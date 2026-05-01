/**
 * Client-side media model router — unified for image, video, and audio.
 *
 * Architectural contract (same pattern as text LLMs):
 *   1. Backend exposes the full list of active models via
 *      /gateway/models/{image,video,audio}.json.
 *   2. The client caches the list, applies hard filters + soft ranking, and
 *      sends the chosen slug to the backend.
 *   3. The backend proxies to Fal with the slug the client asked for.
 *      No resolution logic lives in the backend — just validation.
 *
 * Hard filters depend on the media kind and the request:
 *   - image: maxImages, maxRefImages, CSV resolutions /
 *            aspect ratios.
 *   - video: textToVideo|imageToVideo|videoToVideo, frameControl (if start/
 *            end frame), hasAudio (if withAudio), CSV resolutions / aspect
 *            ratios. Reference images treated like image edits.
 *   - audio: tts|transcribe|music|sfx.
 *
 * Soft ranking (cheaper loses only as a last resort):
 *   label match → isFallback → pricePerUnit.
 *
 * Throws `MediaModelRoutingError` (`code === 'no_model_matches'`) when the
 * hard filters leave zero candidates — the client surfaces this to the agent
 * without round-tripping the backend.
 */

export class MediaModelRoutingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MediaModelRoutingError';
    this.code = 'no_model_matches';
    this.details = details || null;
  }
}

// Operations that mark a model as a SPECIALIST (bg-remove, upscale, inpaint,
// segmentation, …). When no explicit `operation` is requested, models
// advertising any of these are excluded from the general-purpose pool —
// their schemas diverge from the canonical generate/edit request (e.g.
// `output_format: rgba|alpha|zip` on bg-removers) and Fal rejects a normal
// payload with a body-validation error. This list is matched against the
// OP_CANONICAL values the backend sync produces in admin.routes.ts.
const _SPECIALIST_OPS = new Set([
  'background-removal',
  'rembg',
  'upscale',
  'upscaling',
  'inpainting',
  'outpainting',
  'face-swap',
  'faceswap',
  'relighting',
  'relight',
  'denoise',
  'denoising',
  'colorize',
  'colorization',
  'segmentation',
  'restoration',
  'deblur',
]);

// Labels are now per-model `Array<{slug, description}>` (see backend
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

const _csvSupports = (csv, requested) => {
  if (!requested) return true;
  if (!csv) return true;
  return csv.split(',').map((s) => s.trim().toLowerCase()).includes(String(requested).trim().toLowerCase());
};

const _rankSort = (eligible, req) => {
  const wantLabel = req.label || null;
  const wantAspect = req.aspectRatio || null;
  const wantRes = req.resolution || null;
  // Default behaviour: prefer quality (more expensive wins ties) —
  // treats price as a proxy for capability tier, accurate across the
  // image / video / audio catalogs where the premium models also sit
  // at the top of the price ladder. Callers wanting cheapest-first
  // (budget mode) pass `preferQuality: false` explicitly. The other
  // rank dimensions (label, aspect, resolution, isFallback) keep the
  // same direction either way — only the price tiebreaker flips.
  const preferQuality = req.preferQuality !== false;
  const rankOf = (m) => {
    const labelRank = wantLabel
      ? (_modelHasLabel(m, wantLabel) ? 0 : 1)
      : 0;
    // Soft preferences: a model that advertises the requested
    // aspect/resolution is preferred over one that doesn't, but both
    // still compete. For edits, the output inherits the base
    // dimensions anyway, so the non-match is harmless as a fallback.
    // Listing order = importance: aspect first (visible cropping),
    // then resolution (quality tier).
    const aspectRank = wantAspect
      ? (_csvSupports(m.aspectRatios, wantAspect) ? 0 : 1)
      : 0;
    const resRank = wantRes
      ? (_csvSupports(m.resolutions, wantRes) ? 0 : 1)
      : 0;
    const fallbackRank = m.isFallback ? 0 : 1;
    // Cheaper wins by default (POSITIVE_INFINITY when missing pushes
    // unpriced rows last). With preferQuality, negate the price so the
    // most expensive wins instead — same comparator, opposite sign.
    const rawPrice = m.pricePerUnit ?? Number.POSITIVE_INFINITY;
    const priceRank = preferQuality ? -rawPrice : rawPrice;
    return [labelRank, aspectRank, resRank, fallbackRank, priceRank];
  };
  eligible.sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  });
};

const _throwIfEmpty = (eligible, kind, req, total) => {
  if (eligible.length === 0) {
    throw new MediaModelRoutingError(
      `No active ${kind} model matches the requested capabilities`,
      { requirements: req, candidates: total },
    );
  }
};

/**
 * Summary card for an image model — just the fields an agent needs to decide
 * how to recule its request. Keep it compact; this goes into an error payload
 * that's shown to the agent as JSON.
 */
const _imageCard = (m) => ({
  slug: m.slug,
  maxImages: m.maxImages ?? null,
  maxRefImages: m.maxRefImages ?? null,
  resolutions: m.resolutions || '',
  aspectRatios: m.aspectRatios || '',
  // Surfaced so the agent (and the dev reading the log) can tell when a
  // model was rejected because it carries a label the request didn't ask
  // for — otherwise the diagnostic looks like "but this model matches!"
  // while the picker silently drops it for the labels filter.
  labels: _labelSlugs(m),
  operations: Array.isArray(m.operations) ? m.operations : [],
});

/**
 * A model accepts reference images when `canEdit` is true and the request
 * fits under `maxRefImages`. Per-slug adapters live in the backend
 * (`backend/src/modules/gateway/adapters/image/`) — only models with an
 * adapter that maps refs are marked editable.
 *
 * `maxRefImages > 0` caps at N; `=== 0` means unlimited.
 */
const _acceptsRefs = (m, refsCount) => {
  if (!m.canEdit) return false;
  if (typeof m.maxRefImages === 'number' && m.maxRefImages > 0 && refsCount > m.maxRefImages) return false;
  return true;
};

/**
 * When the hard filters leave zero candidates, build a per-dimension
 * diagnostic: for each requirement the caller supplied, list the image
 * models that would have matched IF that dimension had been the only
 * constraint. The agent can then see which combinations are viable and
 * adjust its request.
 */
function _diagnoseImage(models, req) {
  const out = {};
  const n = req.n || 1;
  const refsCount = req.refsCount || 0;

  if (req.resolution) {
    out[`resolution=${req.resolution}`] = models
      .filter((m) => _csvSupports(m.resolutions, req.resolution))
      .map(_imageCard);
  }
  if (req.aspectRatio) {
    out[`aspectRatio=${req.aspectRatio}`] = models
      .filter((m) => _csvSupports(m.aspectRatios, req.aspectRatio))
      .map(_imageCard);
  }
  if (n > 1) {
    out[`n=${n}`] = models
      .filter((m) => m.maxImages == null || n <= m.maxImages)
      .map(_imageCard);
  }
  if (refsCount > 0) {
    out[`refsCount=${refsCount}`] = models
      .filter((m) => _acceptsRefs(m, refsCount))
      .map(_imageCard);
  }
  return out;
}

// ── Image ───────────────────────────────────────────────────────────────────

/**
 * @param {Array<object>} models — /gateway/models/image.json rows
 * @param {object} req
 * @param {number} [req.n=1]
 * @param {string} [req.resolution]
 * @param {string} [req.aspectRatio]
 * @param {number} [req.refsCount=0]
 * @param {string} [req.label]
 * @param {string} [req.operation] - Required semantic category when set:
 *   'bg-remove' | 'upscale' | 'inpaint' | 'outpaint' | 'generate' | 'edit' | ...
 *   A model qualifies only if its `operations` array contains this value.
 *   When unset, the filter is skipped (backwards-compatible for generate).
 */
export function pickImageModel(models, req = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new MediaModelRoutingError('No active image models available', { requirements: req });
  }

  const n = req.n || 1;
  const refsCount = req.refsCount || 0;
  const wantsOperation = typeof req.operation === 'string' && req.operation.trim()
    ? req.operation.trim()
    : null;

  const wantLabel = req.label || null;
  const modelHasLabels = _modelHasAnyLabel;

  // Koi-owned purpose buckets (see model_prices.categories). When a row
  // carries them, this is the SOLE membership signal we trust — vendor
  // tags are advisory and routinely mis-classify models. Rows with an
  // empty categories[] keep the legacy operation/specialist path so the
  // catalog can be backfilled gradually.
  const modelCategories = (m) => Array.isArray(m.categories) ? m.categories : [];
  const isCategorised = (m) => modelCategories(m).length > 0;
  const inCategory = (m, cat) => modelCategories(m).includes(cat);
  // When the agent attaches reference images but doesn't set an explicit
  // operation, treat the request as an edit. Otherwise the bucket defaults
  // to `image_generation` and every categorised edit model (e.g.
  // nano-banana-2/edit) gets filtered out, leaving the agent staring at
  // `no_model_matches` even though refs + the requested aspect/resolution
  // are well-supported by an edit model.
  const wantedImageBucket = (
    (wantsOperation === 'bg-remove' || wantsOperation === 'background-removal' || wantsOperation === 'rembg') ? 'background_removal' :
    (wantsOperation === 'upscale' || wantsOperation === 'upscaling') ? 'image_upscaling' :
    // outpaint = canvas extension. Routes to its own `image_extend`
    // bucket so a single backoffice tag controls which model owns
    // outpainting (the generic edit pool tends to redraw the whole
    // scene instead of only painting the transparent margins).
    (wantsOperation === 'outpaint' || wantsOperation === 'extend') ? 'image_extend' :
    (wantsOperation === 'edit' || wantsOperation === 'inpaint') ? 'image_editing' :
    refsCount > 0 ? 'image_editing' :
    'image_generation'
  );

  // Philosophy: the router is an AUTOMATIC PICKER. The agent supplies the
  // parameters it cares about (aspectRatio, resolution, refsCount, …) and
  // the picker returns the *closest matching active model* — it never
  // errors out because "no model advertises the exact combination". The
  // agent has no way to enumerate the catalog, so a "no_model_matches"
  // error is a router failure, not a user error.
  //
  // Hard filters (reject) are limited to things the model categorically
  // CAN'T do:
  //   • maxRefImages — the only reference-image gate. 0 = text-only, N>0 =
  //     cap, null = unlimited. The legacy canEdit/canGenerate booleans
  //     were a false dichotomy: all "image models" generate images, and
  //     whether they take references is already captured here.
  //   • operations[op] when op is requested — hard "can this do the
  //     requested semantic task?" gate.
  //   • labels mismatch — labels carve out specialised variants; when no
  //     label is requested we pin to non-labelled models, and when one is
  //     requested the model must carry it.
  //   • n exceeds maxImages — explicit numeric cap.
  //   • price must be set (only rules out inactive rows).
  //
  // Everything else (resolution, aspectRatio, maxRefImages==null with no
  // refs requested) is a SOFT preference used by _rankSort to pick the
  // best match among categorical survivors.
  // Two-pass filter: first try with the label constraint (when one was
  // requested), and if that leaves zero candidates fall back to the
  // non-labelled pool. The fallback covers the case where the agent
  // asked for a specialised label (e.g. "sketch-guided") that exists for
  // a DIFFERENT operation (e.g. only on i2v models, none for the
  // requested edit op) — without it the call dies with no_model_matches
  // even though a perfectly fine generic model is sitting right there.
  const _filterImage = (useLabel) => models.filter((m) => {
    if (m.pricePerUnit == null) return false;

    if (useLabel && wantLabel) {
      if (!_modelHasLabel(m, wantLabel)) return false;
    } else {
      // Fallback path OR no label requested: pin to non-labelled models so
      // unrelated specialised variants (lipsync, etc.) never leak in.
      if (modelHasLabels(m)) return false;
    }

    // Curated category gate — authoritative for any row that has been
    // tagged in the backoffice. Categorised rows skip the legacy
    // operation/specialist gates below (the category already encodes
    // purpose); request-shape checks (maxImages, refs) still apply.
    if (isCategorised(m)) {
      if (!inCategory(m, wantedImageBucket)) return false;
      if (m.maxImages != null && n > m.maxImages) return false;
      if (refsCount > 0 && !_acceptsRefs(m, refsCount)) return false;
      return true;
    }

    if (wantsOperation) {
      if (!Array.isArray(m.operations) || !m.operations.includes(wantsOperation)) return false;
      // Operation-scoped routing short-circuits the soft preferences below
      // (BG-removal / upscale outputs mirror the input dimensions
      // regardless of requested aspect/resolution).
      return true;
    }

    // Specialist exclusion — when no operation requested, skip models
    // whose operations include any specialist op (bg-remove, upscale,
    // inpainting, outpainting, segmentation, etc.). The Fal sync attaches
    // the generic `image-to-image` category to every ref-accepting model,
    // so a naïve "does it include image-to-image?" check lets specialist
    // models through — a bg-remove model would then be picked for an edit
    // request and Fal would reject it with its specialist schema (e.g.
    // `output_format: rgba|alpha|zip`). The explicit specialist list below
    // is the authoritative gate; operation-scoped routing still works via
    // the `wantsOperation` branch above.
    if (Array.isArray(m.operations) && m.operations.length > 0) {
      const hasSpecialistOp = m.operations.some((op) => _SPECIALIST_OPS.has(op));
      if (hasSpecialistOp) return false;
      const hasGeneralCap =
        m.operations.includes('generate') ||
        m.operations.includes('edit') ||
        m.operations.includes('text-to-image') ||
        m.operations.includes('image-to-image');
      if (!hasGeneralCap) return false;
    }

    // Edit-only exclusion — when NO reference images are provided, reject
    // models that only advertise `edit` / `image-to-image` (and no pure
    // text-to-image cap). Fal rejects these calls with `body.image_url:
    // Field required` because the model's OpenAPI marks the ref field as
    // required. Without this filter a text-only prompt can get routed to
    // an edit-only model and fail at provider time with no local signal.
    if (refsCount === 0 && Array.isArray(m.operations) && m.operations.length > 0) {
      const hasTextToImage =
        m.operations.includes('generate') ||
        m.operations.includes('text-to-image');
      const isEditOnly =
        !hasTextToImage && (
          m.operations.includes('edit') ||
          m.operations.includes('image-to-image') ||
          m.operations.includes('inpaint') ||
          m.operations.includes('outpaint')
        );
      if (isEditOnly) return false;
    }

    if (m.maxImages != null && n > m.maxImages) return false;
    if (refsCount > 0 && !_acceptsRefs(m, refsCount)) return false;
    return true;
  });

  let eligible = _filterImage(/* useLabel */ true);
  let labelDropped = false;
  if (eligible.length === 0 && wantLabel) {
    eligible = _filterImage(/* useLabel */ false);
    labelDropped = eligible.length > 0;
  }
  if (labelDropped) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[media-router] No image model carries label="${wantLabel}" matching the other constraints — falling back to non-labelled models.`,
      );
    } catch { /* logging is best-effort */ }
  }

  if (eligible.length === 0) {
    throw new MediaModelRoutingError(
      'No active image model matches the requested constraints (refsCount, operation, label, maxImages)',
      {
        requirements: req,
        candidates: models.length,
        alternatives: _diagnoseImage(models, req),
      },
    );
  }
  _rankSort(eligible, req);
  return eligible[0].slug;
}

// ── Video ───────────────────────────────────────────────────────────────────

const _videoCard = (m) => ({
  slug: m.slug,
  textToVideo: !!m.textToVideo,
  imageToVideo: !!m.imageToVideo,
  videoToVideo: !!m.videoToVideo,
  frameControl: !!m.frameControl,
  hasAudio: !!m.hasAudio,
  resolutions: m.resolutions || '',
  aspectRatios: m.aspectRatios || '',
  durations: m.durations || '',
  labels: _labelSlugs(m),
  pricePerUnit: m.pricePerUnit ?? null,
});

/**
 * Build per-dimension alternatives for the agent when hard filters zero the
 * candidate list. Mirrors `_diagnoseImage`: for each requirement, show the
 * subset of models that would have matched IF that single dimension were the
 * only constraint. Lets the agent see which combinations are viable and
 * pivot instead of giving up.
 */
function _diagnoseVideo(models, req) {
  const out = {};
  const refsCount = req.refsCount || 0;
  const videoRefsCount = req.videoRefsCount || 0;
  const shotCount = typeof req.shotCount === 'number' && req.shotCount > 0 ? req.shotCount : 1;
  const wantsImageToVideo = !!(req.hasStartFrame || refsCount > 0);
  const wantsFrameControl = !!req.hasEndFrame;
  const wantsVideoToVideo = videoRefsCount > 0;
  const wantsMultishot = shotCount > 1;

  if (wantsVideoToVideo) {
    out['videoRefsCount>0'] = models
      .filter((m) => !!m.videoToVideo)
      .map(_videoCard);
  }
  if (wantsImageToVideo) {
    out['hasStartFrame|refsCount>0'] = models
      .filter((m) => !!m.imageToVideo)
      .map(_videoCard);
  }
  if (wantsFrameControl) {
    out['hasEndFrame'] = models
      .filter((m) => !!m.frameControl)
      .map(_videoCard);
  }
  if (wantsMultishot) {
    out[`shotCount>=${shotCount}`] = models
      .filter((m) => (typeof m.maxShots === 'number' ? m.maxShots : 1) >= shotCount)
      .map(_videoCard);
  }
  if (req.withAudio) {
    out['withAudio'] = models.filter((m) => !!m.hasAudio).map(_videoCard);
  }
  if (req.resolution) {
    out[`resolution=${req.resolution}`] = models
      .filter((m) => _csvSupports(m.resolutions, req.resolution))
      .map(_videoCard);
  }
  if (req.aspectRatio) {
    out[`aspectRatio=${req.aspectRatio}`] = models
      .filter((m) => _csvSupports(m.aspectRatios, req.aspectRatio))
      .map(_videoCard);
  }
  if (req.label) {
    out[`label=${req.label}`] = models
      .filter((m) => _modelHasLabel(m, req.label))
      .map(_videoCard);
  }
  return out;
}

/**
 * @param {Array<object>} models — /gateway/models/video.json rows
 * @param {object} req
 * @param {string} [req.resolution]
 * @param {string} [req.aspectRatio]
 * @param {boolean} [req.hasStartFrame]
 * @param {boolean} [req.hasEndFrame]
 * @param {boolean} [req.withAudio]
 * @param {number}  [req.refsCount=0]          image references
 * @param {number}  [req.videoRefsCount=0]     video references (video-to-video)
 * @param {number}  [req.shotCount=1]          explicit shots[].length (>1 needs multishot)
 * @param {string}  [req.label]
 * @param {string[]} [req.excludeModels]       slugs to skip (failed previously)
 * @param {string[]} [req.includeModels]       slugs the caller wants to restrict
 *                                              the picker to (whitelist). Empty
 *                                              array = no restriction.
 * @param {boolean} [req.preferQuality]        prefer pricier model on tiebreak
 */
export function pickVideoModel(models, req = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new MediaModelRoutingError('No active video models available', { requirements: req });
  }
  // Whitelist first: when the caller pinned a set of slugs, every other
  // model in the catalog drops out before the rest of the pipeline sees
  // them. This keeps the "no_model_matches" diagnostic and debug logs
  // honest — they reflect ONLY what the user wanted to consider, not the
  // full catalog. Empty array is treated as "no restriction".
  const _included = Array.isArray(req.includeModels) && req.includeModels.length > 0
    ? new Set(req.includeModels)
    : null;
  if (_included) {
    models = models.filter((m) => _included.has(m.slug));
    if (models.length === 0) {
      throw new MediaModelRoutingError(
        `None of the includeModels=[${[..._included].join(', ')}] are present in the active video catalog`,
        { requirements: req, included: [..._included] },
      );
    }
  }
  // Drop slugs the caller explicitly excluded — used by retry flows
  // where a previous slug returned a provider rejection (likeness
  // filter, content policy, etc.) and the agent wants the next best
  // candidate from the same category. Applied AFTER the include filter
  // so a user can shrink an explicit whitelist by retrying with a
  // failed slug on the exclude list.
  const _excluded = Array.isArray(req.excludeModels) ? new Set(req.excludeModels) : null;
  if (_excluded && _excluded.size > 0) {
    models = models.filter((m) => !_excluded.has(m.slug));
    if (models.length === 0) {
      throw new MediaModelRoutingError(
        `All active video models were explicitly excluded (excludeModels=[${[..._excluded].join(', ')}])`,
        { requirements: req, excluded: [..._excluded] },
      );
    }
  }
  if (process.env.KOI_DEBUG_MEDIA_ROUTER) {
    try {
      const dump = models.map((m) => ({
        slug: m.slug,
        textToVideo: !!m.textToVideo,
        imageToVideo: !!m.imageToVideo,
        videoToVideo: !!m.videoToVideo,
        labels: _labelSlugs(m),
        pricePerUnit: m.pricePerUnit,
      }));
      console.error('[media-router] pickVideoModel candidates', JSON.stringify({ req, models: dump }, null, 2));
    } catch { /* non-fatal */ }
  }

  const refsCount = req.refsCount || 0;
  const videoRefsCount = req.videoRefsCount || 0;
  const shotCount = typeof req.shotCount === 'number' && req.shotCount > 0 ? req.shotCount : 1;
  // Frame-control is the model feature that lets the caller pin BOTH ends
  // of a clip (start + end frame) for precise pacing. A single start
  // frame is just plain image-to-video — any `imageToVideo` model can
  // handle it. The old rule required `frameControl` for ANY start/end
  // frame, which wrongly rejected every plain image-to-video model and
  // left generate_video({ startFrame }) with zero candidates.
  const wantsFrameControl = !!req.hasEndFrame;
  const wantsImageToVideo = !!(req.hasStartFrame || refsCount > 0);
  const wantsVideoToVideo = videoRefsCount > 0;
  const wantsMultishot = shotCount > 1;
  const wantLabel = req.label || null;
  const modelHasLabels = _modelHasAnyLabel;

  // Philosophy (same as pickImageModel): the router is an AUTOMATIC PICKER.
  // Hard filters only reject models that categorically CAN'T do the task:
  //   • imageToVideo required when start-frame or ref-images are supplied
  //     (videoToVideo ≠ imageToVideo — extend-video accepts videoToVideo but
  //     cannot turn an image into a video; selecting it leads to a 422
  //     `video_url: Field required` at execution time).
  //   • frameControl required for end-frame pinning.
  //   • hasAudio required when withAudio=true.
  //   • labels enforced: no label requested ⇒ pin to non-labelled models,
  //     label requested ⇒ model must carry it (matches image logic so
  //     specialised variants don't leak into general requests).
  //   • price must be set (inactive rows).
  // `resolution` and `aspectRatio` are SOFT preferences via _rankSort —
  // rejecting hard on them used to leave zero candidates for aspect ratios
  // like 3:2 that no fal video model advertises, even though the output
  // dimension is usually dictated by the start_frame anyway.
  // Two-pass filter (mirror of pickImageModel): try with the label
  // constraint first; if that leaves zero candidates AND a label was
  // requested, retry without the label so the agent's intent (e.g.
  // "sketch-guided") doesn't dead-end the routing when the labelled
  // capability simply doesn't exist for the requested operation
  // (t2v / i2v / v2v). Without this fallback an agent picking
  // `label: "sketch-guided"` for a v2v request fails with
  // no_model_matches even though a generic v2v model would do the job.
  // `kind: 'avatar'` switches the picker into a separate filter mode:
  // the model row must carry the `video_avatar` category (or, on
  // older catalog rows, the legacy `avatar` operation tag / dedicated
  // `m.avatar` flag). When it's set, the t2v / i2v / v2v / multishot
  // gates DON'T apply — avatar models specifically take an image +
  // audio and produce a talking video, which doesn't fit the
  // textToVideo/imageToVideo taxonomy cleanly.
  const wantsAvatar = req.kind === 'avatar';

  // Koi-owned purpose buckets (see model_prices.categories). When a
  // model row carries them, this is the SOLE membership signal we
  // trust — vendor capability flags like imageToVideo are advisory
  // and frequently mis-tagged (avatar models routinely advertise
  // imageToVideo despite requiring audio_url). Rows with an empty
  // categories[] keep the legacy capability-flag path so the catalog
  // can be backfilled gradually.
  const modelCategories = (m) => Array.isArray(m.categories) ? m.categories : [];
  const isCategorised = (m) => modelCategories(m).length > 0;
  const inCategory = (m, cat) => modelCategories(m).includes(cat);
  const wantedBucket = wantsAvatar
    ? 'video_avatar'
    : wantsVideoToVideo
      ? 'video_editing'
      : 'video_generation';

  const _filterVideo = (useLabel) => models.filter((m) => {
    if (m.pricePerUnit == null) return false;

    if (useLabel && wantLabel) {
      if (!_modelHasLabel(m, wantLabel)) return false;
    } else {
      // Fallback path OR no label requested: pin to non-labelled models so
      // unrelated specialised variants (lipsync, etc.) never leak in.
      if (modelHasLabels(m)) return false;
    }

    // Curated category gate. If the model declares any category, it
    // must declare the one we're asking for — otherwise it's silently
    // wrong-shop (e.g. an avatar model getting picked for a generic
    // animate-this-photo request because it advertises imageToVideo).
    if (isCategorised(m)) {
      if (!inCategory(m, wantedBucket)) return false;
    } else if (!wantsAvatar) {
      // Uncategorised row + non-avatar request: the categories rollout
      // is gradual, so we still need to keep these models eligible.
      // BUT we must not let avatar-shaped slugs (ai-avatar, …/avatar)
      // sneak through as generic image-to-video, which is the exact
      // mis-tagging that motivated the categories field in the first
      // place. Slug-pattern check below mirrors the avatar-include
      // logic used in the wantsAvatar branch.
      const slugLooksLikeAvatar = typeof m.slug === 'string'
        && /(?:^|[\/\-_])ai[-_]?avatar(?:$|[\/\-_])|(?:^|\/)avatar(?:$|\/)/i.test(m.slug);
      if (slugLooksLikeAvatar) return false;
    }

    if (wantsAvatar) {
      // Categorised avatar model already passed the gate above. For
      // uncategorised rows fall back to the legacy signals: explicit
      // op tag, dedicated flag, or unambiguous slug pattern.
      if (!isCategorised(m)) {
        const hasOp = Array.isArray(m.operations) && m.operations.includes('avatar');
        const slugLooksLikeAvatar = typeof m.slug === 'string'
          && /(?:^|[\/\-_])ai[-_]?avatar(?:$|[\/\-_])|(?:^|\/)avatar(?:$|\/)/i.test(m.slug);
        if (!m.avatar && !hasOp && !slugLooksLikeAvatar) return false;
      }
      // Avatar models bypass the regular video-mode gates — return early.
      return true;
    }

    // At least one video generation capability.
    const videoCap = m.textToVideo || m.imageToVideo || m.videoToVideo;
    if (!videoCap) return false;

    if (wantsVideoToVideo) {
      // Reference videos → the model must explicitly advertise v2v.
      // Frame / ref-image requirements on top still apply.
      if (!m.videoToVideo) return false;
    } else if (wantsImageToVideo) {
      if (!m.imageToVideo) return false;
    } else {
      // Text-to-video request: reject pure videoToVideo specialists
      // (extend-video, video-to-video restyle, lipsync, …) that don't do
      // text-to-video on their own.
      if (!m.textToVideo) return false;
    }
    if (wantsFrameControl && !m.frameControl) return false;
    if (req.withAudio && !m.hasAudio) return false;
    if (wantsMultishot) {
      const cap = typeof m.maxShots === 'number' ? m.maxShots : 1;
      if (cap < shotCount) return false;
    }
    return true;
  });

  let eligible = _filterVideo(/* useLabel */ true);
  let labelDropped = false;
  if (eligible.length === 0 && wantLabel) {
    eligible = _filterVideo(/* useLabel */ false);
    labelDropped = eligible.length > 0;
  }
  if (labelDropped) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[media-router] No video model carries label="${wantLabel}" matching the requested operation (` +
        `${wantsVideoToVideo ? 'v2v' : wantsImageToVideo ? 'i2v' : 't2v'}) — falling back to non-labelled models.`,
      );
    } catch { /* logging is best-effort */ }
  }

  if (eligible.length === 0) {
    // Per-model rejection reason, so the agent (and logs) can see why a
    // model that "looks" compatible was filtered out. Mirrors the filter
    // block above: first matching rule wins.
    const rejections = models.map((m) => {
      const reasons = [];
      if (m.pricePerUnit == null) reasons.push('pricePerUnit=null');
      if (wantLabel) {
        if (!_modelHasLabel(m, wantLabel)) {
          reasons.push(`label!=${wantLabel}`);
        }
      } else if (modelHasLabels(m)) {
        reasons.push(`has labels=[${_labelSlugs(m).join(',')}] but request has none`);
      }
      const videoCap = m.textToVideo || m.imageToVideo || m.videoToVideo;
      if (!videoCap) reasons.push('no video capability');
      if (wantsVideoToVideo && !m.videoToVideo) reasons.push('videoToVideo=false');
      else if (!wantsVideoToVideo && wantsImageToVideo && !m.imageToVideo) reasons.push('imageToVideo=false');
      else if (!wantsVideoToVideo && !wantsImageToVideo && !m.textToVideo) reasons.push('textToVideo=false (pure v2v specialist)');
      if (wantsFrameControl && !m.frameControl) reasons.push('frameControl=false');
      if (req.withAudio && !m.hasAudio) reasons.push('hasAudio=false');
      if (wantsMultishot) {
        const cap = typeof m.maxShots === 'number' ? m.maxShots : 1;
        if (cap < shotCount) reasons.push(`maxShots=${cap}<${shotCount}`);
      }
      return { slug: m.slug, videoToVideo: !!m.videoToVideo, textToVideo: !!m.textToVideo, imageToVideo: !!m.imageToVideo, labels: _labelSlugs(m), reasons };
    });
    throw new MediaModelRoutingError(
      'No active video model matches the requested capabilities',
      {
        requirements: req,
        candidates: models.length,
        rejections,
        alternatives: _diagnoseVideo(models, req),
      },
    );
  }
  _rankSort(eligible, req);
  return eligible[0].slug;
}

// ── Audio ───────────────────────────────────────────────────────────────────

/**
 * @param {Array<object>} models — /gateway/models/audio.json rows
 * @param {object} req
 * @param {'tts'|'transcribe'|'music'|'sfx'|'voice-clone'} req.kind — what the caller wants to do
 * @param {string} [req.label]
 */
export function pickAudioModel(models, req = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new MediaModelRoutingError('No active audio models available', { requirements: req });
  }

  const kind = req.kind || 'tts';

  // Koi-owned purpose buckets (see model_prices.categories) — same
  // contract as pickImageModel / pickVideoModel: when a row declares
  // categories, that's the authoritative signal; uncategorised rows
  // fall back to the legacy boolean flags during the gradual backfill.
  const modelCategories = (m) => Array.isArray(m.categories) ? m.categories : [];
  const isCategorised = (m) => modelCategories(m).length > 0;
  const wantedBucket = (
    kind === 'tts'         ? 'tts' :
    kind === 'transcribe'  ? 'audio_transcription' :
    kind === 'voice-clone' ? 'voice_clone' :
    kind === 'music'       ? 'music' :
    kind === 'sfx'         ? 'sfx' :
    null
  );

  const eligible = models.filter((m) => {
    if (m.pricePerUnit == null) return false;

    // Curated category gate — short-circuits the legacy boolean checks
    // for any row that's been tagged in the backoffice. Categorised
    // rows must declare the bucket; uncategorised rows fall through
    // to the legacy flag/operation checks below.
    if (isCategorised(m)) {
      if (wantedBucket) return modelCategories(m).includes(wantedBucket);
    }

    if (kind === 'tts'        && !m.tts) return false;
    if (kind === 'transcribe' && !m.transcribe) return false;
    if (kind === 'music'      && !m.music) return false;
    if (kind === 'sfx'        && !m.sfx) return false;
    // voice-clone: model row must advertise it via either a dedicated
    // boolean (m.voiceClone) OR by carrying 'voice-clone' in operations[].
    // The boolean route mirrors tts/transcribe; the operations route lets
    // us tag fal models without adding a column for every new capability.
    if (kind === 'voice-clone') {
      const hasOp = Array.isArray(m.operations) && m.operations.includes('voice-clone');
      if (!m.voiceClone && !hasOp) return false;
    }
    return true;
  });

  _throwIfEmpty(eligible, 'audio', req, models.length);
  _rankSort(eligible, req);
  return eligible[0].slug;
}
