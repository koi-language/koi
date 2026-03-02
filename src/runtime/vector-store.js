/**
 * Vector Store - Semantic search using OpenAI embeddings.
 *
 * Architecture:
 *   - Chunks source files into semantic units (functions, classes, blocks)
 *   - Embeds each chunk via text-embedding-3-small (OpenAI)
 *   - Caches embeddings on disk at .koi/cache/vectors/ with per-file SHA hash
 *   - Searches via cosine similarity at query time
 *
 * Incremental re-indexing: only files whose SHA has changed get re-embedded.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─── Chunking ───────────────────────────────────────────────────────────

/**
 * Split source code into semantic chunks.
 * Each chunk is a logical unit: function, class, method, or block of lines.
 * Returns: [{ text, startLine, endLine }]
 */
function chunkFile(content, filePath) {
  const lines = content.split('\n');
  const chunks = [];
  const ext = path.extname(filePath).toLowerCase();

  // For very small files, treat as single chunk
  if (lines.length <= 20) {
    chunks.push({ text: content, startLine: 1, endLine: lines.length });
    return chunks;
  }

  // Language-aware chunking for JS/TS/Python/Go/Java/etc.
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    return chunkByBraces(lines, filePath);
  } else if (['.py', '.rb'].includes(ext)) {
    return chunkByIndentation(lines, filePath);
  } else {
    // Generic: chunk by fixed-size sliding window
    return chunkByWindow(lines, filePath, 30, 10);
  }
}

/**
 * Chunk brace-based languages (JS, TS, Java, Go, C, etc.)
 * Detects top-level functions, classes, and methods.
 */
function chunkByBraces(lines, filePath) {
  const chunks = [];
  let currentChunkStart = 0;
  let braceDepth = 0;
  let inTopLevel = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect start of a top-level declaration
    if (braceDepth === 0 && isDeclarationStart(trimmed)) {
      // Save preceding chunk if non-trivial
      if (i > currentChunkStart && hasContent(lines, currentChunkStart, i - 1)) {
        chunks.push(makeChunk(lines, currentChunkStart, i - 1));
      }
      currentChunkStart = i;
      inTopLevel = true;
    }

    // Count braces
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // End of top-level block
    if (inTopLevel && braceDepth === 0 && i > currentChunkStart) {
      chunks.push(makeChunk(lines, currentChunkStart, i));
      currentChunkStart = i + 1;
      inTopLevel = false;
    }
  }

  // Remaining lines
  if (currentChunkStart < lines.length && hasContent(lines, currentChunkStart, lines.length - 1)) {
    chunks.push(makeChunk(lines, currentChunkStart, lines.length - 1));
  }

  // If chunking produced nothing or a single huge chunk, fall back to window
  if (chunks.length <= 1 && lines.length > 50) {
    return chunkByWindow(lines, filePath, 30, 10);
  }

  return chunks;
}

function isDeclarationStart(trimmed) {
  return /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var)\s/.test(trimmed)
    || /^(export\s+)?default\s+\{/.test(trimmed)
    || /^(describe|it|test)\s*\(/.test(trimmed);
}

/**
 * Chunk indentation-based languages (Python, Ruby).
 * Detects top-level def/class declarations.
 */
function chunkByIndentation(lines, filePath) {
  const chunks = [];
  let currentChunkStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // New top-level declaration (no leading whitespace)
    if (/^(def |class |async def )/.test(line) && i > currentChunkStart) {
      if (hasContent(lines, currentChunkStart, i - 1)) {
        chunks.push(makeChunk(lines, currentChunkStart, i - 1));
      }
      currentChunkStart = i;
    }
  }

  // Remaining
  if (currentChunkStart < lines.length && hasContent(lines, currentChunkStart, lines.length - 1)) {
    chunks.push(makeChunk(lines, currentChunkStart, lines.length - 1));
  }

  if (chunks.length <= 1 && lines.length > 50) {
    return chunkByWindow(lines, filePath, 30, 10);
  }

  return chunks;
}

/**
 * Generic fixed-size sliding window chunking.
 */
function chunkByWindow(lines, filePath, windowSize = 30, overlap = 10) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += windowSize - overlap) {
    const end = Math.min(i + windowSize - 1, lines.length - 1);
    if (hasContent(lines, i, end)) {
      chunks.push(makeChunk(lines, i, end));
    }
    if (end >= lines.length - 1) break;
  }
  return chunks;
}

function makeChunk(lines, start, end) {
  const text = lines.slice(start, end + 1).join('\n');
  return { text, startLine: start + 1, endLine: end + 1 };
}

function hasContent(lines, start, end) {
  for (let i = start; i <= end; i++) {
    if (lines[i]?.trim()) return true;
  }
  return false;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// ─── Vector Store ───────────────────────────────────────────────────────

/**
 * On-disk vector store with incremental indexing.
 *
 * Cache structure at .koi/cache/vectors/:
 *   manifest.json          – { files: { relativePath: { hash, chunkCount } } }
 *   <sha256-prefix>.json   – { chunks: [{ text, startLine, endLine, embedding }] }
 */
export class VectorStore {
  constructor(cacheDir) {
    this.cacheDir = cacheDir || path.join(process.cwd(), '.koi', 'cache', 'vectors');
    this.manifest = null;  // lazy loaded
    this.chunks = [];      // in-memory: [{ file, text, startLine, endLine, embedding }]
    this.built = false;
  }

  _ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  _manifestPath() {
    return path.join(this.cacheDir, 'manifest.json');
  }

  _loadManifest() {
    if (this.manifest) return this.manifest;
    const p = this._manifestPath();
    if (fs.existsSync(p)) {
      try { this.manifest = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch { this.manifest = { version: 1, files: {} }; }
    } else {
      this.manifest = { version: 1, files: {} };
    }
    return this.manifest;
  }

  _saveManifest() {
    this._ensureDir();
    fs.writeFileSync(this._manifestPath(), JSON.stringify(this.manifest, null, 2));
  }

  _fileHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  _chunkCachePath(fileHash) {
    return path.join(this.cacheDir, `vec-${fileHash.substring(0, 16)}.json`);
  }

  /**
   * Try to load ALL files from disk cache without calling embedFn.
   * Returns true if every file was found in cache (SHA match), false otherwise.
   * When true, sets this.built = true so build() can be skipped.
   *
   * @param {string[]} filePaths - Absolute file paths to check
   * @param {string} basePath - Base directory for relative paths
   * @returns {boolean} true if fully cached, false if any file needs (re-)embedding
   */
  tryLoadFromCache(filePaths, basePath) {
    const manifest = this._loadManifest();
    if (!manifest.files || Object.keys(manifest.files).length === 0) return false;

    const chunks = [];

    for (const filePath of filePaths) {
      const relPath = path.relative(basePath, filePath);
      const entry = manifest.files[relPath];
      if (!entry) return false; // file not in manifest → needs indexing

      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { return false; }

      const hash = this._fileHash(content);
      if (hash !== entry.hash) return false; // file changed → needs re-indexing

      const cachePath = this._chunkCachePath(hash);
      if (!fs.existsSync(cachePath)) return false; // cache file missing

      try {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const chunk of cachedData.chunks) {
          chunks.push({ file: filePath, ...chunk });
        }
      } catch { return false; }
    }

    // All files loaded from cache successfully
    this.chunks = chunks;
    this.built = true;
    return true;
  }

  /**
   * Build or update the vector index for a list of files.
   * Only re-embeds files whose content hash has changed.
   *
   * @param {string[]} filePaths - Absolute file paths to index
   * @param {string} basePath - Base directory for relative paths in manifest
   * @param {Function} embedFn - async (text) => number[] embedding function
   * @param {Function} [onProgress] - optional (done, total) callback
   * @returns {{ indexed, cached, total, errors }}
   */
  async build(filePaths, basePath, embedFn, onProgress) {
    this._ensureDir();
    const manifest = this._loadManifest();
    let indexed = 0, cached = 0, errors = 0, done = 0;
    const BATCH_SIZE = 5;

    for (let batchStart = 0; batchStart < filePaths.length; batchStart += BATCH_SIZE) {
      const batch = filePaths.slice(batchStart, batchStart + BATCH_SIZE);

      await Promise.all(batch.map(async (filePath) => {
        const relPath = path.relative(basePath, filePath);

        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { errors++; done++; if (onProgress) onProgress(done, filePaths.length); return; }

        const hash = this._fileHash(content);
        const existing = manifest.files[relPath];

        // Check cache hit
        if (existing && existing.hash === hash) {
          const cachePath = this._chunkCachePath(hash);
          if (fs.existsSync(cachePath)) {
            try {
              const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
              for (const chunk of cachedData.chunks) {
                this.chunks.push({ file: filePath, ...chunk });
              }
              cached++;
              done++;
              if (onProgress) onProgress(done, filePaths.length);
              return;
            } catch { /* re-index on cache read error */ }
          }
        }

        // Chunk the file
        const fileChunks = chunkFile(content, filePath);

        // Embed each chunk sequentially (rate-limit friendly)
        const embeddedChunks = [];
        for (const chunk of fileChunks) {
          // Skip chunks that are too short to be meaningful
          if (chunk.text.trim().length < 20) continue;

          // Truncate very long chunks (embedding models have token limits)
          const truncated = chunk.text.length > 8000 ? chunk.text.substring(0, 8000) : chunk.text;

          try {
            const embedding = await embedFn(truncated);
            const embeddedChunk = {
              text: chunk.text,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              embedding
            };
            embeddedChunks.push(embeddedChunk);
            this.chunks.push({ file: filePath, ...embeddedChunk });
          } catch (err) {
            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[VectorStore] Embedding error for ${relPath}:${chunk.startLine}: ${err.message}`);
            }
            errors++;
          }
        }

        // Save to disk cache
        if (embeddedChunks.length > 0) {
          const cachePath = this._chunkCachePath(hash);
          try {
            fs.writeFileSync(cachePath, JSON.stringify({ chunks: embeddedChunks }));
          } catch { /* non-fatal */ }
        }

        // Update manifest
        manifest.files[relPath] = { hash, chunkCount: embeddedChunks.length };
        indexed++;
        done++;
        if (onProgress) onProgress(done, filePaths.length);
      }));
    }

    this.manifest = manifest;
    this._saveManifest();
    this.built = true;

    return { indexed, cached, total: filePaths.length, errors };
  }

  /**
   * Search the vector store by semantic similarity.
   *
   * @param {number[]} queryEmbedding - The query embedding vector
   * @param {number} maxResults - Max results to return
   * @param {number} threshold - Minimum similarity threshold (0-1)
   * @returns {Array<{ file, score, startLine, endLine, text }>}
   */
  search(queryEmbedding, maxResults = 20, threshold = 0.3) {
    if (!this.chunks.length) return [];

    const scored = this.chunks
      .map(chunk => ({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return scored;
  }

  /**
   * Get stats about the current index.
   */
  getStats() {
    return {
      totalChunks: this.chunks.length,
      totalFiles: this.manifest ? Object.keys(this.manifest.files).length : 0,
      cacheDir: this.cacheDir
    };
  }
}

// ─── Singleton cache per directory ──────────────────────────────────────

const storeCache = new Map();
const STORE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get or create a VectorStore for a directory.
 * Returns cached instance if still fresh.
 */
export function getOrCreateVectorStore(dirPath) {
  const cached = storeCache.get(dirPath);
  if (cached && (Date.now() - cached.timestamp) < STORE_TTL) {
    return cached.store;
  }

  const cacheDir = path.join(process.cwd(), '.koi', 'cache', 'vectors',
    crypto.createHash('md5').update(dirPath).digest('hex').substring(0, 12));

  const store = new VectorStore(cacheDir);
  storeCache.set(dirPath, { store, timestamp: Date.now() });
  return store;
}
