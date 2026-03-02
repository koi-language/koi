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
import { parseFile, getSupportedExtensions } from './code-parser.js';
import { IGNORE_DIRS } from './file-discovery.js';
import { cliLogger } from './cli-logger.js';

const EMBEDDING_DIM = 1536; // text-embedding-3-small dimension
const FUNC_BATCH_SIZE = 10;
const MAX_SOURCE_CHARS = 1500;

// ─── SemanticIndex ──────────────────────────────────────────────────────

export class SemanticIndex {
  /**
   * @param {string} cacheDir - Directory for LanceDB + manifest (e.g. .koi/cache/semantic-index)
   * @param {import('./llm-provider.js').LLMProvider} llmProvider
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
  async build(projectDir, onProgress) {
    this._building = true;
    this._cache = null; // invalidate cache — will reload after build
    this._cachePromise = null;

    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      await this._ensureDb();
      this._loadManifest();

      const supportedExts = getSupportedExtensions();
      const files = this._discoverFiles(projectDir, supportedExts);
      const total = files.length;

      await this._cleanupDeleted(files, projectDir);

      let indexed = 0;
      let skipped = 0;

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const relPath = path.relative(projectDir, filePath);

        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { skipped++; continue; }

        const hash = sha256(content);
        if (this._manifest[relPath] === hash) {
          skipped++;
          if (onProgress) onProgress(i + 1, total);
          continue;
        }

        try {
          await this._indexFile(filePath, relPath, content, hash);
          indexed++;
        } catch (err) {
          cliLogger.log('semantic-index', `Error indexing ${relPath}: ${err.message}`);
          skipped++;
        }

        if (onProgress) onProgress(i + 1, total);
      }

      this._saveManifest();
      this._ready = true;

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
    if (this._building) return [];

    // Ensure cache is loaded (one-time from LanceDB, then pure memory)
    if (!this._cache) {
      await this._ensureCacheLoaded();
      if (!this._cache) return []; // no index data
    }

    const { type, limit = 20, pathPrefix } = opts;

    const tables = type
      ? [type === 'file' ? 'files' : type === 'class' ? 'classes' : 'functions']
      : ['files', 'classes', 'functions'];

    const allResults = [];

    for (const tableName of tables) {
      const rows = this._cache[tableName];
      if (!rows || rows.length === 0) continue;

      for (const row of rows) {
        if (pathPrefix && !row.file_path?.startsWith(pathPrefix)) continue;
        if (!row.vector || row.vector.length === 0) continue;

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
          sourceCode: row.source_code ?? undefined,
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
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

  async isUpToDate(projectDir) {
    this._loadManifest();
    if (!this._manifest || Object.keys(this._manifest).length === 0) return false;

    const supportedExts = getSupportedExtensions();
    const files = this._discoverFiles(projectDir, supportedExts);

    for (const filePath of files) {
      const relPath = path.relative(projectDir, filePath);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const hash = sha256(content);
      if (this._manifest[relPath] !== hash) return false;
    }
    return true;
  }

  clearManifest() {
    this._manifest = {};
    this._saveManifest();
    this._cache = null;
    this._cachePromise = null;
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
      cliLogger.log('semantic-index', 'Cache load already in progress, waiting...');
      await this._cachePromise;
      return;
    }
    cliLogger.log('semantic-index', 'Loading cache from LanceDB (first time)...');
    this._cachePromise = this._loadCacheFromDb();
    try {
      await this._cachePromise;
      cliLogger.log('semantic-index', `Cache loaded: ${this._cache ? Object.keys(this._cache).map(k => `${k}:${this._cache[k].length}`).join(', ') : 'null'}`);
    } finally {
      this._cachePromise = null;
    }
  }

  /**
   * Load all rows from LanceDB into memory. Called once after build
   * or on first search. After this, LanceDB is not touched for reads.
   */
  async _loadCacheFromDb(force = false) {
    if (!force && this._building) return; // don't read LanceDB while build is writing
    try {
      await this._ensureDb();
      const names = await this._db.tableNames();
      const cache = { files: [], classes: [], functions: [] };

      for (const tableName of ['files', 'classes', 'functions']) {
        if (!names.includes(tableName)) continue;
        try {
          const table = await this._db.openTable(tableName);
          const rows = await table.query().toArray();
          // Convert Arrow rows to plain JS objects with regular arrays for vectors
          cache[tableName] = rows.map(row => {
            const obj = {};
            for (const key of Object.keys(row)) {
              const val = row[key];
              if (key === 'vector' && val) {
                // Arrow Vector → TypedArray → plain Array
                if (typeof val.toArray === 'function') {
                  obj[key] = Array.from(val.toArray());
                } else {
                  obj[key] = Array.from(val);
                }
              } else {
                obj[key] = val;
              }
            }
            return obj;
          });
        } catch (err) {
          cliLogger.log('semantic-index', `Cache load ${tableName}: ${err.message}`);
        }
      }

      this._cache = cache;
      this._ready = true;
    } catch (err) {
      cliLogger.log('semantic-index', `Cache load failed: ${err.message}`);
    }
  }

  // ─── Private: File Discovery ────────────────────────────────────────

  _discoverFiles(baseDir, supportedExts, maxFiles = 5000) {
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 15 || files.length >= maxFiles) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (supportedExts.has(ext)) files.push(full);
        }
      }
    };
    walk(baseDir, 0);
    return files;
  }

  // ─── Private: DB & Tables ───────────────────────────────────────────

  async _ensureDb() {
    if (this._db) return;
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = (async () => {
      const lancedb = await import('@lancedb/lancedb');
      const dbPath = path.join(this.cacheDir, 'lancedb');
      fs.mkdirSync(dbPath, { recursive: true });
      this._db = await lancedb.connect(dbPath);
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

  _loadManifest() {
    if (this._manifest) return;
    try {
      this._manifest = JSON.parse(fs.readFileSync(this._manifestPath, 'utf8'));
    } catch {
      this._manifest = {};
    }
  }

  _saveManifest() {
    fs.mkdirSync(path.dirname(this._manifestPath), { recursive: true });
    fs.writeFileSync(this._manifestPath, JSON.stringify(this._manifest, null, 2));
  }

  // ─── Private: Index a Single File ───────────────────────────────────

  async _indexFile(filePath, relPath, content, hash) {
    const parsed = parseFile(filePath, content);
    if (!parsed) return;

    const { classes, functions } = parsed;
    const lang = path.extname(filePath).replace('.', '');
    const lines = content.split('\n');
    const fileId = sha256(relPath).slice(0, 16);

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

    // Store functions
    const funcTable = await this._ensureFunctionsTable();
    for (const func of allFunctions) {
      const desc = funcDescriptions[func.name] || `${func.name}: ${func.signature}`;
      const embedText = `${desc} | ${func.signature} | ${truncate(func.sourceCode, 200)}`;
      let vector;
      try { vector = await this.llmProvider.getEmbedding(embedText); } catch { vector = zeroVector(); }
      await funcTable.add([{
        id: `${fileId}-fn-${sha256(func.name + func.lineFrom).slice(0, 8)}`,
        file_id: fileId,
        class_id: func.className ? `${fileId}-cls-${sha256(func.className).slice(0, 8)}` : '',
        file_path: relPath,
        name: func.name,
        description: desc,
        vector,
        line_from: func.lineFrom,
        line_to: func.lineTo,
        signature: func.signature,
        source_code: truncate(func.sourceCode, MAX_SOURCE_CHARS),
        is_method: func.isMethod ? 1 : 0,
        class_name: func.className || '',
      }]);
    }

    // Store classes
    const clsTable = await this._ensureClassesTable();
    for (const cls of classes) {
      const desc = classDescriptions[cls.name] || cls.name;
      const methodSummary = cls.methods.map(m => `${m.name}: ${funcDescriptions[m.name] || m.signature}`).join('; ');
      const embedText = `${desc} | ${methodSummary}`.slice(0, 1000);
      let vector;
      try { vector = await this.llmProvider.getEmbedding(embedText); } catch { vector = zeroVector(); }
      await clsTable.add([{
        id: `${fileId}-cls-${sha256(cls.name).slice(0, 8)}`,
        file_id: fileId,
        file_path: relPath,
        name: cls.name,
        description: desc,
        vector,
        line_from: cls.lineFrom,
        line_to: cls.lineTo,
        source_code: truncate(cls.sourceCode, MAX_SOURCE_CHARS),
      }]);
    }

    // Store file
    const fileTable = await this._ensureFilesTable();
    const contentSummary = truncate(content, 500);
    const fileEmbedText = `${fileDescription} | ${contentSummary}`;
    let fileVector;
    try { fileVector = await this.llmProvider.getEmbedding(fileEmbedText); } catch { fileVector = zeroVector(); }
    await fileTable.add([{
      id: fileId,
      file_path: relPath,
      language: lang,
      description: fileDescription,
      vector: fileVector,
      line_count: lines.length,
      content_hash: hash,
      indexed_at: new Date().toISOString(),
    }]);

    this._manifest[relPath] = hash;
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
    const toDelete = [];

    for (const relPath of Object.keys(this._manifest)) {
      if (!currentRelPaths.has(relPath)) {
        toDelete.push(relPath);
      }
    }

    for (const relPath of toDelete) {
      const fileId = sha256(relPath).slice(0, 16);
      await this._deleteFileData(fileId);
      delete this._manifest[relPath];
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
        cliLogger.log('semantic-index', `LLM func description failed: ${err.message}`);
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

let _instance = null;
let _instanceDir = null;

export function getSemanticIndex(cacheDir, llmProvider) {
  if (_instance && _instanceDir === cacheDir) {
    if (llmProvider) _instance.llmProvider = llmProvider;
    return _instance;
  }
  _instance = new SemanticIndex(cacheDir, llmProvider);
  _instanceDir = cacheDir;
  return _instance;
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
