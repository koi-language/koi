/**
 * Gemini provider implementations: LLM (OpenAI-compatible API) and Embeddings.
 * Gemini does not offer a search-augmented model via the OpenAI-compatible API.
 */

import { BaseLLM, BaseEmbedding, ProviderBlockedError } from './base.js';
import { channel } from '../../io/channel.js';

/**
 * Gemini REST error → ProviderBlockedError. Gemini surfaces policy refusals
 * three different ways depending on endpoint:
 *
 *   1. Generative API via OpenAI-compat: 400 with "safety" in the message,
 *      or finish_reason === 'SAFETY' / 'PROHIBITED_CONTENT'.
 *   2. Native REST (image/video): body contains `promptFeedback.blockReason`
 *      or `candidates[0].finishReason === 'SAFETY'`.
 *   3. HTTP errors with status 400/429/403 where the body mentions safety.
 *
 * This helper accepts EITHER a raw Error (from SDK) or a parsed JSON body
 * (from native REST) and returns a ProviderBlockedError when applicable.
 */
function _classifyGeminiError(errOrBody) {
  if (!errOrBody) return null;
  // SDK error path
  if (errOrBody instanceof Error) {
    const err = errOrBody;
    const status = err?.status || err?.statusCode || 0;
    const reason = err?.message || 'Unknown provider error';
    if (/safety|harm|blocked|sexually explicit|dangerous/i.test(reason)) {
      return new ProviderBlockedError({ blockType: 'provider_policy', provider: 'gemini', reason });
    }
    if (status === 429 || /quota|rate/i.test(reason)) {
      return new ProviderBlockedError({
        blockType: /quota/i.test(reason) ? 'quota' : 'rate_limit',
        provider: 'gemini', reason,
      });
    }
    if (status === 401 || status === 403) {
      return new ProviderBlockedError({ blockType: 'auth', provider: 'gemini', reason });
    }
    return null;
  }
  // Native REST body path
  const body = errOrBody;
  const blockReason = body?.promptFeedback?.blockReason
    || body?.candidates?.[0]?.finishReason;
  if (blockReason && /SAFETY|PROHIBITED|BLOCKED/i.test(blockReason)) {
    return new ProviderBlockedError({
      blockType: 'provider_policy', provider: 'gemini',
      reason: `Gemini safety system blocked the request (${blockReason})`,
    });
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini LLM (via OpenAI-compatible API)
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiLLM extends BaseLLM {
  get providerName() { return 'gemini'; }

  // ── Explicit context caching for Gemini direct API ──────────────────────
  // Creates a CachedContent resource via the Gemini REST API and references
  // it in subsequent calls via extra_body.google.cached_content.
  // Only used when talking directly to generativelanguage.googleapis.com
  // (not via gateway/OpenRouter which has its own caching mechanism).

  // ── Cache pool: Map<fingerprint, { name, expiresAt }> ──
  // Multiple agents/playbooks can have different system prompts running
  // concurrently. Each gets its own CachedContent resource, keyed by fingerprint.
  /** @type {Map<string, { name: string, expiresAt: number }>} */
  _cachePool = new Map();

  /**
   * Create or reuse a Gemini CachedContent for the system prompt.
   * Returns the cache name to pass via extra_body, or null if caching is unavailable.
   */
  async _ensureCache(messages) {
    // Only for direct Gemini API (not gateway/OpenRouter)
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !this.caps.supportsCaching) return null;
    // Don't cache if going through gateway (baseURL won't be generativelanguage)
    const baseURL = this.client?.baseURL || '';
    if (!baseURL.includes('generativelanguage.googleapis.com')) return null;

    // Extract system prompt text
    const sysMsg = messages.find(m => m.role === 'system');
    if (!sysMsg) return null;
    const sysText = typeof sysMsg.content === 'string'
      ? sysMsg.content
      : Array.isArray(sysMsg.content)
        ? sysMsg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
        : '';

    // Minimum ~1024 tokens (~4096 chars) for caching to be worthwhile
    if (sysText.length < 4096) return null;

    // Fingerprint: first+last 200 chars + length (fast, detects prompt changes)
    const fp = sysText.slice(0, 200) + sysText.slice(-200) + ':' + sysText.length;

    // Reuse existing cache if still valid
    const existing = this._cachePool.get(fp);
    if (existing && Date.now() < existing.expiresAt) {
      return existing.name;
    }

    // Evict expired entries
    for (const [k, v] of this._cachePool) {
      if (Date.now() >= v.expiresAt) this._cachePool.delete(k);
    }

    // Create new cache
    try {
      const ttlSeconds = 3600; // 1 hour
      const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: `models/${this.model}`,
          systemInstruction: { parts: [{ text: sysText }] },
          contents: [],
          ttl: `${ttlSeconds}s`,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        channel.log('llm', `[gemini-cache] Create failed (${res.status}): ${errBody.slice(0, 200)}`);
        return null;
      }

      const data = await res.json();
      this._cachePool.set(fp, { name: data.name, expiresAt: Date.now() + (ttlSeconds - 60) * 1000 });
      channel.log('llm', `[gemini-cache] Created: ${data.name} (TTL ${ttlSeconds}s, pool size: ${this._cachePool.size})`);
      return data.name;
    } catch (err) {
      channel.log('llm', `[gemini-cache] Create error: ${err.message}`);
      return null;
    }
  }

  async streamReactive(messages, opts = {}) {
    const { abortSignal, onChunk, onHeartbeat } = opts;
    this._logStart();

    // Try to use explicit context caching for the system prompt
    const cacheName = await this._ensureCache(messages);

    // When using cached content, remove system message from messages
    // (it's already in the cache — sending it again wastes tokens)
    const effectiveMessages = cacheName
      ? messages.filter(m => m.role !== 'system')
      : messages;

    // Note: stream_options not supported by Gemini's OpenAI-compatible API
    const geminiParams = this._cleanParams({
      model: this.model,
      messages: effectiveMessages,
      stream: true
    });

    // Reference cached content via extra_body
    if (cacheName) {
      geminiParams.extra_body = {
        ...(geminiParams.extra_body || {}),
        google: { cached_content: cacheName },
      };
    }

    // Note: thinking_config/thinking_budget is intentionally NOT sent.
    // It causes 400 errors on many Gemini models and the performance
    // difference is minimal. Models think briefly by default — acceptable.

    let buffer = '';
    let usage = { input: 0, output: 0 };
    let outChars = 0;
    let _thinkChars = 0;

    const _doStream = async (params) => {
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.chat.completions.create(params, options);
      const race = this._abortRace(abortSignal);

      const _iterate = async () => {
        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
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
              cachedInput: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
            };
          }
        }
      };

      if (race) await Promise.race([_iterate(), race]);
      else await _iterate();
    };

    // Disable internal "dynamic" thinking whenever we don't explicitly
    // want it — otherwise Gemini 3.x Pro goes silent for multiple
    // MINUTES burning internal reasoning tokens before emitting
    // anything visible (the "85 chars in 8s vs 1067 chars in 3m20s"
    // gap on near-identical calls). Send BOTH the Gemini-native param
    // (`thinking_config` in extra_body.google — picked up by the direct
    // API and by our koi-gateway) AND the OpenRouter-standard top-level
    // `reasoning` param — so however the client is wired (direct, koi-
    // gateway, OpenRouter via gateway), at least one of them hits and
    // reasoning stays at 0. 400-on-unknown-field is caught by the
    // fallback below.
    if (this.caps.thinking && !this.useThinking) {
      geminiParams.extra_body = {
        ...(geminiParams.extra_body || {}),
        thinking_config: { thinking_budget: 0 },
        google: {
          ...((geminiParams.extra_body || {}).google || {}),
          thinking_config: { thinking_budget: 0 },
        },
      };
      // OpenRouter-compatible top-level reasoning control. Most
      // reasoning-capable models accept `reasoning: { max_tokens: 0 }`;
      // a few only accept `enabled: false`. Send both keys — they're
      // additive and providers ignore unknown ones.
      geminiParams.reasoning = {
        max_tokens: 0,
        enabled: false,
        exclude: true,
      };
      channel.log('llm', `[gemini] reasoning disable requested (thinking_budget=0, reasoning.max_tokens=0)`);
    }

    try {
      await _doStream(geminiParams);
    } catch (err) {
      // Policy/quota/auth errors jump out — don't try the thinking_config
      // fallback on those since the request itself is what's blocked.
      const blocked = _classifyGeminiError(err);
      if (blocked) { this._logFail(err.message); throw blocked; }
      // Fallback: if 400 with extra_body, retry without it
      if (geminiParams.extra_body && String(err.status || err.message).includes('400')) {
        channel.log('llm', `${this.model}: 400 with thinking_config — retrying without`);
        delete geminiParams.extra_body;
        buffer = ''; outChars = 0; _thinkChars = 0;
        try {
          await _doStream(geminiParams);
        } catch (retryErr) {
          const blocked2 = _classifyGeminiError(retryErr);
          if (blocked2) { this._logFail(retryErr.message); throw blocked2; }
          this._logFail(retryErr.message);
          throw retryErr;
        }
      } else {
        this._logFail(err.message);
        throw err;
      }
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
    // Diagnostic: when reasoning was supposedly disabled but the model
    // still spent reasoning tokens, say so loudly. The gateway /
    // OpenRouter / provider can be silently ignoring `thinking_config`
    // and `reasoning:{max_tokens:0}` — if that happens we need to
    // know, not just wait in silence for minutes.
    if (!this.useThinking && (usage.thinking || 0) > 0) {
      channel.log(
        'llm',
        `[gemini] reasoning disable IGNORED — model burned ${usage.thinking} reasoning tokens (out=${usage.output}, baseURL=${this.client?.baseURL || '?'})`,
      );
    } else if (this.useThinking || (usage.thinking || 0) > 0) {
      channel.log(
        'llm',
        `[gemini] usage in=${usage.input} out=${usage.output} thinking=${usage.thinking || 0}`,
      );
    }

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

    // Try cached content for system prompt
    const cacheName = await this._ensureCache(messages);
    const effectiveMessages = cacheName
      ? messages.filter(m => m.role !== 'system')
      : messages;

    try {
      const params = this._cleanParams({
        model: this.model,
        messages: effectiveMessages,
        temperature,
        max_tokens: maxTokens,
        ...(responseFormat && { response_format: responseFormat }),
        ...(cacheName && { extra_body: { google: { cached_content: cacheName } } }),
      });
      const options = controller ? { signal: controller.signal } : {};
      let completion;
      try {
        completion = await this.client.chat.completions.create(params, options);
      } catch (err) {
        const blocked = _classifyGeminiError(err);
        if (blocked) throw blocked;
        throw err;
      }
      if (completion.choices?.[0]?.finish_reason === 'content_filter'
          || completion.choices?.[0]?.finish_reason === 'SAFETY') {
        throw new ProviderBlockedError({
          blockType: 'provider_policy', provider: 'gemini',
          reason: 'Gemini safety filter blocked the response',
        });
      }
      const text = completion.choices[0].message.content?.trim() || '';
      const usage = {
        input: completion.usage?.prompt_tokens || 0,
        output: completion.usage?.completion_tokens || 0,
        thinking: completion.usage?.completion_tokens_details?.reasoning_tokens || 0,
        cachedInput: completion.usage?.prompt_tokens_details?.cached_tokens || 0,
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
