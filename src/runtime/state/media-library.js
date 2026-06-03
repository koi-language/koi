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
const EMPTY_CATEGORIES_FILE = path.join(DB_DIR, 'empty-categories.json');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
// Text-like artefacts the agent (or user) creates in a working dir and
// wants to surface in the cajón alongside generated media. Stored
// in-place — `MediaLibrary.save()` only persists the path, never copies.
// The drawer renders these as an icon-tile with an excerpt; everything
// else (search, mention, categories, favorite) is shared with regular
// media. Keep this list focused on text-readable formats; binary docs
// (.pdf, .docx) are a separate problem and stay `unknown` for now.
const DOCUMENT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.kt', '.java',
  '.html', '.css', '.scss', '.xml', '.csv', '.tsv',
  '.sh', '.bash', '.zsh', '.toml', '.ini', '.env',
]);

function detectMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (DOCUMENT_EXTS.has(ext)) return 'document';
  return 'unknown';
}

/** For documents, the fine-grained kind (markdown / json / code / text)
 *  surfaced as `metadata.documentSubtype`. Lets the drawer pick the right
 *  icon and the agent know "is this a JSON I can `JSON.parse`, or prose
 *  I should summarise". */
function detectDocumentSubtype(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.env') return 'config';
  if (ext === '.csv' || ext === '.tsv') return 'data';
  if (ext === '.txt') return 'text';
  // Anything else in DOCUMENT_EXTS is source code.
  return DOCUMENT_EXTS.has(ext) ? 'code' : 'text';
}

function detectMimeType(filePath, mediaType = null) {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
    '.md': 'text/markdown', '.markdown': 'text/markdown',
    '.txt': 'text/plain', '.json': 'application/json',
    '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.html': 'text/html', '.css': 'text/css',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.xml': 'application/xml',
    // Source code — text/x-* keeps it readable in browsers / quick-look.
    '.js': 'text/javascript', '.ts': 'text/typescript',
    '.tsx': 'text/typescript', '.jsx': 'text/javascript',
    '.py': 'text/x-python', '.rb': 'text/x-ruby',
    '.go': 'text/x-go', '.rs': 'text/x-rust',
    '.c': 'text/x-c', '.h': 'text/x-c',
    '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
    '.swift': 'text/x-swift', '.kt': 'text/x-kotlin', '.java': 'text/x-java',
    '.scss': 'text/x-scss',
    '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript',
    '.zsh': 'text/x-shellscript',
    '.toml': 'application/toml', '.ini': 'text/plain', '.env': 'text/plain',
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
    // Migrated off @lancedb/lancedb to a SQLite-backed adapter (same one
    // semantic-index uses). Storage layout is preserved (same DB_DIR/lancedb
    // path), schema is auto-derived from the seed row in _ensureTable.
    this._dbPromise = (async () => {
      const { connect } = await import('./_sqlite-vector-adapter.js');
      fs.mkdirSync(DB_DIR, { recursive: true });
      this._db = await connect(path.join(DB_DIR, 'vector-cache'));
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
      // One-shot migration of the cloned-voice registry into the media
      // library. Runs every table open but is fully idempotent — the
      // upsert-by-path semantics on saveVoiceEntry mean a re-run is
      // equivalent to a refresh of the metadata. Timelines used to be
      // imported here too via a directory scan of `~/.koi/timelines/`;
      // that scan has been removed — the DB is the only source of truth
      // for timelines now, fed by `_mirrorToMediaLibrary` on every save.
      this._migrateLegacyArtefacts().catch((e) => {
        process.stderr.write(`[MediaLibrary] migration failed: ${e.message}\n`);
      });
      return this._table;
    })();
    this._table = await this._tablePromise;
    return this._table;
  }

  /** Pull voice registry entries into the library so the GUI drawer
   *  can rely on a single source of truth. Idempotent — upserts by
   *  file_path. Reads a single known JSON registry file, not a
   *  directory scan. Timelines are no longer migrated here: every
   *  timeline save mirrors itself into the DB via `_mirrorToMediaLibrary`,
   *  so the DB is the authoritative index and we never re-scan the
   *  timelines directory. */
  async _migrateLegacyArtefacts() {
    let voices = 0;
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
    if (voices > 0) {
      process.stderr.write(`[MediaLibrary] migration: indexed ${voices} voice(s)\n`);
    }

    // Storyboards: disk-only until now. Scan ~/.koi/storyboards/*.json
    // and index each one so existing storyboards become first-class
    // gallery rows (chronological in the drawer, searchable, deletable).
    // Idempotent — `saveStoryboardEntry` upserts by path, so re-running
    // on every startup just refreshes. New storyboards created after this
    // are mirrored live via the `storyboardSaved` WS message.
    let storyboards = 0;
    const sbDir = path.join(os.homedir(), '.koi', 'storyboards');
    if (fs.existsSync(sbDir)) {
      try {
        const { saveStoryboardEntry } = await import('./media-library.js');
        for (const f of fs.readdirSync(sbDir)) {
          if (!f.endsWith('.json')) continue;
          const fp = path.join(sbDir, f);
          try {
            const body = JSON.parse(fs.readFileSync(fp, 'utf8'));
            await saveStoryboardEntry(fp, body, null);
            storyboards++;
          } catch (e) {
            process.stderr.write(`[MediaLibrary] migrate storyboard ${f} skipped: ${e.message}\n`);
          }
        }
      } catch (e) {
        process.stderr.write(`[MediaLibrary] migrate storyboards skipped: ${e.message}\n`);
      }
    }
    if (storyboards > 0) {
      process.stderr.write(`[MediaLibrary] migration: indexed ${storyboards} storyboard(s)\n`);
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
    visible,
    createdAt,
    /// Optional one-liner the agent passes via the creation tool's
    /// `summary` field (image / video / audio / timeline / storyboard
    /// / voice). Appended to the per-session creations ledger so the
    /// agent can recall what it produced this session — preventing
    /// the "find . -name ..." regression where the agent searched the
    /// filesystem and mixed in stale files from other sessions. When
    /// the agent didn't supply one, the auto-record below falls back
    /// to description → metadata.prompt → filename.
    summary,
  }) {
    const table = await this._ensureTable();
    const buffer = fs.readFileSync(filePath);
    const hash = contentHash(buffer);
    const escPath = String(filePath).replace(/'/g, "''");

    // `visible` defaults to true for any user-visible creation. The
    // composite-snapshot the GUI bakes on every annotation submit
    // (filename `braxil-annotation-*.png`) gets auto-hidden — it's a
    // generative-input artefact that the agent references via
    // `usedForGeneration` metadata, but it shouldn't appear in the
    // creations drawer / cajón. The user explicitly asked for this
    // ("los screenshots de anotaciones … no deberían verse en
    // creaciones ni en el cajón").
    if (visible === undefined) {
      const base = path.basename(filePath);
      if (base.startsWith('braxil-annotation-')) {
        visible = false;
      } else {
        visible = true;
      }
    }
    if (visible === false) {
      metadata = { ...metadata, visible: false };
    }

    // Replace-by-path: the caller declares filePath is the authoritative
    // identity (timelines, voices). Drop any existing row at that path
    // BEFORE the dedup checks so the new content (and its updated
    // metadata / embedding / categories) wins.
    //
    // Side effect tracked here so the creations-ledger hook below only
    // fires the FIRST time we save a given path. Without this, every
    // timeline/storyboard mutation (which delete+reinsert under the
    // same path) would append a fresh ledger entry — the user would
    // see the same timeline listed N times, one per edit.
    let wasReplacement = false;
    if (replaceByPath) {
      try {
        const existing = await table.query()
          .where(`file_path = '${escPath}'`).limit(1).toArray();
        wasReplacement = existing.length > 0;
      } catch { /* table empty — treat as fresh */ }
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
      // Any caller-supplied tag promotes a previously-empty category into a
      // real one — drop those entries from the empty registry so listCategories
      // doesn't surface them as empty alongside their now-populated row.
      for (const c of norm) this.unregisterEmptyCategory(c);
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
    // When dedup hits, we still want to merge any caller-supplied
    // categories into the existing row — otherwise "drop a file from
    // Finder into a new collection" silently no-ops on second drop of
    // the same file (or any file already known to the gallery).
    const mergeCategoriesInto = async (existingId) => {
      if (!Array.isArray(categories) || categories.length === 0) return;
      try {
        const cur = await this._readCategories(existingId);
        const merged = _normaliseCategories([...cur, ...categories]);
        if (merged.length !== cur.length) {
          await this._writeCategories(existingId, merged);
        }
      } catch { /* best effort — dedup wins, tag is opportunistic */ }
    };
    if (!replaceByPath) {
      try {
        const byHash = await table.query().where(`content_hash = '${escHash}'`).limit(1).toArray();
        if (byHash.length > 0) {
          await mergeCategoriesInto(byHash[0].id);
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
          await mergeCategoriesInto(byPath[0].id);
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
      // Honour an explicit createdAt (the backfill passes the
      // storyboard's real authored date so historical items don't all
      // cluster at "now"); default to now for fresh saves.
      created_at: (typeof createdAt === 'string' && createdAt)
        ? createdAt
        : new Date().toISOString(),
      favorite: favorite ? 1 : 0,
      description: description || '',
      metadata_json: JSON.stringify(metadata),
      sam2_masks_json: '',
      embedding: embedding || new Array(EMBEDDING_DIM).fill(0),
    };

    await table.add([row]);

    // Per-session creations ledger. Single point: every NEW MediaLibrary
    // row appends one line to `.koi/sessions/<id>/creations.jsonl` so
    // the agent's `recall_creations` tool can list what THIS session
    // produced, ordered chronologically. Skipped for replace-by-path
    // UPDATES (same timeline edited many times → one ledger entry,
    // not N). No-op outside an active session (boot, batch jobs).
    // Summary resolution prefers the caller-supplied `summary` because
    // it's the only one the agent explicitly wrote as "what was this
    // for"; everything else is best-effort fallback. Fire-and-forget —
    // a ledger I/O hiccup must not fail the save itself.
    if (!wasReplacement) {
      try {
        const { recordCreation } = await import('./creations-ledger.js');
        const prompt = (metadata && typeof metadata.prompt === 'string')
          ? metadata.prompt : '';
        const fallback = description || prompt || row.filename || '';
        const resolvedSummary = (typeof summary === 'string' && summary.trim())
          ? summary.trim()
          : (fallback.length > 200 ? fallback.slice(0, 197) + '…' : fallback);
        // Tie the creation to its storyboard/project so a multi-video session
        // can scope a recall to one project (prevents a Part-2 generation from
        // grabbing another video's sheet). Prefer the explicit source link;
        // for a storyboard row itself, fall back to its own id.
        const _sbRaw = (metadata && (metadata.sourceStoryboard || metadata.storyboardId || metadata.storyboard)) || '';
        let storyboard = '';
        if (typeof _sbRaw === 'string' && _sbRaw) {
          // `sourceStoryboard` is an absolute path to the storyboard JSON;
          // its id is the basename without extension (matches the JSON's "id").
          storyboard = path.basename(_sbRaw).replace(/\.json$/i, '');
        } else if (resolvedType === 'storyboard' && metadata && typeof metadata.id === 'string') {
          storyboard = metadata.id;
        }
        recordCreation({
          id,
          kind: resolvedType,
          summary: resolvedSummary,
          filePath,
          storyboard,
        });
      } catch { /* ledger import failure must never block a save */ }
    }

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
  async list({ favorite, mediaType, mediaTypes, category, limit = 100, offset = 0, includeHidden = false } = {}) {
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

    // Drop invisibly-flagged rows unless the caller explicitly asked
    // for the full set. The drawer / cajón uses the default
    // (includeHidden=false) so hidden artefacts (annotation
    // composite-snapshots, soft-deleted images) stay out of sight
    // but remain in the database for metadata trails.
    if (!includeHidden) {
      rows = rows.filter((r) => {
        try {
          const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
          return meta.visible !== false;
        } catch { return true; }
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
   * Server-side paginated list. Unlike `list()` (which pulls a capped
   * window into memory, then filters/dedups/sorts/slices in JS — so the
   * "page" is computed over an arbitrary truncated subset and old or
   * category-tagged items below the cap silently vanish), this pushes
   * EVERYTHING into one SQL query: visibility filter, media-type filter,
   * category filter, dedup-by-content_hash (newest wins), newest-first
   * sort, and LIMIT/OFFSET. The page is therefore correct no matter how
   * deep the offset or how far down the matching items live.
   *
   * @param {object}   [opts]
   * @param {string[]} [opts.mediaTypes]   restrict to these media_type values
   * @param {string}   [opts.category]     only items tagged with this category
   * @param {number}   [opts.limit=200]    page size
   * @param {number}   [opts.offset=0]     rows to skip (pagination cursor)
   * @param {boolean}  [opts.includeHidden=false]
   * @returns {Promise<{ items: object[], total: number, hasMore: boolean }>}
   */
  async listPage({ mediaTypes, category, limit = 200, offset = 0, includeHidden = false } = {}) {
    const table = await this._ensureTable();
    const tid = table.tableId;

    // Build the shared WHERE conditions + bound params. Everything that
    // can be expressed in SQL goes here so the dedup window + LIMIT see
    // the fully-filtered set.
    const conds = [];
    const params = [];

    if (Array.isArray(mediaTypes) && mediaTypes.length > 0) {
      const valid = mediaTypes.filter((t) => typeof t === 'string' && t);
      if (valid.length > 0) {
        conds.push(`media_type IN (${valid.map(() => '?').join(', ')})`);
        params.push(...valid);
      }
    }

    // Visibility: `meta.visible !== false`. json_extract returns 0 for a
    // JSON false, 1 for true, NULL when absent. `IS NOT 0` is the
    // null-safe "anything except an explicit false" — matches the JS
    // `meta.visible !== false` semantics including the no-metadata case.
    if (!includeHidden) {
      conds.push(`json_extract(metadata_json, '$.visible') IS NOT 0`);
    }

    // Category membership: categories live as a JSON array under
    // metadata_json.$.categories. json_each unrolls it; case-insensitive
    // compare matches `_normaliseCategories` (which lowercases).
    if (category && typeof category === 'string') {
      conds.push(
        `EXISTS (SELECT 1 FROM json_each(metadata_json, '$.categories') WHERE lower(json_each.value) = lower(?))`,
      );
      params.push(category);
    }

    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    // Dedup key: content_hash when present, else the row id (so empty-hash
    // rows each stand alone). ROW_NUMBER picks the newest per key.
    const hashKey = `(CASE WHEN content_hash IS NULL OR content_hash = '' THEN id ELSE content_hash END)`;

    const lim = Math.max(0, Math.floor(limit));
    const off = Math.max(0, Math.floor(offset));

    const pageSql =
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY ${hashKey} ORDER BY created_at DESC
         ) AS _rn
         FROM ${tid}
         ${whereSql}
       ) WHERE _rn = 1
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`;

    const rows = await table.rawAll(pageSql, [...params, lim, off]);

    // Total deduped count for the same filter, so the GUI knows whether a
    // next page exists. COUNT over the deduped groups.
    const countSql =
      `SELECT COUNT(*) AS cnt FROM (
         SELECT ${hashKey} AS hk FROM ${tid} ${whereSql} GROUP BY hk
       )`;
    let total = 0;
    try {
      const r = await table.rawScalar(countSql, params);
      total = (r && typeof r.cnt === 'number') ? r.cnt : 0;
    } catch { /* count is best-effort; hasMore falls back to page-full heuristic */ }

    const items = rows.map((r) => this._deserialize(r));
    const hasMore = total > 0 ? off + items.length < total : items.length === lim;
    return { items, total, hasMore };
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

  /** Replace a row's description text. Used by the vision-describe
   *  auto-pipeline (saveGeneratedImage fires it after save) so the
   *  rich AI-authored caption replaces the bare prompt that was
   *  stamped at save time. Caller is expected to re-embed and call
   *  [setEmbedding] separately so the search index stays in sync. */
  async setDescription(id, description) {
    const table = await this._ensureTable();
    const escId = String(id).replace(/'/g, "''");
    const escDesc = String(description ?? '').replace(/'/g, "''");
    await table.update({
      values: { description: escDesc },
      where: `id = '${escId}'`,
    });
    return true;
  }

  /** Read a single row's metadata_json blob — used by the
   *  auto-describe helper to mark `autoDescribed: true` so the next
   *  save() call doesn't re-run the vision describe on the same row. */
  async getMetadata(id) {
    const table = await this._ensureTable();
    const escId = String(id).replace(/'/g, "''");
    const rows = await table.query().where(`id = '${escId}'`).limit(1).toArray();
    if (rows.length === 0) return null;
    const raw = rows[0].metadata_json;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  /** Set the entire `metadata_json` blob on a row. Used by the auto-
   *  describe helper to flip the `autoDescribed` flag on after a
   *  successful vision call so reruns short-circuit. */
  async setMetadata(id, metadata) {
    const table = await this._ensureTable();
    const escId = String(id).replace(/'/g, "''");
    const blob = JSON.stringify(metadata || {}).replace(/'/g, "''");
    await table.update({
      values: { metadata_json: blob },
      where: `id = '${escId}'`,
    });
    return true;
  }

  /** Set the `visible` flag on a row. False hides the item from the
   *  drawer / cajón AND from `list()` results (the GUI relies on
   *  list() being the visible-only view; hard-deletion would lose the
   *  metadata trail that records what was used to create downstream
   *  outputs). True restores the item to the drawer. Persisted in
   *  `metadata.visible` so no schema migration is required. */
  async setVisible(id, visible) {
    const table = await this._ensureTable();
    try {
      const escId = String(id).replace(/'/g, "''");
      const rows = await table.query().where(`id = '${escId}'`).limit(1).toArray();
      if (rows.length === 0) return false;
      const meta = rows[0].metadata_json ? JSON.parse(rows[0].metadata_json) : {};
      if (visible) {
        delete meta.visible;
      } else {
        meta.visible = false;
      }
      await table.update({
        values: { metadata_json: JSON.stringify(meta) },
        where: `id = '${escId}'`,
      });
      return true;
    } catch (e) {
      process.stderr.write(`[MediaLibrary] setVisible(${id}, ${visible}) failed: ${e.message}\n`);
      return false;
    }
  }

  /** Remove a media item. Soft-delete by default: the row stays in
   *  the library with `visible: false` so its metadata (especially
   *  the "used to produce downstream output" trail) survives. Pass
   *  `{ hard: true }` to actually destroy the row (used internally
   *  by dedup / migration code; the GUI's delete UI uses the soft
   *  variant). The user's wording: "si borro una imagen, debería
   *  simplemente poner visible = false". */
  async remove(id, { hard = false } = {}) {
    if (!hard) return this.setVisible(id, false);
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

  /** Add a single category to a row's tag set. Idempotent. Also drops
   *  the name from the empty-categories registry — once a category has
   *  at least one item it's "real" and the row scan picks it up. */
  async addCategory(id, category) {
    if (!category || typeof category !== 'string') return false;
    const cats = await this._readCategories(id);
    const next = _normaliseCategories([...cats, category]);
    const ok = await this._writeCategories(id, next);
    if (ok) this.unregisterEmptyCategory(category);
    return ok;
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

  /** Set (or clear) the user-defined `@mention` handle on a row. Stored
   *  in `metadata_json` next to categories — same location pattern. The
   *  GUI surfaces the field at the top level of the deserialised
   *  GalleryItem, so callers don't have to peek into `metadata`.
   *  Passing an empty / null mention clears the field; trims whitespace
   *  and strips a leading `@` so the stored value is the bare handle.
   *  Mentions are lowercase-normalised for matching consistency with
   *  the GUI's `@` autocomplete (which lower-cases the prefix it
   *  filters against). */
  async setMention(id, mention) {
    const table = await this._ensureTable();
    try {
      const escId = String(id).replace(/'/g, "''");
      const rows = await table.query().where(`id = '${escId}'`).limit(1).toArray();
      if (rows.length === 0) return false;
      const meta = rows[0].metadata_json ? JSON.parse(rows[0].metadata_json) : {};
      let normalized = (mention == null ? '' : String(mention)).trim();
      if (normalized.startsWith('@')) normalized = normalized.slice(1);
      normalized = normalized.toLowerCase();
      if (normalized.length === 0) {
        delete meta.mention;
      } else {
        meta.mention = normalized;
      }
      await table.update({
        values: { metadata_json: JSON.stringify(meta) },
        where: `id = '${escId}'`,
      });
      return true;
    } catch (e) {
      process.stderr.write(`[MediaLibrary] setMention(${id}) failed: ${e.message}\n`);
      return false;
    }
  }

  /** Look up rows by `@mention` handle. Match is case-insensitive, leading
   *  `@` is stripped (mirroring the contract `setMention` writes with).
   *  Returns rows newest-first so the natural "@tom" => the LATEST `@tom`
   *  resolves to the most recent generation — same model the chat input
   *  bar's `@`-autocomplete uses, so the agent and user share intuition.
   *
   *  Empty / missing mention returns `[]` (never the full library — easy
   *  footgun if a caller forgets the falsy check). */
  async findByMention(mention) {
    if (!mention || typeof mention !== 'string') return [];
    let needle = mention.trim();
    if (needle.startsWith('@')) needle = needle.slice(1);
    needle = needle.toLowerCase();
    if (!needle) return [];

    const table = await this._ensureTable();
    let rows;
    try {
      // No SQL filter on JSON-embedded `mention` — LanceDB can't index
      // into metadata_json. Pull the catalog in one shot (low thousands)
      // and filter in JS, identical to how `list({category})` works.
      rows = await table.query().limit(10000).toArray();
    } catch {
      return [];
    }
    const matches = [];
    for (const r of rows) {
      try {
        const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
        const m = typeof meta.mention === 'string' ? meta.mention : '';
        if (m && m.toLowerCase() === needle) matches.push(r);
      } catch { /* malformed metadata — skip */ }
    }
    matches.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return matches.map(r => this._deserialize(r));
  }

  /** List every distinct `@mention` handle in the library, with the
   *  newest-tagged row per handle. Used by the runtime to seed the
   *  agent's system prompt with "Known media handles: …" so the agent
   *  knows what `@`-vocabulary it can reuse before deciding to invent
   *  a new tag. Cheap enough to run on session start (single full-table
   *  scan; same cost as `list()`). */
  async listMentions() {
    const table = await this._ensureTable();
    let rows;
    try {
      rows = await table.query().limit(10000).toArray();
    } catch {
      return [];
    }
    const byMention = new Map();
    for (const r of rows) {
      try {
        const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
        const m = typeof meta.mention === 'string' ? meta.mention.trim() : '';
        if (!m) continue;
        const existing = byMention.get(m);
        if (!existing || (r.created_at || '') > (existing.row.created_at || '')) {
          byMention.set(m, { row: r, count: (existing?.count || 0) + 1 });
        } else {
          existing.count += 1;
        }
      } catch { /* malformed metadata — skip */ }
    }
    return Array.from(byMention.entries())
      .map(([mention, { row, count }]) => ({
        mention,
        count,
        mediaType: row.media_type,
        filePath: row.file_path,
        createdAt: row.created_at,
        id: row.id,
        // Surface the row's description so callers (notably the system
        // prompt's `KNOWN MEDIA HANDLES` block) can show WHAT each handle
        // actually points at, not just its type. The bare list of names
        // is otherwise opaque ("`@tucan` — image" tells the agent nothing
        // it can act on; "`@tucan` — image: cartoon toucan on a branch,
        // bright tropical palette" lets the agent decide whether to
        // reuse it without opening the file).
        description: row.description || '',
      }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  /** Index a file that lives wherever the caller put it — no copy, no
   *  move. The cajón is agnostic of storage: every row is just a path
   *  pointer plus metadata, so this is the canonical entry point for
   *  cataloguing in-cwd artefacts (scripts, prompts, drafts) without
   *  duplicating bytes.
   *
   *  Idempotent: on content-hash hit returns the existing row (same
   *  semantics as `save()`), so re-registering a file the agent already
   *  catalogued just hands back the original id — useful for "tag, then
   *  if not tagged yet, tag" flows in `tag_media`.
   *
   *  Returns `{ id, isNew, mediaType, item }` where `item` is the
   *  deserialised row. */
  async registerInPlace(filePath, opts = {}) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('registerInPlace: filePath required');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`registerInPlace: file not found: ${filePath}`);
    }
    const resolvedPath = path.resolve(filePath);
    const detectedType = detectMediaType(resolvedPath);
    const mediaType = opts.mediaType || detectedType;

    let metadata = { ...(opts.metadata || {}) };
    if (mediaType === 'document') {
      // Document-specific fields the drawer uses for tile rendering.
      // byteSize lives in metadata (not a column) so we don't need a
      // schema migration; the drawer reads it for "12 KB · markdown"
      // captions.
      try {
        const stat = fs.statSync(resolvedPath);
        metadata.byteSize = stat.size;
      } catch { /* stat failed — drop the hint */ }
      metadata.documentSubtype = opts.documentSubtype || detectDocumentSubtype(resolvedPath);
      // Source flag distinguishes "the agent generated this" from "the
      // user dragged it in" — useful later if we want to GC orphan rows
      // pointing at deleted cwd files.
      metadata.source = metadata.source || opts.source || 'cwd';
      // Cheap text excerpt (first ~10 lines, max 1KB) so the drawer can
      // show a preview without re-reading the file each render. Skip
      // for binary-ish documents (we already filtered to readable
      // extensions, but stay defensive on size).
      if (typeof opts.summary === 'string' && opts.summary.trim()) {
        metadata.summary = opts.summary.trim().slice(0, 500);
      }
      if (!metadata.excerpt) {
        try {
          const stat = fs.statSync(resolvedPath);
          if (stat.size > 0 && stat.size < 5_000_000) {
            const buf = fs.readFileSync(resolvedPath);
            // Detect rough binary-ness: if the first 4KB has many NUL
            // bytes assume binary and skip the excerpt.
            const probe = buf.subarray(0, Math.min(4096, buf.length));
            let nulCount = 0;
            for (let i = 0; i < probe.length; i++) if (probe[i] === 0) nulCount++;
            if (nulCount * 100 < probe.length) {
              const text = buf.toString('utf8');
              const lines = text.split(/\r?\n/).slice(0, 10).join('\n');
              metadata.excerpt = lines.slice(0, 1000);
            }
          }
        } catch { /* read failed — drop the hint */ }
      }
    }
    if (opts.mention) metadata.mention = opts.mention;

    const description = opts.description || metadata.summary || metadata.excerpt || '';
    const result = await this.save({
      filePath: resolvedPath,
      mediaType,
      metadata,
      categories: opts.categories,
      description,
      favorite: !!opts.favorite,
    });
    const item = await this.get(result.id);
    return { id: result.id, isNew: result.isNew, mediaType, item };
  }

  /** Toggle the "hidden from Latest creations" flag on a row. The row
   *  stays in the library (and in any user category it carries); the
   *  drawer's Latest tab filters these out client-side so removing an
   *  item from Latest doesn't cascade-destroy its category memberships. */
  async setHiddenFromLatest(id, hidden) {
    const table = await this._ensureTable();
    try {
      const escId = String(id).replace(/'/g, "''");
      const rows = await table.query().where(`id = '${escId}'`).limit(1).toArray();
      if (rows.length === 0) return false;
      const meta = rows[0].metadata_json ? JSON.parse(rows[0].metadata_json) : {};
      if (hidden) meta.hidden_from_latest = true;
      else delete meta.hidden_from_latest;
      await table.update({
        values: { metadata_json: JSON.stringify(meta) },
        where: `id = '${escId}'`,
      });
      return true;
    } catch (e) {
      process.stderr.write(`[MediaLibrary] setHiddenFromLatest(${id}) failed: ${e.message}\n`);
      return false;
    }
  }

  // ── Empty-categories registry ──────────────────────────────────────────
  //
  // A user-created category with zero items has no natural home in the
  // row-derived listing. We persist it as a tiny JSON sidecar so the
  // chip survives restarts. The first time something gets tagged with
  // the category, we drop the entry — at that point the row scan picks
  // it up and the registry is no longer load-bearing.

  _readEmptyCategoriesFile() {
    try {
      if (!fs.existsSync(EMPTY_CATEGORIES_FILE)) return [];
      const arr = JSON.parse(fs.readFileSync(EMPTY_CATEGORIES_FILE, 'utf8'));
      return Array.isArray(arr) ? arr.filter(s => typeof s === 'string' && s.trim()) : [];
    } catch {
      return [];
    }
  }

  _writeEmptyCategoriesFile(arr) {
    try {
      fs.mkdirSync(DB_DIR, { recursive: true });
      fs.writeFileSync(EMPTY_CATEGORIES_FILE, JSON.stringify(arr, null, 2));
      return true;
    } catch (e) {
      process.stderr.write(`[MediaLibrary] empty-categories write failed: ${e.message}\n`);
      return false;
    }
  }

  /** Register a category with no items yet. Persists across restarts so
   *  the chip stays visible until the user fills or deletes it. */
  registerEmptyCategory(name) {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    const cur = this._readEmptyCategoriesFile();
    const lower = trimmed.toLowerCase();
    if (cur.some(c => c.toLowerCase() === lower)) return true;
    cur.push(trimmed);
    return this._writeEmptyCategoriesFile(cur);
  }

  /** Drop a name from the empty-categories registry. Used when the
   *  category gets its first item (becomes "real") OR when the user
   *  explicitly deletes it. Case-insensitive. */
  unregisterEmptyCategory(name) {
    if (typeof name !== 'string') return false;
    const target = name.trim().toLowerCase();
    if (!target) return false;
    const cur = this._readEmptyCategoriesFile();
    const next = cur.filter(c => c.toLowerCase() !== target);
    if (next.length === cur.length) return false;
    return this._writeEmptyCategoriesFile(next);
  }

  /** Distinct categories across the whole library, with item counts.
   *  Returns [{ name, count }] sorted alphabetically. Includes any
   *  user-created empty categories with count=0 so the drawer chip
   *  stays visible before the first drop. */
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
    // Merge in user-created empty categories. Skip ones the row scan
    // already saw — once a category has items its registry entry is
    // stale and will get cleaned up on the next addCategory call.
    for (const empty of this._readEmptyCategoriesFile()) {
      const key = empty.toLowerCase();
      if (counts.has(key)) continue;
      counts.set(key, 0);
      display.set(key, empty);
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
      // Surfaced separately so the drawer's Latest filter doesn't have
      // to reach into `metadata` either. True means the user X'd the
      // tile from Latest — the row still exists with its categories
      // intact, just hidden from the "everything" view.
      hiddenFromLatest: !!metadata.hidden_from_latest,
      // Soft-delete / hide-everywhere flag. Defaults to true so older
      // rows that pre-date this field stay visible. False hides the
      // item from the drawer (and from the default `list()` filter)
      // — the row + metadata are preserved so "what was used to make
      // X" trails survive.
      visible: metadata.visible === false ? false : true,
      // User-defined `@mention` handle (e.g. `john` for an avatar the
      // user wants to drop into prompts via @john autocomplete). Empty
      // string when unset — same convention `description` uses.
      mention: typeof metadata.mention === 'string' ? metadata.mention : '',
      // Per-creation billing trail — credits charged for this generation
      // + the upstream provider's job id (fal request_id). Surfaced as
      // top-level fields so the GUI's Info panel and any future
      // creations view can render them without peeking inside
      // `metadata`. Source of truth lives in the backend `creations`
      // table; this is the local copy stamped at save time so the GUI
      // doesn't need an extra roundtrip.
      creditsCost: typeof metadata.creditsCost === 'number'
          ? metadata.creditsCost
          : (typeof metadata.credits_cost === 'number' ? metadata.credits_cost : null),
      providerRequestId: typeof metadata.providerRequestId === 'string'
          ? metadata.providerRequestId
          : (typeof metadata.provider_request_id === 'string' ? metadata.provider_request_id : null),
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
      embedding = await llmProvider.getEmbedding(description);
    } catch {
      // Embedding failed — save without it (can be added later)
    }
  }

  const saved = await lib.save({
    filePath,
    metadata: { ...generationParams, source: 'generated' },
    description,
    embedding,
    // Forward the agent-supplied "what was this for" summary down to
    // the ledger hook. Optional — when omitted, MediaLibrary.save
    // falls back to description / prompt / filename automatically.
    summary: generationParams.summary,
  });

  // Fire-and-forget vision-describe enrichment for image rows. The
  // prompt-only embedding above is enough for "prompt-text"-style
  // searches; vision-describe adds a paragraph of what the model
  // ACTUALLY drew (composition, colours, mood…) so a query like
  // "dinosaur in a city" hits an image whose prompt was just "T-Rex
  // in NY". We don't await — the save returns immediately and the
  // search index improves asynchronously. Skipped for non-images
  // here: the alias `saveGeneratedVideo` calls this same function,
  // but autoDescribeImage detects non-image extensions and exits.
  if (llmProvider && saved?.id) {
    autoDescribeImage(saved.id, filePath, description, llmProvider)
      .catch(() => { /* best-effort; failures are logged inside */ });
  }

  return saved;
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
 * Save a generated audio file (speech / sfx / music) to the media library.
 *
 * Thin alias over [saveGeneratedImage] — `MediaLibrary.save()` resolves the
 * row's `media_type` from the file extension (`.mp3`, `.wav`, `.ogg`, `.m4a`,
 * `.flac`) via `detectMediaType()`, so the row gets `media_type: 'audio'`
 * automatically and the GUI's "creaciones" drawer picks it up.
 *
 * @param {string} filePath - Path to generated audio on disk.
 * @param {Object} generationParams - All parameters used for generation
 *   (mode, prompt/text, model, provider, voice, durationSeconds, …).
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider] - For
 *   description embedding.
 */
export async function saveGeneratedAudio(filePath, generationParams, llmProvider) {
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
export async function saveTimelineEntry(filePath, timeline, llmProvider, opts = {}) {
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
    try { embedding = await llmProvider.getEmbedding(description); } catch { /* tolerate */ }
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
    // Agent-supplied "what is this timeline for" — only fires the
    // ledger on the FIRST save of this filePath (subsequent edits
    // skip via the wasReplacement gate in save()). When omitted,
    // ledger falls back to `description` ("Timeline 'X' — N clips,
    // …s.") which is already a usable handle.
    summary: opts.summary,
  });
}

/**
 * Save (or upsert) a STORYBOARD entry — points at the storyboard JSON
 * at `~/.koi/storyboards/<id>.json`. Mirrors `saveTimelineEntry`: the
 * JSON file is the authoritative artefact, the DB row is the index that
 * makes the storyboard a first-class creation (shows in the drawer with
 * a real `created_at`, interleaved chronologically; searchable; deletable
 * through the gallery). `replaceByPath` keeps one row per file across
 * edits.
 *
 * @param {string} filePath - Absolute path to the storyboard JSON.
 * @param {Object} storyboard - Parsed storyboard JSON (v6 schema).
 * @param {import('../llm/llm-provider.js').LLMProvider} [llmProvider]
 */
export async function saveStoryboardEntry(filePath, storyboard, llmProvider, opts = {}) {
  const lib = MediaLibrary.global();
  const name = storyboard?.name || path.basename(filePath, '.json');
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
  const sceneCount = scenes.length;
  let shotCount = 0;
  for (const sc of scenes) {
    if (Array.isArray(sc?.shots)) shotCount += sc.shots.length;
  }
  const aspect = storyboard?.aspect || '16:9';
  const description =
    `Storyboard "${name}" — ${sceneCount} scene${sceneCount === 1 ? '' : 's'}, ` +
    `${shotCount} shot${shotCount === 1 ? '' : 's'}, ${aspect}.`;
  let embedding = null;
  if (llmProvider) {
    try { embedding = await llmProvider.getEmbedding(description); } catch { /* tolerate */ }
  }
  const metadata = {
    source: 'storyboard',
    storyboardId: storyboard?.id,
    name,
    sceneCount,
    shotCount,
    aspect,
    updatedAt: storyboard?.updatedAt || null,
  };
  // Preserve the storyboard's REAL authored date so backfilled rows land
  // at their true position in "Latest" instead of clustering at "now".
  // Prefer the JSON's createdAt, then updatedAt, then the file mtime.
  let createdAt = (typeof storyboard?.createdAt === 'string' && storyboard.createdAt)
    ? storyboard.createdAt
    : (typeof storyboard?.updatedAt === 'string' && storyboard.updatedAt)
        ? storyboard.updatedAt
        : null;
  if (!createdAt) {
    try { createdAt = fs.statSync(filePath).mtime.toISOString(); } catch { /* fall back to now */ }
  }
  return lib.save({
    filePath,
    mediaType: 'storyboard',
    metadata,
    description,
    embedding,
    replaceByPath: true,
    createdAt,
    summary: opts.summary,
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
export async function saveVoiceEntry(filePath, voice, llmProvider, opts = {}) {
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
    try { embedding = await llmProvider.getEmbedding(description); } catch { /* tolerate */ }
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
    summary: opts.summary,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Vision-describe auto-pipeline
// ─────────────────────────────────────────────────────────────────────
//
// When an image row lands in the library, the search index it produces
// is only as rich as the prompt the user wrote. A prompt like
// "T-Rex in NY" embeds well for "T-Rex" / "NY" hits but never for
// "dinosaur in a city" or "kaiju attack". The auto-describe pipeline
// asks a vision-capable LLM (model picked by the factory — no
// hardcoded slug, honours the user's `requiresImage: true` capability
// filter) to caption the rendered output, then UPDATES the row's
// description + embedding so the semantic search sees both signals.
//
// The pipeline is fire-and-forget: failures here MUST NOT break the
// save flow (the user's image already exists on disk and in the
// library; a missing caption is a search-quality regression, not a
// data-loss one). Idempotent via the `autoDescribed` flag stamped
// into metadata_json after a successful run.

/** Compose the final description stored alongside an image: prompt
 *  first (preserves the user's intent + any negative prompt syntax),
 *  then the vision caption on its own line. Both signals end up in
 *  the embedding so a search hits either authored or generated
 *  vocabulary. */
function _composeAutoDescription(prompt, visionCaption) {
  const cleanPrompt = (prompt || '').trim();
  const cleanCaption = (visionCaption || '').trim();
  if (!cleanCaption) return cleanPrompt;
  if (!cleanPrompt) return cleanCaption;
  return `${cleanPrompt}\n\n${cleanCaption}`;
}

/** True iff [filePath] looks like an image we can hand to a vision
 *  model. Conservative — videos go through a frame-extraction path
 *  that doesn't exist yet, and audio/timeline have nothing visual to
 *  describe. */
function _isVisionDescribable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' ||
         ext === '.webp' || ext === '.gif';
}

export async function autoDescribeImage(rowId, filePath, prompt, llmProvider) {
  if (!rowId || !filePath || !llmProvider) return null;
  if (!_isVisionDescribable(filePath)) return null;
  if (!fs.existsSync(filePath)) return null;

  const lib = MediaLibrary.global();

  // Idempotency: skip if a previous auto-describe pass already ran on
  // this row. The save() path can land the same content_hash twice
  // (e.g. an image re-saved as a reference); without the flag we'd
  // pay the vision call again and overwrite a possibly-edited
  // description.
  let meta = {};
  try { meta = await lib.getMetadata(rowId) ?? {}; } catch { meta = {}; }
  if (meta.autoDescribed === true) return null;

  // Resolve a vision-capable model via the factory. `speed` task type
  // + low difficulty steers the router to the cheapest tier (the
  // auto-model-selector filters anything without `inputImage: true`,
  // so we never accidentally pick a text-only model). The factory
  // throws `NO_MODELS` when no vision-capable provider is configured
  // — we tolerate that and just skip the enrichment.
  let resolved;
  try {
    resolved = llmProvider._resolveModel('speed', 30, { requiresImage: true });
  } catch (err) {
    // No vision model available — keep the prompt-based description.
    return null;
  }
  const visionInstance = resolved?.instance;
  const visionProvider = resolved?.provider;
  if (!visionInstance || !visionProvider) return null;

  // Build a multimodal message. resolveAttachments() rewrites the
  // `attachments` field into the provider's expected image-block
  // shape (Anthropic `{type:'image', source:{...}}` vs OpenAI
  // `{type:'image_url', image_url:{...}}`) so we don't have to
  // branch by provider here.
  const messages = [{
    role: 'user',
    content:
      'Describe this image concisely in 1–2 sentences for semantic ' +
      'search. Focus on subject, setting, mood, and notable visual ' +
      'elements. Do not mention model names, file extensions, or the ' +
      'fact that the image was generated.',
    attachments: [{ type: 'image', path: filePath }],
  }];

  let captionText = '';
  try {
    const { resolveAttachments } = await import('../llm/message-builder.js');
    await resolveAttachments(messages, visionProvider);
    const out = await visionInstance.complete(messages, {
      temperature: 0.1,
      maxTokens: 180,
      timeoutMs: 20000,
    });
    captionText = (out?.text || '').toString().trim();
  } catch (err) {
    // Provider rejected the call (rate limit, model timeout, malformed
    // input…) — leave the prompt-only description in place.
    return null;
  }
  if (!captionText) return null;

  const combined = _composeAutoDescription(prompt, captionText);

  // Re-embed the combined description so the search index reflects
  // both the user's intent and the model's caption. If the embedding
  // call fails we still update the text — at worst the row's vector
  // stays the prompt-only one, which is what we had before this
  // pipeline ran.
  let newEmbedding = null;
  try {
    newEmbedding = await llmProvider.getEmbedding(combined);
  } catch { /* tolerate */ }

  try {
    await lib.setDescription(rowId, combined);
    if (Array.isArray(newEmbedding) && newEmbedding.length > 0) {
      await lib.setEmbedding(rowId, newEmbedding);
    }
    await lib.setMetadata(rowId, { ...meta, autoDescribed: true });
  } catch {
    // Persistence failed — surface a noop. The original prompt-based
    // row stays intact; the auto-describe pass will retry next time
    // saveGeneratedImage() lands the same content.
    return null;
  }
  return combined;
}
