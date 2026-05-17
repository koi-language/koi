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
import { absolutizeMediaRefs } from './_absolutize-media-ref.js';
import {
  computeAspectCapGeometry,
  padImageBuffer,
  recoverImageFile,
} from './_pad-and-recover.js';
import { autoAttachMentions, assignPositionalAliases, listAvailableMentions } from './_auto-attach-mentions.js';

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
 * Pick the catalog resolution whose pixel ceiling is the SMALLEST one
 * that is still >= the longest edge of the base image. Used to auto-fill
 * `resolution` from the base reference.
 *
 * Policy: never downsample. The output resolution must be equal to or
 * larger than the source, never smaller — a downsample is a silent
 * quality regression the user didn't ask for. We pick the next bucket
 * up, not the absolute-closest one, so an 1100px source goes to 2K
 * (not 1K) and a 2100px source goes to 4K (not 2K).
 *
 * Falls back to the LARGEST available bucket when the source exceeds
 * every catalog option (e.g. a 6K input on a catalog whose ceiling is
 * 4K) — that's the closest we can get without going under.
 *
 * Returns null when the catalog doesn't use a bucket name we can score
 * (unknown → leave the field unset and let the provider pick).
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
  bannerKind: 'image',
  bannerLabel: 'Generando imagen',
  bannerIconId: 'generate-image',
  // NOTE: this description is the API-keys fallback. When the backend catalog
  // is reachable, the fetchMediaCapabilities('image') block at the bottom of
  // this file REWRITES this string at import time with the real enums (aspect
  // ratios, resolutions, labels, max n, ref image support) pulled from the
  // /gateway/models/image.json catalog. Do NOT add specific values here —
  // they would become stale the moment the catalog changes.
  description: 'Generate an image from a text prompt. In: "prompt" (required), optional "aspectRatio", optional "resolution", optional "n", optional "referenceImages" (accepts a plain path array OR objects with {alias, path}; entries that start with `@` resolve as cross-project mention handles via MediaLibrary — e.g. `referenceImages: ["@tom"]` reuses whatever was last tagged `@tom` via tag_media — and the chat input bar already expands `@`-handles the user types into attachments), optional "saveTo". Returns: { success, provider, model, images: [{ url?, b64?, savedTo? }] }.',
  thinkingHint: 'Generating image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string', description: 'Text description of the desired image. MANDATORY: write the prompt in English regardless of the user\'s language — image models are trained predominantly on English captions and degrade noticeably with non-English prompts. The ONLY exception is text the image itself must literally render (a sign, a label, dialogue in a speech bubble, on-screen UI copy): keep that verbatim in the user\'s language, wrapped in quotes inside the otherwise-English prompt. When you use named reference images, you can refer to them by alias in the prompt (e.g. "Paint the `illustration` onto the `boat`\'s hull, matching `placement_guide`") — far more precise than "FIRST/SECOND/THIRD reference".' },
      aspectRatio:     { type: 'string', description: 'Aspect ratio — must be one of the values in the enum (populated at runtime from the backend catalog). Omit to let the backend pick.' },
      resolution:      { type: 'string', description: 'Resolution — must be one of the values in the enum (populated at runtime from the backend catalog). Omit to let the backend pick.' },
      n:               { type: 'number', description: 'Number of images to generate (default: 1)' },
      referenceImages: {
        type: 'array',
        description: 'Reference images. Each item is either a string (file path, attachment ID like "att-1", or a `@mention` handle like "@tom" resolved via MediaLibrary against whatever tag_media last pinned to that handle — most-recent-first when multiple match) OR an object { alias, path } where `alias` is a short descriptive name you can mention in the prompt. Prefer objects with aliases when you have multiple refs — it lets you say "the boat" or "the style_reference" instead of "the FIRST reference" / "the SECOND reference". Use short, semantic aliases ("boat", "style", "placement_guide"), never generic ones ("ref1", "image1"). When you pass `@name` without an alias, the alias defaults to the bare handle (`tom`).',
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
      cameraAngles: {
        type: 'object',
        description: 'Discrete camera-control sliders for view-synthesis edit models (currently `fal-ai/qwen-image-edit-2511-multiple-angles`). Only set this when the user asks for a different camera angle / viewpoint of an existing image. The model rotates the camera around the subject and re-renders the scene from the new position — generic image-edit models will ignore this field. EACH slider is independently optional: include ONLY the axes the user moved. Omitted axes hit the model at its default (no change on that axis). At least one of horizontal / vertical / zoom must be present.',
        properties: {
          horizontal: { type: 'number', description: 'OPTIONAL. Horizontal camera rotation in degrees (0..360). 0 = front view, 90 = subject\'s right side, 180 = back view, 270 = subject\'s left side. Omit when the user did not rotate.' },
          vertical:   { type: 'number', description: 'OPTIONAL. Vertical camera elevation in degrees (-30..90). -30 = low angle looking up, 0 = eye level, 90 = bird\'s-eye top-down. Omit when the user did not tilt.' },
          zoom:       { type: 'number', description: 'OPTIONAL. Camera distance / framing (0..10). 0 = wide shot (far), 5 = medium / unchanged, 10 = close-up. Omit when the user did not change distance.' }
        }
      }
      // `model` and `excludeProviders` are intentionally NOT declared here.
      // Model selection is the auto-picker's job — the agent should describe
      // what it wants (aspectRatio, resolution, referenceImages, label) and
      // let the client-side router pick the cheapest capable model from the
      // active catalog. `excludeProviders` is a retry-hint set by the
      // Coordinator after a BlockedResult; it is forwarded on `action.*` by
      // playbook-session.js and read in execute() below. Declaring them in
      // the schema would leak them into `get_tool_info` / AVAILABLE ACTIONS
      // and invite the agent to invent a slug (e.g. "gemini-3-pro-image-
      // preview") that the backend catalog may not even have active — a
      // failure mode that can't happen when the picker is the only chooser.
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
    // Guard: a blind first call returns docs instead of executing.
    // Forces the agent to see labels (`erotic`, `porn`, …),
    // excludeProviders/excludeModels, the live per-model catalog,
    // and the aspect/resolution enums BEFORE wasting a round-trip
    // on a default that might mismatch the intent.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('generate_image', agent);
    if (_guard) return _guard;

    // Strip agent-supplied `model` — auto-picker decides. See the
    // matching block in generate-video.js for the full rationale;
    // tl;dr the agent pinning a slug routinely lands on something
    // whose shape doesn't match the request (e.g. gpt-image-2 for
    // an explicit prompt → content-policy reject). Use
    // excludeModels / includeModels / label to bias instead.
    if (action.model && action.model !== 'auto') {
      channel.log(
        'image',
        `Stripping agent-supplied model="${action.model}" — auto-picker drives selection. ` +
        `Use excludeModels / includeModels / label to bias instead.`,
      );
      action.model = undefined;
    }

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

    // Resolve image provider. The picker is the sole decider: it chooses the
    // concrete model from the active catalog based on the agent's parameters
    // (aspectRatio, resolution, refsCount, label). `action.model`, even if an
    // agent sneaks it into the JSON, is intentionally NOT forwarded — an
    // agent-invented slug can be inactive, unavailable to the user, or
    // mispriced, and the catalog is the only authoritative source.
    // `excludeProviders` IS forwarded because it is set by the Coordinator on
    // retry (not by the agent) after a BlockedResult — it tells the picker
    // which provider family just failed so a different one is picked next.
    let resolved;
    try {
      resolved = resolveModel({
        type: 'image',
        clients,
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
    let _refSourcePaths = []; // aligned with referenceImages order; absolute path on disk
    // Per-output recovery geometry. Set when pre-pad ran on at least
    // one ref; consumed after saveTo to crop the model's output back
    // to the original content rect. Single geometry instance — the
    // common edit case is one base ref defining the canvas; rarer
    // multi-ref cases would need per-output geometry but most models
    // emit a single image at the FIRST ref's aspect anyway.
    let _outputRecoveryGeom = null;
    // Auto-attach `@mention` handles found in the prompt that aren't
    // already in `referenceImages`. The agent often writes
    //   "Burrow identical to @storyboard_001"
    // and forgets to wire `@storyboard_001` as a reference; without it
    // the provider invents the burrow visually and breaks continuity.
    // We resolve the gallery row for each handle and merge BEFORE the
    // capacity slice so explicit refs always win the cap budget.
    let _explicitRefs = action.referenceImages || [];
    {
      const _autoRes = await autoAttachMentions({
        prompt,
        refs: _explicitRefs,
        mediaKind: 'image',
        maxRefs: caps.referenceImages ? (caps.maxReferenceImages || 1) : 0,
      });
      if (_autoRes.added.length > 0 && caps.referenceImages) {
        channel.log(
          'image',
          `Auto-attached @mentions from prompt: ${_autoRes.added.join(', ')}`,
        );
      }
      _explicitRefs = _autoRes.merged;

      // Positional reconciliation for handles not in the gallery.
      // The agent often writes prompts like
      //   "Edit @ref1 to look like @ref2"
      // and means "the first / second reference I just attached".
      // Those aren't gallery handles — they're the agent's own labels
      // for the slots — so bind each one as an alias on the next
      // unaliased ref. Downstream prompt-aliasing then resolves
      // `@ref1` → reference legend → model.
      if (_autoRes.unknown.length > 0) {
        const _fix = assignPositionalAliases(_explicitRefs, _autoRes.unknown);
        if (_fix.assigned.length > 0) {
          _explicitRefs = _fix.merged;
          channel.log(
            'image',
            `Bound positional aliases to image refs: ${
              _fix.assigned.map((a) => `${a.handle}→${a.path}`).join(', ')
            }`,
          );
        }
        // Whatever the gallery didn't have AND no ref slot accepts is
        // a genuine hallucination — surface a clear error so the
        // agent can fix the prompt.
        if (_fix.leftover.length > 0) {
          const available = await listAvailableMentions({ limit: 60 });
          const availableStr = (available && available.length)
            ? available.join(', ')
            : '(no @-handles tagged yet — use tag_media to assign one)';
          return {
            success: false,
            error:
              `Prompt references @-handles that don't match any gallery item OR any attached reference slot: ${_fix.leftover.join(', ')}.\n` +
              `Either remove them, attach matching references in referenceImages, or use one of the tagged handles: ${availableStr}`,
          };
        }
      }
    }
    if (_explicitRefs.length) {
      if (!caps.referenceImages) {
        channel.log('image', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
      } else {
        referenceImages = [];
        const maxRef = caps.maxReferenceImages || 1;
        // Resolve every ref to an absolute path in one shot (handles
        // strings, {alias, path} objects, attachment IDs, and relative
        // paths). All downstream code — sharp decode, library save,
        // metadata persistence, GUI thumbnails — sees absolute paths.
        const _resolvedRefs = await absolutizeMediaRefs(_explicitRefs);

        // Load + normalise image bytes, track alias alignment.
        for (const { alias, absPath: resolvedPath } of _resolvedRefs.slice(0, maxRef)) {
          if (!fs.existsSync(resolvedPath)) {
            return { success: false, error: `Reference image not found: ${resolvedPath}` };
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
          _refSourcePaths.push(resolvedPath);

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

    // ── Aspect-ratio cap pre-pad ────────────────────────────────────
    // Several edit models (notably gpt-image-2/edit) cap reference
    // aspect ratio at 3:1 (long edge ≤ 3× short edge). Pre-pad the
    // short edge with transparent borders so the input fits the
    // envelope, and remember the content rect for the recovery crop
    // below. The geometry math + sharp-based pad/crop primitives live
    // in `_pad-and-recover.js` — same module video uses, so the two
    // paths share code instead of duplicating the math.
    //
    // 3:1 is the conservative cap that satisfies every edit model
    // we've shipped so far. computeAspectCapGeometry aligns BOTH dims
    // to multiples of 16 so the model's own pre-validation floor
    // doesn't re-break the ratio (see DIM_ALIGNMENT in
    // _pad-and-recover.js). If a future model has a tighter cap, the
    // call still fails downstream with the same error and the
    // gateway's auto-retry (`_isInputShapeError`) picks a different
    // slug.
    const MAX_REF_ASPECT_RATIO = 3;
    if (referenceImages?.length > 0) {
      try {
        const sharp = (await import('sharp')).default;
        for (let i = 0; i < referenceImages.length; i++) {
          const ref = referenceImages[i];
          const meta = await sharp(ref.data).metadata();
          if (!meta?.width || !meta?.height) continue;
          const geom = computeAspectCapGeometry(meta.width, meta.height, MAX_REF_ASPECT_RATIO);
          if (!geom.needsPadding) continue;
          const padded = await padImageBuffer(ref.data, geom, ref.mimeType);
          referenceImages[i] = padded;
          channel.log(
            'image',
            `Aspect-cap pad: ref[${i}] ${meta.width}×${meta.height} → ${geom.paddedW}×${geom.paddedH} ` +
            `(content @ ${geom.padX},${geom.padY} ${geom.contentW}×${geom.contentH}; ` +
            `ratio ${(Math.max(meta.width, meta.height) / Math.min(meta.width, meta.height)).toFixed(2)} > ${MAX_REF_ASPECT_RATIO})`,
          );
          // Record geometry for the FIRST padded ref only — the model's
          // output normally matches the base ref's canvas, so recovering
          // from the base ref's rect is the right strategy.
          if (!_outputRecoveryGeom) {
            _outputRecoveryGeom = geom;
            // Pass the padded dims as the explicit target so any
            // adapter that supports `{width, height}` (seedream family,
            // etc.) emits at the same canvas we sent — making the
            // recovery a static crop with NO scaling. Adapters that
            // only accept enum presets (gpt-image-2/edit) ignore this
            // and the recovery falls back to the proportional-crop +
            // lanczos resize-back path. Either way the user sees the
            // edit at the source dims.
            action.targetSize = { width: geom.paddedW, height: geom.paddedH };
          }
        }
      } catch (padErr) {
        channel.log('image', `Aspect-cap pad failed (continuing without pad): ${padErr.message}`);
      }
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
        } else {
          // sharp returned no dims — almost always a corrupt buffer or
          // an unsupported format. Loud because the next stage (adapter)
          // will silently default to 1:1 / square otherwise.
          console.warn(`[generate_image] Auto-detect: sharp returned no width/height for base ref (will fall through to 1:1 default downstream)`);
          channel.log('image', `Auto-detect: sharp returned no dims for base ref → downstream will default to 1:1`);
        }
      } catch (err) {
        // Loud — used to be a quiet info log, which let edits silently
        // come back square because the adapter has no way to recover an
        // aspect ratio without help from the client.
        console.warn(`[generate_image] Auto-detect FAILED for base ref: ${err?.message || err}`);
        channel.log('image', `Aspect/resolution auto-detect FAILED: ${err?.message || err} (downstream will default to 1:1)`);
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
    // `intent` is the picker's primary signal (see
    // pickImageModel). outpaint_image passes 'outpaint' here so the
    // router routes to the `image_extend` bucket instead of the
    // generic edit pool. Legacy `operation` key tolerated for backward
    // compatibility during the rename rollout.
    const _intent = action.intent ?? action.operation;
    if (_intent) genOpts.intent = _intent;
    // Inpaint/fill mask. Tools that own a precise fill region (outpaint_image)
    // pass it as { data: Buffer, mimeType }. Adapters that need a separate
    // mask URL (flux-pro/v1/fill) consume it from the canonical request.
    if (action.maskImage?.data) {
      genOpts.maskImage = {
        data: action.maskImage.data,
        mimeType: action.maskImage.mimeType || 'image/png',
      };
    }
    // sourceImage carries the unpadded original for reframe-style adapters
    // (bria/expand, ideogram/v3/reframe). Plumbed separately from
    // referenceImages so the router's refsCount filter doesn't exclude
    // single-ref models that are perfectly able to outpaint.
    if (action.sourceImage?.data) {
      genOpts.sourceImage = {
        data: action.sourceImage.data,
        mimeType: action.sourceImage.mimeType || 'image/png',
      };
    }
    // Absolute target dimensions for *reframe* models (ideogram/v3/reframe,
    // flux/kontext, …) which take a source image + a target frame size and
    // outpaint to fill. Set by outpaint_image to the post-padding dims.
    if (action.targetSize?.width && action.targetSize?.height) {
      genOpts.targetSize = {
        width: action.targetSize.width,
        height: action.targetSize.height,
      };
    }
    // Source-image offset within the target canvas — required for
    // asymmetric outpaint on models with explicit placement (bria/expand).
    if (action.sourceImageOffset
        && typeof action.sourceImageOffset.x === 'number'
        && typeof action.sourceImageOffset.y === 'number') {
      genOpts.sourceImageOffset = {
        x: action.sourceImageOffset.x,
        y: action.sourceImageOffset.y,
      };
    }
    // Camera-angle sliders for view-synthesis edit models (currently
    // only `fal-ai/qwen-image-edit-2511-multiple-angles`). Each axis
    // is INDEPENDENTLY optional — only forward the keys the agent
    // actually sent. Omitted axes hit the model at its default (no
    // change on that axis). At least one axis must be a number; if
    // none are, drop the field entirely.
    if (action.cameraAngles && typeof action.cameraAngles === 'object') {
      const picked = {};
      if (typeof action.cameraAngles.horizontal === 'number') picked.horizontal = action.cameraAngles.horizontal;
      if (typeof action.cameraAngles.vertical === 'number') picked.vertical = action.cameraAngles.vertical;
      if (typeof action.cameraAngles.zoom === 'number') picked.zoom = action.cameraAngles.zoom;
      if (Object.keys(picked).length > 0) {
        genOpts.cameraAngles = picked;
        channel.log('image', `[cameraAngles] action → genOpts: ${JSON.stringify(picked)}`);
      } else {
        channel.log('image', `[cameraAngles] WARNING — action.cameraAngles present but no numeric fields: ${JSON.stringify(action.cameraAngles)}. Dropping the field.`);
      }
    }

    // Pipe fal-status updates from the gateway's submit+poll loop straight
    // to the chat banner. The banner wrapper (action-registry) sets
    // _emitMediaStatus on the action; when nested under another media tool
    // (outpaint → generate_image) it stays undefined and we no-op silently.
    if (typeof action._emitMediaStatus === 'function') {
      genOpts.onStatus = (info) => action._emitMediaStatus(info);
    }

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

    // ── Aspect-cap recovery (mirror of pre-pad above) ──────────────
    // Crop each output back to the original content rect via the
    // shared `recoverImageFile` primitive (handles aspect-mismatch
    // sanity check + proportional scaling internally — same code path
    // video uses, just sharp-based instead of ffmpeg).
    if (_outputRecoveryGeom?.needsPadding) {
      for (const img of savedImages) {
        if (!img.savedTo || !fs.existsSync(img.savedTo)) continue;
        try {
          const { width, height, recovered } = await recoverImageFile(
            img.savedTo,
            _outputRecoveryGeom,
          );
          if (recovered) {
            img.width = width;
            img.height = height;
          }
        } catch (recErr) {
          channel.log('image', `Aspect-cap recovery failed on ${path.basename(img.savedTo)} (keeping padded): ${recErr.message}`);
        }
      }
    }

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
            // Persist the EFFECTIVE values — what was actually sent to the
            // gateway, including the auto-detect from the base reference.
            // Saving `action.aspectRatio` directly hid the auto-detected
            // value and made the metadata panel read "no aspect ratio
            // requested", which is misleading for edits where we always
            // auto-fill from the ref dimensions.
            aspectRatio: effectiveAspect || null,
            resolution: effectiveResolution || null,
            outputFormat: action.outputFormat || 'png',
            stylePreset: action.stylePreset || null,
            // Store media library IDs of reference images (not file paths)
            referenceImageIds: Object.values(_savedRefIds),
            // Absolute, resolved paths — `_savedRefIds` is keyed by the
            // path returned by `path.resolve(filePath)` (Step 3 above),
            // which is guaranteed absolute. Storing the agent's raw
            // `action.referenceImages` would pin relative paths or
            // attachment IDs ("att-1") into the metadata, and the GUI's
            // viewer can't display thumbnails for those after the fact.
            referenceImagePaths: Object.keys(_savedRefIds),
            // Optional pointer to the underlying "original" the caller is
            // editing (e.g. outpaint_image passes its source path here so
            // the Info panel can show a Source-image thumbnail instead of
            // a now-deleted temp padded-canvas). Plain generate_image
            // calls don't set this — referenceImagePaths above carries
            // their refs.
            sourceImagePath: action._sourceImagePath || null,
            seed: action.seed || null,
            steps: action.steps || null,
            guidanceScale: action.guidanceScale || null,
            width: img.width || null,
            height: img.height || null,
            // Per-creation billing trail — credits charged by the
            // backend + upstream provider job id (fal request_id).
            // Forwarded by the gateway on the same response that
            // delivered the image URL; we persist them in the saved
            // media's metadata so the GUI's Info panel can show
            // "Cost: X credits" without a separate roundtrip.
            ...(typeof result?.creditsCost === 'number'
                ? { creditsCost: result.creditsCost }
                : {}),
            ...(typeof result?.providerRequestId === 'string'
                ? { providerRequestId: result.providerRequestId }
                : {}),
          }, agent?.llmProvider || null);
          channel.log('image', `Saved to media library: ${img.savedTo}`);
        }
      }
    } catch (mlErr) {
      channel.log('image', `Media library save failed (non-fatal): ${mlErr.message}`);
    }

    // Record provenance so the coordinator can see what has already been
    // applied to each output file via recall_memory. For generate_image a
    // non-empty referenceImages[] treats the first reference as the
    // lineage source (best approximation of "derived from"); plain text-
    // to-image calls get no source and start a fresh chain.
    try {
      const { recordImageOp } = await import('../../state/image-lineage.js');
      // Reuse the already-resolved absolute paths (`_savedRefIds` is
      // keyed by them) so lineage doesn't re-introduce the relative-
      // path / attachment-id zoo this tool deliberately sheds upstream.
      const refPaths = Object.keys(_savedRefIds);
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

import asyncCapable from '../_async-capable.js';
import { formatModelCatalog } from './_format-model-catalog.js';

// Wrap FIRST so the catalog refresh below mutates the registered object —
// asyncCapable spreads a fresh schema/description, so any in-place edit
// to the source `generateImageAction` would land on a copy nobody reads.
const wrappedAction = asyncCapable(generateImageAction);

// Fire-and-forget: build the tool schema dynamically from the backend's
// /gateway/models/image.json. The rule: the agent must only ever see values
// the backend can actually serve. If the backend advertises no aspect ratios
// → the aspectRatio parameter goes away. Same for resolutions, labels, and
// reference images. The static schema above is the fallback for API-keys
// mode (no backend reach).
//
// The promise is exposed as `_descriptionReady` so consumers (notably
// `get_tool_info`) can await the rewrite before reading the description.
// Without it, the first agent that asks for full docs early in the
// session sees the static fallback (no enums, no model list).
wrappedAction._descriptionReady = fetchMediaCapabilities('image').then((caps) => {
  if (!caps) return; // backend unreachable → keep static defaults

  const props = wrappedAction.schema.properties;

  // Canonical accepted values for the runtime's generic media API.
  // Source of truth: same fallback enums used by `KoiGatewayProvider.
  // capabilities` in `../../llm/providers/gateway.js`. The backend's
  // `_collectCommon` deliberately STOPPED shipping per-model enums for
  // these signals; the per-slug adapter is now the only authority. We
  // surface the generic list to the agent so it can pick a value,
  // and the adapter rejects with a clear error if the resolved model
  // can't honour it. Tighten the enum only when the catalog DOES
  // surface a narrower set (legacy / future-proof path).
  const CANONICAL_ASPECT_RATIOS = [
    '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9',
  ];
  const CANONICAL_RESOLUTIONS = [
    'low', 'medium', 'high', 'ultra',
    '512p', '720p', '1K', '1080p', '2K', '4K',
  ];

  props.aspectRatio = {
    type: 'string',
    enum: caps.aspectRatios?.length ? caps.aspectRatios : CANONICAL_ASPECT_RATIOS,
  };
  props.resolution = {
    type: 'string',
    enum: caps.resolutions?.length ? caps.resolutions : CANONICAL_RESOLUTIONS,
  };
  if (caps.maxImages > 1) {
    props.n = { type: 'number', minimum: 1, maximum: caps.maxImages };
  } else {
    delete props.n;
  }
  // referenceImages: keep the original schema entry (string OR
  // {alias, path} oneOf) regardless of caps. The per-slug adapter
  // rejects with a clear error when the resolved model doesn't accept
  // refs — better than silently hiding the param and forcing the agent
  // to write "use the attached image" in the prose (which the model
  // can't see).
  const refsEnabled = caps.hasRefImageSupport;
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

  {
    const list = props.aspectRatio.enum.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "aspectRatio" — one of: ${list}. Omit to let the backend pick.`);
  }
  {
    const list = props.resolution.enum.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "resolution" — one of: ${list}. Omit to let the backend pick.`);
  }
  if (caps.maxImages > 1) {
    fields.push(`optional "n" — integer 1..${caps.maxImages} (default 1)`);
  }
  {
    const maxRef = caps.maxRefImages ? ` Max ${caps.maxRefImages}.` : '';
    fields.push(`optional "referenceImages" — array of reference assets. Each item is a string (absolute file path, attachment ID like "att-1", or \`@mention\` handle like "@tom") OR an object \`{ alias, path }\` so the prompt can refer to it by alias.${maxRef} The per-slug adapter validates whether the resolved model accepts refs.`);
  }
  if (caps.labels?.length) {
    // Slug list for the enum; descriptions come via labelDetails so the
    // agent can tell when each label is meant to apply (e.g. face-consistency
    // is *only* relevant when a ref image contains people you want preserved
    // exactly — not a generic "quality" knob).
    const details = Array.isArray(caps.labelDetails) ? caps.labelDetails : [];
    const lines = caps.labels.map((slug) => {
      const d = details.find((x) => x && x.slug === slug);
      const desc = d && d.description ? ` — ${d.description}` : '';
      return `    • "${slug}"${desc}`;
    }).join('\n');
    fields.push(`optional "label" — ranking preference for a domain-tuned variant. Check whether your task — and any involved reference image, look at it — matches one of the slugs below; setting the right label routes to a specialised model and gives a better result.\n${lines}`);
  }
  fields.push('optional "saveTo" — absolute directory path where the tool will save the generated image(s). The real path is returned in images[].savedTo — use THAT in any downstream step, never fabricate paths.');

  const header = 'Generate an image from a text prompt (text-to-image OR image-edit when "referenceImages" are passed). The router auto-picks one model from the active catalog based on your params — see the per-model breakdown at the end of this description for what each option supports. Every parameter and its allowed values are listed below (values are pulled live from the active model catalog — anything outside the enum will be rejected).';
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
  const asyncSuffix = ' This tool is async-capable: pass wait=false to kick it off as a background job (returns { jobId }) instead of blocking.';
  const catalog = formatModelCatalog(caps.models);

  wrappedAction.description = header + fieldsBlock + returns + refNote + catalog + asyncSuffix;
}).catch(() => {});

export default wrappedAction;
