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

/** Probe the first video stream as JSON (codec_name, pix_fmt, rotation).
 *  Returns the stream object or null. */
function _probeVideoStreamJson(ffprobe, file) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_streams', '-of', 'json', file,
      ]);
    } catch { return resolve(null); }
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try { resolve(JSON.parse(out)?.streams?.[0] || null); }
      catch { resolve(null); }
    });
  });
}

/** Extract the display rotation (deg) from a probed video stream. Modern
 *  ffmpeg exposes it as `side_data_list[].rotation` (display matrix, often
 *  ±90/180); legacy files use `tags.rotate`. Returns 0 when upright. */
function _rotationFromStream(stream) {
  try {
    const sd = Array.isArray(stream?.side_data_list) ? stream.side_data_list : [];
    for (const s of sd) {
      const n = typeof s?.rotation === 'number' ? s.rotation
        : (s?.rotation != null ? parseFloat(s.rotation) : NaN);
      if (Number.isFinite(n) && n !== 0) return n;
    }
    const t = stream?.tags && (stream.tags.rotate ?? stream.tags.ROTATE);
    if (t != null) { const n = parseFloat(t); if (Number.isFinite(n)) return n; }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Normalize a local video to a STANDARD delivery format before uploading it
 * to a provider. iPhone recordings arrive as QuickTime `.mov` / `.quicktime`
 * containers, frequently HEVC (H.265), often with a rotation display-matrix
 * (and sometimes 10-bit/HDR). Many fal models only accept plain H.264 `.mp4`
 * and reject or mis-handle the rest (the `.quicktime` upload fal bounced).
 *
 * Strategy — cheapest that yields a compliant file, NEVER a silent downgrade:
 *   - already H.264 + yuv420p + `.mp4` + upright  → pass through (no work).
 *   - H.264 + yuv420p + upright, wrong container   → REMUX (`-c copy`,
 *     lossless, milliseconds) into `.mp4`.
 *   - anything else (HEVC, 10-bit / 4:2:2 pix_fmt, a rotation matrix, HDR) →
 *     RE-ENCODE to H.264 high quality (CRF 18 ≈ visually lossless), yuv420p,
 *     +faststart, baking rotation in so providers that ignore the display
 *     matrix still get an upright frame.
 *
 * Returns a path to a compliant file (the original when already fine, or a
 * temp `.mp4`). Returns the ORIGINAL on any failure so the caller still
 * uploads something rather than aborting.
 */
export async function normalizeVideoForProvider(inputPath) {
  try {
    if (!inputPath || typeof inputPath !== 'string' || !fs.existsSync(inputPath)) return inputPath;
    const bins = await _resolveFfmpeg();
    if (!bins?.ffmpeg) return inputPath; // no ffmpeg → can't normalize; upload as-is

    let codec = '', pixFmt = '', rotation = 0;
    if (bins.ffprobe) {
      const st = await _probeVideoStreamJson(bins.ffprobe, inputPath);
      if (st) {
        codec = String(st.codec_name || '').toLowerCase();
        pixFmt = String(st.pix_fmt || '').toLowerCase();
        rotation = _rotationFromStream(st);
      }
    }
    const ext = path.extname(inputPath).toLowerCase();
    const isMp4 = ext === '.mp4';
    const isH264 = codec === 'h264' || codec === 'avc1';
    const is420 = pixFmt.startsWith('yuv420');
    const hasRotation = Math.abs(rotation) >= 1;

    // Already a compliant delivery file → nothing to do. (Only trust this
    // when we could actually probe the codec/pixfmt.)
    if (bins.ffprobe && isMp4 && isH264 && is420 && !hasRotation) return inputPath;

    const outDir = path.join(os.tmpdir(), 'koi-normalized');
    fs.mkdirSync(outDir, { recursive: true });
    const stem = crypto.createHash('sha1')
      .update(`${inputPath}:${fs.statSync(inputPath).mtimeMs}`)
      .digest('hex').slice(0, 12);
    const out = path.join(outDir, `${stem}.mp4`);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out; // cached

    // Lossless remux when the codec is already deliverable and only the
    // container is wrong. Otherwise re-encode to H.264 (visually lossless).
    const canRemux = bins.ffprobe && isH264 && is420 && !hasRotation;
    const args = canRemux
      ? ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', out]
      : ['-y', '-i', inputPath,
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
         '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k',
         '-movflags', '+faststart', out];

    const ok = await _runFfmpeg(bins, args);
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 0) {
      channel.log('video',
        `normalized ${path.basename(inputPath)} → ${path.basename(out)} ` +
        `(${canRemux ? 'remux, lossless' : `re-encode H.264 crf18${hasRotation ? `, rotation ${rotation}° baked` : ''}`}` +
        `${codec ? `; src codec=${codec || '?'} pix=${pixFmt || '?'}` : ''})`);
      return out;
    }
    channel.log('video', `normalize failed for ${path.basename(inputPath)} — uploading original`);
    return inputPath;
  } catch (err) {
    channel.log('video', `normalizeVideoForProvider error (${err?.message || err}) — uploading original`);
    return inputPath;
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
        // Log enough of the tail to actually see the upstream complaint.
        // We've been bitten by the previous `.slice(-400)` chopping the
        // message right at the interesting bit (libx264 / setparams
        // option parser errors run ~600-1500 chars when verbose). Also
        // log the filter chain so a packaged-ffmpeg / older-libx264
        // mismatch can be diagnosed without re-running.
        const vfIdx = args.indexOf('-vf');
        const vf = vfIdx >= 0 && args[vfIdx + 1] ? args[vfIdx + 1] : '(none)';
        const x264Idx = args.indexOf('-x264-params');
        const x264 = x264Idx >= 0 && args[x264Idx + 1] ? args[x264Idx + 1] : '(none)';
        channel.log(
          'pad',
          `ffmpeg exit=${code}\n` +
          `  -vf: ${vf}\n` +
          `  -x264-params: ${x264}\n` +
          `  stderr (last 2KB):\n${err.trim().slice(-2000)}`,
        );
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

/**
 * Compute the padding geometry needed to bring an input within an
 * ASPECT-RATIO CAP — i.e. the maximum allowed long-edge : short-edge
 * ratio a target provider accepts (gpt-image-2/edit caps at 3:1,
 * other models at 2:1 or 4:1, etc.).
 *
 * Output shape mirrors `computePadGeometry`'s — `padX`, `padY`,
 * `contentW`, `contentH`, `paddedW`, `paddedH`, `needsPadding` —
 * so the same `recoverFromPadded` / sharp-based recovery can crop
 * the model's output back to the original content rect regardless
 * of how the padding was originally computed.
 *
 * Returns the geometry with `needsPadding: true` when the input
 * exceeds the cap, or `{ needsPadding: false }` when it's already
 * inside the envelope (no work to do).
 *
 * Pure math — no I/O, no fs, no sharp. The caller decides how to
 * physically pad the asset (in-memory buffer via sharp, file-based
 * via ffmpeg, etc.) given the returned geometry.
 *
 * @param {number} inWidth
 * @param {number} inHeight
 * @param {number} maxAspectRatio  long-edge : short-edge cap (e.g. 3)
 * @returns {{
 *   needsPadding: boolean,
 *   paddedW: number, paddedH: number,
 *   padX: number, padY: number,
 *   contentW: number, contentH: number,
 * }}
 */
// Diffusion edit models (gpt-image-2/edit and friends) silently floor
// both input dims to a multiple of this stride before they validate the
// aspect ratio. Sending 642×214 (ratio 3.0 exact) gets resized to
// 2000×666.67 and floored to 2000×656 → ratio 3.048 → rejected with
// "Image aspect ratio 2000:656 exceeds the maximum allowed ratio 3:1".
// We pre-align BOTH padded dims to the same stride here so the model's
// floor is a no-op and our ratio survives bit-for-bit.
const DIM_ALIGNMENT = 16;

const _ceilToStride = (n, stride) => Math.ceil(n / stride) * stride;

export function computeAspectCapGeometry(inWidth, inHeight, maxAspectRatio) {
  if (!Number.isFinite(inWidth) || !Number.isFinite(inHeight)
      || inWidth <= 0 || inHeight <= 0
      || !Number.isFinite(maxAspectRatio) || maxAspectRatio <= 0) {
    return {
      needsPadding: false,
      paddedW: inWidth, paddedH: inHeight,
      padX: 0, padY: 0,
      contentW: inWidth, contentH: inHeight,
    };
  }
  const longSide = Math.max(inWidth, inHeight);
  const shortSide = Math.min(inWidth, inHeight);
  // Already inside the envelope AND already stride-aligned → no work.
  // If only one of the two holds, fall through and pad the missing bit.
  if (longSide / shortSide <= maxAspectRatio
      && inWidth % DIM_ALIGNMENT === 0
      && inHeight % DIM_ALIGNMENT === 0) {
    return {
      needsPadding: false,
      paddedW: inWidth, paddedH: inHeight,
      padX: 0, padY: 0,
      contentW: inWidth, contentH: inHeight,
    };
  }
  const isLandscape = inWidth >= inHeight;
  // Long edge: round UP to the stride so the model's post-receive floor
  // doesn't trim it (which would shrink the long-side budget and break
  // ratio). Short edge: the smaller of (long / cap, our current short)
  // also rounded up — we must clear the cap AND the stride alignment.
  const paddedLong = _ceilToStride(longSide, DIM_ALIGNMENT);
  const minShortForCap = Math.ceil(paddedLong / maxAspectRatio);
  const paddedShort = _ceilToStride(Math.max(minShortForCap, shortSide), DIM_ALIGNMENT);
  const paddedW = isLandscape ? paddedLong : paddedShort;
  const paddedH = isLandscape ? paddedShort : paddedLong;
  // Center the content within the padded canvas.
  const padX = Math.floor((paddedW - inWidth) / 2);
  const padY = Math.floor((paddedH - inHeight) / 2);
  return {
    needsPadding: paddedW !== inWidth || paddedH !== inHeight,
    paddedW, paddedH,
    padX, padY,
    contentW: inWidth, contentH: inHeight,
  };
}

/**
 * Pad an in-memory image buffer to the given geometry. Sharp-based,
 * no temp files. Returns a `{ data, mimeType }` pair — `mimeType` is
 * always `'image/png'` for the output (alpha-friendly + lossless
 * preserves the hard edges of logos / synthetic art that would
 * otherwise get JPEG ringing on the padded boundary).
 *
 * Pass-through (no allocation, returns the input unchanged) when
 * `geometry.needsPadding === false`.
 *
 * @param {Buffer} buffer       — source image bytes
 * @param {object} geometry     — output of `computeAspectCapGeometry`
 *                                 or `computePadGeometry`
 * @param {string} [sourceMime] — input mime (informational only —
 *                                 the output is always PNG)
 */
export async function padImageBuffer(buffer, geometry, sourceMime) {
  if (!geometry?.needsPadding) {
    return { data: buffer, mimeType: sourceMime || 'image/png' };
  }
  const sharp = (await import('sharp')).default;
  const { paddedW, paddedH, padX, padY, contentW, contentH } = geometry;
  const padded = await sharp(buffer)
    .ensureAlpha()
    .extend({
      top: padY,
      bottom: paddedH - contentH - padY,
      left: padX,
      right: paddedW - contentW - padX,
      // Solid WHITE borders. Originally this was transparent
      // (`alpha: 0`) on the theory that PNG alpha would let the
      // provider read "empty canvas" without leaking colour into the
      // borders. In practice the larger edit models (gpt-image-2/edit
      // and friends) DON'T respect alpha at submit time — they trim
      // or re-process the input and end up reporting an aspect ratio
      // outside the envelope we sent (642×214 padded → "2000:656" on
      // the server side, ratio 3.05 → rejected with "exceeds 3:1").
      // Solid pixels can't be trimmed, so the padded envelope is
      // honoured bit-for-bit and the recovery crop afterwards
      // restores the original content rect. White is the safest
      // neutral for logo-on-light-background flows; the post-crop
      // discards these pixels anyway.
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
  return { data: padded, mimeType: 'image/png' };
}

/**
 * Crop a SAVED image file back to its original content rect using
 * the recorded geometry. Sharp-based, in-place rewrite (the file at
 * `filePath` is replaced with the cropped bytes). Returns the new
 * `{ width, height }` of the recovered image.
 *
 * Pass-through (returns probed dims without rewriting) when
 * `geometry.needsPadding === false`.
 *
 * Handles the model upscaling the padded input proportionally: the
 * crop rect is scaled by `(outW / paddedW, outH / paddedH)` so it
 * lands on the correct region of the actual output. When the model
 * doesn't preserve the envelope (output aspect differs from padded
 * input aspect by >5%), recovery is skipped and the raw output is
 * left intact — better than slicing the wrong region.
 *
 * @param {string} filePath
 * @param {object} geometry — from `computeAspectCapGeometry` / `computePadGeometry`
 * @returns {Promise<{ width: number, height: number, recovered: boolean }>}
 */
export async function recoverImageFile(filePath, geometry) {
  if (!geometry?.needsPadding) {
    const sharp = (await import('sharp')).default;
    const m = await sharp(filePath).metadata();
    return { width: m.width || 0, height: m.height || 0, recovered: false };
  }
  const sharp = (await import('sharp')).default;
  const meta = await sharp(filePath).metadata();
  if (!meta?.width || !meta?.height) {
    return { width: 0, height: 0, recovered: false };
  }
  const inputAspect = geometry.paddedW / geometry.paddedH;
  const outputAspect = meta.width / meta.height;
  // Sanity check: model preserved the envelope within 5% tolerance.
  // Outside that → it picked its own canvas (e.g. forced square) and
  // a static crop would slice the wrong region.
  if (Math.abs(outputAspect - inputAspect) / inputAspect > 0.05) {
    channel.log(
      'pad',
      `recoverImageFile: skip on ${path.basename(filePath)} — ` +
      `output aspect ${outputAspect.toFixed(2)} != padded input ${inputAspect.toFixed(2)}`,
    );
    return { width: meta.width, height: meta.height, recovered: false };
  }
  const scaleX = meta.width / geometry.paddedW;
  const scaleY = meta.height / geometry.paddedH;
  const cropX = Math.max(0, Math.round(geometry.padX * scaleX));
  const cropY = Math.max(0, Math.round(geometry.padY * scaleY));
  const cropW = Math.min(meta.width - cropX, Math.round(geometry.contentW * scaleX));
  const cropH = Math.min(meta.height - cropY, Math.round(geometry.contentH * scaleY));
  if (cropW <= 0 || cropH <= 0) {
    return { width: meta.width, height: meta.height, recovered: false };
  }
  // Crop + resize-back to the ORIGINAL content dimensions. The model
  // (gpt-image-2/edit etc.) emits at its own preset canvas — usually
  // an UPSCALE of the input (e.g. 592×198 padded → 1024×342 out).
  // The crop above gives us the right region, but at the model's
  // canvas size, not the user's. For in-place edit flows (logo
  // recolor, sticker tweak, etc.) the user expects bit-for-bit dim
  // parity with the source: 592×138 in → 592×138 out, not 1024×239.
  // The final resize collapses the model upscale away.
  //
  // We pick lanczos3 because it's the highest-quality downsample
  // sharp offers and the edit content is usually sharp-edge synthetic
  // (text, vector logos) where ringing artifacts of cheaper filters
  // would be visible.
  let pipeline = sharp(filePath)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH });
  const wantResize = cropW !== geometry.contentW || cropH !== geometry.contentH;
  if (wantResize) {
    pipeline = pipeline.resize(geometry.contentW, geometry.contentH, {
      fit: 'fill',
      kernel: 'lanczos3',
    });
  }
  const cropped = await pipeline.toBuffer();
  fs.writeFileSync(filePath, cropped);
  const finalW = wantResize ? geometry.contentW : cropW;
  const finalH = wantResize ? geometry.contentH : cropH;
  channel.log(
    'pad',
    `recoverImageFile: ${path.basename(filePath)} ${meta.width}×${meta.height} → ${finalW}×${finalH} ` +
    `(crop ${cropX},${cropY} ${cropW}×${cropH}` +
    (wantResize ? `; resize-back to source dims ${geometry.contentW}×${geometry.contentH}` : '') +
    `; model scale ${scaleX.toFixed(2)}×${scaleY.toFixed(2)})`,
  );
  return { width: finalW, height: finalH, recovered: true };
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
    case '360p': shortSide = 360; break;
    case '480p': shortSide = 480; break;
    case '720p': shortSide = 720; break;
    case '1080p': shortSide = 1080; break;
    case '2k': case '1440p': shortSide = 1440; break;
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
  // Project frame rate. Carried through `geom` so recoverFromPadded
  // can force the recovered file's fps to match — without this the
  // model's emitted fps (often unspecified, e.g. Kling can return
  // 24/25/30 depending on internal heuristics) drifts away from the
  // V1 timeline's frame cadence and the AI clip plays "1-2 frames
  // adelantado" relative to V1.
  if (Number.isFinite(opts.outputFps) && opts.outputFps > 0) {
    geom.outputFps = opts.outputFps;
  }
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
  //
  // `setparams` stamps explicit BT.709 SDR limited-range metadata on
  // every frame as it leaves the filter graph. Without this the encoder
  // can drop unspecified primaries/trc into the H.264 VUI even when we
  // pass `-color_primaries`/`-color_trc` on the output side — observed
  // on packaged ffmpeg builds where the recovered file came back
  // tagged `color_space=bt709 color_range=tv` but `color_primaries=
  // unknown color_transfer=unknown`. AVFoundation then falls back to
  // a default decode that mismatches V1 (HDR-tonemapped natively),
  // visible to the user as the AI clip looking lighter / washed.
  let vf = `pad=${geom.paddedW}:${geom.paddedH}:${geom.padX}:${geom.padY}:color=black`;
  if (kind === 'video' && geom.needsTemporalPad) {
    vf += `,tpad=stop_duration=${(tailPadMs / 1000).toFixed(3)}`;
  }
  if (kind === 'video') {
    vf += ',setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
    // Lock the padded file's frame rate to the project's fps. ffmpeg's
    // `fps` filter handles up/down conversion (frame drop/duplicate)
    // so the model receives input at exactly the rate we'll later
    // expect from its output — closing the loop on the AI clip ↔ V1
    // frame-grid alignment.
    if (Number.isFinite(geom.outputFps) && geom.outputFps > 0) {
      vf += `,fps=${geom.outputFps.toFixed(6)}`;
    }
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
      // Frame-accurate seed MP4: no B-frames means each sample's
      // DTS == PTS, so libx264 doesn't need an edit list to handle
      // negative CTS offsets. Without `-bf 0`, the H.264 stream's
      // first 1-2 PTS values are negative, libx264 stamps a 1-2
      // frame `edts/elst` skip into the MP4, and any consumer that
      // respects edit lists (AVFoundation, FFmpeg ≥ 4.0) starts
      // playback 1-2 frames into the file. The model on fal then
      // receives "input frame N+2" as its frame 0 — we observed
      // exactly the "+2 frames adelantado" the user reports. The
      // file-size hit (~10-20% larger seed) is irrelevant for a
      // 5-10s clip uploaded to a model API.
      '-bf', '0',
      // Explicit BT.709 SDR limited-range tags. The cropper already
      // tonemaps to BT.709 SDR, and `setparams` in the filter chain
      // stamps the frame metadata, so this just propagates to the
      // output container's stream tags.
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
      '-color_range', 'tv',
      // Force the H.264 bitstream's own VUI to declare the same
      // tags. `-color_*` alone has been observed to write
      // `color_space=bt709` + `color_range=tv` while leaving
      // `color_primaries=unknown` / `color_transfer=unknown` in the
      // muxed file (libx264 only emits VUI primaries/transfer when
      // it sees them set explicitly via x264-params on some builds).
      // Belt-and-braces: `setparams` filter + container `-color_*`
      // + bitstream `-x264-params`.
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv',
      // Strip the mov edit list. With `-bf 0` above the bitstream
      // has no negative CTS, so omitting the edts atom is safe.
      // Pre-7.0 ffmpeg used `-movflags -use_edts`, but that flag was
      // removed (the only valid movflags-side toggle now is via the
      // top-level `-use_editlist 0` option, which is what we use here).
      // Passing `-use_edts` as a movflag through ffmpeg ≥ 7.0 falls
      // into the eval engine and aborts the whole encode with
      // "Undefined constant or missing '(' in 'use_edts'".
      '-movflags', '+faststart',
      '-use_editlist', '0',
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
  const outDims = await _probeDimensions(filePath);
  if (outDims) {
    channel.log('pad', `recoverFromPadded: ${path.basename(filePath)} model output is ${outDims.width}×${outDims.height} (input padded to ${geometry.paddedW}×${geometry.paddedH})`);
  }

  // Compute the static crop in OUTPUT coordinate space. When the model
  // preserved padded dims exactly, scale is 1:1 and this is identical
  // to the raw geometry. When the model rescaled (e.g. Kling video edit
  // 1280×720 → 1920×1080), this scales the crop rect so it lands on
  // the actual content region — without it, the static fallback would
  // sample 660×660 @ (310,30) on a 1920×1080 output and grab the wrong
  // quadrant.
  const scaleX = outDims ? outDims.width / geometry.paddedW : 1;
  const scaleY = outDims ? outDims.height / geometry.paddedH : 1;
  let cropX = Math.round(geometry.padX * scaleX);
  let cropY = Math.round(geometry.padY * scaleY);
  let cropW = Math.round(geometry.contentW * scaleX);
  let cropH = Math.round(geometry.contentH * scaleY);
  // Even-align for h264.
  if (cropX % 2 !== 0) cropX -= 1;
  if (cropY % 2 !== 0) cropY -= 1;
  if (cropW % 2 !== 0) cropW -= 1;
  if (cropH % 2 !== 0) cropH -= 1;
  let strategy = (scaleX === 1 && scaleY === 1) ? 'static' : 'static-scaled';

  // If the model preserved the EXACT padded input dimensions, the
  // content is at the coordinates we drew — no need to run cropdetect
  // (which can pick up edge bleed and over-extend the bbox by 1-2 px,
  // making the recovered file slightly bigger than the original
  // cropper output and producing the visible spatial mismatch the
  // user reported as "el video generado es un pelín más grande").
  const dimsMatchExactly = outDims
      && outDims.width === geometry.paddedW
      && outDims.height === geometry.paddedH;

  // Even when dims don't match exactly, the model often just RESIZES
  // the padded input proportionally (same aspect, larger / smaller).
  // The content's position in the output is then deterministic
  // (padX × scale, padY × scale) and cropdetect would only INTRODUCE
  // error: it sets a 9% luma threshold (limit=24/255), so faint edge
  // bleed from the model's diffusion / encoding lands the bbox a few
  // pixels off — the "black strip on the left" the user reported
  // (e.g. padded input 1280×1050 → output 1588×1304: aspects 1.219
  // vs 1.218, model just upscaled, but cropdetect put x=120 instead
  // of the deterministic ~143). Use the static-scaled geometry
  // whenever input/output aspects match within tolerance.
  const inputAspect = geometry.paddedW > 0 && geometry.paddedH > 0
      ? geometry.paddedW / geometry.paddedH
      : null;
  const outputAspect = outDims && outDims.width > 0 && outDims.height > 0
      ? outDims.width / outDims.height
      : null;
  const aspectMatches = inputAspect != null && outputAspect != null
      && Math.abs(outputAspect - inputAspect) / inputAspect < 0.02;

  if (dimsMatchExactly) {
    channel.log(
      'pad',
      `recoverFromPadded: output dims match padded input exactly — skipping cropdetect`,
    );
  } else if (aspectMatches) {
    channel.log(
      'pad',
      `recoverFromPadded: output aspect ${outputAspect.toFixed(3)} matches padded input ${inputAspect.toFixed(3)} `
      + `(model upscaled proportionally) — skipping cropdetect, using static-scaled crop`,
    );
  } else {
    // Output dims differ AND aspect differs → model rescaled and
    // repositioned. cropdetect is the right tool here (the
    // deterministic geometry no longer applies); otherwise we keep
    // the scaled static crop computed above.
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
      } else {
        channel.log(
          'pad',
          `recoverFromPadded: cropdetect bbox ${detected.w}×${detected.h}@${detected.x},${detected.y} `
          + `aspect ${detectedAspect.toFixed(3)} differs from expected ${expectedAspect.toFixed(3)} `
          + `(${(aspectDelta * 100).toFixed(0)}%)${detectedFillsFrame ? ' (fills frame)' : ''} — falling back to ${strategy} geometry`,
        );
      }
    }
  }

  // ── SACRED aspect conform ─────────────────────────────────────────
  // Whatever strategy picked the crop rect, the recovered file MUST come
  // out at the ORIGINAL (pre-pad) content aspect — an edit of a 9:16
  // video returns a 9:16 video, period. Models routinely disobey the
  // padded envelope (observed: 9:16 source padded to a 1:1 1920×1920
  // canvas, model returned 1280×720 16:9; cropdetect found a ~square
  // bbox and the static-scaled fallback produced a 720×720 SQUARE file —
  // the reported bug). When the chosen rect's aspect drifts from the
  // expected content aspect, shrink the larger dimension centered so the
  // final crop is exactly the source aspect: best-effort composition,
  // guaranteed-correct geometry.
  {
    const _expAspect = geometry.contentW > 0 && geometry.contentH > 0
        ? geometry.contentW / geometry.contentH
        : null;
    if (_expAspect && cropW > 0 && cropH > 0) {
      const _curAspect = cropW / cropH;
      if (Math.abs(_curAspect - _expAspect) / _expAspect > 0.02) {
        if (_curAspect > _expAspect) {
          const w = Math.floor(cropH * _expAspect);
          cropX += Math.floor((cropW - w) / 2);
          cropW = w;
        } else {
          const h = Math.floor(cropW / _expAspect);
          cropY += Math.floor((cropH - h) / 2);
          cropH = h;
        }
        if (cropX % 2 !== 0) cropX -= 1;
        if (cropY % 2 !== 0) cropY -= 1;
        if (cropW % 2 !== 0) cropW -= 1;
        if (cropH % 2 !== 0) cropH -= 1;
        strategy += '+aspect-conform';
        channel.log(
          'pad',
          `recoverFromPadded: crop aspect ${_curAspect.toFixed(3)} != source content aspect ${_expAspect.toFixed(3)} `
          + `— conforming centered to ${cropW}×${cropH} (source aspect is authoritative)`,
        );
      }
    }
  }

  channel.log(
    'pad',
    `recoverFromPadded: using ${strategy} crop ${cropW}×${cropH} @ ${cropX},${cropY}`,
  );

  // `setparams` stamps explicit BT.709 SDR limited-range metadata on
  // every recovered frame BEFORE the encoder sees it. The model emits
  // its output without color tags; passing `-color_*` only on the
  // output side has been observed to write `color_space=bt709 +
  // color_range=tv` while leaving `color_primaries=unknown` /
  // `color_transfer=unknown` in the muxed file, which AVFoundation
  // then decodes with a default that doesn't match V1 (HDR-tonemapped
  // natively) — the user-reported "AI clip looks lighter / washed".
  let cropFilter = `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
  if (kind === 'video') {
    cropFilter += ',setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
    // Force the recovered file's frame rate back to the project's fps
    // when the caller persisted it on the geometry. Closes the
    // round-trip: GUI snaps the source crop to the project fps grid
    // → padIfNeeded re-encodes at that fps → the model emits N
    // frames at SOME fps → recovery restamps to the project fps so
    // the AI clip's frames advance in lockstep with V1 on playback.
    // No-op for `outputFps` not set (legacy callers / image kind).
    if (Number.isFinite(geometry.outputFps) && geometry.outputFps > 0) {
      cropFilter += `,fps=${geometry.outputFps.toFixed(6)}`;
    }
  }
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
      // Same colorspace tags as the padding step. The cropper input
      // is already BT.709 SDR limited-range; the model preserves
      // pixel values but emits no metadata; we close the loop here
      // so the final .unpadded.mp4 declares its colorspace and
      // AVFoundation displays it consistently with the original
      // (HDR-tonemapped) source pixels next to it on the timeline.
      // Without these, AI clips read as visibly LIGHTER / washed-
      // out compared to the unaltered V1 frames — the user-reported
      // mismatch in skin tone and wall colour at the AI clip's edge.
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
      '-color_range', 'tv',
      // Force the H.264 bitstream's own VUI to declare the same
      // tags. Belt-and-braces with `setparams` + container `-color_*`
      // — observed needed on the macOS ffmpeg builds we ship.
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv',
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

/**
 * Re-mux [filePath] with the mov edit list omitted. Returns the new
 * file's path on success; null on failure (caller falls back to the
 * unmodified [filePath]).
 *
 * Why this exists: libx264 + B-frames stamps an `edts/elst` atom on
 * the output MP4 that tells consumers (AVFoundation, FFmpeg ≥ 4.0)
 * to skip the first 1-2 samples — used to compensate for B-frame
 * DTS-vs-PTS reordering. AVFoundation respects it and the AI clip
 * ends up playing 1-2 frames ahead of the linked source on the
 * timeline (the user-reported "1/15s adelantado").
 *
 * Implementation: `-c copy -use_editlist 0` re-writes the moov atom
 * WITHOUT the `edts/elst` skip, but keeps the H.264 bitstream
 * (including B-frames) intact. The result is a frame-aligned file
 * the player can read from sample 0 directly. Done as a separate
 * pass (after recovery succeeds) so the recovery's filter graph
 * stays untouched — adding the edit-list strip flags to the recovery
 * ffmpeg call has been observed to fail silently on the bundled
 * macOS build (recovery returns 0 bytes, the AI clip falls back to
 * the padded model output and shows black bars).
 *
 * Fast (< 100 ms): no re-encode, just a moov rewrite.
 *
 * Returns:
 *   - path to the stripped file on success
 *   - null when input is missing / not a video / strip fails
 *     (caller keeps the original path)
 */
export async function stripVideoEditList(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mp4' && ext !== '.mov' && ext !== '.m4v') return null;
  const bins = await _resolveFfmpeg();
  if (!bins?.ffmpeg) return null;
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const out = path.join(dir, `${stem}.noedts.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-c', 'copy',
    '-movflags', '+faststart',
    // See padded-encode notes above — `-use_editlist 0` replaces the
    // legacy `-movflags -use_edts` which ffmpeg ≥ 7.0 no longer accepts.
    '-use_editlist', '0',
    '-y', out,
  ];
  const ok = await _runFfmpeg(bins, args);
  if (!ok) {
    channel.log('pad', `stripVideoEditList: re-mux failed — keeping original (${path.basename(filePath)})`);
    return null;
  }
  channel.log('pad', `stripVideoEditList: ${path.basename(filePath)} → ${path.basename(out)} (no edts)`);
  return out;
}
