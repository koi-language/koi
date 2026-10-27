/**
 * 3D previz scenes ("scene3d").
 *
 * One JSON per scene in ~/.koi/scenes3d/<id>.json, renders beside it in
 * ~/.koi/scenes3d/<id>/. A scene is ONE shared set (place + characters +
 * blocking on a single clock) covered by N shots; each shot is a camera
 * over a window [startMs, startMs + durationMs] of that clock. Shots that
 * overlap in time are coverage of the same action (plano / contraplano).
 *
 * Renders per shot (content-hashed so unchanged shots never re-render):
 *   <shot>-<hash>.mp4        camera over the WHOLE scene → timeline proxy
 *                            (trim/slip on the timeline is free: the clip
 *                            just windows into it via sourceInMs)
 *   <shot>-<hash>-cut.mp4    only the shot window → animated storyboard card
 *   <shot>-<hash>.jpg        poster (middle of the window)
 *   <shot>-<hash>-depth.mp4  / -mask.mp4   structure passes, on demand
 *
 * Links kept in sync after every render:
 *   - storyboard shot `_preview3d` (GUI-private underscore key, carried
 *     forward by save/update_storyboard)
 *   - every timeline clip whose `scene3d` = { sceneId, shotId } gets its
 *     `path` / `sourceTotalMs` pointed at the fresh proxy
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { runBuilder } from './_blender.js';
import { BUILD_SCENE_PY } from './_build-scene-py.js';

// Builder version: a change to the Blender script must invalidate every
// cached render, or old previews would survive a fix forever.
const _BUILDER_HASH = crypto.createHash('sha1').update(BUILD_SCENE_PY).digest('hex').slice(0, 8);
import { getTimeline, updateTimeline } from '../../state/timelines.js';
import { channel } from '../../io/channel.js';

const ASPECTS = {
  '16:9': [960, 540], '9:16': [540, 960], '1:1': [720, 720], '4:5': [720, 900],
  '4:3': [960, 720], '3:4': [720, 960], '21:9': [1120, 480], '2.39:1': [1148, 480],
};

export const STYLES = ['clay', 'sketch', 'lit'];
export const PASSES = ['beauty', 'depth', 'mask'];

function _home() {
  return process.env.HOME || os.homedir();
}

export function scenesDir() {
  return path.join(_home(), '.koi', 'scenes3d');
}

export function scenePath(id) {
  return path.join(scenesDir(), `${id}.json`);
}

export function renderDir(id) {
  return path.join(scenesDir(), id);
}

export function cleanId(id) {
  return typeof id === 'string' ? path.basename(id.trim()).replace(/\.json$/i, '') : '';
}

export function newSceneId() {
  return `s3d-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function _atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readScene(id) {
  const fp = scenePath(cleanId(id));
  if (!fs.existsSync(fp)) return null;
  const scene = JSON.parse(fs.readFileSync(fp, 'utf8'));
  scene.style = 'lit'; // single look
  return scene;
}

export function writeScene(scene) {
  scene.updatedAt = new Date().toISOString();
  _atomicWrite(scenePath(scene.id), scene);
  return scene;
}

export function listScenes() {
  const dir = scenesDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: s.id,
        name: s.name,
        storyboard: s.storyboard || null,
        shotCount: (s.shots || []).length,
        durationMs: s.durationMs,
        updatedAt: s.updatedAt,
      });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// ───────────────────────────────────────────────────────── validation ──

const _isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const _int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

function _shotId(i, taken) {
  let n = i + 1;
  while (taken.has(`shot${n}`)) n += 1;
  return `shot${n}`;
}

/**
 * Normalise an incoming scene (agent or GUI). Throws an Error with an
 * actionable message on input the builder could not use.
 */
export function normalizeScene(input, existing = null) {
  if (!_isObj(input)) throw new Error('scene must be an object');
  const s = { ...input };
  s.id = cleanId(s.id) || existing?.id || newSceneId();
  s.name = (typeof s.name === 'string' && s.name.trim()) || existing?.name || 'Escena 3D';
  s.version = 1;
  s.createdAt = existing?.createdAt || s.createdAt || new Date().toISOString();
  s.fps = Math.max(12, Math.min(60, _int(s.fps, 24)));
  s.aspect = typeof s.aspect === 'string' && ASPECTS[s.aspect] ? s.aspect : (existing?.aspect || '16:9');
  if (!_isObj(s.resolution)) {
    const [w, h] = ASPECTS[s.aspect];
    s.resolution = { width: w, height: h };
  }
  // One look: Lit (clean real-time EEVEE). Older scenes saved as clay follow.
  s.style = 'lit';
  if (s.set !== undefined && !_isObj(s.set)) throw new Error('`set` must be an object { type, size, props, … }');
  s.set = s.set || { type: 'room', size: [8, 8, 3], props: [] };
  if (s.set.props !== undefined && !Array.isArray(s.set.props)) throw new Error('`set.props` must be an array');
  if (!Array.isArray(s.characters)) s.characters = [];
  if (!Array.isArray(s.actions)) s.actions = [];
  if (!Array.isArray(s.shots) || s.shots.length === 0) {
    throw new Error('`shots` must be a non-empty array — each shot = { id, startMs, durationMs, camera:{…}, move? }');
  }
  const charIds = new Set();
  s.characters = s.characters.map((c, i) => {
    if (!_isObj(c)) throw new Error(`characters[${i}] must be an object`);
    const id = (typeof c.id === 'string' && c.id.trim()) || `char${i + 1}`;
    if (charIds.has(id)) throw new Error(`duplicate character id "${id}"`);
    charIds.add(id);
    if (!Array.isArray(c.position)) throw new Error(`character "${id}" needs position: [x, y] (metres)`);
    return { ...c, id };
  });
  const propIds = new Set(((s.set && s.set.props) || s.props || []).map((p) => p?.id).filter(Boolean));
  s.actions = s.actions.map((a, i) => {
    if (!_isObj(a)) throw new Error(`actions[${i}] must be an object`);
    const type = String(a.type || '').toLowerCase();
    if (type === 'drive' || type === 'ride') {
      // A vehicle drives itself; whoever rides it sits in it.
      if (!propIds.has(a.prop)) {
        throw new Error(`actions[${i}].prop "${a.prop}" is not a prop id (a ${type} needs the vehicle's prop id)`);
      }
      if (type === 'drive' && !(Array.isArray(a.to) && a.to.length >= 2)) {
        throw new Error(`actions[${i}]: a drive needs to: [x, y]`);
      }
    }
    if (type !== 'drive' && !charIds.has(a.character)) {
      throw new Error(`actions[${i}].character "${a.character}" is not a character id (have: ${[...charIds].join(', ') || 'none'})`);
    }
    // A ride with no times is for the whole scene: keep it untimed.
    if (type === 'ride' && a.startMs == null && a.endMs == null) return { ...a };
    return { ...a, startMs: Math.max(0, _int(a.startMs)), endMs: a.endMs != null ? Math.max(0, _int(a.endMs)) : undefined };
  });
  const prevById = new Map((existing?.shots || []).map((x) => [x.id, x]));
  const taken = new Set();
  s.shots = s.shots.map((sh, i) => {
    if (!_isObj(sh)) throw new Error(`shots[${i}] must be an object`);
    const id = (typeof sh.id === 'string' && sh.id.trim()) || _shotId(i, taken);
    if (taken.has(id)) throw new Error(`duplicate shot id "${id}"`);
    taken.add(id);
    const out = {
      ...sh,
      id,
      startMs: Math.max(0, _int(sh.startMs)),
      durationMs: Math.max(200, _int(sh.durationMs, 3000)),
      camera: _isObj(sh.camera) ? sh.camera : {},
    };
    // Render bookkeeping is ours — keep the previous one, never trust input.
    const prev = prevById.get(id);
    if (prev?.preview) out.preview = prev.preview; else delete out.preview;
    return out;
  });
  s.durationMs = sceneDurationMs(s);
  return s;
}

export function sceneDurationMs(s) {
  let d = 0;
  for (const sh of s.shots || []) d = Math.max(d, (sh.startMs || 0) + (sh.durationMs || 0));
  for (const a of s.actions || []) d = Math.max(d, a.endMs || a.startMs || 0);
  // Padded + bucketed: a little tail past the last shot lets the timeline
  // extend a clip (the camera holds), and small trims don't change the
  // scene length — which would otherwise re-render every shot's proxy.
  return Math.max(4000, Math.ceil((d + 1000) / 2000) * 2000);
}

/** Content hash of everything that changes a shot's pixels. */
export function shotHash(scene, shot, style) {
  const moving = !!(shot.keyframes?.length
    || (shot.move && shot.move !== 'static' && shot.move?.type !== 'static')
    || shot.camera?.move);
  // The key light is the scene's (see _scene_key_light in the builder): it
  // comes from the first shot that has one, read against that shot's camera.
  const keyShot = [...(scene.shots || [])]
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
    .find((s) => s.light && typeof s.light === 'object');
  const world = {
    set: scene.set, characters: scene.characters, actions: scene.actions, characterStyle: scene.characterStyle,
    lighting: scene.lighting, fps: scene.fps, resolution: scene.resolution,
    durationMs: scene.durationMs, style,
    key: keyShot ? [keyShot.light, keyShot.camera, keyShot.move, keyShot.keyframes, keyShot.startMs] : null,
  };
  const cam = {
    camera: shot.camera, move: shot.move, keyframes: shot.keyframes,
    // A static camera looks identical whatever its window — leave the
    // window out so trimming a static shot never re-renders the proxy.
    window: moving ? [shot.startMs, shot.durationMs] : null,
    // The subject-framed camera is solved at the window start.
    solveAt: shot.camera?.position == null ? shot.startMs : null,
  };
  return crypto.createHash('sha1').update(JSON.stringify([_BUILDER_HASH, world, cam])).digest('hex').slice(0, 10);
}

// ─────────────────────────────────────────────────────────── render ──

async function _ffmpegBin() {
  try {
    const { ensureFfmpeg } = await import('../../media/ffmpeg-installer.js');
    const r = await ensureFfmpeg();
    return r?.ffmpeg || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

function _run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-300)}`))));
  });
}

function _exists(p) {
  return typeof p === 'string' && p && fs.existsSync(p);
}

function _cardSize(scene) {
  const { width, height } = scene.resolution || {};
  if (!width || !height) return [];
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return ['--width', String(even(width * 2 / 3)), '--height', String(even(height * 2 / 3))];
}

/** Split jobs over a few Blender processes: each builds the world once, so
 *  only split when there is enough work to beat the extra start-up. */
function _chunks(jobs) {
  if (!jobs.length) return [];
  const n = Math.max(1, Math.min(3, Math.floor(jobs.length / 8)));
  const out = Array.from({ length: n }, () => []);
  jobs.forEach((j, i) => out[i % n].push(j));
  return out;
}

/**
 * Render (or reuse) shots of a scene. FAST PATH: every shot renders only its
 * own window (its storyboard card / generation reference), all shots in
 * parallel. The whole-scene proxy each timeline clip windows into is
 * `full: 'background'` by default (queued after this returns), `'await'`
 * when the caller needs it now (placing clips), or `false`.
 *
 * @returns {Promise<{ rendered: string[], reused: string[], failed: {shotId, error}[] }>}
 */
export async function renderScene(scene, { shotIds = null, passes = ['beauty'], style = null, force = false, video = false, onProgress } = {}) {
  void style;
  const st = 'lit';
  const dir = renderDir(scene.id);
  fs.mkdirSync(dir, { recursive: true });
  const want = new Set((passes || ['beauty']).filter((p) => PASSES.includes(p) && p !== 'beauty'));
  const targets = (scene.shots || []).filter((sh) => !shotIds || shotIds.includes(sh.id));
  const res = { rendered: [], reused: [], failed: [] };
  const ffmpeg = await _ffmpegBin();

  // The builder reads a frozen snapshot, never the live file the GUI or
  // another tool might be rewriting mid-render.
  const snap = path.join(dir, `.snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(snap, JSON.stringify(scene), 'utf8');
  // Plan every shot first, then render: the set, cast and blocking are the
  // same for all shots — only the camera changes — so ONE Blender process
  // builds the world once and renders every camera (split in a few chunks
  // to use the cores when there are many shots).
  const plans = [];
  const byPass = { beauty: [], depth: [], mask: [] };
  // Results by shot id. Never read them back off `scene.shots`: each live
  // publish re-reads the scene from disk (fresh objects), so a reference to
  // an old shot object would silently drop every later shot's preview.
  const previews = new Map();
  for (const sh of targets) {
    const hash = shotHash(scene, sh, st);
    const base = path.join(dir, `${sh.id}-${hash}`);
    const win = `${sh.startMs}-${sh.durationMs}`;
    const pv = sh.preview && sh.preview.hash === hash ? { ...sh.preview } : { hash, style: st };
    const cut = `${base}-cut-${win}.mp4`;
    const poster = `${base}-${win}.jpg`;
    const sheet = `${base}-sheet-${win}.jpg`;
    const stills = `${base}-${win}.stills`;
    const plan = { sh, pv, cut, poster, sheet, stills, base, win, outs: [] };
    const job = (pass, out) => {
      byPass[pass].push({ shot: sh.id, out: `${out}.part.mp4`, fromMs: sh.startMs, toMs: sh.startMs + sh.durationMs });
      plan.outs.push([pass, out]);
    };
    // The shot plays LIVE (Blender interprets it in the GUI); what is
    // rendered here is only what must exist as a file: the card poster +
    // the 3-frame review sheet (stills), and a video only when asked for
    // (generation references, export).
    if (force || !_exists(poster) || !_exists(sheet)) {
      const last = Math.max(sh.startMs, sh.startMs + sh.durationMs - Math.ceil(1000 / (scene.fps || 24)));
      byPass.beauty.push({ shot: sh.id, out: stills, stills: [sh.startMs, Math.round(sh.startMs + sh.durationMs / 2), last],
        fromMs: sh.startMs, toMs: sh.startMs + sh.durationMs });
      plan.outs.push(['stills', stills]);
    }
    if (video) {
      if (force || !_exists(cut)) job('beauty', cut); else pv.cut = cut;
    }
    for (const pass of want) {
      const out = `${base}-${pass}-cut-${win}.mp4`;
      if (force || !_exists(out)) job(pass, out); else pv[pass] = out;
    }
    if (!plan.outs.length) {
      pv.sheet = sheet;
      pv.poster = poster;
      res.reused.push(sh.id);
      sh.preview = pv;
      previews.set(sh.id, pv);
      continue;
    }
    plans.push(plan);
  }
  const failedBatch = new Map(); // shot id → error
  // Publish each shot as soon as ALL its passes have landed: the card
  // animates while the other cameras are still rendering.
  const planById = new Map(plans.map((pl) => [pl.sh.id, pl]));
  const passesLeft = new Map(plans.map((pl) => [pl.sh.id, pl.outs.length]));
  const finished = new Set();
  let publishChain = Promise.resolve();
  const finishPlan = async (pl) => {
    const { sh, pv, cut, poster, sheet, stills, outs } = pl;
    try {
      if (failedBatch.has(sh.id)) throw new Error(failedBatch.get(sh.id));
      for (const [pass, out] of outs) {
        if (pass === 'stills') continue;
        if (_exists(`${out}.part.mp4`)) fs.renameSync(`${out}.part.mp4`, out);
        pv[pass === 'beauty' ? 'cut' : pass] = out;
      }
      const frames = [0, 1, 2].map((i) => `${stills}-${i}.png`);
      if (frames.every(_exists)) {
        await _run(ffmpeg, ['-v', 'error', '-y', '-i', frames[1], '-q:v', '3', poster]);
        // Review sheet: first / middle / last frame side by side — what the
        // agent LOOKS at to check framing AND movement against the script.
        try {
          await _run(ffmpeg, ['-v', 'error', '-y', '-start_number', '0', '-i', `${stills}-%d.png`, '-vf',
            'scale=400:-2,tile=3x1:padding=6:color=0x202020', '-frames:v', '1', '-q:v', '4', sheet]);
        } catch { /* review is best-effort */ }
        for (const f of frames) fs.rmSync(f, { force: true });
      } else if (outs.some(([p]) => p === 'stills')) {
        throw new Error('stills were not rendered');
      }
      if (_exists(sheet)) pv.sheet = sheet;
      // What the camera actually sees (written by the builder): the shot's
      // continuity, derived from the 3D — kept internally, never shown.
      try {
        const inf = `${pl.base}-${pl.win}.inframe.json`;
        if (_exists(inf)) { pv.inFrame = JSON.parse(fs.readFileSync(inf, 'utf8')); fs.rmSync(inf, { force: true }); }
        fs.rmSync(`${cut}.inframe.json`, { force: true });
      } catch { /* advisory */ }
      if (video && _exists(cut)) pv.cut = cut;
      pv.poster = poster;
      pv.cutWindow = [sh.startMs, sh.durationMs];
      pv.renderedAt = new Date().toISOString();
      sh.preview = pv;
      previews.set(sh.id, pv);
      res.rendered.push(sh.id);
    } catch (e) {
      channel.log('scene3d', `render ${scene.id}/${sh.id} failed: ${e.message}`);
      res.failed.push({ shotId: sh.id, error: e.message });
    }
  };
  const onShotDone = (shotId) => {
    const left = (passesLeft.get(shotId) || 1) - 1;
    passesLeft.set(shotId, left);
    const pl = planById.get(shotId);
    if (left > 0 || !pl || finished.has(shotId)) return;
    finished.add(shotId);
    publishChain = publishChain.then(async () => {
      await finishPlan(pl);
      _commitPreviews(scene, st, previews);
      await syncLinks(scene);
    }).catch((e) => channel.log('scene3d', `publish ${shotId} failed: ${e.message}`));
  };
  try {
    const runs = [];
    for (const [pass, jobs] of Object.entries(byPass)) {
      for (const chunk of _chunks(jobs)) {
        runs.push((async () => {
          const jf = `${snap}.${pass}-${runs.length}.jobs.json`;
          fs.writeFileSync(jf, JSON.stringify(chunk), 'utf8');
          try {
            // Cards are small: the beauty cut renders at 2/3 size (≈2× faster);
            // structure passes keep full size for generation.
            // Lit with few samples: the noise sources are off, so 4 is clean.
            const sz = pass === 'beauty' ? [..._cardSize(scene), '--samples', '4'] : [];
            await runBuilder(['--scene', snap, '--jobs', jf, '--pass', pass, '--style', st, ...sz], {
              onProgress: (_p, label) => label && onProgress?.(null, label),
              onShotDone,
              heavy: video, // whole clips: one at a time (see runBuilder)
            });
          } catch (e) {
            for (const j of chunk) failedBatch.set(j.shot, e.message);
          } finally {
            fs.rmSync(jf, { force: true });
          }
        })());
      }
    }
    await Promise.all(runs);
  } finally {
    fs.rmSync(snap, { force: true });
  }
  await publishChain;
  // Anything not published live (failed batch, missed line) finishes here.
  for (const pl of plans) if (!finished.has(pl.sh.id)) await finishPlan(pl);
  _commitPreviews(scene, st, previews);
  await syncLinks(scene);

  onProgress?.(1, 'Done');
  return res;
}

/** Merge freshly rendered previews into the scene AS IT IS ON DISK NOW: a
 *  concurrent edit while Blender ran must not be clobbered — only previews
 *  whose hash still matches the current shot are ours to set. */
function _commitPreviews(scene, st, previews) {
  const fresh = readScene(scene.id) || scene;
  for (const sh of fresh.shots || []) {
    const r = previews.get(sh.id);
    if (r && shotHash(fresh, sh, st) === r.hash) {
      sh.preview = { ...(sh.preview?.hash === r.hash ? sh.preview : {}), ...r };
    }
  }
  writeScene(fresh);
  Object.assign(scene, fresh);
  _gc(scene);
}

/** Timeline clip path of a live 3D shot: no file — the GUI's preview has
 *  Blender interpret it live; it becomes a video only when baked. */
export const livePath = (sceneId, shotId) => `scene3d:${sceneId}/${shotId}`;
export const isLivePath = (p) => typeof p === 'string' && p.startsWith('scene3d:');

const _bakes = new Map(); // out path → in-flight render

/** One still of a shot at scene time `ms` (PNG) — exporting a single
 *  frame of a timeline. Cached like [bakeWindow]. */
export async function bakeStill(sceneId, shotId, ms, { width, height } = {}) {
  const scene = readScene(sceneId);
  const sh = scene?.shots?.find((x) => x.id === shotId);
  if (!sh) throw new Error(`scene3d bake: no shot ${sceneId}/${shotId}`);
  const st = 'lit';
  const dir = renderDir(scene.id);
  fs.mkdirSync(dir, { recursive: true });
  const w = width ? Math.round(width / 2) * 2 : 0;
  const h = height ? Math.round(height / 2) * 2 : 0;
  const key = crypto.createHash('sha1').update(JSON.stringify([shotHash(scene, sh, st), 'still', ms, w, h])).digest('hex').slice(0, 10);
  const out = path.join(dir, `${sh.id}-${key}-still-${Math.round(ms)}.png`);
  if (_exists(out)) return out;
  if (_bakes.has(out)) return _bakes.get(out);
  const run = (async () => {
    const snap = path.join(dir, `.snapshot-still-${process.pid}-${key}.json`);
    fs.writeFileSync(snap, JSON.stringify(scene), 'utf8');
    try {
      await runBuilder(['--scene', snap, '--shot', sh.id, '--out', `${out}.part.png`, '--still', String(Math.round(ms)),
        '--style', st, '--samples', '16', ...(w && h ? ['--width', String(w), '--height', String(h)] : [])]);
      fs.renameSync(`${out}.part.png`, out);
      return out;
    } finally {
      fs.rmSync(snap, { force: true });
    }
  })().finally(() => _bakes.delete(out));
  _bakes.set(out, run);
  return run;
}

/**
 * Bake ONE window of a shot (scene clock [fromMs, toMs)) to an mp4 — only
 * for what needs a real file: exporting a timeline. Cached per scene state +
 * window + size, so a second export of an untouched montage is instant.
 */
export async function bakeWindow(sceneId, shotId, fromMs, toMs, { width, height } = {}) {
  const scene = readScene(sceneId);
  const sh = scene?.shots?.find((x) => x.id === shotId);
  if (!sh) throw new Error(`scene3d bake: no shot ${sceneId}/${shotId}`);
  const st = 'lit';
  const dir = renderDir(scene.id);
  fs.mkdirSync(dir, { recursive: true });
  const w = width ? Math.round(width / 2) * 2 : 0;
  const h = height ? Math.round(height / 2) * 2 : 0;
  const key = crypto.createHash('sha1').update(JSON.stringify([shotHash(scene, sh, st), fromMs, toMs, w, h])).digest('hex').slice(0, 10);
  const out = path.join(dir, `${sh.id}-${key}-bake-${Math.round(fromMs)}-${Math.round(toMs)}.mp4`);
  // Kept beside the bake: who the camera sees and where (bakeInFrame).
  if (_exists(out) && _exists(`${out}.inframe.json`)) return out;
  if (_bakes.has(out)) return _bakes.get(out);
  const run = (async () => {
    const snap = path.join(dir, `.snapshot-bake-${process.pid}-${key}.json`);
    const jf = `${snap}.jobs.json`;
    fs.writeFileSync(snap, JSON.stringify(scene), 'utf8');
    fs.writeFileSync(jf, JSON.stringify([{ shot: sh.id, out: `${out}.part.mp4`, fromMs, toMs }]), 'utf8');
    try {
      await runBuilder(['--scene', snap, '--jobs', jf, '--pass', 'beauty', '--style', st, '--samples', '8',
        ...(w && h ? ['--width', String(w), '--height', String(h)] : [])], { heavy: true });
      fs.renameSync(`${out}.part.mp4`, out);
      return out;
    } finally {
      fs.rmSync(snap, { force: true });
      fs.rmSync(jf, { force: true });
    }
  })().finally(() => _bakes.delete(out));
  _bakes.set(out, run);
  return run;
}

/** Who a bake's camera sees and where on screen: { characters: [{id, name,
 *  x (0 left … 1 right), share (of the frame height), frames, of}], props }. */
export function bakeInFrame(bakePath) {
  try { return JSON.parse(fs.readFileSync(`${bakePath}.inframe.json`, 'utf8')); } catch { return null; }
}

/** Drop render files no shot points at any more (keeps the newest 2 per shot
 *  so a GUI undo that restores an older proxy path still finds it). */
function _gc(scene) {
  const dir = renderDir(scene.id);
  let files;
  try { files = fs.readdirSync(dir); } catch { return; }
  const live = new Set();
  for (const sh of scene.shots || []) {
    for (const k of ['cut', 'poster', 'sheet', 'depth', 'mask']) {
      if (sh.preview?.[k]) live.add(path.basename(sh.preview[k]));
    }
  }
  // Never delete what a storyboard card still points at (the visor may not
  // have reloaded the new paths yet).
  if (scene.storyboard?.id) {
    try {
      const sb = JSON.parse(fs.readFileSync(storyboardPath(scene.storyboard.id), 'utf8'));
      for (const sc of sb.scenes || []) {
        for (const sh of sc.shots || []) {
          for (const k of ['video', 'poster']) {
            const v = sh?._preview3d?.[k];
            if (typeof v === 'string') live.add(path.basename(v));
          }
        }
      }
    } catch { /* no storyboard */ }
  }
  const ids = new Set((scene.shots || []).map((s) => s.id));
  const groups = new Map();
  for (const f of files) {
    if (f.startsWith('.') || live.has(f)) continue;
    const m = /^(.+?)-([0-9a-f]{10})/.exec(f);
    if (!m) continue;
    if (!ids.has(m[1])) { fs.rmSync(path.join(dir, f), { force: true }); continue; }
    const g = groups.get(m[1]) || [];
    g.push(f);
    groups.set(m[1], g);
  }
  for (const g of groups.values()) {
    const sorted = g.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of sorted.slice(8)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

// ──────────────────────────────────────────────────────────── links ──

export function storyboardPath(id) {
  return path.join(_home(), '.koi', 'storyboards', `${cleanId(id)}.json`);
}

/** Stamp `_preview3d` onto linked storyboard shots + repoint timeline clips. */
export async function syncLinks(scene) {
  // Storyboard cards.
  const sbId = scene.storyboard?.id;
  if (sbId) {
    const fp = storyboardPath(sbId);
    try {
      if (fs.existsSync(fp)) {
        const sb = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const byShot = new Map();
        for (const sh of scene.shots || []) if (sh.storyboardShotId) byShot.set(sh.storyboardShotId, sh);
        let changed = false;
        for (const sc of sb.scenes || []) {
          for (const shot of sc.shots || []) {
            const s3 = byShot.get(shot.id);
            const prev = shot._preview3d;
            if (!s3) {
              // Unlinked since last sync → drop our stamp (only ours).
              if (prev?.sceneId === scene.id) { delete shot._preview3d; changed = true; }
              continue;
            }
            const pv = s3.preview || {};
            const next = {
              sceneId: scene.id, shotId: s3.id,
              video: pv.cut || null, poster: pv.poster || null,
              startMs: s3.startMs, durationMs: s3.durationMs, updatedAt: pv.renderedAt || null,
              ...(pv.inFrame ? { inFrame: pv.inFrame } : {}),
            };
            if (JSON.stringify(prev) !== JSON.stringify(next)) { shot._preview3d = next; changed = true; }
          }
        }
        if (changed) _atomicWrite(fp, sb);
      }
    } catch (e) {
      channel.log('scene3d', `storyboard link sync failed: ${e.message}`);
    }
  }

  // Timeline clips. Cheap text pre-filter so we only parse timelines that
  // mention this scene.
  const tlDir = path.join(_home(), '.koi', 'timelines');
  let files = [];
  try { files = fs.readdirSync(tlDir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  const byId = new Map((scene.shots || []).map((s) => [s.id, s]));
  for (const f of files) {
    const fp = path.join(tlDir, f);
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    if (!raw.includes(scene.id)) continue;
    const id = f.replace(/\.json$/, '');
    try {
      const tl = getTimeline(id);
      if (!tl) continue;
      let changed = false;
      for (const c of tl.clips || []) {
        if (c.scene3d?.sceneId !== scene.id) continue;
        const sh = byId.get(c.scene3d.shotId);
        if (!sh) continue;
        // Only a clip still SHOWING the previz is live 3D; once the real shot
        // was generated onto it (assign_generated_media_to_clip) the previz
        // lives on as its aiState placeholder — "back to previz" goes live.
        // Old timelines pointed at pre-rendered proxies: they go live too.
        const live = livePath(scene.id, sh.id);
        const isPreviz = (p) => isLivePath(p) || (typeof p === 'string' && p.startsWith(renderDir(scene.id) + path.sep));
        if (isPreviz(c.path)) {
          if (c.path !== live) {
            // A cut-only stand-in windowed the shot from its own 0.
            if (!isLivePath(c.path) && /-cut-/.test(c.path)) c.sourceInMs = sh.startMs + (c.sourceInMs || 0);
            c.path = live;
            changed = true;
          }
          if (c.sourceTotalMs !== scene.durationMs) { c.sourceTotalMs = scene.durationMs; changed = true; }
          const poster = sh.preview?.poster || null;
          if ((c.scene3d.poster || null) !== poster) { c.scene3d = { ...c.scene3d, poster }; changed = true; }
        } else if (c.aiState && isPreviz(c.aiState.placeholderPath) && c.aiState.placeholderPath !== live) {
          c.aiState.placeholderPath = live;
          changed = true;
        }
        // The real take was generated from the 3D as it was then: once the
        // 3D moves on, the take is behind its source.
        const from = c.scene3d.render?.sig;
        if (from) {
          const stale = from !== shotHash(scene, sh, 'lit');
          if (Boolean(c.scene3d.renderStale) !== stale) {
            const { renderStale: _, ...rest } = c.scene3d;
            c.scene3d = stale ? { ...rest, renderStale: true } : rest;
            changed = true;
          }
        }
      }
      if (changed) updateTimeline(id, tl);
    } catch (e) {
      channel.log('scene3d', `timeline ${id} link sync failed: ${e.message}`);
    }
  }

  // The story's montage follows every re-render (new shots join, windows
  // and order track the script).
  if (sbId) {
    try {
      const { ensureStoryTimeline } = await import('./_story-timeline.js');
      ensureStoryTimeline(sbId);
    } catch (e) {
      channel.log('scene3d', `montage sync ${sbId} failed: ${e.message}`);
    }
  }
}

/** A real take just landed on a 3D clip: remember which state of the 3D it
 *  was generated from, so a later change to the 3D marks it out of date. */
export function stampScene3dRender(timelineId, clipId, mediaPath) {
  const tl = getTimeline(timelineId);
  const c = tl?.clips?.find((x) => x.id === clipId);
  if (!c?.scene3d) return;
  const scene = readScene(c.scene3d.sceneId);
  const sh = scene?.shots?.find((x) => x.id === c.scene3d.shotId);
  if (!sh) return;
  const { renderStale: _, ...rest } = c.scene3d;
  c.scene3d = {
    ...rest,
    render: {
      path: mediaPath,
      sig: shotHash(scene, sh, 'lit'),
      fromMs: Number.isFinite(c.aiState?.placeholderSourceInMs) ? c.aiState.placeholderSourceInMs : sh.startMs,
      at: new Date().toISOString(),
    },
  };
  updateTimeline(timelineId, tl);
}

/** What the agent reviews after a render: per shot, the 3-frame sheet next
 *  to the storyboard text it must match. `_reviewImages` is turned into
 *  real images by the MCP layer. */
export function buildReview(scene, shotIds) {
  let sbShots = new Map();
  if (scene.storyboard?.id) {
    try {
      const sb = JSON.parse(fs.readFileSync(storyboardPath(scene.storyboard.id), 'utf8'));
      for (const sc of sb.scenes || []) for (const sh of sc.shots || []) sbShots.set(sh.id, sh);
    } catch { sbShots = new Map(); }
  }
  const cut = (v) => (typeof v === 'string' ? (v.length > 320 ? `${v.slice(0, 320)}…` : v) : undefined);
  const review = [];
  for (const sh of scene.shots || []) {
    if (shotIds && !shotIds.includes(sh.id)) continue;
    const pv = sh.preview || {};
    if (!pv.sheet) continue;
    const s = sbShots.get(sh.storyboardShotId) || {};
    review.push({
      shotId: sh.id,
      storyboardShotId: sh.storyboardShotId,
      sheet: pv.sheet,
      script: {
        shot: cut(s.shot), camera: cut(s.camera || s.movement), composition: cut(s.composition),
        lighting: cut(s.lighting), action: cut(s.action), seconds: s.duration,
      },
    });
  }
  return {
    review,
    _reviewImages: review.slice(0, 16).map((r) => r.sheet),
    reviewNote: review.length
      ? 'LOOK at each attached sheet (start | middle | end of the shot, in order of `review`) and compare it with its `script`: '
        + 'shot size, angle/height, lens feel, camera move, composition (who is where in frame, lead room), '
        + 'staging (positions, facing, who holds what), light direction. Fix every mismatch with update_scene3d, then re-check.'
      : undefined,
  };
}

/** Compact per-shot summary returned by the tools. */
export function summarize(scene) {
  return {
    id: scene.id,
    name: scene.name,
    path: scenePath(scene.id),
    durationMs: scene.durationMs,
    storyboard: scene.storyboard || null,
    shots: (scene.shots || []).map((sh) => ({
      id: sh.id,
      name: sh.name,
      storyboardShotId: sh.storyboardShotId,
      startMs: sh.startMs,
      durationMs: sh.durationMs,
      cut: sh.preview?.cut || null,
      poster: sh.preview?.poster || null,
      depth: sh.preview?.depth || null,
      mask: sh.preview?.mask || null,
    })),
  };
}
