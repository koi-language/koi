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
 *   - image: canGenerate|canEdit, maxImages, maxRefImages, CSV resolutions /
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

const _csvSupports = (csv, requested) => {
  if (!requested) return true;
  if (!csv) return true;
  return csv.split(',').map((s) => s.trim().toLowerCase()).includes(String(requested).trim().toLowerCase());
};

const _rankSort = (eligible, req) => {
  const wantLabel = req.label || null;
  const rankOf = (m) => {
    const labelRank = wantLabel
      ? (Array.isArray(m.labels) && m.labels.includes(wantLabel) ? 0 : 1)
      : 0;
    const fallbackRank = m.isFallback ? 0 : 1;
    const priceRank = m.pricePerUnit ?? Number.POSITIVE_INFINITY;
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
  canGenerate: !!m.canGenerate,
  canEdit: !!m.canEdit,
  maxImages: m.maxImages ?? null,
  maxRefImages: m.maxRefImages ?? null,
  resolutions: m.resolutions || '',
  aspectRatios: m.aspectRatios || '',
});

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
  const wantsEdit = refsCount > 0;

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
  if (wantsEdit) {
    out[`refsCount=${refsCount}`] = models
      .filter((m) => m.canEdit && m.maxRefImages != null
        && (m.maxRefImages === 0 || refsCount <= m.maxRefImages))
      .map(_imageCard);
  } else {
    out['canGenerate'] = models.filter((m) => m.canGenerate).map(_imageCard);
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
  const wantsEdit = refsCount > 0;
  const wantsOperation = typeof req.operation === 'string' && req.operation.trim()
    ? req.operation.trim()
    : null;

  const eligible = models.filter((m) => {
    if (m.pricePerUnit == null) return false;
    // Structured operation filter — the model must explicitly advertise it.
    // Intentionally strict: if the model has no `operations` array at all we
    // reject it. Mixing "unknown" with "supports everything" would silently
    // route BG-removal requests to models that only do raw generation.
    if (wantsOperation) {
      if (!Array.isArray(m.operations) || !m.operations.includes(wantsOperation)) return false;
      // Operation-scoped routing short-circuits the coarse generate/edit
      // gates. A BG-removal model doesn't need to declare canEdit=true or
      // populate maxRefImages — the presence of operations[] is the
      // authoritative signal. Resolution/aspect are typically not
      // meaningful for these transforms either (output mirrors input).
      return true;
    }
    if (wantsEdit && !m.canEdit) return false;
    if (!wantsEdit && !m.canGenerate) return false;
    if (m.maxImages != null && n > m.maxImages) return false;
    if (wantsEdit) {
      if (m.maxRefImages == null) return false;
      if (m.maxRefImages > 0 && refsCount > m.maxRefImages) return false;
    }
    if (!_csvSupports(m.resolutions, req.resolution)) return false;
    if (!_csvSupports(m.aspectRatios, req.aspectRatio)) return false;
    return true;
  });

  if (eligible.length === 0) {
    throw new MediaModelRoutingError(
      `No active image model matches every requested capability at once`,
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

/**
 * @param {Array<object>} models — /gateway/models/video.json rows
 * @param {object} req
 * @param {string} [req.resolution]
 * @param {string} [req.aspectRatio]
 * @param {boolean} [req.hasStartFrame]
 * @param {boolean} [req.hasEndFrame]
 * @param {boolean} [req.withAudio]
 * @param {number}  [req.refsCount=0]
 * @param {string}  [req.label]
 */
export function pickVideoModel(models, req = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new MediaModelRoutingError('No active video models available', { requirements: req });
  }

  const refsCount = req.refsCount || 0;
  const wantsFrameControl = !!(req.hasStartFrame || req.hasEndFrame);

  const eligible = models.filter((m) => {
    if (m.pricePerUnit == null) return false;
    // At least one video generation capability.
    const videoCap = m.textToVideo || m.imageToVideo || m.videoToVideo;
    if (!videoCap) return false;
    // If caller is supplying reference frames/images, the model must accept them.
    if (refsCount > 0 && !m.imageToVideo && !m.videoToVideo) return false;
    // Start/end frame control is a hard requirement when the caller uses it.
    if (wantsFrameControl && !m.frameControl) return false;
    // Audio track generation is a hard requirement when withAudio=true.
    if (req.withAudio && !m.hasAudio) return false;
    if (!_csvSupports(m.resolutions, req.resolution)) return false;
    if (!_csvSupports(m.aspectRatios, req.aspectRatio)) return false;
    return true;
  });

  _throwIfEmpty(eligible, 'video', req, models.length);
  _rankSort(eligible, req);
  return eligible[0].slug;
}

// ── Audio ───────────────────────────────────────────────────────────────────

/**
 * @param {Array<object>} models — /gateway/models/audio.json rows
 * @param {object} req
 * @param {'tts'|'transcribe'|'music'|'sfx'} req.kind — what the caller wants to do
 * @param {string} [req.label]
 */
export function pickAudioModel(models, req = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new MediaModelRoutingError('No active audio models available', { requirements: req });
  }

  const kind = req.kind || 'tts';
  const eligible = models.filter((m) => {
    if (m.pricePerUnit == null) return false;
    if (kind === 'tts'        && !m.tts) return false;
    if (kind === 'transcribe' && !m.transcribe) return false;
    if (kind === 'music'      && !m.music) return false;
    if (kind === 'sfx'        && !m.sfx) return false;
    return true;
  });

  _throwIfEmpty(eligible, 'audio', req, models.length);
  _rankSort(eligible, req);
  return eligible[0].slug;
}
