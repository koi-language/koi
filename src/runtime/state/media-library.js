/**
 * Media Library — Global persistent storage for images, videos, and audio.
 *
 * Uses LanceDB at ~/.koi/media-library/ to store media with:
 *   - Binary data (image_bytes as base64)
 *   - Metadata (mime_type, filename, width, height, created_at, favorite, etc.)
 *   - Embedding vector for semantic search
 *   - Generation parameters (prompt, model, reference images, etc.)
 *   - SAM2 masks (cached once computed)
 *
 * Deduplication: content hash (SHA-256) prevents storing the same file twice.
 *
 * Usage:
 *   const lib = MediaLibrary.global();
 *   const id = await lib.save({ filePath: '/tmp/img.png', metadata: { prompt: '...' } });
 *   const items = await lib.list({ favorite: true, limit: 50 });
 *   const results = await lib.search(embedding, 10);
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const EMBEDDING_DIM = 1536;
const DB_DIR = path.join(os.homedir(), '.koi', 'media-library');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

function detectMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'unknown';
}

function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  };
  return mimes[ext] || 'application/octet-stream';
}

function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Get image dimensions using sharp (if available) or fallback to basic PNG parsing. */
async function getImageDimensions(filePath) {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(filePath).metadata();
    return { width: meta.width || 0, height: meta.height || 0 };
  } catch {
    // Fallback: try to read PNG header
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
    } catch {}
    return { width: 0, height: 0 };
  }
}

export class MediaLibrary {
  constructor() {
    this._db = null;
    this._dbPromise = null;
    this._table = null;
    this._tablePromise = null;
  }

  // ── Singleton ───────────────────────────────────────────────────────────

  static _instance = null;
  static global() {
    if (!MediaLibrary._instance) {
      MediaLibrary._instance = new MediaLibrary();
    }
    return MediaLibrary._instance;
  }

  // ── DB setup ────────────────────────────────────────────────────────────

  async _ensureDb() {
    if (this._db) return;
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = (async () => {
      const lancedb = await import('@lancedb/lancedb');
      fs.mkdirSync(DB_DIR, { recursive: true });
      this._db = await lancedb.connect(path.join(DB_DIR, 'lancedb'));
    })();
    await this._dbPromise;
  }

  async _ensureTable() {
    if (this._table) return this._table;
    if (this._tablePromise) return this._tablePromise;
    this._tablePromise = (async () => {
      await this._ensureDb();
      const names = await this._db.tableNames();
      if (names.includes('media')) {
        this._table = await this._db.openTable('media');
      } else {
        // Create with a seed row that we immediately delete
        this._table = await this._db.createTable('media', [{
          id: '__seed__',
          content_hash: '',
          media_type: 'image',
          mime_type: 'image/png',
          filename: '',
          file_path: '',
          width: 0,
          height: 0,
          created_at: new Date().toISOString(),
          favorite: false,
          description: '',
          metadata_json: '{}',
          sam2_masks_json: null,
          embedding: new Array(EMBEDDING_DIM).fill(0),
        }]);
        // Delete seed
        try { await this._table.delete('id = "__seed__"'); } catch {}
      }
      return this._table;
    })();
    this._table = await this._tablePromise;
    return this._table;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Save a media file to the library. Deduplicates by content hash.
   *
   * @param {Object} opts
   * @param {string} opts.filePath - Path to the media file on disk
   * @param {Object} [opts.metadata] - Generation params (prompt, model, refs, etc.)
   * @param {string} [opts.description] - Human-readable description for embedding
   * @param {number[]} [opts.embedding] - Pre-computed embedding vector
   * @param {boolean} [opts.favorite] - Mark as favorite
   * @returns {Promise<{id: string, isNew: boolean}>}
   */
  async save({ filePath, metadata = {}, description = '', embedding = null, favorite = false }) {
    const table = await this._ensureTable();
    const buffer = fs.readFileSync(filePath);
    const hash = contentHash(buffer);

    // Check for existing entry with same hash (deduplication)
    try {
      const existing = await table.search(new Array(EMBEDDING_DIM).fill(0))
        .where(`content_hash = '${hash}'`)
        .limit(1)
        .toArray();
      if (existing.length > 0) {
        return { id: existing[0].id, isNew: false };
      }
    } catch {
      // Table might be empty — ignore search errors
    }

    const dims = await getImageDimensions(filePath);
    const id = `media-${Date.now()}-${hash.substring(0, 8)}`;
    const ext = path.extname(filePath).toLowerCase();

    const row = {
      id,
      content_hash: hash,
      media_type: detectMediaType(filePath),
      mime_type: detectMimeType(filePath),
      filename: path.basename(filePath),
      file_path: filePath,
      width: dims.width,
      height: dims.height,
      created_at: new Date().toISOString(),
      favorite,
      description: description || '',
      metadata_json: JSON.stringify(metadata),
      sam2_masks_json: null,
      embedding: embedding || new Array(EMBEDDING_DIM).fill(0),
    };

    await table.add([row]);
    return { id, isNew: true };
  }

  /**
   * Get a single media item by ID.
   */
  async get(id) {
    const table = await this._ensureTable();
    try {
      const rows = await table.search(new Array(EMBEDDING_DIM).fill(0))
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();
      return rows.length > 0 ? this._deserialize(rows[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get a media item by content hash (for deduplication checks).
   */
  async getByHash(hash) {
    const table = await this._ensureTable();
    try {
      const rows = await table.search(new Array(EMBEDDING_DIM).fill(0))
        .where(`content_hash = '${hash}'`)
        .limit(1)
        .toArray();
      return rows.length > 0 ? this._deserialize(rows[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * List media items with optional filters.
   * @param {Object} [opts]
   * @param {boolean} [opts.favorite] - Filter by favorite
   * @param {string} [opts.mediaType] - Filter by 'image'|'video'|'audio'
   * @param {number} [opts.limit=100]
   * @param {number} [opts.offset=0]
   */
  async list({ favorite, mediaType, limit = 100, offset = 0 } = {}) {
    // Try LanceDB first
    try {
      const table = await this._ensureTable();
      let query = table.search(new Array(EMBEDDING_DIM).fill(0));

      const conditions = [];
      if (favorite !== undefined) conditions.push(`favorite = ${favorite}`);
      if (mediaType) conditions.push(`media_type = '${mediaType}'`);
      if (conditions.length > 0) {
        query = query.where(conditions.join(' AND '));
      }

      const rows = await query.limit(limit + offset).toArray();
      if (rows.length > 0) {
        return rows.slice(offset).map(r => this._deserialize(r));
      }
    } catch {
      // LanceDB unavailable or empty — fall through to filesystem scan
    }

    // Fallback: scan ~/.koi/images/ directory for image files
    const imagesDir = path.join(os.homedir(), '.koi', 'images');
    if (!fs.existsSync(imagesDir)) return [];
    try {
      const files = fs.readdirSync(imagesDir)
        .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
        .map(f => {
          const fp = path.join(imagesDir, f);
          const stat = fs.statSync(fp);
          return {
            id: f,
            filePath: fp,
            file_path: fp,
            filename: f,
            media_type: 'image',
            mime_type: detectMimeType(fp),
            created_at: stat.birthtime.toISOString(),
            favorite: false,
            description: '',
            metadata: {},
            width: 0,
            height: 0,
          };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));

      if (mediaType && mediaType !== 'image') return [];
      return files.slice(offset, offset + limit);
    } catch {
      return [];
    }
  }

  /**
   * Semantic search by embedding vector.
   */
  async search(embedding, limit = 10) {
    const table = await this._ensureTable();
    try {
      const rows = await table.search(embedding).limit(limit).toArray();
      return rows.map(r => this._deserialize(r));
    } catch {
      return [];
    }
  }

  /**
   * Toggle or set favorite status.
   */
  async setFavorite(id, favorite) {
    const table = await this._ensureTable();
    try {
      await table.update({ favorite }, `id = '${id}'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update SAM2 masks for a media item (cache once computed).
   */
  async setSam2Masks(id, masks) {
    const table = await this._ensureTable();
    try {
      await table.update({ sam2_masks_json: JSON.stringify(masks) }, `id = '${id}'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update the embedding for a media item.
   */
  async setEmbedding(id, embedding) {
    const table = await this._ensureTable();
    try {
      await table.update({ embedding }, `id = '${id}'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a media item by ID.
   */
  async remove(id) {
    const table = await this._ensureTable();
    try {
      await table.delete(`id = '${id}'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get total count of items.
   */
  async count() {
    const table = await this._ensureTable();
    try {
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _deserialize(row) {
    return {
      id: row.id,
      contentHash: row.content_hash,
      mediaType: row.media_type,
      mimeType: row.mime_type,
      filename: row.filename,
      filePath: row.file_path,
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
      favorite: !!row.favorite,
      description: row.description || '',
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      sam2Masks: row.sam2_masks_json ? JSON.parse(row.sam2_masks_json) : null,
      // Embedding omitted from deserialization (large, not needed for display)
    };
  }
}

// ── Convenience function for auto-saving generated images ──────────────

/**
 * Save a generated image to the media library with full generation params.
 * Called automatically by image generation tools.
 *
 * @param {string} filePath - Path to generated image
 * @param {Object} generationParams - All parameters used for generation
 * @param {string} generationParams.prompt - The generation prompt
 * @param {string} [generationParams.model] - Model used
 * @param {string} [generationParams.aspectRatio] - Aspect ratio
 * @param {string[]} [generationParams.referenceImages] - Paths to reference images
 * @param {Object} [generationParams.*] - Any other params
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider] - For embedding
 */
/**
 * Save a generated image to the media library with full generation params.
 * Reference images should already be saved separately before calling this.
 *
 * @param {string} filePath - Path to generated image
 * @param {Object} generationParams - All parameters used for generation
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider] - For embedding
 */
export async function saveGeneratedImage(filePath, generationParams, llmProvider) {
  const lib = MediaLibrary.global();

  // Use the prompt as description for the embedding
  let description = generationParams.prompt || path.basename(filePath);
  let embedding = null;

  if (llmProvider) {
    try {
      embedding = await llmProvider.embedText(description);
    } catch {
      // Embedding failed — save without it (can be added later)
    }
  }

  return lib.save({
    filePath,
    metadata: { ...generationParams, source: 'generated' },
    description,
    embedding,
  });
}
