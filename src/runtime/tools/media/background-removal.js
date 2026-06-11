/**
 * Background Removal Action — removes the background from an image.
 *
 * Routes to a Fal model whose catalog entry carries
 * `categories: ["image_background_removal"]`. Model selection happens
 * client-side via pickImageModel (operation: 'background-removal') and
 * the concrete slug is sent to the gateway — the backend never decides.
 *
 * Permission: 'generate_image' (reused — background removal is a form of
 * image creation, same billing category).
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../io/channel.js';
import { normalizeImageForProvider } from './_normalize-image-for-provider.js';
import asyncCapable from '../_async-capable.js';
import { slugFromSourcePath, buildDescribedFilename } from './util/slugify-description.js';
import { exportMediaCopy } from './util/export-copy.js';
import { downloadAssetToFile, undownloadableResult } from '../../io/download-asset.js';

const IMAGE_EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const backgroundRemovalAction = {
  type: 'background_removal',
  intent: 'background_removal',
  description: 'Remove the background from an existing image. Returns a new PNG with transparent background. In: "image" (path or attachment id, required), optional "outputFormat" (png|webp), optional "saveTo" (directory path). Returns: { success, provider, model, images: [{ savedTo }] }.',
  thinkingHint: 'Removing background',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: 'Input image — either an absolute file path or an attachment id ("att-1"). The background will be removed from this image.',
      },
      outputFormat: {
        type: 'string',
        description: 'Output format — png (default, preserves alpha) or webp.',
      },
      saveTo: {
        type: 'string',
        description: 'Where to place a COPY of the result (a directory, or a full .png/.webp file path). The original always stays in ~/.koi/images/ so the creations drawer finds it. Mirrors generate_image. images[].savedTo is the original; images[].exportedTo is the copy at your saveTo.',
      },
    },
    required: ['image'],
  },

  examples: [
    { intent: 'background_removal', image: '/Users/me/.koi/images/product_photo.png' },
    { intent: 'background_removal', image: 'att-1', outputFormat: 'webp' },
    { intent: 'background_removal', image: 'att-1', saveTo: '/Users/me/project/assets' },
  ],

  async execute(action, agent) {
    // Guard — see generate-image.js for rationale.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('background_removal', agent);
    if (_guard) return _guard;

    if (!action.image) {
      return { success: false, error: 'background_removal: "image" is required (file path or attachment id)' };
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

    // Direct-API providers don't currently implement operation-specific
    // routing — only gateway mode routes by Koi categories. Surface a clear
    // error so the user knows to sign in (or run via the gateway).
    if (typeof instance.runOperation !== 'function') {
      return {
        success: false,
        error: 'Background removal is only available when signed in (gateway mode). Current provider does not expose category-based routing.',
        provider: resolved.provider,
      };
    }

    const normalized = await normalizeImageForProvider(resolvedPath);
    if (normalized.converted) {
      channel.log('image', `Input normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
    }
    const imgBuf = fs.readFileSync(normalized.path);
    const imgB64 = `data:${normalized.mimeType};base64,${imgBuf.toString('base64')}`;

    channel.log('image', `background_removal: ${resolved.provider} (auto-select), input=${path.basename(resolvedPath)} (${(imgBuf.length / 1024).toFixed(0)}KB)`);

    // ── Cost confirmation ───────────────────────────────────────────────
    // Background removal bills like any media op, so warn before dispatch.
    // `confirmCost` defaults to true; programmatic callers pass false to skip.
    if (action.confirmCost !== false) try {
      const { fetchMediaCapabilities } = await import('../../llm/providers/gateway.js');
      const { confirmMediaCost } = await import('./cost-permission.js');
      const _slug = resolved.model || null;
      let _name = _slug, _max = null;
      if (_slug) {
        const _caps = await fetchMediaCapabilities('image');
        const _row = (_caps?.models || []).find((m) => m.slug === _slug);
        if (_row) { _max = _row.maxCredits ?? null; _name = _row.displayName || _slug; }
      }
      const _ok = await confirmMediaCost(channel, {
        kind: 'image', model: _name || 'Auto', resolution: null, aspectRatio: null,
        maxCredits: _max, abortSignal: action?.abortSignal,
      });
      if (!_ok) return { success: false, denied: true, message: 'User declined the media generation cost.' };
    } catch (_costErr) {
      channel.log('image', `cost-confirm skipped (${_costErr?.message || _costErr})`);
    }

    let result;
    try {
      result = await instance.runOperation('background-removal', imgB64, {
        outputFormat: action.outputFormat || 'png',
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
          hint: 'No active image model in the `image_background_removal` category. Ask the backend admin to tag at least one model (e.g. bria-rmbg-2.0) with `categories: ["image_background_removal"]`.',
        };
      }
      return { success: false, provider: resolved.provider, error: errMsg };
    }

    // Persist output — honor saveTo when provided (mirrors generate_image).
    // Default lives in ~/.koi/images/ so new results still feed the global
    // media library without the agent having to specify a directory.
    if (!result.images?.length) {
      return { success: false, provider: resolved.provider, model: result.model, error: 'Background removal returned no images.' };
    }

    // ORIGINAL always in ~/.koi/images (media library / creations drawer
    // indexes it); a caller saveTo gets a COPY before the return.
    const saveDir = path.join(os.homedir(), '.koi', 'images');
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const outExt = action.outputFormat === 'webp' ? 'webp' : 'png';
    // Human-readable filename derived from the source image so a
    // batch of bg-removed files stays grouped next to its origin in
    // the gallery / Finder ordering (e.g. `mouse-with-cheese-bgremoved-<ts>_0.png`).
    const slug = slugFromSourcePath(action.image, 'bgremoved');
    const saved = [];
    let lastDl = null; // classified download failure (network|http) for the no-asset path
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i];
      const filename = buildDescribedFilename({ slug, fallback: 'bgremoved', index: i, ext: outExt });
      const filePath = path.join(saveDir, filename);

      if (img.b64) {
        fs.writeFileSync(filePath, Buffer.from(img.b64.replace(/^data:[^;]+;base64,/, ''), 'base64'));
        saved.push({ savedTo: filePath });
        channel.log('image', `Saved: ${filePath}`);
      } else if (img.url) {
        const dl = await downloadAssetToFile(img.url, filePath, { kind: 'image' });
        if (dl.ok) {
          saved.push({ savedTo: filePath, url: img.url });
        } else {
          lastDl = dl;
        }
      }
    }

    if (saved.length === 0) {
      // Transport/DNS failure (the asset exists, retry the download) vs. no data.
      if (lastDl) {
        return undownloadableResult({
          tool: 'remove_background', provider: resolved.provider, model: result.model,
          url: (result.images.find((im) => im.url) || {}).url || '', dl: lastDl, noun: 'image',
        });
      }
      return { success: false, provider: resolved.provider, model: result.model, error: 'Background removal result had no usable image data (no b64 or downloadable url).' };
    }

    // Best-effort media library registration — same as generate_image.
    try {
      const { saveGeneratedImage } = await import('../../state/media-library.js');
      for (const img of saved) {
        if (img.savedTo) {
          await saveGeneratedImage(img.savedTo, {
            prompt: null,
            model: result.model,
            provider: resolved.provider,
            operation: 'background-removal',
            sourceImage: resolvedPath,
            outputFormat: outExt,
          });
        }
      }
    } catch (mlErr) {
      channel.log('image', `Media library save failed (non-fatal): ${mlErr.message}`);
    }

    // Record provenance for the coordinator's recall_memory view.
    try {
      const { recordImageOp } = await import('../../state/image-lineage.js');
      for (const img of saved) {
        if (!img.savedTo) continue;
        recordImageOp({
          op: 'bg-remove',
          outputPath: img.savedTo,
          sourcePath: resolvedPath,
          agentName: agent?.name,
        });
      }
    } catch { /* lineage is best-effort */ }

    // Export a COPY to the caller's saveTo (canonical original already
    // registered above). `savedTo` stays the original; `exportedTo` is the copy.
    if (action.saveTo) {
      saved.forEach((img, i) => {
        if (!img.savedTo) return;
        const copy = exportMediaCopy(img.savedTo, action.saveTo, { index: i, logTag: 'image' });
        if (copy) img.exportedTo = copy;
      });
    }

    return {
      success: true,
      provider: resolved.provider,
      model: result.model,
      operation: 'background-removal',
      imageCount: saved.length,
      images: saved,
      usage: result.usage,
    };
  },
};

export default asyncCapable(backgroundRemovalAction);
