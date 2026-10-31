/**
 * Read File Action - Read file contents without using shell.
 *
 * Dedicated action so the LLM doesn't need to use shell with cat/head/tail.
 * Supports reading full files or specific line ranges.
 * Permission: per directory, shared with edit_file/write_file/search.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';

import { t } from '../../i18n.js';
import { getFilePermissions } from '../../code/file-permissions.js';
import { creationDirHit, creationDirBlockedError } from '../_creation-dir-guard.js';
import { channel } from '../../io/channel.js';
import { markRead } from '../../state/read-tracker.js';

async function extractPdfPageImages(page, pdfjsLib) {
  const opList = await page.getOperatorList();
  const images = [];
  const ImageKind = pdfjsLib.ImageKind || {
    GRAYSCALE_1BPP: 1,
    RGB_24BPP: 2,
    RGBA_32BPP: 3
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn !== pdfjsLib.OPS.paintImageXObject && fn !== pdfjsLib.OPS.paintInlineImageXObject) continue;

    const args = opList.argsArray[i] || [];
    const imageId = args[0];
    let img = null;

    if (imageId) {
      try {
        img = page.objs.get(imageId);
      } catch {
        img = null;
      }
    }

    if (!img && fn === pdfjsLib.OPS.paintInlineImageXObject) {
      img = args[0];
    }

    if (!img || !img.data || !img.width || !img.height) continue;

    let rgba;
    if (img.kind === ImageKind.RGBA_32BPP) {
      rgba = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    } else if (img.kind === ImageKind.RGB_24BPP) {
      rgba = new Uint8ClampedArray(img.width * img.height * 4);
      for (let src = 0, dest = 0; src < img.data.length; src += 3, dest += 4) {
        rgba[dest] = img.data[src];
        rgba[dest + 1] = img.data[src + 1];
        rgba[dest + 2] = img.data[src + 2];
        rgba[dest + 3] = 255;
      }
    } else if (img.kind === ImageKind.GRAYSCALE_1BPP) {
      rgba = new Uint8ClampedArray(img.width * img.height * 4);
      const rowBytes = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const byte = img.data[y * rowBytes + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          const value = bit ? 0 : 255;
          const idx = (y * img.width + x) * 4;
          rgba[idx] = value;
          rgba[idx + 1] = value;
          rgba[idx + 2] = value;
          rgba[idx + 3] = 255;
        }
      }
    } else {
      rgba = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    }

    images.push({ data: rgba, width: img.width, height: img.height });
  }

  return images;
}

/**
 * Install minimal DOM polyfills that pdfjs-dist needs at module load time.
 * Must be called BEFORE any import('pdfjs-dist/...').
 */
function _ensurePdfjsPolyfills() {
  if (typeof globalThis.DOMMatrix !== 'undefined') return; // already polyfilled or real browser

  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      const v = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
      this.a = v[0] ?? 1; this.b = v[1] ?? 0; this.c = v[2] ?? 0;
      this.d = v[3] ?? 1; this.e = v[4] ?? 0; this.f = v[5] ?? 0;
      this.m11 = this.a; this.m12 = this.b; this.m21 = this.c;
      this.m22 = this.d; this.m41 = this.e; this.m42 = this.f;
      this.m13 = 0; this.m14 = 0; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m43 = 0; this.m44 = 1; this.is2D = true; this.isIdentity = false;
    }
    multiplySelf(o) {
      const a = this.a * o.a + this.c * o.b, b = this.b * o.a + this.d * o.b;
      const c = this.a * o.c + this.c * o.d, d = this.b * o.c + this.d * o.d;
      const e = this.a * o.e + this.c * o.f + this.e, f = this.b * o.e + this.d * o.f + this.f;
      this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
      return this;
    }
    translate(tx, ty) { return this.multiplySelf(new DOMMatrix([1, 0, 0, 1, tx, ty])); }
    scale(sx, sy) { return this.multiplySelf(new DOMMatrix([sx, 0, 0, sy ?? sx, 0, 0])); }
    inverse() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return new DOMMatrix();
      return new DOMMatrix([this.d / det, -this.b / det, -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det]);
    }
    transformPoint(p) {
      return { x: this.a * (p?.x || 0) + this.c * (p?.y || 0) + this.e,
               y: this.b * (p?.x || 0) + this.d * (p?.y || 0) + this.f };
    }
    static fromMatrix(o) { return new DOMMatrix([o?.a ?? 1, o?.b ?? 0, o?.c ?? 0, o?.d ?? 1, o?.e ?? 0, o?.f ?? 0]); }
  };

  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  }
  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = class Path2D { constructor() {} moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} rect() {} };
  }
}

/**
 * Load pdfjs-dist in pkg binary by extracting the ESM files from the snapshot
 * to ~/.koi/runtime/{version}/pdfjs-dist/ on real disk, then importing from there.
 * Cached — only extracts once per version.
 */
let _pdfjsCached = null;
async function _loadPdfjsFromCache() {
  if (_pdfjsCached) return _pdfjsCached;

  const version = process.env.KOI_VERSION || 'dev';
  const cacheDir = path.join(os.homedir(), '.koi', 'runtime', version, 'pdfjs-dist');
  const targetFile = path.join(cacheDir, 'pdf.mjs');
  const markerFile = path.join(cacheDir, '.extracted');

  if (!fs.existsSync(markerFile)) {
    // Find pdfjs-dist in the snapshot via require.resolve. ESM has no
    // CommonJS `__filename`; we anchor `createRequire` at this file
    // first (handles the pkg-binary case where bundled deps live
    // alongside the runtime) and fall back to the CLI's entry script +
    // cwd so the resolver also walks `koi-cli/node_modules/` when the
    // runtime is consumed from a sibling package (the workspace
    // layout: `koi-cli` declares pdfjs-dist, `koi` doesn't, and
    // anchoring only at `koi/...` never finds it).
    const { createRequire } = await import('module');
    const anchors = [import.meta.url];
    if (process.argv[1]) anchors.push(process.argv[1]);
    anchors.push(path.join(process.cwd(), 'package.json'));
    let snapshotDir = null;
    let lastErr = null;
    for (const anchor of anchors) {
      try {
        const req = createRequire(anchor);
        const resolved = req.resolve('pdfjs-dist/legacy/build/pdf.mjs');
        snapshotDir = path.dirname(resolved);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!snapshotDir) {
      throw new Error(
        `pdfjs-dist not found from any module-resolution anchor ` +
        `(tried ${anchors.length}: ${anchors.map((a) => String(a)).join(', ')}). ` +
        `Install pdfjs-dist as a dep of the package whose binary launches the runtime. ` +
        `Last resolve error: ${lastErr?.message || 'unknown'}`,
      );
    }

    // Extract all files from the legacy/build directory
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    fs.mkdirSync(cacheDir, { recursive: true });

    const files = fs.readdirSync(snapshotDir);
    for (const file of files) {
      const src = path.join(snapshotDir, file);
      const dest = path.join(cacheDir, file);
      try {
        const stat = fs.statSync(src);
        if (stat.isFile()) {
          fs.copyFileSync(src, dest);
        }
      } catch { /* skip unreadable files */ }
    }

    fs.writeFileSync(markerFile, version, 'utf8');
    channel.log('read_file', `Extracted pdfjs-dist to ${cacheDir}`);
  }

  // Suppress pdfjs warnings about missing optional deps (@napi-rs/canvas)
  const _origWarn = console.warn;
  console.warn = (...args) => {
    const msg = String(args[0] || '');
    if (msg.startsWith('Warning: Cannot') || msg.includes('@napi-rs/canvas')) return;
    _origWarn.apply(console, args);
  };
  try {
    const { pathToFileURL } = await import('url');
    _pdfjsCached = await import(pathToFileURL(targetFile).href);
  } finally {
    console.warn = _origWarn;
  }
  return _pdfjsCached;
}

/** Format a millisecond playhead position as MM:SS.ms (zero-padded).
 *  Mirrors the format used by the system prompt builder for the
 *  WORKING AREA video annotations block. */
function _formatVideoTs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '00:00.000';
  const totalSec = Math.floor(ms / 1000);
  const millis = Math.round(ms - totalSec * 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

const _VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg']);
const _AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.opus', '.oga', '.weba']);

/** Render seconds as MM:SS or HH:MM:SS. Used by the audio metadata
 *  branch so the agent sees a human-readable duration alongside the
 *  raw `durationSec` number. */
function _formatDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Probe a video's duration in milliseconds via the bundled ffprobe.
 *  Falls through to the system PATH only when the bundled installer
 *  fails to materialise (dev runs, tests). Returns null when neither is
 *  reachable or the file is unreadable — callers should treat that as
 *  "no signal" and degrade gracefully.
 *
 *  Important: the koi-cli binary doesn't ship ffprobe on the host's
 *  PATH; it stages a copy at `~/.koi/bin/` via `ensureFfmpeg()`. Hard-
 *  coding `'ffprobe'` here meant any user without a system install hit
 *  "ffmpeg may be unavailable" on every video read. */
async function _probeVideoDurationMs(filePath) {
  let bin = 'ffprobe';
  try {
    const installer = await import('../../media/ffmpeg-installer.js');
    const r = await installer.ensureFfmpeg();
    if (r?.ffprobe) bin = r.ffprobe;
  } catch { /* fall back to PATH */ }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const { stdout } = await run(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { timeout: 3000 },
    );
    const data = JSON.parse(stdout);
    const sec = data?.format?.duration ? Number(data.format.duration) : null;
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
  } catch {
    return null;
  }
}

/** Sample N evenly-spaced JPEG frames from a video and queue them for
 *  the next LLM turn as vision inputs. Centre-of-bin sampling (5/8/etc%
 *  through their slice) avoids the all-black opening frame and the
 *  freeze-on-EOF problem you'd hit by sampling at exactly 0% / 100%.
 *  Returns the chosen timestamps so the caller can name them in the
 *  result message. Best-effort — bails out (returns []) if ffmpeg is
 *  unavailable or every extraction errors. */
async function _queueVideoFramesForVision(videoPath, session, opts = {}) {
  const count = Math.max(1, Math.min(8, opts.count || 4));
  const durMs = await _probeVideoDurationMs(videoPath);
  if (!durMs) return [];

  let ffmpegBin;
  try {
    const installer = await import('../../media/ffmpeg-installer.js');
    const r = await installer.ensureFfmpeg();
    ffmpegBin = r.ffmpeg;
  } catch {
    return [];
  }
  const { spawn } = await import('child_process');

  const tmpDir = path.join(
    os.tmpdir(),
    'koi-read-file-video',
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  const sampledMs = [];
  for (let i = 0; i < count; i++) {
    const tMs = Math.floor((durMs * (i + 0.5)) / count);
    const outPath = path.join(tmpDir, `frame-${String(i).padStart(2, '0')}.jpg`);
    const ts = (tMs / 1000).toFixed(3);
    const argv = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', ts,
      '-i', videoPath,
      '-frames:v', '1', '-an',
      '-q:v', '3',
      '-y', outPath,
    ];
    const ok = await new Promise((resolve) => {
      const child = spawn(ffmpegBin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok || !fs.existsSync(outPath)) continue;
    const b64 = fs.readFileSync(outPath).toString('base64');
    if (!session._pendingMcpImages) session._pendingMcpImages = [];
    session._pendingMcpImages.push({
      mimeType: 'image/jpeg',
      data: b64,
      _debugPath: outPath,
      role: 'video_frame_sample',
    });
    sampledMs.push(tMs);
  }
  return sampledMs;
}

/** Downscale a video so it fits under `targetBytes` for NATIVE inline upload.
 *  For analysis we don't need full quality, so this walks a ladder of
 *  progressively smaller settings (resolution / fps / crf / drop-audio) and
 *  returns the first .mp4 output under the target — far better than degrading
 *  to a handful of sampled frames. Returns { path, bytes } (the smallest we
 *  managed, even if still over target so the caller can decide), or null when
 *  ffmpeg is unavailable / every pass errored. */
async function _transcodeVideoForUpload(videoPath, targetBytes) {
  let ffmpegBin;
  try {
    const installer = await import('../../media/ffmpeg-installer.js');
    const r = await installer.ensureFfmpeg();
    ffmpegBin = r.ffmpeg;
  } catch {
    return null;
  }
  const { spawn } = await import('child_process');
  const tmpDir = path.join(
    os.tmpdir(),
    'koi-read-file-video',
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  // [scale height, fps (null = keep), crf, keep audio]. Each rung is smaller
  // than the last; Gemini understands video at ~1 fps anyway, so dropping
  // resolution/fps costs nothing for content analysis.
  const ladder = [
    [480, null, 30, true],
    [360, 15, 32, false],
    [288, 8, 34, false],
  ];
  let best = null;
  for (let i = 0; i < ladder.length; i++) {
    const [h, fps, crf, audio] = ladder[i];
    const outPath = path.join(tmpDir, `reduced-${i}.mp4`);
    const argv = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-vf', `scale=-2:${h}`,
      ...(fps ? ['-r', String(fps)] : []),
      '-c:v', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '40k'] : ['-an']),
      '-movflags', '+faststart',
      outPath,
    ];
    const ok = await new Promise((resolve) => {
      const child = spawn(ffmpegBin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok || !fs.existsSync(outPath)) continue;
    const bytes = fs.statSync(outPath).size;
    if (!best || bytes < best.bytes) best = { path: outPath, bytes };
    if (bytes <= targetBytes) return best;
  }
  return best;
}

/** Best-effort metadata probe via ffprobe. Returns null when ffprobe
 *  isn't installed or the file is unreadable — caller falls back to
 *  basic file-stat info. The 2-second timeout protects against a
 *  hanging probe on a corrupt file. */
async function _probeAudioMetadata(filePath) {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
      { timeout: 2000 },
    );
    const data = JSON.parse(stdout);
    const stream = (data.streams || []).find((s) => s.codec_type === 'audio') || {};
    const fmt = data.format || {};
    return {
      durationSec: fmt.duration ? Number(fmt.duration) : null,
      bitRateKbps: fmt.bit_rate ? Math.round(Number(fmt.bit_rate) / 1000) : null,
      codec: stream.codec_name || null,
      sampleRateHz: stream.sample_rate ? Number(stream.sample_rate) : null,
      channels: stream.channels || null,
      formatName: fmt.format_long_name || fmt.format_name || null,
    };
  } catch {
    return null;
  }
}

/** Queue every annotation in the bundle as a vision input, with the
 *  appropriate caption per kind. Returns a text fragment to splice into
 *  the read_file return message. Pasted-cutout references are listed in
 *  the message but NEVER queued — they flow to generate_image as
 *  `referenceImages` separately, so the agent doesn't have to inspect
 *  each cutout source visually to reason about the edit. */
async function _queueAnnotationsForVision(bundle, doc, session) {
  const anns = Array.isArray(bundle?.annotations) ? bundle.annotations : [];
  let note = '';

  // Image annotations — single composite-snapshot at most. Use the
  // legacy `[ANNOTATIONS OVERLAY]` caption so existing image-flow
  // behaviour is preserved verbatim.
  const { readNormalisedImageForVision } = await import('../media/_normalize-image-for-vision.js');
  const imageAnns = anns.filter((a) => a && a.role !== 'video-frame-composite');
  for (const a of imageAnns) {
    if (!a.path || !fs.existsSync(a.path)) continue;
    let mime, b64;
    try {
      const norm = await readNormalisedImageForVision(a.path);
      mime = norm.mimeType;
      b64 = norm.base64;
    } catch {
      // If sharp can't read it (rare — annotation composites are
      // generated PNGs), fall back to raw bytes so we don't drop the
      // user's markup silently.
      const ext = path.extname(a.path).toLowerCase().slice(1);
      mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      b64 = fs.readFileSync(a.path).toString('base64');
    }
    const caption =
      '[ANNOTATIONS OVERLAY] The next image is NOT part of the original document. ' +
      'It is the user\'s hand-drawn markup (arrows, circles, boxes, freehand, text) ' +
      'AND any reference cutouts they have pasted, both painted on top of the exact ' +
      'same image you just saw. Use it as a visual guide that complements the text ' +
      'prompt: the shapes and their positions indicate what the user is referring to. ' +
      'Drawn-colour markup itself is meaningless — only the regions and the shapes\' ' +
      'intent matter. Do not treat the markup as part of the design or copy its ' +
      'colours into your output. Pasted cutouts ARE content, but you do NOT need to ' +
      'inspect their full-quality sources here — they are listed in the bundle and ' +
      'will be forwarded by generate_image as referenceImages when the edit runs.';
    session._pendingMcpImages.push({
      mimeType: mime,
      data: b64,
      _debugPath: a.path,
      caption,
      role: 'annotation_overlay',
    });
    channel.log('read_file', `[bundle:${doc.id}] annotation queued for vision: ${a.path}`);
    note = ' The user has drawn/composed on top of it — a second image labeled "ANNOTATIONS OVERLAY" follows: THAT is the visual intent spec.';
  }

  // Video frame composites — one per annotated frame, chronological.
  // Each gets a `[ANNOTATIONS @ MM:SS.ms]` caption with frame index so
  // the agent can correlate to the source timeline. Caption asks the
  // agent to interpret marks (red X = remove; arrow = motion; etc.) and
  // write a SPECIFIC `generate_video` prompt that names what changes.
  const videoAnns = anns.filter((a) => a && a.role === 'video-frame-composite');
  if (videoAnns.length > 0) {
    const sorted = [...videoAnns].sort(
      (a, b) => (a.frameTimestampMs ?? 0) - (b.frameTimestampMs ?? 0),
    );
    for (const a of sorted) {
      if (!a.path || !fs.existsSync(a.path)) continue;
      let mime, b64;
      try {
        const norm = await readNormalisedImageForVision(a.path);
        mime = norm.mimeType;
        b64 = norm.base64;
      } catch {
        const ext = path.extname(a.path).toLowerCase().slice(1);
        mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        b64 = fs.readFileSync(a.path).toString('base64');
      }
      const tsLabel = typeof a.frameTimestampMs === 'number'
        ? _formatVideoTs(a.frameTimestampMs)
        : '?';
      const idxLabel = typeof a.frameIndex === 'number' ? ` (frame ${a.frameIndex})` : '';
      const caption =
        `[ANNOTATIONS @ ${tsLabel}]${idxLabel} A composite PNG of the video frame at ${tsLabel} ` +
        'with the user\'s drawn marks (arrows, crosses, circles, freehand, text) on top. ' +
        'Interpret the marks: red X / cross-out = remove that subject; arrow = motion direction ' +
        'or "move from A to B"; circle / rectangle = focus area; freehand = the area to change; ' +
        'text = literal instruction. Use the timestamp to refer to specific moments in the source ' +
        'video when writing the `generate_video` prompt — drawn-colour markup itself is meaningless, ' +
        'only the regions and the shapes\' intent matter.';
      session._pendingMcpImages.push({
        mimeType: mime,
        data: b64,
        _debugPath: a.path,
        caption,
        role: 'video_frame_annotation',
      });
      channel.log(
        'read_file',
        `[bundle:${doc.id}] video annotation queued for vision: ${a.path} @ ${tsLabel}`,
      );
    }
    const stamps = sorted
      .map((a) => typeof a.frameTimestampMs === 'number' ? _formatVideoTs(a.frameTimestampMs) : '?')
      .join(', ');
    note = ` ${sorted.length} per-frame annotation${sorted.length === 1 ? '' : 's'} queued ` +
      `(timestamps: ${stamps}). Each is a composite labelled "[ANNOTATIONS @ MM:SS.ms]" — ` +
      'interpret the marks and translate them into a SPECIFIC generate_video prompt that ' +
      'names what to keep, what to remove, and what to change at each marked region.';
  }

  // Reference paths — surface them in the return message so the agent
  // can forward the paths to generate_image without having to inspect
  // each image visually. Intentionally NOT queued to vision.
  const refs = Array.isArray(bundle?.references) ? bundle.references : [];
  if (refs.length > 0) {
    const refList = refs.map((r, i) => `  ${i + 1}. ${r.path}`).join('\n');
    note += ` ${refs.length} reference source(s) available in the bundle for downstream tools:\n${refList}`;
    channel.log(
      'read_file',
      `[bundle:${doc?.id}] ${refs.length} reference(s) listed (not vision-queued): ${refs.map((r) => path.basename(r.path)).join(', ')}`,
    );
  }

  return note;
}

/**
 * Queue the active working-area document (image, web screenshot, or
 * video) for the next LLM turn as a vision input, and queue every
 * annotation in the bundle as additional vision inputs preceded by
 * captions marking them as user markup. This is used both for the URL
 * branch (web tabs) and as a follow-up after reading a file that happens
 * to be the active working-area document.
 */
async function _queueActiveDocumentForVision(doc, agent, originalRequestPath) {
  const session = agent?._activeSession;
  if (!session) {
    return {
      success: false,
      error: 'No active session — cannot queue document for vision.',
    };
  }

  // New contract: the document carries a [DocumentBundle] — one primary
  // resource, a list of annotations (one composite for images, one per
  // marked frame for videos), and a list of references. We queue PRIMARY
  // + ANNOTATIONS to vision (those are the images the agent needs to see
  // to understand intent). References are NOT auto-queued.
  const bundle = doc.bundle || null;
  const primaryPath = bundle?.primary?.path || doc.path;
  if (!primaryPath || !fs.existsSync(primaryPath)) {
    return {
      success: false,
      error: `Active document has no readable primary on disk (looked for: ${primaryPath || 'none'}).`,
    };
  }

  if (!session._pendingMcpImages) session._pendingMcpImages = [];

  // Skip pushing the primary to vision when it's a video file — vision
  // endpoints can't decode mp4/mov/etc., and the per-frame composites
  // already convey what the user is pointing at on the timeline.
  const primaryExt = path.extname(primaryPath).toLowerCase();
  const primaryIsVideo = _VIDEO_EXTS.has(primaryExt);
  if (!primaryIsVideo) {
    let srcMime, srcB64;
    try {
      const { readNormalisedImageForVision } = await import('../media/_normalize-image-for-vision.js');
      const norm = await readNormalisedImageForVision(primaryPath);
      srcMime = norm.mimeType;
      srcB64 = norm.base64;
      if (norm.converted) {
        const fmtMb = (n) => (n / (1024 * 1024)).toFixed(2);
        channel.log(
          'read_file',
          `[bundle:${doc.id}] primary normalised for vision: ${primaryPath} (${fmtMb(norm.originalBytes)}MB → ${fmtMb(norm.normalisedBytes)}MB)${norm.fromCache ? ' [cache]' : ''}`,
        );
      }
    } catch {
      const srcExt = primaryExt.slice(1);
      srcMime = srcExt === 'jpg' ? 'image/jpeg' : `image/${srcExt}`;
      srcB64 = fs.readFileSync(primaryPath).toString('base64');
    }
    session._pendingMcpImages.push({ mimeType: srcMime, data: srcB64, _debugPath: primaryPath });
    channel.log('read_file', `[bundle:${doc.id}] primary queued for vision: ${primaryPath}`);
  } else {
    channel.log(
      'read_file',
      `[bundle:${doc.id}] primary is video (${primaryExt}) — only annotation composites will be queued for vision`,
    );
  }

  const annotationNote = await _queueAnnotationsForVision(bundle, doc, session);

  const docKind = doc.url ? 'web' : (primaryIsVideo ? 'video' : 'image');
  const baseMsg = doc.url
    ? 'Active working-area web page attached for visual analysis.'
    : (primaryIsVideo
        ? 'Active working-area video — per-frame annotation composites attached for visual analysis.'
        : 'Active working-area image attached for visual analysis.');

  return {
    success: true,
    path: originalRequestPath,
    type: docKind,
    bundle: bundle || undefined,
    message: baseMsg + annotationNote,
  };
}

export default {
  type: 'read_file',
  intent: 'read_file',
  description: 'Read a file\'s contents. Supports text files, PDF files, images (PNG, JPG, GIF, WebP, …) and videos (MP4, MOV, WebM, …). For images, the file is attached as vision input — you will see it on your next response. For videos (MP4, MOV, WebM, …) the WHOLE video is attached natively — the model watches it as a single video block (motion + audio + every frame), so you can describe shots, timing, what happens, transcribe speech, etc. Large videos are auto-downscaled to fit; if a video is so huge it cannot fit even downscaled, read_file FAILS with a clear message (telling the user to trim/compress it) rather than degrading — it never silently falls back to a few frames. NEVER shell out to ffmpeg/ffprobe to "look at" a video — read_file IS how you watch it. For SCANNED PDFs (pages with no text layer), Tesseract OCR runs automatically with a shared worker across all pages; pass `language` to specify the language(s) (default "eng+spa"). The "path" field accepts: an absolute or relative file path, an attachment ID (e.g. "att-1"), or a `@mention` handle (e.g. "@hero_script", "@tom") — `@`-handles resolve via the cross-project MediaLibrary to the most-recent asset (image / video / audio / document) tagged with that handle, so you NEVER have to look up the physical path yourself. Fields: "path" (file path / att-N / @handle), optional "offset" (start line, 1-based, default 1), optional "limit" (number of lines, default 2000), optional "pages" (page range for PDFs), optional "language" (OCR language for scanned PDFs — string or array, e.g. "spa" or ["spa","eng"]). If path is a directory, lists its contents.',
  instructions: `read_file rules:
- For text files, prefer 50-150 lines per read with offset + limit
- 200-line soft cap per read, UNLESS the task genuinely needs the whole file (e.g. a small config / prompt / script you must read end-to-end, a search where you don't know where the answer lives, generating a full review/edit). In that case omit limit (or set it high) and read the whole file in one go — paginating just to satisfy the cap wastes turns
- For large files (>500 lines), still paginate: read targeted ranges with offset + limit, don't dump the whole thing
- For images (.png, .jpg, .gif, .webp): just call read_file with the path — the image will be attached for visual analysis on your next turn.
- For videos (.mp4, .mov, .webm, …): read_file attaches the WHOLE video natively — the model watches it (motion + audio + every frame), same UX as reading an image, just call read_file with the path. Large files are auto-downscaled to fit. Treat it as "you've now actually watched the video." NEVER use shell/ffmpeg/ffprobe to detect cuts, extract frames, or otherwise "inspect" a video — that is exactly what read_file does for you, natively and better.
- \`@mention\` handles work directly: \`intent: read_file\` with \`path: "@hero_script"\` resolves the handle via the cross-project MediaLibrary to the most recent tagged asset. Do NOT enumerate the library by hand to look up the path first — the resolver does it for you. Same for \`@tom\` (image), \`@narrator\` (audio), etc.`,
  thinkingHint: (action) => `Reading ${action.path ? path.basename(action.path) : 'file'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read. Accepts: an absolute or relative path; an attachment ID (e.g. "att-1") for an attached file; OR a `@mention` handle (e.g. "@hero_script", "@tom") resolved via the cross-project MediaLibrary to the most recent asset tagged with that handle. Use the `@`-form when you have already named an asset (via tag_media or right-click) — it is the stable identity across sessions and projects.' },
      offset: { type: 'number', description: 'Start reading from this line number (1-based, optional)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
      pages: { type: 'string', description: 'Optional page range for PDF files (e.g. "1-5", "3", "10-20"). Only for .pdf files. No hard page cap — use `limit` to bound output by line count instead, or omit both to read the whole PDF. For SCANNED PDFs that need OCR, prefer scoping via `pages` or `limit` because OCR takes ~3s per page (a 100-page scan = ~5 min).' },
      language: { description: 'OCR language(s) for SCANNED PDFs (pages with no text layer). Tesseract ISO-639-3 codes. Accepts a single string ("spa") or an array (["spa","eng"]) — multiple languages are loaded together (faster than picking one wrong). Default ["eng","spa"]. Examples: "spa" for Spanish-only, "eng+deu" or ["eng","deu"] for English+German, "fra" for French. Ignored on PDFs that already have a text layer.' }
    },
    required: ['path']
  },

  examples: [
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js' },
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js', offset: 10, limit: 50 },
    { actionType: 'direct', intent: 'read_file', path: 'docs/manual.pdf', pages: '1-5' },
    { actionType: 'direct', intent: 'read_file', path: 'docs/escritura-judicial.pdf', language: 'spa' },
    { actionType: 'direct', intent: 'read_file', path: 'assets/screenshot.png' }
  ],

  async execute(action, agent) {
    let filePath = action.path;
    if (!filePath) throw new Error('read_file: "path" field is required');

    // URL branch — the system prompt tells the agent to read the active
    // working-area document with its `path or url`. For web tabs that means
    // read_file gets an http(s) URL, which is obviously not a file on disk.
    // Resolve it through the open-documents store: if the URL matches an
    // open web tab, queue the GUI-captured screenshot (and any annotation
    // overlay the user has drawn) for vision, then return.
    if (/^https?:\/\//i.test(filePath)) {
      try {
        const { openDocumentsStore } = await import('../../state/open-documents-store.js');
        const doc = openDocumentsStore.findInSnapshotByPathOrUrl(filePath);
        if (!doc) {
          return {
            success: false,
            error: `URL "${filePath}" is not an open working-area document. Use web_fetch for arbitrary URLs.`,
          };
        }
        const queued = await _queueActiveDocumentForVision(doc, agent, filePath);
        if (queued.success) return queued;
        return queued;
      } catch (err) {
        return { success: false, error: `Failed to read active web document: ${err.message}` };
      }
    }

    // Resolve attachment IDs (att-N) transparently via the attachment registry.
    // Agents reference attachments by ID; read_file resolves them to actual paths.
    if (/^att-\d+$/.test(filePath)) {
      try {
        const { attachmentRegistry } = await import('../../state/attachment-registry.js');
        const resolved = attachmentRegistry.resolve(filePath);
        if (!resolved) {
          return { success: false, error: `Attachment not found: ${filePath}. Use a valid attachment ID (e.g. att-1).` };
        }
        filePath = resolved;
      } catch {
        return { success: false, error: `Could not resolve attachment ID: ${filePath}` };
      }
    }

    // Resolve `@mention` handles transparently via the cross-project
    // MediaLibrary. Same model the chat input bar's `@`-autocomplete
    // uses: most-recent asset wins when several rows share the handle,
    // so the agent and user share intuition. Helper centralised in
    // `_resolve-mention-path.js` so write_file / edit_file etc. share
    // the exact same contract.
    {
      const { resolveMentionPath } = await import('./_resolve-mention-path.js');
      const r = await resolveMentionPath(filePath);
      if (!r.ok) return { success: false, error: `read_file: ${r.error}` };
      if (r.resolved) {
        channel.log(
          'read_file',
          `mention "${filePath}" → ${r.mediaType || 'unknown'} ${r.path}` +
            (r.matchCount > 1 ? ` (newest of ${r.matchCount} matches)` : ''),
        );
        filePath = r.path;
      }
    }

    let resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    // Check directory permission
    const permissions = getFilePermissions(agent);
    const targetDir = fs.statSync(resolvedPath).isDirectory() ? resolvedPath : path.dirname(resolvedPath);

    if (!permissions.isAllowed(resolvedPath, 'read')) {
      channel.clearProgress();
      const agentName = agent?.name || 'Agent';
      const _dirBase = path.basename(path.dirname(resolvedPath));
      const value = await channel.select('', [
        { title: t('permYes'), value: 'yes' },
        { title: `${t('permAlwaysAllow')} (${_dirBase}/)`, value: 'always' },
        { title: t('permNo'), value: 'no' }
      ], 0, { meta: {
        type: 'bash',
        header: `${agentName} ${t('wantsToRead')}`.replace(':', ''),
        command: `Read(${filePath})`,
        // Tell the GUI this is a READ-category permission so the
        // dialog title reads "Allow Braxil to read files…" instead
        // of the generic "Allow Braxil to run a command on your
        // computer?" (which makes a file read look like an
        // arbitrary shell exec — confusing when the displayed
        // "command" is a bare directory path).
        permissionCategory: 'READ',
      } });

      if (value === 'always') {
        permissions.allowProject(resolvedPath);
      } else if (value !== 'yes') {
        return { success: false, denied: true, message: 'User denied file access' };
      }
    }

    const stat = fs.statSync(resolvedPath);
    // Record that the agent has actually LOOKED at this file, so media tools can
    // enforce read-before-use (you can't animate / reference an image you never
    // opened). Files only — listing a directory isn't "reading" an image.
    if (!stat.isDirectory()) markRead(resolvedPath);
    if (stat.isDirectory()) {
      // Creation-dir guard: LISTING a shared `.koi` creation dir
      // (timelines/storyboards/images/videos/renders) is forbidden — it
      // surfaces other sessions'/projects' files. Reading a SPECIFIC file
      // inside one (the path a recall tool returned) stays allowed; this
      // branch only fires for a directory target.
      const _hit = creationDirHit(resolvedPath);
      if (_hit) return creationDirBlockedError('read_file', _hit, filePath);

      const entries = fs.readdirSync(resolvedPath);
      const listing = entries.map(e => {
        const full = path.join(resolvedPath, e);
        try {
          const s = fs.statSync(full);
          return s.isDirectory() ? `${e}/` : e;
        } catch {
          return e;
        }
      });
      return { success: true, path: filePath, type: 'directory', entries: listing };
    }

    // --- Timeline support (vision via render or single-clip shortcut) ---
    // A timeline is a JSON description of clips on tracks; reading it as
    // raw text gives the agent metadata but ZERO knowledge of what the
    // video actually shows. So we transparently turn the timeline into a
    // viewable video and feed THAT to the vision pipeline:
    //   (a) If a clip is selected (selectedClipId from the working-area
    //       snapshot) AND it's a video clip → read the clip's source
    //       video directly. The agent's intent is scoped to that clip.
    //   (b) Else if the timeline contains exactly one video clip → take
    //       the same shortcut on that single clip — saves a render pass
    //       on the common "single clip on V1 + audio on A1" timeline.
    //   (c) Else → render the whole timeline to a cached mp4 (sha1 of
    //       the JSON content). The cache lives in
    //       `~/.koi/cache/timeline-renders/<id>-<hash>.mp4` and survives
    //       restarts; identical content reuses the cache instead of
    //       re-rendering. Then read that mp4 as a normal video.
    let _fromTimelineRedirect = false;
    if (_isTimelineFile(resolvedPath)) {
      channel.log('read_file', `[timeline] detected ${path.basename(resolvedPath)}, resolving renderable video…`);
      const tlBranch = await _resolveTimelineForRead(resolvedPath, agent);
      if (tlBranch?._error) {
        channel.log('read_file', `[timeline] resolution failed: ${tlBranch._error}`);
        return { success: false, error: tlBranch._error };
      }
      if (tlBranch?.redirectPath) {
        // Fall through with the resolved video path so the existing
        // video branch handles vision sampling. Preserve the original
        // timeline path only in the log for traceability.
        channel.log('read_file', `[timeline] ${path.basename(resolvedPath)} → ${tlBranch.reason}: ${tlBranch.redirectPath}`);
        resolvedPath = tlBranch.redirectPath;
        filePath = tlBranch.redirectPath;
        _fromTimelineRedirect = true;
      } else if (tlBranch?.rawJsonFallback) {
        // Render not possible → serve the timeline's raw JSON below (the
        // normal text-read path). The structure is what edit intents need.
        channel.log('read_file', `[timeline] ${tlBranch.note}`);
      } else {
        channel.log('read_file', `[timeline] no redirect produced — falling through to raw-text read (likely a bug)`);
      }
    }

    // --- Video support (vision) ---
    // Three paths in priority order:
    //   (1) Active working-area video → route through the bundle helper
    //       so per-frame annotation composites land at the LLM with
    //       `[ANNOTATIONS @ MM:SS.ms]` captions.
    //   (2) Off-canvas video on a session that has video-input models
    //       in the catalog → upload the whole file as a base64 data URL
    //       (`video_url` content block per OpenRouter's multimodal
    //       spec). Gemini 2.5/3.x picks it up natively; flagging the
    //       session with `_hasVideoAttachments` forces the auto-
    //       selector to pick a Gemini model on the next turn.
    //   (3) Fallback: ffmpeg-sample N evenly-spaced JPEG frames if
    //       (a) no session, (b) the bundled ffmpeg can't read the
    //       file's metadata, or (c) the file is too big to upload as a
    //       base64 video block (>20MB).
    if (_VIDEO_EXTS.has(path.extname(resolvedPath).toLowerCase())) {
      // When we got here via the timeline redirect, skip the working-
      // area-doc shortcut and go straight to the upload path. Reason:
      // the redirect target is the underlying clip file, which OFTEN
      // also exists as a sibling video tab in the working area with
      // an empty bundle. The bundle helper would then return success
      // with ZERO sampled frames ("primary is video, only annotation
      // composites will be queued") and the agent gets nothing — the
      // exact opposite of why the user asked us to read the timeline.
      if (!_fromTimelineRedirect) {
        try {
          const { openDocumentsStore } = await import('../../state/open-documents-store.js');
          const doc = openDocumentsStore.findInSnapshotByPathOrUrl(resolvedPath) ||
                      openDocumentsStore.findInSnapshotByPathOrUrl(filePath);
          if (doc) {
            return await _queueActiveDocumentForVision(doc, agent, filePath);
          }
        } catch { /* store unavailable — fall through to upload / sampling */ }
      }

      const session = agent?._activeSession;
      if (session) {
        // (2) Try the native video-upload path first. The bytes go up
        // as `data:video/...;base64,…` in a `video_url` content block;
        // the auto-selector picks a Gemini model that natively
        // understands video.
        const totalDurMs = await _probeVideoDurationMs(resolvedPath);
        const totalDurSec = totalDurMs != null ? (totalDurMs / 1000) : null;
        // base64 inflates raw bytes by ~33% and Gemini's inline request cap
        // is ~20 MB total, so keep the RAW upload under ~14 MB. Videos over
        // that are DOWNSCALED with ffmpeg (analysis doesn't need full quality)
        // and STILL sent whole — only if even the smallest transcode won't fit
        // do we degrade to sampled frames.
        const _TARGET_RAW_BYTES = 14 * 1024 * 1024;
        try {
          const origBytes = fs.statSync(resolvedPath).size;
          let uploadPath = resolvedPath;
          let uploadBytes = origBytes;
          let downscaled = false;
          if (origBytes > _TARGET_RAW_BYTES) {
            const reduced = await _transcodeVideoForUpload(resolvedPath, _TARGET_RAW_BYTES);
            if (reduced && reduced.bytes <= _TARGET_RAW_BYTES) {
              uploadPath = reduced.path;
              uploadBytes = reduced.bytes;
              downscaled = true;
            }
          }
          if (uploadBytes <= _TARGET_RAW_BYTES) {
            const srcExt = path.extname(uploadPath).slice(1).toLowerCase();
            const mimeType =
              downscaled ? 'video/mp4' :
              srcExt === 'mp4' ? 'video/mp4' :
              srcExt === 'mov' ? 'video/mp4' : // OR sends mov as mp4-compat
              srcExt === 'webm' ? 'video/webm' :
              srcExt === 'mpeg' || srcExt === 'mpg' ? 'video/mpeg' :
              `video/${srcExt}`;
            const data = fs.readFileSync(uploadPath).toString('base64');
            // Best-effort cleanup of the transcoded temp file once read.
            if (downscaled) { try { fs.unlinkSync(uploadPath); } catch { /* */ } }
            if (!session._pendingMcpVideos) session._pendingMcpVideos = [];
            session._pendingMcpVideos.push({
              mimeType,
              data,
              _debugPath: resolvedPath,
              role: 'video_full',
            });
            // Force the selector to pick a model with inputVideo:true
            // (Gemini family) on the next turn.
            session._hasVideoAttachments = true;
            channel.log(
              'read_file',
              `Video attached for native video input (${Math.round(uploadBytes / 1024)}KB${downscaled ? `, downscaled from ${Math.round(origBytes / 1024)}KB` : ''}, ${mimeType}): ${filePath}` +
              (totalDurSec != null ? ` — duration ${totalDurSec.toFixed(2)}s` : ''),
            );
            const durationHint = totalDurSec != null
              ? ` Total video duration: **${totalDurSec.toFixed(2)} seconds** — use this exact value for any \`durationSeconds\` parameter on follow-up calls (generate_audio, etc.).`
              : '';
            return {
              success: true,
              path: filePath,
              type: 'video',
              attachedAs: 'video_url',
              sizeBytes: origBytes,
              ...(downscaled ? { downscaledBytes: uploadBytes } : {}),
              ...(totalDurMs != null ? { durationMs: totalDurMs, durationSec: totalDurSec } : {}),
              message: `Video attached natively for visual analysis on the next turn — you will see it as a single video block (motion + audio + frames intact)${downscaled ? ', downscaled for size — quality reduced but the full timeline is intact' : ''}.${durationHint}`,
            };
          }
        } catch (e) {
          channel.log('read_file', `[video] native upload path failed: ${e?.message || e}`);
          return {
            success: false,
            type: 'video',
            error: `Could not attach "${path.basename(filePath)}" for analysis (${e?.message || e}). Surface this to the user; do NOT fall back to ffmpeg/shell to inspect the video.`,
          };
        }

        // Too large to send whole, even after maximum downscaling → FAIL
        // CLEARLY. We deliberately do NOT degrade to sampled frames: a few
        // stills can't answer shot-by-shot / temporal questions, so an honest
        // failure the user can act on (trim / pre-compress) beats a misleading
        // partial result.
        const _durLabel = totalDurSec != null ? `${totalDurSec.toFixed(0)}s long` : 'of unknown length';
        return {
          success: false,
          type: 'video',
          tooLarge: true,
          ...(totalDurMs != null ? { durationMs: totalDurMs, durationSec: totalDurSec } : {}),
          error: `The video "${path.basename(filePath)}" (${_durLabel}) is too large to analyse even after maximum downscaling — it exceeds the model's ~20 MB native-video input limit. Tell the user the clip is too big/long to analyse as-is and ask them to trim it to a shorter segment or pre-compress it. Do NOT fall back to ffmpeg frame extraction or any other tool.`,
        };
      }
      return {
        success: false,
        error: `Could not read "${filePath}" — the file is unreadable (corrupt, unsupported codec, or empty). Surface the failure to the user; do NOT fall back to a different tool.`,
      };
    }

    // --- Audio support (metadata only — never raw bytes) ---
    // Audio files are binary; dumping them as "text" produces a wall of
    // garbage that wastes the agent's tokens AND confuses it. Instead
    // we return structured metadata (size, duration, codec, sample
    // rate, …) so the agent can reason about the file without ever
    // touching the raw bytes. If the agent needs the actual content
    // (transcription, lipsync driving, …) it should call the dedicated
    // tool (generate_audio mode=transcribe, generate_video avatar mode, …).
    if (_AUDIO_EXTS.has(path.extname(resolvedPath).toLowerCase())) {
      const stat = fs.statSync(resolvedPath);
      const ext = path.extname(resolvedPath).slice(1).toLowerCase();
      const meta = await _probeAudioMetadata(resolvedPath);
      const sizeKb = Math.round(stat.size / 1024);
      const _metaFields = meta ? {
        durationSec: meta.durationSec,
        durationFormatted: meta.durationSec != null ? _formatDuration(meta.durationSec) : null,
        bitRateKbps: meta.bitRateKbps,
        codec: meta.codec,
        sampleRateHz: meta.sampleRateHz,
        channels: meta.channels,
        channelLayout: meta.channels === 1 ? 'mono'
          : meta.channels === 2 ? 'stereo'
          : meta.channels ? `${meta.channels}-channel`
          : null,
        formatName: meta.formatName,
      } : {
        probe: 'unavailable',
        probeHint: 'ffprobe not found — install ffmpeg locally to surface duration / codec / sample rate; the file itself is fine.',
      };

      // Native audio input: attach the bytes so an audio-capable model (Gemini)
      // HEARS the clip on the next turn — same UX as reading an image. The
      // auto-selector is forced onto an inputAudio:true model. Non-mp3/wav is
      // transcoded to mp3 first (Telegram voice = OGG/Opus).
      const session = agent?._activeSession;
      if (session) {
        try {
          const { attachAudioFileToSession } = await import('../../llm/attach-audio.js');
          const r = await attachAudioFileToSession(session, resolvedPath);
          if (r.ok) {
            channel.log('read_file', `Audio attached for native audio input (${sizeKb}KB${r.transcoded ? `, transcoded to ${r.format}` : ''}): ${filePath}`);
            return {
              success: true,
              path: filePath,
              type: 'audio',
              attachedAs: 'input_audio',
              format: ext,
              sizeBytes: stat.size,
              sizeKb,
              modified: stat.mtime.toISOString(),
              ..._metaFields,
              message: `Audio attached natively — you will HEAR it on your next turn as an audio block${r.transcoded ? ` (transcoded to ${r.format} for compatibility)` : ''}. No transcription step needed; just respond to what you hear.`,
            };
          }
          channel.log('read_file', `[audio] native attach skipped (${r.reason}) — returning metadata + transcribe hint: ${filePath}`);
        } catch (e) {
          channel.log('read_file', `[audio] native attach failed (${e?.message || e}) — returning metadata + transcribe hint`);
        }
      }

      // Fallback (no session, too large, or attach failed): metadata only.
      return {
        success: true,
        path: filePath,
        type: 'audio',
        format: ext,
        sizeBytes: stat.size,
        sizeKb,
        modified: stat.mtime.toISOString(),
        ..._metaFields,
        hint: 'Audio could not be attached natively (too large or no audio-capable model). To get its content, call transcribe_audio with this path. To drive an avatar video, pass the path as audioFile to generate_video (avatar mode).',
      };
    }

    // --- Image support (vision) ---
    // Keep .bmp/.svg/etc in the accepted-extensions list so the agent
    // can point read_file at them — normalizeImageForProvider transcodes
    // to PNG before the bytes reach the LLM. Vision endpoints
    // (OpenAI/Azure, Gemini) only accept jpeg/png/gif/webp and reject
    // anything else with a cryptic 400; sharp decoding also acts as a
    // validity check, catching the common "web_fetch saved an HTML
    // error page with a .jpg extension" trap that otherwise explodes as
    // "The image data you provided does not represent a valid image".
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif', '.tif', '.tiff', '.avif'];
    if (IMAGE_EXTS.includes(path.extname(resolvedPath).toLowerCase())) {
      // Use the VISION-optimised normaliser (max edge 2048, JPEG q=85,
      // alpha flattened, EXIF stripped). The earlier path used the
      // GENERATION normaliser which preserves bytes — fine for image-
      // gen providers, ruinous for vision: a 5504×3072 PNG straight out
      // of generate_image is ~17 MB, four of them in one parallel
      // read_file batch hit the LLM gateway as ~70 MB of base64 →
      // 413 "Payload Too Large" → agent retries the same payload →
      // infinite loop. The vision normaliser caps the payload at a
      // size every modern endpoint can swallow without changing what
      // the model sees (they downscale internally to ≤2048 anyway).
      const { readNormalisedImageForVision } = await import('../media/_normalize-image-for-vision.js');
      let normalised;
      try {
        normalised = await readNormalisedImageForVision(resolvedPath);
      } catch (err) {
        return {
          success: false,
          error: `Could not read "${filePath}" as an image: ${err.message || err}. Common causes: the file is actually HTML (e.g. web_fetch saved an error page), the file is corrupt, or the format is unsupported. Inspect it with shell (\`file <path>\` / \`wc -c <path>\`) before retrying.`,
        };
      }
      const b64 = normalised.base64;
      const mime = normalised.mimeType;
      if (normalised.converted) {
        const fmtMb = (n) => (n / (1024 * 1024)).toFixed(2);
        channel.log(
          'read_file',
          `Image normalised for vision: ${filePath} (${fmtMb(normalised.originalBytes)}MB → ${fmtMb(normalised.normalisedBytes)}MB)${normalised.fromCache ? ' [cache]' : ''}`,
        );
      }

      // Queue the image for the next LLM turn as a vision input.
      const session = agent?._activeSession;
      if (session) {
        if (!session._pendingMcpImages) session._pendingMcpImages = [];
        session._pendingMcpImages.push({ mimeType: mime, data: b64, _debugPath: filePath });
        channel.log('read_file', `Image queued for vision: ${filePath}`);

        // If this image is also the active working-area document AND the
        // tab carries a [DocumentBundle] (annotations / references), queue
        // each annotation right after the primary so the LLM sees them as
        // a sequence. References are listed in the return message but NOT
        // queued to vision — generate_image forwards them separately as
        // referenceImages, so the agent doesn't need to inspect each
        // cutout source visually to reason about the edit.
        let annotationNote = '';
        let matchedDoc = null;
        try {
          const { openDocumentsStore } = await import('../../state/open-documents-store.js');
          const doc = openDocumentsStore.findInSnapshotByPathOrUrl(resolvedPath) ||
                      openDocumentsStore.findInSnapshotByPathOrUrl(filePath);
          matchedDoc = doc;
          if (doc) {
            annotationNote = await _queueAnnotationsForVision(doc.bundle || null, doc, session);
          }
        } catch { /* store unavailable — ignore */ }

        return {
          success: true,
          path: filePath,
          type: 'image',
          bundle: matchedDoc?.bundle || undefined,
          message: `Image loaded and attached for visual analysis. You will see the image on your next response.${annotationNote}`
        };
      }
      // Fallback: no agent available, return base64 directly
      return {
        success: true,
        path: filePath,
        type: 'image',
        mimeType: mime,
        base64: b64,
        message: 'Image data returned as base64.'
      };
    }

    // --- PDF support ---
    if (resolvedPath.toLowerCase().endsWith('.pdf')) {
      try {
        // Polyfill DOM APIs that pdfjs requires even for text extraction.
        // Must be set BEFORE import() — pdfjs accesses them at module load time.
        _ensurePdfjsPolyfills();

        // Load pdfjs-dist. Direct import works in dev; in pkg binary, pdfjs-dist
        // is ESM-only so neither require() nor import() work from the snapshot.
        // Fallback: extract the .mjs file to a real disk cache and import from there.
        let pdfjsLib;
        try {
          pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        } catch {
          pdfjsLib = await _loadPdfjsFromCache();
        }
        // Suppress benign "standardFontDataUrl" warnings from pdfjs
        pdfjsLib.VerbosityLevel && pdfjsLib.setVerbosityLevel?.(0);
        const dataBuffer = fs.readFileSync(resolvedPath);
        const uint8Array = new Uint8Array(dataBuffer);

        const doc = await pdfjsLib.getDocument({ data: uint8Array, verbosity: 0 }).promise;
        const totalPages = doc.numPages;

        // Parse page range if provided. No hard page cap — the model
        // decides scope via `pages` (explicit range) and/or `limit`
        // (max output lines, with early-exit inside the page loop so
        // scanned PDFs don't keep OCR'ing after the limit is reached).
        // Omitting both reads the whole PDF.
        let pagesToRead = [];
        if (action.pages) {
          const ranges = String(action.pages).split(',').map(r => r.trim());
          const pageSet = new Set();
          for (const r of ranges) {
            if (r.includes('-')) {
              const [startStr, endStr] = r.split('-');
              const start = parseInt(startStr, 10);
              const end = parseInt(endStr, 10);
              if (!isNaN(start) && !isNaN(end)) {
                for (let p = start; p <= Math.min(end, totalPages); p++) pageSet.add(p);
              }
            } else {
              const p = parseInt(r, 10);
              if (!isNaN(p) && p >= 1 && p <= totalPages) pageSet.add(p);
            }
          }
          pagesToRead = [...pageSet].sort((a, b) => a - b);
        } else {
          for (let i = 1; i <= totalPages; i++) pagesToRead.push(i);
        }

        // Normalise the `language` param for OCR. Accepts:
        //   - missing (default ["eng","spa"] — covers the common cases here),
        //   - string "spa", "spa+eng", or comma-separated "spa,eng",
        //   - array ["spa","eng"].
        // Multi-language packs load once, recognise together — picking the
        // wrong single language returns garbage, multi-loading is fast.
        const _userLang = action.language;
        let _ocrLangs;
        if (Array.isArray(_userLang)) {
          _ocrLangs = _userLang.map(s => String(s).trim()).filter(Boolean);
        } else if (typeof _userLang === 'string' && _userLang.trim()) {
          _ocrLangs = _userLang.split(/[+,\s]+/).map(s => s.trim()).filter(Boolean);
        } else {
          _ocrLangs = ['eng', 'spa'];
        }
        if (_ocrLangs.length === 0) _ocrLangs = ['eng'];
        const _tesseractLangStr = _ocrLangs.join('+');

        // Pre-scan: detect a "fully scanned" PDF before walking every page,
        // so we can (a) warn the user about the expected OCR runtime and
        // (b) spin a SINGLE Tesseract worker reused across all pages —
        // creating one worker per page on an 88-page scan wastes ~3 min in
        // init alone (the user-reported bug). Sample up to 3 pages from the
        // requested range; if NONE has a text layer, treat the PDF as a
        // scan and prepare the worker. Pages with a real text layer fall
        // through the same loop unaffected — they just skip OCR.
        const _OCR_TEXT_THRESHOLD = 30; // chars per page below which we treat the page as "needs OCR"
        const _sampleIdxs = pagesToRead.length <= 3
          ? pagesToRead
          : [pagesToRead[0], pagesToRead[Math.floor(pagesToRead.length / 2)], pagesToRead[pagesToRead.length - 1]];
        let _samplePagesWithText = 0;
        for (const _pn of _sampleIdxs) {
          try {
            const _pg = await doc.getPage(_pn);
            const _tc = await _pg.getTextContent();
            const _txt = _tc.items.map(i => i.str || '').join('').trim();
            if (_txt.length >= _OCR_TEXT_THRESHOLD) _samplePagesWithText += 1;
          } catch { /* skip — non-fatal */ }
        }
        const _isScannedPdf = _samplePagesWithText === 0 && pagesToRead.length > 0;

        // ── Result cache for OCR'd pages ──────────────────────────
        // Hash the PDF bytes + the requested OCR language(s) and use
        // the pair as the cache key. Re-reading the same PDF (same
        // content + same lang) in any later session — or even just a
        // few minutes later in the same session — pulls per-page OCR
        // text from disk instead of re-running Tesseract for ~3 sec
        // per page. The cache supports PARTIAL hits: a previous run
        // that OCR'd pages 1-20 with `pages: "1-20"` populates only
        // those entries; a later "whole PDF" read OCR's just the
        // missing tail and merges the new pages back into the cache.
        const _fileHash = crypto.createHash('sha256').update(dataBuffer).digest('hex');
        const _safeLang = _tesseractLangStr.replace(/[+,\s]/g, '-');
        const _ocrResultsCacheDir = path.join(os.homedir(), '.koi', 'ocr-cache');
        const _ocrResultsCacheFile = path.join(_ocrResultsCacheDir, `${_fileHash}__${_safeLang}.json`);
        let _ocrResultsCache = { version: 1, hash: _fileHash, language: _tesseractLangStr, pages: {} };
        try {
          if (fs.existsSync(_ocrResultsCacheFile)) {
            const _raw = fs.readFileSync(_ocrResultsCacheFile, 'utf8');
            const _parsed = JSON.parse(_raw);
            if (_parsed && typeof _parsed === 'object' && _parsed.pages && typeof _parsed.pages === 'object') {
              _ocrResultsCache = _parsed;
              channel.log('read_file', `OCR cache hit for "${path.basename(filePath)}" (${Object.keys(_parsed.pages).length} page(s) cached) at ${_ocrResultsCacheFile}`);
            }
          }
        } catch (err) {
          channel.log('read_file', `OCR cache read failed (${err.message}); proceeding without cache`);
        }
        let _ocrResultsCacheChanged = false;

        // How many of the requested pages still need real OCR work?
        // (Used to size the banner / decide whether to spin a worker.)
        const _uncachedPagesToOcr = _isScannedPdf
          ? pagesToRead.filter((p) => typeof _ocrResultsCache.pages[String(p)] !== 'string')
          : [];

        let _ocrWorker = null;
        let _ocrCachePath = null;
        let _ocrBannerId = null;
        if (_isScannedPdf && _uncachedPagesToOcr.length === 0) {
          // Every requested page is in cache. Skip worker init AND the
          // progress banner entirely — the loop below will just pull
          // text from `_ocrResultsCache` page by page (instantaneous).
          channel.log('read_file', `All ${pagesToRead.length} requested page(s) of "${path.basename(filePath)}" are in OCR cache — skipping Tesseract entirely.`);
        } else if (_isScannedPdf) {
          _ocrCachePath = path.join(os.homedir(), '.koi', 'tesseract-data');
          try { fs.mkdirSync(_ocrCachePath, { recursive: true }); } catch { /* */ }
          const _cachedHits = pagesToRead.length - _uncachedPagesToOcr.length;
          const _estSec = Math.ceil(_uncachedPagesToOcr.length * 3);
          channel.log(
            'read_file',
            `PDF "${path.basename(filePath)}" appears to be a scan. ` +
            `OCR'ing ${_uncachedPagesToOcr.length}/${pagesToRead.length} requested page(s) with lang=${_tesseractLangStr}` +
            (_cachedHits > 0 ? ` (${_cachedHits} already in cache)` : '') +
            ` — estimated ~${_estSec}s.` +
            (totalPages > pagesToRead.length
              ? ` Pass \`pages: "1-${pagesToRead.length}"\` to scope.`
              : ''),
          );
          // User-visible progress banner — without this an 80-page OCR
          // looks like a frozen tool for 4–5 minutes. Reuses the same
          // media-banner channel the image / video / audio generators
          // use, so the GUI renders the familiar progress card with
          // elapsed time + estimated duration. We emit it ourselves
          // (not via `bannerKind`) because we only want the banner for
          // the SCANNED-PDF path, not for every read_file call.
          _ocrBannerId = `read_file-pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          try {
            channel.mediaToolStart({
              id: _ocrBannerId,
              intent: 'read_file',
              kind: 'document',
              label: `Scanning PDF — ${_uncachedPagesToOcr.length} page${_uncachedPagesToOcr.length === 1 ? '' : 's'} (${_tesseractLangStr})`,
              iconId: 'read_file',
              expectedDurationMs: _uncachedPagesToOcr.length * 3000,
            });
          } catch { /* observability — banner is nice-to-have */ }
          try {
            _ocrWorker = await Tesseract.createWorker(_tesseractLangStr, undefined, {
              cachePath: _ocrCachePath,
              logger: () => { /* suppress per-page Tesseract progress spam */ },
            });
            try { await _ocrWorker.setParameters({ user_defined_dpi: '300' }); } catch { /* not all versions */ }
          } catch (err) {
            channel.log('read_file', `Tesseract worker init failed (${err.message}) — falling back to per-page Tesseract.recognize`);
            _ocrWorker = null;
          }
        }

        // Extract text and images from selected pages.
        // pdfjs items have a transform matrix where [5] is the Y coordinate.
        // When Y changes between items, it means a new line in the PDF layout.
        const pageTexts = [];
        const _pdfImages = []; // { page, index, width, height, path }
        const session = agent?._activeSession;
        const _pdfImgDir = path.join(os.tmpdir(), 'koi-pdf-images');

        let _ocrPagesDone = 0;
        let _earlyExitAtPage = null;
        for (const pageNum of pagesToRead) {
          const page = await doc.getPage(pageNum);
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(i => i.str !== undefined);
          const _itemsRawText = items.map(i => i.str || '').join('').trim();

          // Extract images from every page. Save to temp files so the model
          // can inspect them via read_file. Small sets (≤3 total) are auto-attached
          // as vision input; larger sets are listed so the model picks which to view.
          try {
            const images = await extractPdfPageImages(page, pdfjsLib);
            if (images.length > 0) {
              if (!fs.existsSync(_pdfImgDir)) fs.mkdirSync(_pdfImgDir, { recursive: true });
              for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
                const image = images[imgIdx];
                if (image.width < 50 || image.height < 50) continue;
                const imgPath = path.join(_pdfImgDir, `pdf-p${pageNum}-img${imgIdx}-${Date.now()}.png`);
                await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
                  .png().toFile(imgPath);
                _pdfImages.push({ page: pageNum, index: imgIdx, width: image.width, height: image.height, path: imgPath });
              }
            }

            // OCR fallback fires when the page's text layer is empty OR
            // suspiciously sparse (< 30 useful chars — typically just a
            // footer like "Page 1" or a watermark, never the real content).
            // The old gate required `items.length === 0` exactly, which
            // missed scanned PDFs that carry a one-line page number and
            // nothing else — Tesseract never ran, the agent saw "Page 1"
            // as the entire page, and assumed there was no body text.
            const _needsOcr = _itemsRawText.length < _OCR_TEXT_THRESHOLD;
            if (_needsOcr && images.length > 0) {
              // TODO: when extractPdfPageImages returns nothing on a
              // scanned page (rare: PDFs that wrap the scan in nested
              // form XObjects), render the page via pdfjs canvas to a
              // PNG and OCR that. Skipping for now — covers >95% of real
              // scans without adding canvas-backend deps.

              // Cache hit: this page was already OCR'd in a previous
              // read (same file content + same lang). Pull the text
              // from disk — instant, no Tesseract call.
              const _cachedText = _ocrResultsCache.pages[String(pageNum)];
              if (typeof _cachedText === 'string') {
                if (_cachedText.length > 0) {
                  pageTexts.push(`--- Page ${pageNum} (OCR cached, ${_tesseractLangStr}) ---\n${_cachedText}`);
                }
              } else {
                for (const image of images) {
                  const pngBuffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
                    .png().withMetadata({ density: 300 }).toBuffer();
                  try {
                    const { data } = _ocrWorker
                      ? await _ocrWorker.recognize(pngBuffer)
                      : await Tesseract.recognize(
                          pngBuffer,
                          _tesseractLangStr,
                          { cachePath: _ocrCachePath || path.join(os.homedir(), '.koi', 'tesseract-data'), user_defined_dpi: '300' },
                        );
                    const ocrText = data?.text ? data.text.trim() : '';
                    if (ocrText) pageTexts.push(`--- Page ${pageNum} (OCR, ${_tesseractLangStr}) ---\n${ocrText}`);
                    // Always cache the result — even an empty string
                    // is a useful signal ("OCR ran but found nothing"
                    // → don't try again on this page). When a page
                    // has multiple image XObjects we'd write each in
                    // turn; the last write wins, which is fine since
                    // the loop's text was already pushed to pageTexts.
                    _ocrResultsCache.pages[String(pageNum)] = ocrText;
                    _ocrResultsCacheChanged = true;
                  } catch (ocrErr) {
                    channel.log('read_file', `OCR failed on page ${pageNum}: ${ocrErr.message}`);
                  }
                }
              }
              _ocrPagesDone += 1;
              if (_isScannedPdf && (_ocrPagesDone % 10 === 0 || _ocrPagesDone === pagesToRead.length)) {
                channel.log('read_file', `OCR progress: ${_ocrPagesDone}/${pagesToRead.length} pages`);
              }
              // Push DETERMINATE progress to the banner. We know
              // exactly how many pages are done — feed the bar the
              // real fraction instead of letting the GUI animate
              // against the expectedDurationMs estimate.
              if (_ocrBannerId) {
                try {
                  channel.mediaToolStatus({
                    id: _ocrBannerId,
                    progress: _ocrPagesDone / pagesToRead.length,
                    progressLabel: `${_ocrPagesDone} / ${pagesToRead.length} pages`,
                  });
                } catch { /* observability */ }
              }
            }
          } catch (imgErr) {
            channel.log('read_file', `PDF image extraction failed on page ${pageNum}: ${imgErr.message}`);
          }

          if (!items.length) continue;

          let lines = [];
          let currentLine = '';
          let lastY = null;

          for (const item of items) {
            const y = item.transform ? item.transform[5] : null;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
              lines.push(currentLine);
              currentLine = item.str;
            } else {
              if (currentLine && item.str && !currentLine.endsWith(' ') && !item.str.startsWith(' ')) {
                currentLine += ' ' + item.str;
              } else {
                currentLine += item.str;
              }
            }
            if (y !== null) lastY = y;
          }
          if (currentLine) lines.push(currentLine);

          const pageText = lines.join('\n').trim();
          if (pageText) {
            pageTexts.push(`--- Page ${pageNum} ---\n${pageText}`);
          }

          // Early-exit when the caller passed an explicit `limit`: as
          // soon as the accumulated output reaches `offset + limit`
          // lines, stop walking pages. Skips OCR (expensive) and text
          // extraction on the tail of the PDF. When `limit` is omitted
          // the loop reads every page.
          if (typeof action.limit === 'number' && action.limit > 0) {
            const _accLines = pageTexts.reduce((acc, t) => acc + (t ? t.split('\n').length : 0), 0);
            const _cap = (action.offset && action.offset > 1 ? action.offset - 1 : 0) + action.limit;
            if (_accLines >= _cap) {
              if (pageNum < pagesToRead[pagesToRead.length - 1]) {
                _earlyExitAtPage = pageNum;
                if (_isScannedPdf) {
                  channel.log(
                    'read_file',
                    `Reached limit (${action.limit} lines) at page ${pageNum} — stopping early; ${pagesToRead.length - pagesToRead.indexOf(pageNum) - 1} page(s) skipped. ` +
                    `Pass a higher \`limit\` or \`pages: "${pageNum + 1}-${pagesToRead[pagesToRead.length - 1]}"\` to continue.`,
                  );
                }
              }
              break;
            }
          }
        }

        // Release the shared OCR worker (if we initialised one). Tesseract
        // workers hold WASM heap + native handles — leaving them dangling
        // grows memory across reads. Non-fatal if terminate() throws.
        if (_ocrWorker) {
          try { await _ocrWorker.terminate(); } catch { /* */ }
        }
        // Persist the OCR results cache so the next read of this PDF
        // (any session, any time) skips Tesseract entirely. Atomic
        // write to avoid leaving a half-written JSON if the process
        // dies mid-flush. Only persist when something actually
        // changed — pure cache-hit reads don't rewrite the file.
        if (_ocrResultsCacheChanged) {
          try {
            fs.mkdirSync(_ocrResultsCacheDir, { recursive: true });
            const _tmpFile = `${_ocrResultsCacheFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
            fs.writeFileSync(_tmpFile, JSON.stringify(_ocrResultsCache));
            fs.renameSync(_tmpFile, _ocrResultsCacheFile);
            channel.log('read_file', `OCR cache saved to ${_ocrResultsCacheFile} (${Object.keys(_ocrResultsCache.pages).length} page(s)).`);
          } catch (err) {
            channel.log('read_file', `OCR cache save failed (${err.message}); next read will re-OCR`);
          }
        }
        // Close the user-visible progress banner. We made it this far
        // without throwing, so report success. (If an error bubbled out
        // of the OCR loop the banner would dangle — acceptable; the
        // ReferenceError / read failure surfaces as a tool result and
        // the GUI clears its in-flight registry on the next turn.)
        if (_ocrBannerId) {
          try { channel.mediaToolEnd({ id: _ocrBannerId, ok: true }); } catch { /* */ }
        }

        // Handle PDF images: ≤3 → auto-attach for vision; >3 → list paths so model picks
        const _AUTO_ATTACH_MAX = 3;
        if (_pdfImages.length > 0) {
          const autoAttach = _pdfImages.length <= _AUTO_ATTACH_MAX;
          if (autoAttach && session) {
            if (!session._pendingMcpImages) session._pendingMcpImages = [];
            const { readNormalisedImageForVision } = await import('../media/_normalize-image-for-vision.js');
            for (const img of _pdfImages) {
              try {
                let imgB64, imgMime;
                try {
                  const norm = await readNormalisedImageForVision(img.path);
                  imgB64 = norm.base64;
                  imgMime = norm.mimeType;
                } catch {
                  imgB64 = fs.readFileSync(img.path).toString('base64');
                  const imgExt = path.extname(img.path).toLowerCase().slice(1) || 'png';
                  imgMime = imgExt === 'jpg' ? 'image/jpeg' : `image/${imgExt}`;
                }
                session._pendingMcpImages.push({ mimeType: imgMime, data: imgB64, _debugPath: img.path });
                channel.log('read_file', `PDF p${img.page} image auto-attached: ${img.path}`);
              } catch { /* skip unreadable images */ }
            }
          }
          const _imgLines = _pdfImages.map(i =>
            `  - Page ${i.page}, image ${i.index} (${i.width}×${i.height}): ${i.path}${autoAttach ? ' [attached]' : ''}`
          ).join('\n');
          const _header = autoAttach
            ? `--- Images (${_pdfImages.length}, attached for vision) ---`
            : `--- Images (${_pdfImages.length} found — use read_file to inspect) ---`;
          pageTexts.push(`${_header}\n${_imgLines}`);
        }

        const text = pageTexts.join('\n\n').trim();

        if (!text && _pdfImages.length === 0) {
          return { success: true, path: filePath, type: 'pdf', totalPages, content: '(No extractable text or images found in PDF.)', hint: 'This PDF has no text layer and no extractable images.' };
        }
        if (!text) {
          return { success: true, path: filePath, type: 'pdf', totalPages, content: `(No extractable text, but ${_pdfImages.length} image(s) attached for vision.)` };
        }

        // Apply line numbering and truncation. PDFs differ from text
        // files: when `limit` is omitted we return the WHOLE PDF (no
        // default cap), because the user opted into the cost by reading
        // a PDF and the page loop above already early-exited if the
        // caller did set a limit. The MAX_LINES default still applies
        // to regular text reads — see the earlier text branch.
        const allLines = text.split('\n');
        const MAX_LINE_LENGTH = 2000;
        const offset = Math.max(1, action.offset || 1);
        const limit = action.limit || allLines.length;
        const startIdx = offset - 1;
        const endIdx = Math.min(startIdx + limit, allLines.length);
        const selectedLines = allLines.slice(startIdx, endIdx);

        const numbered = selectedLines.map((line, i) => {
          const lineNum = String(startIdx + i + 1).padStart(5);
          const truncated = line.length > MAX_LINE_LENGTH
            ? line.substring(0, MAX_LINE_LENGTH) + '...'
            : line;
          return `${lineNum} ${truncated}`;
        }).join('\n');

        const wasTruncated = endIdx < allLines.length && !action.limit;

        return {
          success: true,
          path: filePath,
          type: 'pdf',
          totalPages,
          pagesRead: pagesToRead.join(', '),
          content: numbered,
          totalLines: allLines.length,
          from: offset,
          to: endIdx,
          ...(wasTruncated && { truncated: true, hint: `PDF text has ${allLines.length} lines. Use offset/limit to read more.` }),
          ...(_earlyExitAtPage !== null && {
            partial: true,
            hint: `Stopped at page ${_earlyExitAtPage} of ${pagesToRead[pagesToRead.length - 1]} because the line limit (${action.limit}) was reached. Pass a higher \`limit\` or \`pages: "${_earlyExitAtPage + 1}-${pagesToRead[pagesToRead.length - 1]}"\` to read the rest.`,
          }),
        };
      } catch (err) {
        return { success: false, error: `Failed to read PDF: ${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : ''}` };
      }
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const allLines = content.split('\n');

    const MAX_LINES = 2000;
    const MAX_LINE_LENGTH = 2000;

    const offset = Math.max(1, action.offset || 1);
    const limit = action.limit || MAX_LINES;
    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + limit, allLines.length);
    const selectedLines = allLines.slice(startIdx, endIdx);

    // Format with line numbers, truncating long lines
    const numbered = selectedLines.map((line, i) => {
      const lineNum = String(startIdx + i + 1).padStart(5);
      const truncated = line.length > MAX_LINE_LENGTH
        ? line.substring(0, MAX_LINE_LENGTH) + '...'
        : line;
      return `${lineNum} ${truncated}`;
    }).join('\n');

    const wasTruncated = endIdx < allLines.length && !action.limit;

    // If this file is the active working-area document and the GUI has
    // published a cursor/selection, attach it so the agent knows where the
    // user is pointing ("change this"). Only included for text-like types
    // the user can actually edit in place.
    let editor = null;
    try {
      const { openDocumentsStore } = await import('../../state/open-documents-store.js');
      const doc = openDocumentsStore.findInSnapshotByPathOrUrl(resolvedPath) ||
                  openDocumentsStore.findInSnapshotByPathOrUrl(filePath);
      if (doc && (doc.selectionStart != null || doc.selectionEnd != null)) {
        editor = _describeEditorSelection(content, doc.selectionStart, doc.selectionEnd);
      }
    } catch { /* store unavailable — ignore */ }

    return {
      success: true,
      path: filePath,
      content: numbered,
      totalLines: allLines.length,
      from: offset,
      to: endIdx,
      ...(editor && { editor }),
      ...(wasTruncated && { truncated: true, hint: `File has ${allLines.length} lines. Use offset/limit to read more.` })
    };
  }
};

/**
 * Convert a (start, end) character-offset pair from the GUI text editor
 * into a human-readable cursor/selection block the LLM can reason about.
 * Returns an object with 1-based line/column coordinates, the selected
 * text (truncated for large selections), and a short `summary` string
 * that can be shown inline or read alone.
 */
function _describeEditorSelection(content, start, end) {
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  const len = content.length;
  const lo = Math.max(0, Math.min(start, end, len));
  const hi = Math.max(0, Math.min(Math.max(start, end), len));

  const offsetToLineCol = (offset) => {
    let line = 1;
    let col = 1;
    for (let i = 0; i < offset; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  };

  const startPos = offsetToLineCol(lo);
  if (lo === hi) {
    return {
      type: 'cursor',
      line: startPos.line,
      column: startPos.col,
      summary: `User's caret is at line ${startPos.line}, column ${startPos.col}. No text is selected; when the user says "here" or "this line" they mean that position.`,
    };
  }

  const endPos = offsetToLineCol(hi);
  const MAX_SNIPPET = 500;
  let snippet = content.slice(lo, hi);
  const truncated = snippet.length > MAX_SNIPPET;
  if (truncated) snippet = snippet.slice(0, MAX_SNIPPET) + '…';

  const sameLine = startPos.line === endPos.line;
  const rangeDesc = sameLine
    ? `line ${startPos.line}, columns ${startPos.col}–${endPos.col}`
    : `line ${startPos.line} col ${startPos.col} → line ${endPos.line} col ${endPos.col}`;

  return {
    type: 'selection',
    startLine: startPos.line,
    startColumn: startPos.col,
    endLine: endPos.line,
    endColumn: endPos.col,
    selectedText: snippet,
    truncated,
    summary:
      `User has text selected: ${rangeDesc}. When they say "this", "esto", "change this", ` +
      `"replace this", or refer to something without naming it, they mean the SELECTED text below. ` +
      `Selected text${truncated ? ' (truncated)' : ''}:\n"""${snippet}"""`,
  };
}

// ─── Timeline → renderable-video resolution ─────────────────────────
// A timeline is a JSON file under `<project>/timelines/`. When the agent
// calls read_file on it, the raw JSON is useless for sound design —
// what matters is what the rendered video shows. These helpers turn
// the JSON into a video path (either a single underlying clip or a
// freshly rendered mp4 from the export pipeline) so the existing
// video branch can handle vision sampling unchanged.

const _TIMELINE_PATH_RE = /[/\\]\.koi[/\\]timelines[/\\][^/\\]+\.json$/i;

function _isTimelineFile(absPath) {
  if (!absPath) return false;
  if (!_TIMELINE_PATH_RE.test(absPath)) return false;
  if (!fs.existsSync(absPath)) return false;
  // Path-based detection is enough: <project>/timelines/ is a koi-managed
  // directory, every .json inside is a timeline. The earlier "sniff
  // first 200 bytes for `clips`" guard sounded prudent but actively
  // broke real timelines whose settings block (videoTracks, audioTracks,
  // pixelsPerSecond, previewSplit, playheadMs, …) consumed the entire
  // window before the clips array showed up — the sniff returned false,
  // the agent got the raw JSON instead of the rendered video, and the
  // SFX prompt was generic ("cinematic sound design"). Trust the dir.
  return true;
}

const _VIDEO_EXTS_FOR_TIMELINE = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg']);

function _isVideoClipPath(p) {
  if (!p) return false;
  return _VIDEO_EXTS_FOR_TIMELINE.has(path.extname(p).toLowerCase());
}

async function _resolveTimelineForRead(timelinePath, agent) {
  let raw;
  try {
    raw = fs.readFileSync(timelinePath, 'utf8');
  } catch (err) {
    return { _error: `Could not read timeline JSON: ${err.message}` };
  }
  let tl;
  try {
    tl = JSON.parse(raw);
  } catch (err) {
    return { _error: `Timeline JSON is malformed: ${err.message}` };
  }
  const clips = Array.isArray(tl?.clips) ? tl.clips : [];
  if (clips.length === 0) {
    return { _error: `Timeline ${tl.id || path.basename(timelinePath)} has no clips — nothing to read.` };
  }

  // Branch (a): the user has selected a specific clip. The GUI surfaces
  // selectedClipId on the active document via working-area state; if it
  // matches a video clip, narrow the read to that clip's source. Audio
  // and image clips don't make sense as "the active visual" — fall
  // through to render in those cases.
  const selectedClipId = await _getSelectedClipId(timelinePath);
  if (selectedClipId) {
    const sel = clips.find((c) => c?.id === selectedClipId);
    if (sel && _isVideoClipPath(sel.path) && fs.existsSync(sel.path)) {
      return { redirectPath: sel.path, reason: `selected clip ${sel.id}` };
    }
  }

  // Branch (b): exactly one video clip on the timeline → no need to
  // render, the clip IS the visual. Saves seconds-to-minutes of FFmpeg
  // work on the common "single clip + audio peer" timeline.
  const videoClips = clips.filter((c) => _isVideoClipPath(c?.path));
  if (videoClips.length === 1 && fs.existsSync(videoClips[0].path)) {
    return { redirectPath: videoClips[0].path, reason: 'single video clip shortcut' };
  }
  if (videoClips.length === 0) {
    return { _error: `Timeline ${tl.id || path.basename(timelinePath)} has no video clips — read_file vision needs a renderable visual.` };
  }

  // Branch (c): multi-clip → render and cache by sha1 of the JSON.
  const rendered = await _ensureCachedTimelineRender(tl, raw, agent);
  if (rendered?.path) {
    return { redirectPath: rendered.path, reason: 'rendered timeline' };
  }
  // Render failed (e.g. the ffmpeg path can't draw title overlays yet).
  // Fall back to the timeline's RAW JSON: for inspect/edit intents the
  // structure (clip ids, tracks, scale, offsets) is exactly what the agent
  // needs — an outright error here used to send agents on a
  // list_timelines/shell/recall goose chase that never converged.
  return {
    rawJsonFallback: true,
    note: `Timeline could not be rendered to video (${rendered?.error || 'unknown error'}). ` +
      `Falling back to the timeline's raw JSON — to edit it use get_timeline / the timeline update tools.`,
  };
}

/** Snapshot helper: read selectedClipId from the active doc when it
 *  matches the timeline path. Returns null when not available. */
async function _getSelectedClipId(timelinePath) {
  try {
    const { openDocumentsStore } = await import('../../state/open-documents-store.js');
    const active = openDocumentsStore.getSnapshotActive?.() || openDocumentsStore.getActive?.();
    if (!active) return null;
    if (active.path !== timelinePath) return null;
    return active.selectedClipId || null;
  } catch { return null; }
}

async function _ensureCachedTimelineRender(timelineJson, rawJsonStr, agent) {
  const home = process.env.HOME || os.homedir();
  const cacheDir = path.join(home, '.koi', 'cache', 'timeline-renders');
  fs.mkdirSync(cacheDir, { recursive: true });

  // Hash the JSON content (not just the id) so any clip / setting edit
  // invalidates the cache automatically. 12 hex chars is collision-safe
  // enough for a per-user cache and keeps filenames readable.
  const hash = crypto.createHash('sha1').update(rawJsonStr).digest('hex').slice(0, 12);
  const tlId = timelineJson.id || 'tl';
  const cachedPath = path.join(cacheDir, `${tlId}-${hash}.mp4`);

  if (fs.existsSync(cachedPath)) {
    channel.log('read_file', `[timeline] cache hit ${path.basename(cachedPath)}`);
    return { path: cachedPath };
  }

  channel.log('read_file', `[timeline] rendering ${tlId} → ${path.basename(cachedPath)} (this may take a few seconds)`);
  let renderTool;
  try {
    renderTool = (await import('../timeline/render-timeline.js')).default;
  } catch (err) {
    channel.log('read_file', `[timeline] render-timeline tool unavailable: ${err.message}`);
    return { error: `render-timeline tool unavailable: ${err.message}` };
  }
  try {
    const result = await renderTool.execute(
      { id: tlId, wait: true, outputPath: cachedPath },
      agent,
    );
    if (!result?.success) {
      channel.log('read_file', `[timeline] render failed: ${result?.error || 'unknown'}`);
      return { error: result?.error || 'unknown render failure' };
    }
    if (!fs.existsSync(cachedPath)) {
      channel.log('read_file', `[timeline] render returned success but file missing: ${cachedPath}`);
      return { error: 'render reported success but the output file is missing' };
    }
    return { path: cachedPath };
  } catch (err) {
    channel.log('read_file', `[timeline] render threw: ${err.message}`);
    return { error: err.message };
  }
}

