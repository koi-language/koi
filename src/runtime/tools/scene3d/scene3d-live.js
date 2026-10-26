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
import { readScene, writeScene, normalizeScene, renderScene, renderDir, cleanId, syncLinks, storyboardPath } from './_store.js';
import { stampSources, refreshPrevizFlags } from './_previz-sync.js';
import { channel } from '../../io/channel.js';
import { ensureBlender, builderScriptPath, liveSurfaceLib } from './_blender.js';

const _sessions = new Map(); // "<sceneId>#<slot>" → { proc, port }

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

function _stop(sceneId) {
  const s = _sessions.get(sceneId);
  if (!s) return false;
  try { s.proc.kill('SIGTERM'); } catch { /* gone */ }
  _sessions.delete(sceneId);
  return true;
}

process.on('exit', () => { for (const id of [..._sessions.keys()]) _stop(id); });

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
  // Room for the new shot: push what comes after the cut shot forward.
  const grow = Math.max(0, NEW_CAM_MIN_MS - (end - at));
  const resized = new Map(); // storyboard shot id → new durationMs
  if (grow) {
    for (const x of next.shots || []) {
      if (x === sh) continue;
      const xs = x.startMs || 0, xe = xs + (x.durationMs || 3000);
      if (xs >= end) x.startMs = xs + grow;
      else if (xe > end) {
        x.durationMs = xe - xs + grow; // coverage running across the cut
        if (x.storyboardShotId) resized.set(x.storyboardShotId, x.durationMs);
      }
    }
    for (const a of next.actions || []) {
      if (typeof a.startMs === 'number' && a.startMs >= end) a.startMs += grow;
      if (typeof a.endMs === 'number' && a.endMs > end) a.endMs += grow;
    }
  }
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
    _stop(key); // a fresh start always reflects the scene as saved now
    // Timelines made before live 3D still point at pre-rendered proxies:
    // repoint them to the live shot (cheap, idempotent).
    syncLinks(scene).catch(() => {});
    const { bin } = await ensureBlender();
    const port = await _freePort();
    const surfaceLib = liveSurfaceLib();
    const dir = renderDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const snap = path.join(dir, `.snapshot-live-${process.pid}-${key.split("#")[1]}.json`);
    fs.writeFileSync(snap, JSON.stringify(scene), 'utf8');
    const proc = spawn(bin, [
      '--factory-startup', '--no-window-focus', '--window-geometry', '-4000', '-4000', '48', '48', '-noaudio',
      '-P', builderScriptPath(), '--', '--scene', snap, '--live', String(port),
      // Frames through shared memory (IOSurface) when the native lib exists.
      ...(surfaceLib ? ['--surface-lib', surfaceLib] : []),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    _sessions.set(key, { proc, port });
    proc.on('exit', () => { if (_sessions.get(key)?.proc === proc) _sessions.delete(key); });
    const ready = await new Promise((resolve) => {
      let log = '';
      const t = setTimeout(() => resolve({ ok: false, log }), 60000);
      const on = (d) => {
        log += d;
        if (log.includes('[scene3d] live on')) { clearTimeout(t); resolve({ ok: true }); }
        else if (log.includes('Traceback')) { clearTimeout(t); resolve({ ok: false, log }); }
      };
      proc.stdout.on('data', on);
      proc.stderr.on('data', on);
      proc.on('exit', () => { clearTimeout(t); resolve({ ok: false, log }); });
    });
    if (!ready.ok) {
      _stop(key);
      return { success: false, error: `scene3d_live: Blender did not start: ${String(ready.log || '').slice(-800)}` };
    }
    return {
      success: true,
      port,
      shots: scene.shots.map((s) => ({ id: s.id, name: s.name, storyboardShotId: s.storyboardShotId, durationMs: s.durationMs })),
      characters: (scene.characters || []).map((c) => ({ id: c.id, name: c.name, characterId: c.characterId })),
      aspect: (scene.resolution?.width || 16) / (scene.resolution?.height || 9),
      surface: !!surfaceLib,
    };
  },
};
