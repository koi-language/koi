/**
 * Upscale Image Action — increases an image's resolution.
 *
 * Routes to a Fal model whose catalog entry advertises
 * `operations.includes('upscale')`. Model selection happens client-side via
 * pickImageModel (operation: 'upscale') and the concrete slug is sent to the
 * gateway — the backend never decides.
 *
 * The parameter surface is intentionally provider-neutral: only the knobs
 * that make sense across the whole upscaler ecosystem (Topaz, SeedVR2,
 * Clarity, Recraft, AuraSR…) are first-class. Model-specific exotica
 * (Topaz's `texture`, `subject_detection`, `model` variant, …) travel
 * through the free-form `extra` bag so rare use cases don't have to poison
 * the main contract.
 *
 * Permission: 'generate_image' (reused — upscaling is a form of image
 * creation, same billing category as generate_image and background_removal).
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../io/channel.js';
import { normalizeImageForProvider } from './_normalize-image-for-provider.js';

const IMAGE_EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export default {
  type: 'upscale_image',
  intent: 'upscale_image',
  description: 'Upscale an existing image to a higher resolution. Routes to a Fal model tagged operations.includes("upscale"). In: "image" (path or attachment id, required), optional "upscaleFactor" (1–4, default 2), optional "prompt" (guides generative upscalers like Topaz Redefine / Clarity), optional "creativity" (0–1, normalized across providers), optional "faceEnhancement" (bool), optional "outputFormat" (png|jpeg|webp), optional "saveTo" (directory path). Pass model-specific knobs (e.g. Topaz model variant) via "extra: {}". Returns: { success, provider, model, images: [{ savedTo }] }.',
  thinkingHint: 'Upscaling image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: 'Input image — either an absolute file path or an attachment id ("att-1"). This image will be upscaled.',
      },
      upscaleFactor: {
        type: 'number',
        description: 'How much to scale the image up. Must be between 1 and 4. Default 2 (doubles width and height). Some models only support fixed factors — the adapter clamps to the nearest supported value.',
      },
      prompt: {
        type: 'string',
        description: 'Optional text prompt to guide generative upscalers (Topaz Redefine, Clarity Upscaler, Recraft Creative). Ignored by non-generative upscalers. Max ~1024 chars.',
      },
      creativity: {
        type: 'number',
        description: 'Optional 0.0–1.0 knob controlling how much the upscaler is allowed to invent new detail vs. staying faithful to the source. 0 = fully faithful, 1 = highly creative. Normalized across providers — the adapter maps to each model\'s native scale (Topaz uses 1–6 internally).',
      },
      faceEnhancement: {
        type: 'boolean',
        description: 'Apply face-enhancement pass when the model supports it (Topaz does). Default true for portraits. Ignored by models without face enhancement.',
      },
      outputFormat: {
        type: 'string',
        description: 'Output image format — png (default, lossless), jpeg, or webp.',
      },
      saveTo: {
        type: 'string',
        description: 'Directory path where the result should be saved. Mirrors generate_image / background_removal. If omitted, the image lands in ~/.koi/images/. Filename is auto-generated (upscale_<timestamp>_<i>.<ext>).',
      },
      extra: {
        type: 'object',
        description: 'Free-form pass-through bag for model-specific options the provider-neutral contract doesn\'t expose (e.g. Topaz "model" variant, "texture", "subjectDetection", "denoise"). Keys are forwarded verbatim to the underlying Fal model — use only when you know which provider will handle the call.',
      },
    },
    required: ['image'],
  },

  examples: [
    { intent: 'upscale_image', image: '/Users/me/.koi/images/photo.jpg' },
    { intent: 'upscale_image', image: 'att-1', upscaleFactor: 4 },
    { intent: 'upscale_image', image: 'att-1', prompt: 'sharp fur detail, studio lighting', creativity: 0.4 },
    { intent: 'upscale_image', image: 'att-1', saveTo: '/Users/me/project/hires' },
    { intent: 'upscale_image', image: 'att-1', upscaleFactor: 2, extra: { model: 'Redefine', texture: 4 } },
  ],

  async execute(action, agent) {
    if (!action.image) {
      return { success: false, error: 'upscale_image: "image" is required (file path or attachment id)' };
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

    // Most upscalers (Recraft, Topaz, Clarity, AuraSR, …) reject inputs
    // smaller than 256px on either side. Catching this client-side gives a
    // clear, actionable error in the same turn instead of burning a gateway
    // round-trip on a model-internal "image too small" rejection.
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(resolvedPath).metadata();
      if (meta.width && meta.height && (meta.width < 256 || meta.height < 256)) {
        return {
          success: false,
          error: `Input image is too small (${meta.width}×${meta.height}). Upscalers require at least 256px on each side. Use a larger source image, or generate a new one at higher resolution instead of upscaling.`,
        };
      }
    } catch { /* dimension probe is best-effort — fall through and let the gateway decide */ }

    // Clamp upscaleFactor to the generic 1–4 window. Individual models may
    // only support a subset (2x/4x fixed); the gateway/adapter is responsible
    // for rounding to the nearest supported value.
    let upscaleFactor = typeof action.upscaleFactor === 'number'
      ? action.upscaleFactor
      : 2;
    if (!Number.isFinite(upscaleFactor) || upscaleFactor < 1) upscaleFactor = 1;
    if (upscaleFactor > 4) upscaleFactor = 4;

    // creativity is exposed as 0–1 and forwarded as-is; the adapter side
    // decides how to translate (e.g. Topaz integer 1–6 = round(1 + 5 * x)).
    let creativity;
    if (typeof action.creativity === 'number' && Number.isFinite(action.creativity)) {
      creativity = Math.min(1, Math.max(0, action.creativity));
    }

    // Resolve image provider. Same factory path as generate_image — the
    // operation filter is applied when the gateway picks the concrete slug.
    const clients = agent?.llmProvider?.getClients?.() || {};
    let resolved;
    try {
      resolved = resolveModel({ type: 'image', clients });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const instance = resolved.instance;

    // Direct-API providers don't implement operation-specific routing —
    // only gateway mode routes by operations[]. Surface a clear error so
    // the user knows to sign in (or run via the gateway).
    if (typeof instance.runOperation !== 'function') {
      return {
        success: false,
        error: 'Upscaling is only available when signed in (gateway mode). Current provider does not expose an operations-based router.',
        provider: resolved.provider,
      };
    }

    const normalized = await normalizeImageForProvider(resolvedPath);
    if (normalized.converted) {
      channel.log('image', `Input normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
    }
    const imgBuf = fs.readFileSync(normalized.path);
    const imgB64 = `data:${normalized.mimeType};base64,${imgBuf.toString('base64')}`;

    channel.log('image', `upscale_image: ${resolved.provider} (auto-select), input=${path.basename(resolvedPath)} (${(imgBuf.length / 1024).toFixed(0)}KB), factor=${upscaleFactor}x`);

    let result;
    try {
      result = await instance.runOperation('upscale', imgB64, {
        outputFormat: action.outputFormat || 'png',
        upscaleFactor,
        ...(action.prompt ? { prompt: String(action.prompt).slice(0, 1024) } : {}),
        ...(creativity !== undefined ? { creativity } : {}),
        ...(typeof action.faceEnhancement === 'boolean' ? { faceEnhancement: action.faceEnhancement } : {}),
        ...(action.extra && typeof action.extra === 'object' ? { extra: action.extra } : {}),
      });
      if (result?.model) channel.log('image', `Model resolved → ${result.model}`);
    } catch (err) {
      const errMsg = err.message || String(err);
      const details = err.details || null;
      if (details?.code === 'no_model_matches') {
        return {
          success: false,
          errorType: 'no_model_matches',
          error: errMsg,
          hint: 'No active image model advertises operations.includes("upscale"). Ask the backend admin to tag at least one upscaler model (e.g. fal-ai/topaz/upscale/image, clarity-upscaler) with operations: ["upscale"], then re-sync from Fal.',
        };
      }
      return { success: false, provider: resolved.provider, error: errMsg };
    }

    if (!result.images?.length) {
      return { success: false, provider: resolved.provider, model: result.model, error: 'Upscaler returned no images.' };
    }

    // Persist output — honour saveTo when provided (mirrors generate_image).
    const saveDir = typeof action.saveTo === 'string' && action.saveTo.trim()
      ? path.resolve(action.saveTo.trim())
      : path.join(os.homedir(), '.koi', 'images');
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const outExt = ({ webp: 'webp', jpeg: 'jpg', jpg: 'jpg' }[action.outputFormat] || 'png');
    const saved = [];
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i];
      const filename = `upscale_${Date.now()}_${i}.${outExt}`;
      const filePath = path.join(saveDir, filename);

      if (img.b64) {
        fs.writeFileSync(filePath, Buffer.from(img.b64.replace(/^data:[^;]+;base64,/, ''), 'base64'));
        saved.push({ savedTo: filePath });
        channel.log('image', `Saved: ${filePath}`);
      } else if (img.url) {
        try {
          const resp = await fetch(img.url);
          if (resp.ok) {
            const buffer = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(filePath, buffer);
            saved.push({ savedTo: filePath, url: img.url });
            channel.log('image', `Downloaded and saved: ${filePath} (${(buffer.length / 1024).toFixed(0)}KB)`);
          } else {
            channel.log('image', `Failed to download ${img.url}: HTTP ${resp.status}`);
          }
        } catch (dlErr) {
          channel.log('image', `Failed to download ${img.url}: ${dlErr.message}`);
        }
      }
    }

    if (saved.length === 0) {
      return { success: false, provider: resolved.provider, model: result.model, error: 'Upscaler result had no usable image data (no b64 or downloadable url).' };
    }

    // Best-effort media library registration — same as generate_image /
    // background_removal.
    try {
      const { saveGeneratedImage } = await import('../../state/media-library.js');
      for (const img of saved) {
        if (img.savedTo) {
          await saveGeneratedImage(img.savedTo, {
            prompt: action.prompt || null,
            model: result.model,
            provider: resolved.provider,
            operation: 'upscale',
            sourceImage: resolvedPath,
            outputFormat: outExt,
            upscaleFactor,
          });
        }
      }
    } catch (mlErr) {
      channel.log('image', `Media library save failed (non-fatal): ${mlErr.message}`);
    }

    // Record provenance for the coordinator's recall_facts view.
    try {
      const { recordImageOp } = await import('../../state/image-lineage.js');
      for (const img of saved) {
        if (!img.savedTo) continue;
        recordImageOp({
          op: 'upscale',
          outputPath: img.savedTo,
          sourcePath: resolvedPath,
          params: { factor: `${upscaleFactor}x` },
          agentName: agent?.name,
        });
      }
    } catch { /* lineage is best-effort */ }

    return {
      success: true,
      provider: resolved.provider,
      model: result.model,
      operation: 'upscale',
      upscaleFactor,
      imageCount: saved.length,
      images: saved,
      usage: result.usage,
    };
  },
};
