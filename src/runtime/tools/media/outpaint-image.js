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
 *   2. Builds a TRANSPARENT-padded canvas at the target size with the
 *      original image composited at (padLeft, padTop). The model sees
 *      exactly where the existing scene sits and what regions need
 *      filling — no ambiguity about composition.
 *   3. Composes a prompt that asks the model to FILL the transparent
 *      regions, continuing the scene seamlessly across the boundary.
 *   4. Delegates to generate_image passing the padded canvas as the
 *      reference (not the original). Modern edit models (gpt-image-1
 *      v2+, Gemini 3, Flux Fill) handle alpha reliably and produce
 *      extensions that connect at the boundary instead of regenerating
 *      the whole scene.
 *   5. As a final safety net, the ORIGINAL pixels are composited on
 *      top of the model output at the same offset — guarantees
 *      pixel-identical preservation of the existing region even when
 *      the model nudged it.
 *
 * Permission: 'generate_image' (same billing category).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { channel } from '../../io/channel.js';
import generateImageAction from './generate-image.js';
import asyncCapable from '../_async-capable.js';

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


const outpaintImageAction = {
  type: 'outpaint_image',
  intent: 'outpaint_image',
  bannerKind: 'image',
  bannerLabel: 'Extendiendo imagen',
  bannerIconId: 'outpaint',
  description: 'Extend (outpaint) an image\'s canvas by adding pixels to one or more sides, filling the new margins with content that seamlessly continues the scene. Internally delegates to generate_image using the same underlying image models. In: "image" (path or attachment id, required), at least one of "padTop" / "padBottom" / "padLeft" / "padRight" (pixels, 0–4096), optional "prompt" (see PROMPT TEMPLATE below), optional "outputFormat" (png|jpeg|webp), optional "saveTo" (directory). Returns: { success, provider, model, images: [{ savedTo }] }. Use this when the scene needs to be wider/taller than the source — for style transfer, img2img or composition, use generate_image directly.\n\nPROMPT TEMPLATE — the optional `prompt` field MUST be ENGLISH (translate the user\'s request if it\'s in any other language) and describe ONLY the content for the NEW margins, never restate the geometry (the tool appends the px directions automatically). Use this shape:\n  "<short scene continuation description>. <optional explicit additions the user requested>."\nExamples:\n  • User says nothing → leave `prompt` empty; the tool uses a safe background-continuation default.\n  • User says "extiende el cielo y mete más nubes" → prompt: "Continue the sky with additional natural-looking clouds in the same lighting."\n  • User says "mete más personas a los lados" → prompt: "Add 2–3 additional pedestrians walking on the cobblestone in the new margins, dressed consistently with the existing figure."\n  • User says "que se vea más calle a la derecha" → prompt: "Continue the cobblestone street, shopfronts and trees to the right at the same perspective."\nDO NOT include phrases like "no new people / no new objects" — those are the tool\'s default guards and they conflict with users who DO want new content. The tool already appends a universal "no text, no captions, no labels" tail, so don\'t restate it. Keep the prompt to ONE coherent sentence.',
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
        description: 'Optional guidance for what the new margins should contain (e.g. "continue the ocean and horizon", "add more forest canopy"). Prepended to an auto-built outpainting instruction. Max ~1024 chars. MANDATORY: write the prompt in English regardless of the user\'s language — outpaint models are trained on English captions. The ONLY exception is text that must literally appear in the extended canvas (a sign, a label), which stays in the user\'s language wrapped in quotes inside the otherwise-English prompt.',
      },
      outputFormat: {
        type: 'string',
        description: 'Output image format — png (default, lossless), jpeg, or webp.',
      },
      saveTo: {
        type: 'string',
        description: 'Where to place a COPY of the result (a directory, or a full image file path). The original always stays in ~/.koi/images/ (images[].savedTo); the copy at your saveTo is images[].exportedTo.',
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
    // Guard — see generate-image.js for rationale.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('outpaint_image', agent);
    if (_guard) return _guard;

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

    let newWidth = origWidth + pads.left + pads.right;
    let newHeight = origHeight + pads.top + pads.bottom;

    // Output-canvas cap enforcement. Ask the router which slug it
    // would dispatch to and read `constraints.output.maxArea /
    // maxDimension` off it. When present, resize the source AND the
    // requested pads by the same factor so the composed canvas
    // lands inside the cap.
    //
    // We DON'T have an `agent.imageGen` handle here — outpaint
    // delegates to generate_image which resolves the provider
    // internally. So we walk the same path the gateway picker
    // would: fetch the media catalog, run `peekImageModel` with
    // the request shape we're about to send, and read constraints
    // off the picked model.
    let pickedModel = null;
    try {
      const { fetchMediaCapabilities } = await import('../../llm/providers/gateway.js');
      const { peekImageModel } = await import('../../llm/providers/media-model-router.js');
      const caps = await fetchMediaCapabilities('image');
      if (caps && Array.isArray(caps.models) && caps.models.length > 0) {
        pickedModel = peekImageModel(caps.models, {
          intent: 'outpaint',
          refsCount: 1,
          hasMaskImage: true,
          hasSourceImage: true,
          hasTargetSize: true,
          hasSourceImageOffset: true,
        }) || null;
      }
    } catch { /* no peek → no restrictions to honour */ }
    const { clampOutputDims } = await import('../../llm/providers/_constraints.js');
    // The helper logs `[detect] <slug>.output exceeds <cap>` when it
    // fires. The tool below adds the post-resize log line so the
    // operator sees both "what was detected" and "what the tool did".
    channel.log(
      'constraints',
      `[tool  ] outpaint_image: composed ${newWidth}×${newHeight} (orig ${origWidth}×${origHeight} + ` +
      `pads T${pads.top}/B${pads.bottom}/L${pads.left}/R${pads.right}) — ` +
      `checking ${pickedModel?.slug ?? '?'}.output caps…`,
    );
    const clamp = clampOutputDims({ width: newWidth, height: newHeight }, pickedModel);

    let workingPath = resolvedPath;
    if (clamp.needsResize) {
      const scale = clamp.scale;
      const scaledOrigW = Math.max(1, Math.floor(origWidth * scale));
      const scaledOrigH = Math.max(1, Math.floor(origHeight * scale));
      const scaledPads = {
        left: Math.max(0, Math.floor(pads.left * scale)),
        right: Math.max(0, Math.floor(pads.right * scale)),
        top: Math.max(0, Math.floor(pads.top * scale)),
        bottom: Math.max(0, Math.floor(pads.bottom * scale)),
      };
      try {
        const sharp = (await import('sharp')).default;
        const scaledPath = path.join(os.tmpdir(), `outpaint-src-${Date.now()}.png`);
        await sharp(resolvedPath)
          .resize(scaledOrigW, scaledOrigH, { fit: 'fill' })
          .png({ compressionLevel: 9, palette: false })
          .toFile(scaledPath);
        workingPath = scaledPath;
        channel.log(
          'constraints',
          `[apply ] outpaint_image resized source + pads to fit ${pickedModel?.slug ?? '?'}.output: ` +
          `source ${origWidth}×${origHeight} → ${scaledOrigW}×${scaledOrigH}, ` +
          `pads T${pads.top}/B${pads.bottom}/L${pads.left}/R${pads.right} → ` +
          `T${scaledPads.top}/B${scaledPads.bottom}/L${scaledPads.left}/R${scaledPads.right}, ` +
          `composed ${scaledOrigW + scaledPads.left + scaledPads.right}×` +
          `${scaledOrigH + scaledPads.top + scaledPads.bottom}, scale=${scale.toFixed(3)}`,
        );
        origWidth = scaledOrigW;
        origHeight = scaledOrigH;
        pads.left = scaledPads.left;
        pads.right = scaledPads.right;
        pads.top = scaledPads.top;
        pads.bottom = scaledPads.bottom;
        newWidth = origWidth + pads.left + pads.right;
        newHeight = origHeight + pads.top + pads.bottom;
      } catch (err) {
        return { success: false, error: `Failed to pre-resize source for outpaint cap: ${err.message}` };
      }
    }

    const newAspect = _closestAspectRatio(newWidth, newHeight);

    // Build the transparent-padded canvas: a `newWidth × newHeight`
    // PNG with full alpha=0, with the original image composited at
    // (padLeft, padTop). The model sees the exact spatial layout —
    // there is no ambiguity about where the existing pixels live and
    // which regions need filling. This is the key win over the old
    // "pass original + describe layout in prompt" approach: that one
    // gave the model freedom to RECOMPOSE the whole scene, which is
    // what produced the "picture-in-picture" seam we kept hitting.
    //
    // We also build a companion MASK (white in the new margins, black
    // over the original region). Adapters whose underlying model takes
    // a separate `mask_url` (flux-pro/v1/fill) consume it from the
    // canonical request's `maskImage`. Adapters that handle alpha
    // natively (gpt-image, gemini) ignore it.
    const paddedCanvasPath = path.join(os.tmpdir(), `outpaint-canvas-${Date.now()}.png`);
    let maskBuffer;
    try {
      const sharp = (await import('sharp')).default;
      const canvasBuffer = await sharp({
        create: {
          width: newWidth,
          height: newHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([{ input: workingPath, left: pads.left, top: pads.top }])
        .png()
        .toBuffer();
      fs.writeFileSync(paddedCanvasPath, canvasBuffer);

      // Mask: RGB canvas (sharp's create only supports 3 or 4 channels),
      // white background (= "fill this") with a black rectangle over the
      // original image's footprint (= "keep"). Adapters that need a
      // single-channel mask can extract one trivially since RGB values
      // are identical here.
      const blackPatch = await sharp({
        create: { width: origWidth, height: origHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
      }).png().toBuffer();
      maskBuffer = await sharp({
        create: { width: newWidth, height: newHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite([{ input: blackPatch, left: pads.left, top: pads.top }])
        .png()
        .toBuffer();
    } catch (err) {
      return { success: false, error: `Failed to build padded canvas: ${err.message}` };
    }

    const directions = _directionPhrase(pads);
    const directionsList = directions.length > 0 ? directions.join(', ') : 'on the added margins';

    const userPrompt = typeof action.prompt === 'string' && action.prompt.trim()
      ? String(action.prompt).slice(0, 1024).trim()
      : '';

    // The prompt has to survive TWO very different model families:
    //
    //   - Instruction-following edit models (gpt-image, gemini-edit) that
    //     need to be told "don't recompose the whole scene" or they will.
    //   - Pure fill/inpaint models (flux-pro/v1/fill) that do NOT follow
    //     instructions — they treat any English text as CONTENT to render
    //     into the masked region. We have screenshots of the prompt's own
    //     words coming back as post-it notes inside the painted margins.
    //
    // The CALLING AGENT is responsible for emitting an English prompt
    // that already incorporates user intent + scene description. The
    // tool's `description` field documents the required template for
    // that prompt (see action spec above). All we do here is:
    //   - When the agent passed a prompt, use it as-is and append a
    //     short geometry hint + the universal "no text/captions/labels"
    //     guard (text in painted margins is the #1 outpaint failure
    //     mode across every model we've shipped).
    //   - When the agent passed NO prompt, fall back to a safe-default
    //     prompt: pure background continuation with the full guard
    //     list (no new people / objects / text / captions). This is
    //     the right default for "extend the canvas, don't add stuff".
    const guardsTail = `No text, no captions, no labels.`;
    const effectivePrompt = userPrompt
      ? `${userPrompt} Extend the canvas ${directionsList}, matching the existing art style, palette, lighting, and texture at the boundary. ${guardsTail}`
      : `Continue the existing scene into the surrounding background area, ${directionsList}. ` +
        `Match the same art style, color palette, texture, and lighting as the existing pixels at the boundary. ` +
        `Background continuation only — no new people, no new objects, ${guardsTail.toLowerCase()}`;

    channel.log(
      'image',
      `outpaint_image: source=${path.basename(resolvedPath)} ${origWidth}×${origHeight} → ${newWidth}×${newHeight} ` +
      `(T${pads.top}/B${pads.bottom}/L${pads.left}/R${pads.right}) aspect=${newAspect || '-'} canvas=${path.basename(paddedCanvasPath)}`,
    );

    // Delegate to generate_image. Pass the PADDED CANVAS (with original
    // at offset, transparent margins) as the reference. The aspect
    // ratio still travels for models that key off it. `operation:
    // "outpaint"` routes the picker to the curated `image_extend`
    // category bucket so a backoffice-tagged model owns extension —
    // the generic edit pool tends to redraw the whole scene rather
    // than painting only the transparent margins.
    // ONE reference image (the padded RGBA canvas). The unpadded original
    // travels via the dedicated `sourceImage` field — keeping it out of
    // referenceImages prevents the router's refsCount filter from excluding
    // single-ref models that are perfectly able to outpaint via reframe.
    //
    // Adapter consumption:
    //   - fill models (flux-pro/v1/fill): refs[0] (padded) + maskImage
    //   - alpha-edit models (gpt-image, gemini-edit): refs[0] (padded), alpha
    //     channel encodes the fill region
    //   - reframe models (bria/expand, ideogram/v3/reframe): sourceImage
    //     (unpadded original) + targetSize + sourceImageOffset
    //
    // Aliases intentionally omitted: a named ref triggers generate-image.js
    // to prepend a "Reference images (by position)" legend to the prompt,
    // which fill models render as visible text inside the painted region.
    let originalBuffer;
    try { originalBuffer = fs.readFileSync(workingPath); } catch { /* fall through; reframe models will fail loudly */ }
    const genAction = {
      // Mark this as an internal tool-to-tool delegation so
      // generate_image bypasses its `requireToolInfoFirst` guard.
      // The guard exists to force the AGENT to read schema before
      // calling blind; from the agent's perspective the request IS
      // `outpaint_image`, and `outpaint_image` knows the
      // `generate_image` schema. Without this flag, the first
      // outpaint call short-circuits into a "here's my docs" return
      // and never actually generates — surfaces as
      // {success:true, tool:'generate_image', documentation:'...'}.
      _internalDelegate: true,
      prompt: effectivePrompt,
      // `intent` routes the picker to the `image_extend` bucket (see
      // media-model-router.js:pickImageModel). The `operation` keys
      // further down in this file are persistence/return metadata
      // ("what was done"), NOT picker signals.
      intent: 'outpaint',
      // outpaint_image already shows its own "Extendiendo imagen…" banner;
      // suppress generate_image's "Generando imagen…" so the user sees one
      // operation, not two stacked progress bars.
      _suppressBanner: true,
      // Forward outpaint's own banner-status emitter so the IN_QUEUE /
      // IN_PROGRESS updates from the nested image submit+poll loop still
      // reach the chat banner the user is looking at.
      _mediaBannerId: action._mediaBannerId,
      _emitMediaStatus: action._emitMediaStatus,
      referenceImages: [paddedCanvasPath],
      maskImage: maskBuffer ? { data: maskBuffer, mimeType: 'image/png' } : undefined,
      sourceImage: originalBuffer ? { data: originalBuffer, mimeType: 'image/png' } : undefined,
      // Persist the ORIGINAL image path on the saved media's metadata so
      // the GUI's Info panel can render a "Source image" thumbnail for
      // outpainted results. Without this the only references the metadata
      // carries are the (temporary) padded canvas + the source-buffer we
      // upload to fal — neither survives on disk after the tool returns,
      // so the Info panel falls back to "no references" even though the
      // user clearly had an original image they were outpainting from.
      _sourceImagePath: resolvedPath,
      targetSize: { width: newWidth, height: newHeight },
      // Where the original sits inside the new canvas. bria/expand uses
      // this to position the source for asymmetric outpaint (e.g.
      // padRight=512 only → original flush to the left). Models that
      // always centre the source ignore it.
      sourceImageOffset: { x: pads.left, y: pads.top },
      aspectRatio: newAspect || undefined,
      outputFormat: action.outputFormat || 'png',
      saveTo: action.saveTo,
      n: 1,
    };

    const result = await generateImageAction.execute(genAction, agent);

    // Clean up the temp canvas regardless of outcome — keeps /tmp tidy
    // and avoids leaking PII (the canvas contains the original image).
    try { fs.unlinkSync(paddedCanvasPath); } catch { /* best-effort */ }
    // Same for the auto-downscaled source copy when we wrote one.
    if (workingPath !== resolvedPath) {
      try { fs.unlinkSync(workingPath); } catch { /* best-effort */ }
    }

    if (!result || result.success === false) {
      return {
        ...(result || {}),
        success: false,
        operation: 'outpaint',
        hint: result?.hint ||
          'Outpaint delegates to generate_image with a reference image. If no model advertises referenceImages support, sign in (gateway mode) or configure a provider that supports image editing.',
      };
    }

    // We used to composite the ORIGINAL image back on top of the model's
    // output (with feathered edges) to guarantee pixel-identical
    // preservation of the source region. In practice modern edit models
    // (GPT-Image, Gemini 2.5 Flash Image, Seedream Edit, …) already produce
    // a continuous, well-blended outpaint when given a reference + padded
    // canvas, and the stamp-on-top step was actively making the result
    // WORSE: it introduced a visible rectangular seam wherever the
    // model's natural rendering of the boundary differed from the
    // original (lighting, contrast, lines crossing the edge). The user-
    // reported failure mode was textbook — model returned a perfect
    // wide-shot continuation, tool slapped the smaller original back in
    // the middle, leaving an obvious hard-edged inset.
    //
    // Trust the model's output. Pixel-identical preservation is the
    // wrong default for outpainting — if the caller genuinely needs the
    // source region untouched they can crop the original back in
    // themselves on top of the result.

    // Record provenance so `recall_memory` knows where each pixel came from.
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

export default asyncCapable(outpaintImageAction);
