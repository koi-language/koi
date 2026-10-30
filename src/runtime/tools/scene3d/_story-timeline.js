/**
 * The story's own montage timeline (`role: 'storyboard'`).
 *
 * Every 3D shot of a storyboard lies on V1 of ONE timeline, in script order,
 * end to end — a LIVE window on the scene clock (`scene3d:<scene>/<shot>`:
 * Blender interprets it in the preview, nothing is pre-rendered). The link runs
 * both ways:
 *   - script / 3D → timeline: `ensureStoryTimeline` re-lays the clips
 *     (after every re-render, storyboard save or new shot);
 *   - timeline → script / 3D: `applyStoryTimelineEdits` writes a trim, slip
 *     or reorder made on the timeline back into the storyboard (durations,
 *     shot order) and the scene3d shot windows, re-stamping their source
 *     signature so the edit never reads as "previz out of date".
 *
 * Clips the user generated a real video onto keep their media; they only
 * move with the script order.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { listScenes, readScene, writeScene, storyboardPath, renderDir, renderScene, livePath, isLivePath } from './_store.js';
import { createTimeline, getTimeline, updateTimeline } from '../../state/timelines.js';
import { stampSources } from './_previz-sync.js';
import { channel } from '../../io/channel.js';

const _home = () => process.env.HOME || os.homedir();

function _readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function _writeJson(fp, obj) {
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, fp);
}

/** Id of the storyboard's montage timeline, or null. */
export function findStoryTimeline(storyboardId) {
  if (!storyboardId) return null;
  const dir = path.join(_home(), '.koi', 'timelines');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const f of files) {
    const fp = path.join(dir, f);
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    if (!raw.includes(storyboardId) || !raw.includes('"storyboard"')) continue;
    let tl = _readJson(fp);
    // Caught mid-write (a writer that truncates first): read again shortly.
    // Never "not found" — that created a second, empty montage and the
    // generated takes vanished from the story.
    for (let i = 0; !tl && i < 5; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      tl = _readJson(fp);
    }
    if (!tl) {
      if (/"role"\s*:\s*"storyboard"/.test(raw)) return f.slice(0, -5);
      continue;
    }
    if (tl?.role === 'storyboard' && tl.storyboardId === storyboardId) {
      if (!best || String(tl.createdAt || '') < String(best.createdAt || '')) best = tl;
    }
  }
  return best?.id || null;
}

/** Linked 3D shots in script order: [{ sbScene, sbShot, scene, shot }]. */
function _scriptOrder(sb) {
  const linked = new Map();
  for (const meta of listScenes()) {
    if (meta.storyboard?.id !== sb.id) continue;
    const s = readScene(meta.id);
    for (const sh of s?.shots || []) if (sh.storyboardShotId) linked.set(sh.storyboardShotId, { scene: s, shot: sh });
  }
  const out = [];
  for (const sc of sb.scenes || []) {
    for (const shot of sc.shots || []) {
      const l = linked.get(shot?.id);
      if (l) out.push({ sbScene: sc, sbShot: shot, ...l });
    }
  }
  return out;
}

// What the montage last laid on V1 (`<sceneId>/<shotId>` keys), in a sidecar:
// the GUI rewrites the timeline file from its own model and drops unknown
// fields. Lets a GUI save tell "the user deleted this clip" from "a shot
// the montage never had".
const _laidPath = (id) => path.join(_home(), '.koi', 'timelines', `.${id}.montage.json`);
function _readLaid(id) {
  return _readJson(_laidPath(id)) || { at: 0, keys: [] };
}
function _writeLaid(id, keys) {
  try { _writeJson(_laidPath(id), { at: Date.now(), keys }); } catch { /* best-effort */ }
}

const _managed = (c) => c?.track === 'V1' && c.scene3d?.sceneId && c.scene3d?.shotId;
// Still the previz (live, or a legacy pre-rendered proxy) — not a generated video.
const _isPreviz = (p, sceneId) => isLivePath(p) || (typeof p === 'string' && p.startsWith(renderDir(sceneId) + path.sep));

/**
 * Create (when missing and `create`) and re-lay the storyboard's montage.
 * @returns {{ timelineId: string|null, changed: boolean }}
 */
export function ensureStoryTimeline(storyboardId, { create = true } = {}) {
  const sb = _readJson(storyboardPath(storyboardId));
  if (!sb) return { timelineId: null, changed: false };
  const items = _scriptOrder(sb);
  let id = findStoryTimeline(storyboardId);
  if (!id) {
    if (!create || !items.length) return { timelineId: null, changed: false };
    const first = items[0].scene;
    const [w, h] = [first.resolution?.width, first.resolution?.height];
    const k = w && h ? 1920 / Math.max(w, h) : 1;
    const even = (v) => Math.round((v * k) / 2) * 2;
    id = createTimeline({
      name: sb.name || 'Storyboard',
      storyboardId,
      role: 'storyboard',
      summary: `Montage of the storyboard "${sb.name || storyboardId}": every 3D shot in script order`,
      settings: { videoTracks: 2, audioTracks: 2, ...(w && h ? { fps: first.fps, width: even(w), height: even(h) } : {}) },
    }).id;
  }
  const tl = getTimeline(id);
  if (!tl) return { timelineId: null, changed: false };
  const old = new Map((tl.clips || []).filter(_managed).map((c) => [`${c.scene3d.sceneId}/${c.scene3d.shotId}`, c]));
  const others = (tl.clips || []).filter((c) => !_managed(c));
  const placed = [];
  let at = 0;
  for (const it of items) {
    const { scene, shot, sbScene, sbShot } = it;
    // The user took this camera out of the montage: it stays out.
    if (shot.inMontage === false) continue;
    const prev = old.get(`${scene.id}/${shot.id}`);
    const link = { sceneId: scene.id, shotId: shot.id, storyboardShotId: sbShot.id, storyboardSceneId: sbScene.id,
      poster: shot.preview?.poster || null };
    let c;
    if (prev && !_isPreviz(prev.path, scene.id)) {
      // A real generated video sits here: keep its media, follow the order.
      c = { ...prev, startMs: at, scene3d: { ...prev.scene3d, ...link } };
    } else {
      c = {
        ...(prev || {}),
        track: 'V1',
        path: livePath(scene.id, shot.id),
        startMs: at,
        durationMs: shot.durationMs,
        // A window on the scene clock: trim / slip move it, live.
        sourceInMs: shot.startMs,
        sourceTotalMs: scene.durationMs,
        hasAudio: false,
        sourceWidthPx: scene.resolution?.width,
        sourceHeightPx: scene.resolution?.height,
        scene3d: link,
      };
    }
    placed.push(c);
    at += c.durationMs;
  }
  _writeLaid(id, placed.map((c) => `${c.scene3d.sceneId}/${c.scene3d.shotId}`));
  // A clip that moved takes its linked clips with it (the take's own sound
  // on an audio track), or they would play out of sync.
  for (const c of placed) {
    const prev = old.get(`${c.scene3d.sceneId}/${c.scene3d.shotId}`);
    const d = prev ? c.startMs - prev.startMs : 0;
    if (!d || !c.linkId) continue;
    for (const o of others) if (o.linkId === c.linkId) o.startMs += d;
  }
  const strip = (cs) => JSON.stringify(cs.map((c) => [c.id, c.path, c.startMs, c.durationMs, c.sourceInMs, c.sourceTotalMs, c.scene3d]));
  if (strip([...old.values()].sort((a, b) => a.startMs - b.startMs)) === strip(placed)) return { timelineId: id, changed: false };
  updateTimeline(id, { ...tl, clips: [...others, ...placed] });
  return { timelineId: id, changed: true };
}

/** Ordering key per item: its clip rank, or just after the previous one. */
function _reorder(list, rankOf) {
  let last = -1;
  const keyed = list.map((x, i) => {
    const r = rankOf(x);
    const k = r == null ? last + 0.001 : r;
    last = k;
    return { x, k, i };
  });
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  const out = keyed.map((e) => e.x);
  return out.some((x, i) => x !== list[i]) ? out : null;
}

const _lerp = (a, b, f) => (Array.isArray(a) && Array.isArray(b)
  ? a.map((x, i) => (typeof x === 'number' && typeof b[i] === 'number' ? x + (b[i] - x) * f : x))
  : typeof a === 'number' && typeof b === 'number' ? a + (b - a) * f : a);

/**
 * Keys (t = ms from the shot start) re-based on a shot window that now
 * starts [delta] ms later and lasts [dur]: the camera at the new start is
 * where it was at that moment, and what falls outside is cut at the edges.
 */
function _rebaseKeys(keys, delta, dur) {
  if (!Array.isArray(keys) || !keys.length) return keys;
  const ks = keys.filter((k) => k && typeof k === 'object')
    .map((k) => ({ ...k, t: (Number(k.t ?? k.ms) || 0) - delta }))
    .sort((a, b) => a.t - b.t);
  const at = (t) => {
    const j = ks.findIndex((k) => k.t >= t);
    if (j < 0) return { ...ks[ks.length - 1], t };
    if (j === 0) return { ...ks[0], t };
    const a = ks[j - 1], b = ks[j], f = (t - a.t) / Math.max(1, b.t - a.t);
    const out = { ...a, t };
    for (const [key, v] of Object.entries(b)) if (key !== 't' && key !== 'ms') out[key] = _lerp(a[key], v, f);
    return out;
  };
  const inside = ks.filter((k) => k.t > 0 && k.t < dur);
  const out = [at(0), ...inside, ...(ks[ks.length - 1].t > 0 ? [at(dur)] : [])];
  for (const k of out) { k.t = Math.round(k.t); delete k.ms; }
  return out.filter((k, i) => !i || k.t !== out[i - 1].t);
}

/**
 * A trim / slip on the montage windows the shot's camera instead of
 * re-staging it: hand-keyed paths and lanes are re-based, and a scripted
 * move keeps being solved over the window it was made for (`camWindow`,
 * widened when the shot grows past it), so the camera at the new start is
 * the one the shot had at that second.
 */
function _trimCamera(sh, start, dur) {
  const delta = start - sh.startMs;
  const cam = sh.camera && typeof sh.camera === 'object' ? sh.camera : null;
  if (Array.isArray(sh.keyframes) && sh.keyframes.length) sh.keyframes = _rebaseKeys(sh.keyframes, delta, dur);
  else if (Array.isArray(cam?.keyframes) && cam.keyframes.length) cam.keyframes = _rebaseKeys(cam.keyframes, delta, dur);
  for (const lane of ['lensKeys', 'focusKeys', 'focus']) {
    if (Array.isArray(cam?.[lane]) && cam[lane].length) cam[lane] = _rebaseKeys(cam[lane], delta, dur);
  }
  const w = Array.isArray(sh.camWindow) && sh.camWindow.length === 2 ? sh.camWindow : [sh.startMs, sh.durationMs];
  const ws = Math.min(w[0], start), we = Math.max(w[0] + w[1], start + dur);
  if (ws === start && we === start + dur) delete sh.camWindow;
  else sh.camWindow = [ws, we - ws];
}

/**
 * A GUI save of a montage timeline: carry its edits into the story.
 * @returns {{ storyboard: boolean, scenes: string[] }} what changed
 */
export function applyStoryTimelineEdits(tl) {
  const done = { storyboard: false, scenes: [] };
  if (tl?.role !== 'storyboard' || !tl.storyboardId) return done;
  const fp = storyboardPath(tl.storyboardId);
  const sb = _readJson(fp);
  if (!sb) return done;
  const clips = (tl.clips || []).filter(_managed).sort((a, b) => a.startMs - b.startMs);
  if (!clips.length) return done;
  // A clip the montage had laid and this save no longer carries was deleted
  // on the timeline: mark its shot out of the montage, or the next re-lay
  // brings it back. A save racing a fresh re-lay (the GUI still holding the
  // old clips) is not a deletion.
  const laid = _readLaid(tl.id);
  const removed = Date.now() - laid.at < 5000 ? [] : (() => {
    const now = new Set(clips.map((c) => `${c.scene3d.sceneId}/${c.scene3d.shotId}`));
    return laid.keys.filter((k) => !now.has(k));
  })();
  const scenes = new Map();
  const sceneOf = (sid) => {
    if (!scenes.has(sid)) scenes.set(sid, { s: readScene(sid), touched: new Set() });
    return scenes.get(sid);
  };
  const sbShots = new Map();
  for (const sc of sb.scenes || []) for (const sh of sc.shots || []) sbShots.set(sh.id, sh);
  const rank = new Map(); // storyboard shot id → clip order
  clips.forEach((c, i) => {
    const e = sceneOf(c.scene3d.sceneId);
    const sh = e.s?.shots?.find((x) => x.id === c.scene3d.shotId);
    if (!sh) return;
    if (sh.storyboardShotId) rank.set(sh.storyboardShotId, i);
    const dur = Math.max(200, Math.round(c.durationMs));
    let start = sh.startMs;
    if (isLivePath(c.path)) start = Math.round(c.sourceInMs || 0);
    start = Math.max(0, Math.min(start, Math.max(0, (e.s.durationMs || start + dur) - dur)));
    if (start !== sh.startMs || dur !== sh.durationMs) {
      _trimCamera(sh, start, dur);
      sh.startMs = start;
      sh.durationMs = dur;
      e.touched.add(sh.id);
    }
    const sbShot = sh.storyboardShotId && sbShots.get(sh.storyboardShotId);
    const secs = Math.round(dur / 100) / 10;
    if (sbShot && sbShot.duration !== secs) {
      sbShot.duration = secs;
      done.storyboard = true;
    }
  });
  // Shot order (inside each scene) and scene order follow the montage.
  for (const sc of sb.scenes || []) {
    const next = Array.isArray(sc.shots) && _reorder(sc.shots, (sh) => rank.get(sh?.id) ?? null);
    if (next) { sc.shots = next; done.storyboard = true; }
  }
  const sceneRank = (sc) => {
    const r = (sc.shots || []).map((sh) => rank.get(sh?.id)).filter((x) => x != null);
    return r.length ? Math.min(...r) : null;
  };
  const nextScenes = Array.isArray(sb.scenes) && _reorder(sb.scenes, sceneRank);
  if (nextScenes) { sb.scenes = nextScenes; done.storyboard = true; }
  if (done.storyboard) _writeJson(fp, sb);
  for (const k of removed) {
    const [sid, shotId] = k.split('/');
    const e = sceneOf(sid);
    const sh = e.s?.shots?.find((x) => x.id === shotId);
    if (sh && sh.inMontage !== false) {
      sh.inMontage = false;
      e.touched.add(sh.id);
    }
  }
  if (removed.length) _writeLaid(tl.id, laid.keys.filter((k) => !removed.includes(k)));
  for (const [sid, e] of scenes) {
    if (!e.s || !e.touched.size) continue;
    // Built from the storyboard as it is NOW (the edit came from here).
    stampSources(e.s, e.touched);
    writeScene(e.s);
    done.scenes.push(sid);
    renderScene(e.s, { shotIds: [...e.touched] })
      .catch((err) => channel.log('scene3d', `re-render after montage edit ${sid}: ${err.message}`));
  }
  return done;
}
