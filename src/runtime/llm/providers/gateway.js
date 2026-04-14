/**
 * Gateway providers — used when the user is authenticated via a braxil.ai account.
 *
 * All calls are routed through the braxil.ai backend gateway, which proxies
 * to the actual providers server-side (OpenAI, Gemini, Kling, Seedance, etc.).
 *
 * The gateway exposes a UNIFIED API inspired by fal.ai's pattern:
 *
 *   LLM:       POST /gateway/chat/completions          (OpenAI-compatible)
 *   Embedding: POST /gateway/embeddings                 (OpenAI-compatible)
 *   Search:    POST /gateway/search
 *
 *   Image:     POST /gateway/media/image/generate       (sync — returns images)
 *   Audio TTS: POST /gateway/media/audio/speech         (sync — returns audio buffer)
 *   Audio STT: POST /gateway/media/audio/transcribe     (sync — returns text)
 *   Video:     POST /gateway/media/video/generate       (async — returns job ID)
 *   Video:     GET  /gateway/media/video/status/:id     (poll job status)
 *
 * The gateway accepts ANY model from ANY provider — the backend routes it.
 * Capabilities are resolved dynamically from models.json mediaCaps.
 */

import { BaseEmbedding, BaseSearch, BaseImageGen, BaseAudioGen, BaseVideoGen } from './base.js';
import { lookupModel } from '../cost-center.js';
import { parseQuotaExceededResponse } from '../quota-exceeded-error.js';

/**
 * Throw a QuotaExceededError if the response is HTTP 402. Callers should
 * `await throwIfQuotaExceeded(res)` immediately after `fetch()` so that the
 * no-credits case short-circuits any per-endpoint error handling below.
 */
async function throwIfQuotaExceeded(res) {
  if (res.status === 402) {
    throw await parseQuotaExceededResponse(res);
  }
}

// ── Gateway base URL ─────────────────────────────────────────────────────────

export function getGatewayBase() {
  return (process.env.KOI_API_URL || 'http://localhost:3000') + '/gateway';
}

export function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${process.env.KOI_AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ── Shared: resolve mediaCaps from models.json ──────────────────────────────

function _getMediaCaps(model) {
  const info = lookupModel(model);
  return info?.mediaCaps || null;
}

// ── Dynamic media capabilities from the backend models list ────────────────
//
// Source of truth: GET /gateway/models/{image,video,audio}.json — the
// authoritative list of currently active media models from the backend DB.
// We fetch once per process per kind, take the DISTINCT union of the
// capability columns, and expose a single blob the runtime tools use to
// build dynamic schemas so the agent only ever sees values the backend can
// actually serve (no phantom aspect ratios, no phantom resolutions, no
// phantom labels).
//
// Design intent (important):
//   - Labels are a RANKING preference, not a filter. A model without the
//     label is still eligible, it just ranks lower.
//   - Any parameter (label, resolution, aspectRatio, n, refs, withAudio…)
//     is surfaced to the agent ONLY when at least one active model in the
//     set supports it. Empty → omit from the schema entirely.
//
// Returns null on any failure (offline, unauth, 5xx). Callers treat that
// as "unknown, fall back to static defaults".

const _mediaCapabilitiesPromises = { image: null, video: null, audio: null };

const _splitCsv = (s) => {
  if (typeof s !== 'string') return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
};

function _collectCommon(models) {
  const labelSet = new Set();
  const resolutionSet = new Set();
  const aspectRatioSet = new Set();
  for (const m of models) {
    if (Array.isArray(m?.labels)) {
      for (const l of m.labels) {
        if (typeof l === 'string' && l.trim()) labelSet.add(l.trim());
      }
    }
    for (const r of _splitCsv(m?.resolutions)) resolutionSet.add(r);
    for (const a of _splitCsv(m?.aspectRatios)) aspectRatioSet.add(a);
  }
  return {
    labels:       [...labelSet].sort(),
    resolutions:  [...resolutionSet],
    aspectRatios: [...aspectRatioSet],
  };
}

function _aggregateImage(models) {
  const common = _collectCommon(models);
  let anyCanGenerate = false;
  let anyCanEdit = false;
  let maxImages = 0;
  let maxRefImages = 0;
  let hasRefImageSupport = false;
  for (const m of models) {
    if (m?.canGenerate) anyCanGenerate = true;
    if (m?.canEdit) anyCanEdit = true;
    if (typeof m?.maxImages === 'number' && m.maxImages > maxImages) {
      maxImages = m.maxImages;
    }
    if (m?.maxRefImages != null) {
      hasRefImageSupport = true;
      if (m.maxRefImages === 0) {
        maxRefImages = Math.max(maxRefImages, 16);
      } else if (typeof m.maxRefImages === 'number' && m.maxRefImages > maxRefImages) {
        maxRefImages = m.maxRefImages;
      }
    }
  }
  return {
    models,
    ...common,
    anyCanGenerate,
    anyCanEdit,
    maxImages: maxImages || 1,
    hasRefImageSupport,
    maxRefImages,
  };
}

function _aggregateVideo(models) {
  const common = _collectCommon(models);
  let anyTextToVideo = false;
  let anyImageToVideo = false;
  let anyVideoToVideo = false;
  let anyFrameControl = false;
  let anyAudio = false;
  for (const m of models) {
    if (m?.textToVideo) anyTextToVideo = true;
    if (m?.imageToVideo) anyImageToVideo = true;
    if (m?.videoToVideo) anyVideoToVideo = true;
    if (m?.frameControl) anyFrameControl = true;
    if (m?.hasAudio) anyAudio = true;
  }
  return {
    models,
    ...common,
    anyTextToVideo,
    anyImageToVideo,
    anyVideoToVideo,
    anyFrameControl,
    anyAudio,
    hasRefImageSupport: anyImageToVideo || anyVideoToVideo,
  };
}

function _aggregateAudio(models) {
  const common = _collectCommon(models);
  let anyTts = false;
  let anyTranscribe = false;
  let anyMusic = false;
  let anySfx = false;
  let anyVoiceSelect = false;
  for (const m of models) {
    if (m?.tts) anyTts = true;
    if (m?.transcribe) anyTranscribe = true;
    if (m?.music) anyMusic = true;
    if (m?.sfx) anySfx = true;
    if (m?.voiceSelect) anyVoiceSelect = true;
  }
  const kinds = [];
  if (anyTts) kinds.push('tts');
  if (anyTranscribe) kinds.push('transcribe');
  if (anyMusic) kinds.push('music');
  if (anySfx) kinds.push('sfx');
  return {
    models,
    ...common,
    kinds,
    anyTts,
    anyTranscribe,
    anyMusic,
    anySfx,
    anyVoiceSelect,
  };
}

const _aggregateByKind = {
  image: _aggregateImage,
  video: _aggregateVideo,
  audio: _aggregateAudio,
};

/**
 * Fetch + cache the active media models of a given kind plus a union of the
 * user-facing capability signals the runtime tools need to build dynamic
 * schemas. Cached for the process lifetime. Returns null on any failure.
 */
export function fetchMediaCapabilities(kind) {
  if (!_mediaCapabilitiesPromises.hasOwnProperty(kind)) {
    return Promise.resolve(null);
  }
  if (_mediaCapabilitiesPromises[kind]) return _mediaCapabilitiesPromises[kind];
  _mediaCapabilitiesPromises[kind] = (async () => {
    try {
      const res = await fetch(`${getGatewayBase()}/models/${kind}.json`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return null;
      const models = await res.json();
      if (!Array.isArray(models) || models.length === 0) return null;
      return _aggregateByKind[kind](models);
    } catch {
      return null;
    }
  })();
  return _mediaCapabilitiesPromises[kind];
}

// ── Client-side media model resolver ────────────────────────────────────────
//
// Mirrors how text LLMs work: the backend is a dumb proxy that runs whatever
// slug the client sends. Hard filters + soft ranking live in the runtime
// (see media-model-router.js), fed by the live /gateway/models/{kind}.json
// list. When the caller provides an explicit slug we trust it verbatim and
// skip the router.

function _toNoMatchError(routingErr) {
  const err = new Error(routingErr.message);
  err.details = { code: 'no_model_matches', ...(routingErr.details || {}) };
  return err;
}

async function _resolveMediaModel(kind, explicit, opts, pickFn, req) {
  if (explicit && explicit !== 'auto') return explicit;
  const caps = await fetchMediaCapabilities(kind);
  if (!caps || !Array.isArray(caps.models) || caps.models.length === 0) {
    const err = new Error(`No active ${kind} models available from the backend`);
    err.details = { code: 'no_model_matches', requirements: req };
    throw err;
  }
  return await pickFn(caps.models, req);
}

// ── GatewayEmbedding ─────────────────────────────────────────────────────────

export class GatewayEmbedding extends BaseEmbedding {
  constructor() {
    // Pass dummy client/model — we use fetch directly
    super({ _gateway: true }, 'text-embedding-3-small');
    this._dim = 1536;
  }

  get providerName() { return 'koi-gateway'; }

  dimension() { return this._dim; }

  async embed(text, opts = {}) {
    const res = await fetch(`${getGatewayBase()}/embeddings`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        input: text,
        model: this.model,
      }),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway embedding error (${res.status}): ${body}`);
    }

    const data = await res.json();
    // OpenAI-compatible response: { data: [{ embedding: [...] }] }
    return data.data?.[0]?.embedding || data.embedding || [];
  }

  /**
   * Batch embed multiple texts in chunks to respect rate limits.
   * Sends chunks of CHUNK_SIZE with pauses between them.
   * On 429, respects the server's Retry-After header (or waits 60s).
   */
  async embedBatch(texts, opts = {}) {
    if (!texts.length) return [];
    if (texts.length === 1) return [await this.embed(texts[0], opts)];

    const CHUNK_SIZE = 20;
    const CHUNK_PAUSE = 1000;
    const MAX_RETRIES = 4;

    const allVectors = [];
    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CHUNK_SIZE);
      if (i > 0) await new Promise(r => setTimeout(r, CHUNK_PAUSE));

      let vectors;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(`${getGatewayBase()}/embeddings`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ input: chunk, model: this.model }),
          signal: opts.abortSignal,
        });

        if (res.ok) {
          const data = await res.json();
          const sorted = (data.data || []).sort((a, b) => a.index - b.index);
          vectors = sorted.map(d => d.embedding);
          break;
        }

        // 402 = no credits — abort the whole batch loop immediately.
        await throwIfQuotaExceeded(res);

        if (res.status === 429 && attempt < MAX_RETRIES) {
          // Respect Retry-After header; default to 60s (gateway says "retry in 1 minute")
          const retryAfter = parseInt(res.headers.get('retry-after'), 10);
          const wait = (retryAfter > 0 ? retryAfter : 60) * 1000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        const body = await res.text().catch(() => '');
        throw new Error(`Gateway embedding error (${res.status}): ${body}`);
      }

      allVectors.push(...vectors);
    }

    return allVectors;
  }
}

// ── GatewaySearch ────────────────────────────────────────────────────────────

export class GatewaySearch extends BaseSearch {
  constructor() {
    super({ _gateway: true }, 'gateway-search');
  }

  get providerName() { return 'koi-gateway'; }

  async search(query, opts = {}) {
    const res = await fetch(`${getGatewayBase()}/search`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        query,
        count: opts.count || 5,
      }),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway search error (${res.status}): ${body}`);
    }

    const data = await res.json();
    // Backend returns a flat array; wrap in { results } for consistency with other providers
    return { results: Array.isArray(data) ? data : (data.results || []) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GatewayImageGen — Unified image generation via gateway
//
// Accepts ANY image model (gpt-image-1, gemini-3.1-flash-image-preview, etc.)
// The gateway backend routes to the correct provider.
// Capabilities are resolved dynamically from models.json mediaCaps.
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayImageGen extends BaseImageGen {
  constructor(model = 'auto') {
    super({ _gateway: true }, model);
  }

  get providerName() { return 'koi-gateway'; }

  get capabilities() {
    const mc = _getMediaCaps(this.model);
    if (mc) {
      return {
        referenceImages: mc.referenceImages ?? false,
        maxReferenceImages: mc.maxRefImages ?? 0,
        edit: mc.edit ?? false,
        aspectRatios: mc.aspectRatios || ['1:1'],
        resolutions: mc.resolutions || ['medium'],
        qualities: mc.qualities || ['auto'],
        maxN: mc.maxN ?? 1,
        outputFormats: mc.outputFormats || ['png'],
      };
    }
    // Fallback: generous defaults (gateway supports anything the backend does)
    return {
      referenceImages: true,
      maxReferenceImages: 14,
      edit: true,
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'],
      resolutions: ['low', 'medium', 'high', 'ultra'],
      qualities: ['auto', 'low', 'medium', 'high'],
      maxN: 4,
      outputFormats: ['png', 'webp', 'jpeg', 'b64_json'],
    };
  }

  async generate(prompt, opts = {}) {
    const resolvedModel = await _resolveMediaModel('image', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickImageModel, MediaModelRoutingError }) => {
        try {
          return pickImageModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      {
        n: opts.n,
        resolution: opts.resolution,
        aspectRatio: opts.aspectRatio,
        refsCount: opts.referenceImages?.length || 0,
        label: opts.label,
      },
    );

    // Only include fields that the gateway/fal understand — omit undefined/unsupported
    const payload = { model: resolvedModel, prompt };
    if (opts.n && opts.n > 1) payload.num_images = opts.n;
    if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;
    if (opts.outputFormat) payload.output_format = opts.outputFormat;
    // resolution/quality are passed through to the Fal model as-is.
    if (opts.resolution) payload.resolution = opts.resolution;

    if (opts.referenceImages?.length) {
      payload.reference_images = opts.referenceImages.map(ref => ({
        data: typeof ref.data === 'string' ? ref.data : ref.data.toString('base64'),
        mime_type: ref.mimeType || 'image/png',
      }));
    }

    const res = await fetch(`${getGatewayBase()}/fal/generate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      // Preserve structured errors from the backend (e.g. no_model_matches with availableLabels).
      const bodyText = await res.text().catch(() => '');
      let structured = null;
      try { structured = JSON.parse(bodyText); } catch {}
      const err = new Error(
        structured?.error || `Gateway image error (${res.status}): ${bodyText}`,
      );
      err.status = res.status;
      if (structured) err.details = structured;
      throw err;
    }

    const data = await res.json();
    const images = (data.images || data.data || []).map(img => ({
      url: img.url || undefined,
      b64: img.b64 || img.b64_json || undefined,
      revisedPrompt: img.revised_prompt || img.revisedPrompt || undefined,
    }));
    return { images, usage: data.usage || { input: 0, output: 0 } };
  }

  async edit(prompt, image, opts = {}) {
    const imgData = typeof image === 'string' ? image : image.toString('base64');

    const payload = {
      model: this.model,
      prompt,
      image: imgData,
      aspect_ratio: opts.aspectRatio || '1:1',
      resolution: opts.resolution || 'medium',
      n: opts.n || 1,
    };
    if (opts.mask) {
      payload.mask = typeof opts.mask === 'string' ? opts.mask : opts.mask.toString('base64');
    }

    const res = await fetch(`${getGatewayBase()}/media/image/edit`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway image edit error (${res.status}): ${body}`);
    }

    const data = await res.json();
    const images = (data.images || data.data || []).map(img => ({
      url: img.url || undefined,
      b64: img.b64 || img.b64_json || undefined,
      revisedPrompt: img.revised_prompt || img.revisedPrompt || undefined,
    }));
    return { images, usage: data.usage || { input: 0, output: 0 } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GatewayAudioGen — Unified audio generation via gateway
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayAudioGen extends BaseAudioGen {
  constructor(model = 'auto') {
    super({ _gateway: true }, model);
  }

  get providerName() { return 'koi-gateway'; }

  async speech(text, opts = {}) {
    const resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
        try {
          return pickAudioModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      { kind: 'tts', label: opts.label },
    );

    const res = await fetch(`${getGatewayBase()}/media/audio/speech`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: resolvedModel,
        input: text,
        voice: opts.voice || 'alloy',
        response_format: opts.outputFormat || 'mp3',
        speed: opts.speed || 1.0,
      }),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway audio error (${res.status}): ${body}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { audio: buffer, format: opts.outputFormat || 'mp3', usage: { characters: text.length } };
  }

  async transcribe(audio, opts = {}) {
    const resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
        try {
          return pickAudioModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      { kind: 'transcribe', label: opts.label },
    );

    const res = await fetch(`${getGatewayBase()}/media/audio/transcribe`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: resolvedModel,
        language: opts.language,
        response_format: opts.format || 'json',
      }),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway transcribe error (${res.status}): ${body}`);
    }

    const data = await res.json();
    return { text: data.text, segments: data.segments, usage: { duration: data.duration || 0 } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GatewayVideoGen — Unified async video generation via gateway
//
// Accepts ANY video model (sora, kling-v3-0, veo-3.1-generate-preview,
// seedance-2-0-lite, etc.). The gateway backend routes to the correct provider.
// Capabilities are resolved dynamically from models.json mediaCaps.
//
// Async pattern (like fal.ai queue):
//   POST /gateway/media/video/generate → { id, status }
//   GET  /gateway/media/video/status/:id → { id, status, url? }
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayVideoGen extends BaseVideoGen {
  constructor(model = 'auto') {
    super({ _gateway: true }, model);
  }

  get providerName() { return 'koi-gateway'; }

  get capabilities() {
    const mc = _getMediaCaps(this.model);
    if (mc) {
      return {
        startFrame: mc.startFrame ?? false,
        endFrame: mc.endFrame ?? false,
        referenceImages: mc.referenceImages ?? false,
        maxReferenceImages: mc.maxRefImages ?? 0,
        withAudio: mc.withAudio ?? false,
        aspectRatios: mc.aspectRatios || ['16:9'],
        resolutions: mc.resolutions || ['720p'],
        qualities: mc.qualities || ['auto'],
        durations: mc.durations || [5],
        maxDuration: mc.maxDuration ?? 5,
      };
    }
    // Fallback: generous defaults
    return {
      startFrame: true,
      endFrame: true,
      referenceImages: true,
      maxReferenceImages: 4,
      withAudio: true,
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      resolutions: ['480p', '720p', '1080p', '4k'],
      qualities: ['auto', 'low', 'medium', 'high'],
      durations: [4, 5, 6, 8, 10, 15, 20],
      maxDuration: 20,
    };
  }

  async generate(prompt, opts = {}) {
    const resolvedModel = await _resolveMediaModel('video', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickVideoModel, MediaModelRoutingError }) => {
        try {
          return pickVideoModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      {
        resolution: opts.resolution,
        aspectRatio: opts.aspectRatio,
        hasStartFrame: !!opts.startFrame?.data,
        hasEndFrame: !!opts.endFrame?.data,
        withAudio: !!opts.withAudio,
        refsCount: opts.referenceImages?.length || 0,
        label: opts.label,
      },
    );

    const payload = {
      model: resolvedModel,
      prompt,
      aspect_ratio: opts.aspectRatio || '16:9',
      resolution: opts.resolution || '720p',
      duration: opts.duration || 5,
      quality: opts.quality || 'auto',
      with_audio: opts.withAudio || false,
    };

    if (opts.startFrame?.data) {
      payload.start_frame = {
        data: typeof opts.startFrame.data === 'string' ? opts.startFrame.data : opts.startFrame.data.toString('base64'),
        mime_type: opts.startFrame.mimeType || 'image/png',
      };
    }
    if (opts.endFrame?.data) {
      payload.end_frame = {
        data: typeof opts.endFrame.data === 'string' ? opts.endFrame.data : opts.endFrame.data.toString('base64'),
        mime_type: opts.endFrame.mimeType || 'image/png',
      };
    }
    if (opts.referenceImages?.length) {
      payload.reference_images = opts.referenceImages.map(ref => ({
        data: typeof ref.data === 'string' ? ref.data : ref.data.toString('base64'),
        mime_type: ref.mimeType || 'image/png',
      }));
    }

    const res = await fetch(`${getGatewayBase()}/media/video/generate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway video error (${res.status}): ${body}`);
    }

    const data = await res.json();
    return {
      id: data.id || data.request_id || data.name,
      status: _mapGatewayVideoStatus(data.status),
      url: data.url || undefined,
      usage: { durationSec: opts.duration || 5 },
    };
  }

  async getStatus(jobId, opts = {}) {
    const res = await fetch(`${getGatewayBase()}/media/video/status/${jobId}`, {
      method: 'GET',
      headers: getAuthHeaders(),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway video status error (${res.status}): ${body}`);
    }

    const data = await res.json();
    return {
      id: jobId,
      status: _mapGatewayVideoStatus(data.status),
      url: data.url || undefined,
      error: data.error || undefined,
    };
  }
}

/** Map gateway/fal-style statuses to our standard enum. */
function _mapGatewayVideoStatus(status) {
  switch (status) {
    case 'IN_QUEUE':    return 'pending';
    case 'IN_PROGRESS': return 'processing';
    case 'COMPLETED':   return 'completed';
    case 'FAILED':      return 'failed';
    // Also accept our own standard values
    case 'pending':     return 'pending';
    case 'processing':  return 'processing';
    case 'completed':   return 'completed';
    case 'failed':      return 'failed';
    default:            return 'pending';
  }
}
