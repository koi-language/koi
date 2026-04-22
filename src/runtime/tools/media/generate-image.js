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
import { normalizeImageForProvider } from './_normalize-image-for-provider.js';

// NOTE on the "label" parameter: intentionally NOT declared in the static
// schema or description below. It is injected at import time by the
// fetchMediaCapabilities('image') block at the bottom of this file — and ONLY when
// the backend advertises at least one distinct label across its active image
// models. When the label set is empty (or the fetch fails), the parameter
// simply does not exist from the agent's point of view. Do not re-add it
// here.

/**
 * Pick the closest common aspect ratio (string form, e.g. "16:9") to the
 * given pixel dimensions. Used to auto-fill aspectRatio from the base
 * reference image when the agent didn't specify one — providers default
 * to 1:1 otherwise, which crops most real-world photos. Candidate list
 * mirrors what every major provider (OpenAI, Google, Replicate, Fal)
 * accepts.
 */
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

// Resolution buckets, expressed as the pixel ceiling on the longest edge.
// The runtime catalog can advertise buckets under either naming scheme
// (symbolic low/medium/high/ultra or explicit 512/1K/2K/4K), so both sets
// map to the same pixel anchor — we pick whichever form is actually in
// `caps.resolutions` at call time.
const _RES_TO_PX = {
  low: 512, medium: 1024, high: 2048, ultra: 4096,
  '512': 512, '0.5k': 512,
  '1k': 1024, '1024': 1024,
  '2k': 2048, '2048': 2048,
  '4k': 4096, '4096': 4096,
};

/**
 * Pick the smallest catalog resolution whose pixel ceiling is >= the
 * longest edge of the base image. Used to auto-fill `resolution` from
 * the base reference: if the user hands us a 2K photo to edit, returning
 * a 1K downsample is a quality regression — aspect ratio preservation
 * without resolution preservation is half the job.
 *
 * Falls back to the largest available bucket when the source exceeds
 * every catalog option, and returns null when the catalog doesn't use
 * a bucket name we can score (unknown → leave the field unset and let
 * the provider pick its default).
 */
function _closestResolution(pixelMax, available) {
  if (!pixelMax || !Array.isArray(available) || available.length === 0) return null;
  const scored = available
    .map((r) => {
      const k = String(r).toLowerCase();
      return { name: r, px: _RES_TO_PX[k] ?? null };
    })
    .filter((x) => x.px != null)
    .sort((a, b) => a.px - b.px);
  if (scored.length === 0) return null;
  for (const x of scored) if (x.px >= pixelMax) return x.name;
  return scored[scored.length - 1].name;
}

const generateImageAction = {
  type: 'generate_image',
  intent: 'generate_image',
  // NOTE: this description is the API-keys fallback. When the backend catalog
  // is reachable, the fetchMediaCapabilities('image') block at the bottom of
  // this file REWRITES this string at import time with the real enums (aspect
  // ratios, resolutions, labels, max n, ref image support) pulled from the
  // /gateway/models/image.json catalog. Do NOT add specific values here —
  // they would become stale the moment the catalog changes.
  description: 'Generate an image from a text prompt. In: "prompt" (required), optional "aspectRatio", optional "resolution", optional "n", optional "referenceImages" (accepts a plain path array OR objects with {alias, path} for named refs you can mention in the prompt), optional "saveTo". Returns: { success, provider, model, images: [{ url?, b64?, savedTo? }] }.',
  thinkingHint: 'Generating image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string', description: 'Text description of the desired image. When you use named reference images, you can refer to them by alias in the prompt (e.g. "Paint the `illustration` onto the `boat`\'s hull, matching `placement_guide`") — far more precise than "FIRST/SECOND/THIRD reference".' },
      aspectRatio:     { type: 'string', description: 'Aspect ratio — must be one of the values in the enum (populated at runtime from the backend catalog). Omit to let the backend pick.' },
      resolution:      { type: 'string', description: 'Resolution — must be one of the values in the enum (populated at runtime from the backend catalog). Omit to let the backend pick.' },
      n:               { type: 'number', description: 'Number of images to generate (default: 1)' },
      referenceImages: {
        type: 'array',
        description: 'Reference images. Each item is either a string (file path or attachment ID like "att-1") OR an object { alias, path } where `alias` is a short descriptive name you can mention in the prompt. Prefer objects with aliases when you have multiple refs — it lets you say "the boat" or "the style_reference" instead of "the FIRST reference" / "the SECOND reference". Use short, semantic aliases ("boat", "style", "placement_guide"), never generic ones ("ref1", "image1").',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                alias: { type: 'string', description: 'Short descriptive name (e.g. "boat", "placement_guide", "style_reference"). Referenced by the prompt.' },
                path:  { type: 'string', description: 'File path or attachment ID (att-N).' }
              },
              required: ['alias', 'path']
            }
          ]
        }
      },
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
    { intent: 'generate_image', prompt: 'Edit the reference image: change the eye color to red, keep everything else identical', referenceImages: ['/Users/me/.koi/images/kitten.png'] },
    {
      intent: 'generate_image',
      prompt: 'Paint the `illustration` onto the side of the `boat`\'s hull, following the perspective and texture shown in `placement_guide`.',
      referenceImages: [
        { alias: 'boat',            path: '/Users/me/.koi/images/boat.png' },
        { alias: 'placement_guide', path: '/Users/me/.koi/images/snapshot.png' },
        { alias: 'illustration',    path: '/Users/me/.koi/images/source.png' }
      ]
    }
  ],

  async execute(action, agent) {
    const prompt = action.prompt;
    if (!prompt) throw new Error('generate_image: "prompt" is required');

    // If the active doc in the working-area store carries a
    // [DocumentBundle], surface a one-line log — matches the
    // "[bundle:<id>]" convention used on every other touchpoint
    // (submit, workingAreaState, read_file) so the full round-trip
    // is visible in the log without grepping multiple keys.
    try {
      const { openDocumentsStore } = await import('../../state/open-documents-store.js');
      const active = openDocumentsStore.getActive?.();
      const b = active?.bundle;
      if (b) {
        const base = (p) => p ? p.split('/').pop() : '-';
        const refs = Array.isArray(b.references) ? b.references : [];
        channel.log(
          'image',
          `[bundle:${active.id}] (generate_image) primary=${base(b.primary?.path)} ` +
          `annotation=${b.annotation?.path ? base(b.annotation.path) : '-'} ` +
          `refs=${refs.length}` +
          `${refs.length ? ' [' + refs.map((r) => base(r.path)).join(', ') + ']' : ''}`,
        );
      }
    } catch { /* store unavailable — ignore */ }

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
    //
    // Accepts TWO input shapes (both valid on the same request):
    //   1. Plain path / attachment-id strings:
    //        referenceImages: ["att-1", "/path/to/pic.png"]
    //   2. Named objects with { alias, path }:
    //        referenceImages: [{ alias: "boat", path: "att-1" }, ...]
    // Aliases are optional; when at least one is present, a compact legend is
    // prepended to the prompt so the model can map "boat" / "placement_guide"
    // / "illustration" to ref #1 / #2 / #3. Providers only accept ordered
    // arrays — the legend is our workaround to let agents write semantic
    // prompts without losing the position-to-name mapping.
    let referenceImages;
    const _savedRefIds = {}; // filePath → media library ID
    let _refAliases = []; // aligned with referenceImages order; empty string when unnamed
    if (action.referenceImages?.length) {
      if (!caps.referenceImages) {
        channel.log('image', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
      } else {
        referenceImages = [];
        const maxRef = caps.maxReferenceImages || 1;
        // Step 1 — normalize to [{ alias, rawPath }]. String items keep alias=''.
        const _normalized = action.referenceImages.map((item) => {
          if (typeof item === 'string') return { alias: '', rawPath: item };
          if (item && typeof item === 'object') {
            const rawPath = typeof item.path === 'string' ? item.path : '';
            const alias = typeof item.alias === 'string' ? item.alias.trim() : '';
            return { alias, rawPath };
          }
          return { alias: '', rawPath: '' };
        }).filter((x) => x.rawPath);

        // Step 2 — resolve attachment IDs (att-N) to real paths. Any
        // other value is passed through verbatim; Step 3 calls
        // `path.resolve()` which absolutizes relative paths against
        // cwd and checks existence, so this stays permissive.
        const _resolvedRefs = [];
        try {
          const { attachmentRegistry: _ar } = await import('../../state/attachment-registry.js');
          for (const { alias, rawPath } of _normalized) {
            if (/^att-\d+$/.test(rawPath)) {
              const entry = _ar.get(rawPath);
              if (entry?.path) {
                _resolvedRefs.push({ alias, filePath: entry.path });
                continue;
              }
            }
            _resolvedRefs.push({ alias, filePath: rawPath });
          }
        } catch {
          for (const { alias, rawPath } of _normalized) {
            _resolvedRefs.push({ alias, filePath: rawPath });
          }
        }

        // Step 3 — load + normalise image bytes, track alias alignment.
        for (const { alias, filePath } of _resolvedRefs.slice(0, maxRef)) {
          const resolvedPath = path.resolve(filePath);
          if (!fs.existsSync(resolvedPath)) {
            return { success: false, error: `Reference image not found: ${filePath}` };
          }
          // Transcode anything that isn't PNG/JPEG before upload — providers
          // reject WebP/HEIC/AVIF/TIFF/BMP/GIF inconsistently, and failing
          // here (rather than silently passing through) would force a retry.
          const normalized = await normalizeImageForProvider(resolvedPath);
          if (normalized.converted) {
            channel.log('image', `Reference normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
          }
          const data = fs.readFileSync(normalized.path);
          // Decode-validate the ref locally with sharp so we fail fast and
          // actionably (e.g. "not a real image", "truncated", "0 bytes")
          // instead of round-tripping to Fal and getting back a generic
          // "Could not generate images with the given prompts and images".
          try {
            const sharp = (await import('sharp')).default;
            const meta = await sharp(data).metadata();
            if (!meta?.width || !meta?.height || !meta?.format) {
              return {
                success: false,
                errorType: 'reference_image_invalid',
                error: `Reference image could not be decoded (${path.basename(resolvedPath)}). The file exists but is not a valid image — check the download, file size, and magic bytes.`,
                referencePath: resolvedPath,
              };
            }
          } catch (decodeErr) {
            return {
              success: false,
              errorType: 'reference_image_invalid',
              error: `Reference image is not a valid image (${path.basename(resolvedPath)}): ${decodeErr.message}`,
              referencePath: resolvedPath,
            };
          }
          referenceImages.push({ data, mimeType: normalized.mimeType });
          _refAliases.push(alias);

          // Save reference image to media library (dedup by hash, non-blocking)
          try {
            const { MediaLibrary } = await import('../../state/media-library.js');
            const lib = MediaLibrary.global();
            const result = await lib.save({
              filePath: resolvedPath,
              metadata: { source: 'reference', usedForGeneration: true, alias: alias || undefined },
              description: `Reference image${alias ? ` (${alias})` : ''}: ${path.basename(resolvedPath)}`,
            });
            _savedRefIds[resolvedPath] = result.id;
            channel.log('image', `Reference image ${result.isNew ? 'saved to' : 'already in'} media library: ${result.id}${alias ? ` [${alias}]` : ''}`);
          } catch (mlErr) {
            channel.log('image', `Media library ref save failed (non-fatal): ${mlErr.message}`);
          }
        }
      }
    }

    // Build the final prompt: if any reference carries an alias, prepend a
    // short legend so the provider's model can map "boat"/"placement_guide"
    // to ref #1/#2/... regardless of how the underlying API presents them.
    let effectivePrompt = prompt;
    if (_refAliases.some((a) => a && a.length > 0)) {
      const legendLines = _refAliases.map((alias, i) => {
        const n = i + 1;
        return alias ? `  • reference #${n} = "${alias}"` : `  • reference #${n} = (unnamed)`;
      });
      effectivePrompt =
        `Reference images (by position):\n${legendLines.join('\n')}\n\n` +
        `When the prompt below mentions a name in backticks (e.g. \`boat\`), it is referring to the reference image of that alias.\n\n` +
        prompt;
      channel.log('image', `Reference aliases: ${_refAliases.map((a, i) => `${i + 1}=${a || '-'}`).join(', ')}`);
    }

    // Auto-detect aspectRatio AND resolution from the FIRST reference (the
    // base image being edited). Only one of the references is "the canvas" —
    // the rest are style / placement / source-of-pieces guides. Without these
    // hints the provider falls back to 1:1 (crops the scene) and its default
    // resolution (frequently a step down from the source → silent quality
    // regression on a 2K/4K input). Both are passed as soft preferences;
    // edit models preserve the base dimensions natively regardless.
    let autoAspectRatio = null;
    let autoResolution = null;
    if ((!action.aspectRatio || !action.resolution) && referenceImages?.length) {
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(referenceImages[0].data).metadata();
        if (meta?.width && meta?.height) {
          if (!action.aspectRatio) {
            autoAspectRatio = _closestAspectRatio(meta.width, meta.height);
            channel.log('image', `Auto-detected aspectRatio=${autoAspectRatio} from base ref (${meta.width}x${meta.height})`);
          }
          if (!action.resolution) {
            autoResolution = _closestResolution(Math.max(meta.width, meta.height), caps.resolutions);
            if (autoResolution) {
              channel.log('image', `Auto-detected resolution=${autoResolution} from base ref (max=${Math.max(meta.width, meta.height)}px)`);
            }
          }
        }
      } catch (err) {
        channel.log('image', `Aspect/resolution auto-detect failed (non-fatal): ${err?.message || err}`);
      }
    }
    const effectiveAspect = action.aspectRatio || autoAspectRatio;
    const effectiveResolution = action.resolution || autoResolution;

    // Log full generation request details. Ref items can now be strings or
    // {alias,path} objects — normalise for the summary without re-parsing.
    const refSummary = (action.referenceImages || []).map((it) => {
      if (typeof it === 'string') return path.basename(it);
      if (it && typeof it === 'object') {
        const base = it.path ? path.basename(it.path) : '?';
        return it.alias ? `${it.alias}=${base}` : base;
      }
      return '?';
    });
    channel.log('image', `generate_image: ${resolved.provider}/${resolved.model}, prompt="${effectivePrompt.substring(0, 150)}...", aspectRatio=${effectiveAspect || '-'}, resolution=${effectiveResolution || '-'}, n=${action.n || 1}, refs=${refSummary.length}${refSummary.length ? ' [' + refSummary.join(', ') + ']' : ''}, saveTo=${action.saveTo || 'default'}`);

    // Passthrough: only forward params the agent actually supplied. The
    // client-side router (media-model-router.js) picks a model that accepts
    // exactly those constraints — fabricating defaults here would reintroduce
    // stale vocabulary (e.g. 'medium') that the live backend catalog does not
    // advertise.
    const genOpts = {
      outputFormat: action.outputFormat || (action.saveTo ? 'png' : 'b64_json'),
      referenceImages,
    };
    if (effectiveAspect) genOpts.aspectRatio = effectiveAspect;
    if (effectiveResolution) genOpts.resolution = effectiveResolution;
    if (action.n && action.n > 1) genOpts.n = action.n;
    if (action.label) genOpts.label = action.label;

    let result;
    try {
      result = await instance.generate(effectivePrompt, genOpts);
      // Log the ACTUAL slug the router picked (e.g. "fal-ai/flux/dev")
      // instead of the declared "auto" — the user needs to know which
      // model produced each image, so this hits stdout AND the image
      // metadata saved to the media library a few lines below.
      if (result?.model) {
        channel.log('image', `Model resolved → ${result.model}`);
      }
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
      // Mine the raw provider response for a real reason. Different providers
      // use different shapes; pull whatever's there without trusting any one.
      const raw = result.raw || result.providerRaw || {};
      const hints = [];
      // Fal-specific NSFW flag (per-image boolean array)
      if (Array.isArray(raw.has_nsfw_concepts) && raw.has_nsfw_concepts.some(Boolean)) {
        hints.push('NSFW/safety filter triggered (has_nsfw_concepts=true)');
      }
      // Fal / generic error fields
      if (raw.detail) hints.push(`detail: ${typeof raw.detail === 'string' ? raw.detail : JSON.stringify(raw.detail).slice(0, 200)}`);
      if (raw.error && !hints.length) hints.push(`error: ${typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error).slice(0, 200)}`);
      if (raw.message && raw.message !== raw.error) hints.push(`message: ${raw.message}`);
      // Gemini / Nano Banana shape when wrapped
      const cand = Array.isArray(raw.candidates) ? raw.candidates[0] : null;
      if (cand?.finishReason && cand.finishReason !== 'STOP') hints.push(`finishReason: ${cand.finishReason}`);
      if (Array.isArray(cand?.safetyRatings)) {
        const blocked = cand.safetyRatings.filter(r => r.blocked || /HIGH|MEDIUM/i.test(r.probability || ''));
        if (blocked.length) hints.push(`safetyRatings: ${blocked.map(r => `${r.category}=${r.probability}`).join(', ')}`);
      }
      if (raw.promptFeedback?.blockReason) hints.push(`blockReason: ${raw.promptFeedback.blockReason}`);
      // Revised prompt (some models silently refuse and return just a rewrite)
      if (raw.revised_prompt && !raw.images?.length) hints.push(`revisedPrompt: ${String(raw.revised_prompt).slice(0, 200)}`);

      const rawSnippet = Object.keys(raw).length
        ? ` | raw: ${JSON.stringify(raw).slice(0, 500)}`
        : '';
      const baseMsg = result.error || result.message
        || 'Image generation returned no images. The model likely rejected the prompt (content policy) or timed out.';

      return {
        success: false,
        provider: resolved.provider,
        model: resolved.model,
        error: hints.length ? `${baseMsg} (${hints.join(' | ')})` : `${baseMsg}${rawSnippet}`,
        diagnostics: hints.length ? hints : undefined,
        raw: Object.keys(raw).length ? raw : undefined,
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
            // Prefer the slug the router actually resolved to; fall back
            // to the factory-declared model only when the gateway didn't
            // report one. The user needs the concrete slug (e.g.
            // "fal-ai/flux/dev") stored alongside the image — "auto" in
            // metadata hides the audit trail for billing and reproduction.
            model: result?.model || resolved.model,
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

    // Record provenance so the coordinator can see what has already been
    // applied to each output file via recall_facts. For generate_image a
    // non-empty referenceImages[] treats the first reference as the
    // lineage source (best approximation of "derived from"); plain text-
    // to-image calls get no source and start a fresh chain.
    try {
      const { recordImageOp } = await import('../../state/image-lineage.js');
      const refPaths = (action.referenceImages || [])
        .map(r => typeof r === 'string' ? r : r?.filePath)
        .filter(Boolean);
      for (const img of savedImages) {
        if (!img.savedTo) continue;
        recordImageOp({
          op: 'generate',
          outputPath: img.savedTo,
          sourcePath: refPaths[0] || null,
          params: {
            provider: resolved.provider,
            ...(action.aspectRatio ? { aspectRatio: action.aspectRatio } : {}),
          },
          agentName: agent?.name,
        });
      }
    } catch { /* lineage is best-effort — never fail the tool on it */ }

    return {
      success: true,
      provider: resolved.provider,
      // Concrete slug the router picked (e.g. "fal-ai/flux/dev") — the
      // agent sees what actually ran, not the factory-declared "auto".
      model: result?.model || resolved.model,
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
  // Reference-image support comes from the fleet: any active model with
  // maxRefImages != 0 counts. The legacy `anyCanEdit` gate is gone because
  // "canEdit" was a false dichotomy — if a model accepts input images it
  // can edit, end of story.
  const refsEnabled = caps.hasRefImageSupport;
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
    ? `

IMPORTANT when using "referenceImages" — edit models see every ref as equally
authoritative pixels. They do NOT distinguish "this is the canvas" from "this
is a source asset" from "this is a placement sketch". You MUST state each
ref's role explicitly in the prompt, AND warn the model off any traits of a
schematic ref that should not bleed into the output.

Recommended prompt shape (adapt wording to the actual task):

  1. ROLE ASSIGNMENT — one sentence per ref, in order:
       "Reference #1 is the CANVAS to edit (the boat). Reference #2 is a
        composite snapshot indicating ONLY the desired location and size of
        the artwork — its flat pasted rendering MUST NOT be reproduced.
        Reference #3 is the high-fidelity source to paint."

  2. POSITIVE INSTRUCTIONS — what the output must do:
       "Apply ref #3 at the position/size shown by ref #2, rendered in the
        CANVAS's own perspective: wrap to the surface curvature, match the
        camera angle and foreshortening, blend with ambient lighting (top
        highlights, bottom shadow), integrate edges so it reads as painted
        on the material, not as a flat sticker."

  3. PRESERVATION LIST — what must stay untouched:
       "Leave [list: deck / background / faces / water / any unrelated area]
        completely unchanged."

  4. NEGATIVE GUARD when a ref is schematic / composite / sketch:
       "Do NOT reproduce the flat 2D rendering style of reference #N; its
        only purpose is positional. Render the final artwork correctly in
        3D perspective matching the canvas."

Typical one-ref openers for simpler cases:
  • "Using the reference image as a STYLE guide, ..."  (style transfer)
  • "Edit the reference image to ..."                   (img2img edit)
  • "Use the reference image as the subject and ..."    (subject preservation)`
    : '';
  const fieldsBlock = '\n' + fields.map((f) => `  - ${f}`).join('\n');
  const returns = '\nReturns: { success, provider, model, images: [{ url?, b64?, savedTo? }] }';

  generateImageAction.description = header + fieldsBlock + returns + refNote;
}).catch(() => {});

export default generateImageAction;
