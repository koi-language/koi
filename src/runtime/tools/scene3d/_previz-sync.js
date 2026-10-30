/**
 * Storyboard ↔ 3D previz consistency.
 *
 * The previz is PART of the storyboard: every storyboard shot must have a
 * 3D shot built from its CURRENT content. Each scene3d shot stores the
 * `sourceSig` of the storyboard shot it was built from; when the storyboard
 * changes, shots whose signature moved are stale and must be re-blocked.
 *
 * Writers that change a storyboard (save_storyboard, update_storyboard, the
 * GUI's storyboardSaved notify) call `refreshPrevizFlags` so each linked
 * card carries `_preview3d.stale`, and tool results surface `previz3d`
 * so the agent keeps the previz in sync (enforced at the tool level, not
 * only in the skill).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { listScenes, readScene, storyboardPath, cleanId } from './_store.js';
import { locationViews } from '../../state/location-registry.js';

/** Editorial inputs of a storyboard shot that change its 3D blocking. */
export function storyboardShotSig(sb, sc, sh) {
  const payload = [
    sb?.aspect || null,
    sc?.location || null,
    sc?.locationIds || sc?.locationId || null,
    sh?.duration ?? null,
    sh?.shot ?? null,
    sh?.camera ?? sh?.movement ?? null,
    sh?.composition ?? null,
    sh?.action ?? null,
    sh?.continuity ?? null,
    sh?.noCutBefore === true,
  ];
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

const _IMG = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|avif)$/i;

function _locationImages(locId) {
  if (typeof locId !== 'string' || !locId.trim()) return [];
  const fp = path.join(process.env.HOME || os.homedir(), '.koi', 'locations', `${path.basename(locId)}.json`);
  try {
    const loc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return [...locationViews(loc).map((v) => v?.path), ...(loc.photos || [])];
  } catch {
    return [];
  }
}

/**
 * Every image that tells us what a storyboard scene's PLACE looks like:
 * the scene's and its shots' `references`, and the plates / photos of the
 * saved location(s) it points at. The 3D set must be laid out from these —
 * when one appears after the set was built, the set is out of date.
 */
export function sceneSpatialRefs(sb, sc) {
  const out = [];
  const add = (p) => {
    if (typeof p === 'string' && path.isAbsolute(p) && _IMG.test(p) && fs.existsSync(p) && !out.includes(p)) out.push(p);
  };
  for (const r of sc?.references || []) add(r);
  for (const sh of sc?.shots || []) for (const r of sh?.references || []) add(r);
  const locIds = [...(Array.isArray(sc?.locationIds) ? sc.locationIds : []), sc?.locationId];
  // A scene naming a roster set by name (no id) still gets its location card.
  for (const l of sb?.locations || []) {
    if (l?.locationId && typeof sc?.location === 'string' && l.name
        && sc.location.toLowerCase().includes(String(l.name).toLowerCase())) locIds.push(l.locationId);
  }
  for (const id of locIds) for (const p of _locationImages(id)) add(p);
  return out;
}

function _readStoryboard(id) {
  const fp = storyboardPath(id);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function _sbShotIndex(sb) {
  const out = new Map();
  for (const sc of sb?.scenes || []) {
    for (const sh of sc?.shots || []) {
      if (sh && typeof sh.id === 'string') out.set(sh.id, { sc, sh });
    }
  }
  return out;
}

/** Stamp linked shots of `scene` with the signature of their storyboard
 *  shot as it is NOW — "this 3D shot was built from that version".
 *  `onlyShotIds` limits it to the shots an edit actually re-blocked, so
 *  fixing one stale shot never silently clears the others. */
export function stampSources(scene, onlyShotIds = null) {
  const sbId = scene?.storyboard?.id;
  if (!sbId) return;
  const sb = _readStoryboard(sbId);
  if (!sb) return;
  const idx = _sbShotIndex(sb);
  for (const sh of scene.shots || []) {
    if (onlyShotIds && !onlyShotIds.has(sh.id) && sh.sourceSig) continue;
    const hit = sh.storyboardShotId && idx.get(sh.storyboardShotId);
    if (hit) sh.sourceSig = storyboardShotSig(sb, hit.sc, hit.sh);
    else delete sh.sourceSig;
  }
}

/**
 * Where the previz of a storyboard stands.
 * @returns {{ storyboardId, totalShots, upToDate, missing: object[], stale: object[], orphans: object[], scenes: object[] }}
 */
export function previzStatus(storyboardId) {
  const id = cleanId(storyboardId);
  const sb = _readStoryboard(id);
  const status = { storyboardId: id, totalShots: 0, upToDate: 0, missing: [], stale: [], orphans: [], scenes: [], layout: [] };
  if (!sb) return status;
  const idx = _sbShotIndex(sb);
  status.totalShots = idx.size;
  const linked = new Map(); // storyboard shot id → { scene3d, shot }
  for (const meta of listScenes()) {
    if (meta.storyboard?.id !== id) continue;
    const s = readScene(meta.id);
    if (!s) continue;
    status.scenes.push({ scene3dId: s.id, storyboardSceneId: s.storyboard?.sceneId || null });
    // New reference images of the place since the set was laid out → the
    // whole set must be rebuilt from them (every shot of it is stale).
    const sbScene = (sb.scenes || []).find((x) => x?.id === s.storyboard?.sceneId);
    if (sbScene) {
      const refs = sceneSpatialRefs(sb, sbScene);
      const used = new Set(Array.isArray(s.set?.layoutFrom) ? s.set.layoutFrom : []);
      const fresh = refs.filter((r) => !used.has(r));
      if (fresh.length) {
        status.layout.push({ scene3dId: s.id, storyboardSceneId: sbScene.id, newReferences: fresh, allReferences: refs });
        s._layoutStale = true;
      }
    }
    for (const sh of s.shots || []) {
      if (!sh.storyboardShotId) continue;
      if (!idx.has(sh.storyboardShotId)) {
        status.orphans.push({ scene3dId: s.id, shotId: sh.id, storyboardShotId: sh.storyboardShotId });
        continue;
      }
      linked.set(sh.storyboardShotId, { scene: s, shot: sh });
    }
  }
  for (const [shotId, { sc, sh }] of idx) {
    const l = linked.get(shotId);
    if (!l) {
      status.missing.push({ storyboardSceneId: sc.id, storyboardShotId: shotId });
      continue;
    }
    if (l.scene._layoutStale || l.shot.sourceSig !== storyboardShotSig(sb, sc, sh)) {
      status.stale.push({ storyboardSceneId: sc.id, storyboardShotId: shotId, scene3dId: l.scene.id, shotId: l.shot.id });
    } else {
      status.upToDate += 1;
    }
  }
  return status;
}

/** Write `_preview3d.stale` onto the storyboard's linked cards (diff-guarded,
 *  so a re-notify can't loop). With `markPending` (the caller is handing the
 *  agent a previz3d directive right now), shots with no 3D yet get
 *  `_preview3d: { pending, pendingAt }` so the visor shows them as building.
 *  Returns the status. */
export function refreshPrevizFlags(storyboardId, { markPending = false } = {}) {
  const status = previzStatus(storyboardId);
  const fp = storyboardPath(storyboardId);
  if (!fs.existsSync(fp)) return status;
  let sb;
  try { sb = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return status; }
  const stale = new Set(status.stale.map((x) => x.storyboardShotId));
  const missing = new Set(status.missing.map((x) => x.storyboardShotId));
  let changed = false;
  for (const sc of sb.scenes || []) {
    for (const sh of sc.shots || []) {
      if (markPending && missing.has(sh?.id) && !sh._preview3d?.video && !sh._preview3d?.poster) {
        sh._preview3d = { pending: true, pendingAt: new Date().toISOString() };
        changed = true;
        continue;
      }
      const pv = sh?._preview3d;
      if (!pv || typeof pv !== 'object') continue;
      const want = stale.has(sh.id);
      if (Boolean(pv.stale) !== want) {
        if (want) pv.stale = true; else { delete pv.stale; delete pv.pending; delete pv.pendingAt; }
        changed = true;
      }
      // The agent is being told to re-block it right now → "building".
      if (want && markPending && !pv.pending) {
        pv.pending = true;
        pv.pendingAt = new Date().toISOString();
        changed = true;
      }
    }
  }
  if (changed) {
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sb, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, fp);
  }
  return status;
}

/** The `previz3d` block tool results carry when the previz is behind. */
export function previzDirective(status) {
  if (!status || !status.totalShots) return null;
  const { missing, stale, orphans, layout = [] } = status;
  if (!missing.length && !stale.length && !orphans.length && !layout.length) return null;
  const parts = [];
  for (const l of layout) {
    parts.push(`scene3d ${l.scene3dId} (storyboard scene ${l.storyboardSceneId}) has NEW reference images of the place it was not built from: ${l.newReferences.join(', ')} — READ every image and rebuild/adjust its set to match them spatially (room size and shape, walls/openings, every visible object with its real dimensions, position and orientation, recognizable silhouettes), then set set.layoutFrom to ALL of: ${l.allReferences.join(', ')}`);
  }
  if (missing.length) parts.push(`${missing.length} shot(s) without 3D previz: ${missing.map((m) => m.storyboardShotId).join(', ')}`);
  if (stale.length) parts.push(`${stale.length} 3D shot(s) out of date with the storyboard: ${stale.map((m) => m.storyboardShotId).join(', ')}`);
  if (orphans.length) parts.push(`${orphans.length} 3D shot(s) linked to storyboard shots that no longer exist: ${orphans.map((o) => `${o.scene3dId}/${o.shotId}`).join(', ')}`);
  return {
    required: true,
    ...status,
    instruction:
      'The 3D previz is PART of the storyboard and must match it. ' + parts.join('; ') + '. ' +
      'Activate the scene-3d skill and, BEFORE telling the user the storyboard is done: ' +
      (status.scenes.length
        ? 'update the existing scene3d scene(s) (get_scene3d → update_scene3d: re-block only the listed shots, add missing ones, remove orphans), '
        : 'build it — one save_scene3d per storyboard scene, one 3D shot per storyboard shot with storyboardShotId, ') +
      'then check the posters. SPEED: delegate each storyboard scene that needs work to a `previz-creator` subagent, ' +
      'ALL IN PARALLEL in one message (one Agent call per scene), instead of doing them one after another.',
  };
}

/** A saved location changed (new plate / photos): re-check every storyboard
 *  that uses it and return the previz3d directives for the agent. */
export function previzForLocation(locationId) {
  if (typeof locationId !== 'string' || !locationId) return [];
  const dir = path.join(process.env.HOME || os.homedir(), '.koi', 'storyboards');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (!raw.includes(locationId)) continue;
    const d = previzDirective(refreshPrevizFlags(f.replace(/\.json$/, '')));
    if (d) out.push(d);
  }
  return out;
}
