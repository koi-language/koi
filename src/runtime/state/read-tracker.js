/**
 * Read-before-use tracker.
 *
 * Records every local file the agent has actually `read_file`'d this session, so
 * media tools can REFUSE to use an image they've never looked at. The rule
 * (user-mandated): you may not animate (`generate_video`) or reference
 * (`generate_image` / `generate_video`) a local image file unless you read it
 * first — blind use of a path grabbed off the working area is the reported bug
 * (the agent fired `generate_video` on a storyboard sheet it never opened and
 * hallucinated the scene).
 *
 * Scope: one koi runtime process == one session (the GUI spawns an engine per
 * session/tab), so a module-level Set is correctly session-scoped. Paths are
 * resolved to absolute form so "./x.png" and "/abs/x.png" match.
 *
 * Only LOCAL FILE PATHS are gated. `@handle` mentions, `att-N` chat
 * attachments and `http(s)://` URLs are deliberate, named references and are
 * exempt (they didn't come from the agent guessing a path off disk).
 */
import path from 'node:path';
import fs from 'node:fs';

const _read = new Set();

function _norm(p) {
  try { return fs.realpathSync(path.resolve(String(p))); }
  catch { return path.resolve(String(p)); }
}

/** Mark a file as read (called by read_file on success). */
export function markRead(filePath) {
  if (filePath && typeof filePath === 'string') _read.add(_norm(filePath));
}

/** True if this exact local file was read_file'd earlier this session. */
export function wasRead(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return _read.has(_norm(filePath));
}

/**
 * Is this reference a LOCAL FILE PATH (so the read-before-use rule applies)?
 * Exempts @handles, att-N attachment ids, and http(s) URLs.
 */
export function isGatedLocalPath(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return false;
  const s = ref.trim();
  if (s.startsWith('@')) return false;
  if (/^att-\d+/i.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false; // http(s):// data: etc.
  // Absolute / relative path, or an existing file on disk.
  return s.startsWith('/') || s.startsWith('~') || s.startsWith('./') || s.startsWith('../') || fs.existsSync(s);
}
