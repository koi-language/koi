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
 * If `filePath` is already PNG/JPEG, returns it unchanged. Otherwise
 * transcodes it to PNG under `$TMPDIR/koi-img-norm/<hash>.png` (cached
 * across calls, keyed by resolved path + mtime) and returns the new path.
 *
 * Returns `{ path, ext, mimeType, converted }` where `converted` is true
 * when a PNG copy was written (useful for logging).
 */
export async function normalizeImageForProvider(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();

  if (PROVIDER_SAFE_EXT.has(ext)) {
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
