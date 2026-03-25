/**
 * Gateway providers — used when the user is authenticated via a koi-cli.ai account.
 *
 * All calls are routed through the koi-cli.ai backend gateway, which proxies
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

// ── Gateway base URL ─────────────────────────────────────────────────────────

function getGatewayBase() {
  return (process.env.KOI_API_URL || 'http://localhost:3000') + '/gateway';
}

function getAuthHeaders() {
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

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway embedding error (${res.status}): ${body}`);
    }

    const data = await res.json();
    // OpenAI-compatible response: { data: [{ embedding: [...] }] }
    return data.data?.[0]?.embedding || data.embedding || [];
  }

  /**
   * Batch embed multiple texts in chunks to avoid rate limits.
   */
  async embedBatch(texts, opts = {}) {
    if (!texts.length) return [];
    if (texts.length === 1) return [await this.embed(texts[0], opts)];

    const CHUNK_SIZE = 10;
    const CHUNK_PAUSE = 500;
    const RETRY_WAIT = 15_000;
    const MAX_RETRIES = 2;

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

        if (res.status === 429 && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_WAIT));
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
    const payload = {
      model: this.model,
      prompt,
      n: opts.n || 1,
      aspect_ratio: opts.aspectRatio || '1:1',
      resolution: opts.resolution || 'medium',
      quality: opts.quality || 'auto',
      output_format: opts.outputFormat || 'png',
    };

    if (opts.referenceImages?.length) {
      payload.reference_images = opts.referenceImages.map(ref => ({
        data: typeof ref.data === 'string' ? ref.data : ref.data.toString('base64'),
        mime_type: ref.mimeType || 'image/png',
      }));
    }

    const res = await fetch(`${getGatewayBase()}/media/image/generate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway image error (${res.status}): ${body}`);
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
    const res = await fetch(`${getGatewayBase()}/media/audio/speech`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: opts.voice || 'alloy',
        response_format: opts.outputFormat || 'mp3',
        speed: opts.speed || 1.0,
      }),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway audio error (${res.status}): ${body}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { audio: buffer, format: opts.outputFormat || 'mp3', usage: { characters: text.length } };
  }

  async transcribe(audio, opts = {}) {
    const res = await fetch(`${getGatewayBase()}/media/audio/transcribe`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: 'whisper-1',
        language: opts.language,
        response_format: opts.format || 'json',
      }),
      signal: opts.abortSignal,
    });

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
    const payload = {
      model: this.model,
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
