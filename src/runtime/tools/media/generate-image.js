/**
 * Generate Image Action — Generate images from text prompts.
 *
 * Delegates to the provider factory which auto-selects the best available
 * image provider: OpenAI (gpt-image-1) → Gemini (gemini-2.5-flash-image).
 *
 * All parameters use NORMALIZED values (aspect ratios, resolutions, etc.)
 * — each provider maps them to its native format internally.
 *
 * Permission: 'generate_image' (individual permission for image generation)
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { ProviderBlockedError } from '../../llm/providers/base.js';
import { blockedResult } from '../../llm/blocked-result.js';

import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../io/channel.js';

// NOTE on the "label" parameter: intentionally NOT declared in the static
// schema or description below. It is injected at import time by the
// fetchMediaCapabilities('image') block at the bottom of this file — and ONLY when
// the backend advertises at least one distinct label across its active image
// models. When the label set is empty (or the fetch fails), the parameter
// simply does not exist from the agent's point of view. Do not re-add it
// here.
const generateImageAction = {
  type: 'generate_image',
  intent: 'generate_image',
  // NOTE: this description is the API-keys fallback. When the backend catalog
  // is reachable, the fetchMediaCapabilities('image') block at the bottom of
  // this file REWRITES this string at import time with the real enums (aspect
  // ratios, resolutions, labels, max n, ref image support) pulled from the
  // /gateway/models/image.json catalog. Do NOT add specific values here —
  // they would become stale the moment the catalog changes.
  description: 'Generate an image from a text prompt. In: "prompt" (required), optional "aspectRatio", optional "resolution", optional "n", optional "referenceImages", optional "saveTo". Returns: { success, provider, model, images: [{ url?, b64?, savedTo? }] }.',
  thinkingHint: 'Generating image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string', description: 'Text description of the desired image' },
      aspectRatio:     { type: 'string', description: 'Aspect ratio — must be one of the values in the enum (populated at runtime from the backend catalog). Omit to let the backend pick.' },
      resolution:      { type: 'string', description: 'Resolution — must be one of the values in the enum (populated at runtime from the backend catalog). Omit to let the backend pick.' },
      n:               { type: 'number', description: 'Number of images to generate (default: 1)' },
      referenceImages: { type: 'array',  description: 'Array of attachment IDs (e.g. "att-1") or file paths for reference images. Annotation attachments are automatically excluded.', items: { type: 'string' } },
      outputFormat:    { type: 'string', description: 'Output format: png, webp, jpeg, b64_json (default: png)' },
      saveTo:          { type: 'string', description: 'Directory path to save generated images. If omitted, images are returned as base64.' },
      model:           { type: 'string', description: 'Specific model slug to force (optional — normally you should let the backend pick the cheapest capable model).' },
      excludeProviders:{ type: 'array',  description: 'Retry hint: skip these provider families when picking a model. Use on retry after a previous call returned blocked:true — pass the blocked provider here so the next attempt uses a different family. Examples: ["openai"], ["openai","google"].', items: { type: 'string' } }
    },
    required: ['prompt']
  },

  examples: [
    { intent: 'generate_image', prompt: 'A serene mountain lake at sunset, oil painting style' },
    { intent: 'generate_image', prompt: 'Logo for a tech startup' },
    { intent: 'generate_image', prompt: 'Using the reference image as a STYLE guide, create an illustration of a smartphone floating in perspective, in the exact art style of the reference image', referenceImages: ['att-1'] },
    { intent: 'generate_image', prompt: 'Edit the reference image: change the eye color to red, keep everything else identical', referenceImages: ['/Users/me/.koi/images/kitten.png'] }
  ],

  async execute(action, agent) {
    const prompt = action.prompt;
    if (!prompt) throw new Error('generate_image: "prompt" is required');

    // Get clients from the agent's LLM provider
    const clients = agent?.llmProvider?.getClients?.() || {};

    // Resolve image provider. `excludeProviders` is populated by the
    // Coordinator on retry — it passes the provider family from the
    // previous BlockedResult so the factory picks a different one.
    let resolved;
    try {
      resolved = resolveModel({
        type: 'image',
        clients,
        model: action.model,
        excludeProviders: Array.isArray(action.excludeProviders) ? action.excludeProviders : undefined,
      });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const instance = resolved.instance;
    const caps = instance.capabilities;

    // Load reference images from file paths.
    // Each reference image used for generation is saved to the media library
    // (deduplicated by content hash — won't store duplicates).
    let referenceImages;
    const _savedRefIds = {}; // filePath → media library ID
    if (action.referenceImages?.length) {
      if (!caps.referenceImages) {
        channel.log('image', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
      } else {
        referenceImages = [];
        const maxRef = caps.maxReferenceImages || 1;
        // Resolve attachment IDs (att-N) to real paths.
        const _resolvedRefs = [];
        try {
          const { attachmentRegistry: _ar } = await import('../../state/attachment-registry.js');
          for (const p of action.referenceImages) {
            if (typeof p === 'string' && /^att-\d+$/.test(p)) {
              const entry = _ar.get(p);
              if (entry?.path) {
                _resolvedRefs.push(entry.path);
                continue;
              }
            }
            _resolvedRefs.push(p);
          }
        } catch {
          _resolvedRefs.push(...action.referenceImages);
        }
        for (const filePath of _resolvedRefs.slice(0, maxRef)) {
          const resolvedPath = path.resolve(filePath);
          if (!fs.existsSync(resolvedPath)) {
            return { success: false, error: `Reference image not found: ${filePath}` };
          }
          const data = fs.readFileSync(resolvedPath);
          const ext = path.extname(resolvedPath).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
          referenceImages.push({ data, mimeType: mimeMap[ext] || 'image/png' });

          // Save reference image to media library (dedup by hash, non-blocking)
          try {
            const { MediaLibrary } = await import('../../state/media-library.js');
            const lib = MediaLibrary.global();
            const result = await lib.save({
              filePath: resolvedPath,
              metadata: { source: 'reference', usedForGeneration: true },
              description: `Reference image: ${path.basename(resolvedPath)}`,
            });
            _savedRefIds[resolvedPath] = result.id;
            channel.log('image', `Reference image ${result.isNew ? 'saved to' : 'already in'} media library: ${result.id}`);
          } catch (mlErr) {
            channel.log('image', `Media library ref save failed (non-fatal): ${mlErr.message}`);
          }
        }
      }
    }

    // Log full generation request details
    const refPaths = action.referenceImages?.length ? action.referenceImages : [];
    channel.log('image', `generate_image: ${resolved.provider}/${resolved.model}, prompt="${prompt.substring(0, 150)}...", aspectRatio=${action.aspectRatio || '-'}, resolution=${action.resolution || '-'}, n=${action.n || 1}, refs=${refPaths.length}${refPaths.length ? ' [' + refPaths.map(p => path.basename(p)).join(', ') + ']' : ''}, saveTo=${action.saveTo || 'default'}`);

    // Passthrough: only forward params the agent actually supplied. The
    // client-side router (media-model-router.js) picks a model that accepts
    // exactly those constraints — fabricating defaults here would reintroduce
    // stale vocabulary (e.g. 'medium') that the live backend catalog does not
    // advertise.
    const genOpts = {
      outputFormat: action.outputFormat || (action.saveTo ? 'png' : 'b64_json'),
      referenceImages,
    };
    if (action.aspectRatio) genOpts.aspectRatio = action.aspectRatio;
    if (action.resolution)  genOpts.resolution  = action.resolution;
    if (action.n && action.n > 1) genOpts.n = action.n;
    if (action.label) genOpts.label = action.label;

    let result;
    try {
      result = await instance.generate(prompt, genOpts);
    } catch (genErr) {
      // Structured block from the provider: policy refusal, rate limit,
      // auth, quota. This is the happy path for "the provider said no" —
      // the Coordinator reads `blocked: true` + `retryable` and decides
      // whether to try a different provider.
      if (genErr instanceof ProviderBlockedError) {
        return {
          ...blockedResult({
            blockType: genErr.blockType,
            provider: genErr.provider || resolved.provider,
            reason: genErr.providerReason || genErr.message,
            retryable: genErr.retryable,
          }),
          model: resolved.model,
        };
      }

      const errMsg = genErr.message || String(genErr);
      const details = genErr.details || null;
      // Structured router error — backend couldn't find a model whose HARD
      // capabilities match the request (canEdit for reference images,
      // maxImages, resolution, aspect_ratio). Labels are ranking-only and
      // never cause this error, so we don't return availableLabels here.
      // The agent should retry by dropping the constraint that doesn't fit
      // (fewer images, smaller resolution, no reference images, etc.).
      if (details?.code === 'no_model_matches') {
        // `alternatives` is a per-dimension diagnostic: for each requirement
        // the caller supplied, the list of image models that WOULD match if
        // that dimension had been the only constraint. The agent uses it to
        // reconcile its request — pick a model listed under one dimension
        // and drop/relax the other constraint.
        return {
          success: false,
          errorType: 'no_model_matches',
          error: errMsg,
          requirements: details.requirements || null,
          alternatives: details.alternatives || null,
          hint: 'No single active model satisfies every hard constraint at once. Inspect `alternatives` — each key is one of your requested features and its list is the models that would accept it in isolation. Cross-reference the lists to find a combination that is actually supported, then retry with a compatible request (different resolution, different aspectRatio, fewer reference images, smaller n, etc.).',
        };
      }
      // Fallback classification for providers that don't (yet) throw
      // ProviderBlockedError. Uses message-matching on the provider's raw
      // error text — less reliable than the structured path above, but
      // still surfaces the common cases in a shape the Coordinator can
      // route around. New providers should throw ProviderBlockedError
      // directly so we can drop these regexes over time.
      const isContentPolicy = /safety|policy|nsfw|blocked|prohibited|inappropriate|harmful/i.test(errMsg);
      const isTimeout = /timeout|timed out|deadline/i.test(errMsg);
      const isQuota = /quota|rate.limit|429|too many/i.test(errMsg);
      if (isContentPolicy) {
        return {
          ...blockedResult({
            blockType: 'provider_policy',
            provider: resolved.provider,
            reason: errMsg,
          }),
          model: resolved.model,
        };
      }
      if (isQuota) {
        return {
          ...blockedResult({
            blockType: /quota/i.test(errMsg) ? 'quota' : 'rate_limit',
            provider: resolved.provider,
            reason: errMsg,
          }),
          model: resolved.model,
        };
      }
      const errorType = isTimeout ? 'timeout' : 'generation_error';
      return {
        success: false,
        provider: resolved.provider,
        model: resolved.model,
        error: errMsg,
        errorType,
        capabilities: caps,
      };
    }

    // Always save images to disk — persistent dir so they survive across sessions
    if (result.images?.length) {
      const saveDir = path.join(os.homedir(), '.koi', 'images');
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        // Download from URL if no base64 data
        if (!img.b64 && img.url) {
          try {
            const resp = await fetch(img.url);
            if (resp.ok) {
              const contentType = resp.headers.get('content-type') || '';
              const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'png';
              const filename = `image_${Date.now()}_${i}.${ext}`;
              const filePath = path.join(saveDir, filename);
              const buffer = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(filePath, buffer);
              img.savedTo = filePath;
              channel.log('image', `Downloaded and saved: ${filePath} (${(buffer.length / 1024).toFixed(0)}KB)`);
            }
          } catch (dlErr) {
            channel.log('image', `Failed to download ${img.url}: ${dlErr.message}`);
          }
        }
        if (img.b64) {
          const ext = action.outputFormat || 'png';
          const filename = `image_${Date.now()}_${i}.${ext}`;
          const filePath = path.join(saveDir, filename);
          fs.writeFileSync(filePath, Buffer.from(img.b64, 'base64'));
          img.savedTo = filePath;
          channel.log('image', `Saved: ${filePath}`);
        }
      }
    }

    // Verify images were actually generated
    const images = result.images || [];
    const hasImages = images.length > 0 && images.some(img => img.url || img.b64 || img.savedTo);
    if (!hasImages) {
      return {
        success: false,
        provider: resolved.provider,
        model: resolved.model,
        error: result.error || result.message || 'Image generation returned no images. The model may have rejected the prompt (content policy) or timed out.',
        capabilities: caps,
      };
    }

    // Build a clean response with only saved paths (strip large b64 data)
    const savedImages = images
      .filter(img => img.savedTo || img.url)
      .map(img => ({
        ...(img.savedTo ? { savedTo: img.savedTo } : {}),
        ...(img.url ? { url: img.url } : {}),
        ...(img.width ? { width: img.width } : {}),
        ...(img.height ? { height: img.height } : {}),
      }));

    // Auto-save generated images to media library (non-blocking)
    try {
      const { saveGeneratedImage } = await import('../../state/media-library.js');
      for (const img of savedImages) {
        if (img.savedTo) {
          await saveGeneratedImage(img.savedTo, {
            prompt: action.prompt,
            negativePrompt: action.negativePrompt || null,
            model: resolved.model,
            provider: resolved.provider,
            aspectRatio: action.aspectRatio || null,
            outputFormat: action.outputFormat || 'png',
            stylePreset: action.stylePreset || null,
            // Store media library IDs of reference images (not file paths)
            referenceImageIds: Object.values(_savedRefIds),
            referenceImagePaths: (action.referenceImages || []).map(r => typeof r === 'string' ? r : r.filePath).filter(Boolean),
            seed: action.seed || null,
            steps: action.steps || null,
            guidanceScale: action.guidanceScale || null,
            width: img.width || null,
            height: img.height || null,
          }, agent?.llmProvider || null);
          channel.log('image', `Saved to media library: ${img.savedTo}`);
        }
      }
    } catch (mlErr) {
      channel.log('image', `Media library save failed (non-fatal): ${mlErr.message}`);
    }

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      supportedAspectRatios: caps.aspectRatios,
      imageCount: savedImages.length,
      images: savedImages,
      usage: result.usage,
    };
  }
};

// Fire-and-forget: build the tool schema dynamically from the backend's
// /gateway/models/image.json. The rule: the agent must only ever see values
// the backend can actually serve. If the backend advertises no aspect ratios
// → the aspectRatio parameter goes away. Same for resolutions, labels, and
// reference images. The static schema above is the fallback for API-keys
// mode (no backend reach).
//
// The fetchMediaCapabilities('image') helper in providers/gateway.js returns
// the pre-computed union of all capabilities. We replace each schema property
// in-place with an enum/limit pulled from that union.
fetchMediaCapabilities('image').then((caps) => {
  if (!caps) return; // backend unreachable → keep static defaults

  const props = generateImageAction.schema.properties;

  // Sync the schema props with the catalog (used for JSON-schema validation
  // and by any tool-introspection consumer).
  if (caps.aspectRatios?.length) {
    props.aspectRatio = { type: 'string', enum: caps.aspectRatios };
  } else {
    delete props.aspectRatio;
  }
  if (caps.resolutions?.length) {
    props.resolution = { type: 'string', enum: caps.resolutions };
  } else {
    delete props.resolution;
  }
  if (caps.maxImages > 1) {
    props.n = { type: 'number', minimum: 1, maximum: caps.maxImages };
  } else {
    delete props.n;
  }
  const refsEnabled = caps.hasRefImageSupport && caps.anyCanEdit;
  if (refsEnabled) {
    props.referenceImages = { type: 'array', items: { type: 'string' } };
  } else {
    delete props.referenceImages;
  }
  if (caps.labels?.length) {
    props.label = { type: 'string', enum: caps.labels };
  } else {
    delete props.label;
  }

  // Rewrite the tool description IN PLACE, inlining the real values from the
  // catalog. This is the string the agent actually sees in AVAILABLE ACTIONS
  // — so the allowed values must live here, not in schema-property metadata
  // that the renderer does not unfold.
  const fields = ['"prompt" (required) — text description of the desired image'];

  if (caps.aspectRatios?.length) {
    const list = caps.aspectRatios.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "aspectRatio" — one of: ${list}. Pick based on user intent (portrait → tall, landscape → wide). Omit to let the backend pick.`);
  }
  if (caps.resolutions?.length) {
    const list = caps.resolutions.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "resolution" — one of: ${list}. Omit to let the backend pick.`);
  }
  if (caps.maxImages > 1) {
    fields.push(`optional "n" — integer 1..${caps.maxImages} (default 1)`);
  }
  if (refsEnabled) {
    const maxRef = caps.maxRefImages ? ` Max ${caps.maxRefImages}.` : '';
    fields.push(`optional "referenceImages" — array of attachment IDs (e.g. "att-1") or absolute file paths.${maxRef} Annotation attachments are auto-excluded.`);
  }
  if (caps.labels?.length) {
    const list = caps.labels.map((l) => `"${l}"`).join(', ');
    fields.push(`optional "label" — ranking preference, one of: ${list}. Soft hint only, never filters.`);
  }
  fields.push('optional "saveTo" — absolute directory path where the tool will save the generated image(s). The real path is returned in images[].savedTo — use THAT in any downstream step, never fabricate paths.');

  const header = 'Generate an image from a text prompt. Every parameter and its allowed values are listed below (values are pulled live from the active model catalog — anything outside the enum will be rejected).';
  const refNote = refsEnabled
    ? ' IMPORTANT when using "referenceImages": the image model does NOT automatically know what role the reference plays — state it explicitly in "prompt". Start with a directive such as "Using the reference image as a STYLE guide, ..." (style transfer), "Edit the reference image to ..." (img2img edit), or "Use the reference image as the subject and ..." (subject preservation).'
    : '';
  const fieldsBlock = '\n' + fields.map((f) => `  - ${f}`).join('\n');
  const returns = '\nReturns: { success, provider, model, images: [{ url?, b64?, savedTo? }] }';

  generateImageAction.description = header + fieldsBlock + returns + refNote;
}).catch(() => {});

export default generateImageAction;
