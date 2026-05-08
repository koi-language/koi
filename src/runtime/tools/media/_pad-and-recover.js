/**
 * Pad / recover helpers for media that's too small for the picked
 * provider's minimum input dimensions.
 *
 * Why this exists: the agent's reference inputs (videos, images) often
 * come from the GUI's clip cropper, which honours the AI clip's exact
 * canvas rect — and that rect can land at, say, 474×800 off a 720p
 * source when the user only wants to operate on a small region. Most
 * generation providers (Kling, Veo, Seedance, …) reject inputs whose
 * smaller side is below 720; some require 1080. Rescaling the user's
 * pixels to satisfy the provider would change the very content the
 * model is meant to operate on — visible drift, off-by-one halos
 * around the recovered area, etc.
 *
 * The pattern below pads the input with solid black to reach the
 * provider's envelope, BIT-FOR-BIT preserving the original pixels,
 * sends the padded asset, and crops the model's output back to the
 * original content rect post-generation. The model sees content +
 * uniform black borders; diffusion-class models preserve the spatial
 * layout, so the crop-back yields the original content area exactly.
 *
 * The whole dance is internal to the generation tool — `generate_video`
 * uses these helpers transparently; `assign_generated_media_to_clip`
 * and the GUI never see padded media on either side of the call.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';

import { ensureFfmpeg } from '../../media/ffmpeg-installer.js';
import { channel } from '../../io/channel.js';

/** Minimum smaller-side the padded asset will have. 1080 covers every
 *  active model in the catalog (Kling 720, Veo 720/1080, Seedance
 *  480-1080, Wan 720-1080, OmniHuman 720-1080) without ballooning
 *  payload size for the common 480p/720p source case. */
const DEFAULT_MIN_SIDE = 1080;

/**
 * Probe a media file's pixel dimensions via ffprobe. Returns `{ width,
 * height }` or null on failure (no ffprobe, unreadable file, etc.).
 */
async function _probeDimensions(filePath) {
  let bins;
  try {
    bins = await ensureFfmpeg();
  } catch (err) {
    channel.log('pad', `ensureFfmpeg failed: ${err.message}`);
    return null;
  }
  if (!bins?.ffprobe) return null;
  return await new Promise((resolve) => {
    const proc = spawn(bins.ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      filePath,
    ]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        channel.log('pad', `ffprobe ${filePath} exit=${code}: ${err.trim().slice(0, 200)}`);
        return resolve(null);
      }
      const m = out.trim().match(/^(\d+),(\d+)/);
      if (!m) return resolve(null);
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      if (!w || !h) return resolve(null);
      resolve({ width: w, height: h });
    });
    proc.on('error', () => resolve(null));
  });
}

function _hash(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function _ensureTmpDir() {
  const dir = path.join(os.tmpdir(), 'koi-padref');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _runFfmpeg(bins, args) {
  return new Promise((resolve) => {
    const proc = spawn(bins.ffmpeg, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', (code) => {
      if (code !== 0) {
        channel.log('pad', `ffmpeg exit=${code}: ${err.trim().slice(-400)}`);
      }
      resolve(code === 0);
    });
    proc.on('error', (e) => {
      channel.log('pad', `ffmpeg spawn failed: ${e.message}`);
      resolve(false);
    });
  });
}

/**
 * Compute the padded envelope for an `(inWidth, inHeight)` source.
 * Returns the recovery rect describing the original content's
 * position inside the padded canvas — used to crop borders off the
 * model's output later.
 */
export function computePadGeometry(inWidth, inHeight, minSide = DEFAULT_MIN_SIDE) {
  if (!inWidth || !inHeight) return null;
  // Even-aligned envelope so h264 / yuv420p don't choke on odd dims.
  let paddedW = inWidth < minSide ? minSide : inWidth;
  let paddedH = inHeight < minSide ? minSide : inHeight;
  if (paddedW % 2 !== 0) paddedW += 1;
  if (paddedH % 2 !== 0) paddedH += 1;
  // Even content dims — the recovery crop runs in the padded space and
  // h264 still cares there.
  let contentW = inWidth - (inWidth % 2);
  let contentH = inHeight - (inHeight % 2);
  if (contentW <= 0 || contentH <= 0) return null;
  let padX = Math.floor((paddedW - contentW) / 2);
  let padY = Math.floor((paddedH - contentH) / 2);
  if (padX % 2 !== 0) padX -= 1;
  if (padY % 2 !== 0) padY -= 1;
  if (padX < 0) padX = 0;
  if (padY < 0) padY = 0;
  return {
    contentW,
    contentH,
    paddedW,
    paddedH,
    padX,
    padY,
    needsPadding: paddedW !== contentW || paddedH !== contentH,
  };
}

/**
 * If [filePath] is a video / image whose smaller side is below
 * [minSide], pad it with solid black up to that envelope and return
 * `{ paddedPath, geometry }`. Otherwise return `{ paddedPath: null,
 * geometry }` (no work needed; caller keeps using the original path).
 *
 * Outputs land under `$TMPDIR/koi-padref/` keyed on a content hash
 * (path + mtime + minSide) so repeated calls in the same session
 * reuse the encode.
 */
export async function padIfNeeded(filePath, kind, minSide = DEFAULT_MIN_SIDE) {
  if (!filePath || typeof filePath !== 'string') {
    return { paddedPath: null, geometry: null };
  }
  if (!fs.existsSync(filePath)) {
    return { paddedPath: null, geometry: null };
  }
  if (kind !== 'video' && kind !== 'image') {
    return { paddedPath: null, geometry: null };
  }
  const dims = await _probeDimensions(filePath);
  if (!dims) return { paddedPath: null, geometry: null };
  const geom = computePadGeometry(dims.width, dims.height, minSide);
  if (!geom || !geom.needsPadding) {
    return { paddedPath: null, geometry: geom };
  }
  let bins;
  try {
    bins = await ensureFfmpeg();
  } catch (err) {
    channel.log('pad', `ensureFfmpeg failed: ${err.message}`);
    return { paddedPath: null, geometry: null };
  }
  if (!bins?.ffmpeg) return { paddedPath: null, geometry: null };
  const dir = _ensureTmpDir();
  const stat = fs.statSync(filePath);
  const key = _hash([
    filePath,
    String(stat.size),
    String(stat.mtimeMs | 0),
    String(minSide),
  ]);
  const ext = kind === 'video' ? 'mp4' : 'png';
  const out = path.join(dir, `${key}.padded.${ext}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    return { paddedPath: out, geometry: geom };
  }
  const padFilter =
    `pad=${geom.paddedW}:${geom.paddedH}:${geom.padX}:${geom.padY}:color=black`;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vf', padFilter];
  if (kind === 'video') {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
    );
  }
  args.push('-y', out);
  const ok = await _runFfmpeg(bins, args);
  if (!ok) return { paddedPath: null, geometry: null };
  channel.log(
    'pad',
    `padded ${path.basename(filePath)} ` +
    `${dims.width}×${dims.height} → ${geom.paddedW}×${geom.paddedH} ` +
    `(content @ ${geom.padX},${geom.padY})`,
  );
  return { paddedPath: out, geometry: geom };
}

/**
 * Crop the black borders off [filePath] using [geometry] (the same
 * `_CropGeometry` the padding step produced). Returns the new file's
 * absolute path on success. If the geometry indicates no padding was
 * applied (`needsPadding === false`), passes through and returns
 * [filePath] unchanged. Caller can replace the original with the
 * recovered file (the tool typically does this so downstream code
 * doesn't have to track which path is which).
 */
export async function recoverFromPadded(filePath, geometry, kind) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (!fs.existsSync(filePath)) return null;
  if (!geometry || !geometry.needsPadding) return filePath;
  if (kind !== 'video' && kind !== 'image') return filePath;
  let bins;
  try {
    bins = await ensureFfmpeg();
  } catch (err) {
    channel.log('pad', `ensureFfmpeg failed: ${err.message}`);
    return null;
  }
  if (!bins?.ffmpeg) return null;
  // Cache the recovery output beside the source: same name with
  // `.unpadded.<ext>` suffix. Lets repeated probes (e.g. retries) reuse.
  const ext = kind === 'video' ? 'mp4' : 'png';
  const baseDir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const out = path.join(baseDir, `${stem}.unpadded.${ext}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const cropFilter =
    `crop=${geometry.contentW}:${geometry.contentH}:${geometry.padX}:${geometry.padY}`;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vf', cropFilter];
  if (kind === 'video') {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
    );
  }
  args.push('-y', out);
  const ok = await _runFfmpeg(bins, args);
  if (!ok) return null;
  channel.log(
    'pad',
    `recovered ${path.basename(filePath)} → ${path.basename(out)} ` +
    `(crop ${geometry.contentW}×${geometry.contentH} @ ${geometry.padX},${geometry.padY})`,
  );
  return out;
}
