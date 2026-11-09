/**
 * Photo check: the set seen from the camera each reference photo was taken
 * from, next to the photo and blended over it — [photo | 3D | blend]. The
 * agent reads it to lay the set out ON the photo (walls, door, window,
 * furniture outline over outline) instead of from a text description.
 * `set.photoCams: [{ image, camera: { position, target, lens } }]`, scene frame.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { runBuilder } from './_blender.js';
import { renderDir } from './_store.js';

async function _bins() {
  try {
    const r = await (await import('../../media/ffmpeg-installer.js')).ensureFfmpeg();
    return { ffmpeg: r?.ffmpeg || 'ffmpeg', ffprobe: r?.ffprobe || 'ffprobe' };
  } catch {
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  }
}

function _run(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ code: -1, out }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const _vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** The scene's usable photo cameras. */
export function photoCams(scene) {
  const cams = Array.isArray(scene?.set?.photoCams) ? scene.set.photoCams : [];
  return cams.filter((c) => c && typeof c.image === 'string' && fs.existsSync(c.image)
    && _vec3(c.camera?.position) && _vec3(c.camera?.target));
}

/** [{ index, image, compare }] — cached per set state + camera. */
export async function photoCheck(scene, { style = 'lit' } = {}) {
  const cams = photoCams(scene);
  if (!cams.length) return [];
  const { ffmpeg, ffprobe } = await _bins();
  const dir = renderDir(scene.id);
  fs.mkdirSync(dir, { recursive: true });
  // What the photo views see: the set and the light, never the cast.
  const world = { set: scene.set, lighting: scene.lighting, style, aspect: scene.aspect, fps: scene.fps };
  const out = [];
  for (const [i, c] of cams.entries()) {
    const probe = await _run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x', c.image]);
    const [pw, ph] = (/(\d+)x(\d+)/.exec(probe.out) || []).slice(1).map(Number);
    const W = 960;
    const H = pw && ph ? Math.max(2, Math.round((W * ph) / pw / 2) * 2) : 540;
    const key = crypto.createHash('sha1')
      .update(JSON.stringify([world, c.camera, c.image, fs.statSync(c.image).mtimeMs, W, H])).digest('hex').slice(0, 12);
    const compare = path.join(dir, `photo-${i}-${key}.png`);
    if (!fs.existsSync(compare)) {
      const render = path.join(dir, `.photo-${i}-${key}-3d.png`);
      const snap = path.join(dir, `.snapshot-photo-${process.pid}-${key}.json`);
      const tmp = {
        ...scene, characters: [], actions: [], durationMs: 1000,
        shots: [{ id: '__photo', durationMs: 1000, startMs: 0, move: { type: 'static' },
          camera: { position: c.camera.position, target: c.camera.target, lens: Number(c.camera.lens) || 35 } }],
      };
      fs.writeFileSync(snap, JSON.stringify(tmp), 'utf8');
      try {
        await runBuilder(['--scene', snap, '--shot', '__photo', '--out', render, '--still', '0',
          '--style', style, '--samples', '16', '--width', String(W), '--height', String(H)]);
      } finally {
        fs.rmSync(snap, { force: true });
      }
      const r = await _run(ffmpeg, ['-y', '-v', 'error', '-i', c.image, '-i', render, '-filter_complex',
        `[0:v]scale=${W}:${H},format=gbrp,split[p0][p1];[1:v]scale=${W}:${H},format=gbrp,split[r0][r1];`
        + '[p1][r1]blend=all_mode=average[b];[p0][r0][b]hstack=inputs=3', '-frames:v', '1', compare]);
      fs.rmSync(render, { force: true });
      if (r.code !== 0 || !fs.existsSync(compare)) throw new Error(`photo check compose failed: ${r.out.slice(-300)}`);
    }
    out.push({ index: i, image: c.image, compare });
  }
  return out;
}

/** Adds the photo checks to a tool result's review (images + how to read them). */
export async function withPhotoCheck(scene, result) {
  if (!scene || !photoCams(scene).length) return result;
  try {
    const checks = await photoCheck(scene);
    return {
      ...result,
      photoChecks: checks,
      _reviewImages: [...checks.map((c) => c.compare), ...(result._reviewImages || [])],
      photoCheckNote: 'FIRST look at each photo check: [reference photo | the set from that photo\'s camera | both blended]. '
        + 'In the blend the set must sit ON the photo: walls and corners on the photo\'s corners, the door / window on their '
        + 'openings, every piece of furniture outline over outline, same colours. If everything is off the same way, fix the '
        + 'photo camera (set.photoCams); if one thing is off, move / resize it. Fix with update_scene3d until it matches.',
    };
  } catch (e) {
    return { ...result, photoCheckError: e.message };
  }
}
