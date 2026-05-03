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
import { channel } from '../../io/channel.js';

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
    // Find pdfjs-dist in the snapshot via require.resolve
    const { createRequire } = await import('module');
    const _req = createRequire(__filename || process.argv[1]);
    let snapshotDir;
    try {
      const resolved = _req.resolve('pdfjs-dist/legacy/build/pdf.mjs');
      snapshotDir = path.dirname(resolved);
    } catch {
      throw new Error('pdfjs-dist not found in snapshot — PDF reading unavailable');
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

/** Probe a video's duration in milliseconds via ffprobe. Returns null
 *  when ffprobe is missing or the file is unreadable — callers should
 *  treat that as "no signal" and degrade gracefully. */
async function _probeVideoDurationMs(filePath) {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const { stdout } = await run(
      'ffprobe',
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
function _queueAnnotationsForVision(bundle, doc, session) {
  const anns = Array.isArray(bundle?.annotations) ? bundle.annotations : [];
  let note = '';

  // Image annotations — single composite-snapshot at most. Use the
  // legacy `[ANNOTATIONS OVERLAY]` caption so existing image-flow
  // behaviour is preserved verbatim.
  const imageAnns = anns.filter((a) => a && a.role !== 'video-frame-composite');
  for (const a of imageAnns) {
    if (!a.path || !fs.existsSync(a.path)) continue;
    const ext = path.extname(a.path).toLowerCase().slice(1);
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const b64 = fs.readFileSync(a.path).toString('base64');
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
      const ext = path.extname(a.path).toLowerCase().slice(1);
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const b64 = fs.readFileSync(a.path).toString('base64');
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
    const srcExt = primaryExt.slice(1);
    const srcMime = srcExt === 'jpg' ? 'image/jpeg' : `image/${srcExt}`;
    const srcB64 = fs.readFileSync(primaryPath).toString('base64');
    session._pendingMcpImages.push({ mimeType: srcMime, data: srcB64, _debugPath: primaryPath });
    channel.log('read_file', `[bundle:${doc.id}] primary queued for vision: ${primaryPath}`);
  } else {
    channel.log(
      'read_file',
      `[bundle:${doc.id}] primary is video (${primaryExt}) — only annotation composites will be queued for vision`,
    );
  }

  const annotationNote = _queueAnnotationsForVision(bundle, doc, session);

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
  description: 'Read a file\'s contents. Supports text files, PDF files, images (PNG, JPG, GIF, WebP, …) and videos (MP4, MOV, WebM, …). For images, the file is attached as vision input — you will see it on your next response. For videos, 4 evenly-spaced frames are sampled and attached so you can reason about the content visually without per-frame extraction. Fields: "path" (file path), optional "offset" (start line, 1-based, default 1), optional "limit" (number of lines, default 2000), optional "pages" (page range for PDFs). If path is a directory, lists its contents.',
  instructions: `read_file rules:
- Always use offset + limit for text files
- Prefer 50-150 lines per read
- Never read more than 200 lines at once
- For large files, never omit offset/limit
- For images (.png, .jpg, .gif, .webp): just call read_file with the path — the image will be attached for visual analysis on your next turn.
- For videos (.mp4, .mov, .webm, …): read_file samples 4 evenly-spaced frames and attaches them. For a frame at a SPECIFIC timestamp, call extract_frame instead.`,
  thinkingHint: (action) => `Reading ${action.path ? path.basename(action.path) : 'file'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read, or an attachment ID (e.g. att-1) to read an attached file' },
      offset: { type: 'number', description: 'Start reading from this line number (1-based, optional)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
      pages: { type: 'string', description: 'Page range for PDF files (e.g. "1-5", "3", "10-20"). Only for .pdf files. Max 20 pages per request.' }
    },
    required: ['path']
  },

  examples: [
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js' },
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js', offset: 10, limit: 50 },
    { actionType: 'direct', intent: 'read_file', path: 'docs/manual.pdf', pages: '1-5' },
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
      ], 0, { meta: { type: 'bash', header: `${agentName} ${t('wantsToRead')}`.replace(':', ''), command: `Read(${filePath})` } });

      if (value === 'always') {
        permissions.allowProject(resolvedPath);
      } else if (value !== 'yes') {
        return { success: false, denied: true, message: 'User denied file access' };
      }
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
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
      } else {
        channel.log('read_file', `[timeline] no redirect produced — falling through to raw-text read (likely a bug)`);
      }
    }

    // --- Video support (vision) ---
    // Two paths:
    //   (1) Active working-area video → route through the bundle helper
    //       so per-frame annotation composites land at the LLM with
    //       `[ANNOTATIONS @ MM:SS.ms]` captions.
    //   (2) Off-canvas video → ffmpeg-sample N evenly-spaced JPEG frames
    //       and queue them as vision inputs. The chat models we target
    //       (OpenAI / Anthropic / Gemini-via-OpenRouter) don't accept
    //       raw video bytes through the multimodal chat interface, so a
    //       sampled-frame mosaic is the provider-agnostic equivalent of
    //       "attach this video": the agent sees enough of the visual
    //       content to describe / analyse / write a follow-up prompt.
    if (_VIDEO_EXTS.has(path.extname(resolvedPath).toLowerCase())) {
      // When we got here via the timeline redirect, skip the working-
      // area-doc shortcut and go straight to ffmpeg sampling. Reason:
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
        } catch { /* store unavailable — fall through to sampling */ }
      }

      const session = agent?._activeSession;
      if (session) {
        const sampledMs = await _queueVideoFramesForVision(resolvedPath, session, { count: 4 });
        if (sampledMs.length > 0) {
          const stamps = sampledMs.map((ms) => _formatDuration(ms / 1000)).join(', ');
          // Probe duration up-front and surface it in the result so the
          // agent never has to guess `durationSeconds` for follow-up
          // calls (generate_audio sfx, etc.). Without this the agent
          // routinely picks 10/12s for a 5s clip — the SFX runs past
          // the end of the source.
          const totalDurMs = await _probeVideoDurationMs(resolvedPath);
          const totalDurSec = totalDurMs != null ? (totalDurMs / 1000) : null;
          channel.log(
            'read_file',
            `Video sampled for vision (${sampledMs.length} frames): ${filePath}` +
            (totalDurSec != null ? ` — duration ${totalDurSec.toFixed(2)}s` : ''),
          );
          const durationHint = totalDurSec != null
            ? ` Total video duration: **${totalDurSec.toFixed(2)} seconds** — use this exact value for any \`durationSeconds\` parameter on follow-up calls (generate_audio, etc.). Do NOT guess; the source is ${totalDurSec.toFixed(2)}s long, audio that runs longer plays past the end.`
            : '';
          return {
            success: true,
            path: filePath,
            type: 'video',
            sampledFrames: sampledMs.length,
            sampledTimestampsMs: sampledMs,
            ...(totalDurMs != null ? { durationMs: totalDurMs, durationSec: totalDurSec } : {}),
            message: `Video attached as ${sampledMs.length} sampled frames at ${stamps}. Use them as a visual summary of the video — they're evenly spaced, so reason about progression / motion / scene changes from the sequence.${durationHint} For per-frame inspection at a specific timestamp, call extract_frame.`,
          };
        }
      }
      return {
        success: false,
        error: `Could not sample frames from "${filePath}" — ffmpeg may be unavailable or the file is unreadable. For offline analysis call extract_frame at specific timestamps.`,
      };
    }

    // --- Audio support (metadata only — never raw bytes) ---
    // Audio files are binary; dumping them as "text" produces a wall of
    // garbage that wastes the agent's tokens AND confuses it. Instead
    // we return structured metadata (size, duration, codec, sample
    // rate, …) so the agent can reason about the file without ever
    // touching the raw bytes. If the agent needs the actual content
    // (transcription, lipsync driving, …) it should call the dedicated
    // tool (generate_audio mode=transcribe, generate_avatar_video, …).
    if (_AUDIO_EXTS.has(path.extname(resolvedPath).toLowerCase())) {
      const stat = fs.statSync(resolvedPath);
      const ext = path.extname(resolvedPath).slice(1).toLowerCase();
      const meta = await _probeAudioMetadata(resolvedPath);
      const sizeKb = Math.round(stat.size / 1024);
      return {
        success: true,
        path: filePath,
        type: 'audio',
        format: ext,
        sizeBytes: stat.size,
        sizeKb,
        modified: stat.mtime.toISOString(),
        ...(meta ? {
          durationSec: meta.durationSec,
          durationFormatted: meta.durationSec != null
            ? _formatDuration(meta.durationSec)
            : null,
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
        }),
        hint: 'This is an audio file — the runtime returns metadata, never the raw bytes. To transcribe, call generate_audio with mode="transcribe". To drive an avatar video, pass the path to generate_avatar_video.',
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
      const { normalizeImageForProvider } = await import('../media/_normalize-image-for-provider.js');
      let normalized;
      try {
        normalized = await normalizeImageForProvider(resolvedPath);
      } catch (err) {
        return {
          success: false,
          error: `Could not read "${filePath}" as an image: ${err.message || err}. Common causes: the file is actually HTML (e.g. web_fetch saved an error page), the file is corrupt, or the format is unsupported. Inspect it with shell (\`file <path>\` / \`wc -c <path>\`) before retrying.`,
        };
      }
      const b64 = fs.readFileSync(normalized.path).toString('base64');
      const mime = normalized.mimeType;
      if (normalized.converted) {
        channel.log('read_file', `Image transcoded to PNG for vision: ${filePath}`);
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
            annotationNote = _queueAnnotationsForVision(doc.bundle || null, doc, session);
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
        const MAX_PDF_PAGES = 20;

        const doc = await pdfjsLib.getDocument({ data: uint8Array, verbosity: 0 }).promise;
        const totalPages = doc.numPages;

        // Parse page range if provided
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
          if (pageSet.size > MAX_PDF_PAGES) {
            return { success: false, error: `Too many pages requested (max ${MAX_PDF_PAGES}). Use a smaller range.` };
          }
          pagesToRead = [...pageSet].sort((a, b) => a - b);
        } else {
          // No pages specified — read all (up to MAX_PDF_PAGES)
          const maxPage = Math.min(totalPages, MAX_PDF_PAGES);
          for (let i = 1; i <= maxPage; i++) pagesToRead.push(i);
        }

        // Extract text and images from selected pages.
        // pdfjs items have a transform matrix where [5] is the Y coordinate.
        // When Y changes between items, it means a new line in the PDF layout.
        const pageTexts = [];
        const _pdfImages = []; // { page, index, width, height, path }
        const session = agent?._activeSession;
        const _pdfImgDir = path.join(os.tmpdir(), 'koi-pdf-images');

        for (const pageNum of pagesToRead) {
          const page = await doc.getPage(pageNum);
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(i => i.str !== undefined);

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

            // Pages with no text: try OCR as fallback
            if (!items.length && images.length > 0) {
              const cachePath = path.join(os.homedir(), '.koi', 'tesseract-data');
              if (!fs.existsSync(cachePath)) fs.mkdirSync(cachePath, { recursive: true });
              for (const image of images) {
                const pngBuffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().withMetadata({ density: 300 }).toBuffer();
                try {
                  const { data } = await Tesseract.recognize(pngBuffer, 'eng', { cachePath, user_defined_dpi: '300' });
                  const ocrText = data?.text ? data.text.trim() : '';
                  if (ocrText) pageTexts.push(`--- Page ${pageNum} (OCR) ---\n${ocrText}`);
                } catch { /* OCR failed */ }
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
        }

        // Handle PDF images: ≤3 → auto-attach for vision; >3 → list paths so model picks
        const _AUTO_ATTACH_MAX = 3;
        if (_pdfImages.length > 0) {
          const autoAttach = _pdfImages.length <= _AUTO_ATTACH_MAX;
          if (autoAttach && session) {
            if (!session._pendingMcpImages) session._pendingMcpImages = [];
            for (const img of _pdfImages) {
              try {
                const imgB64 = fs.readFileSync(img.path).toString('base64');
                const imgExt = path.extname(img.path).toLowerCase().slice(1) || 'png';
                const imgMime = imgExt === 'jpg' ? 'image/jpeg' : `image/${imgExt}`;
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

        // Apply line numbering and truncation like regular files
        const allLines = text.split('\n');
        const MAX_LINES = 2000;
        const MAX_LINE_LENGTH = 2000;
        const offset = Math.max(1, action.offset || 1);
        const limit = action.limit || MAX_LINES;
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
          ...(!action.pages && totalPages > MAX_PDF_PAGES && { hint: `PDF has ${totalPages} pages but only first ${MAX_PDF_PAGES} were read. Use "pages" field (e.g. "1-5") to read specific pages.` })
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
// A timeline is a JSON file under `~/.koi/timelines/`. When the agent
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
  // Path-based detection is enough: ~/.koi/timelines/ is a koi-managed
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
  const renderedPath = await _ensureCachedTimelineRender(tl, raw, agent);
  if (!renderedPath) {
    return { _error: `Timeline render failed for ${tl.id || path.basename(timelinePath)}.` };
  }
  return { redirectPath: renderedPath, reason: 'rendered timeline' };
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
    return cachedPath;
  }

  channel.log('read_file', `[timeline] rendering ${tlId} → ${path.basename(cachedPath)} (this may take a few seconds)`);
  let renderTool;
  try {
    renderTool = (await import('../timeline/render-timeline.js')).default;
  } catch (err) {
    channel.log('read_file', `[timeline] render-timeline tool unavailable: ${err.message}`);
    return null;
  }
  try {
    const result = await renderTool.execute(
      { id: tlId, wait: true, outputPath: cachedPath },
      agent,
    );
    if (!result?.success) {
      channel.log('read_file', `[timeline] render failed: ${result?.error || 'unknown'}`);
      return null;
    }
    if (!fs.existsSync(cachedPath)) {
      channel.log('read_file', `[timeline] render returned success but file missing: ${cachedPath}`);
      return null;
    }
    return cachedPath;
  } catch (err) {
    channel.log('read_file', `[timeline] render threw: ${err.message}`);
    return null;
  }
}

