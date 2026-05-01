/**
 * Media Library — Global persistent storage for ALL user-visible assets:
 * images, videos, audio, voice samples, AND timelines.
 *
 * Uses LanceDB at ~/.koi/media-library/ to store media with:
 *   - Binary data on disk; the row carries the path
 *   - Metadata (mime_type, filename, width, height, created_at, favorite,
 *     `categories[]` — multivalued user-visible tags / collections)
 *   - Embedding vector for semantic search
 *   - Generation parameters (prompt, model, reference images, etc.)
 *   - SAM2 masks (cached once computed)
 *
 * media_type values:
 *   - 'image' | 'video' | 'audio' — auto-detected from extension
 *   - 'voice'     — voice sample (the cloned-voice registry stores a
 *                   sample audio + provider metadata; the row points
 *                   at that sample, with the provider/model in metadata)
 *   - 'timeline'  — video editor timeline (the row's filePath is the
 *                   `~/.koi/timelines/<id>.json` document; metadata
 *                   carries clip count, duration, etc.)
 *   - 'unknown'   — fallback when the extension doesn't match
 *
 * Categories: multi-valued tags. `categories[]` is stored inside
 * `metadata_json` for now (so schema doesn't need a LanceDB column
 * migration). The drawer surfaces them as collection chips:
 * `galleryListCategories()` returns the union, `addCategory(id, cat)` /
 * `removeCategory(id, cat)` mutate one row's tag set, and
 * `list({ category })` filters by a single tag. When we move to cloud
 * sync we'll promote this to a real LanceDB column for fast SQL filters.
 *
 * Deduplication: content hash (SHA-256) prevents storing the same file
 * twice. For timelines / voices (whose content evolves over time at a
 * stable path) save helpers use `upsertByPath` semantics instead.
 *
 * Usage:
 *   const lib = MediaLibrary.global();
 *   const id = await lib.save({ filePath: '/tmp/img.png', metadata: { prompt: '...' } });
 *   const items = await lib.list({ favorite: true, limit: 50 });
 *   const results = await lib.search(embedding, 10);
 *   await lib.addCategory(id, 'project-A');
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

function detectMimeType(filePath, mediaType = null) {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  };
  // Synthetic media types. Timelines are koi JSON documents — give
  // them a recognisable mime so the GUI side can distinguish "play this"
  // from "open this in the editor". Voices reuse the audio mime of the
  // sample.
  if (mediaType === 'timeline') return 'application/x-koi-timeline+json';
  return mimes[ext] || 'application/octet-stream';
}

/** Lowercase / trim / dedup / cap a tag list. Empty strings get dropped. */
function _normaliseCategories(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 32) break; // hard cap, sanity
  }
  return out;
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
        // Clean up duplicates on first open
        this.deduplicate().catch(() => {});
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
          favorite: 0,
          description: '',
          metadata_json: '{}',
          sam2_masks_json: '',
          embedding: new Array(EMBEDDING_DIM).fill(0),
        }]);
        // Delete seed
        try { await this._table.delete('id = "__seed__"'); } catch {}
      }
      // One-shot migration of legacy on-disk artefacts (timeline JSONs
      // and the cloned-voice registry) into the media library. Runs
      // EVERY time the table is opened but is fully idempotent — the
      // upsert-by-path semantics on saveTimelineEntry / saveVoiceEntry
      // mean a re-run is equivalent to a refresh of the metadata.
      // Fire-and-forget so the table-open path stays fast for callers.
      this._migrateLegacyArtefacts().catch((e) => {
        process.stderr.write(`[MediaLibrary] migration failed: ${e.message}\n`);
      });
      return this._table;
    })();
    this._table = await this._tablePromise;
    return this._table;
  }

  /** Pull existing timelines and voices from disk into the library so
   *  the GUI drawer can rely on a single source of truth. Idempotent —
   *  upserts by file_path, doesn't re-embed or duplicate. */
  async _migrateLegacyArtefacts() {
    let timelines = 0;
    let voices = 0;
    // Timelines: scan ~/.koi/timelines/*.json in the project root if
    // available (KOI_PROJECT_ROOT) AND the global home as a fallback.
    const projectRoot = process.env.KOI_PROJECT_ROOT;
    const candidates = [];
    if (projectRoot) candidates.push(path.join(projectRoot, '.koi', 'timelines'));
    candidates.push(path.join(os.homedir(), '.koi', 'timelines'));
    const seen = new Set();
    for (const dir of candidates) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!fs.existsSync(dir)) continue;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.json')) continue;
          const fp = path.join(dir, name);
          try {
            const state = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const { saveTimelineEntry } = await import('./media-library.js');
            await saveTimelineEntry(fp, state, null);
            timelines++;
          } catch (e) {
            process.stderr.write(`[MediaLibrary] migrate timeline ${fp} skipped: ${e.message}\n`);
          }
        }
      } catch { /* unreadable dir */ }
    }
    // Voices: a single registry file at ~/.koi/voices/voices.json
    const voicesJson = path.join(os.homedir(), '.koi', 'voices', 'voices.json');
    if (fs.existsSync(voicesJson)) {
      try {
        const arr = JSON.parse(fs.readFileSync(voicesJson, 'utf8'));
        if (Array.isArray(arr)) {
          const { saveVoiceEntry } = await import('./media-library.js');
          for (const entry of arr) {
            if (!entry?.samplePath) continue;
            if (!fs.existsSync(entry.samplePath)) continue;
            try {
              await saveVoiceEntry(entry.samplePath, entry, null);
              voices++;
            } catch (e) {
              process.stderr.write(`[MediaLibrary] migrate voice ${entry.id || ''} skipped: ${e.message}\n`);
            }
          }
        }
      } catch (e) {
        process.stderr.write(`[MediaLibrary] migrate voices.json skipped: ${e.message}\n`);
      }
    }
    if (timelines > 0 || voices > 0) {
      process.stderr.write(`[MediaLibrary] migration: indexed ${timelines} timeline(s), ${voices} voice(s)\n`);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Save a media file to the library. Deduplicates by content hash by
   * default; pass `replaceByPath: true` for "this filePath is the
   * authoritative key, replace any existing row at it" semantics —
   * used for timelines / voices whose content evolves at a stable path.
   *
   * @param {Object} opts
   * @param {string} opts.filePath - Path to the media file on disk
   * @param {string} [opts.mediaType] - Override auto-detection ('timeline', 'voice', etc.)
   * @param {Object} [opts.metadata] - Generation params (prompt, model, refs, etc.)
   * @param {string[]} [opts.categories] - Multi-valued tags (collections)
   * @param {string} [opts.description] - Human-readable description for embedding
   * @param {number[]} [opts.embedding] - Pre-computed embedding vector
   * @param {boolean} [opts.favorite] - Mark as favorite
   * @param {boolean} [opts.replaceByPath] - Upsert semantics keyed on file_path
   * @returns {Promise<{id: string, isNew: boolean}>}
   */
  async save({
    filePath,
    mediaType,
    metadata = {},
    categories,
    description = '',
    embedding = null,
    favorite = false,
    replaceByPath = false,
  }) {
    const table = await this._ensureTable();
    const buffer = fs.readFileSync(filePath);
    const hash = contentHash(buffer);
    const escPath = String(filePath).replace(/'/g, "''");

    // Replace-by-path: the caller declares filePath is the authoritative
    // identity (timelines, voices). Drop any existing row at that path
    // BEFORE the dedup checks so the new content (and its updated
    // metadata / embedding / categories) wins.
    if (replaceByPath) {
      try {
        await table.delete(`file_path = '${escPath}'`);
      } catch { /* nothing to delete */ }
    }

    // Categories normalisation: lowercase trim, dedup, drop empties.
    // Stored inside metadata_json for now (see file header). Existing
    // tags survive when the caller doesn't pass `categories` — only
    // an explicit array overrides them, so a save that doesn't know
    // about tags doesn't accidentally clear them.
    if (Array.isArray(categories)) {
      const norm = _normaliseCategories(categories);
      metadata = { ...metadata, categories: norm };
    }

    // Dedup: content_hash is the primary identity — same bytes == same asset.
    // When a caller re-saves an existing file (most commonly: an image that
    // was generated, then later reused as a reference) we MUST NOT create a
    // second row. Doing so caused metadata loss: the original generation
    // metadata (prompt, model, sampler…) would be shadowed by the newer
    // "source: reference" entry because list() keeps the newest per hash.
    //
    // Historically this used `table.search(zeroVec).where(...)` which is
    // unreliable — LanceDB's vector search + where can return empty when
    // the stored embedding is the zero placeholder. `table.filter()` is
    // purely metadata-driven and always sees the row.
    const escHash = String(hash).replace(/'/g, "''");
    if (!replaceByPath) {
      try {
        const byHash = await table.query().where(`content_hash = '${escHash}'`).limit(1).toArray();
        if (byHash.length > 0) {
          return { id: byHash[0].id, isNew: false };
        }
      } catch { /* table empty — fall through */ }

      // Secondary dedup: same file_path. Defends against the rare case where
      // the file was re-encoded identically (same pixels, new bytes → new
      // hash) between the original save and this one. Still preserves the
      // original row and its metadata.
      try {
        const byPath = await table.query().where(`file_path = '${escPath}'`).limit(1).toArray();
        if (byPath.length > 0) {
          return { id: byPath[0].id, isNew: false };
        }
      } catch { /* ignore */ }
    }

    const resolvedType = mediaType || detectMediaType(filePath);
    // Image dimensions only make sense for raster media. Skip the
    // sharp probe for everything else (avoids "Input file is missing
    // a header" warnings on .json / .wav files).
    const dims = (resolvedType === 'image')
      ? await getImageDimensions(filePath)
      : { width: 0, height: 0 };
    const id = `media-${Date.now()}-${hash.substring(0, 8)}`;

    const row = {
      id,
      content_hash: hash,
      media_type: resolvedType,
      mime_type: detectMimeType(filePath, resolvedType),
      filename: path.basename(filePath),
      file_path: filePath,
      width: dims.width,
      height: dims.height,
      created_at: new Date().toISOString(),
      favorite: favorite ? 1 : 0,
      description: description || '',
      metadata_json: JSON.stringify(metadata),
      sam2_masks_json: '',
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
      const escId = String(id).replace(/'/g, "''");
      const rows = await table.query().where(`id = '${escId}'`).limit(1).toArray();
      return rows.length > 0 ? this._deserialize(rows[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get a media item by file path (no vector search required).
   */
  async getByPath(filePath) {
    const table = await this._ensureTable();
    try {
      const escaped = filePath.replace(/'/g, "''");
      const rows = await table.query().where(`file_path = '${escaped}'`).limit(1).toArray();
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
      const escHash = String(hash).replace(/'/g, "''");
      const rows = await table.query().where(`content_hash = '${escHash}'`).limit(1).toArray();
      return rows.length > 0 ? this._deserialize(rows[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * List media items with optional filters.
   * @param {Object} [opts]
   * @param {boolean} [opts.favorite] - Filter by favorite
   * @param {string} [opts.mediaType] - Filter by single type
   * @param {string[]} [opts.mediaTypes] - Filter by ANY of these types
   *   (e.g. ['image','video','timeline'] for the "Latest" drawer tab)
   * @param {string} [opts.category] - Multi-valued tag filter (drawer
   *   collection chip). In-memory match against `metadata.categories`
   *   because LanceDB doesn't natively index JSON arrays — fast enough
   *   for the catalog sizes we expect (low thousands).
   * @param {number} [opts.limit=100]
   * @param {number} [opts.offset=0]
   */
  async list({ favorite, mediaType, mediaTypes, category, limit = 100, offset = 0 } = {}) {
    // LanceDB is the single source of truth — no fallbacks, no disk scanning.
    const table = await this._ensureTable();

    const conditions = [];
    // `favorite` is a Float64 column (seeded with 0/1) — comparing against
    // a SQL boolean literal `true`/`false` errors with "could not convert
    // to literal of type 'Float64'". Coerce to the numeric literal.
    if (favorite !== undefined) conditions.push(`favorite = ${favorite ? 1 : 0}`);
    if (mediaType) conditions.push(`media_type = '${mediaType}'`);
    if (Array.isArray(mediaTypes) && mediaTypes.length > 0) {
      const list = mediaTypes
        .filter(t => typeof t === 'string' && t)
        .map(t => `'${t.replace(/'/g, "''")}'`)
        .join(', ');
      if (list) conditions.push(`media_type IN (${list})`);
    }

    let rows;
    if (conditions.length > 0) {
      rows = await table.query().where(conditions.join(' AND ')).limit(10000).toArray();
    } else {
      rows = await table.query().limit(10000).toArray();
    }

    // Categories are in metadata_json (see file header), so the
    // category filter runs in-memory after the SQL pass.
    if (category && typeof category === 'string') {
      const target = category.toLowerCase();
      rows = rows.filter(r => {
        try {
          const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
          const cats = Array.isArray(meta.categories) ? meta.categories : [];
          return cats.some(c => typeof c === 'string' && c.toLowerCase() === target);
        } catch { return false; }
      });
    }

    // Deduplicate by content_hash — keep the newest entry per hash
    const seen = new Map();
    for (const r of rows) {
      const hash = r.content_hash;
      if (!hash || hash === '') { seen.set(r.id, r); continue; }
      const existing = seen.get(hash);
      if (!existing || r.created_at > existing.created_at) {
        seen.set(hash, r);
      }
    }
    const unique = Array.from(seen.values())
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    return unique.slice(offset, offset + limit).map(r => this._deserialize(r));
  }

  /**
   * Remove duplicate entries from LanceDB (keeps newest per content_hash).
   * Called on startup or manually.
   */
  async deduplicate() {
    const table = await this._ensureTable();
    const rows = await table.query().limit(100000).toArray();

    const byHash = new Map();
    for (const r of rows) {
      const hash = r.content_hash;
      if (!hash || hash === '') continue;
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(r);
    }

    let removed = 0;
    for (const [, dupes] of byHash) {
      if (dupes.length <= 1) continue;
      // Sort newest first, delete the rest
      dupes.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      for (let i = 1; i < dupes.length; i++) {
        try {
          await table.delete(`id = '${dupes[i].id}'`);
          removed++;
        } catch {}
      }
    }
    if (removed > 0) {
      console.warn(`[MediaLibrary] Deduplicated: removed ${removed} duplicate entries`);
    }
    return removed;
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
    const val = favorite ? '1' : '0';
    const escId = String(id).replace(/'/g, "''");
    try {
      // LanceDB update() expects SQL expression strings as values, not JS
      // numbers, AND the where clause goes inside the options object — not
      // via a `.where().execute()` chain (that API doesn't exist on the
      // installed lancedb). For `favorite` the value `'1'` / `'0'` IS a
      // valid SQL literal so the default 2-arg shape works.
      await table.update({ favorite: val }, { where: `id = '${escId}'` });
    } catch (e) {
      process.stderr.write(`[MediaLibrary] setFavorite failed for ${id}: ${e.message}\n`);
    }
    return true;
  }

  /**
   * Update SAM2 masks for a media item (cache once computed).
   */
  async setSam2Masks(id, masks) {
    const table = await this._ensureTable();
    const escId = String(id).replace(/'/g, "''");
    // Use the explicit `{values, where}` shape so the JSON blob is
    // toSQL-escaped instead of being spliced as a raw SQL expression
    // (which fails to parse on the leading `{`).
    await table.update({
      values: { sam2_masks_json: JSON.stringify(masks) },
      where: `id = '${escId}'`,
    });
    return true;
  }

  async setEmbedding(id, embedding) {
    const table = await this._ensureTable();
    const escId = String(id).replace(/'/g, "''");
    await table.update({ values: { embedding }, where: `id = '${escId}'` });
    return true;
  }

  async remove(id) {
    const table = await this._ensureTable();
    try {
      await table.delete(`id = '${id}'`);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove rows by their absolute file_path. Used by timelines.js /
   *  voice-registry.js when their on-disk artefact is deleted. */
  async removeByPath(filePath) {
    const table = await this._ensureTable();
    const escPath = String(filePath).replace(/'/g, "''");
    try {
      await table.delete(`file_path = '${escPath}'`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Categories ──────────────────────────────────────────────────────────
  //
  // Multi-valued tags backing the drawer's collection chips. Stored
  // inside `metadata_json` for now (no schema migration); migrate to a
  // top-level column when cloud sync needs SQL-level filtering.

  /** Read the current category list for a row. Returns []. */
  async _readCategories(id) {
    const table = await this._ensureTable();
    try {
      const rows = await table.query().where(`id = '${id}'`).limit(1).toArray();
      if (rows.length === 0) return [];
      const meta = rows[0].metadata_json ? JSON.parse(rows[0].metadata_json) : {};
      return Array.isArray(meta.categories) ? meta.categories : [];
    } catch { return []; }
  }

  /** Persist a new category set on a row (replaces, doesn't merge). */
  async _writeCategories(id, categories) {
    const table = await this._ensureTable();
    try {
      const rows = await table.query().where(`id = '${id}'`).limit(1).toArray();
      if (rows.length === 0) return false;
      const meta = rows[0].metadata_json ? JSON.parse(rows[0].metadata_json) : {};
      meta.categories = _normaliseCategories(categories);
      const escId = String(id).replace(/'/g, "''");
      // LanceDB has two `update` shapes:
      //   - the "default" 2-arg form maps each value through toSQL on the
      //     way down — except when neither `values` nor `valuesSql` is set,
      //     in which case the values are spliced into SQL **as raw
      //     expressions** (so a JSON blob with `{` blows up the parser).
      //   - the explicit `{values, where}` form runs every value through
      //     toSQL (string → quoted SQL string). That's what we need for
      //     metadata_json, which is JSON, not a SQL expression.
      await table.update({
        values: { metadata_json: JSON.stringify(meta) },
        where: `id = '${escId}'`,
      });
      return true;
    } catch (e) {
      process.stderr.write(`[MediaLibrary] _writeCategories(${id}) failed: ${e.message}\n`);
      return false;
    }
  }

  /** Add a single category to a row's tag set. Idempotent. */
  async addCategory(id, category) {
    if (!category || typeof category !== 'string') return false;
    const cats = await this._readCategories(id);
    const next = _normaliseCategories([...cats, category]);
    return this._writeCategories(id, next);
  }

  /** Remove a single category from a row. Case-insensitive match. */
  async removeCategory(id, category) {
    if (!category || typeof category !== 'string') return false;
    const target = category.toLowerCase();
    const cats = await this._readCategories(id);
    const next = cats.filter(c => typeof c === 'string' && c.toLowerCase() !== target);
    if (next.length === cats.length) return false;
    return this._writeCategories(id, next);
  }

  /** Distinct categories across the whole library, with item counts.
   *  Returns [{ name, count }] sorted alphabetically. */
  async listCategories() {
    const table = await this._ensureTable();
    const rows = await table.query().limit(100000).toArray();
    const counts = new Map();
    const display = new Map(); // lowercase → original casing of first occurrence
    for (const r of rows) {
      try {
        const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
        const cats = Array.isArray(meta.categories) ? meta.categories : [];
        for (const c of cats) {
          if (typeof c !== 'string' || !c) continue;
          const key = c.toLowerCase();
          counts.set(key, (counts.get(key) || 0) + 1);
          if (!display.has(key)) display.set(key, c);
        }
      } catch { /* skip corrupt row */ }
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ name: display.get(key) || key, count }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
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
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    const categories = Array.isArray(metadata.categories) ? metadata.categories : [];
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
      metadata,
      // Surfaced separately for the drawer / chip code so it doesn't
      // have to peek inside `metadata` (the storage location is an
      // implementation detail; categories will move to a top-level
      // column when cloud sync lands).
      categories,
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

/**
 * Save a generated video to the media library with full generation params.
 *
 * Thin alias over [saveGeneratedImage] — `MediaLibrary.save()` already
 * detects media type from the file extension via `detectMediaType()`,
 * so the underlying row gets `media_type: 'video'` automatically. This
 * wrapper exists for callers that want a name matching their intent
 * and so the doc-comment can list video-specific generation fields
 * (prompt, model, duration, aspectRatio, resolution, cameraMovement,
 * referenceVideos, referenceImages, startFrame, endFrame, shots, …).
 *
 * @param {string} filePath - Path to generated video on disk.
 * @param {Object} generationParams - All parameters used for generation.
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider] - For description embedding.
 */
export async function saveGeneratedVideo(filePath, generationParams, llmProvider) {
  return saveGeneratedImage(filePath, generationParams, llmProvider);
}

/**
 * Save (or upsert) a TIMELINE entry — `~/.koi/timelines/<id>.json`.
 * Unlike images / videos, the file CONTENT changes over time at a
 * stable path, so this uses replace-by-path semantics: the row gets
 * rewritten on every save (new hash, new metadata, fresh embedding).
 *
 * @param {string} filePath - `~/.koi/timelines/<id>.json` path.
 * @param {Object} timeline - Parsed timeline JSON. Used to derive
 *   description (project name + clip count + duration) and metadata.
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider]
 */
export async function saveTimelineEntry(filePath, timeline, llmProvider) {
  const lib = MediaLibrary.global();
  const name = timeline?.name || path.basename(filePath, '.json');
  const clipCount = Array.isArray(timeline?.clips) ? timeline.clips.length : 0;
  // Approximate duration from the latest clip end. Cheap to compute
  // and useful as a description hint.
  let durationMs = 0;
  for (const c of timeline?.clips || []) {
    const end = (c?.startMs || 0) + (c?.durationMs || 0);
    if (end > durationMs) durationMs = end;
  }
  const description =
    `Timeline "${name}" — ${clipCount} clip${clipCount === 1 ? '' : 's'}, ` +
    `${(durationMs / 1000).toFixed(1)}s. ` +
    `Tracks: ${timeline?.settings?.videoTracks ?? 0} video / ${timeline?.settings?.audioTracks ?? 0} audio.`;
  let embedding = null;
  if (llmProvider) {
    try { embedding = await llmProvider.embedText(description); } catch { /* tolerate */ }
  }
  const metadata = {
    source: 'timeline',
    timelineId: timeline?.id,
    name,
    clipCount,
    durationMs,
    videoTracks: timeline?.settings?.videoTracks ?? 0,
    audioTracks: timeline?.settings?.audioTracks ?? 0,
    updatedAt: timeline?.updatedAt || null,
  };
  return lib.save({
    filePath,
    mediaType: 'timeline',
    metadata,
    description,
    embedding,
    replaceByPath: true,
  });
}

/**
 * Save (or upsert) a VOICE entry — points at the cloned-voice sample
 * audio file. The provider, model, and language ride in metadata.
 *
 * @param {string} filePath - Absolute path to the sample audio file.
 * @param {Object} voice - Voice registry entry.
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider]
 */
export async function saveVoiceEntry(filePath, voice, llmProvider) {
  const lib = MediaLibrary.global();
  const name = voice?.name || path.basename(filePath, path.extname(filePath));
  const provider = voice?.provider || 'unknown';
  const model = voice?.modelSlug || '';
  const lang = voice?.language ? ` (${voice.language})` : '';
  const description =
    `Voice "${name}"${lang} — ${provider}${model ? ` / ${model}` : ''}. ` +
    (voice?.description ? voice.description : '');
  let embedding = null;
  if (llmProvider) {
    try { embedding = await llmProvider.embedText(description); } catch { /* tolerate */ }
  }
  const metadata = {
    source: 'voice',
    voiceId: voice?.id,
    providerVoiceId: voice?.providerVoiceId,
    name,
    provider,
    modelSlug: model,
    language: voice?.language || null,
    note: voice?.description || '',
  };
  return lib.save({
    filePath,
    mediaType: 'voice',
    metadata,
    description,
    embedding,
    replaceByPath: true,
  });
}
