/**
 * Centralised media-output export.
 *
 * The contract every media tool shares: the ORIGINAL artefact always lives in
 * its canonical per-kind home under `~/.koi/<images|videos|audio>` — that's the
 * path registered in the media library, so the creations drawer ("cajón")
 * always finds it, and the path timelines / lineage reference (stable storage,
 * never an ephemeral workspace). When the caller passed `saveTo` / `saveAs`, we
 * additionally write a COPY there. The user's path is therefore a copy; the
 * original is never moved out of the repo.
 *
 * This module is the single home for that logic so no tool re-implements the
 * "is saveTo a directory or a file path?" resolution or the copy + workspace
 * guard. See `exportMediaCopy`.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../../io/channel.js';

import { docDir } from '../../../state/doc-root.js';
// Extensions that mean `saveTo` names a FILE rather than a directory. Kept as
// an explicit allow-list (not "any dotted last segment") so a directory called
// e.g. `my.assets` or `v1.2` isn't mistaken for a file.
const MEDIA_FILE_EXT_RE =
  /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|mp4|mov|webm|mkv|m4v|mp3|wav|aac|flac|opus|ogg|m4a)$/i;

/** Canonical per-kind home in the project where ORIGINALS always live so the
 *  media library / creations drawer can always find them. `kind` is one of
 *  `images` / `videos` / `audio`. */
export function defaultMediaDir(kind) {
  return docDir(kind);
}

/** True when `p` sits inside an ephemeral workflow workspace
 *  (`<root>/.koi/workflows/<run_id>/…`). Anything written there is garbage-
 *  collected at run-end, so copying a user export into it is pointless — the
 *  canonical original already survives. The leading dot keeps us from matching
 *  a user folder literally named `workflows`. */
function _inWorkflowWorkspace(p) {
  if (typeof p !== 'string' || !p) return false;
  const segs = path.resolve(p).split(path.sep);
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === '.koi' && segs[i + 1] === 'workflows') return true;
  }
  return false;
}

/**
 * Resolve where a user-requested `saveTo` export should land for output
 * `index`, given the canonical original at `canonicalPath`. `saveTo` may be a
 * DIRECTORY (the canonical basename is reused inside it) or a full FILE path
 * (used verbatim for index 0; extra outputs get a `-<index>` suffix beside it).
 * Relative paths resolve against cwd. Returns an absolute path, or null when
 * `saveTo` is empty.
 */
export function resolveExportPath(saveTo, canonicalPath, index = 0) {
  const raw = typeof saveTo === 'string' && saveTo.trim() ? saveTo.trim() : null;
  if (!raw) return null;
  const abs = path.resolve(raw);
  const namesFile = MEDIA_FILE_EXT_RE.test(path.basename(abs));
  if (!namesFile) return path.join(abs, path.basename(canonicalPath));
  if (index === 0) return abs;
  const ext = path.extname(abs);
  return path.join(path.dirname(abs), `${path.basename(abs, ext)}-${index}${ext}`);
}

/**
 * Export a COPY of the canonical original to the caller's `saveTo` while the
 * original stays put in its `~/.koi` repo dir. Best-effort: a copy failure is
 * logged and returns null — it never destroys or replaces the original.
 *
 * @param {string} canonicalPath  Absolute path to the original (already written
 *                                under `~/.koi/<kind>`).
 * @param {string} saveTo         Caller-supplied directory OR file path.
 * @param {object} [opts]
 * @param {number} [opts.index=0] Output index (drives the `-N` suffix when
 *                                `saveTo` names a single file but N outputs
 *                                exist).
 * @param {string} [opts.logTag='media'] Channel log tag.
 * @returns {string|null} Absolute copy path, or null when no `saveTo` was given,
 *                        the copy failed, or the destination equals the original
 *                        / sits in an ephemeral workflow workspace.
 */
export function exportMediaCopy(canonicalPath, saveTo, { index = 0, logTag = 'media' } = {}) {
  if (!canonicalPath || !fs.existsSync(canonicalPath)) return null;
  const dest = resolveExportPath(saveTo, canonicalPath, index);
  if (!dest) return null;
  if (path.resolve(dest) === path.resolve(canonicalPath)) return null;
  if (_inWorkflowWorkspace(dest)) {
    channel.log(
      logTag,
      `saveTo "${dest}" is inside an ephemeral workflow workspace; skipping the ` +
      `export copy — the original survives at ${canonicalPath}.`,
    );
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(canonicalPath, dest);
    channel.log(logTag, `Exported copy → ${dest} (original kept at ${canonicalPath})`);
    return dest;
  } catch (err) {
    channel.log(logTag, `Export copy to ${dest} failed (original kept at ${canonicalPath}): ${err.message}`);
    return null;
  }
}
