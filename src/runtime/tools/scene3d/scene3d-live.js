/**
 * scene3d_live — the REAL Blender viewport, live, for the GUI.
 *
 * Starts Blender with its UI (the viewport only exists in a UI session) but
 * with its window pushed off-screen, builds the scene, and streams what its
 * viewport draws (Workbench clay or EEVEE) as raw RGBA frames over a local
 * socket — no video files. The GUI drives it with JSON lines (shot / seek /
 * play / free camera / pick / engine). One session per scene; `stop` (or a
 * new `start`) ends it.
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { readScene, writeScene, normalizeScene, renderScene, renderDir, cleanId, syncLinks, storyboardPath, stripPlan, finishStrip } from './_store.js';
import { stampSources, refreshPrevizFlags } from './_previz-sync.js';
import { channel } from '../../io/channel.js';
import { ensureBlender, builderScriptPath, liveSurfaceLib } from './_blender.js';

const _sessions = new Map(); // "<sceneId>#<slot>" → { proc, port, ctl }

/**
 * The engine's own link to a live session (`ctl`: never a view, never the
 * stage). It asks for timeline filmstrips, which the session draws in its
 * idle moments — a few ms a frame, with the scene already loaded, instead
 * of a separate Blender per strip.
 */
function _ctlLink(s, sceneId) {
  if (s.ctl) return s.ctl;
  const sock = net.createConnection({ host: '127.0.0.1', port: s.port });
  const ctl = { sock, waiting: new Map(), pongAt: Date.now() }; // raw path → { shotId, plan }
  s.ctl = ctl;
  let buf = Buffer.alloc(0);
  sock.on('connect', () => sock.write(JSON.stringify({ cmd: 'ctl' }) + '\n'));
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16) {
      const len = buf.readUInt32LE(12);
      if (buf.length < 16 + len) break;
      const magic = buf.toString('latin1', 0, 4);
      const body = buf.subarray(16, 16 + len);
      buf = buf.subarray(16 + len);
      if (magic !== 'BRXJ') continue;
      let m;
      try { m = JSON.parse(body.toString('utf8')); } catch { continue; }
      if (m.type === 'pong') ctl.pongAt = Date.now();
      if (m.type !== 'strip_done') continue;
      const w = ctl.waiting.get(m.out);
      if (!w) continue;
      ctl.waiting.delete(m.out);
      if (m.skipped) { fs.rmSync(m.out, { force: true }); continue; }
      finishStrip(sceneId, w.shotId, m.out, w.plan)
        .catch((e) => channel.log('scene3d', `strip ${sceneId}/${w.shotId}: ${e.message}`));
    }
  });
  const drop = () => {
    if (s.ctl === ctl) s.ctl = null;
    for (const raw of ctl.waiting.keys()) fs.rmSync(raw, { force: true });
    ctl.waiting.clear();
  };
  sock.on('error', drop);
  sock.on('close', drop);
  return ctl;
}

/**
 * Filmstrips for the shots of a scene that lack one (all of them by
 * default), drawn by its running live session. Each request carries the
 * shot's camera as saved: a session still showing an older version skips
 * it (it is about to restart, and its start asks again). No session: the
 * timeline shows the review sheet until one runs.
 */
export function requestStrips(sceneId, shotIds = null) {
  const id = cleanId(sceneId);
  const s = _sessions.get(`${id}#main`);
  const scene = s && readScene(id);
  if (!scene) return 0;
  const ctl = _ctlLink(s, id);
  const dir = renderDir(id);
  let n = 0;
  for (const sh of scene.shots || []) {
    if (shotIds && !shotIds.includes(sh.id)) continue;
    const plan = stripPlan(scene, sh);
    if (fs.existsSync(plan.strip)) continue;
    const raw = path.join(dir, `.strip-${sh.id}-${plan.hash}.rgba`);
    if (ctl.waiting.has(raw)) continue;
    ctl.waiting.set(raw, { shotId: sh.id, plan });
    ctl.sock.write(JSON.stringify({
      cmd: 'strip', shot: sh.id, out: raw, times: plan.times, w: plan.w, h: plan.h,
      expect: { keyframes: sh.keyframes ?? null, camera: sh.camera ?? null },
    }) + '\n');
    n++;
  }
  return n;
}

function _freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Pool of Blenders. A stopped session's process is PARKED instead of killed,
 * and the next start of any scene takes it over (`load`: the builder runs
 * again in that process on the new scene — no launch, shaders already
 * compiled). At most MAX_BLENDERS processes in all, live + parked.
 */
const MAX_BLENDERS = 3;
const _parked = []; // { proc, port, log }

const _gone = (proc) => proc.exitCode != null || proc.signalCode != null;

/** SIGTERM, then SIGKILL: a frozen Blender does not honour the polite one. */
function _kill(proc) {
  if (_gone(proc)) return;
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => {
    if (_gone(proc)) return;
    channel.log('scene3d', `Blender ${proc.pid} ignored SIGTERM: SIGKILL`);
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
  }, 3000).unref();
}

/** Does this Blender's loop answer? Parked ones are checked before reuse. */
function _ping(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(JSON.stringify({ cmd: 'ping' }) + '\n');
    });
    const done = (ok) => {
      clearTimeout(t);
      sock.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.on('data', () => done(true));
    sock.on('error', () => done(false));
    sock.on('close', () => done(false));
  });
}

/**
 * A live session whose loop stops answering is frozen: no frames, no commands,
 * and its socket stays open, so nothing else notices. Killed here, the views
 * lose the socket, find nobody on the port and start a new Blender.
 */
const PING_EVERY_MS = 10000;
const FROZEN_AFTER_MS = 60000; // a long shader compile is not a freeze
let _watchdog = null;
function _watchSessions() {
  _watchdog ??= setInterval(() => {
    for (const [key, s] of _sessions) {
      if (!s.ready) continue;
      const ctl = _ctlLink(s, key.split('#')[0]);
      if (Date.now() - ctl.pongAt > FROZEN_AFTER_MS) {
        channel.log('scene3d', `live ${key}: frozen (no answer in ${FROZEN_AFTER_MS / 1000} s): killing Blender ${s.proc.pid}`);
        _stop(key, { park: false });
        continue;
      }
      try { ctl.sock.write(JSON.stringify({ cmd: 'ping' }) + '\n'); } catch { /* reconnects next round */ }
    }
  }, PING_EVERY_MS);
  _watchdog.unref();
}

function _stop(sceneId, { park = true } = {}) {
  const s = _sessions.get(sceneId);
  if (!s) return false;
  _sessions.delete(sceneId);
  try { s.ctl?.sock.destroy(); } catch { /* closed */ }
  if (park && s.proc.exitCode == null && !s.proc.killed) {
    _parked.push({ proc: s.proc, port: s.port, log: s.log });
    while (_parked.length && _sessions.size + _parked.length > MAX_BLENDERS) _kill(_parked.shift().proc);
  } else {
    _kill(s.proc);
  }
  return true;
}

function _killNow(proc) {
  try { proc.kill('SIGKILL'); } catch { /* gone */ }
}

process.on('exit', () => {
  // No timers at exit: SIGKILL right away, or a frozen one outlives the app.
  for (const s of _sessions.values()) _killNow(s.proc);
  for (const p of _parked.splice(0)) _killNow(p.proc);
});

/** Wait for a (re)built live session: its "live on" line, or a failure. */
function _waitReady(proc, log, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let buf = '';
    const done = (r) => {
      clearTimeout(t);
      proc.stdout.off('data', on);
      proc.stderr.off('data', on);
      proc.off('exit', onExit);
      resolve(r);
    };
    const t = setTimeout(() => done({ ok: false, log: buf }), timeoutMs);
    const on = (d) => {
      buf += d;
      if (buf.includes('[scene3d] live on')) done({ ok: true });
      else if (buf.includes('Traceback')) done({ ok: false, log: buf });
    };
    const onExit = () => done({ ok: false, log: buf });
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
    proc.on('exit', onExit);
  });
}

/** A parked Blender, rebuilt on [snap]; null when none could take it. */
async function _fromPool(snap) {
  while (_parked.length) {
    const p = _parked.pop(); // the most recent: its shaders are the freshest
    if (_gone(p.proc)) continue;
    if (!await _ping(p.port)) {
      channel.log('scene3d', `pooled Blender ${p.proc.pid} on :${p.port} does not answer: replaced`);
      _kill(p.proc);
      continue;
    }
    // A reload takes well under a second: one that has not answered in 10 s
    // is not coming (a deaf process) — a fresh Blender beats a frozen stage.
    const ready = _waitReady(p.proc, p.log, 10000);
    // `ready` bounds the whole attempt: a process too frozen to take the
    // request must not leave this waiting forever (the GUI's start times out).
    const sock = net.createConnection({ host: '127.0.0.1', port: p.port }, () => {
      sock.end(JSON.stringify({ cmd: 'load', scene: snap, script: builderScriptPath() }) + '\n');
    });
    const refused = new Promise((resolve) => sock.on('error', () => resolve({ ok: false })));
    const r = await Promise.race([ready, refused]);
    sock.destroy();
    if (r.ok) return p;
    channel.log('scene3d', `pooled Blender could not load: ${String(r.log || '').slice(-400)} | before: ${String(p.log?.tail || '').slice(-1500)}`);
    _kill(p.proc);
  }
  return null;
}

/**
 * A new camera from the stage: the shot under the playhead is cut at
 * `atMs` (scene clock) and the rest of it becomes a NEW shot seen from
 * `camera` — the action keeps running once, only the point of view
 * changes. The new shot lasts at least NEW_CAM_MIN_MS: when the rest is
 * shorter, everything after the cut shot (later shots, actions) moves
 * forward by the difference. The storyboard gets the matching card right after the source
 * one, so script, previz and montage stay one thing.
 */
const NEW_CAM_MIN_MS = 2000;

async function _addCamera(params) {
  const id = cleanId(params?.id);
  const existing = id ? readScene(id) : null;
  if (!existing) return { success: false, error: `scene3d_live: no scene "${params?.id}".` };
  const next = JSON.parse(JSON.stringify(existing));
  const sh = (next.shots || []).find((x) => x.id === params.shot);
  if (!sh) return { success: false, error: `scene3d_live: no shot "${params.shot}".` };
  const at = Math.round(Number(params.atMs));
  const start = sh.startMs || 0;
  const end = start + (sh.durationMs || 3000);
  if (!(at >= start + 200 && at <= end)) {
    return { success: false, error: 'scene3d_live: the playhead must be inside the shot (at least 0.2 s after its start).' };
  }
  const cam = params.camera || {};
  const v3 = (p) => (Array.isArray(p) && p.length >= 3 ? p.slice(0, 3).map(Number) : null);
  const position = v3(cam.position), target = v3(cam.target);
  if (!position || !target) return { success: false, error: 'scene3d_live: camera needs position and target.' };
  const lens = Number(cam.lens) || 35;
  const newId = `sh${Date.now().toString(36)}`;
  // The new shot's minimum length: the shots after it watch later moments.
  const grow = Math.max(0, NEW_CAM_MIN_MS - (end - at));
  const resized = new Map(); // storyboard shot id → new durationMs
  sh.durationMs = at - start;
  const shot = {
    id: newId,
    startMs: at,
    durationMs: end - at + grow,
    camera: { lens },
    keyframes: [{ t: 0, position, target, lens }],
  };
  // The storyboard card, right after the source one.
  let sbId = null;
  if (sh.storyboardShotId && next.storyboard?.id) {
    const fp = storyboardPath(next.storyboard.id);
    try {
      const sb = JSON.parse(fs.readFileSync(fp, 'utf8'));
      for (const sc of sb.scenes || []) {
        const i = (sc.shots || []).findIndex((x) => x.id === sh.storyboardShotId);
        if (i < 0) continue;
        const src = sc.shots[i];
        src.duration = Math.round(sh.durationMs / 100) / 10;
        sc.shots.splice(i + 1, 0, {
          id: newId,
          duration: Math.round(shot.durationMs / 100) / 10,
          shot: `${Math.round(lens)}mm`,
          camera: `${Math.round(lens)}mm`,
          action: src.action || '',
          ...(src.continuity ? { continuity: src.continuity } : {}),
        });
        shot.storyboardShotId = newId;
        sbId = sb.id || next.storyboard.id;
        break;
      }
      if (sbId) {
        for (const sc of sb.scenes || []) {
          for (const x of sc.shots || []) {
            if (resized.has(x.id)) x.duration = Math.round(resized.get(x.id) / 100) / 10;
          }
        }
        let n = 0;
        for (const sc of sb.scenes || []) for (const x of sc.shots || []) x.number = ++n;
        const tmp = `${fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(sb, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, fp);
      }
    } catch (e) {
      return { success: false, error: `scene3d_live: storyboard update failed: ${e.message}` };
    }
  }
  next.shots.push(shot);
  let scene;
  try {
    scene = normalizeScene(next, existing);
  } catch (e) {
    return { success: false, error: `scene3d_live: ${e.message}` };
  }
  stampSources(scene, grow ? null : new Set([sh.id, newId]));
  writeScene(scene);
  if (sbId) refreshPrevizFlags(sbId);
  // Posters + montage follow (renderScene re-syncs the story timeline).
  // Moved actions change what every shot sees.
  syncLinks(scene).catch(() => {});
  renderScene(scene, { shotIds: grow ? null : [sh.id, newId] })
    .catch((e) => channel.log('scene3d', `render after new camera ${id}: ${e.message}`));
  return { success: true, shotId: newId, pushedMs: grow };
}

export default {
  type: 'scene3d_live',
  intent: 'scene3d_live',
  description: 'Internal (GUI live 3D viewer): start / stop the live Blender viewport session of a scene. start → { port }.',
  thinkingHint: 'Opening live Blender viewport',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['start', 'stop', 'add_camera'] },
      shot: { type: 'string', description: 'add_camera: the shot to cut' },
      atMs: { type: 'number', description: 'add_camera: scene-clock time of the cut' },
      camera: { type: 'object', description: 'add_camera: { position, target, lens } of the new camera' },
      id: { type: 'string', description: 'Scene id' },
      slot: { type: 'string', description: 'Independent session of the same scene ("main" = timeline stage + preview, "viewer" = the popup viewer)' },
    },
    required: ['op', 'id'],
  },

  async execute(params) {
    const id = cleanId(params?.id);
    const key = `${id}#${String(params?.slot || 'main').replace(/[^\w-]/g, '')}`;
    if (params?.op === 'stop') return { success: true, stopped: _stop(key) };
    if (params?.op === 'add_camera') return _addCamera(params);
    const scene = readScene(id);
    if (!scene) return { success: false, error: `scene3d_live: no scene "${params?.id}".` };
    _stop(key); // a fresh start always reflects the scene as saved now (its Blender is reused)
    // Timelines made before live 3D still point at pre-rendered proxies:
    // repoint them to the live shot (cheap, idempotent).
    syncLinks(scene).catch(() => {});
    const { bin } = await ensureBlender();
    const surfaceLib = liveSurfaceLib();
    const dir = renderDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const snap = path.join(dir, `.snapshot-live-${process.pid}-${key.split("#")[1]}.json`);
    fs.writeFileSync(snap, JSON.stringify(scene), 'utf8');
    const reused = await _fromPool(snap);
    if (reused) {
      channel.log('scene3d', `live ${key}: reused a pooled Blender`);
      _sessions.set(key, { proc: reused.proc, port: reused.port, log: reused.log });
      return _started(key, id, scene, reused.port, surfaceLib);
    }
    const port = await _freePort();
    const proc = spawn(bin, [
      '--factory-startup', '--no-window-focus', '--window-geometry', '-4000', '-4000', '48', '48', '-noaudio',
      '-P', builderScriptPath(), '--', '--scene', snap, '--live', String(port),
      // Frames through shared memory (IOSurface) when the native lib exists.
      ...(surfaceLib ? ['--surface-lib', surfaceLib] : []),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = { tail: '' };
    _sessions.set(key, { proc, port, log });
    proc.on('exit', (code, signal) => {
      channel.log('scene3d', `live :${port}: Blender exited (code ${code}, signal ${signal}): ${log.tail.slice(-400)}`);
      for (const [k, s] of _sessions) if (s.proc === proc) _sessions.delete(k);
      const i = _parked.findIndex((p) => p.proc === proc);
      if (i >= 0) _parked.splice(i, 1);
    });
    // Keep the pipes drained for the whole life of the process (a pooled
    // Blender keeps printing; a full pipe would block it).
    // The last output stays on hand (a pooled reload that fails says why),
    // and an error inside the live loop goes to the log as it happens.
    const keep = (d) => {
      log.tail = (log.tail + d).slice(-4000);
      if (String(d).includes('[scene3d] tick error')) channel.log('scene3d', `live ${port}: ${String(d).slice(-1500)}`);
    };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    const ready = await _waitReady(proc, log);
    if (!ready.ok) {
      _stop(key, { park: false });
      return { success: false, error: `scene3d_live: Blender did not start: ${String(ready.log || '').slice(-800)}` };
    }
    return _started(key, id, scene, port, surfaceLib);
  },
};

function _started(key, id, scene, port, surfaceLib) {
  const session = _sessions.get(key);
  if (session) session.ready = true;
  _watchSessions();
  // Shots without a filmstrip (new, edited, or from before it existed):
  // this session draws them when idle.
  if (key.endsWith('#main')) requestStrips(id);
  return {
    success: true,
    port,
    shots: scene.shots.map((s) => ({ id: s.id, name: s.name, storyboardShotId: s.storyboardShotId, durationMs: s.durationMs })),
    characters: (scene.characters || []).map((c) => ({ id: c.id, name: c.name, characterId: c.characterId })),
    aspect: (scene.resolution?.width || 16) / (scene.resolution?.height || 9),
    surface: !!surfaceLib,
  };
}
