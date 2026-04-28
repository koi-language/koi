/**
 * Extract Frame Action — pull a single still frame out of a video at an
 * exact timestamp, at the source's native resolution.
 *
 * Inputs:
 *   - video (required): absolute path to the source video file.
 *   - timeMs OR timeSeconds (one required): position to grab.
 *   - saveTo (optional): destination path. The extension picks the
 *     codec — `.png` (default, lossless) or `.jpg` / `.jpeg` (smaller).
 *     Defaults to `<projectRoot>/.koi/frames/<videoName>-t<ms>.png`.
 *
 * Output: { success, savedTo, width, height, timeMs, format }.
 *
 * Implementation: ffmpeg single-frame extraction. We pass `-ss` BEFORE
 * `-i` (fast seek) AND `-frames:v 1` so ffmpeg decodes from the nearest
 * keyframe forward to the target presentation timestamp — modern ffmpeg
 * (2.1+) does accurate seek in this form, which is the right balance of
 * speed (no full-file decode) and frame-accuracy. For lossy outputs we
 * pin `-q:v 2` (perceptually transparent JPEG); PNG is lossless by
 * construction so quality flags are skipped.
 *
 * Permission: 'write' (creates a local image file).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureFfmpeg } from '../../media/ffmpeg-installer.js';
import { channel } from '../../io/channel.js';

const _PNG_EXT = new Set(['.png']);
const _JPG_EXT = new Set(['.jpg', '.jpeg']);

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

function _formatTimestamp(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export default {
  type: 'extract_frame',
  intent: 'extract_frame',
  description:
    'Extract a single still frame from a local video at an exact timestamp, at the source\'s native resolution. ' +
    'Required: "video" (absolute path) and one of "timeMs" or "timeSeconds". ' +
    'Optional: "saveTo" — destination path; the extension picks the codec ("png" lossless [default], "jpg"/"jpeg" smaller). ' +
    'Defaults to "<projectRoot>/.koi/frames/<videoName>-t<ms>.png". ' +
    'Returns { success, savedTo, width, height, timeMs, format }. ffmpeg is auto-installed on first use.',
  thinkingHint: 'Extracting frame',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      video:       { type: 'string',  description: 'Absolute path to the source video file.' },
      timeMs:      { type: 'number',  description: 'Timestamp to grab, in milliseconds. Use this OR timeSeconds.' },
      timeSeconds: { type: 'number',  description: 'Timestamp to grab, in seconds (float). Use this OR timeMs.' },
      saveTo:      { type: 'string',  description: 'Destination file path. Extension picks the format: .png (lossless, default) or .jpg/.jpeg.' },
    },
    required: ['video'],
  },

  examples: [
    { intent: 'extract_frame', video: '/Users/me/clips/intro.mp4', timeSeconds: 12.5 },
    { intent: 'extract_frame', video: '/tmp/render.mov', timeMs: 33000, saveTo: '/tmp/poster.jpg' },
  ],

  async execute(action) {
    const videoPath = action.video;
    if (!videoPath) return { success: false, error: 'extract_frame: "video" is required' };
    const resolvedVideo = path.resolve(videoPath);
    if (!fs.existsSync(resolvedVideo)) {
      return { success: false, error: `Video not found: ${videoPath}` };
    }

    let timeMs;
    if (typeof action.timeMs === 'number') timeMs = action.timeMs;
    else if (typeof action.timeSeconds === 'number') timeMs = action.timeSeconds * 1000;
    else return { success: false, error: 'extract_frame: pass either "timeMs" or "timeSeconds"' };
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      return { success: false, error: `extract_frame: invalid timestamp (${timeMs}ms)` };
    }

    // Resolve destination + format. We honour the caller's extension
    // when present — png is lossless and the right default for
    // analysis / reuse; jpg is the right call when a smaller poster
    // image is enough.
    let savePath;
    if (action.saveTo) {
      savePath = path.resolve(action.saveTo);
    } else {
      const stem = path.basename(resolvedVideo, path.extname(resolvedVideo));
      const dir = path.join(_projectRoot(), '.koi', 'frames');
      savePath = path.join(dir, `${stem}-t${Math.round(timeMs)}.png`);
    }
    const ext = path.extname(savePath).toLowerCase();
    let format;
    if (_PNG_EXT.has(ext)) format = 'png';
    else if (_JPG_EXT.has(ext)) format = 'jpg';
    else {
      return {
        success: false,
        error: `extract_frame: unsupported output extension "${ext || '(none)'}". Use .png or .jpg/.jpeg.`,
      };
    }
    fs.mkdirSync(path.dirname(savePath), { recursive: true });

    const { ffmpeg } = await ensureFfmpeg();

    // -ss <ts> before -i: fast seek to the nearest keyframe, then decode
    // forward to the exact PTS. Modern ffmpeg makes this both fast AND
    // accurate, so we don't need the post-input slow-seek form.
    // -frames:v 1 stops after one written frame.
    // -y overwrites; -an drops audio (a single frame doesn't need it).
    const argv = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', _formatTimestamp(timeMs / 1000),
      '-i', resolvedVideo,
      '-frames:v', '1',
      '-an',
    ];
    if (format === 'jpg') {
      // -q:v 2 ≈ "visually transparent" — the lowest JPEG quantizer
      // that still produces a small file. We could expose this as a
      // knob later, but every caller so far wants "best reasonable".
      argv.push('-q:v', '2');
    }
    argv.push('-y', savePath);

    channel.log('media', `extract_frame: ${path.basename(resolvedVideo)} @ ${(timeMs / 1000).toFixed(3)}s → ${savePath}`);

    const stderrTail = await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      child.stderr.on('data', (buf) => {
        tail = (tail + buf.toString('utf8')).slice(-8192);
      });
      child.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
      child.on('exit', (code, sig) => {
        if (code === 0) resolve(tail);
        else reject(new Error(`ffmpeg exited with code=${code} sig=${sig || '-'}: ${tail.trim() || '(no stderr)'}`));
      });
    }).catch((err) => ({ _err: err }));

    if (stderrTail && typeof stderrTail === 'object' && stderrTail._err) {
      return { success: false, error: stderrTail._err.message };
    }

    if (!fs.existsSync(savePath)) {
      return {
        success: false,
        error: `extract_frame: ffmpeg produced no output (timestamp ${timeMs}ms may be past the end of the video).`,
      };
    }

    // ffmpeg's banner is suppressed at -loglevel error, so dimensions
    // need a quick header probe. Fall back to 0x0 if the format isn't
    // recognised — non-fatal, just informational.
    const dims = _readImageDims(savePath, format);
    const stat = fs.statSync(savePath);
    return {
      success: true,
      savedTo: savePath,
      format,
      width: dims.width,
      height: dims.height,
      timeMs,
      fileSize: stat.size,
    };
  },
};

/** Read width/height from the first ~32 bytes of the freshly-written
 *  image. Cheaper than re-spawning ffprobe for a value we just wrote. */
function _readImageDims(filePath, format) {
  try {
    const buf = Buffer.alloc(32);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buf, 0, 32, 0); } finally { fs.closeSync(fd); }
    if (format === 'png') {
      // PNG: width @16, height @20 (big-endian uint32 each).
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
    } else if (format === 'jpg') {
      // JPEG: walk markers until SOF0..SOF3, dimensions sit at +5/+7.
      const full = fs.readFileSync(filePath);
      let pos = 2;
      while (pos < full.length - 8) {
        if (full[pos] !== 0xFF) { pos++; continue; }
        const marker = full[pos + 1];
        const len = full.readUInt16BE(pos + 2);
        if (marker >= 0xC0 && marker <= 0xC3) {
          return { width: full.readUInt16BE(pos + 7), height: full.readUInt16BE(pos + 5) };
        }
        pos += 2 + len;
      }
    }
  } catch { /* ignore — dimensions are best-effort */ }
  return { width: 0, height: 0 };
}
