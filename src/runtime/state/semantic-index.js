/**
 * Semantic Index — Hierarchical code indexing with LLM descriptions and vector embeddings.
 *
 * Pipeline per file (bottom-up):
 *   1. Parse (tree-sitter) → classes + standalone functions
 *   2. Describe functions via LLM (batches of 10)
 *   3. Describe classes via LLM (fed with method descriptions)
 *   4. Describe file via LLM (fed with class + function descriptions)
 *   5. Embed descriptions → store in LanceDB (3 tables: files, classes, functions)
 *
 * Incremental: SHA-256 content hash manifest skips unchanged files.
 * Storage: LanceDB (embedded, serverless) at .koi/cache/semantic-index/
 *
 * Search: In-memory cosine similarity on a cached snapshot of the index.
 * LanceDB is ONLY used for writes (build) and one-time cache loading.
 * This avoids native-binding deadlocks and allows fully parallel searches.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseFile, getSupportedExtensions } from '../code/code-parser.js';
import { IGNORE_DIRS, discoverFiles } from '../code/file-discovery.js';
import { channel } from '../io/channel.js';

const EMBEDDING_DIM = 1536; // text-embedding-3-small dimension
const FUNC_BATCH_SIZE = 10;
const MAX_SOURCE_CHARS = 1500;
const FILE_PARALLEL_BATCH = 5; // Index this many files concurrently

// ─── SemanticIndex ──────────────────────────────────────────────────────

export class SemanticIndex {
  /**
   * @param {string} cacheDir - Directory for LanceDB + manifest (e.g. .koi/cache/semantic-index)
   * @param {import('../llm/llm-provider.js').LLMProvider} llmProvider
   */
  constructor(cacheDir, llmProvider) {
    this.cacheDir = cacheDir;
    this.llmProvider = llmProvider;
    this._db = null;
    this._dbPromise = null;
    this._tables = {};
    this._manifestPath = path.join(cacheDir, 'manifest.json');
    this._manifest = null;
    this._ready = false;
    this._building = false;

    // In-memory search cache — loaded once from LanceDB, then all searches are pure JS.
    this._cache = null;       // { files: Row[], classes: Row[], functions: Row[] }
    this._cachePromise = null; // guards concurrent _loadCache calls
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Build or update the semantic index for a project directory.
   */
  /**
   * Build or update the semantic index for a project directory.
   * @param {string} projectDir - Project root directory
   * @param {Function} [onProgress] - (done, total) callback
   * @param {{ depDirs?: string[] }} [opts] - Options. depDirs: dependency directories to include in the same index.
   */
  async build(projectDir, onProgress, opts = {}) {
    this._building = true;
    this._cache = null; // invalidate cache — will reload after build
    this._cachePromise = null;

    try {
      channel.log('semantic-index', `build() started — projectDir: ${projectDir}`);
      fs.mkdirSync(this.cacheDir, { recursive: true });
      await this._ensureDb();
      this._loadManifest();

      // File discovery uses .koi/index-extensions.json (all configured extensions).
      // Files without a tree-sitter parser still get file-level indexing.
      const parserExts = getSupportedExtensions();
      channel.log('semantic-index', `Discovery: index-extensions.json (parser: ${[...parserExts].join(', ')})`);

      // Discover files from main project + dependency directories (all in one index)
      // manifestKey = key for incremental hash check (dep:name/... for deps, relPath for main)
      // indexPath = path stored in LanceDB file_path column — ALWAYS absolute so agents can read_file directly
      const fileEntries = []; // { absPath, manifestKey, indexPath }
      const mainFiles = this._discoverFiles(projectDir);
      for (const f of mainFiles) {
        const rel = path.relative(projectDir, f);
        fileEntries.push({ absPath: f, manifestKey: rel, indexPath: f });
      }

      // Include dependency files — stored with absolute paths so read_file works directly
      const depDirs = opts.depDirs || [];
      for (const depDir of depDirs) {
        const depName = path.basename(depDir);
        const depFiles = this._discoverFiles(depDir);
        channel.log('semantic-index', `Dependency ${depName}: ${depFiles.length} files`);
        for (const f of depFiles) {
          fileEntries.push({
            absPath: f,
            manifestKey: `dep:${depName}/${path.relative(depDir, f)}`,
            indexPath: f, // absolute path — agent can read_file directly
          });
        }
      }

      const total = fileEntries.length;
      channel.log('semantic-index', `Discovered ${total} files to consider (${mainFiles.length} main + ${total - mainFiles.length} deps)`);

      await this._cleanupDeletedByKeys(new Set(fileEntries.map(e => e.manifestKey)));

      let indexed = 0;
      let skipped = 0;
      let processed = 0;

      // Filter out already-up-to-date files first (fast, no I/O beyond fs.read)
      const toIndex = [];
      for (const entry of fileEntries) {
        let content;
        try { content = fs.readFileSync(entry.absPath, 'utf8'); } catch { skipped++; processed++; continue; }
        const hash = sha256(content);
        if (this._manifest[entry.manifestKey] === hash) {
          skipped++;
          processed++;
          continue;
        }
        toIndex.push({ ...entry, content, hash });
      }

      if (onProgress) onProgress(processed, total);
      channel.log('semantic-index', `${toIndex.length} files need indexing, ${skipped} up-to-date`);

      // Pre-create LanceDB tables to avoid race conditions in parallel indexing
      if (toIndex.length > 0) {
        await this._ensureFilesTable();
        await this._ensureFunctionsTable();
        await this._ensureClassesTable();
      }

      // Process files in parallel batches.
      // Phase 1: Parse + describe files in parallel (LLM calls for descriptions).
      // Phase 2: Collect all embedding jobs across the batch.
      // Phase 3: Embed everything in one batch request.
      // Phase 4: Store results.
      for (let i = 0; i < toIndex.length; i += FILE_PARALLEL_BATCH) {
        // Yield between batches to avoid starving agent LLM calls
        if (i > 0) await new Promise(r => setTimeout(r, 500));
        const batch = toIndex.slice(i, i + FILE_PARALLEL_BATCH);

        // Phase 1+2: Prepare files in parallel — returns pending embed jobs + store callbacks
        const results = await Promise.allSettled(
          batch.map(entry => this._prepareFile(entry.absPath, entry.indexPath, entry.content, entry.hash, entry.manifestKey))
        );

        // Phase 3: Collect all embed jobs from all files in this batch
        const allEmbedTexts = [];
        const preparedFiles = [];
        for (let j = 0; j < results.length; j++) {
          if (results[j].status === 'fulfilled' && results[j].value) {
            const prepared = results[j].value;
            prepared._batchOffset = allEmbedTexts.length;
            allEmbedTexts.push(...prepared.embedTexts);
            preparedFiles.push({ idx: j, prepared });
          }
        }

        // Single batch embedding call for all files in this batch
        let allVectors = [];
        if (allEmbedTexts.length > 0) {
          allVectors = await this.llmProvider.getEmbeddingBatch(allEmbedTexts);
        }

        // Phase 4: Store results — give each file its slice of vectors
        for (const { idx, prepared } of preparedFiles) {
          const vectors = allVectors.slice(prepared._batchOffset, prepared._batchOffset + prepared.embedTexts.length);
          try {
            await prepared.store(vectors);
          } catch { /* logged inside store */ }
        }

        for (let j = 0; j < results.length; j++) {
          processed++;
          if (results[j].status === 'fulfilled') {
            this._manifest[batch[j].manifestKey] = batch[j].hash;
            indexed++;
          } else {
            channel.log('semantic-index', `Error indexing ${batch[j].indexPath}: ${results[j].reason?.message || results[j].reason}`);
            skipped++;
          }
        }

        // Save manifest after each batch so progress survives interruptions
        this._saveManifest();

        if (onProgress) onProgress(processed, total);
      }

      this._saveManifest(); // final save
      this._ready = true;
      channel.log('semantic-index', `build() done — indexed: ${indexed}, skipped: ${skipped}, total: ${total}`);

      // Pre-load cache so first search is instant (skip _building guard)
      await this._loadCacheFromDb(true);

      return { indexed, skipped, total };
    } finally {
      this._building = false;
    }
  }

  /** @returns {boolean} True if a build is currently in progress */
  isBuilding() {
    return this._building;
  }

  /**
   * Search the semantic index using in-memory cosine similarity.
   * Fully parallel-safe — no LanceDB access during search.
   */
  async search(queryEmbedding, opts = {}) {
    if (this._building) {
      channel.log('semantic-index', 'Search skipped: building in progress');
      return [];
    }

    // Ensure cache is loaded (one-time from LanceDB, then pure memory)
    if (!this._cache) {
      await this._ensureCacheLoaded();
      if (!this._cache) {
        channel.log('semantic-index', 'Search aborted: cache is null after load attempt');
        return [];
      }
    }

    const { type, limit = 20, pathPrefix } = opts;

    const tables = type
      ? [type === 'file' ? 'files' : type === 'class' ? 'classes' : 'functions']
      : ['files', 'classes', 'functions'];

    // Validate cache health — if all vectors are empty, force reload from LanceDB
    const _totalRows = (this._cache.files?.length || 0) + (this._cache.classes?.length || 0) + (this._cache.functions?.length || 0);
    if (_totalRows > 0 && !this._cacheValidated) {
      let _hasVectors = false;
      for (const tableName of ['files', 'classes', 'functions']) {
        for (const row of (this._cache[tableName] || [])) {
          if (row.vector && row.vector.length > 0) { _hasVectors = true; break; }
        }
        if (_hasVectors) break;
      }
      this._cacheValidated = true;
      if (!_hasVectors) {
        channel.log('semantic-index', `Cache has ${_totalRows} rows but ZERO vectors — forcing reload from LanceDB`);
        this._cache = null;
        this._ready = false;
        await this._ensureCacheLoaded();
        if (!this._cache) {
          channel.log('semantic-index', 'Search aborted: cache still null after forced reload');
          return [];
        }
      }
    }

    channel.log('semantic-index', `Search: tables=[${tables.join(',')}], cache sizes: files=${this._cache.files?.length || 0}, classes=${this._cache.classes?.length || 0}, functions=${this._cache.functions?.length || 0}, queryDim=${queryEmbedding?.length || 0}`);

    const allResults = [];
    let _skipNoVector = 0, _skipPathPrefix = 0;

    for (const tableName of tables) {
      const rows = this._cache[tableName];
      if (!rows || rows.length === 0) continue;

      for (const row of rows) {
        if (pathPrefix && !row.file_path?.startsWith(pathPrefix)) { _skipPathPrefix++; continue; }
        if (!row.vector || row.vector.length === 0) { _skipNoVector++; continue; }

        const score = cosineSimilarity(queryEmbedding, row.vector);
        const resultType = tableName === 'files' ? 'file' : tableName === 'classes' ? 'class' : 'function';

        allResults.push({
          type: resultType,
          name: row.name || path.basename(row.file_path || ''),
          filePath: row.file_path,
          lineFrom: row.line_from ?? undefined,
          lineTo: row.line_to ?? undefined,
          description: row.description,
          score,
          signature: row.signature ?? undefined,
          className: row.class_name ?? undefined,
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    const top = allResults.slice(0, limit);
    if (allResults.length > 0) {
      channel.log('semantic-index', `Search: ${allResults.length} candidates, top score=${allResults[0].score.toFixed(4)}, bottom score=${allResults[allResults.length - 1].score.toFixed(4)}`);
    } else {
      channel.log('semantic-index', `Search: 0 candidates (skipped: ${_skipNoVector} no-vector, ${_skipPathPrefix} path-prefix-mismatch, total rows=${_totalRows})`);
    }
    return top;
  }

  /**
   * Check if the index has data and is ready for search.
   * Uses manifest (filesystem) — NEVER touches LanceDB to avoid deadlocks.
   */
  isReady() {
    if (this._ready) return true;
    if (this._cache) return true;
    // Check manifest on disk — no LanceDB call
    this._loadManifest();
    return this._manifest && Object.keys(this._manifest).length > 0;
  }

  /**
   * Check if the index is up-to-date for the project (and optionally dependencies).
   * @param {string} projectDir
   * @param {{ depDirs?: string[] }} [opts]
   */
  async isUpToDate(projectDir, opts = {}) {
    this._loadManifest();
    if (!this._manifest || Object.keys(this._manifest).length === 0) return false;

    // Check main project files
    const files = this._discoverFiles(projectDir);
    for (const filePath of files) {
      const relPath = path.relative(projectDir, filePath);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const hash = sha256(content);
      if (this._manifest[relPath] !== hash) return false;
    }

    // Check dependency files
    for (const depDir of (opts.depDirs || [])) {
      const depName = path.basename(depDir);
      const depFiles = this._discoverFiles(depDir);
      for (const filePath of depFiles) {
        const relPath = `dep:${depName}/${path.relative(depDir, filePath)}`;
        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
        const hash = sha256(content);
        if (this._manifest[relPath] !== hash) return false;
      }
    }

    return true;
  }

  clearManifest() {
    this._manifest = {};
    this._saveManifest();
    this._cache = null;
    this._cachePromise = null;
  }

  /**
   * Get structured index stats for the GUI.
   * @returns {{ totalFiles: number, indexedFiles: number, directories: string[], cacheSize: { files: number, classes: number, functions: number } }}
   */
  getStats() {
    this._loadManifest();
    const manifestKeys = Object.keys(this._manifest || {});
    const dirs = new Set();
    for (const key of manifestKeys) {
      // key is either a relative path or dep:name/rel/path
      const parts = key.replace(/^dep:[^/]+\//, '').split('/');
      if (parts.length > 1) dirs.add(parts.slice(0, -1).join('/'));
    }
    return {
      totalFiles: manifestKeys.length,
      indexedFiles: manifestKeys.length,
      directories: [...dirs].sort(),
      isBuilding: this._building,
      cacheSize: {
        files: this._cache?.files?.length || 0,
        classes: this._cache?.classes?.length || 0,
        functions: this._cache?.functions?.length || 0,
      },
    };
  }

  // ─── Cache Management ──────────────────────────────────────────────

  /**
   * Ensure the cache is loaded from LanceDB (one-time).
   * Safe to call from background tasks or before parallel searches.
   * Uses a promise guard to prevent multiple concurrent loads.
   */
  async ensureCacheLoaded() {
    return this._ensureCacheLoaded();
  }

  /** @private */
  async _ensureCacheLoaded() {
    if (this._cache) return;
    if (this._cachePromise) {
      channel.log('semantic-index', 'Cache load already in progress, waiting...');
      await this._cachePromise;
      return;
    }
    channel.log('semantic-index', 'Loading cache from LanceDB (first time)...');
    this._cachePromise = this._loadCacheFromDb();
    try {
      await this._cachePromise;
      channel.log('semantic-index', `Cache loaded: ${this._cache ? Object.keys(this._cache).map(k => `${k}:${this._cache[k].length}`).join(', ') : 'null'}`);
    } finally {
      this._cachePromise = null;
    }
  }

  /**
   * Load all rows from LanceDB into memory. Called once after build
   * or on first search. After this, LanceDB is not touched for reads.
   */
  async _loadCacheFromDb(force = false) {
    if (!force && this._building) {
      channel.log('semantic-index', 'Cache load skipped: building in progress');
      return;
    }
    try {
      await this._ensureDb();
      const names = await this._db.tableNames();
      channel.log('semantic-index', `LanceDB tables found: [${names.join(', ')}]`);
      const cache = { files: [], classes: [], functions: [] };

      for (const tableName of ['files', 'classes', 'functions']) {
        if (!names.includes(tableName)) {
          channel.log('semantic-index', `Table "${tableName}" not found in LanceDB, skipping`);
          continue;
        }
        try {
          const table = await this._db.openTable(tableName);
          const rows = await table.query().toArray();
          channel.log('semantic-index', `Table "${tableName}": ${rows.length} rows loaded from LanceDB`);
          // Convert Arrow rows to plain JS objects with regular arrays for vectors.
          // Multiple conversion strategies to handle Arrow Vector objects in both
          // native Node.js and pkg binary environments where native bindings may differ.
          let vectorOk = 0, vectorFail = 0;
          cache[tableName] = rows.map(row => {
            const obj = {};
            for (const key of Object.keys(row)) {
              const val = row[key];
              if (key === 'vector' && val) {
                let vec = null;
                try {
                  // Strategy 1: Arrow Vector.toArray() → Float32Array → Array
                  if (!vec && typeof val.toArray === 'function') {
                    const typed = val.toArray();
                    vec = Array.from(typed);
                  }
                  // Strategy 2: Iterable (Symbol.iterator)
                  if ((!vec || vec.length === 0) && val[Symbol.iterator]) {
                    vec = [...val];
                  }
                  // Strategy 3: JSON round-trip (catches exotic Arrow wrappers)
                  if ((!vec || vec.length === 0) && typeof val === 'object') {
                    const parsed = JSON.parse(JSON.stringify(val));
                    if (Array.isArray(parsed)) vec = parsed;
                  }
                  // Strategy 4: Index-based access (fallback for ArrayLike without iterator)
                  if ((!vec || vec.length === 0) && typeof val.length === 'number' && val.length > 0) {
                    vec = [];
                    for (let i = 0; i < val.length; i++) vec.push(val[i]);
                  }
                } catch { /* all strategies exhausted */ }

                obj[key] = (vec && vec.length > 0) ? vec : [];
                if (obj[key].length > 0) vectorOk++; else vectorFail++;
              } else {
                obj[key] = val;
              }
            }
            return obj;
          });
          channel.log('semantic-index', `Table "${tableName}": ${vectorOk} vectors OK, ${vectorFail} vectors empty/failed`);
        } catch (err) {
          channel.log('semantic-index', `Cache load ${tableName} FAILED: ${err.message}`);
        }
      }

      this._cache = cache;
      this._ready = true;
      channel.log('semantic-index', `Cache ready: files=${cache.files.length}, classes=${cache.classes.length}, functions=${cache.functions.length}`);
    } catch (err) {
      channel.log('semantic-index', `Cache load FAILED: ${err.message}\n${err.stack}`);
    }
  }

  // ─── Private: File Discovery ────────────────────────────────────────

  _discoverFiles(baseDir, _supportedExts, maxFiles = 5000) {
    // Delegates to the shared discoverFiles (accepts all text files, skips binaries)
    return discoverFiles(baseDir, maxFiles);
  }

  // ─── Private: DB & Tables ───────────────────────────────────────────

  async _ensureDb() {
    if (this._db) return;
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = (async () => {
      channel.log('semantic-index', 'Loading @lancedb/lancedb...');
      let lancedb;
      const isBinary = typeof process.pkg !== 'undefined';
      try {
        if (isBinary) {
          const lancedbPath = path.join(process.env.KOI_EXTRACTED_NODE_MODULES, '@lancedb', 'lancedb', 'dist', 'index.js');
          channel.log('semantic-index', `Loading LanceDB from disk: ${lancedbPath}`);
          let binaryRequire = globalThis.require;
          if (!binaryRequire) {
            try { binaryRequire = eval('require'); } catch {}
          }
          if (!binaryRequire) {
            throw new Error('require is not available in binary mode');
          }
          lancedb = binaryRequire(lancedbPath);
          lancedb = lancedb?.default ?? lancedb;
        } else {
          lancedb = await import('@lancedb/lancedb');
        }
        channel.log('semantic-index', '@lancedb/lancedb loaded OK');
      } catch (err) {
        channel.log('semantic-index', `@lancedb/lancedb FAILED to load: ${err.message}`);
        throw err;
      }
      const dbPath = path.join(this.cacheDir, 'lancedb');
      fs.mkdirSync(dbPath, { recursive: true });
      channel.log('semantic-index', `Connecting to LanceDB at: ${dbPath}`);
      try {
        this._db = await lancedb.connect(dbPath);
        channel.log('semantic-index', 'LanceDB connected OK');
      } catch (err) {
        channel.log('semantic-index', `LanceDB connect FAILED: ${err.message}`);
        throw err;
      }
    })();
    await this._dbPromise;
  }

  async _openTable(name) {
    if (this._tables[name]) return this._tables[name];
    if (!this._tablePromises) this._tablePromises = {};
    if (this._tablePromises[name]) return this._tablePromises[name];
    this._tablePromises[name] = (async () => {
      try {
        const names = await this._db.tableNames();
        if (!names.includes(name)) return null;
        this._tables[name] = await this._db.openTable(name);
        return this._tables[name];
      } catch {
        return null;
      }
    })();
    const result = await this._tablePromises[name];
    delete this._tablePromises[name];
    return result;
  }

  async _getOrCreateTable(name, sampleRow) {
    if (this._tables[name]) return this._tables[name];
    const names = await this._db.tableNames();
    if (names.includes(name)) {
      this._tables[name] = await this._db.openTable(name);
    } else {
      this._tables[name] = await this._db.createTable(name, [sampleRow]);
      await this._tables[name].delete(`id = "${sampleRow.id}"`);
    }
    return this._tables[name];
  }

  // ─── Private: Manifest ──────────────────────────────────────────────

  // Manifest version — bump this when the storage format changes (e.g. relative → absolute paths).
  // A version mismatch triggers a full re-index on the next build.
  static MANIFEST_VERSION = 3; // v3: discover all SOURCE_EXTS, file-level indexing for non-parsed languages

  _loadManifest() {
    if (this._manifest) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this._manifestPath, 'utf8'));
      // Check manifest version — if outdated, invalidate to force full re-index
      if (raw._version !== SemanticIndex.MANIFEST_VERSION) {
        channel.log('semantic-index', `Manifest version mismatch (${raw._version || 1} → ${SemanticIndex.MANIFEST_VERSION}) — clearing index for re-build`);
        this._manifest = {};
        // Also drop LanceDB tables so stale relative paths are removed
        this._dropAllTables().catch(() => {});
      } else {
        this._manifest = raw;
      }
    } catch {
      this._manifest = {};
    }
  }

  _saveManifest() {
    fs.mkdirSync(path.dirname(this._manifestPath), { recursive: true });
    this._manifest._version = SemanticIndex.MANIFEST_VERSION;
    fs.writeFileSync(this._manifestPath, JSON.stringify(this._manifest, null, 2));
  }

  async _dropAllTables() {
    try {
      const db = await this._ensureDb();
      const tables = await db.tableNames();
      for (const t of tables) {
        await db.dropTable(t);
      }
      channel.log('semantic-index', `Dropped ${tables.length} LanceDB tables for re-index`);
    } catch (e) {
      channel.log('semantic-index', `Failed to drop tables: ${e.message}`);
    }
  }

  // ─── Private: Index a Single File ───────────────────────────────────

  /**
   * Prepare a file for indexing: parse, describe, collect embedding texts.
   * Returns { embedTexts: string[], store: (vectors) => Promise<void> }
   * The actual embedding is done externally so multiple files can be batched.
   */
  async _prepareFile(filePath, relPath, content, hash, manifestKey) {
    const parsed = parseFile(filePath, content);

    if (!parsed) {
      return this._prepareFileOnly(filePath, relPath, content, hash, manifestKey);
    }

    const { classes, functions } = parsed;
    const lang = path.extname(filePath).replace('.', '');
    const lines = content.split('\n');
    const fileId = sha256(manifestKey || relPath).slice(0, 16);

    await this._deleteFileData(fileId);

    const allFunctions = [...functions];
    for (const cls of classes) {
      allFunctions.push(...cls.methods);
    }

    const funcDescriptions = await this._describeFunctions(allFunctions, relPath, lang);

    const classDescriptions = {};
    for (const cls of classes) {
      classDescriptions[cls.name] = await this._describeClass(cls, funcDescriptions, relPath);
    }

    const fileDescription = await this._describeFile(relPath, lines.length, classes, functions, classDescriptions, funcDescriptions);

    // Collect embedding texts (keys track which vector goes where)
    const embedKeys = [];
    const embedTexts = [];

    for (const func of allFunctions) {
      const desc = funcDescriptions[func.name] || `${func.name}: ${func.signature}`;
      embedKeys.push(`fn:${func.name}:${func.lineFrom}`);
      embedTexts.push(`${desc} | ${func.signature} | ${truncate(func.sourceCode, 200)}`);
    }

    for (const cls of classes) {
      const desc = classDescriptions[cls.name] || cls.name;
      const methodSummary = cls.methods.map(m => `${m.name}: ${funcDescriptions[m.name] || m.signature}`).join('; ');
      embedKeys.push(`cls:${cls.name}`);
      embedTexts.push(`${desc} | ${methodSummary}`.slice(0, 1000));
    }

    const contentSummary = truncate(content, 500);
    embedKeys.push('file');
    embedTexts.push(`${fileDescription} | ${contentSummary}`);

    // Return texts for batching + a store callback that receives the vectors
    const self = this;
    return {
      embedTexts,
      async store(vectorsArray) {
        const vectors = {};
        for (let i = 0; i < embedKeys.length; i++) {
          vectors[embedKeys[i]] = vectorsArray[i] || zeroVector();
        }

        const funcTable = await self._ensureFunctionsTable();
        const funcRows = allFunctions.map(func => {
          const desc = funcDescriptions[func.name] || `${func.name}: ${func.signature}`;
          return {
            id: `${fileId}-fn-${sha256(func.name + func.lineFrom).slice(0, 8)}`,
            file_id: fileId,
            class_id: func.className ? `${fileId}-cls-${sha256(func.className).slice(0, 8)}` : '',
            file_path: relPath,
            name: func.name,
            description: desc,
            vector: vectors[`fn:${func.name}:${func.lineFrom}`],
            line_from: func.lineFrom,
            line_to: func.lineTo,
            signature: func.signature,
            source_code: truncate(func.sourceCode, MAX_SOURCE_CHARS),
            is_method: func.isMethod ? 1 : 0,
            class_name: func.className || '',
          };
        });
        if (funcRows.length > 0) await funcTable.add(funcRows);

        const clsTable = await self._ensureClassesTable();
        const clsRows = classes.map(cls => {
          const desc = classDescriptions[cls.name] || cls.name;
          return {
            id: `${fileId}-cls-${sha256(cls.name).slice(0, 8)}`,
            file_id: fileId,
            file_path: relPath,
            name: cls.name,
            description: desc,
            vector: vectors[`cls:${cls.name}`],
            line_from: cls.lineFrom,
            line_to: cls.lineTo,
            source_code: truncate(cls.sourceCode, MAX_SOURCE_CHARS),
          };
        });
        if (clsRows.length > 0) await clsTable.add(clsRows);

        const fileTable = await self._ensureFilesTable();
        await fileTable.add([{
          id: fileId,
          file_path: relPath,
          language: lang,
          description: fileDescription,
          vector: vectors['file'],
          line_count: lines.length,
          content_hash: hash,
          indexed_at: new Date().toISOString(),
        }]);
      },
    };
  }

  /**
   * Prepare file-level-only indexing (no tree-sitter plugin available).
   * Returns { embedTexts, store } like _prepareFile.
   */
  async _prepareFileOnly(filePath, relPath, content, hash, manifestKey) {
    const lang = path.extname(filePath).replace('.', '');
    const lines = content.split('\n');
    const fileId = sha256(manifestKey || relPath).slice(0, 16);

    await this._deleteFileData(fileId);

    const contentPreview = truncate(content, 2000);
    const prompt = `Given a source file's contents, write a concise 1-2 sentence description focusing on purpose, key classes, and key methods.

File: ${relPath} (${lines.length} lines, language: ${lang})
\`\`\`${lang}
${contentPreview}
\`\`\`

Return: { "description": "..." }`;

    let fileDescription;
    try {
      const result = await this.llmProvider.callJSON(prompt, null, { silent: true });
      fileDescription = result?.description || relPath;
    } catch {
      fileDescription = relPath;
    }

    const embedTexts = [`${fileDescription} | ${truncate(content, 500)}`];

    const self = this;
    return {
      embedTexts,
      async store(vectorsArray) {
        const vector = vectorsArray[0] || zeroVector();
        const fileTable = await self._ensureFilesTable();
        await fileTable.add([{
          id: fileId,
          file_path: relPath,
          language: lang,
          description: fileDescription,
          vector,
          line_count: lines.length,
          content_hash: hash,
          indexed_at: new Date().toISOString(),
        }]);
      },
    };
  }

  async _deleteFileData(fileId) {
    try {
      const filesTable = await this._openTable('files');
      if (filesTable) await filesTable.delete(`id = "${fileId}"`);
    } catch { /* table may not exist */ }

    for (const tableName of ['classes', 'functions']) {
      try {
        const table = await this._openTable(tableName);
        if (table) await table.delete(`file_id = "${fileId}"`);
      } catch { /* table may not exist */ }
    }
  }

  // ─── Private: Table Initialization ──────────────────────────────────

  async _ensureFilesTable() {
    return this._getOrCreateTable('files', {
      id: '__init__', file_path: '', language: '', description: '',
      vector: zeroVector(), line_count: 0, content_hash: '', indexed_at: '',
    });
  }

  async _ensureClassesTable() {
    return this._getOrCreateTable('classes', {
      id: '__init__', file_id: '', file_path: '', name: '', description: '',
      vector: zeroVector(), line_from: 0, line_to: 0, source_code: '',
    });
  }

  async _ensureFunctionsTable() {
    return this._getOrCreateTable('functions', {
      id: '__init__', file_id: '', class_id: '', file_path: '', name: '',
      description: '', vector: zeroVector(), line_from: 0, line_to: 0,
      signature: '', source_code: '', is_method: 0, class_name: '',
    });
  }

  // ─── Private: Cleanup ───────────────────────────────────────────────

  async _cleanupDeleted(currentFiles, projectDir) {
    const currentRelPaths = new Set(currentFiles.map(f => path.relative(projectDir, f)));
    await this._cleanupDeletedByKeys(currentRelPaths);
  }

  async _cleanupDeletedByKeys(currentKeys) {
    const toDelete = [];

    for (const key of Object.keys(this._manifest)) {
      if (!currentKeys.has(key)) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      const fileId = sha256(key).slice(0, 16);
      await this._deleteFileData(fileId);
      delete this._manifest[key];
    }
  }

  // ─── Private: LLM Description Generation ───────────────────────────

  async _describeFunctions(functions, filePath, lang) {
    const descriptions = {};
    if (functions.length === 0) return descriptions;

    for (let i = 0; i < functions.length; i += FUNC_BATCH_SIZE) {
      const batch = functions.slice(i, i + FUNC_BATCH_SIZE);
      const prompt = this._buildFuncDescriptionPrompt(batch, filePath, lang);

      try {
        const result = await this.llmProvider.callJSON(prompt, null, { silent: true });
        if (result?.descriptions) {
          Object.assign(descriptions, result.descriptions);
        }
      } catch (err) {
        channel.log('semantic-index', `LLM func description failed: ${err.message}`);
        for (const fn of batch) {
          descriptions[fn.name] = `${fn.name}: ${fn.signature}`;
        }
      }
    }

    for (const fn of functions) {
      if (!descriptions[fn.name]) {
        descriptions[fn.name] = `${fn.name}: ${fn.signature}`;
      }
    }

    return descriptions;
  }

  async _describeClass(cls, funcDescriptions, filePath) {
    const methodDescs = cls.methods.map(m =>
      `- ${m.name}: "${funcDescriptions[m.name] || m.signature}"`
    ).join('\n');

    const prompt = `Given a class and its method descriptions, write a concise 1-2 sentence class description focusing on purpose and behavior.

Class: ${cls.name} [lines ${cls.lineFrom}-${cls.lineTo}] in ${filePath}
Methods:
${methodDescs || '(no methods)'}

Return: { "description": "..." }`;

    try {
      const result = await this.llmProvider.callJSON(prompt, null, { silent: true });
      return result?.description || cls.name;
    } catch {
      return cls.name;
    }
  }

  async _describeFile(filePath, lineCount, classes, functions, classDescs, funcDescs) {
    const classSummary = classes.map(c =>
      `- ${c.name}: "${classDescs[c.name] || c.name}"`
    ).join('\n');
    const funcSummary = functions.map(f =>
      `- ${f.name}: "${funcDescs[f.name] || f.signature}"`
    ).join('\n');

    const prompt = `Given a file's contents summary, write a concise 1-2 sentence file description focusing on purpose.

File: ${filePath} (${lineCount} lines)
${classSummary ? `Classes:\n${classSummary}` : 'Classes: (none)'}
${funcSummary ? `Functions:\n${funcSummary}` : 'Functions: (none)'}

Return: { "description": "..." }`;

    try {
      const result = await this.llmProvider.callJSON(prompt, null, { silent: true });
      return result?.description || filePath;
    } catch {
      return filePath;
    }
  }

  _buildFuncDescriptionPrompt(batch, filePath, lang) {
    let prompt = `You are a code documentation assistant. For each function below, write a concise 1-2 sentence description. Focus on purpose and behavior. Return ONLY valid JSON.

File: ${filePath}

`;
    for (let i = 0; i < batch.length; i++) {
      const fn = batch[i];
      const src = truncate(fn.sourceCode, MAX_SOURCE_CHARS);
      prompt += `${i + 1}. ${fn.signature} [lines ${fn.lineFrom}-${fn.lineTo}]${fn.isMethod ? ` (method of ${fn.className})` : ''}\n\`\`\`${lang}\n${src}\n\`\`\`\n\n`;
    }
    prompt += `Return: { "descriptions": { "functionName": "description", ... } }`;
    return prompt;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

const _instances = new Map(); // cacheDir → SemanticIndex

export function getSemanticIndex(cacheDir, llmProvider) {
  if (_instances.has(cacheDir)) {
    const inst = _instances.get(cacheDir);
    if (llmProvider) inst.llmProvider = llmProvider;
    return inst;
  }
  const inst = new SemanticIndex(cacheDir, llmProvider);
  _instances.set(cacheDir, inst);
  return inst;
}

/**
 * Given an absolute path, find the nearest ancestor directory that contains
 * a `.koi/cache/semantic-index` folder (i.e. has been indexed).
 * Returns the cacheDir path, or null if none found.
 */
export function findProjectCacheDir(absPath) {
  let dir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()
    ? absPath
    : path.dirname(absPath);
  // Walk up max 6 levels to find a .koi dir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.koi', 'cache', 'semantic-index');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function zeroVector() {
  return new Array(EMBEDDING_DIM).fill(0);
}

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 * Used for in-memory search instead of LanceDB vectorSearch.
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
