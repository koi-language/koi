/**
 * Attachment Registry — Maps attachment IDs (att-N) to file paths.
 *
 * Attachments the user adds to a message are SACRED: they are part of the
 * conversation forever and must be recoverable AT ANY TIME — exactly like the
 * text of the conversation. So the source of truth for `att-N` resolution is
 * the persistent per-session dialogue log (`<sessionDir>/dialogue.jsonl`), NOT
 * a volatile in-memory map. `att-N` = the N-th DISTINCT user attachment in
 * chronological order across the whole session. Because the dialogue log is
 * append-only, that numbering is STABLE and survives engine restarts, context
 * scroll-out, and session resume.
 *
 * A small in-memory map is kept as a same-turn fast path / fallback for
 * environments without a session dir (KOI_SESSION_ID unset).
 *
 * Usage:
 *   attachmentRegistry.resolve('att-1') → '/path/to/image.png'
 *   attachmentRegistry.resolveAll(['att-1', 'att-2']) → ['/path/...', ...]
 *   attachmentRegistry.all() → [{ id, path, mimeType, fileName, ts }, ...]
 */

import fs from 'fs';
import path from 'path';

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv',
  '.js': 'text/javascript', '.ts': 'text/typescript',
  '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

function _mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function _sessionDir() {
  const sessionId = process.env.KOI_SESSION_ID;
  if (!sessionId) return null;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  return path.join(projectRoot, '.koi', 'sessions', sessionId);
}

class AttachmentRegistry {
  constructor() {
    this._map = new Map();   // id → { path, mimeType, fileName, registeredAt }
    this._counter = 0;
    // Cache of the parsed dialogue-backed list, invalidated by mtime.
    this._cache = { mtimeMs: -1, list: null };
  }

  /**
   * Canonical, persistent att-N → attachment mapping, read from the session
   * dialogue log. Returns [{ id, path, mimeType, fileName, ts }] in chronological
   * order (att-1 oldest). Deduped by resolved path so the same file attached
   * twice keeps its FIRST id. Cached on the log's mtime so repeated resolves in
   * a turn don't re-parse the whole file.
   */
  _canonical() {
    const dir = _sessionDir();
    if (!dir) return [];
    const logPath = path.join(dir, 'dialogue.jsonl');
    let stat;
    try { stat = fs.statSync(logPath); } catch { return []; }
    if (this._cache.list && this._cache.mtimeMs === stat.mtimeMs) {
      return this._cache.list;
    }
    let raw;
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return []; }

    const seen = new Set();
    const list = [];
    let n = 0;
    // Chronological (oldest first) so att-1 is the first attachment ever.
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'user_input') continue;
      const atts = Array.isArray(entry.attachments) ? entry.attachments : [];
      for (const a of atts) {
        if (!a || !a.path) continue;
        const resolved = path.resolve(a.path);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        list.push({
          id: `att-${++n}`,
          path: resolved,
          mimeType: _mimeOf(resolved),
          fileName: path.basename(resolved),
          ts: typeof entry.ts === 'number' ? entry.ts : undefined,
        });
      }
    }
    this._cache = { mtimeMs: stat.mtimeMs, list };
    return list;
  }

  /**
   * Register a file and return its attachment ID. Kept for API compatibility;
   * resolution itself is dialogue-backed (see _canonical), so a registered id
   * is only a same-turn fast path. If the file is already registered, returns
   * the existing ID.
   */
  register(filePath) {
    const resolved = path.resolve(filePath);
    for (const [id, entry] of this._map) {
      if (entry.path === resolved) return id;
    }
    const id = `att-${++this._counter}`;
    this._map.set(id, {
      path: resolved,
      mimeType: _mimeOf(resolved),
      fileName: path.basename(resolved),
      registeredAt: Date.now(),
    });
    return id;
  }

  /** Resolve an attachment ID to its file path. Null if not found. */
  resolve(id) {
    const entry = this.get(id);
    return entry?.path ?? null;
  }

  /** Get full entry (path, mimeType, fileName) for an attachment ID. */
  get(id) {
    // Persistent dialogue-backed mapping is the source of truth.
    const hit = this._canonical().find(e => e.id === id);
    if (hit) return hit;
    // Fallback: same-turn in-memory map (or no session dir).
    return this._map.get(id) ?? null;
  }

  /** Resolve multiple attachment IDs. */
  resolveAll(ids) {
    return ids.map(id => this.resolve(id)).filter(Boolean);
  }

  /** Get all entries for multiple IDs. */
  getAll(ids) {
    return ids.map(id => this.get(id)).filter(Boolean);
  }

  /** Check if an attachment is an image. */
  isImage(id) {
    return this.get(id)?.mimeType?.startsWith('image/') ?? false;
  }

  /**
   * All known attachments for this session — the persistent dialogue-backed
   * list, plus any same-turn in-memory entries whose path isn't in it yet
   * (assigned the next ids). This is what the prompt lists so the agent always
   * sees the exact att-N ids it can re-read.
   */
  all() {
    const canonical = this._canonical();
    const seen = new Set(canonical.map(e => e.path));
    const out = [...canonical];
    let n = canonical.length;
    for (const entry of this._map.values()) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      out.push({ id: `att-${++n}`, ...entry });
    }
    return out;
  }

  /** Clear the in-memory map. Does NOT affect the persistent dialogue log. */
  clear() {
    this._map.clear();
    this._counter = 0;
    this._cache = { mtimeMs: -1, list: null };
  }
}

// Singleton
const _instance = globalThis.__koiAttachmentRegistry || new AttachmentRegistry();
if (!globalThis.__koiAttachmentRegistry) globalThis.__koiAttachmentRegistry = _instance;

export const attachmentRegistry = _instance;
export default attachmentRegistry;
