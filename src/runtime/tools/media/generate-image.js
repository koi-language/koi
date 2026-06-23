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
import { slugifyDescription, buildDescribedFilename } from './util/slugify-description.js';
import { exportMediaCopy } from './util/export-copy.js';
import {
  computeAspectCapGeometry,
  padImageBuffer,
  recoverImageFile,
} from './_pad-and-recover.js';
import { autoAttachMentions, assignPositionalAliases, listAvailableMentions } from './_auto-attach-mentions.js';
import { wasRead, isGatedLocalPath, markRead } from '../../state/read-tracker.js';
import { fetchAssetBuffer, undownloadableResult } from '../../io/download-asset.js';

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
      quality:         { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'OPTIONAL. Sampling effort, decoupled from pixel count. Lower quality = faster + cheaper, less polished. Consumed only by models that advertise a sampling-effort knob (see the catalog snapshot — most slugs ignore it). Use "low" for thumbnails / storyboards / quick iteration, "medium" for general work, "high" for finals. "auto" lets the adapter pick. Omit entirely to fall back to the adapter\'s legacy behaviour (which derives quality from `resolution`).' },
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
      saveTo:          { type: 'string', description: 'Where to place a COPY of the generated image(s). Either a DIRECTORY (a filename is minted inside it) OR a full FILE path ending in an image extension (.png/.jpg/.webp) — in that case the first image is copied to exactly that path. The ORIGINAL is always kept in ~/.koi/images (so the creations drawer always finds it): images[].savedTo is that original and images[].exportedTo is the copy at your saveTo. Prefer an absolute path; relative paths resolve against cwd. If omitted, only the ~/.koi/images original is produced.' },
      summary:         { type: 'string', description: 'OPTIONAL. One-line "what was this for" — pinned to this session\'s creations ledger so you can later list / recall it via `recall_creations` without searching the filesystem. Examples: "Ferrari hero shot for video ad opening", "Burrow front view, 9:16, used in storyboard sheet 2". Keep it short and self-evident; the agent is the one who will read it back later. When omitted, the ledger falls back to the prompt — usable but less semantic.' },
      metadata:        { type: 'object', additionalProperties: true, description: 'Arbitrary key/value pairs to persist alongside the generated image in the media library (queryable later via the Info panel / MediaLibrary). Use it to record provenance the generic fields don\'t cover — for example, when an image is part of a multi-step pipeline that another tool / skill later consumes, the upstream call records the source artefact path here so the downstream stage can re-attach context. **The skill / workflow you are operating under is the source of truth for which metadata keys are required for each call shape** — read its instructions. If a contract is violated (a required key is missing), the tool returns a soft warning in the result alongside `success: true`. Reserved keys (prompt, model, provider, seed, referenceImagePaths, …) are set by the tool and override this.' },
      cameraAngles: {
        type: 'object',
        description: 'Discrete camera-control sliders for view-synthesis edit models (the catalog snapshot lists which active models advertise multi-angle / camera-rotation capability — the picker routes to one of those when this field is set). Only set this when the user asks for a different camera angle / viewpoint of an existing image. The model rotates the camera around the subject and re-renders the scene from the new position — generic image-edit models will ignore this field. EACH slider is independently optional: include ONLY the axes the user moved. Omitted axes hit the model at its default (no change on that axis). At least one of horizontal / vertical / zoom must be present.',
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
    // ── Per-call concurrency checkpoint tracing ─────────────────────────────
    // Three parallel workers calling generate_image at once interleave their
    // log lines AND all log as "Worker", so a hang is impossible to attribute.
    // Tag every checkpoint with the worker's UI instanceId + a per-call id so
    // an interleaved log can be read per-call and the exact stalled `await`
    // is visible. Temporary diagnostic for the "2 of 3 concurrent gens hang
    // before the gateway call" bug. Remove once the deadlock is found.
    const _wtag = `${agent?.name || 'gen'}#${String(agent?.state?._uiInstanceId || '').slice(-6) || '?'}`;
    const _ck = (msg) => { try { channel.log('image', `[gen-trace ${_wtag}] ${msg}`); } catch { /* non-fatal */ } };
    _ck('execute() entered');

    // Guard: a blind first call returns docs instead of executing.
    // Forces the agent to see labels (`erotic`, `porn`, …),
    // excludeProviders/excludeModels, the live per-model catalog,
    // and the aspect/resolution enums BEFORE wasting a round-trip
    // on a default that might mismatch the intent.
    // The guard intercepts BLIND agent calls — the agent must have
    // expanded the docs at least once before. When `outpaint_image`
    // (or any other internal tool) delegates here, the agent already
    // sees only the outer tool's docs and never asked for
    // `generate_image`. The internal caller signals that by setting
    // `_internalDelegate: true` on the action; we then bypass the
    // guard because the delegating tool is responsible for matching
    // the schema, not the agent.
    // A camera-angle call (slider-driven: cameraAngles {horizontal/vertical/zoom})
    // is a PRECISE, deterministic request — it doesn't need the get_tool_info
    // catalog tutorial, and blocking it is actively harmful: the doc-guard
    // returns the schema, forcing a re-issue, and the weak routing model
    // routinely drops/mangles `cameraAngles` on that second attempt → the
    // router no longer sees the sliders → it falls back to a generic edit model
    // (gpt-image-2) instead of the angle LoRA. So skip the guard whenever
    // numeric cameraAngles are present (same spirit as the `_internalDelegate`
    // bypass: the caller already produced a fully-formed, schema-correct call).
    const _hasCameraAngles = action.cameraAngles
      && typeof action.cameraAngles === 'object'
      && (typeof action.cameraAngles.horizontal === 'number'
        || typeof action.cameraAngles.vertical === 'number'
        || typeof action.cameraAngles.zoom === 'number');
    if (action._internalDelegate !== true && !_hasCameraAngles) {
      const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
      const _guard = await requireToolInfoFirst('generate_image', agent);
      if (_guard) return _guard;
    }

    // ── Read-before-use guard ────────────────────────────────────────
    // You may NOT use a LOCAL image as a reference unless you've `read_file`'d
    // it this session OR generated it yourself this session (generated outputs
    // are marked read). Forces the agent to actually LOOK at a reference it
    // grabbed off disk instead of using it blind. @mention handles, att-N
    // attachments and URLs are exempt; internal tool delegations bypass this
    // (their refs are pre-validated by the delegating tool).
    if (action._internalDelegate !== true && Array.isArray(action.referenceImages)) {
      const refPath = (r) => (typeof r === 'string' ? r : (r && typeof r === 'object' ? (r.path || r.url || '') : ''));
      // Bundled SKILL assets (e.g. a skill's `references/LAYOUT_TEMPLATE.png`)
      // are fixed, trusted files shipped with the skill — never a user image the
      // agent could confabulate about — so they're exempt, like @mentions/URLs.
      const _isSkillAsset = (v) => /\/skills\/[^/]+\/references\//.test(v || '');
      const unread = action.referenceImages
        .map((r, i) => [`referenceImages[${i}]`, refPath(r)])
        .filter(([, v]) => isGatedLocalPath(v) && !wasRead(v) && !_isSkillAsset(v));
      if (unread.length) {
        return {
          // Pre-flight lint (no provider call, no charge): the agent re-issues
          // after read_file'ing the refs. Flag as validationError so the banner
          // middleware silently removes the banner instead of flashing a red
          // "Error generating image" at the user for an internal control retry.
          success: false,
          validationError: true,
          error:
            'read_file required first — you cannot use a local image as a reference unless you have read it this session. ' +
            'Call read_file on each of these BEFORE generate_image, then retry:\n  ' +
            unread.map(([f, v]) => `${f}: ${v}`).join('\n  ') +
            '\n(@mention handles, att-N attachments and http(s) URLs are exempt; images you generated this session are fine.)',
        };
      }
    }

    // Per-call warning bag. Populated below for soft-enforcement issues
    // (missing metadata that downstream tools depend on, etc). Returned
    // alongside `success: true` so the agent sees them on the next turn
    // and can self-correct in subsequent calls. Hard errors still go
    // through `return { success: false, error }`; this bag is for "the
    // call worked, but you broke a downstream contract you should fix".
    const _warnings = [];

    // Visual-storyboard provenance guard.
    //
    // When the agent calls us with `label: "visual_storyboard"` (the
    // route the `visual-panels` skill uses), the produced PNG is
    // expected to carry a metadata link back to where it came from —
    // either `sourceStoryboard` (path to the interactive storyboard
    // JSON) or `storyboardOrigin: "idea"` (explicit declaration that
    // there's no JSON, the sheet was built from a raw prompt). Without
    // ONE of those, the downstream `visual-panels-to-video` skill
    // can't re-attach the source JSON when rendering the final video,
    // and (reported bug) the agent falls back to disk-searching the
    // storyboards folder and confabulating which JSON "matches" the
    // pixels. Surface a loud warning so the agent fixes the call shape.
    if (action.label === 'visual_storyboard') {
      const m = action.metadata && typeof action.metadata === 'object' ? action.metadata : null;
      const hasSourceLink = m && typeof m.sourceStoryboard === 'string' && m.sourceStoryboard.length > 0;
      const isIdeaOrigin = m && m.storyboardOrigin === 'idea';
      if (!hasSourceLink && !isIdeaOrigin) {
        const msg =
          'generate_image was called with `label: "visual_storyboard"` but ' +
          '`metadata.sourceStoryboard` is missing AND `metadata.storyboardOrigin` ' +
          'is not "idea". The visual-panels skill REQUIRES one of those so ' +
          'the downstream `visual-panels-to-video` skill can re-attach the ' +
          'source storyboard JSON (or know there is none). Pass `metadata: ' +
          '{ sourceStoryboard: "<abs-path>", storyboardPart: K, storyboardParts: ' +
          'K_total, storyboardShotIds: [...] }` when the sheet derives from an ' +
          'interactive storyboard JSON, OR `metadata: { storyboardOrigin: "idea" }` ' +
          'when there is no source JSON.';
        try { channel.log('image', `⚠ ${msg}`); } catch { /* best-effort log */ }
        _warnings.push({ code: 'visual_storyboard_missing_source_link', message: msg });
      }
    }

    // Model selection policy:
    //   • Explicit caller-supplied `model` (e.g. "fal/flux/schnell") ALWAYS
    //     wins — programmatic clients (Flutter GUI, internal delegators,
    //     scripted runs) have specific reasons to pin a slug (fastest model
    //     for storyboard iteration, cheapest for batch, a model whose output
    //     style matches the surrounding artefact). The previous behaviour
    //     here stripped the field defensively, which made the explicit-pin
    //     semantics quietly unreliable. If the slug isn't in the active
    //     catalog the gateway returns a hard error and the caller learns;
    //     that's healthier than silently swapping the model.
    //   • `model: 'auto'` (or omitted) → auto-picker drives the selection
    //     based on aspectRatio / resolution / refsCount / label.
    //   • Agents that hallucinate slugs will now see real errors. The
    //     correct guidance for the LLM is still: bias with
    //     excludeModels / includeModels / label rather than pinning.
    if (action.model && action.model !== 'auto') {
      channel.log(
        'image',
        `Honoring caller-supplied model="${action.model}" (explicit pin wins over auto-picker).`,
      );
    }

    const prompt = action.prompt;
    if (!prompt) throw new Error('generate_image: "prompt" is required');

    // Derive a human-readable slug from the prompt so the auto-named
    // output file describes its content ("mouse-with-cheese-mh4n5p_0.png")
    // instead of being an opaque timestamp ("image_1779209209076_0.png").
    // Computed once here and reused for every file the call emits so a
    // batch of N images shares a consistent prefix.
    const slug = slugifyDescription(prompt);

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

    // Resolve image provider. When the caller pinned a model the resolver
    // forwards that slug straight to the gateway (see `_resolveImage` in
    // `factory.js`); otherwise the picker chooses from the active catalog
    // based on aspectRatio / resolution / refsCount / label. `excludeProviders`
    // is set by the Coordinator on retry (not by the agent) after a
    // BlockedResult — it tells the picker which provider family just failed
    // so a different one is picked next.
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

    // Storyboard-driven SCOPED auto-attach. The agent owns the scope
    // (which shots from the source storyboard belong to THIS sheet);
    // the tool only enforces "within that scope, every `references`
    // entry MUST reach the model — no quiet drops".
    //
    // Activation contract (both required):
    //   • `metadata.sourceStoryboard` — absolute path to the source
    //     interactive storyboard JSON.
    //   • `metadata.storyboardShotIds` — array of shot ids that
    //     define this sheet's panel scope (e.g. ["sh1","sh2","sh3"]).
    //     Refs from shots OUTSIDE this list are NOT auto-attached —
    //     a multi-sheet storyboard's later-shot references stay
    //     scoped to their own sheet.
    //
    // Scope rule: a shot's refs are in scope iff the shot id is in
    // `storyboardShotIds`. A scene's refs are in scope iff at least
    // one of the scene's shots is in `storyboardShotIds`. The
    // storyboard-root refs are always in scope (they're global anchors,
    // not panel-specific). The agent stays in charge of WHAT counts as
    // the sheet's scope; the tool only stops the agent from quietly
    // omitting refs once that scope is declared.
    //
    // Why this is here at all: real reported failure mode — the user
    // attached 3 photos of a Ferrari to shot 1 (front / side / rear),
    // the agent only passed 1 of them to generate_image, and the
    // model invented the back of the car. The skill tells the agent
    // to collect all three; this guarantees the agent's declared
    // scope is actually honored on the wire.
    if (caps.referenceImages
        && typeof action.metadata?.sourceStoryboard === 'string'
        && action.metadata.sourceStoryboard
        && Array.isArray(action.metadata.storyboardShotIds)
        && action.metadata.storyboardShotIds.length > 0) {
      const _sbPath = action.metadata.sourceStoryboard;
      const _scope = new Set(
        action.metadata.storyboardShotIds.filter((s) => typeof s === 'string' && s),
      );
      let _sb = null;
      try {
        if (fs.existsSync(_sbPath)) {
          _sb = JSON.parse(fs.readFileSync(_sbPath, 'utf8'));
        } else {
          channel.log('image',
            `Storyboard auto-attach skipped: ${_sbPath} does not exist on disk.`);
        }
      } catch (e) {
        channel.log('image',
          `Storyboard auto-attach skipped: ${_sbPath} unreadable (${e.message}).`);
      }
      if (_sb && typeof _sb === 'object' && _scope.size > 0) {
        const _collected = [];
        // Image extensions Sharp can decode. A storyboard can carry a
        // VIDEO/AUDIO subject reference (e.g. the source clip the user dropped
        // in) — those are NOT usable as image references: normalizeImageForProvider
        // runs Sharp on every ref, Sharp can't decode an .mp4, and the whole
        // generate_image call throws ("Input file contains unsupported image
        // format") and the agent retries the same thing forever. Skip non-image
        // refs here; the sheet still renders from the text prompt. Refs WITHOUT
        // an extension (attachment ids like "att-1") pass through and resolve
        // downstream.
        const _IMG_REF_EXT = new Set([
          '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
          '.heic', '.heif', '.avif',
        ]);
        const _push = (arr, source) => {
          if (!Array.isArray(arr)) return;
          for (const r of arr) {
            if (typeof r === 'string' && r.trim()) {
              const _ref = r.trim();
              const _ext = path.extname(_ref).toLowerCase();
              if (_ext && !_IMG_REF_EXT.has(_ext)) {
                channel.log('image',
                  `Storyboard ref skipped (not an image, can't be used as a reference): ${path.basename(_ref)}`);
                continue;
              }
              _collected.push({ ref: _ref, source });
            }
          }
        };
        // Storyboard-level: always in scope.
        _push(_sb.references, 'storyboard');
        // Subject references are IDENTITY ANCHORS for the whole production,
        // not per-panel decor: a character's reference photo is attached to
        // the shot where they first appear (often scene 1), but that same
        // character recurs in LATER scenes that land on OTHER PART sheets.
        // Scoping refs to only the current sheet's shots dropped the returning
        // characters' refs — e.g. PART 2 (Yoda's bathroom) kept Yoda's photo
        // but lost Luke/Obi-Wan's (attached to a scene-1 shot) even though
        // they re-enter in scene 3. So collect refs from EVERY scene/shot of
        // the storyboard and carry them on every sheet (deduped below; the
        // downstream maxReferenceImages cap trims if a storyboard is ref-heavy).
        // This matches the skill's stated rule: each sheet gets the subject
        // references, same as sheet 1.
        if (Array.isArray(_sb.scenes)) {
          for (const sc of _sb.scenes) {
            const scId = (typeof sc?.id === 'string' && sc.id) ? sc.id : 'scene';
            _push(sc?.references, scId);
            const _shots = Array.isArray(sc?.shots) ? sc.shots : [];
            for (const sh of _shots) {
              const shId = (typeof sh?.id === 'string' && sh.id) ? sh.id : scId;
              _push(sh?.references, shId);
            }
          }
        }

        if (_collected.length > 0) {
          const _existingResolved = await absolutizeMediaRefs(_explicitRefs);
          const _seen = new Set(_existingResolved.map((r) => r.absPath));
          const _perSource = new Map();
          for (const { source } of _collected) {
            _perSource.set(source, (_perSource.get(source) || 0) + 1);
          }
          const _counters = new Map();
          const _added = [];
          for (const { ref, source } of _collected) {
            const _r = await absolutizeMediaRefs([ref]);
            const absPath = _r[0]?.absPath;
            if (!absPath || _seen.has(absPath)) continue;
            _seen.add(absPath);
            const total = _perSource.get(source) || 1;
            const n = (_counters.get(source) || 0) + 1;
            _counters.set(source, n);
            const alias = total > 1 ? `${source}_ref_${n}` : `${source}_ref`;
            _explicitRefs = [..._explicitRefs, { alias, path: ref }];
            _added.push(`${alias}=${ref}`);
          }
          if (_added.length > 0) {
            channel.log('image',
              `Auto-attached storyboard subject refs (identity anchors, whole storyboard) from ${_sbPath} ` +
              `(sheet shotIds=[${[..._scope].join(',')}]): ${_added.join(', ')}`);
          }
        }
      }
    }
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
      //   "Edit Image 1 to look like Image 2"
      // and means "the first / second reference I just attached".
      // Those aren't gallery handles — they're the agent's own labels
      // for the slots — so bind each one as an alias on the next
      // unaliased ref. Downstream prompt-aliasing then resolves
      // `Image 1` → reference legend → model.
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
            // Pre-flight lint (no provider call, no charge): the agent will
            // re-issue with the prompt/references fixed, so flag it as a
            // validation failure and let the banner middleware remove the
            // banner instead of flashing red mid-correction.
            success: false,
            validationError: true,
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
            // Our pre-flight guard (no provider call) → silent banner, not red.
            return { success: false, validationError: true, error: `Reference image not found: ${resolvedPath}` };
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
                validationError: true, // our pre-flight guard → silent banner
                errorType: 'reference_image_invalid',
                error: `Reference image could not be decoded (${path.basename(resolvedPath)}). The file exists but is not a valid image — check the download, file size, and magic bytes.`,
                referencePath: resolvedPath,
              };
            }
          } catch (decodeErr) {
            return {
              success: false,
              validationError: true, // our pre-flight guard → silent banner
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
            _ck(`MediaLibrary.save() START (${path.basename(resolvedPath)})`);
            const result = await lib.save({
              filePath: resolvedPath,
              metadata: { source: 'reference', usedForGeneration: true, alias: alias || undefined },
              description: `Reference image${alias ? ` (${alias})` : ''}: ${path.basename(resolvedPath)}`,
            });
            _ck(`MediaLibrary.save() DONE (isNew=${result.isNew})`);
            _savedRefIds[resolvedPath] = result.id;
            channel.log('image', `Reference image ${result.isNew ? 'saved to' : 'already in'} media library: ${result.id}${alias ? ` [${alias}]` : ''}`);
          } catch (mlErr) {
            channel.log('image', `Media library ref save failed (non-fatal): ${mlErr.message}`);
          }
        }
      }
    }

    // Ask the router which image slug it would dispatch to so we adapt
    // inputs against THAT model's restrictions (not some hardcoded
    // conservative cap). Same fetch + pick path the gateway dispatcher
    // uses, but without firing the call. Mirrors `generate-avatar-video.js`
    // — that tool does the same dance for `imageUrl`; we do it here for
    // `referenceImages`.
    if (referenceImages?.length) {
      let pickedImageModel = null;
      try {
        const { peekImageModel } = await import('../../llm/providers/media-model-router.js');
        const mediaCaps = await fetchMediaCapabilities('image');
        if (mediaCaps && Array.isArray(mediaCaps.models) && mediaCaps.models.length > 0) {
          pickedImageModel = peekImageModel(mediaCaps.models, {
            intent: typeof action.intent === 'string' ? action.intent : (action.operation || ''),
            refsCount: referenceImages.length,
            hasMaskImage: !!action.maskImage,
            hasSourceImage: !!action.sourceImage,
            hasTargetSize: !!(action.targetSize?.width && action.targetSize?.height),
          }) || null;
        }
      } catch { /* no peek → no restriction → ship originals */ }

      // Generic constraint-aware adaptation. The helper applies dim
      // caps first (maxWidth / maxHeight / maxArea on `referenceImages`),
      // then iterative lossless PNG shrink for any remaining maxBytes
      // overshoot. No-op when the adapter declared nothing.
      // adaptImageInput emits its own `[detect]` / `[shrink]` /
      // `[apply ]` lines via channel.log('constraints', …) so the
      // operator can trace every restriction action without this tool
      // duplicating those messages.
      try {
        const { adaptImageInput } = await import('../../llm/providers/_constraints.js');
        for (let i = 0; i < referenceImages.length; i++) {
          const ref = referenceImages[i];
          _ck(`adaptImageInput() START [ref ${i}]`);
          const adapted = await adaptImageInput(ref.data, pickedImageModel, 'referenceImages');
          _ck(`adaptImageInput() DONE [ref ${i}] changed=${adapted.changed}`);
          if (adapted.changed) {
            referenceImages[i] = { data: adapted.buffer, mimeType: adapted.mimeType };
          }
        }
      } catch (err) {
        // Sharp parse / re-encode failed — fall back to the original
        // bytes and let the model try its luck. Logging only so the
        // user can see why an oversized ref might still slip through.
        channel.log(
          'image',
          `generate_image: adapt-image step skipped (${err?.message || err}) — uploading originals`,
        );
      }
    }

    // Build the final prompt: prepend a positional legend ("IMAGE 1 =
    // <alias>, IMAGE 2 = ...") so the provider's model can map the
    // names the agent uses in the prompt body to actual reference
    // slots, regardless of how the underlying API presents them.
    //
    // We ALSO post-process the agent's prompt body to auto-annotate
    // any backtick `alias` mention with its positional "(IMAGE N)"
    // index. Reason: the agent doesn't reliably know which slot a
    // given alias ended up in (their `referenceImages` array order
    // may not match the order they inspected files in or the order
    // they reasoned about), and a hand-typed position from the agent
    // is a common off-by-one mistake — the agent claims the rear of
    // the car is at position 4 while their array put it at slot 3,
    // so the model lines up the wrong photo with the wrong
    // description and invents bodywork. Injecting the index here
    // means the runtime — the piece that actually controls the slot
    // ordering — is the single source of truth. If the agent
    // hand-wrote a position (correct or wrong), we strip it first
    // and re-write the authoritative one. Skills should write
    // positional references as "IMAGE N" inline (see the
    // visual-panels SKILL); the backtick-alias auto-annotation
    // here is a safety net for skills that still emit aliases.
    let effectivePrompt = prompt;
    if (_refAliases.some((a) => a && a.length > 0)) {
      const legendLines = _refAliases.map((alias, i) => {
        const n = i + 1;
        return alias ? `  • IMAGE ${n} = "${alias}"` : `  • IMAGE ${n} = (unnamed)`;
      });
      // alias → position lookup. Aliases with empty/missing values are
      // skipped (positional-only refs don't have a backtick form to find).
      const _aliasToIndex = new Map();
      for (let i = 0; i < _refAliases.length; i++) {
        const a = _refAliases[i];
        if (a && a.length > 0) _aliasToIndex.set(a, i + 1);
      }
      let annotatedBody = prompt;
      if (_aliasToIndex.size > 0) {
        // Sort longest first so a `ferrari_e_a` mention isn't partially
        // matched by a shorter `ferrari_e` alias if both exist.
        const aliases = [..._aliasToIndex.keys()].sort((a, b) => b.length - a.length);
        // Pass 1 — strip any pre-existing positional annotation the
        // agent may have hand-typed (`(IMAGE N)` or `(reference #N)`).
        // The agent's count is unreliable; we discard it so pass 2 can
        // write the authoritative number.
        for (const alias of aliases) {
          const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const stripRe = new RegExp(
            '`' + esc + '`\\s*\\((?:IMAGE\\s*|reference\\s*#\\s*)\\d+\\s*\\)',
            'g',
          );
          annotatedBody = annotatedBody.replace(stripRe, '`' + alias + '`');
        }
        // Pass 2 — append the correct `(IMAGE N)` to every backtick
        // mention of each alias.
        for (const alias of aliases) {
          const n = _aliasToIndex.get(alias);
          const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('`' + esc + '`', 'g');
          annotatedBody = annotatedBody.replace(re, '`' + alias + '` (IMAGE ' + n + ')');
        }
      }
      effectivePrompt =
        `Reference images (by position):\n${legendLines.join('\n')}\n\n` +
        `When the prompt below references "IMAGE N", it points to the reference image at that position above. The "(IMAGE N)" annotations the runtime added next to any backtick alias are authoritative — trust them over any number the prompt's author may have written.\n\n` +
        annotatedBody;
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
    // Capture the caller's EXPLICIT output-dim intent BEFORE the loop —
    // it's our signal that the aspect-cap pad must not hijack the
    // output size. Both `resolution` and `targetSize{width,height}`
    // count; either one means "the caller chose the canvas, don't
    // override it from the base ref". Captured once up front because
    // the loop itself mutates `action.targetSize` further down, and we
    // need the pre-loop value to make the right call on every iteration.
    const _callerSetExplicitOutputDim = !!(
      action.resolution
      || (action.targetSize?.width && action.targetSize?.height)
    );
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
          //
          // EXCEPTION — when the caller passed an explicit output dim
          // (`resolution` OR `targetSize{width,height}`), the agent is
          // NOT editing the base ref's canvas: they want a fresh
          // generation at the requested size (e.g. a visual-panels
          // sheet at 4K that just happens to use the base ref as
          // identity input, or an outpaint where the caller pre-computed
          // the target canvas). Setting targetSize to the padded ref
          // dims here would hijack the output back to the ref's size —
          // exactly the "I asked for 4K, got 1200×704" bug. Skip both
          // the targetSize hint AND the recovery geometry in that case;
          // the in-memory pad still happens so fal accepts the ref, the
          // model emits at the caller's chosen dim, and there's no
          // recovery crop because there's no base canvas to recover to.
          if (!_outputRecoveryGeom && !_callerSetExplicitOutputDim) {
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

    // ── Payload-size guard: shrink fat reference images ──────────────
    // The gateway POSTs `reference_images: [{data: <base64>, mime_type}]`
    // and the surrounding HTTP layer caps payload at ~10 MB. 4K PNG
    // refs run 2-4 MB each in binary, ~3-6 MB once base64-encoded —
    // half a dozen of them and the request fails with HTTP 413
    // "Payload Too Large" before any model sees it. The 413 comes
    // back as an opaque `errorType: "generation_error"` and the agent
    // has no way to know it was just bytes.
    //
    // Strategy is a ladder, each step kept as lossless as possible:
    //
    //   1. PNG re-encode with max zlib compression + palette
    //      indexing (`.png({ compressionLevel: 9, palette: true })`).
    //      Pure lossless — sharp picks an 8-bit palette only when the
    //      image actually has ≤256 distinct colours (typical for
    //      screenshots / diagrams / UI), so screencaps drop 5-10× with
    //      ZERO pixel change. Real photos / renders fall back to
    //      true-colour PNG and shrink only marginally — that's fine,
    //      step 2 picks it up.
    //   2. Downscale to longest edge 2048 px (still lossless re-encode
    //      as PNG). Edit models resample internally to ≤2K anyway, so
    //      losing nothing above 2K. Only the spatial resample loses
    //      information, and the model would have lost it itself.
    //   3. Downscale harder (1536 → 1024) if the budget still isn't met.
    //   4. JPEG q92 as the absolute last resort — only when no
    //      lossless re-encode + resize chain fits inside the budget.
    //      This branch should be rare in practice (10+ MB of photos
    //      from a real DSLR, etc.).
    //
    // PNG with alpha is preserved as PNG throughout (masks /
    // outpaint canvases rely on the alpha channel; JPEG would
    // silently flatten it).
    if (referenceImages?.length) {
      try {
        const sharp = (await import('sharp')).default;
        // Encoded size = base64 expansion (×4/3) + tiny JSON wrapper.
        // Budget aligned with the backend's hard cap: Fastify's
        // `bodyLimit` is 50 MB (backend/src/app.ts) so anything inside
        // that ceiling reaches the route handler. Railway's edge proxy
        // sits in front and its body cap is undocumented but empirically
        // generous (no fail seen at 30+ MB in past tests). Putting the
        // budget right at 50 MB means we only shrink when the request
        // genuinely cannot fit, which preserves maximum fidelity for the
        // common case (3-5 refs at native resolution). If a future bug
        // surfaces an actual Railway cap lower than 50 MB, drop this
        // back to ~30 MB — it's the only knob.
        const BUDGET_BYTES = 50 * 1024 * 1024;
        const _encodedSize = (n) => Math.ceil(n * 4 / 3);
        const _totalEncoded = () => referenceImages.reduce(
          (acc, r) => acc + _encodedSize(r.data?.length || 0), 0,
        );

        if (_totalEncoded() > BUDGET_BYTES) {
          channel.log(
            'image',
            `Reference payload ${(_totalEncoded() / 1024 / 1024).toFixed(1)} MB > budget ${(BUDGET_BYTES / 1024 / 1024).toFixed(1)} MB — greedy shrink (largest refs first, stop as soon as total fits)`,
          );

          // Greedy global shrinker. Previous version allocated
          // `BUDGET / N` per image and pushed EVERY ref through the
          // full ladder until each individual ref fit that per-image
          // budget. With many refs (9 photos → 5.5 MB encoded each),
          // that forced almost every reference down to 1024 px JPEG
          // even though the GLOBAL total had plenty of headroom — the
          // model then saw an aggressively downscaled storyboard and
          // produced visibly worse results (the symptom the user
          // reported).
          //
          // The right strategy: keep every ref at native res when the
          // global budget permits; when it doesn't, shrink only the
          // biggest ones, ONE step at a time, and stop the moment the
          // global total fits. Small refs are never touched.
          //
          // The ladder is (per ref):
          //   0 = original   (untouched)
          //   1 = png-recompress  (lossless, only step that's cheap to
          //       run on every ref preemptively — palette PNG often
          //       drops screenshots / diagrams 5-10× with zero loss)
          //   2 = 2048 px PNG lossless
          //   3 = 1536 px PNG lossless
          //   4 = 1024 px PNG lossless
          //   5 = JPEG q92 @ 1024 px  (last resort, only when no
          //       alpha — JPEG can't carry transparency)
          //   6 = JPEG q85 @ 1024 px  (only fired when 5 still busts
          //       the budget on a many-ref payload)
          const refState = referenceImages.map((r, i) => ({
            idx: i,
            step: 0,
            data: r.data,
            mimeType: r.mimeType,
            hasAlpha: null, // resolved lazily on first shrink
          }));
          const _refSize = (s) => s?.data?.length || 0;

          const _applyStep = async (state) => {
            const sharpInst = sharp(state.data);
            const meta = await sharpInst.metadata();
            if (state.hasAlpha == null) {
              state.hasAlpha = meta?.hasAlpha === true || meta?.channels === 4;
            }
            const fromBuf = state.data;
            if (state.step === 1) {
              // Lossless recompress at native res.
              const out = await sharp(fromBuf)
                .png({ compressionLevel: 9, palette: true })
                .toBuffer();
              return { data: out, mimeType: 'image/png', note: 'png-recompress' };
            }
            const dimMap = { 2: 2048, 3: 1536, 4: 1024 };
            if (state.step in dimMap) {
              const target = dimMap[state.step];
              const out = await sharp(fromBuf)
                .resize({ width: target, height: target, fit: 'inside', withoutEnlargement: true })
                .png({ compressionLevel: 9, palette: true })
                .toBuffer();
              return { data: out, mimeType: 'image/png', note: `png@${target}` };
            }
            if (state.step === 5 || state.step === 6) {
              if (state.hasAlpha) {
                // JPEG can't carry alpha — keep PNG at 1024 instead.
                const out = await sharp(fromBuf)
                  .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                  .png({ compressionLevel: 9, palette: true })
                  .toBuffer();
                return { data: out, mimeType: 'image/png', note: 'png@1024(alpha)' };
              }
              const quality = state.step === 5 ? 92 : 85;
              const out = await sharp(fromBuf)
                .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality, mozjpeg: true })
                .toBuffer();
              return { data: out, mimeType: 'image/jpeg', note: `jpeg-q${quality}@1024` };
            }
            return null; // step exhausted
          };

          const _totalNow = () => refState.reduce(
            (acc, s) => acc + _encodedSize(_refSize(s)), 0,
          );

          // Optional pass 0: cheap palette-recompress on every ref
          // FIRST. Lossless and fast — often clears the deficit on
          // its own when the refs are screenshots / UI mocks.
          for (const s of refState) {
            try {
              s.step = 1;
              const out = await _applyStep(s);
              if (out && out.data.length < s.data.length) {
                s.data = out.data;
                s.mimeType = out.mimeType;
                s._note = out.note;
              }
            } catch { /* ignore — keep original */ }
            if (_totalNow() <= BUDGET_BYTES) break;
          }

          // Greedy loop: while we're still over budget, find the
          // largest ref that still has ladder steps available and
          // bump it ONE step. Recheck total. Repeat.
          let safety = refState.length * 6 + 4; // hard stop, can't loop forever
          while (_totalNow() > BUDGET_BYTES && safety-- > 0) {
            const candidate = refState
              .filter((s) => s.step < 6)
              .sort((a, b) => _refSize(b) - _refSize(a))[0];
            if (!candidate) break; // every ref exhausted the ladder
            candidate.step += 1;
            try {
              const out = await _applyStep(candidate);
              if (out) {
                candidate.data = out.data;
                candidate.mimeType = out.mimeType;
                candidate._note = out.note;
              }
            } catch (err) {
              channel.log('image', `  ref[${candidate.idx}] shrink step ${candidate.step} failed (keeping previous): ${err.message}`);
              // Mark exhausted so we don't retry this step in a loop.
              candidate.step = 6;
            }
          }

          // Write back + log per-ref outcome.
          for (const s of refState) {
            const before = referenceImages[s.idx]?.data?.length || 0;
            const after = s.data.length;
            if (s.step > 0) {
              channel.log(
                'image',
                `  ref[${s.idx}]: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (${s._note || 'unchanged'})`,
              );
            } else {
              channel.log('image', `  ref[${s.idx}]: ${(before / 1024).toFixed(0)} KB (native, kept as-is)`);
            }
            referenceImages[s.idx] = { data: s.data, mimeType: s.mimeType };
          }
          channel.log(
            'image',
            `Reference payload after shrink: ${(_totalEncoded() / 1024 / 1024).toFixed(1)} MB`,
          );
        }
      } catch (sharpErr) {
        channel.log('image', `Reference payload size guard skipped (sharp unavailable): ${sharpErr.message}`);
      }
    }

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
    _ck('reached model dispatch (about to call the gateway)');
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
    // Forward `quality` to the gateway — sampling-effort knob,
    // decoupled from `resolution` (pixel count). Currently consumed
    // by openai/gpt-image-2(-edit); other slugs ignore it. Used by
    // the storyboard visor to render small thumbnails at LOW
    // sampling effort without dragging pixel count down too.
    if (typeof action.quality === 'string') {
      const q = action.quality.toLowerCase();
      if (q === 'low' || q === 'medium' || q === 'high' || q === 'auto') {
        genOpts.quality = q;
      }
    }
    // Forward `seed` to the gateway so character consistency across
    // sibling generations (storyboard shots that share a hero, video
    // frame variants, etc) is achievable. Fal models that accept a
    // seed will reuse the same noise tensor when the same seed is
    // passed; models that ignore it fall through silently.
    if (typeof action.seed === 'number' && Number.isFinite(action.seed)) {
      genOpts.seed = Math.floor(action.seed);
    }
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

    // Cost consent is handled UP FRONT by the media banner wrapper
    // (action-registry.js → preflightMediaCost), before the banner and before
    // we get here — so by this point the user has already approved (or
    // auto-approved). No per-tool confirmation needed.

    let result;
    try {
      _ck('gateway generate() START');
      result = await instance.generate(effectivePrompt, genOpts);
      _ck('gateway generate() DONE');
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
    // Track the last DOWNLOAD failure (classified by `fetchAssetBuffer`) so we
    // can tell a local connectivity/DNS problem (the asset exists on the
    // provider, WE couldn't reach it) apart from a real failure (HTTP 4xx/5xx).
    // They need opposite recoveries: a network error → retry the DOWNLOAD, never
    // regenerate; an HTTP error → the result is genuinely unusable.
    let lastDl = null; // classified failure from fetchAssetBuffer (network|http)
    if (result.images?.length) {
      // The ORIGINAL always lands in the persistent ~/.koi/images repo so it
      // survives across sessions AND the media library / creations drawer
      // always indexes it. A caller-supplied saveTo gets a COPY further down
      // (see exportMediaCopy) — the user's path is never the sole home.
      const saveDir = path.join(os.homedir(), '.koi', 'images');
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        // Download from URL if no base64 data, via the shared asset downloader
        // (retry + backoff + transport-vs-HTTP classification). If it fails,
        // img.savedTo stays unset → reported as a FAILURE below, with the
        // classification driving whether the agent should retry or give up.
        if (!img.b64 && img.url) {
          const dl = await fetchAssetBuffer(img.url, { kind: 'image' });
          if (dl.ok) {
            const ext = dl.contentType.includes('png') ? 'png' : dl.contentType.includes('webp') ? 'webp' : 'png';
            const filename = buildDescribedFilename({ slug, fallback: 'image', index: i, ext });
            const filePath = path.join(saveDir, filename);
            fs.writeFileSync(filePath, dl.buffer);
            img.savedTo = filePath;
            markRead(filePath); // the agent created it → it "knows" it (read-before-use)
            channel.log('image', `Downloaded and saved: ${filePath} (${(dl.buffer.length / 1024).toFixed(0)}KB)`);
          } else {
            lastDl = dl;
          }
        }
        if (img.b64) {
          const ext = action.outputFormat || 'png';
          const filename = buildDescribedFilename({ slug, fallback: 'image', index: i, ext });
          const filePath = path.join(saveDir, filename);
          fs.writeFileSync(filePath, Buffer.from(img.b64, 'base64'));
          img.savedTo = filePath;
          markRead(filePath); // the agent created it → it "knows" it (read-before-use)
          channel.log('image', `Saved: ${filePath}`);
        }
      }
    }

    // Verify images were actually generated AND we have them locally. A bare
    // `url` we couldn't download (img.savedTo never set) is NOT a usable result:
    // the GUI has nothing to show and nothing got saved to the library. Treating
    // it as success is exactly the "Image generated ✓ but nothing appears" bug —
    // require a local asset (savedTo) or inline bytes (b64).
    const images = result.images || [];
    const hasImages = images.length > 0 && images.some(img => img.savedTo || img.b64);
    const onlyUndownloadableUrls = images.length > 0 && !hasImages
      && images.every(img => img.url && !img.savedTo && !img.b64);
    if (!hasImages) {
      // Distinct, honest failure: the provider DID return a result URL but every
      // download attempt failed. This is NOT a content-policy rejection — say so
      // precisely so the agent retries instead of telling the user it's done.
      if (onlyUndownloadableUrls) {
        const failedUrl = (images.find((im) => im.url) || {}).url || '';
        const dl = lastDl || { errorClass: 'network', message: 'connectivity error' };
        channel.log('image', `Generation succeeded on ${result.provider || 'provider'} but the result URL could not be downloaded (${dl.errorClass}): ${failedUrl}`);
        return {
          ...undownloadableResult({
            tool: 'generate_image',
            provider: result.provider,
            model: result.model,
            url: failedUrl,
            dl,
            noun: 'image',
          }),
          images: result.images,
        };
      }
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

    // Export a COPY to the caller's saveTo (if any) now that the canonical
    // original is final (post aspect-cap recovery). The original stays in
    // ~/.koi/images and is what the media library / lineage below register, so
    // the creations drawer always finds it; `exportedTo` is the user's copy.
    if (action.saveTo) {
      savedImages.forEach((img, i) => {
        if (!img.savedTo) return;
        const copy = exportMediaCopy(img.savedTo, action.saveTo, { index: i, logTag: 'image' });
        if (copy) img.exportedTo = copy;
      });
    }

    // Auto-save generated images to media library (non-blocking).
    //
    // EXCEPTION — storyboard panel thumbnails. The interactive storyboard
    // visor (Flutter `storyboard_tab.dart`) renders every shot card via
    // generate_image with `label: "storyboard_card"`, then immediately
    // MOVES the produced PNG into its own cache dir
    // (`~/.koi/storyboards/.storyboard_cache/<hash>.png`). Those are
    // ephemeral working thumbnails, not user-facing outputs, and must
    // never appear in the creations drawer / cajón. Auto-saving them left
    // a MediaLibrary row (pointing at a now-moved path) AND a
    // creations.jsonl ledger entry; on `regenerate` the visor's move
    // sometimes falls back to copy (cross-fs), so the original PNG
    // lingered at the saved path and its row surfaced in the cajón — the
    // reported bug ("algunas acaban en el cajón como creaciones"). Note
    // the `visual_storyboard` label (the final exported sheet) IS a real
    // creation and is intentionally NOT covered by this skip.
    try {
      const { saveGeneratedImage } = await import('../../state/media-library.js');
      for (const img of savedImages) {
        if (img.savedTo && action.label !== 'storyboard_card') {
          await saveGeneratedImage(img.savedTo, {
            // Caller-supplied passthrough metadata FIRST so the tool's
            // authoritative fields below always win on key collisions.
            // Lets a visual storyboard sheet record `sourceStoryboard`
            // (the interactive storyboard JSON it belongs to) so a later
            // step can re-attach it when rendering the video.
            ...(action.metadata && typeof action.metadata === 'object' && !Array.isArray(action.metadata)
                ? action.metadata
                : {}),
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
            // Forwarded to MediaLibrary.save({summary}) → the per-
            // session creations ledger. See the field doc in the
            // schema for why this lives here.
            summary: typeof action.summary === 'string' ? action.summary : undefined,
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

    // Queue the generated image(s) into the NEXT turn's vision so the agent
    // SEES what it just produced. Without this it stays BLIND to its own
    // output — only the working-area document is attached as vision — so it
    // thinks nothing changed and loops, re-generating or firing parallel
    // variants ("no se queda conforme con lo que genera"). Mirrors read_file's
    // vision queueing. Best-effort; never fail the tool on it. Storyboard
    // thumbnails are ephemeral working assets, not outputs the agent reviews.
    if (action.label !== 'storyboard_card') {
      try {
        const session = agent?._activeSession;
        if (session) {
          const { readNormalisedImageForVision } = await import('./_normalize-image-for-vision.js');
          if (!session._pendingMcpImages) session._pendingMcpImages = [];
          for (const img of savedImages) {
            if (!img.savedTo) continue;
            const norm = await readNormalisedImageForVision(img.savedTo);
            session._pendingMcpImages.push({ mimeType: norm.mimeType, data: norm.base64, _debugPath: img.savedTo });
            channel.log('image', `Generated image queued for vision: ${img.savedTo}`);
          }
        }
      } catch (e) {
        channel.log('image', `Could not queue generated image for vision: ${e?.message || e}`);
      }
    }

    // Response contract (uniform across media tools): `savedTo` is the
    // canonical original in ~/.koi/images (stable, indexed by the creations
    // drawer); `exportedTo`, when present, is the COPY at the caller's saveTo.
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
      // Non-fatal contract violations surface here. Currently used by the
      // `visual_storyboard` label to flag missing source-JSON metadata —
      // the call succeeded but the downstream `visual-panels-to-video`
      // link is broken (see _warnings collection at the top of execute()).
      ...(_warnings.length > 0 ? { warnings: _warnings } : {}),
    };
  }
};

import asyncCapable from '../_async-capable.js';
import { formatModelCatalog } from './_format-model-catalog.js';

// Wrap FIRST so the catalog refresh below mutates the registered object —
// asyncCapable spreads a fresh schema/description, so any in-place edit
// to the source `generateImageAction` would land on a copy nobody reads.
const wrappedAction = asyncCapable(generateImageAction);

// Pristine knob vocabulary, snapshotted BEFORE the capability rewrite below
// deletes props the ACTIVE provider lacks. The MCP media mapper reads this:
// deriving knobs from the live (trimmed) schema is circular — a provider whose
// map is missing a knob trims the schema, so the remap can never recover it.
wrappedAction._pristineProperties = JSON.parse(JSON.stringify(wrappedAction.schema.properties));

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
  fields.push('optional "saveTo" — where to place a COPY: an absolute DIRECTORY (a filename is minted inside it) OR a full FILE path ending in .png/.jpg/.webp (the first image is copied to exactly that path). The original always stays in ~/.koi/images and is returned in images[].savedTo (use THAT for downstream chaining, never fabricate paths); the copy at your saveTo is images[].exportedTo.');

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
