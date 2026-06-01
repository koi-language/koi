import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Image/video generation providers (OpenAI, Google, Replicate, …) reliably
// accept PNG and JPEG. Everything else — WebP, HEIC, AVIF, TIFF, BMP, GIF —
// is rejected by at least one mainstream provider and should be transcoded
// BEFORE the upload. Keeping this normalization in one place means every
// media tool (generate_image, generate_video, upscale, background removal,
// future ones) gets it for free.
const PROVIDER_SAFE_EXT = new Set(['.png', '.jpg', '.jpeg']);

/**
 * True if `resolved` is a multi-frame JPEG — an MPO (Multi-Picture Object)
 * container that embeds 2+ JPEG images in one file. These are produced by
 * 3D/stereo cameras and some phones, carry a normal .jpg/.jpeg extension
 * and an image/jpeg MIME, yet providers like fal reject them outright
 * ("Multi-frame MPO containers cannot be safely re-encoded"). Detection
 * walks the JPEG header segments and looks for the APP2 "MPF" marker, which
 * is the canonical MPO indicator — so no false positives from random image
 * bytes. Cheap: only the header (up to 128 KB, before SOS) is read.
 */
function _isMultiFrameJpeg(resolved) {
  let fd;
  try {
    fd = fs.openSync(resolved, 'r');
    const head = Buffer.alloc(131072);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < 4 || head[0] !== 0xff || head[1] !== 0xd8) return false; // not JPEG
    let off = 2;
    while (off + 4 <= n) {
      if (head[off] !== 0xff) { off++; continue; }
      const marker = head[off + 1];
      // Standalone markers (SOI/EOI/TEM/RSTn) carry no length segment.
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xda) break; // SOS → entropy data starts; headers done.
      const len = (head[off + 2] << 8) | head[off + 3];
      if (len < 2) break;
      if (marker === 0xe2) { // APP2 — MPF lives here for MPO files.
        const id = off + 4;
        if (id + 4 <= n &&
            head[id] === 0x4d && head[id + 1] === 0x50 &&
            head[id + 2] === 0x46 && head[id + 3] === 0x00) {
          return true; // "MPF\0"
        }
      }
      off += 2 + len;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } }
  }
}

/**
 * If `filePath` is already a normal single-frame PNG/JPEG, returns it
 * unchanged. Otherwise — a non-PNG/JPEG format, OR a JPEG that is actually
 * a multi-frame MPO — transcodes it to PNG under
 * `$TMPDIR/koi-img-norm/<hash>.png` (cached across calls, keyed by resolved
 * path + mtime) and returns the new path. Re-encoding through sharp reads
 * only the MPO's primary frame, so the extra frame is dropped.
 *
 * Returns `{ path, ext, mimeType, converted }` where `converted` is true
 * when a PNG copy was written (useful for logging).
 */
export async function normalizeImageForProvider(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();

  // Fast path only for genuinely single-frame JPEG/PNG. A JPEG that is
  // really an MPO must fall through to the re-encode below — passing its
  // raw bytes upstream is exactly what makes fal 422 on the reference.
  if (PROVIDER_SAFE_EXT.has(ext) &&
      !(ext !== '.png' && _isMultiFrameJpeg(resolved))) {
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return { path: resolved, ext, mimeType, converted: false };
  }

  const srcStat = fs.statSync(resolved);
  const cacheKey = crypto
    .createHash('sha1')
    .update(`${resolved}:${srcStat.mtimeMs}:${srcStat.size}`)
    .digest('hex')
    .slice(0, 16);

  const cacheDir = path.join(os.tmpdir(), 'koi-img-norm');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${cacheKey}.png`);

  if (!fs.existsSync(outPath)) {
    const sharp = (await import('sharp')).default;
    // .png() defaults to lossless zlib, keeping alpha where present. We
    // intentionally do NOT resize — upstream tools decide dimensions.
    await sharp(resolved).png().toFile(outPath);
  }

  return { path: outPath, ext: '.png', mimeType: 'image/png', converted: true };
}
