/**
 * Client-side media model router — unified for image, video, and audio.
 *
 * Architectural contract:
 *   1. Backend exposes the active catalog at
 *      /gateway/models/{image,video,audio}.json. The payload carries
 *      ONLY Koi-owned signals: slug, displayName, provider, pricePerUnit,
 *      unitType, avgLatencyMs, isFallback, labels[], categories[].
 *      Vendor-derived classification (textToVideo/imageToVideo/…,
 *      operations[]) and schema-introspected facts (maxRefImages,
 *      aspectRatios, resolutions, frameControl, hasAudio, lipsync,
 *      tts/sfx/…, inputImage/Video/Audio) are intentionally absent —
 *      they were unreliable (fal mis-classifies refs-to-video as
 *      image-to-video) or duplicated info that lives in the per-slug
 *      adapter anyway.
 *   2. The client maps the request shape to a `wantedBucket` (a Koi
 *      `categories[]` value) and filters models that declare that
 *      bucket. Labels carve out specialised variants when requested.
 *      Pricing breaks ties.
 *   3. The picked slug is sent to the backend, which dispatches to the
 *      per-slug adapter. The adapter is the SOLE place that knows what
 *      shape the model physically accepts; mismatched inputs fail
 *      cleanly inside `adapter.build()` instead of being silently
 *      coerced by the router.
 *
 * Throws `MediaModelRoutingError` (`code === 'no_model_matches'`) when
 * no model in the active catalog carries the bucket the request maps
 * to. The error includes the requirements + a list of slugs by
 * category so the agent can pivot instead of giving up.
 */

import { channel } from '../../io/channel.js';

export class MediaModelRoutingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MediaModelRoutingError';
    this.code = 'no_model_matches';
    this.details = details || null;
  }
}

// Labels are per-model `Array<{slug, description}>` (see backend
// gateway.service.ts:getMediaModels). Tolerate the legacy plain-string
// shape so older catalogs / tests / fixtures keep working.
const _labelSlugs = (m) => {
  if (!Array.isArray(m?.labels)) return [];
  return m.labels.map((l) => {
    if (typeof l === 'string') return l;
    if (l && typeof l === 'object' && typeof l.slug === 'string') return l.slug;
    return null;
  }).filter(Boolean);
};
const _modelHasLabel = (m, slug) => _labelSlugs(m).includes(slug);
const _modelHasAnyLabel = (m) => _labelSlugs(m).length > 0;

const _modelCategories = (m) => Array.isArray(m?.categories) ? m.categories : [];

// Legacy → canonical bucket aliases. The backoffice form vocabulary
// (`audio_sfx`, `audio_music`, `audio_tts`, `audio_voice_clone`,
// `image_background_removal`, …) was tightened up AFTER catalog rows
// had already been tagged with the older short forms (`sfx`, `music`,
// `tts`, `voice_clone`, `background-removal`, …). Rather than force a
// data migration, the router treats both as the same bucket — a model
// declaring either side of the alias is considered in-category for
// the canonical form. Add new aliases here when the form vocabulary
// changes; never branch on shape elsewhere.
const _CATEGORY_ALIASES = {
  audio_sfx: ['sfx'],
  audio_music: ['music'],
  audio_tts: ['tts'],
  audio_voice_clone: ['voice_clone', 'voice-clone'],
  audio_transcription: ['transcribe', 'transcription'],
  image_background_removal: ['background-removal', 'background_removal', 'bg-remove', 'rembg'],
  image_upscaling: ['upscale', 'upscaling', 'upscaler'],
  image_extend: ['outpaint', 'outpainting', 'extend'],
  image_editing: ['edit', 'editing', 'inpaint', 'inpainting'],
  image_generation: ['generate', 'text-to-image'],
  video_avatar: ['avatar', 'lipsync'],
  video_extend: ['video-extend'],
  video_background_removal: ['video-background-removal'],
  video_editing: ['video-edit', 'video-to-video'],
  video_generation: ['video-generate', 'text-to-video'],
};
const _bucketSynonyms = (cat) => {
  const aliases = _CATEGORY_ALIASES[cat] || [];
  return [cat, ...aliases];
};
const _inCategory = (m, cat) => {
  const cats = _modelCategories(m);
  for (const syn of _bucketSynonyms(cat)) {
    if (cats.includes(syn)) return true;
  }
  return false;
};

/** Canonical names of every input a per-slug `requires` array might
 *  list, paired with the `req` flag that signals the caller is sending
 *  that input. Used by `_shapeMatchScore` so the ranker can prefer
 *  slugs whose declared input shape OVERLAPS with what the caller
 *  actually has — a model with `requires: ['startFrame']` ranks ahead
 *  of one with `requires: []` when the caller passed a startFrame,
 *  even though both pass the cheap `_filterByRequires` gate.
 *  Without this tier the seedance reference-to-video slug
 *  (`requires: []`, accepts image_urls optionally) tied on every other
 *  rank with the seedance image-to-video slug (`requires: ['startFrame']`)
 *  and won by alphabetical accident, silently remapping the caller's
 *  startFrame to a reference image with different semantics. */
const _REQUIRES_KEY_FROM_REQ = {
  startFrame:          (r) => !!r.hasStartFrame,
  endFrame:            (r) => !!r.hasEndFrame,
  referenceImages:     (r) => (r.refsCount || 0) > 0,
  referenceVideos:     (r) => (r.videoRefsCount || 0) > 0,
  imageUrl:            (r) => !!r.hasImageUrl,
  audioUrl:            (r) => !!r.hasAudioUrl,
  characterOrientation:(r) => !!r.characterOrientation,
  maskImage:           (r) => !!r.hasMaskImage,
  sourceImage:         (r) => !!r.hasSourceImage,
  targetSize:          (r) => !!r.hasTargetSize,
  sourceImageOffset:   (r) => !!r.hasSourceImageOffset,
  cameraAngles:        (r) => !!(r.cameraAngles
      && (typeof r.cameraAngles.horizontal === 'number'
          || typeof r.cameraAngles.vertical === 'number'
          || typeof r.cameraAngles.zoom === 'number')),
  videoUrl:            (r) => !!r.hasVideoUrl,
};

/** Returns the count of `m.requires` entries the caller actually sent.
 *  Higher = better shape match (model and caller agree on the inputs).
 *  Empty `m.requires` → 0 (no declared shape), no penalty either way. */
function _shapeMatchScore(m, req) {
  const reqs = Array.isArray(m?.requires) ? m.requires : null;
  if (!reqs || reqs.length === 0) return 0;
  let matched = 0;
  for (const key of reqs) {
    const has = _REQUIRES_KEY_FROM_REQ[key];
    if (typeof has === 'function' && has(req)) matched += 1;
  }
  return matched;
}

/** Sort eligible candidates so the best pick lands at index 0. Ranks:
 *  1. Shape match. Models whose `requires` list overlaps with the
 *     caller's actual inputs win — keeps an image-to-video slug
 *     (`requires: ['startFrame']`) ahead of a reference-to-video slug
 *     (`requires: []`) when the caller passed `startFrame`, even if
 *     both pass `_filterByRequires` and tie on price.
 *  2. Label match. When a label was requested, matching wins. When none
 *     was requested, the "default" label is treated as a curated
 *     preference: models carrying `default` rank first, then unlabelled
 *     (generic) models, then models with other (specialised) labels.
 *  3. isFallback (admin-curated rows tagged `isFallback: true` lose to
 *     primary rows when both qualify — used for "keep around but only
 *     pick if nothing else fits" entries).
 *  4. Price — by default the most EXPENSIVE wins (price as a quality
 *     proxy). Caller can flip with `preferQuality: false` for budget
 *     mode where cheapest wins.
 *  Mutates the array in place. */
const _rankSort = (eligible, req) => {
  const wantLabel = req.label || null;
  const preferQuality = req.preferQuality !== false;
  const rankOf = (m) => {
    // Negate so a higher match score sorts FIRST.
    const shapeRank = -_shapeMatchScore(m, req);
    let labelRank;
    if (wantLabel) {
      labelRank = _modelHasLabel(m, wantLabel) ? 0 : 1;
    } else if (_modelHasLabel(m, 'default')) {
      labelRank = 0;
    } else if (!_modelHasAnyLabel(m)) {
      labelRank = 1;
    } else {
      labelRank = 2;
    }
    const fallbackRank = m.isFallback ? 1 : 0;
    const rawPrice = m.pricePerUnit ?? Number.POSITIVE_INFINITY;
    const priceRank = preferQuality ? -rawPrice : rawPrice;
    return [shapeRank, labelRank, fallbackRank, priceRank];
  };
  eligible.sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  });
};

/** Build a `categories → [slugs]` map for the no_model_matches error
 *  so the agent can see which buckets the active catalog covers and
 *  pivot if its request lands in an empty one. */
const _catalogByCategory = (models) => {
  const out = {};
  for (const m of models) {
    for (const c of _modelCategories(m)) {
      if (!out[c]) out[c] = [];
      out[c].push(m.slug);
    }
  }
  return out;
};

/** Shared picker. Filters by:
 *   • `pricePerUnit != null` (skip inactive / unpriced rows)
 *   • includeModels whitelist (if non-empty)
 *   • excludeModels blacklist
 *   • category `wantedBucket` (the row must declare this category)
 *   • label match (when requested, two-pass fallback drops the label)
 *  then sorts via `_rankSort` and returns the top slug.
 *  Throws MediaModelRoutingError when no row qualifies. */
function _pickByBucket(kind, models, req, wantedBucket) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new MediaModelRoutingError(`No active ${kind} models available`, { requirements: req });
  }

  // `other` / `default` are admin placeholders in the catalog rather
  // than meaningful semantic choices — `other` means "no specific
  // category" and `default` means "this is the curated baseline".
  // Treat them as no-label so the caller's pool isn't accidentally
  // narrowed to whichever model happened to carry the placeholder tag
  // (real-world bug: an agent passing `label: 'other'` filtered the
  // video catalog down to kling alone because kling was the only model
  // tagged with that placeholder, even though seedance image-to-video
  // was the better pick by every other tier).
  if (req.label === 'other' || req.label === 'default') {
    req = { ...req, label: null };
  }

  // Whitelist (caller-pinned slugs) takes precedence so debug/error
  // output reflects ONLY what the caller wanted to consider.
  const _included = Array.isArray(req.includeModels) && req.includeModels.length > 0
    ? new Set(req.includeModels)
    : null;
  let pool = _included ? models.filter((m) => _included.has(m.slug)) : models;
  if (_included && pool.length === 0) {
    throw new MediaModelRoutingError(
      `None of the includeModels=[${[..._included].join(', ')}] are present in the active ${kind} catalog`,
      { requirements: req, included: [..._included] },
    );
  }

  const _excluded = Array.isArray(req.excludeModels) && req.excludeModels.length > 0
    ? new Set(req.excludeModels)
    : null;
  if (_excluded) {
    pool = pool.filter((m) => !_excluded.has(m.slug));
    if (pool.length === 0) {
      throw new MediaModelRoutingError(
        `All active ${kind} models were explicitly excluded (excludeModels=[${[..._excluded].join(', ')}])`,
        { requirements: req, excluded: [..._excluded] },
      );
    }
  }

  const wantLabel = req.label || null;

  const _filter = (useLabel) => pool.filter((m) => {
    if (m.pricePerUnit == null) return false;
    if (!_inCategory(m, wantedBucket)) return false;
    if (useLabel && wantLabel && !_modelHasLabel(m, wantLabel)) return false;
    return true;
  });

  let eligible = _filter(/* useLabel */ true);
  if (eligible.length === 0 && wantLabel) {
    // Label fallback: when the requested label exists nowhere in the
    // target bucket, retry without it so a specialised label doesn't
    // dead-end a routing call when a generic model would do the job.
    eligible = _filter(/* useLabel */ false);
    if (eligible.length > 0) {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[media-router] No ${kind} model in bucket="${wantedBucket}" carries label="${wantLabel}" — falling back to non-labelled.`,
        );
      } catch { /* logging is best-effort */ }
    }
  }

  if (eligible.length === 0) {
    // Verbose diagnostic — surface to console.error so the user can see
    // EXACTLY which slugs are in the cache and what their `categories`
    // arrays look like. The catalog-by-category map alone hides slugs
    // when the category aliases didn't match, so dump the raw shape
    // too.
    try {
      const raw = pool.map((m) => ({
        slug: m?.slug,
        categories: m?.categories,
        labels: Array.isArray(m?.labels)
          ? m.labels.map((l) => (typeof l === 'string' ? l : l?.slug))
          : [],
        isActive: m?.isActive,
        pricePerUnit: m?.pricePerUnit,
      }));
      // eslint-disable-next-line no-console
      console.error(
        `[media-router] No ${kind} model in bucket="${wantedBucket}". ` +
        `Pool has ${pool.length} model(s):`,
        JSON.stringify(raw, null, 2),
      );
    } catch { /* logging is best-effort */ }
    throw new MediaModelRoutingError(
      `No active ${kind} model in bucket="${wantedBucket}"${wantLabel ? ` with label="${wantLabel}"` : ''}`,
      {
        requirements: req,
        wantedBucket,
        catalog: _catalogByCategory(pool),
      },
    );
  }
  _rankSort(eligible, req);
  // Log the decision so future "why did the picker land here?" debug
  // doesn't require reconstructing the catalog state from memory. Each
  // line includes the bucket, the winning slug, and the ranked
  // competitors with their (labelRank, fallbackRank, priceRank) tuples.
  try {
    const winner = eligible[0].slug;
    const competitors = eligible.slice(0, 5).map((m) => {
      const labels = _labelSlugs(m);
      const labelTag = labels.length > 0 ? `[${labels.join(',')}]` : '[-]';
      const fb = m.isFallback ? ' fb' : '';
      return `${m.slug}${labelTag}@${m.pricePerUnit ?? '?'}${fb}`;
    }).join(' > ');
    channel.log('media-router', `${kind}/${wantedBucket}${wantLabel ? `:${wantLabel}` : ''} → ${winner}  (ranked: ${competitors}${eligible.length > 5 ? ` +${eligible.length - 5} more` : ''})`);
  } catch { /* logging is best-effort */ }
  // Return the full model OBJECT, not just the slug. Callers that
  // only need the slug do `picked.slug`; tools that need
  // `constraints` / `categories` / etc. before dispatching read
  // those off the object directly (the whole point of this refactor —
  // outpaint-image needs the picked model's output.maxArea/Dimension
  // BEFORE building the canvas to avoid the guaranteed 4xx).
  return eligible[0];
}

// ── Image ───────────────────────────────────────────────────────────────────

/** Map an image request to a Koi `categories[]` bucket.
 *   • `intent: 'bg-remove' | 'background-removal' | 'rembg'` → image_background_removal
 *   • `intent: 'upscale' | 'upscaling'`                       → image_upscaling
 *   • `intent: 'outpaint' | 'extend'`                         → image_extend
 *   • `intent: 'edit' | 'inpaint'`                            → image_editing
 *   • `refsCount > 0` (no explicit intent)                    → image_editing
 *   • else                                                    → image_generation
 *
 *  `req.intent` is the AGENT-SIDE signal (what the tool wants to do) —
 *  it's deliberately named differently from the legacy `m.operations[]`
 *  vendor classification (which is no longer consumed anywhere outside
 *  the backoffice UI). Buckets are admin-curated via the `categories[]`
 *  field on model_prices. Per-shape capacity gates (maxRefImages, etc.)
 *  are NOT here — the per-slug adapter rejects mismatched payloads at
 *  execution time.
 */
export function pickImageModel(models, req = {}) {
  // Camera-angle requests are deterministically routed to the only
  // model whose LoRA understands the discrete (horizontal, vertical,
  // zoom) sliders. Bypass the bucket logic entirely — running an
  // image_editing bucket pick here could land on a generic edit
  // model that has no concept of `cameraAngles` and would just
  // return the input unchanged (the bug we hit before this short-circuit).
  if (req?.cameraAngles
      && (typeof req.cameraAngles.horizontal === 'number'
          || typeof req.cameraAngles.vertical === 'number'
          || typeof req.cameraAngles.zoom === 'number')) {
    const QWEN_ANGLES_SLUG = 'fal-ai/qwen-image-edit-2511-multiple-angles';
    const hit = (models || []).find((m) => m?.slug === QWEN_ANGLES_SLUG);
    if (hit) {
      channel.log(
        'image',
        `[cameraAngles] router short-circuit → ${QWEN_ANGLES_SLUG} (${JSON.stringify(req.cameraAngles)})`,
      );
      // pickImageModel's contract is to return the slug STRING (matches
      // _pickByBucket's `return eligible[0].slug`). Returning the model
      // object here surfaced as `Model resolved → [object Object]` and
      // a downstream "Unknown model slug: [object Object]" error.
      return hit.slug;
    }
    // Fall through to bucket selection if the slug isn't in the live
    // catalog yet (e.g. admin hasn't added the model_prices row). The
    // adapter will then throw a clear "cameraAngles required" error.
    channel.log(
      'image',
      `[cameraAngles] WARNING — cameraAngles present but slug ${QWEN_ANGLES_SLUG} not in active catalog. Falling back to bucket selection; the picked model will likely ignore the camera sliders and return the input image unchanged. Action: add the slug to model_prices in the backoffice.`,
    );
  }

  const intent = typeof req.intent === 'string' ? req.intent.trim() : '';
  const refsCount = req.refsCount || 0;
  const wantedBucket =
    (intent === 'bg-remove' || intent === 'background-removal' || intent === 'rembg') ? 'image_background_removal' :
    (intent === 'upscale' || intent === 'upscaling') ? 'image_upscaling' :
    (intent === 'outpaint' || intent === 'extend') ? 'image_extend' :
    (intent === 'edit' || intent === 'inpaint') ? 'image_editing' :
    refsCount > 0 ? 'image_editing' :
    'image_generation';

  // Shape filter: drop slugs whose `requires` lists a canonical input
  // the request doesn't carry. Optional/soft inputs aren't tracked —
  // the adapter handles them. The presence map enumerates every
  // canonical input a per-slug `requires` *might* name (see
  // backend/src/modules/gateway/adapters/_shared.ts::ImageRequired).
  const presence = {
    referenceImages: refsCount > 0,
    maskImage: !!req.hasMaskImage,
    sourceImage: !!req.hasSourceImage,
    targetSize: !!req.hasTargetSize,
    sourceImageOffset: !!req.hasSourceImageOffset,
    cameraAngles: !!(req.cameraAngles
      && (typeof req.cameraAngles.horizontal === 'number'
          || typeof req.cameraAngles.vertical === 'number'
          || typeof req.cameraAngles.zoom === 'number')),
  };
  const filtered = _filterByRequires(models, presence);
  const pool = filtered.length > 0 ? filtered : models;
  // Preserve the public-API contract: pickImageModel returns the slug
  // STRING. Tools that need the full model object (with `constraints`)
  // use `peekImageModel` below, which performs the same ranking but
  // returns the model object directly.
  return _pickByBucket('image', pool, req, wantedBucket).slug;
}

/**
 * Identical to pickImageModel but returns the full model OBJECT
 * (slug, displayName, categories, constraints, …) instead of just
 * the slug string. Tools call this BEFORE dispatching so they can
 * read the picked model's `constraints` and resize / recompress the
 * payload accordingly. The cameraAngles short-circuit, the
 * `_filterByRequires` step, and the bucket-rank logic are exactly
 * the same — only the return shape differs.
 */
export function peekImageModel(models, req = {}) {
  if (req?.cameraAngles
      && (typeof req.cameraAngles.horizontal === 'number'
          || typeof req.cameraAngles.vertical === 'number'
          || typeof req.cameraAngles.zoom === 'number')) {
    const QWEN_ANGLES_SLUG = 'fal-ai/qwen-image-edit-2511-multiple-angles';
    const hit = (models || []).find((m) => m?.slug === QWEN_ANGLES_SLUG);
    if (hit) return hit;
  }
  const intent = typeof req.intent === 'string' ? req.intent.trim() : '';
  const refsCount = req.refsCount || 0;
  const wantedBucket =
    (intent === 'bg-remove' || intent === 'background-removal' || intent === 'rembg') ? 'image_background_removal' :
    (intent === 'upscale' || intent === 'upscaling') ? 'image_upscaling' :
    (intent === 'outpaint' || intent === 'extend') ? 'image_extend' :
    (intent === 'edit' || intent === 'inpaint') ? 'image_editing' :
    refsCount > 0 ? 'image_editing' :
    'image_generation';
  const presence = {
    referenceImages: refsCount > 0,
    maskImage: !!req.hasMaskImage,
    sourceImage: !!req.hasSourceImage,
    targetSize: !!req.hasTargetSize,
    sourceImageOffset: !!req.hasSourceImageOffset,
    cameraAngles: !!(req.cameraAngles
      && (typeof req.cameraAngles.horizontal === 'number'
          || typeof req.cameraAngles.vertical === 'number'
          || typeof req.cameraAngles.zoom === 'number')),
  };
  const filtered = _filterByRequires(models, presence);
  const pool = filtered.length > 0 ? filtered : models;
  return _pickByBucket('image', pool, req, wantedBucket);
}

// ── Video ───────────────────────────────────────────────────────────────────

/** Apply the declarative `requires` filter to a candidate pool.
 *
 *  Each model's `requires` is a STRING ARRAY listing only the canonical
 *  inputs the adapter cannot work without. Optional inputs aren't
 *  tracked — the adapter forwards them when supported and silently
 *  ignores them when not. The router's only job is to drop slugs that
 *  would 4xx or throw for lack of a mandatory input.
 *
 *  `presence` is a `{ inputName: true|false }` snapshot of which
 *  canonical inputs the caller wired into the request. Models whose
 *  `requires` is `null` / `undefined` (legacy or no registered adapter)
 *  always pass — the per-slug adapter will reject at execution time.
 */
function _filterByRequires(models, presence) {
  if (!Array.isArray(models) || models.length === 0) return models;
  return models.filter((m) => {
    const req = m?.requires;
    if (req == null) return true; // legacy: trust the adapter
    if (!Array.isArray(req)) return true; // unknown shape: don't gate on it
    for (const key of req) {
      if (!presence[key]) return false;
    }
    return true;
  });
}

/** Map a video request to a Koi `categories[]` bucket AND filter the
 *  candidate pool by declarative input-shape compatibility (per-slug
 *  `requires` populated from the adapter, see
 *  `backend/src/modules/gateway/adapters/_shared.ts::VideoRequires`).
 *
 *  Bucket selection:
 *   • `kind: 'avatar'`              → video_avatar
 *   • `kind: 'extend'`              → video_extend
 *   • `kind: 'bg-remove' | …`       → video_background_removal
 *   • `videoRefsCount > 0`          → video_editing  (video-to-video)
 *   • else                          → video_generation
 *
 *  Shape filter: applied INSIDE the chosen bucket. A model whose
 *  `requires` declares an input as `'required'` is dropped when that
 *  input is missing from the request; a model whose `requires` doesn't
 *  list an input the request carries is dropped to avoid silently
 *  ignoring the user's data. See [_filterByRequires].
 */
export function pickVideoModel(models, req = {}) {
  const kind = req.kind || '';
  const videoRefsCount = req.videoRefsCount || 0;
  const wantedBucket =
    kind === 'avatar' ? 'video_avatar' :
    kind === 'extend' ? 'video_extend' :
    (kind === 'bg-remove' || kind === 'background-removal' || kind === 'background_removal') ? 'video_background_removal' :
    videoRefsCount > 0 ? 'video_editing' :
    'video_generation';

  if (!Array.isArray(models) || models.length === 0) {
    return _pickByBucket('video', models, req, wantedBucket).slug;
  }

  // Build the presence snapshot mirroring the keys of VideoRequires.
  const presence = {
    startFrame: !!req.hasStartFrame,
    endFrame: !!req.hasEndFrame,
    referenceImages: (req.refsCount || 0) > 0,
    referenceVideos: (req.videoRefsCount || 0) > 0,
    imageUrl: !!req.hasImageUrl,
    audioUrl: !!req.hasAudioUrl,
    characterOrientation: !!req.characterOrientation,
  };

  const filtered = _filterByRequires(models, presence);
  // If the filter empties the pool but candidates existed upstream,
  // fall back to the unfiltered list. The per-slug adapter will reject
  // and the agent can react — better than throwing `no_model_matches`
  // with a misleading reason.
  const pool = filtered.length > 0 ? filtered : models;
  return _pickByBucket('video', pool, req, wantedBucket).slug;
}

/** Same as pickVideoModel but returns the full model OBJECT — see
 *  peekImageModel for rationale. */
export function peekVideoModel(models, req = {}) {
  const kind = req.kind || '';
  const videoRefsCount = req.videoRefsCount || 0;
  const wantedBucket =
    kind === 'avatar' ? 'video_avatar' :
    kind === 'extend' ? 'video_extend' :
    (kind === 'bg-remove' || kind === 'background-removal' || kind === 'background_removal') ? 'video_background_removal' :
    videoRefsCount > 0 ? 'video_editing' :
    'video_generation';
  if (!Array.isArray(models) || models.length === 0) {
    return _pickByBucket('video', models, req, wantedBucket);
  }
  const presence = {
    startFrame: !!req.hasStartFrame,
    endFrame: !!req.hasEndFrame,
    referenceImages: (req.refsCount || 0) > 0,
    referenceVideos: (req.videoRefsCount || 0) > 0,
    imageUrl: !!req.hasImageUrl,
    audioUrl: !!req.hasAudioUrl,
    characterOrientation: !!req.characterOrientation,
  };
  const filtered = _filterByRequires(models, presence);
  const pool = filtered.length > 0 ? filtered : models;
  return _pickByBucket('video', pool, req, wantedBucket);
}

// ── Audio ───────────────────────────────────────────────────────────────────

/** Map an audio request to a Koi `categories[]` bucket.
 *   • `kind: 'tts'`         → audio_tts
 *   • `kind: 'transcribe'`  → audio_transcription
 *   • `kind: 'voice-clone'` → audio_voice_clone
 *   • `kind: 'music'`       → audio_music
 *   • `kind: 'sfx'`         → audio_sfx
 */
export function pickAudioModel(models, req = {}) {
  const kind = req.kind || 'tts';
  const wantedBucket =
    kind === 'tts' ? 'audio_tts' :
    kind === 'transcribe' ? 'audio_transcription' :
    kind === 'voice-clone' ? 'audio_voice_clone' :
    kind === 'music' ? 'audio_music' :
    kind === 'sfx' ? 'audio_sfx' :
    'audio_tts';

  // Shape filter — mirrors image/video. Only canonical inputs that some
  // audio adapter lists as required need to appear here. Today only
  // `videoUrl` qualifies (controlfoley REQUIRES a source video — without
  // it it has nothing to score). Optional knobs (voice, language, pitch,
  // volume, etc.) are handled by each adapter directly.
  const presence = {
    videoUrl: !!req.hasVideoUrl,
  };
  const filtered = _filterByRequires(models, presence);
  const pool = filtered.length > 0 ? filtered : models;
  return _pickByBucket('audio', pool, req, wantedBucket).slug;
}

/** Same as pickAudioModel but returns the full model OBJECT — see
 *  peekImageModel for rationale. */
export function peekAudioModel(models, req = {}) {
  const kind = req.kind || 'tts';
  const wantedBucket =
    kind === 'tts' ? 'audio_tts' :
    kind === 'transcribe' ? 'audio_transcription' :
    kind === 'voice-clone' ? 'audio_voice_clone' :
    kind === 'music' ? 'audio_music' :
    kind === 'sfx' ? 'audio_sfx' :
    'audio_tts';
  const presence = { videoUrl: !!req.hasVideoUrl };
  const filtered = _filterByRequires(models, presence);
  const pool = filtered.length > 0 ? filtered : models;
  return _pickByBucket('audio', pool, req, wantedBucket);
}
