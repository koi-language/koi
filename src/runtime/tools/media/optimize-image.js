/**
 * Optimize Image Action — LOSSLESS shrink of a local image so it fits a
 * byte / dimension budget. PNG-only pipeline (compressionLevel 9, ×0.85
 * downscale loop) via the same `adaptImageInput` engine the media tools
 * use for provider caps — **never JPEG, never lossy re-encoding**: pixel
 * values are preserved, only the pixel COUNT shrinks when the budget
 * demands it.
 *
 * Use case: a provider worker rejects/fails to download a heavy source
 * image (e.g. fal avatar models with a multi-MB PNG → "body.image_url:
 * Failed to download the file"). Run this on the image and retry with
 * the optimized path — do NOT hand-roll sips/ffmpeg conversions to JPEG
 * (quality loss) from the shell.
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../../io/channel.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // matches the avatar workers' real cap
const DEFAULT_MAX_DIMENSION = 2048;

const optimizeImageAction = {
  type: 'optimize_image',
  intent: 'optimize_image',
  description:
    'LOSSLESSLY optimize a local image to fit a byte / dimension budget (PNG compressionLevel 9 + iterative downscale — NEVER JPEG, no quality loss beyond the downscale itself). ' +
    'Use when a provider fails on a heavy source image (e.g. "body.image_url: Failed to download the file" from an avatar model): optimize, then retry the SAME call with the returned `savedTo` path. ' +
    'Do NOT convert images to JPEG with shell tools (sips/ffmpeg) — that destroys quality; this tool is the sanctioned path.\n' +
    '\n' +
    'Required:\n' +
    '  - "image": absolute path to the source image (png/jpg/webp — output is always PNG).\n' +
    'Optional:\n' +
    '  - "maxBytes": target byte ceiling (default 2097152 = 2 MB, the practical cap of fal avatar workers).\n' +
    '  - "maxDimension": max width/height in px (default 2048).\n' +
    '\n' +
    'Returns: { success, savedTo, width, height, bytes, originalBytes, changed }. `changed:false` means the image already fit — `savedTo` is the ORIGINAL path, use it as-is.',
  thinkingHint: 'Optimizing image',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Absolute path to the source image.' },
      maxBytes: { type: 'number', description: 'Byte ceiling for the output (default 2 MB).' },
      maxDimension: { type: 'number', description: 'Max width/height in px (default 2048).' },
    },
    required: ['image'],
  },

  examples: [
    { intent: 'optimize_image', image: '/Users/me/.koi/images/portrait.png' },
    { intent: 'optimize_image', image: '/tmp/poster.png', maxBytes: 1048576, maxDimension: 1600 },
  ],

  async execute(action) {
    const imagePath = action.image;
    if (typeof imagePath !== 'string' || !imagePath.trim()) {
      return { success: false, error: 'optimize_image: "image" is required (absolute path).' };
    }
    const resolved = path.resolve(imagePath);
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `Image not found: ${imagePath}` };
    }
    const maxBytes = typeof action.maxBytes === 'number' && action.maxBytes > 0
      ? Math.round(action.maxBytes)
      : DEFAULT_MAX_BYTES;
    const maxDim = typeof action.maxDimension === 'number' && action.maxDimension > 0
      ? Math.round(action.maxDimension)
      : DEFAULT_MAX_DIMENSION;

    // Synthetic constraints row → the SAME lossless adaptation engine the
    // media tools run against real per-model caps.
    const syntheticModel = {
      slug: 'optimize_image',
      constraints: { inputs: { image: { maxBytes, maxWidth: maxDim, maxHeight: maxDim } } },
    };
    let adapted;
    try {
      const { adaptImageInput } = await import('../../llm/providers/_constraints.js');
      adapted = await adaptImageInput(fs.readFileSync(resolved), syntheticModel, 'image');
    } catch (err) {
      return { success: false, error: `optimize_image failed: ${err?.message || err}` };
    }

    if (!adapted.changed) {
      // Already within budget — no copy, the original IS the answer.
      return {
        success: true,
        savedTo: resolved,
        width: adapted.width,
        height: adapted.height,
        bytes: adapted.bytes ?? fs.statSync(resolved).size,
        originalBytes: fs.statSync(resolved).size,
        changed: false,
      };
    }

    const base = path.basename(resolved).replace(/\.[a-z0-9]+$/i, '');
    const outPath = path.join(path.dirname(resolved), `${base}.opt.png`);
    try {
      fs.writeFileSync(outPath, adapted.buffer);
    } catch (err) {
      return { success: false, error: `optimize_image: could not write ${outPath}: ${err?.message || err}` };
    }
    channel.log(
      'image',
      `optimize_image: ${path.basename(resolved)} ${(fs.statSync(resolved).size / 1024).toFixed(0)}KB → ` +
      `${path.basename(outPath)} ${(adapted.buffer.length / 1024).toFixed(0)}KB (${adapted.width}×${adapted.height}, lossless PNG)`,
    );
    return {
      success: true,
      savedTo: outPath,
      width: adapted.width,
      height: adapted.height,
      bytes: adapted.buffer.length,
      originalBytes: fs.statSync(resolved).size,
      changed: true,
    };
  },
};

export default optimizeImageAction;
