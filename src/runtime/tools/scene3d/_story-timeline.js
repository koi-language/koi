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
 * move with the script order. Clips the user LOCKED do not change at all: the
 * rest of the montage is laid around them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { listScenes, readScene, writeScene, storyboardPath, renderDir, renderScene, livePath, isLivePath, sceneDurationMs, relayShots } from './_store.js';
import { createTimeline, getTimeline, lockedClips, updateTimeline } from '../../state/timelines.js';
import { stampSources } from './_previz-sync.js';
import { channel } from '../../io/channel.js';

import { docDir } from '../../state/doc-root.js';
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
  const dir = path.join(docDir('timelines'));
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
const _laidPath = (id) => path.join(docDir('timelines'), `.${id}.montage.json`);
function _readLaid(id) {
  return _readJson(_laidPath(id)) || { at: 0, keys: [] };
}
function _writeLaid(id, keys) {
  try { _writeJson(_laidPath(id), { at: Date.now(), keys }); } catch { /* best-effort */ }
}

const _managed = (c) => c?.track === 'V1' && c.scene3d?.sceneId && c.scene3d?.shotId;
/** Every 3D shot a montage clip plays: a continuous take covers several. */
export const clipShotIds = (c) => (Array.isArray(c?.scene3d?.shots) && c.scene3d.shots.length
  ? c.scene3d.shots.map((x) => x?.id).filter(Boolean)
  : [c?.scene3d?.shotId].filter(Boolean));
const _keys = (c) => clipShotIds(c).map((sh) => `${c.scene3d.sceneId}/${sh}`);
// Still the previz (live, or a legacy pre-rendered proxy) — not a generated video.
const _isPreviz = (p, sceneId) => isLivePath(p) || (typeof p === 'string' && p.startsWith(renderDir(sceneId) + path.sep));

/**
 * Create (when missing and `create`) and re-lay the storyboard's montage.
 * @returns {{ timelineId: string|null, changed: boolean }}
 */
export function ensureStoryTimeline(storyboardId, { create = true } = {}) {
  const sb = _readJson(storyboardPath(storyboardId));
  if (!sb) return { timelineId: null, changed: false };
  // The story's order may have changed: cameras follow it along the action.
  for (const meta of listScenes()) {
    if (meta.storyboard?.id !== sb.id) continue;
    const scene = readScene(meta.id);
    if (scene && relayShots(scene).length) writeScene(scene);
  }
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
  const old = new Map();
  for (const c of (tl.clips || []).filter(_managed)) for (const k of _keys(c)) if (!old.has(k)) old.set(k, c);
  const others = (tl.clips || []).filter((c) => !_managed(c));
  const frozen = [...new Set(old.values())].filter((c) => c.locked === true);
  // The next start at or after [from] where [dur] ms fit between locked clips.
  const freeStart = (from, dur) => {
    let start = from;
    for (const c of [...frozen].sort((a, b) => a.startMs - b.startMs)) {
      if (start < c.startMs + c.durationMs && c.startMs < start + dur) start = c.startMs + c.durationMs;
    }
    return start;
  };
  const placed = [...frozen];
  let at = 0;
  for (const it of items) {
    const { scene, shot, sbScene, sbShot } = it;
    // The user took this camera out of the montage: it stays out.
    if (shot.inMontage === false) continue;
    let prev = old.get(`${scene.id}/${shot.id}`);
    if (prev?.locked === true) continue;
    // A continuous take (the script's noCutBefore): the shot joins the clip
    // before it, one clip for the whole take, while both still show the
    // previz and their windows meet on the scene clock.
    const last = placed.filter((c) => c.locked !== true).at(-1);
    const lastShots = last?.scene3d?.shots;
    const lastEnd = lastShots ? lastShots[lastShots.length - 1] : null;
    if (sbShot.noCutBefore === true && last && last.scene3d.sceneId === scene.id && isLivePath(last.path)
        && (!prev || prev === last || _isPreviz(prev.path, scene.id))
        && lastEnd && lastEnd.startMs + lastEnd.durationMs === shot.startMs) {
      if (freeStart(last.startMs, last.durationMs + shot.durationMs) === last.startMs) {
        lastShots.push({ id: shot.id, storyboardShotId: sbShot.id, startMs: shot.startMs, durationMs: shot.durationMs });
        last.durationMs += shot.durationMs;
        at += shot.durationMs;
        continue;
      }
    }
    if (prev && placed.some((x) => x.id === prev.id)) {
      // Already laid: a generated take that spans this shot too keeps it;
      // a previz clip that no longer does lends this shot a fresh clip.
      if (!_isPreviz(prev.path, scene.id)) continue;
      prev = null;
    }
    // The script's shot number, shown on the clip and on its camera: what
    // the user says in the chat ("cambia el plano 6").
    const link = { sceneId: scene.id, shotId: shot.id, storyboardShotId: sbShot.id, storyboardSceneId: sbScene.id,
      poster: shot.preview?.poster || null, ...(Number.isFinite(sbShot.number) ? { number: sbShot.number } : {}) };
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
        scene3d: { ...link, shots: [{ id: shot.id, storyboardShotId: sbShot.id, startMs: shot.startMs, durationMs: shot.durationMs }] },
      };
    }
    c.startMs = freeStart(at, c.durationMs);
    placed.push(c);
    at = c.startMs + c.durationMs;
  }
  placed.sort((a, b) => a.startMs - b.startMs);
  // One shot per clip needs no list (the clip's own window says it all).
  for (const c of placed) if (c.locked !== true && c.scene3d.shots?.length === 1) { const { shots: _, ...rest } = c.scene3d; c.scene3d = rest; }
  _writeLaid(id, placed.flatMap(_keys));
  // A clip that moved takes its linked clips with it (the take's own sound
  // on an audio track), or they would play out of sync.
  for (const c of placed) {
    const prev = old.get(`${c.scene3d.sceneId}/${c.scene3d.shotId}`);
    const d = prev ? c.startMs - prev.startMs : 0;
    if (!d || !c.linkId) continue;
    for (const o of others) if (o.linkId === c.linkId) o.startMs += d;
  }
  _durationsFromMontage(storyboardId, sb, items);
  const strip = (cs) => JSON.stringify(cs.map((c) => [c.id, c.path, c.startMs, c.durationMs, c.sourceInMs, c.sourceTotalMs, c.scene3d]));
  if (strip([...new Set(old.values())].sort((a, b) => a.startMs - b.startMs)) === strip(placed)) return { timelineId: id, changed: false };
  updateTimeline(id, { ...tl, clips: [...others, ...placed] });
  return { timelineId: id, changed: true };
}

const _stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
  : x));

/** What a 3D shot plays, without what renders and sync checks stamp on it. */
const _shotContent = ({ preview: _p, sourceSig: _s, ...rest }) => _stable(rest);

// Scene fields every shot shares: changing them changes what a live clip shows.
const _WORLD_FIELDS = ['aspect', 'style', 'set', 'lighting', 'characters', 'actions', 'resolution', 'fps'];

function _lockedOfScene(sceneId) {
  return lockedClips().filter(({ clip }) => clip.scene3d?.sceneId === sceneId).map(({ clip }) => clip);
}

/** Ids of the shots of [sceneId] that a locked clip plays. */
export function lockedShotIds(sceneId) {
  return new Set(_lockedOfScene(sceneId).flatMap(clipShotIds));
}

/**
 * The 3D behind locked clips stays as it is: their shots always, and the shared
 * world too while one of them still plays the live previz (a generated video no
 * longer depends on it).
 * @returns {string|null} why [next] may not be saved over [existing]
 */
export function lockedSceneViolation(existing, next) {
  if (!existing) return null;
  const locked = _lockedOfScene(existing.id);
  if (!locked.length) return null;
  const after = new Map((next.shots || []).map((s) => [s.id, s]));
  const changed = (existing.shots || [])
    .filter((s) => locked.some((c) => clipShotIds(c).includes(s.id)))
    .filter((s) => !after.has(s.id) || _shotContent(after.get(s.id)) !== _shotContent(s))
    .map((s) => s.id);
  if (changed.length) {
    return `shots ${changed.join(', ')} belong to clips the user locked on the timeline and cannot be changed. `
      + 'Leave them as they are, or ask the user to unlock those clips.';
  }
  const world = locked.some((c) => isLivePath(c.path))
    ? _WORLD_FIELDS.filter((f) => _stable(existing[f] ?? null) !== _stable(next[f] ?? null))
    : [];
  if (world.length) {
    return `changing ${world.join(', ')} would alter the live 3D of clips the user locked on the timeline. `
      + 'Ask the user to unlock those clips, or to generate their video first.';
  }
  return null;
}

/**
 * TIMING belongs to the montage: every story shot's `duration` is the length
 * its 3D shot plays on the montage, written back here whatever the script
 * said (a continuous take keeps one duration per shot, never the take's sum
 * on its first shot). The scenes are re-stamped so the new wording of the
 * durations never reads as "previz out of date".
 */
function _durationsFromMontage(storyboardId, sb, items) {
  const touched = new Map();
  for (const { scene, shot, sbShot } of items) {
    if (shot.inMontage === false || !Number.isFinite(shot.durationMs)) continue;
    const secs = Math.round(shot.durationMs / 100) / 10;
    if (sbShot.duration === secs) continue;
    sbShot.duration = secs;
    if (!touched.has(scene.id)) touched.set(scene.id, new Set());
    touched.get(scene.id).add(shot.id);
  }
  if (!touched.size) return;
  _writeJson(storyboardPath(storyboardId), sb);
  for (const [sid, ids] of touched) {
    const s = readScene(sid);
    if (!s) continue;
    stampSources(s, ids);
    writeScene(s);
  }
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

// Script fields a merged shot takes from the shots it absorbs (in order).
const _MERGE_APPEND = ['action', 'dialogue', 'sfx', 'music'];

/**
 * Merge consecutive 3D shots into the FIRST one, in [scene] and its
 * storyboard [sb] (both mutated, nothing written): it keeps its own camera
 * over the whole window (the action runs on the same scene clock), the other
 * shots disappear, and the script's first shot absorbs what the others said.
 * @returns {string[]} ids of the scene shots removed
 */
export function mergeShotsInto(scene, sb, shots, start = shots[0].startMs,
  dur = shots[shots.length - 1].startMs + shots[shots.length - 1].durationMs - start) {
  const [first, ...rest] = shots;
  _trimCamera(first, start, dur);
  first.startMs = start;
  first.durationMs = dur;
  const gone = new Set(rest.map((x) => x.id));
  scene.shots = scene.shots.filter((x) => !gone.has(x.id));
  if (sb) {
    const all = (sb.scenes || []).flatMap((sc) => sc.shots || []);
    const head = all.find((x) => x?.id === first.storyboardShotId);
    const tails = rest.map((x) => all.find((y) => y?.id === x.storyboardShotId)).filter(Boolean);
    if (head) {
      for (const t of tails) {
        for (const f of _MERGE_APPEND) {
          const a = typeof head[f] === 'string' ? head[f].trim() : '';
          const b = typeof t[f] === 'string' ? t[f].trim() : '';
          if (b && b !== a) head[f] = a ? `${a} ${b}` : b;
        }
        if (t.continuity != null) head.continuity = t.continuity;
        if (Array.isArray(t.references)) head.references = [...new Set([...(head.references || []), ...t.references])];
      }
      head.duration = Math.round(dur / 100) / 10;
      const drop = new Set(tails);
      for (const sc of sb.scenes || []) if (Array.isArray(sc.shots)) sc.shots = sc.shots.filter((x) => !drop.has(x));
      _renumber(sb);
    }
  }
  return [...gone];
}

function _renumber(sb) {
  // A continuation shares the number of the shot it continues.
  let n = 0;
  for (const sc of sb.scenes || []) {
    for (const sh of sc.shots || []) {
      if (!sh || typeof sh !== 'object') continue;
      if (!n && sh.noCutBefore === true) sh.noCutBefore = false;
      sh.number = sh.noCutBefore === true ? n : ++n;
    }
  }
}

/**
 * Merge consecutive shots of a scene (by id) into the first: scene and
 * storyboard written, the merged shot re-rendered.
 */
export function mergeShots(sceneId, shotIds) {
  const scene = readScene(sceneId);
  if (!scene) throw new Error(`no scene "${sceneId}"`);
  const shots = shotIds.map((id) => scene.shots.find((x) => x.id === id));
  const missing = shotIds.filter((_, i) => !shots[i]);
  if (missing.length) throw new Error(`no shot ${missing.join(', ')} in ${sceneId}`);
  shots.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < shots.length; i++) {
    const p = shots[i - 1];
    if (Math.abs(p.startMs + p.durationMs - shots[i].startMs) > 2) {
      throw new Error(`shots ${p.id} and ${shots[i].id} do not follow each other on the scene clock`);
    }
  }
  const sbId = scene.storyboard?.id;
  const fp = sbId ? storyboardPath(sbId) : null;
  const sb = fp ? _readJson(fp) : null;
  const removed = mergeShotsInto(scene, sb, shots);
  if (sb) _writeJson(fp, sb);
  stampSources(scene, new Set([shots[0].id]));
  writeScene(scene);
  renderScene(scene, { shotIds: [shots[0].id] })
    .catch((err) => channel.log('scene3d', `re-render after merging shots ${sceneId}: ${err.message}`));
  return { merged: shots[0].id, removed, durationMs: shots[0].durationMs };
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
    const now = new Set(clips.flatMap(_keys));
    return laid.keys.filter((k) => !now.has(k));
  })();
  const scenes = new Map();
  const sceneOf = (sid) => {
    if (!scenes.has(sid)) {
      const s = readScene(sid);
      scenes.set(sid, { s, touched: new Set() });
    }
    return scenes.get(sid);
  };
  const sbShots = new Map();
  for (const sc of sb.scenes || []) for (const sh of sc.shots || []) sbShots.set(sh.id, sh);
  const rank = new Map(); // storyboard shot id → clip order
  const setWindow = (e, sh, start, dur) => {
    if (start === sh.startMs && dur === sh.durationMs) return;
    _trimCamera(sh, start, dur);
    sh.startMs = start;
    sh.durationMs = dur;
    e.touched.add(sh.id);
  };
  clips.forEach((c, i) => {
    const e = sceneOf(c.scene3d.sceneId);
    const shots = clipShotIds(c).map((id) => e.s?.shots?.find((x) => x.id === id)).filter(Boolean);
    if (!shots.length) return;
    const sh = shots[0];
    shots.forEach((x, j) => { if (x.storyboardShotId) rank.set(x.storyboardShotId, i + j / 100); });
    const dur = Math.max(200 * shots.length, Math.round(c.durationMs));
    let start = sh.startMs;
    const live = isLivePath(c.path);
    if (live) start = Math.round(c.sourceInMs || 0);
    // Joined on the timeline ("Delete Through Edit") — not a take the script
    // already glues: ONE shot from now on, with the first one's camera.
    const joined = shots.length > 1 && shots.slice(1).some((x) => sbShots.get(x.storyboardShotId)?.noCutBefore !== true);
    if (joined) {
      mergeShotsInto(e.s, sb, shots, start, dur);
      e.touched.add(sh.id);
      done.storyboard = true;
      return;
    }
    if (shots.length === 1) {
      setWindow(e, sh, start, dur);
    } else {
      // A continuous take: its outer edges move the first shot's start and
      // the last shot's end; the joins between its shots stay where they are.
      const end = start + dur;
      const inner = shots.slice(1).map((x) => x.startMs);
      const firstEnd = Math.max(start + 200, Math.min(inner[0], end - 200 * (shots.length - 1)));
      setWindow(e, sh, start, firstEnd - start);
      for (let j = 1; j < shots.length; j++) {
        const s0 = j === 1 ? firstEnd : shots[j].startMs;
        const s1 = j === shots.length - 1 ? end : shots[j + 1].startMs;
        setWindow(e, shots[j], s0, Math.max(200, s1 - s0));
      }
    }
    for (const [j, x] of shots.entries()) {
      const sbShot = x.storyboardShotId && sbShots.get(x.storyboardShotId);
      if (!sbShot) continue;
      const secs = Math.round(x.durationMs / 100) / 10;
      if (sbShot.duration !== secs) { sbShot.duration = secs; done.storyboard = true; }
      // Joined on the timeline ("Delete Through Edit"): the script now
      // plays these shots as ONE continuous take.
      if (j > 0 && sbShot.noCutBefore !== true) { sbShot.noCutBefore = true; done.storyboard = true; e.touched.add(x.id); }
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
  if (done.storyboard) {
    _renumber(sb);
    _writeJson(fp, sb);
  }
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
    if (!e.s) continue;
    // The clips decide which stretch of the action each camera watches; the
    // action itself is not touched. The saved clips follow.
    for (const id of relayShots(e.s)) e.touched.add(id);
    for (const c of clips) {
      if (c.scene3d.sceneId !== sid) continue;
      const ids = clipShotIds(c);
      const first = e.s.shots.find((x) => x.id === ids[0]);
      if (first && isLivePath(c.path)) c.sourceInMs = first.startMs;
      for (const x of c.scene3d.shots || []) {
        const sh = e.s.shots.find((y) => y.id === x.id);
        if (sh) { x.startMs = sh.startMs; x.durationMs = sh.durationMs; }
      }
    }
    if (!e.touched.size) continue;
    e.s.durationMs = sceneDurationMs(e.s);
    // Built from the storyboard as it is NOW (the edit came from here).
    stampSources(e.s, e.touched);
    writeScene(e.s);
    done.scenes.push(sid);
    renderScene(e.s, { shotIds: [...e.touched] })
      .catch((err) => channel.log('scene3d', `re-render after montage edit ${sid}: ${err.message}`));
  }
  return done;
}
