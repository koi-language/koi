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
  description: 'Generate an image from a text prompt. Supports reference images (provider-dependent). Fields: "prompt" (required), optional "aspectRatio", optional "resolution", optional "n", optional "referenceImages" (array of file paths / attachment IDs), optional "saveTo" (directory to save images). For "aspectRatio" and "resolution" you MUST pick one of the exact values from the enum in the schema — the allowed values come from the live backend catalog and any other value will be rejected. Omit either parameter to let the backend choose a default. Returns: { success, provider, model, images: [{ url?, b64?, savedTo?, revisedPrompt? }] }. IMPORTANT when using "referenceImages": the image model does NOT automatically know what role the reference plays — you MUST state it explicitly in "prompt". Start the prompt with a clear directive such as "Using the reference image as a STYLE guide, ..." / "...in the exact art style of the reference image" (for style transfer), or "Edit the reference image to ..." (for img2img edits), or "Use the reference image as the subject and ..." (for subject preservation). If the user supplies a reference for style but asks for a different subject, lead the prompt with the style directive and keep your own stylistic adjectives minimal so they do not compete with the reference.',
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
      model:           { type: 'string', description: 'Specific model slug to force (optional — normally you should let the backend pick the cheapest capable model).' }
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

    // Resolve image provider
    let resolved;
    try {
      resolved = resolveModel({ type: 'image', clients, model: action.model });
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
        // Resolve attachment IDs (att-N) to real paths, filtering out annotations.
        // Annotations contain user markup that would contaminate the generated image.
        const _filteredRefs = [];
        try {
          const { attachmentRegistry: _ar } = await import('../../state/attachment-registry.js');
          for (const p of action.referenceImages) {
            if (typeof p === 'string' && /^att-\d+$/.test(p)) {
              const entry = _ar.get(p);
              if (entry?.role === 'annotation') {
                channel.log('image', `Skipping annotation attachment as reference: ${p} (${entry.fileName})`);
                continue;
              }
              if (entry?.path) {
                _filteredRefs.push(entry.path);
                continue;
              }
            }
            // Raw path fallback — also check filename
            const name = typeof p === 'string' ? path.basename(p) : '';
            if (name.startsWith('braxil-annotation-')) {
              channel.log('image', `Skipping annotation image as reference: ${name}`);
              continue;
            }
            _filteredRefs.push(p);
          }
        } catch {
          // Fallback: filter by filename only
          for (const p of action.referenceImages) {
            const name = typeof p === 'string' ? path.basename(p) : '';
            if (!name.startsWith('braxil-annotation-')) _filteredRefs.push(p);
          }
        }
        for (const filePath of _filteredRefs.slice(0, maxRef)) {
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
      // Detect common error types for the agent to interpret
      const isContentPolicy = /safety|policy|nsfw|blocked|prohibited|inappropriate|harmful/i.test(errMsg);
      const isTimeout = /timeout|timed out|deadline/i.test(errMsg);
      const isQuota = /quota|rate.limit|429|too many/i.test(errMsg);
      const errorType = isContentPolicy ? 'content_policy' : isTimeout ? 'timeout' : isQuota ? 'rate_limit' : 'generation_error';
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

  // Aspect ratios: replace with the exact enum from the backend, or drop.
  if (caps.aspectRatios?.length) {
    props.aspectRatio = {
      type: 'string',
      enum: caps.aspectRatios,
      description: `Aspect ratio for the generated image. Choose one of the supported values: ${caps.aspectRatios.map((v) => `"${v}"`).join(', ')}. Pick based on user intent (portrait/vertical → tall, landscape/wide → wide).`,
    };
  } else {
    delete props.aspectRatio;
  }

  // Resolutions: ditto.
  if (caps.resolutions?.length) {
    props.resolution = {
      type: 'string',
      enum: caps.resolutions,
      description: `Resolution for the generated image. Choose one of: ${caps.resolutions.map((v) => `"${v}"`).join(', ')}.`,
    };
  } else {
    delete props.resolution;
  }

  // Number of images: max bounded by the most permissive active model.
  if (caps.maxImages > 1) {
    props.n = {
      type: 'number',
      minimum: 1,
      maximum: caps.maxImages,
      description: `Number of images to generate (default: 1, max: ${caps.maxImages}).`,
    };
  } else {
    delete props.n;
  }

  // Reference images: only expose the parameter if at least one active model
  // can actually consume reference images. Otherwise the agent never sees it.
  if (caps.hasRefImageSupport && caps.anyCanEdit) {
    const capHint = caps.maxRefImages ? ` Max: ${caps.maxRefImages}.` : '';
    props.referenceImages = {
      type: 'array',
      items: { type: 'string' },
      description: `Array of attachment IDs (e.g. "att-1") or file paths for reference images. Annotation attachments are automatically excluded.${capHint} IMPORTANT: when you pass reference images, state their role explicitly in the prompt — "Using the reference image as a STYLE guide, ...", "Edit the reference image to ...", "Use the reference image as the subject and ...".`,
    };
  } else {
    delete props.referenceImages;
  }

  // Labels: soft ranking preference. Only expose when at least one is
  // advertised, and never filter — passing a label can't fail the call.
  if (caps.labels?.length) {
    const list = caps.labels.map((l) => `"${l}"`).join(', ');
    props.label = {
      type: 'string',
      enum: caps.labels,
      description: `Optional ranking preference — the router prefers (but does not require) a model tagged with this label when several are eligible. Never filters: if no tagged model exists the cheapest capable one is used. Available: ${list}. Omit when you have no preference.`,
    };
    generateImageAction.description += ` Optional "label" ranking hint (one of: ${list}).`;
  } else {
    delete props.label;
  }
}).catch(() => {});

export default generateImageAction;
