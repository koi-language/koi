/**
 * Generic, constraint-aware input adapters used by every media tool
 * that uploads a file to the gateway. Tools pass the picked model
 * (via `agent.imageGen.peekModel()` / `agent.videoGen.peekModel()`)
 * plus the canonical input role the file plays; the helper reads
 * `model.constraints.inputs.<role>` and adapts the bytes accordingly.
 *
 * When the role has NO restriction in the catalog, every helper is a
 * no-op — the original bytes pass through. Tools never need to
 * special-case absence.
 *
 * Vocabulary for `role` is the same as the adapter's `requires`
 * array (`referenceImages`, `maskImage`, `sourceImage`, `startFrame`,
 * `endFrame`, `imageUrl`, `audioUrl`, `videoUrl`, `referenceVideos`).
 *
 * Canonical shape of the `constraints` blob lives in
 * `backend/src/modules/gateway/model-constraints.ts` (ModelConstraints).
 * Runtime treats it as a plain object — TS enforces the shape at the
 * source, here we just read whatever fields the catalog ships.
 */

/**
 * Adapt a single uploaded image so it fits the picked model's
 * restrictions on the given canonical role. Reads
 * `inputs.<role>.maxWidth/Height/Area/Bytes` and applies in order:
 *
 *   1. DIMS — when width/height/area exceeded, sharp.resize the
 *      buffer proportionally so all three caps are satisfied at once.
 *   2. BYTES — when maxBytes is declared and the (resized) buffer
 *      still exceeds it, iteratively shrink the longest side by 15%
 *      and re-encode as max-compression PNG until it fits, capped at
 *      8 passes. ALWAYS lossless PNG — never JPEG (the whole pipeline
 *      treats lossy re-encoding as a regression).
 *
 * No-op when the role has no restrictions in the catalog. Always
 * returns a `Buffer` + `mimeType` plus the resolved dims and byte
 * size so the caller can log / decide further behaviour.
 *
 * @param {Buffer|string} source — raw bytes OR a filesystem path to read.
 * @param {{ slug?: string, constraints?: object } | null | undefined} model
 * @param {'referenceImages'|'maskImage'|'sourceImage'|'startFrame'|'endFrame'|'imageUrl'} role
 * @returns {Promise<{
 *   buffer: Buffer,
 *   mimeType: string,
 *   width: number,
 *   height: number,
 *   bytes: number,
 *   changed: boolean,
 *   limitedBy: 'maxArea'|'maxWidth'|'maxHeight'|'maxBytes'|null,
 *   reason: string|null,
 * }>}
 */
export async function adaptImageInput(source, model, role) {
  const fs = await import('fs');
  const sharp = (await import('sharp')).default;
  const slot = model?.constraints?.inputs?.[role];

  // Load source. Buffer in → use as-is; path in → read once.
  let buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  const meta0 = await sharp(buffer).metadata();
  let width = meta0.width || 0;
  let height = meta0.height || 0;
  const originalBytes = buffer.length;
  const mimeType = 'image/png';

  // No restrictions declared → ship original, untouched.
  if (!slot) {
    return {
      buffer,
      mimeType: meta0.format ? `image/${meta0.format}` : mimeType,
      width,
      height,
      bytes: originalBytes,
      changed: false,
      limitedBy: null,
      reason: null,
    };
  }

  let limitedBy = null;
  let changed = false;

  // ── 1) Dimension caps ────────────────────────────────────────────
  const widthScale = (typeof slot.maxWidth === 'number' && width > slot.maxWidth)
    ? slot.maxWidth / width : 1;
  const heightScale = (typeof slot.maxHeight === 'number' && height > slot.maxHeight)
    ? slot.maxHeight / height : 1;
  const areaScale = (typeof slot.maxArea === 'number' && width * height > slot.maxArea)
    ? Math.sqrt(slot.maxArea / (width * height)) : 1;
  const dimScale = Math.min(widthScale, heightScale, areaScale);
  if (dimScale < 1) {
    const newW = Math.max(1, Math.floor(width * dimScale));
    const newH = Math.max(1, Math.floor(height * dimScale));
    buffer = await sharp(buffer)
      .rotate() // honour EXIF orientation before downscaling
      .resize(newW, newH, { fit: 'fill' })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    width = newW;
    height = newH;
    changed = true;
    limitedBy =
      dimScale === areaScale   ? 'maxArea'   :
      dimScale === widthScale  ? 'maxWidth'  :
      'maxHeight';
  }

  // ── 2) Byte cap (iterative LOSSLESS shrink) ─────────────────────
  if (typeof slot.maxBytes === 'number' && buffer.length > slot.maxBytes) {
    // If we haven't transcoded yet (still original mime), force a PNG
    // re-encode now so the first iteration measures against the same
    // codec the loop will use.
    if (!changed) {
      buffer = await sharp(buffer)
        .rotate()
        .png({ compressionLevel: 9, palette: false })
        .toBuffer();
      const m = await sharp(buffer).metadata();
      width = m.width || width;
      height = m.height || height;
      changed = true;
    }
    const SHRINK = 0.85;
    const MAX_ITER = 8;
    let curW = width;
    let curH = height;
    let attempt = 0;
    while (buffer.length > slot.maxBytes && attempt < MAX_ITER) {
      attempt += 1;
      curW = Math.max(1, Math.round(curW * SHRINK));
      curH = Math.max(1, Math.round(curH * SHRINK));
      buffer = await sharp(buffer)
        .resize(curW, curH, { fit: 'fill' })
        .png({ compressionLevel: 9, palette: false })
        .toBuffer();
    }
    width = curW;
    height = curH;
    limitedBy = 'maxBytes';
  }

  const slug = typeof model?.slug === 'string' ? model.slug : '?';
  return {
    buffer,
    mimeType,
    width,
    height,
    bytes: buffer.length,
    changed,
    limitedBy,
    reason: changed
      ? `Adapted to ${slug}.${role} restrictions: ` +
        `${originalBytes}B/${meta0.width}×${meta0.height} → ` +
        `${buffer.length}B/${width}×${height} (limitedBy=${limitedBy})`
      : null,
  };
}

/**
 * Check whether an audio buffer fits the picked model's restrictions
 * for the given role. Trimming audio bytes / duration needs ffmpeg
 * which lives outside this runtime; the helper SURFACES a clear
 * error result the tool propagates instead of silently uploading
 * something the model will reject.
 *
 * @param {Buffer} buffer
 * @param {{ durationSec?: number }} meta — caller measures duration externally
 * @param {{ slug?: string, constraints?: object } | null | undefined} model
 * @param {'audioUrl'} role
 * @returns {{ ok: boolean, error: string|null, limitedBy: 'maxBytes'|'maxDurationSec'|null }}
 */
export function checkAudioInput(buffer, meta, model, role) {
  const slot = model?.constraints?.inputs?.[role];
  if (!slot) return { ok: true, error: null, limitedBy: null };
  const slug = typeof model?.slug === 'string' ? model.slug : '?';
  if (typeof slot.maxBytes === 'number' && buffer.length > slot.maxBytes) {
    return {
      ok: false,
      error: `Audio exceeds maxBytes (${buffer.length} > ${slot.maxBytes}) for ${slug}.${role}`,
      limitedBy: 'maxBytes',
    };
  }
  if (typeof slot.maxDurationSec === 'number'
      && typeof meta?.durationSec === 'number'
      && meta.durationSec > slot.maxDurationSec) {
    return {
      ok: false,
      error: `Audio exceeds maxDurationSec (${meta.durationSec.toFixed(1)}s > ${slot.maxDurationSec}s) for ${slug}.${role}`,
      limitedBy: 'maxDurationSec',
    };
  }
  return { ok: true, error: null, limitedBy: null };
}
