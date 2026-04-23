/**
 * Outpaint Image Action — extend an image's canvas by filling new margins.
 *
 * Thin, prompt-specialized wrapper on top of generate_image. Exists as a
 * separate discoverable tool so that models facing a canvas-extension task
 * see an unambiguous entry point (padTop / padBottom / padLeft / padRight)
 * instead of having to hand-compose one.
 *
 * How it works:
 *   1. Resolves the source image (path or att-N), reads its dimensions.
 *   2. Derives the TARGET aspect ratio from (origDims + pads).
 *   3. Composes an outpainting prompt that pins the original content's
 *      position in the new canvas and names the direction(s) to extend.
 *   4. Delegates to generate_image with the ORIGINAL image as a reference
 *      and the derived aspect ratio. Same label-free models as
 *      generate_image — no `operation: 'outpaint'` tag.
 *
 * Why the original image (not a transparent-padded canvas): general-purpose
 * edit models (gpt-image-1, Gemini 2.5 Flash Image, …) handle alpha
 * inconsistently and frequently return zero images when a large fraction of
 * the input is transparent. Passing the original image + target aspect
 * ratio + spatial prompt is what produces reliable extensions in practice.
 *
 * Permission: 'generate_image' (same billing category).
 */
import fs from 'fs';
import path from 'path';
import { channel } from '../../io/channel.js';
import generateImageAction from './generate-image.js';

const OUTPAINT_MAX_PAD = 4096;

function _clampPad(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > OUTPAINT_MAX_PAD) return OUTPAINT_MAX_PAD;
  return Math.round(v);
}

function _closestAspectRatio(width, height) {
  if (!width || !height) return null;
  const r = width / height;
  const candidates = [
    ['1:1', 1.0],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['3:2', 3 / 2],
    ['2:3', 2 / 3],
    ['21:9', 21 / 9],
  ];
  let best = candidates[0];
  let bestDiff = Math.abs(r - best[1]);
  for (const c of candidates) {
    const d = Math.abs(r - c[1]);
    if (d < bestDiff) { best = c; bestDiff = d; }
  }
  return best[0];
}

function _directionPhrase(pads) {
  const parts = [];
  if (pads.top > 0)    parts.push(`${pads.top}px upward (above the original scene)`);
  if (pads.bottom > 0) parts.push(`${pads.bottom}px downward (below the original scene)`);
  if (pads.left > 0)   parts.push(`${pads.left}px to the left`);
  if (pads.right > 0)  parts.push(`${pads.right}px to the right`);
  return parts;
}

export default {
  type: 'outpaint_image',
  intent: 'outpaint_image',
  description: 'Extend (outpaint) an image\'s canvas by adding pixels to one or more sides, filling the new margins with content that seamlessly continues the scene. Internally delegates to generate_image using the same underlying image models. In: "image" (path or attachment id, required), at least one of "padTop" / "padBottom" / "padLeft" / "padRight" (pixels, 0–4096), optional "prompt" (guides what the new margins should contain — e.g. "continue the beach and sky"), optional "outputFormat" (png|jpeg|webp), optional "saveTo" (directory). Returns: { success, provider, model, images: [{ savedTo }] }. Use this when the scene needs to be wider/taller than the source — for style transfer, img2img or composition, use generate_image directly.',
  thinkingHint: 'Outpainting image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: 'Input image — either an absolute file path or an attachment id ("att-1"). This image\'s canvas will be extended.',
      },
      padTop: {
        type: 'number',
        description: 'Pixels to add ABOVE the original image (0–4096). The model will fill these with content that extends the scene upward.',
      },
      padBottom: {
        type: 'number',
        description: 'Pixels to add BELOW the original image (0–4096). The model will fill these with content that extends the scene downward.',
      },
      padLeft: {
        type: 'number',
        description: 'Pixels to add to the LEFT of the original image (0–4096). The model will fill these with content that extends the scene leftward.',
      },
      padRight: {
        type: 'number',
        description: 'Pixels to add to the RIGHT of the original image (0–4096). The model will fill these with content that extends the scene rightward.',
      },
      prompt: {
        type: 'string',
        description: 'Optional guidance for what the new margins should contain (e.g. "continue the ocean and horizon", "add more forest canopy"). Prepended to an auto-built outpainting instruction. Max ~1024 chars.',
      },
      outputFormat: {
        type: 'string',
        description: 'Output image format — png (default, lossless), jpeg, or webp.',
      },
      saveTo: {
        type: 'string',
        description: 'Directory path where the result should be saved. If omitted, the image lands in ~/.koi/images/.',
      },
    },
    required: ['image'],
  },

  examples: [
    { intent: 'outpaint_image', image: 'att-1', padRight: 512 },
    { intent: 'outpaint_image', image: 'att-1', padTop: 256, padBottom: 256, prompt: 'extend the sky upward and the ocean downward' },
    { intent: 'outpaint_image', image: '/Users/me/.koi/images/photo.png', padLeft: 400, padRight: 400, saveTo: '/Users/me/project/wide' },
  ],

  async execute(action, agent) {
    if (!action.image) {
      return { success: false, error: 'outpaint_image: "image" is required (file path or attachment id)' };
    }

    const pads = {
      top:    _clampPad(action.padTop),
      bottom: _clampPad(action.padBottom),
      left:   _clampPad(action.padLeft),
      right:  _clampPad(action.padRight),
    };
    const totalPad = pads.top + pads.bottom + pads.left + pads.right;
    if (totalPad === 0) {
      return { success: false, error: 'outpaint_image: at least one of padTop/padBottom/padLeft/padRight must be > 0.' };
    }

    // Resolve attachment id → real path if needed.
    let inputPath = action.image;
    if (/^att-\d+$/.test(inputPath)) {
      try {
        const { attachmentRegistry } = await import('../../state/attachment-registry.js');
        const entry = attachmentRegistry.get(inputPath);
        if (!entry?.path) {
          return { success: false, error: `Attachment not found: ${inputPath}` };
        }
        inputPath = entry.path;
      } catch (e) {
        return { success: false, error: `Failed to resolve attachment ${inputPath}: ${e.message}` };
      }
    }

    const resolvedPath = path.resolve(inputPath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `Input image not found: ${resolvedPath}` };
    }

    // Read dimensions from the source — we only need metadata, not pixel
    // transformations. Sharp is already a dep of the runtime; a miss here
    // is unrecoverable.
    let origWidth, origHeight;
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(resolvedPath).metadata();
      origWidth = meta.width || 0;
      origHeight = meta.height || 0;
      if (!origWidth || !origHeight) {
        return { success: false, error: `Could not read dimensions from ${resolvedPath}` };
      }
    } catch (err) {
      return { success: false, error: `Failed to read image metadata: ${err.message}` };
    }

    const newWidth = origWidth + pads.left + pads.right;
    const newHeight = origHeight + pads.top + pads.bottom;
    const newAspect = _closestAspectRatio(newWidth, newHeight);

    // Describe where the original content sits IN THE NEW CANVAS so the
    // edit model places it correctly. Using percentages because general
    // edit models reason about composition in relative terms, not pixels.
    const placement = _placementDescription(pads, newWidth, newHeight);
    const directions = _directionPhrase(pads);
    const directionsList = directions.length > 0 ? directions.join(', ') : 'on the added margins';

    const userPrompt = typeof action.prompt === 'string' && action.prompt.trim()
      ? String(action.prompt).slice(0, 1024).trim()
      : '';

    const basePrompt =
      `Outpaint the reference image by producing a WIDER/TALLER version at aspect ratio ${newAspect || `${newWidth}:${newHeight}`}. ` +
      `Keep the reference image's scene, subjects, composition, style, perspective, lighting, and color palette intact — ${placement}. ` +
      `Extend the scene naturally by ${directionsList}, inventing plausible new content that matches the reference's texture and atmosphere seamlessly at the edges. ` +
      `The final image must read as a larger photograph of the SAME moment — not a crop, not a stylised reinterpretation, not a different scene.`;

    const effectivePrompt = userPrompt
      ? `${basePrompt}\n\nAdditional guidance for the extended regions: ${userPrompt}`
      : basePrompt;

    channel.log(
      'image',
      `outpaint_image: source=${path.basename(resolvedPath)} ${origWidth}×${origHeight} → ${newWidth}×${newHeight} ` +
      `(T${pads.top}/B${pads.bottom}/L${pads.left}/R${pads.right}) aspect=${newAspect || '-'}`,
    );

    // Delegate to generate_image. Pass the ORIGINAL image as the reference
    // and let the aspect ratio + prompt drive the extension. Same label-
    // free models as generate_image — no operation tag.
    const genAction = {
      prompt: effectivePrompt,
      referenceImages: [{ alias: 'source', path: resolvedPath }],
      aspectRatio: newAspect || undefined,
      outputFormat: action.outputFormat || 'png',
      saveTo: action.saveTo,
      n: 1,
    };

    const result = await generateImageAction.execute(genAction, agent);

    if (!result || result.success === false) {
      return {
        ...(result || {}),
        success: false,
        operation: 'outpaint',
        hint: result?.hint ||
          'Outpaint delegates to generate_image with a reference image. If no model advertises referenceImages support, sign in (gateway mode) or configure a provider that supports image editing.',
      };
    }

    // Pixel-identical preservation of the original: edit models (GPT-Image,
    // Gemini 2.5 Flash Image, etc.) do not guarantee that a source region
    // survives the round-trip — in practice they redraw everything, which
    // surfaces as "the outpaint output looks similar but NOT the same".
    // Here we force the guarantee: resize the generated canvas to the exact
    // target dimensions, then composite the ORIGINAL image on top at the
    // requested offset. Result: original pixels verbatim; model-invented
    // content only in the margins.
    try {
      const sharp = (await import('sharp')).default;
      for (const img of result.images || []) {
        if (!img.savedTo || !fs.existsSync(img.savedTo)) continue;
        const resized = await sharp(img.savedTo)
          .resize(newWidth, newHeight, { fit: 'fill' })
          .toBuffer();
        const stamped = await sharp(resized)
          .composite([{ input: resolvedPath, left: pads.left, top: pads.top }])
          .toFormat(action.outputFormat || 'png')
          .toBuffer();
        fs.writeFileSync(img.savedTo, stamped);
      }
    } catch (err) {
      channel.log('image', `outpaint_image: original composite step failed: ${err.message}`);
    }

    // Record provenance so `recall_facts` knows where each pixel came from.
    try {
      const { recordImageOp } = await import('../../state/image-lineage.js');
      for (const img of result.images || []) {
        if (!img.savedTo) continue;
        recordImageOp({
          op: 'outpaint',
          outputPath: img.savedTo,
          sourcePath: resolvedPath,
          params: {
            padTop: pads.top,
            padBottom: pads.bottom,
            padLeft: pads.left,
            padRight: pads.right,
            finalSize: `${newWidth}x${newHeight}`,
          },
          agentName: agent?.name,
        });
      }
    } catch { /* lineage is best-effort */ }

    return {
      ...result,
      operation: 'outpaint',
      padTop: pads.top,
      padBottom: pads.bottom,
      padLeft: pads.left,
      padRight: pads.right,
      originalSize: `${origWidth}x${origHeight}`,
      finalSize: `${newWidth}x${newHeight}`,
    };
  },
};

function _placementDescription(pads, newW, newH) {
  const verticalLabel = _positionLabel(pads.top, pads.bottom, 'top', 'bottom');
  const horizontalLabel = _positionLabel(pads.left, pads.right, 'left', 'right');
  const pieces = [];
  if (verticalLabel) pieces.push(verticalLabel);
  if (horizontalLabel) pieces.push(horizontalLabel);
  const where = pieces.length === 0 ? 'centered' : pieces.join(' and ');
  return `position the reference's existing content ${where} in the new canvas (${newW}×${newH})`;
}

function _positionLabel(padA, padB, labelA, labelB) {
  if (padA === 0 && padB === 0) return '';
  if (padA > 0 && padB === 0) return `anchored to the ${labelB}`;
  if (padB > 0 && padA === 0) return `anchored to the ${labelA}`;
  const axis = labelA === 'top' ? 'vertically' : 'horizontally';
  if (Math.abs(padA - padB) / Math.max(padA, padB) < 0.15) return `${axis} centered`;
  return padA > padB ? `closer to the ${labelB}` : `closer to the ${labelA}`;
}
