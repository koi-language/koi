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
const _inCategory = (m, cat) => _modelCategories(m).includes(cat);

/** Sort eligible candidates so the best pick lands at index 0. Ranks:
 *  1. Label match (when one was requested, matching wins; when none,
 *     unlabelled wins over labelled — labels mark specialised variants
 *     that shouldn't leak into generic requests by accident).
 *  2. isFallback (admin-curated rows tagged `isFallback: true` lose to
 *     primary rows when both qualify — used for "keep around but only
 *     pick if nothing else fits" entries).
 *  3. Price — by default the most EXPENSIVE wins (price as a quality
 *     proxy). Caller can flip with `preferQuality: false` for budget
 *     mode where cheapest wins.
 *  Mutates the array in place. */
const _rankSort = (eligible, req) => {
  const wantLabel = req.label || null;
  const preferQuality = req.preferQuality !== false;
  const rankOf = (m) => {
    const labelRank = wantLabel
      ? (_modelHasLabel(m, wantLabel) ? 0 : 1)
      : (_modelHasAnyLabel(m) ? 1 : 0);
    const fallbackRank = m.isFallback ? 1 : 0;
    const rawPrice = m.pricePerUnit ?? Number.POSITIVE_INFINITY;
    const priceRank = preferQuality ? -rawPrice : rawPrice;
    return [labelRank, fallbackRank, priceRank];
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
  return eligible[0].slug;
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
  const intent = typeof req.intent === 'string' ? req.intent.trim() : '';
  const refsCount = req.refsCount || 0;
  const wantedBucket =
    (intent === 'bg-remove' || intent === 'background-removal' || intent === 'rembg') ? 'image_background_removal' :
    (intent === 'upscale' || intent === 'upscaling') ? 'image_upscaling' :
    (intent === 'outpaint' || intent === 'extend') ? 'image_extend' :
    (intent === 'edit' || intent === 'inpaint') ? 'image_editing' :
    refsCount > 0 ? 'image_editing' :
    'image_generation';
  return _pickByBucket('image', models, req, wantedBucket);
}

// ── Video ───────────────────────────────────────────────────────────────────

/** Map a video request to a Koi `categories[]` bucket.
 *   • `kind: 'avatar'`              → video_avatar
 *   • `kind: 'extend'`              → video_extend
 *   • `kind: 'bg-remove' | …`       → video_background_removal
 *   • `videoRefsCount > 0`          → video_editing  (video-to-video)
 *   • else                          → video_generation
 *
 *  Note: `hasStartFrame` and `refsCount` (image references) do NOT
 *  change the bucket — both image-to-video and reference-to-video
 *  models live under `video_generation`. The router does not gate
 *  by input shape; the per-slug adapter rejects payloads it can't
 *  honour at execution time.
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
  return _pickByBucket('video', models, req, wantedBucket);
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
  return _pickByBucket('audio', models, req, wantedBucket);
}
