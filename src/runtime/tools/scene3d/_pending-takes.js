/**
 * Takes waiting for their real video: prepare_scene3d_video records which
 * clips each baked 3D reference belongs to, and generate_video — when a
 * generation that used that reference lands — puts the take on those clips
 * (assign_scene3d_take). The agent used to stop after reviewing the take and
 * never assign it: the timeline kept showing the previous version.
 *
 * Kept on disk (the engine may restart between the two calls).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { docDir } from '../../state/doc-root.js';
import { readDocJson, stringifyDocJson } from '../../state/project-paths.js';
const _file = () => path.join(docDir('scenes3d'), '.pending-takes.json');
const _TTL_MS = 7 * 24 * 3600 * 1000;

function _read() {
  try { return readDocJson(_file()) || {}; } catch { return {}; }
}

function _write(all) {
  const fp = _file();
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, stringifyDocJson(all, fp, 0), 'utf8');
    fs.renameSync(tmp, fp);
  } catch { /* best-effort */ }
}

/** Remember that [referenceVideo] is the 3D of [clipIds] on [timelineId]. */
export function notePendingTake(referenceVideo, timelineId, clipIds) {
  const all = _read();
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (!v?.at || now - v.at > _TTL_MS) delete all[k];
  all[path.resolve(referenceVideo)] = { timelineId, clipIds, at: now };
  _write(all);
}

/** The clips a reference video was baked for, or null. Kept after use: a
 *  second generation from the same reference replaces the first on the clips. */
export function pendingTakeFor(referenceVideos) {
  const all = _read();
  for (const r of referenceVideos || []) {
    if (typeof r !== 'string') continue;
    const hit = all[path.resolve(r)];
    if (hit?.timelineId && Array.isArray(hit.clipIds) && hit.clipIds.length) return hit;
  }
  return null;
}
