/**
 * Gemini provider implementations: LLM (OpenAI-compatible API) and Embeddings.
 * Gemini does not offer a search-augmented model via the OpenAI-compatible API.
 */

import { BaseLLM, BaseEmbedding, BaseImageGen, BaseVideoGen } from './base.js';
import { channel } from '../../io/channel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gemini LLM (via OpenAI-compatible API)
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiLLM extends BaseLLM {
  get providerName() { return 'gemini'; }

  async streamReactive(messages, opts = {}) {
    const { abortSignal, onChunk, onHeartbeat } = opts;
    this._logStart();

    // Note: stream_options not supported by Gemini's OpenAI-compatible API
    const geminiParams = this._cleanParams({
      model: this.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: true
    });

    // Disable extended thinking unless explicitly selected.
    // Thinking generates internal reasoning tokens before the first response,
    // causing 10-60s of streaming silence.
    if (this.caps.thinking && !this.useThinking) {
      geminiParams.extra_body = { thinking_config: { thinking_budget: 0 } };
    }

    let buffer = '';
    let usage = { input: 0, output: 0 };
    let outChars = 0;
    let _thinkChars = 0;

    try {
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.chat.completions.create(geminiParams, options);

      const race = this._abortRace(abortSignal);

      const _iterate = async () => {
        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
          // Gemini thinking: count empty-content chunks as ~10 tokens each
          const _gDelta = chunk.choices?.[0]?.delta?.content || '';
          if (!_gDelta && _thinkChars === 0) _thinkChars = 1;
          if (!_gDelta && _thinkChars > 0) _thinkChars += 40;
          onHeartbeat?.(_thinkChars && !_gDelta ? Math.ceil(_thinkChars / 4) : 0);

          if (_gDelta) {
            buffer += _gDelta;
            outChars += _gDelta.length;
            onChunk?.(_gDelta, Math.ceil(outChars / 4));
            if (buffer.trimEnd().endsWith('}')) {
              try { JSON.parse(buffer.trim()); break; } catch {}
            }
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens || 0,
              output: chunk.usage.completion_tokens || 0,
              thinking: chunk.usage.completion_tokens_details?.reasoning_tokens || 0,
            };
          }
        }
      };

      if (race) await Promise.race([_iterate(), race]);
      else await _iterate();
    } catch (err) {
      this._logFail(err.message);
      throw err;
    }

    if (usage.output === 0 && outChars > 0) usage.output = Math.ceil(outChars / 4);
    // Estimate input tokens when streaming break cut off the usage chunk
    if (usage.input === 0 && messages.length > 0) {
      const inputChars = messages.reduce((sum, m) => {
        const c = m.content;
        if (typeof c === 'string') return sum + c.length;
        if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text || JSON.stringify(p)).length, 0);
        return sum;
      }, 0);
      usage.input = Math.ceil(inputChars / 4);
    }
    if (!usage.thinking && _thinkChars > 0) usage.thinking = Math.ceil(_thinkChars / 4);
    this._logEnd(outChars);

    const text = buffer.trim();
    if (!text) throw new Error('Gemini returned no content');
    if (text.startsWith('{') || text.startsWith('[')) {
      try { JSON.parse(text); } catch {
        throw new Error(`Gemini returned truncated response (${text.length} chars): ${text.substring(0, 80)}...`);
      }
    }
    return { text, usage };
  }

  async complete(messages, opts = {}) {
    const maxTokens = opts.maxTokens ?? this.maxTokens;
    const temperature = opts.temperature ?? this.temperature;
    const responseFormat = opts.responseFormat ? { type: opts.responseFormat } : undefined;
    const timeoutMs = opts.timeoutMs || 0;

    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const params = this._cleanParams({
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(responseFormat && { response_format: responseFormat })
      });
      const options = controller ? { signal: controller.signal } : {};
      const completion = await this.client.chat.completions.create(params, options);
      const text = completion.choices[0].message.content?.trim() || '';
      const usage = {
        input: completion.usage?.prompt_tokens || 0,
        output: completion.usage?.completion_tokens || 0,
        thinking: completion.usage?.completion_tokens_details?.reasoning_tokens || 0,
      };
      return { text, usage };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Embeddings (via OpenAI-compatible API)
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiEmbedding extends BaseEmbedding {
  constructor(client, model = 'text-embedding-004') {
    super(client, model);
  }

  get providerName() { return 'gemini'; }

  dimension() { return 768; }

  async embed(text, opts = {}) {
    const _t0 = Date.now();
    const _baseURL = this.client?.baseURL || 'unknown';
    try {
      const response = await this.client.embeddings.create(
        { model: this.model, input: text.trim() },
        opts.abortSignal ? { signal: opts.abortSignal } : {}
      );
      const _elapsed = Date.now() - _t0;
      if (_elapsed > 3000) {
        channel.log('embedding', `Gemini embed slow: ${_elapsed}ms, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}`);
      }
      return response.data[0].embedding;
    } catch (err) {
      const _elapsed = Date.now() - _t0;
      channel.log('embedding', `Gemini embed error after ${_elapsed}ms: ${err.message}, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}, status=${err.status || 'n/a'}`);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Image Generation (gemini-2.5-flash-image, gemini-3-pro-image)
// Uses the Gemini native REST API (not OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiImageGen extends BaseImageGen {
  constructor(client, model = 'gemini-2.5-flash-image') {
    super(client, model);
  }

  get providerName() { return 'gemini'; }

  get capabilities() {
    return {
      referenceImages: true,         // Gemini accepts inline image parts for style reference
      maxReferenceImages: 4,
      edit: false,                   // No dedicated edit endpoint
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
      resolutions: ['medium', 'high'],
      qualities: ['auto'],
      maxN: 1,
      outputFormats: ['png', 'jpeg'],
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '1:1';
    const resolution = opts.resolution || 'medium';

    channel.log('image', `Gemini image generate: model=${this.model}, aspect=${aspectRatio}, res=${resolution}`);
    const _t0 = Date.now();

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

      // Build content parts: reference images first, then text prompt
      const parts = [];

      // Reference images as inline image parts
      if (opts.referenceImages?.length) {
        for (const ref of opts.referenceImages) {
          const imgData = typeof ref.data === 'string'
            ? ref.data
            : ref.data.toString('base64');
          parts.push({
            inlineData: {
              mimeType: ref.mimeType || 'image/png',
              data: imgData,
            },
          });
        }
      }

      parts.push({ text: prompt });

      const body = {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          // Map normalized aspect ratio to Gemini's aspectRatio param
          ...(aspectRatio !== '1:1' && { aspectRatio }),
        },
      };

      const fetchOpts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      };
      if (opts.abortSignal) fetchOpts.signal = opts.abortSignal;

      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Gemini image API error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      const _elapsed = Date.now() - _t0;
      channel.log('image', `Gemini image generate completed in ${_elapsed}ms`);

      const images = [];
      const resParts = data.candidates?.[0]?.content?.parts || [];
      for (const part of resParts) {
        if (part.inlineData) {
          images.push({
            b64: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png',
          });
        }
      }

      return {
        images,
        usage: {
          input: data.usageMetadata?.promptTokenCount || 0,
          output: data.usageMetadata?.candidatesTokenCount || 0,
        },
      };
    } catch (err) {
      channel.log('image', `Gemini image generate FAILED: ${err.message}`);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Video Generation (Veo)
// Uses the official Gemini API (generativelanguage.googleapis.com)
//
// Docs: https://ai.google.dev/gemini-api/docs/video
//
// Auth:    x-goog-api-key header (NOT query param)
// Create:  POST /v1beta/models/{model}:predictLongRunning
// Poll:    GET  /v1beta/{operation_name}
//
// Request: { instances: [{ prompt, image?, lastFrame?, referenceImages? }],
//            parameters: { aspectRatio, durationSeconds (STRING), resolution, numberOfVideos } }
//
// Response (create): { name: "models/.../operations/..." }
// Response (poll):   { done: true, response: { generateVideoResponse:
//                      { generatedSamples: [{ video: { uri: "..." } }] } } }
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiVideoGen extends BaseVideoGen {
  constructor(client, model = 'veo-3.1-generate-preview') {
    super(client, model);
  }

  get providerName() { return 'gemini'; }

  get capabilities() {
    const isV31 = this.model.includes('3.1');
    const isV3Plus = isV31 || this.model.includes('3.0');
    return {
      startFrame: true,
      endFrame: isV3Plus,                        // Veo 3+ supports lastFrame interpolation
      referenceImages: isV31,                    // Veo 3.1 only: up to 3 refs (asset/style)
      maxReferenceImages: isV31 ? 3 : 0,
      withAudio: false,                          // generateAudio is Vertex AI only, not Gemini API
      aspectRatios: ['16:9', '9:16'],            // Veo only supports these two
      resolutions: isV31 ? ['720p', '1080p', '4k'] : ['720p', '1080p'],
      qualities: ['auto'],
      durations: isV3Plus ? [4, 6, 8] : [5, 8],
      maxDuration: 8,
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '16:9';
    const duration = opts.duration || 8;
    const resolution = opts.resolution || '720p';
    const caps = this.capabilities;

    channel.log('video', `Veo generate: model=${this.model}, aspect=${aspectRatio}, duration=${duration}s, res=${resolution}`);
    const _t0 = Date.now();

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('Veo requires GEMINI_API_KEY environment variable');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:predictLongRunning`;

      const instance = { prompt };

      // Start frame → image field (inlineData format per official docs)
      if (opts.startFrame?.data) {
        const imgData = typeof opts.startFrame.data === 'string'
          ? opts.startFrame.data
          : opts.startFrame.data.toString('base64');
        instance.image = {
          inlineData: {
            mimeType: opts.startFrame.mimeType || 'image/png',
            data: imgData,
          },
        };
      }

      // End frame → lastFrame field (Veo 3+, inlineData format)
      if (opts.endFrame?.data && caps.endFrame) {
        const imgData = typeof opts.endFrame.data === 'string'
          ? opts.endFrame.data
          : opts.endFrame.data.toString('base64');
        instance.lastFrame = {
          inlineData: {
            mimeType: opts.endFrame.mimeType || 'image/png',
            data: imgData,
          },
        };
      }

      // Reference images → referenceImages[] (Veo 3.1, inlineData format)
      if (opts.referenceImages?.length && caps.referenceImages) {
        instance.referenceImages = opts.referenceImages.slice(0, caps.maxReferenceImages).map(ref => {
          const data = typeof ref.data === 'string'
            ? ref.data
            : ref.data.toString('base64');
          return {
            image: {
              inlineData: {
                mimeType: ref.mimeType || 'image/png',
                data,
              },
            },
            referenceType: ref.referenceType || 'asset',
          };
        });
      }

      // durationSeconds MUST be a string in the Gemini API
      const parameters = {
        aspectRatio,
        durationSeconds: String(duration),
        resolution,
        numberOfVideos: 1,
        personGeneration: 'allow_all',
      };

      const body = { instances: [instance], parameters };

      const fetchOpts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      };
      if (opts.abortSignal) fetchOpts.signal = opts.abortSignal;

      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Veo API error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      const _elapsed = Date.now() - _t0;
      channel.log('video', `Veo generate submitted in ${_elapsed}ms: ${data.name}`);

      return {
        id: data.name || 'unknown',
        status: data.done ? 'completed' : 'pending',
        url: data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || undefined,
        usage: { durationSec: duration },
      };
    } catch (err) {
      channel.log('video', `Veo generate FAILED: ${err.message}`);
      throw err;
    }
  }

  async getStatus(jobId, opts = {}) {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('Veo requires GEMINI_API_KEY environment variable');

      // Poll: GET /v1beta/{operation_name} with x-goog-api-key header
      const url = `https://generativelanguage.googleapis.com/v1beta/${jobId}`;

      const fetchOpts = {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey },
      };
      if (opts.abortSignal) fetchOpts.signal = opts.abortSignal;

      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Veo status error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      const videoUrl = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;

      return {
        id: jobId,
        status: data.done ? 'completed' : 'processing',
        url: videoUrl || undefined,
        error: data.error?.message || undefined,
      };
    } catch (err) {
      channel.log('video', `Veo status FAILED: ${err.message}`);
      throw err;
    }
  }
}
