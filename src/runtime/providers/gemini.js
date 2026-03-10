/**
 * Gemini provider implementations: LLM (OpenAI-compatible API) and Embeddings.
 * Gemini does not offer a search-augmented model via the OpenAI-compatible API.
 */

import { BaseLLM, BaseEmbedding } from './base.js';
import { cliLogger } from '../cli-logger.js';

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

    try {
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.chat.completions.create(geminiParams, options);

      const race = this._abortRace(abortSignal);
      let _thinkChars = 0;

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
              output: chunk.usage.completion_tokens || 0
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
    this._logEnd(outChars);

    const text = buffer.trim();
    if (!text) throw new Error('Gemini returned no content');
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
        output: completion.usage?.completion_tokens || 0
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
        cliLogger.log('embedding', `Gemini embed slow: ${_elapsed}ms, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}`);
      }
      return response.data[0].embedding;
    } catch (err) {
      const _elapsed = Date.now() - _t0;
      cliLogger.log('embedding', `Gemini embed error after ${_elapsed}ms: ${err.message}, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}, status=${err.status || 'n/a'}`);
      throw err;
    }
  }
}
