import { channel } from '../../io/channel.js';
/**
 * Base interfaces for the 6 model types: LLM, Embedding, Search,
 * ImageGen, AudioGen, VideoGen.
 *
 * Each provider (OpenAI, Anthropic, Gemini) implements these interfaces
 * with its own proprietary API calls. The common parametrization lives here;
 * each subclass converts it to the provider-specific format.
 */

// ─────────────────────────────────────────────────────────────────────────────
// BaseLLM — Chat / Reasoning / Reactive completions
// ─────────────────────────────────────────────────────────────────────────────

export class BaseLLM {
  /**
   * @param {Object}  client   - Provider SDK client (OpenAI instance, Anthropic instance, etc.)
   * @param {string}  model    - Model identifier (e.g. 'gpt-4o-mini', 'claude-sonnet-4-6')
   * @param {Object}  [opts]
   * @param {number}  [opts.temperature=0]
   * @param {number}  [opts.maxTokens=8192]
   * @param {Object}  [opts.caps]   - Model capabilities from getModelCaps()
   * @param {boolean} [opts.useThinking=false]
   */
  constructor(client, model, opts = {}) {
    if (new.target === BaseLLM) throw new Error('BaseLLM is abstract — use a provider subclass');
    this.client = client;
    this.model = model;
    this.temperature = opts.temperature ?? 0;
    // Caller's maxTokens wins if explicitly set (e.g. callUtility with 150 tokens).
    // Otherwise use 1/4 of model's max output (floor 8K, capped at model max).
    const _modelMax = opts.caps?.maxOutputTokens || 0;
    const _perModel = _modelMax ? Math.max(Math.min(8000, _modelMax), Math.floor(_modelMax / 4)) : 0;
    this.maxTokens = opts.maxTokens || _perModel || 8192;
    this.caps = opts.caps || {};
    this.useThinking = opts.useThinking ?? false;
  }

  /** Provider name for logging. Override in subclass. */
  get providerName() { return 'unknown'; }

  /**
   * Streaming reactive call for the agent loop.
   * Returns the full response text + token usage after streaming completes.
   *
   * @param {Array<{role: string, content: string|Array}>} messages
   * @param {Object}        opts
   * @param {AbortSignal}   [opts.abortSignal]
   * @param {Function}      [opts.onChunk]     - (delta: string, estOutputTokens: number) => void
   * @param {Function}      [opts.onHeartbeat] - (thinkingTokens: number) => void
   * @returns {Promise<{text: string, usage: {input: number, output: number, thinking?: number}}>}
   */
  async streamReactive(messages, opts = {}) {
    throw new Error(`${this.constructor.name}.streamReactive() not implemented`);
  }

  /**
   * Simple (non-streaming) completion.
   * Used by callJSON, callSummary, callUtility, simpleChat, executePlanning, etc.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object}  [opts]
   * @param {number}  [opts.maxTokens]
   * @param {number}  [opts.temperature]
   * @param {string}  [opts.responseFormat] - 'json_object' | null
   * @param {number}  [opts.timeoutMs]     - Abort after this many ms (0 = no timeout)
   * @returns {Promise<{text: string, usage: {input: number, output: number}}>}
   */
  async complete(messages, opts = {}) {
    throw new Error(`${this.constructor.name}.complete() not implemented`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Build the abort race pattern common to all streaming providers. */
  _abortRace(abortSignal) {
    if (!abortSignal) return null;
    return new Promise((_, reject) => {
      if (abortSignal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }

  /** Strip unsupported params based on model capabilities (noTemperature, noMaxTokens). */
  _cleanParams(params) {
    const p = { ...params };
    if (this.caps.noTemperature) delete p.temperature;
    if (this.caps.noMaxTokens) {
      // gpt-5.x models require max_completion_tokens instead of max_tokens
      const val = p.max_tokens;
      delete p.max_tokens;
      if (val) p.max_completion_tokens = val;
    }
    return p;
  }

  /** Log HTTP request start/end (delegates to cliLogger). */
  _logStart() { channel.log('llm', `HTTP request starting (streaming)...`); }
  _logEnd(chars) { channel.log('llm', `HTTP request completed (streamed ${chars} chars)`); }
  _logFail(msg) { channel.log('llm', `HTTP request FAILED: ${msg}`); }
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseEmbedding — Vector embeddings for semantic search
// ─────────────────────────────────────────────────────────────────────────────

export class BaseEmbedding {
  /**
   * @param {Object} client - Provider SDK client
   * @param {string} model  - Embedding model identifier
   */
  constructor(client, model) {
    if (new.target === BaseEmbedding) throw new Error('BaseEmbedding is abstract — use a provider subclass');
    this.client = client;
    this.model = model;
  }

  /** Provider name for logging. Override in subclass. */
  get providerName() { return 'unknown'; }

  /**
   * Generate an embedding vector for the given text.
   * @param {string} text
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<number[]>} - Float array (vector)
   */
  async embed(text, opts = {}) {
    throw new Error(`${this.constructor.name}.embed() not implemented`);
  }

  /**
   * Return the dimensionality of vectors this model produces.
   * @returns {number}
   */
  dimension() {
    throw new Error(`${this.constructor.name}.dimension() not implemented`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseSearch — Search-augmented models (web search, grounding)
// ─────────────────────────────────────────────────────────────────────────────

export class BaseSearch {
  /**
   * @param {Object} client - Provider SDK client
   * @param {string} model  - Search model identifier
   */
  constructor(client, model) {
    if (new.target === BaseSearch) throw new Error('BaseSearch is abstract — use a provider subclass');
    this.client = client;
    this.model = model;
  }

  /** Provider name for logging. Override in subclass. */
  get providerName() { return 'unknown'; }

  /**
   * Search-augmented completion: the model searches the web/grounding sources
   * and returns an answer with citations.
   *
   * @param {string} query
   * @param {Object} [opts]
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.maxTokens]
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{text: string, citations?: Array, usage: {input: number, output: number}}>}
   */
  async search(query, opts = {}) {
    throw new Error(`${this.constructor.name}.search() not implemented`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseImageGen — Image generation models (DALL-E, gpt-image, Gemini image)
// ─────────────────────────────────────────────────────────────────────────────
//
// NORMALIZED INTERFACE — All parameters use a standard vocabulary.
// Each provider subclass maps normalized values to provider-specific formats.
//
//   Aspect ratios: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3' | '21:9'
//   Resolutions:   'low' (≈512px) | 'medium' (≈1024px) | 'high' (≈2048px) | 'ultra' (≈4096px)
//   Quality:       'auto' | 'low' | 'medium' | 'high'
//
//   Reference images: Array<{ data: string|Buffer, mimeType?: string }>
//     Each entry is an image that guides generation (style transfer, subject ref, etc.)
//
// ─────────────────────────────────────────────────────────────────────────────

export class BaseImageGen {
  /**
   * @param {Object} client - Provider SDK client
   * @param {string} model  - Model identifier (e.g. 'gpt-image-1', 'gemini-2.5-flash-image')
   */
  constructor(client, model) {
    if (new.target === BaseImageGen) throw new Error('BaseImageGen is abstract — use a provider subclass');
    this.client = client;
    this.model = model;
  }

  /** Provider name for logging. Override in subclass. */
  get providerName() { return 'unknown'; }

  /**
   * Declare what this model supports. Override in each subclass.
   * Callers can inspect this BEFORE calling generate() to know what's available.
   *
   * @returns {ImageGenCapabilities}
   */
  get capabilities() {
    return {
      referenceImages: false,       // Can accept reference/style images
      maxReferenceImages: 0,        // Max reference images per call
      edit: false,                  // Supports inpainting / image editing
      aspectRatios: ['1:1'],        // Supported normalized aspect ratios
      resolutions: ['medium'],      // Supported normalized resolutions
      qualities: ['auto'],          // Supported quality levels
      maxN: 1,                      // Max images per request
      outputFormats: ['png'],       // Supported output formats
    };
  }

  /**
   * Generate an image from a text prompt.
   *
   * All parameters are NORMALIZED — the subclass maps them to provider format.
   *
   * @param {string} prompt - Text description of the desired image
   * @param {Object} [opts]
   * @param {Array<{data: string|Buffer, mimeType?: string}>} [opts.referenceImages] - Style/subject reference images
   * @param {string} [opts.aspectRatio='1:1']   - '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3' | '21:9'
   * @param {string} [opts.resolution='medium'] - 'low' | 'medium' | 'high' | 'ultra'
   * @param {string} [opts.quality='auto']      - 'auto' | 'low' | 'medium' | 'high'
   * @param {number} [opts.n=1]                 - Number of images to generate
   * @param {string} [opts.outputFormat='png']  - 'png' | 'webp' | 'jpeg' | 'b64_json'
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{ images: Array<{ url?: string, b64?: string, revisedPrompt?: string }>, usage?: { input: number, output: number } }>}
   */
  async generate(prompt, opts = {}) {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }

  /**
   * Edit/inpaint an existing image based on a prompt and optional mask.
   *
   * @param {string}       prompt - Text description of the edit
   * @param {Buffer|string} image - Image data (base64 string or Buffer)
   * @param {Object} [opts]
   * @param {Buffer|string} [opts.mask] - Mask indicating areas to edit
   * @param {Array<{data: string|Buffer, mimeType?: string}>} [opts.referenceImages]
   * @param {string} [opts.aspectRatio='1:1']
   * @param {string} [opts.resolution='medium']
   * @param {number} [opts.n=1]
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{ images: Array<{ url?: string, b64?: string, revisedPrompt?: string }>, usage?: { input: number, output: number } }>}
   */
  async edit(prompt, image, opts = {}) {
    throw new Error(`${this.constructor.name}.edit() not implemented`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseAudioGen — Audio generation / text-to-speech models
// ─────────────────────────────────────────────────────────────────────────────

export class BaseAudioGen {
  /**
   * @param {Object} client - Provider SDK client
   * @param {string} model  - Model identifier (e.g. 'tts-1', 'gpt-audio')
   */
  constructor(client, model) {
    if (new.target === BaseAudioGen) throw new Error('BaseAudioGen is abstract — use a provider subclass');
    this.client = client;
    this.model = model;
  }

  /** Provider name for logging. Override in subclass. */
  get providerName() { return 'unknown'; }

  /**
   * Generate speech audio from text.
   *
   * @param {string} text - Text to convert to speech
   * @param {Object} [opts]
   * @param {string} [opts.voice]        - Voice identifier (e.g. 'alloy', 'echo', 'nova')
   * @param {string} [opts.outputFormat] - 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
   * @param {number} [opts.speed]        - Speed multiplier (0.25 to 4.0, default 1.0)
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{ audio: Buffer, format: string, usage?: { characters: number } }>}
   */
  async speech(text, opts = {}) {
    throw new Error(`${this.constructor.name}.speech() not implemented`);
  }

  /**
   * Transcribe audio to text (speech-to-text).
   *
   * @param {Buffer|ReadableStream} audio - Audio data
   * @param {Object} [opts]
   * @param {string} [opts.language]   - ISO-639-1 language code
   * @param {string} [opts.format]     - 'json' | 'text' | 'srt' | 'vtt'
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{ text: string, segments?: Array, usage?: { duration: number } }>}
   */
  async transcribe(audio, opts = {}) {
    throw new Error(`${this.constructor.name}.transcribe() not implemented`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseVideoGen — Video generation models (Sora, Veo, Kling, Seedance, etc.)
// ─────────────────────────────────────────────────────────────────────────────
//
// NORMALIZED INTERFACE — All parameters use a standard vocabulary.
// Each provider subclass maps normalized values to provider-specific formats.
//
//   Start/end frames: { data: string|Buffer, mimeType?: string }
//   Reference images: Array<{ data: string|Buffer, mimeType?: string }>
//   Duration:     number (seconds)
//   Aspect ratio: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3' | '21:9'
//   Resolution:   '360p' | '480p' | '720p' | '1080p' | '2k' | '4k'
//   Quality:      'auto' | 'low' | 'medium' | 'high'
//   With audio:   boolean — whether the video includes generated audio
//
// ─────────────────────────────────────────────────────────────────────────────

export class BaseVideoGen {
  /**
   * @param {Object} client - Provider SDK client
   * @param {string} model  - Model identifier (e.g. 'sora', 'kling-v3', 'veo-2.0-generate-001')
   */
  constructor(client, model) {
    if (new.target === BaseVideoGen) throw new Error('BaseVideoGen is abstract — use a provider subclass');
    this.client = client;
    this.model = model;
  }

  /** Provider name for logging. Override in subclass. */
  get providerName() { return 'unknown'; }

  /**
   * Declare what this model supports. Override in each subclass.
   * Callers can inspect this BEFORE calling generate() to know what's available.
   *
   * @returns {VideoGenCapabilities}
   */
  get capabilities() {
    return {
      startFrame: false,            // Accepts a first-frame image
      endFrame: false,              // Accepts a last-frame image
      referenceImages: false,       // Accepts reference/style images
      maxReferenceImages: 0,        // Max reference images per call
      withAudio: false,             // Can generate audio track alongside video
      aspectRatios: ['16:9'],       // Supported normalized aspect ratios
      resolutions: ['720p'],        // Supported normalized resolutions
      qualities: ['auto'],          // Supported quality levels
      durations: [5],               // Supported durations in seconds (e.g. [5, 10])
      maxDuration: 5,               // Max duration in seconds
    };
  }

  /**
   * Generate a video from a text prompt.
   *
   * All parameters are NORMALIZED — the subclass maps them to provider format.
   *
   * @param {string} prompt - Text description of the desired video
   * @param {Object} [opts]
   * @param {{data: string|Buffer, mimeType?: string}}  [opts.startFrame]      - First frame image
   * @param {{data: string|Buffer, mimeType?: string}}  [opts.endFrame]        - Last frame image
   * @param {Array<{data: string|Buffer, mimeType?: string}>} [opts.referenceImages] - Style/subject reference images
   * @param {number}  [opts.duration=5]            - Duration in seconds
   * @param {string}  [opts.aspectRatio='16:9']    - '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3' | '21:9'
   * @param {string}  [opts.resolution='720p']     - '360p' | '480p' | '720p' | '1080p' | '2k' | '4k'
   * @param {string}  [opts.quality='auto']        - 'auto' | 'low' | 'medium' | 'high'
   * @param {boolean} [opts.withAudio=false]        - Generate audio track
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{ id: string, status: string, url?: string, usage?: { durationSec: number } }>}
   */
  async generate(prompt, opts = {}) {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }

  /**
   * Check the status of a video generation job (video gen is often async).
   *
   * @param {string} jobId - Job/task identifier returned by generate()
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.abortSignal]
   * @returns {Promise<{ id: string, status: 'pending'|'processing'|'completed'|'failed', url?: string, error?: string }>}
   */
  async getStatus(jobId, opts = {}) {
    throw new Error(`${this.constructor.name}.getStatus() not implemented`);
  }
}
