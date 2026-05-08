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
 * Resolve `{ ffmpeg, ffprobe? }` paths. Tries env-var overrides first
 * (the Flutter GUI exports `KOI_FFMPEG_PATH` / `KOI_FFPROBE_PATH` when
 * it spawns koi-cli — its bundled static builds are far more reliable
 * than `which` on a Homebrew machine), then falls through to
 * `ensureFfmpeg()`'s auto-installer.
 *
 * `ffprobe` is OPTIONAL: when missing we use ffmpeg itself as the
 * probe (parsing `Stream #0:0 ... 1920x1080` out of stderr). The
 * Flutter app currently bundles ffmpeg only — bundling ffprobe too
 * would double the resource footprint without buying us much, since
 * ffmpeg's stderr already carries every dimension we need.
 */
async function _resolveFfmpeg() {
  const envFf = process.env.KOI_FFMPEG_PATH;
  const envFp = process.env.KOI_FFPROBE_PATH;
  // Both env vars present and pointing at real files → straight pass.
  if (envFf && envFp && fs.existsSync(envFf) && fs.existsSync(envFp)) {
    return { ffmpeg: envFf, ffprobe: envFp };
  }
  // Only ffmpeg is available — use it for both encode and probe paths.
  if (envFf && fs.existsSync(envFf)) {
    return { ffmpeg: envFf, ffprobe: null };
  }
  try {
    return await ensureFfmpeg();
  } catch (err) {
    channel.log('pad', `ensureFfmpeg failed: ${err.message}`);
    return null;
  }
}

function _parseDimsFromFfmpegStderr(stderr) {
  // ffmpeg's stderr summary lines look like
  //   "Stream #0:0[0x1](und): Video: h264 (...) 812x456, 30 fps, ..."
  // The first such match per file is always the primary video track.
  const m = stderr.match(/Stream #\d+:\d+(?:[^\n]*?Video:[^\n]*?)\b(\d{2,5})x(\d{2,5})\b/);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return null;
  return { width: w, height: h };
}

/**
 * Probe a media file's duration in milliseconds. Used by `padIfNeeded`
 * to record the canonical duration of the cropper's reference media,
 * which the recovery step then forces back onto the model's output —
 * some video providers emit a frame or two longer than the input
 * (Kling video edit was observed adding 40 ms = 1 frame at 25 fps),
 * which produces a visible temporal drift between the AI clip and
 * the underlying source on the timeline.
 */
async function _probeDurationMs(filePath) {
  const bins = await _resolveFfmpeg();
  if (!bins?.ffmpeg) return null;
  if (bins.ffprobe) {
    const dur = await new Promise((resolve) => {
      const proc = spawn(bins.ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath,
      ]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => {
        const seconds = parseFloat(out.trim());
        if (!Number.isFinite(seconds) || seconds <= 0) return resolve(null);
        resolve(Math.round(seconds * 1000));
      });
      proc.on('error', () => resolve(null));
    });
    if (dur != null) return dur;
  }
  return await new Promise((resolve) => {
    const proc = spawn(bins.ffmpeg, [
      '-hide_banner', '-i', filePath, '-f', 'null', '-',
    ]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', () => {
      // ffmpeg duration line: "  Duration: 00:00:03.00, start: ..."
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(null);
      const h = parseInt(m[1], 10);
      const mn = parseInt(m[2], 10);
      const s = parseFloat(m[3]);
      if (!Number.isFinite(h) || !Number.isFinite(mn) || !Number.isFinite(s)) return resolve(null);
      resolve(Math.round(((h * 3600) + (mn * 60) + s) * 1000));
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Probe a media file's pixel dimensions via ffprobe (preferred) or
 * ffmpeg's stderr (fallback). Returns `{ width, height }` or null on
 * failure.
 */
async function _probeDimensions(filePath) {
  const bins = await _resolveFfmpeg();
  if (!bins?.ffmpeg) {
    channel.log('pad', `no ffmpeg/ffprobe available — cannot probe ${filePath}`);
    return null;
  }
  if (bins.ffprobe) {
    const dims = await new Promise((resolve) => {
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
    if (dims) return dims;
    // Fall through to ffmpeg if ffprobe failed for some reason.
  }
  // ffmpeg-as-probe: `-f null -` consumes input without producing output,
  // and ffmpeg dumps a summary to stderr that includes the WIDTHxHEIGHT
  // string. Cheap (no transcoding) and reliable across formats. Parse
  // the FIRST `Stream #...: Video:` line — secondary streams (audio,
  // subtitles, attachments) don't carry the dimensions we want.
  return await new Promise((resolve) => {
    const proc = spawn(bins.ffmpeg, [
      '-hide_banner',
      '-i', filePath,
      '-f', 'null',
      '-frames:v', '1',
      '-',
    ]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', () => {
      // ffmpeg returns 0 on success, but `-f null -` with `-frames:v 1`
      // can also exit non-zero on some builds — the dimensions are in
      // stderr regardless, so we look there before checking the code.
      const dims = _parseDimsFromFfmpegStderr(err);
      if (dims) return resolve(dims);
      channel.log('pad', `ffmpeg-probe ${filePath} could not extract dims; stderr=${err.trim().slice(0, 200)}`);
      resolve(null);
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
 *
 * Two modes, picked by the [opts] argument:
 *
 * - `targetWidth` + `targetHeight`: pad to EXACTLY those dimensions.
 *   This is what we use when the caller knows the provider's output
 *   aspect (e.g. 720p + 16:9 → 1280×720). The recovery crop reads
 *   the provider's output at the SAME dimensions we sent, so the
 *   content position carries through bit-for-bit. Without this the
 *   provider rescales / re-crops to its own native canvas (Kling
 *   normalises to 1280×720 even when fed a 1080×1080 padded input)
 *   and the recovery rect ends up reading from a region of the
 *   output that's mostly black + corner of content. Hard fix:
 *   match the provider's output aspect at submit time.
 *
 * - `minSide`: pad just enough to clear that minimum on both axes.
 *   Square-ish envelope kept for legacy callers that don't know
 *   the provider's output dims; not great for video models — use
 *   the target-dim path whenever possible.
 */
export function computePadGeometry(inWidth, inHeight, opts = {}) {
  if (!inWidth || !inHeight) return null;
  // Decide the final envelope.
  let paddedW;
  let paddedH;
  if (Number.isFinite(opts.targetWidth) && Number.isFinite(opts.targetHeight)
      && opts.targetWidth > 0 && opts.targetHeight > 0) {
    // Cap by the source's own dims if it's already bigger — we only ever
    // pad up, never down.
    paddedW = Math.max(opts.targetWidth, inWidth);
    paddedH = Math.max(opts.targetHeight, inHeight);
  } else {
    const minSide = Number.isFinite(opts.minSide) && opts.minSide > 0
      ? opts.minSide
      : DEFAULT_MIN_SIDE;
    paddedW = inWidth < minSide ? minSide : inWidth;
    paddedH = inHeight < minSide ? minSide : inHeight;
  }
  // Even alignment so h264 / yuv420p don't choke on odd dims, and the
  // pad math stays integer (otherwise the recovery crop drifts by a
  // pixel and we get one-pixel halos around the content).
  if (paddedW % 2 !== 0) paddedW += 1;
  if (paddedH % 2 !== 0) paddedH += 1;
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
 * Pick the resolution + aspect from a provider's catalog that
 * **envelopes** the source content with the LEAST padding waste,
 * without ever rescaling the source pixels. Used by `generate_video`
 * so the request we send to the model:
 *
 *   1. Pads to dimensions the model NATIVELY supports as output
 *      (e.g. one of `caps.resolutions × caps.aspectRatios`), and
 *   2. Asks the model to emit at EXACTLY that resolution + aspect.
 *
 * That guarantees `input dim == output dim` per the user's
 * "darle una resolucion y pedirle la salida EN LA MISMA RESOLUCION"
 * rule — the recovery crop reads back the same coordinate space we
 * drew, no scaling guesswork.
 *
 * Returns `{ resolution, aspectRatio, w, h }` or null when no
 * envelope is feasible (catalog empty, content bigger than every
 * candidate, etc.). When `caps.aspectRatios` is empty the input's
 * own aspect is used (model doesn't restrict aspect).
 */
export function pickEnvelopeResolution({
  contentWidth,
  contentHeight,
  resolutions,
  aspectRatios,
}) {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)) return null;
  if (contentWidth <= 0 || contentHeight <= 0) return null;
  if (!Array.isArray(resolutions) || resolutions.length === 0) return null;
  const resList = resolutions;
  // When the model doesn't publish accepted aspects, treat the source's
  // own aspect as the only candidate — no padding bias either way.
  const inputAspect = contentWidth / contentHeight;
  const aspList = Array.isArray(aspectRatios) && aspectRatios.length > 0
    ? aspectRatios
    : [`${Math.round(inputAspect * 100)}:100`];
  // Two-tier ranking: aspect match dominates, padding area breaks ties.
  // Without this a 16:9 source ends up packed into a 4:3 envelope just
  // because its raw area is smaller — the visible bars then spill across
  // both dimensions instead of just two edges, and the model wastes
  // generation effort on the side bars instead of the actual scene.
  let best = null;
  for (const res of resList) {
    for (const asp of aspList) {
      const dims = targetDimsForResolutionAspect(res, asp);
      if (!dims) continue;
      // Strict envelope: every dimension must be ≥ source content.
      if (dims.w < contentWidth || dims.h < contentHeight) continue;
      const candAspect = dims.w / dims.h;
      const aspectDelta = Math.abs(candAspect - inputAspect) / inputAspect;
      const padArea = dims.w * dims.h - contentWidth * contentHeight;
      if (best == null
          || aspectDelta < best.aspectDelta - 1e-6
          || (Math.abs(aspectDelta - best.aspectDelta) < 1e-6 && padArea < best.padArea)) {
        best = {
          resolution: res,
          aspectRatio: asp,
          w: dims.w,
          h: dims.h,
          aspectDelta,
          padArea,
        };
      }
    }
  }
  if (!best) return null;
  return {
    resolution: best.resolution,
    aspectRatio: best.aspectRatio,
    w: best.w,
    h: best.h,
  };
}

/** Map (resolution, aspectRatio) → output (w, h). Picks ffmpeg-friendly
 *  dimensions that match what the major video providers emit at the
 *  given combo. Returns null when either piece is missing or unparseable
 *  so the caller can fall back to the legacy minSide envelope. */
export function targetDimsForResolutionAspect(resolution, aspectRatio) {
  if (typeof resolution !== 'string' || typeof aspectRatio !== 'string') return null;
  const m = aspectRatio.match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  const aw = parseInt(m[1], 10);
  const ah = parseInt(m[2], 10);
  if (!aw || !ah) return null;
  // Resolution → "short side" (the smaller of the two output dims). 480p
  // is special-cased because providers historically emit 854×480 not
  // 640×480 for 16:9 — sticking to the short-side rule keeps every
  // aspect on a single rule.
  let shortSide;
  switch (resolution.toLowerCase()) {
    case '480p': shortSide = 480; break;
    case '720p': shortSide = 720; break;
    case '1080p': shortSide = 1080; break;
    case '4k': case '2160p': shortSide = 2160; break;
    default: return null;
  }
  // Wider aspect → height is the short side; portrait → width is.
  let w, h;
  if (aw >= ah) {
    h = shortSide;
    w = Math.round(shortSide * aw / ah);
  } else {
    w = shortSide;
    h = Math.round(shortSide * ah / aw);
  }
  if (w % 2 !== 0) w += 1;
  if (h % 2 !== 0) h += 1;
  return { w, h };
}

/**
 * Pad [filePath] to a target envelope so it satisfies the provider's
 * input dimension rules. Two modes:
 *
 *   - `targetDims: { w, h }` — pad to EXACTLY those output dimensions
 *     (recommended for video providers: matches what they'll emit, so
 *     the recovery crop reads the same coordinate space we sent in).
 *   - `minSide: N` — pad just enough to clear N on both axes (legacy /
 *     when output dims are unknown).
 *
 * For videos, an OPTIONAL temporal pad: when `minDurationMs` is set
 * and the source is shorter, append black frames at the end (via
 * ffmpeg's `tpad` filter) to reach the minimum. Some providers
 * reject inputs below a hard duration floor (Kling video-to-video
 * edit observed: 3.0 s minimum vs. our 2.958 s cropper output).
 * Recovery already trims back to `geometry.inputDurMs` so the
 * black tail is invisible end-to-end — same pattern as the
 * spatial pad → submit → recover dance.
 *
 * Outputs land under `$TMPDIR/koi-padref/` keyed on a content hash
 * (path + mtime + envelope) so repeated calls in the same session
 * reuse the encode.
 *
 * @param {string} filePath
 * @param {'video'|'image'} kind
 * @param {{ targetDims?: { w: number, h: number }, minSide?: number, minDurationMs?: number }} [opts]
 * @returns {Promise<{ paddedPath: string|null, geometry: object|null }>}
 */
export async function padIfNeeded(filePath, kind, opts = {}) {
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
  if (!dims) {
    channel.log('pad', `padIfNeeded: probe failed for ${filePath} — passing through unchanged`);
    return { paddedPath: null, geometry: null };
  }
  // Build the geometry: prefer explicit target dims (matches provider
  // output), fall back to a min-side envelope when the caller doesn't
  // know what the provider will emit.
  const geomOpts = {};
  if (opts.targetDims && Number.isFinite(opts.targetDims.w)
      && Number.isFinite(opts.targetDims.h)) {
    geomOpts.targetWidth = opts.targetDims.w;
    geomOpts.targetHeight = opts.targetDims.h;
  }
  if (Number.isFinite(opts.minSide) && opts.minSide > 0) {
    geomOpts.minSide = opts.minSide;
  }
  const geom = computePadGeometry(dims.width, dims.height, geomOpts);
  if (!geom) return { paddedPath: null, geometry: null };
  // Probe duration for video inputs and bake it into the geometry.
  // Recovery uses this to cap the model's output to the SAME number
  // of milliseconds — Kling video edit (and similar) sometimes
  // emit a frame longer than the input (e.g. 3.04 s vs 3.00 s),
  // which produces a visible temporal drift between the AI clip
  // and the underlying source on the timeline. Capping at recovery
  // realigns the clip to the original content window.
  if (kind === 'video') {
    const inputDurMs = await _probeDurationMs(filePath);
    if (Number.isFinite(inputDurMs) && inputDurMs > 0) {
      geom.inputDurMs = inputDurMs;
    }
  }
  // Decide if we also need to pad the video TEMPORALLY (append black
  // frames at the end) to clear a provider minimum. Same idea as the
  // spatial pad: recovery (`-t inputDurMs/1000`) trims the tail off
  // the model's output, so the user never sees the black filler.
  let tailPadMs = 0;
  let targetDurMs = null;
  if (kind === 'video'
      && Number.isFinite(opts.minDurationMs) && opts.minDurationMs > 0
      && Number.isFinite(geom.inputDurMs) && geom.inputDurMs > 0
      && geom.inputDurMs < opts.minDurationMs) {
    tailPadMs = opts.minDurationMs - geom.inputDurMs;
    targetDurMs = opts.minDurationMs;
    geom.tailPadMs = tailPadMs;
    geom.targetDurMs = targetDurMs;
    geom.needsTemporalPad = true;
    geom.needsPadding = true; // force a re-encode pass
  }
  const envelopeLabel = geomOpts.targetWidth
    ? `target ${geomOpts.targetWidth}×${geomOpts.targetHeight}`
    : `minSide ${geomOpts.minSide || DEFAULT_MIN_SIDE}`;
  if (!geom.needsPadding) {
    channel.log('pad', `padIfNeeded: ${path.basename(filePath)} is ${dims.width}×${dims.height} (>= ${envelopeLabel}) — no padding needed`);
    return { paddedPath: null, geometry: geom };
  }
  const tempLabel = geom.needsTemporalPad
    ? `, +${(tailPadMs / 1000).toFixed(3)}s tail (target ${(targetDurMs / 1000).toFixed(3)}s)`
    : '';
  channel.log('pad', `padIfNeeded: ${path.basename(filePath)} is ${dims.width}×${dims.height} — padding to ${geom.paddedW}×${geom.paddedH} (${envelopeLabel})${tempLabel}`);
  const bins = await _resolveFfmpeg();
  if (!bins?.ffmpeg) {
    channel.log('pad', `padIfNeeded: NO FFMPEG AVAILABLE — provider will receive un-padded ${dims.width}×${dims.height} input and may reject`);
    return { paddedPath: null, geometry: null };
  }
  const dir = _ensureTmpDir();
  const stat = fs.statSync(filePath);
  const key = _hash([
    filePath,
    String(stat.size),
    String(stat.mtimeMs | 0),
    `${geom.paddedW}x${geom.paddedH}`,
    geom.needsTemporalPad ? `t${targetDurMs}` : 'tnone',
  ]);
  const ext = kind === 'video' ? 'mp4' : 'png';
  const out = path.join(dir, `${key}.padded.${ext}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    return { paddedPath: out, geometry: geom };
  }
  // Build the video filter chain. `tpad=stop_duration=X` appends X
  // seconds of black frames at the end (default `stop_mode=add`,
  // default color=black). Combined with `-an` so we don't have to
  // worry about audio-stream apad / silent-pad mismatch — providers
  // doing video-to-video edits don't consume the audio anyway.
  let vf = `pad=${geom.paddedW}:${geom.paddedH}:${geom.padX}:${geom.padY}:color=black`;
  if (kind === 'video' && geom.needsTemporalPad) {
    vf += `,tpad=stop_duration=${(tailPadMs / 1000).toFixed(3)}`;
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vf', vf];
  if (kind === 'video') {
    if (geom.needsTemporalPad) {
      // Drop audio: simplest robust path. Avoids `-af apad` failing
      // on inputs without an audio stream, and the model regenerates
      // sound on its side regardless.
      args.push('-an');
    } else {
      args.push('-c:a', 'copy');
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    );
    if (geom.needsTemporalPad) {
      // Cap the output to the exact target duration. tpad would
      // otherwise emit slightly more than requested in some ffmpeg
      // builds (rounding to whole frames), and we want the file's
      // reported duration to MATCH what we'll tell the provider.
      args.push('-t', (targetDurMs / 1000).toFixed(3));
    }
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
 * Detect the content's bounding box inside [filePath] by running
 * ffmpeg's `cropdetect` filter — finds the rectangle of non-black
 * pixels averaged across a few seconds of frames. Used by
 * `recoverFromPadded` to discover where the model actually placed the
 * content (Kling and friends can RECENTER the content inside their
 * output rather than honouring the input's spatial layout, so a
 * static crop with the input geometry leaves black bars on the
 * recovered media). Returns `{ x, y, w, h }` or null on failure.
 */
async function _detectContentBbox(filePath) {
  const bins = await _resolveFfmpeg();
  if (!bins?.ffmpeg) return null;
  // cropdetect=limit:round:skip — limit=24 (~9% threshold above pure
  // black, generous because some models bleed faint colour into the
  // padding), round=2 (even-dim alignment for h264), skip=0 (process
  // every frame). Read 4s of video so we don't lock onto a single
  // frame's transient artefact.
  return await new Promise((resolve) => {
    const proc = spawn(bins.ffmpeg, [
      '-hide_banner',
      '-nostats',
      '-t', '4',
      '-i', filePath,
      '-vf', 'cropdetect=24:2:0',
      '-f', 'null',
      '-',
    ]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', () => {
      // Lines look like:
      //   [Parsed_cropdetect_0 @ ...] x1:268 x2:1009 y1:152 y2:565 w:742 h:414 x:268 y:152 pts:... t:... crop=742:414:268:152
      // Take the LAST one — it's the cumulative result over all frames
      // processed (cropdetect tightens its rectangle as more frames
      // arrive). Earlier lines are mid-process snapshots.
      const matches = [...err.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
      if (matches.length === 0) {
        channel.log('pad', `cropdetect: no crop= line in stderr`);
        return resolve(null);
      }
      const m = matches[matches.length - 1];
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      const x = parseInt(m[3], 10);
      const y = parseInt(m[4], 10);
      if (!w || !h) return resolve(null);
      resolve({ x, y, w, h });
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Crop the black borders off [filePath]. Tries TWO strategies in
 * order:
 *
 *   1. **cropdetect** — runs ffmpeg's cropdetect filter on the file
 *      to find the actual rectangle of non-black pixels. Robust when
 *      the model didn't preserve our input's spatial layout (Kling
 *      and similar editing models RECENTER the content inside their
 *      output rather than honouring the position we padded). The
 *      detected rect is sanity-checked against the expected geometry
 *      (aspect within ~10%) — if it's wildly off, fall through.
 *   2. **static geometry** — uses the [geometry] from the padding
 *      step. Faster (no extra ffmpeg pass), but only correct when
 *      the model preserved spatial layout exactly.
 *
 * Returns the new file's absolute path on success. If the geometry
 * indicates no padding was applied (`needsPadding === false`),
 * passes through and returns [filePath] unchanged.
 */
export async function recoverFromPadded(filePath, geometry, kind) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (!fs.existsSync(filePath)) return null;
  if (!geometry || !geometry.needsPadding) return filePath;
  if (kind !== 'video' && kind !== 'image') return filePath;
  const bins = await _resolveFfmpeg();
  if (!bins?.ffmpeg) {
    channel.log('pad', `recoverFromPadded: no ffmpeg available — keeping padded output`);
    return filePath;
  }
  // Cache the recovery output beside the source: same name with
  // `.unpadded.<ext>` suffix. Lets repeated probes (e.g. retries) reuse.
  const ext = kind === 'video' ? 'mp4' : 'png';
  const baseDir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const out = path.join(baseDir, `${stem}.unpadded.${ext}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  // Resolve where to crop. Prefer cropdetect (robust against the model
  // resizing / repositioning), with a static-geometry fallback when
  // cropdetect comes back with something that fails the aspect-ratio
  // sanity check (very dark scene → content not detectable as
  // "non-black", or detection found no padding at all).
  let cropX = geometry.padX;
  let cropY = geometry.padY;
  let cropW = geometry.contentW;
  let cropH = geometry.contentH;
  let strategy = 'static';

  const outDims = await _probeDimensions(filePath);
  if (outDims) {
    channel.log('pad', `recoverFromPadded: ${path.basename(filePath)} model output is ${outDims.width}×${outDims.height} (input padded to ${geometry.paddedW}×${geometry.paddedH})`);
  }

  // If the model preserved the EXACT padded input dimensions, the
  // content is at the coordinates we drew — no need to run cropdetect
  // (which can pick up edge bleed and over-extend the bbox by 1-2 px,
  // making the recovered file slightly bigger than the original
  // cropper output and producing the visible spatial mismatch the
  // user reported as "el video generado es un pelín más grande").
  const dimsMatchExactly = outDims
      && outDims.width === geometry.paddedW
      && outDims.height === geometry.paddedH;

  if (dimsMatchExactly) {
    channel.log(
      'pad',
      `recoverFromPadded: output dims match padded input exactly — skipping cropdetect`,
    );
  } else {
    // Output dims differ from padded input → model rescaled / repositioned.
    // cropdetect is the right tool for that scenario.
    const detected = await _detectContentBbox(filePath);
    if (detected) {
      const expectedAspect = geometry.contentW / geometry.contentH;
      const detectedAspect = detected.w / detected.h;
      const aspectDelta = Math.abs(detectedAspect - expectedAspect) / expectedAspect;
      const detectedFillsFrame = outDims
          && detected.w >= outDims.width - 2
          && detected.h >= outDims.height - 2;
      if (aspectDelta < 0.1 && !detectedFillsFrame) {
        cropX = detected.x;
        cropY = detected.y;
        cropW = detected.w;
        cropH = detected.h;
        strategy = 'cropdetect';
      } else if (detectedFillsFrame && outDims) {
        // Model didn't pad in its output (or content fills it) — fall
        // through to static crop scaled to actual output dims.
        const scaleX = outDims.width / geometry.paddedW;
        const scaleY = outDims.height / geometry.paddedH;
        cropX = Math.round(geometry.padX * scaleX);
        cropY = Math.round(geometry.padY * scaleY);
        cropW = Math.round(geometry.contentW * scaleX);
        cropH = Math.round(geometry.contentH * scaleY);
        // Even-align for h264.
        if (cropX % 2 !== 0) cropX -= 1;
        if (cropY % 2 !== 0) cropY -= 1;
        if (cropW % 2 !== 0) cropW -= 1;
        if (cropH % 2 !== 0) cropH -= 1;
        strategy = 'static-scaled';
      } else {
        channel.log(
          'pad',
          `recoverFromPadded: cropdetect bbox ${detected.w}×${detected.h}@${detected.x},${detected.y} `
          + `aspect ${detectedAspect.toFixed(3)} differs from expected ${expectedAspect.toFixed(3)} `
          + `(${(aspectDelta * 100).toFixed(0)}%) — falling back to static geometry`,
        );
      }
    }
  }

  channel.log(
    'pad',
    `recoverFromPadded: using ${strategy} crop ${cropW}×${cropH} @ ${cropX},${cropY}`,
  );

  const cropFilter = `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vf', cropFilter];
  // Force the output to last EXACTLY as long as the input we sent the
  // model. Some video providers add a frame or two on the way out
  // (Kling video edit observed: 3.00 s in → 3.04 s out, ≈ +1 frame
  // at 25 fps), which makes the AI clip drift on the timeline relative
  // to the underlying source it was meant to replace. Capping at
  // recovery is the cheapest knob with the right effect: ffmpeg drops
  // the trailing frame and the AI clip lines up to the millisecond
  // with the original cropper segment.
  if (kind === 'video' && Number.isFinite(geometry.inputDurMs) && geometry.inputDurMs > 0) {
    args.push('-t', (geometry.inputDurMs / 1000).toFixed(3));
    channel.log(
      'pad',
      `recoverFromPadded: capping output duration to ${geometry.inputDurMs} ms (matches input)`,
    );
  }
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
    `(${strategy} crop ${cropW}×${cropH} @ ${cropX},${cropY})`,
  );
  return out;
}
