/**
 * Paths inside a project's DOCUMENTS are stored RELATIVE to the project
 * (`images/a.png`, `scenes3d/s3d-x/sh1.jpg`), never absolute: a project that
 * is moved, copied or synced (iCloud Drive, another Mac) keeps every link.
 *
 * In memory every path stays ABSOLUTE (tools, ffmpeg, Blender, the GUI all
 * need real paths): documents go through `fromStoredPaths` when read and
 * `toStoredPaths` when written — `readDocJson` / `writeDocJson` do both.
 *
 * Mirror of the GUI's `ProjectDocs.toStored / fromStored` (same rules).
 */

import fs from 'fs';
import path from 'path';
import { DOC_KINDS, documentsRoot, PROJECT_EXT } from './doc-root.js';

/** A stored relative path: starts with a document kind's folder. */
const REL_RE = new RegExp(`^(?:${DOC_KINDS.map((k) => k.replace(/[-]/g, '\\-')).join('|')})/[^\\n]+$`);
/** An absolute path into SOME `.braxil` package: [1] the package, [2] inside it. */
const PKG_RE = /^(\/[^\n]*?\.braxil)\/([^\n]+)$/i;

/** The documents root a doc file belongs to: its own `.braxil` package when
 *  it lives in one, else this session's documents root. */
export function rootForFile(file) {
  if (typeof file === 'string') {
    let d = path.dirname(path.resolve(file));
    for (;;) {
      if (d.toLowerCase().endsWith(PROJECT_EXT)) return d;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return documentsRoot();
}

function _mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => _mapStrings(v, fn));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = _mapStrings(v, fn); // keys can be paths too
    return out;
  }
  return value;
}

/** One string → its stored form (relative when it points inside [root], or
 *  inside an older place of the same package that now lives at [root]). */
export function toStoredPath(s, root = documentsRoot()) {
  if (typeof s !== 'string' || !s.startsWith('/')) return s;
  const r = root.replace(/\/+$/, '');
  if (s.startsWith(`${r}/`)) {
    const rel = s.slice(r.length + 1);
    return REL_RE.test(rel) ? rel : s;
  }
  // A moved / copied package: the old absolute place is gone, the same file
  // is here.
  // A package of the same name is this project in its old place, even when
  // the file itself is gone.
  const m = PKG_RE.exec(s);
  if (m && REL_RE.test(m[2])
      && (path.basename(m[1]).normalize('NFC') === path.basename(r).normalize('NFC')
        || (!fs.existsSync(s) && fs.existsSync(path.join(r, m[2]))))) return m[2];
  return s;
}

/** One stored string → absolute (a relative document path → under [root]). */
export function fromStoredPath(s, root = documentsRoot()) {
  if (typeof s !== 'string' || !REL_RE.test(s)) return s;
  return path.join(root, s);
}

export function toStoredPaths(value, root = documentsRoot()) {
  return _mapStrings(value, (s) => toStoredPath(s, root));
}

export function fromStoredPaths(value, root = documentsRoot()) {
  return _mapStrings(value, (s) => fromStoredPath(s, root));
}

/** Parse a document's JSON text with its paths made absolute. */
export function parseDocJson(text, file) {
  return fromStoredPaths(JSON.parse(text), rootForFile(file));
}

/** Serialize a document with its paths made relative (default 2-space indent). */
export function stringifyDocJson(obj, file, indent = 2) {
  return JSON.stringify(toStoredPaths(obj, rootForFile(file)), null, indent);
}

export function readDocJson(file) {
  return parseDocJson(fs.readFileSync(file, 'utf8'), file);
}

export async function readDocJsonAsync(file) {
  return parseDocJson(await fs.promises.readFile(file, 'utf8'), file);
}

export function writeDocJson(file, obj, indent = 2) {
  fs.writeFileSync(file, stringifyDocJson(obj, file, indent));
}

export async function writeDocJsonAsync(file, obj, indent = 2) {
  await fs.promises.writeFile(file, stringifyDocJson(obj, file, indent));
}
