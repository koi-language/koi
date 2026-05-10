/**
 * Image normaliser tuned for the VISION pipeline (LLM image inputs).
 *
 * Different goal from `_normalize-image-for-provider.js` — that one
 * preserves bytes for image-generation providers, where every pixel
 * matters. The vision pipeline is the OPPOSITE problem: a 5504×3072
 * PNG straight out of an image-gen tool is ~17 MB; four of them in
 * one turn = ~70 MB of base64 → the LLM gateway returns 413 "Payload
 * Too Large" and the agent loops trying to retry. So we transcode to
 * JPEG with a sensible max-edge cap before the bytes ever leave this
 * function.
 *
 * Why these numbers:
 *   - Max edge 2048 px: every modern vision endpoint (Gemini 2.5/3.x,
 *     Claude, GPT-4o) downscales internally to ≤2048 (most to ~1568)
 *     before tokenising. Sending more is pure waste.
 *   - JPEG quality 85: indistinguishable from the source for human or
 *     model perception of natural photography; keeps file size in the
 *     0.3–1.5 MB range for typical content. PNG would balloon back to
 *     several MB for the same pixels.
 *   - Strip alpha: vision endpoints don't reason about transparency;
 *     compositing onto white preserves the visible content faithfully
 *     and lets the JPEG codec do its job.
 *   - Strip ICC / EXIF metadata: the model doesn't see them and they
 *     waste bytes (large ICC profiles can add 100+ KB on their own).
 *
 * Caching: keyed by absolute path + mtime + size + target params, so
 * resaving the same source file produces the same cached output. The
 * cache lives in $TMPDIR/koi-img-vision/ and is cleaned by the OS's
 * usual tmp policy.
 *
 * Returns `{ path, ext, mimeType, converted, originalBytes,
 * normalisedBytes, savedBytes }` where the savings are useful for the
 * read_file return message ("Image attached for vision (3.2 MB → 0.4
 * MB)") so the agent has a sense of what's flowing through.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_JPEG_QUALITY = 85;

export async function normalizeImageForVision(filePath, opts = {}) {
  const maxEdge = opts.maxEdge || DEFAULT_MAX_EDGE;
  const quality = opts.quality || DEFAULT_JPEG_QUALITY;
  const resolved = path.resolve(filePath);

  // Cheap fast-path: tiny files (≤200 KB) are almost certainly already
  // small enough — re-encoding adds latency for no payload win. Inspect
  // dimensions once via sharp to be safe; if both edges are within the
  // cap and the bytes are small, return the original path unchanged.
  const srcStat = fs.statSync(resolved);

  const cacheKey = crypto
    .createHash('sha1')
    .update(`${resolved}:${srcStat.mtimeMs}:${srcStat.size}:e${maxEdge}:q${quality}`)
    .digest('hex')
    .slice(0, 16);

  const cacheDir = path.join(os.tmpdir(), 'koi-img-vision');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${cacheKey}.jpg`);

  if (fs.existsSync(outPath)) {
    const outStat = fs.statSync(outPath);
    return {
      path: outPath,
      ext: '.jpg',
      mimeType: 'image/jpeg',
      converted: true,
      originalBytes: srcStat.size,
      normalisedBytes: outStat.size,
      savedBytes: Math.max(0, srcStat.size - outStat.size),
      fromCache: true,
    };
  }

  const sharp = (await import('sharp')).default;
  const meta = await sharp(resolved).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  // Already small + already JPEG → original is fine for vision. Keeps
  // the fast path for screenshots, web thumbs, etc. that are produced
  // at sane sizes.
  const isJpeg = meta.format === 'jpeg' || meta.format === 'jpg';
  if (isJpeg && w && h && w <= maxEdge && h <= maxEdge && srcStat.size <= 1_500_000) {
    return {
      path: resolved,
      ext: path.extname(resolved).toLowerCase() || '.jpg',
      mimeType: 'image/jpeg',
      converted: false,
      originalBytes: srcStat.size,
      normalisedBytes: srcStat.size,
      savedBytes: 0,
      fromCache: false,
    };
  }

  // Downscale (only if needed — `withoutEnlargement: true` keeps small
  // sources at their native size) and flatten alpha to white before
  // the JPEG encode. mozjpeg gives ~10–15 % smaller files at the same
  // quality, free win on installs that ship it.
  const pipeline = sharp(resolved)
    .rotate() // honour EXIF orientation; the strip below removes the rest
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality, mozjpeg: true })
    .withMetadata({}); // strip everything except orientation we already applied

  await pipeline.toFile(outPath);

  const outStat = fs.statSync(outPath);
  return {
    path: outPath,
    ext: '.jpg',
    mimeType: 'image/jpeg',
    converted: true,
    originalBytes: srcStat.size,
    normalisedBytes: outStat.size,
    savedBytes: Math.max(0, srcStat.size - outStat.size),
    fromCache: false,
  };
}

/** Convenience: normalise + read the resulting bytes as base64 in one
 *  call (the canonical pattern for queueing into `_pendingMcpImages`). */
export async function readNormalisedImageForVision(filePath, opts = {}) {
  const norm = await normalizeImageForVision(filePath, opts);
  const data = fs.readFileSync(norm.path).toString('base64');
  return { ...norm, base64: data };
}
