/**
 * OpenAI provider implementations: Chat Completions LLM, Responses API LLM,
 * Embeddings, and Search.
 */

import { BaseLLM, BaseEmbedding, BaseSearch, BaseImageGen, BaseAudioGen, BaseVideoGen } from './base.js';
import { getModelCaps } from '../cost-center.js';
import { channel } from '../../io/channel.js';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions LLM
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIChatLLM extends BaseLLM {
  get providerName() { return 'openai'; }

  async streamReactive(messages, opts = {}) {
    const { abortSignal, onChunk, onHeartbeat } = opts;
    this._logStart();

    let buffer = '';
    let usage = { input: 0, output: 0 };
    let outChars = 0;
    let _thinkChars = 0;
    let _finishReason = null;

    try {
      const params = this._cleanParams({
        model: this.model,
        messages,
        temperature: 0,
        max_completion_tokens: this.maxTokens,
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true },
        ...(this.caps.thinking && { reasoning_effort: (!this.reasoningEffort || this.reasoningEffort === 'none') ? 'low' : this.reasoningEffort }),
      });
      channel.log('llm', `[request] model=${params.model} max_tokens=${params.max_completion_tokens} reasoning_effort=${params.reasoning_effort ?? '(none)'} thinking=${this.useThinking} temp=${params.temperature}`);
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.chat.completions.create(params, options);

      const race = this._abortRace(abortSignal);

      const _iterate = async () => {
        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
          // Track finish_reason to detect output-length truncation
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) _finishReason = fr;

          // Detect reasoning/thinking content (OpenAI reasoning models)
          const _reasoning = chunk.choices?.[0]?.delta?.reasoning_content
            || chunk.choices?.[0]?.delta?.reasoning || '';
          if (_reasoning) _thinkChars += _reasoning.length;
          onHeartbeat?.(_thinkChars ? Math.ceil(_thinkChars / 4) : 0);

          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta) {
            buffer += delta;
            outChars += delta.length;
            onChunk?.(delta, Math.ceil(outChars / 4));
            if (buffer.trimEnd().endsWith('}')) {
              try { JSON.parse(buffer.trim()); break; } catch {}
            }
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens || 0,
              output: chunk.usage.completion_tokens || 0,
              thinking: chunk.usage.reasoning_tokens
                || chunk.usage.completion_tokens_details?.reasoning_tokens
                || 0,
              cachedInput: chunk.usage.prompt_tokens_details?.cached_tokens
                || chunk.usage.prompt_tokens_details?.cached_input_tokens
                || 0,
            };
          }
        }
      };

      if (race) await Promise.race([_iterate(), race]);
      else await _iterate();
    } catch (err) {
      // If we already accumulated content before the stream broke (e.g.
      // "JSON error injected into SSE stream" from Gemini proxies),
      // try to use what we have instead of failing the whole call.
      if (buffer.trim().length > 10) {
        try {
          JSON.parse(buffer.trim());
          this._log(`Stream error recovered (${buffer.length} chars buffered): ${err.message}`);
        } catch {
          this._logFail(err.message);
          throw err;
        }
      } else {
        this._logFail(err.message);
        throw err;
      }
    }

    if (usage.output === 0 && outChars > 0) usage.output = Math.ceil(outChars / 4);
    // Estimate input tokens from message content when streaming break cut off the usage chunk.
    // This happens when we break early after receiving a complete JSON object — the usage
    // chunk comes after content but we stop reading to save time.
    if (usage.input === 0 && messages.length > 0) {
      const inputChars = messages.reduce((sum, m) => {
        const c = m.content;
        if (typeof c === 'string') return sum + c.length;
        if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text || JSON.stringify(p)).length, 0);
        return sum;
      }, 0);
      usage.input = Math.ceil(inputChars / 4);
    }
    // Fall back to character-based estimate for thinking tokens if provider didn't report them
    if (!usage.thinking && _thinkChars > 0) usage.thinking = Math.ceil(_thinkChars / 4);
    this._logEnd(outChars);

    const text = buffer.trim();
    if (!text) {
      // Build an informative error message to aid debugging and retry logic.
      // Common causes:
      //   1. finish_reason === 'length' — model exhausted all output tokens
      //      on thinking and never emitted a content delta.
      //   2. Gateway timeout / connection reset — finish_reason null.
      //   3. Model errored silently after reasoning.
      const parts = [];
      if (_finishReason === 'length') {
        parts.push(`exhausted max_tokens budget (${this.maxTokens}) on reasoning`);
      } else if (_finishReason) {
        parts.push(`finish_reason=${_finishReason}`);
      } else {
        parts.push('stream ended without content');
      }
      if (_thinkChars > 0) {
        parts.push(`${_thinkChars} reasoning chars consumed`);
      }
      parts.push(`effort=${this.reasoningEffort || 'default'}`);
      throw new Error(`OpenAI returned no content (${parts.join(', ')})`);
    }
    // Validate that the response is complete JSON — if the stream was cut short
    // (connection drop, timeout, or max_tokens hit), the buffer will be truncated.
    // Throwing here lets the agent retry the LLM call instead of failing at parse.
    if (text.startsWith('{') || text.startsWith('[')) {
      try { JSON.parse(text); } catch {
        const reason = _finishReason === 'length'
          ? `output hit max_tokens limit (${this.maxTokens})`
          : _finishReason ? `finish_reason=${_finishReason}` : 'stream ended prematurely';
        throw new Error(`OpenAI returned truncated JSON (${reason}, ${text.length} chars): ${text.substring(0, 80)}...`);
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
        max_completion_tokens: maxTokens,
        ...(responseFormat && { response_format: responseFormat }),
        ...(this.caps.thinking && { reasoning_effort: (!this.reasoningEffort || this.reasoningEffort === 'none') ? 'low' : this.reasoningEffort }),
      });
      channel.log('llm', `[request] model=${params.model} max_tokens=${params.max_completion_tokens || maxTokens} reasoning_effort=${params.reasoning_effort ?? '(none)'} thinking=${this.useThinking} temp=${params.temperature ?? temperature}`);
      const options = controller ? { signal: controller.signal } : {};
      const completion = await this.client.chat.completions.create(params, options);
      const text = completion.choices[0].message.content?.trim() || '';
      const usage = {
        input: completion.usage?.prompt_tokens || 0,
        output: completion.usage?.completion_tokens || 0,
        thinking: completion.usage?.reasoning_tokens
          || completion.usage?.completion_tokens_details?.reasoning_tokens
          || 0,
        cachedInput: completion.usage?.prompt_tokens_details?.cached_tokens
          || completion.usage?.prompt_tokens_details?.cached_input_tokens
          || 0,
      };
      return { text, usage };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Responses API LLM (codex / reasoning models)
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIResponsesLLM extends BaseLLM {
  get providerName() { return 'openai'; }

  // Convert a Chat-Completions-style content part into the Responses API
  // shape. The two APIs disagree on:
  //   - text:  Chat uses { type: 'text', text }         → Responses wants { type: 'input_text', text }
  //   - image: Chat uses { type: 'image_url', image_url: { url } }
  //            → Responses wants { type: 'input_image', image_url: <string> }
  // Without this, passing an array content through unchanged makes OpenRouter
  // reject the call with `"expected string, received array"` on image_url.
  _normalizeContentForResponses(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content;
    return content.map(p => {
      if (!p || typeof p !== 'object') return p;
      if (p.type === 'text') return { type: 'input_text', text: p.text };
      if (p.type === 'input_text' || p.type === 'input_image') return p;
      if (p.type === 'image_url') {
        const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
        return { type: 'input_image', image_url: url };
      }
      if (p.type === 'image' && p.source?.type === 'base64') {
        return {
          type: 'input_image',
          image_url: `data:${p.source.media_type};base64,${p.source.data}`,
        };
      }
      return p;
    });
  }

  async streamReactive(messages, opts = {}) {
    const { abortSignal, onChunk, onHeartbeat } = opts;

    // Responses API: system → instructions, user/assistant → input
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    let inputMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: this._normalizeContentForResponses(m.content) }));

    // Responses API requires "json" in input messages for json_object format
    const lastUserIdx = inputMessages.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx >= 0) {
      const _luc = inputMessages[lastUserIdx].content;
      const _lucText = Array.isArray(_luc)
        ? _luc.filter(p => p.type === 'text').map(p => p.text).join(' ')
        : String(_luc || '');
      if (!_lucText.toLowerCase().includes('json')) {
        const _reminder = '\n\nRespond with a valid JSON object only.';
        inputMessages = inputMessages.map((m, i) => {
          if (i !== lastUserIdx) return m;
          if (Array.isArray(m.content)) {
            const hasText = m.content.some(p => p.type === 'text');
            if (hasText) return { ...m, content: m.content.map(p => p.type === 'text' ? { ...p, text: p.text + _reminder } : p) };
            return { ...m, content: [...m.content, { type: 'text', text: _reminder }] };
          }
          return { ...m, content: m.content + _reminder };
        });
      }
    }

    this._logStart();

    let buffer = '';
    let usage = { input: 0, output: 0 };
    let outChars = 0;
    let _thinkChars = 0;

    try {
      const params = {
        model: this.model,
        instructions: systemPrompt,
        input: inputMessages,
        text: { format: { type: 'json_object' } },
        stream: true
      };
      // Control reasoning effort based on thinking mode
      if (this.caps.thinking && !this.useThinking) {
        params.reasoning = { effort: 'low', summary: 'auto' };
      } else if (this.caps.thinking && this.useThinking) {
        params.reasoning = { effort: 'high', summary: 'auto' };
      }

      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.responses.create(params, options);
      const race = this._abortRace(abortSignal);
      const _iterate = async () => {
        for await (const event of stream) {
          if (abortSignal?.aborted) break;
          // Track reasoning tokens: both actual reasoning and its summary
          if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
            _thinkChars += event.delta.length;
          } else if (event.type === 'response.reasoning.delta' && event.delta) {
            _thinkChars += event.delta.length;
          }
          onHeartbeat?.(_thinkChars ? Math.ceil(_thinkChars / 4) : 0);

          if (event.type === 'response.output_text.delta') {
            const delta = event.delta || '';
            if (delta) {
              buffer += delta;
              outChars += delta.length;
              onChunk?.(delta, Math.ceil(outChars / 4));
              if (buffer.trimEnd().endsWith('}')) {
                try { JSON.parse(buffer.trim()); break; } catch {}
              }
            }
          }
          if (event.type === 'response.completed' && event.response?.usage) {
            usage = {
              input: event.response.usage.input_tokens || 0,
              output: event.response.usage.output_tokens || 0,
              thinking: event.response.usage.reasoning_tokens
                || event.response.usage.output_tokens_details?.reasoning_tokens
                || 0,
              cachedInput: event.response.usage.input_tokens_details?.cached_tokens
                || 0,
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
    // Estimate input tokens when streaming break cut off the usage event
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
    if (!text) throw new Error('OpenAI Responses API returned no content');
    if (text.startsWith('{') || text.startsWith('[')) {
      try { JSON.parse(text); } catch {
        throw new Error(`OpenAI Responses API returned truncated response (${text.length} chars): ${text.substring(0, 80)}...`);
      }
    }
    return { text, usage };
  }

  async complete(messages, opts = {}) {
    // Codex and other Responses-API-only models cannot use Chat Completions
    // (the endpoint returns 404). Use responses.create directly and collect
    // the output into a single text string — mirrors the chat-completions
    // contract (returns { text, usage }) so callers don't need to branch.
    const maxTokens = opts.maxTokens ?? this.maxTokens;
    const responseFormat = opts.responseFormat;
    const timeoutMs = opts.timeoutMs || 0;

    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
      let inputMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: this._normalizeContentForResponses(m.content) }));

      // Responses API requires literal "json" in the last user input when
      // format=json_object. Inject a reminder if the prompt doesn't already
      // mention it — mirrors the streaming path.
      if (responseFormat === 'json_object') {
        const lastUserIdx = inputMessages.map(m => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const _luc = inputMessages[lastUserIdx].content;
          const _lucText = typeof _luc === 'string' ? _luc : String(_luc || '');
          if (!_lucText.toLowerCase().includes('json')) {
            inputMessages[lastUserIdx] = {
              ...inputMessages[lastUserIdx],
              content: _lucText + '\n\nRespond with a valid JSON object only.',
            };
          }
        }
      }

      const params = {
        model: this.model,
        instructions: systemPrompt,
        input: inputMessages,
        max_output_tokens: maxTokens,
      };
      if (responseFormat === 'json_object') {
        params.text = { format: { type: 'json_object' } };
      }
      if (this.caps.thinking) {
        // Honor the configured reasoning effort for these models; default low
        // matches the non-thinking classifier path.
        const effort = (!this.reasoningEffort || this.reasoningEffort === 'none')
          ? 'low'
          : this.reasoningEffort;
        params.reasoning = { effort, summary: 'auto' };
      }

      channel.log('llm', `[request] model=${params.model} max_output_tokens=${params.max_output_tokens} reasoning_effort=${params.reasoning?.effort ?? '(none)'} thinking=${this.useThinking} api=responses`);

      const options = controller ? { signal: controller.signal } : {};
      const response = await this.client.responses.create(params, options);

      // Extract the text output. The Responses API returns an array of
      // output items; we only care about text content.
      let text = '';
      if (response.output_text) {
        text = response.output_text;
      } else if (Array.isArray(response.output)) {
        for (const item of response.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === 'output_text' && c.text) text += c.text;
            }
          }
        }
      }
      text = (text || '').trim();

      const usage = {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
        thinking: response.usage?.reasoning_tokens
          || response.usage?.output_tokens_details?.reasoning_tokens
          || 0,
        cachedInput: response.usage?.input_tokens_details?.cached_tokens || 0,
      };
      return { text, usage };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Embeddings
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIEmbedding extends BaseEmbedding {
  constructor(client, model = 'text-embedding-3-small') {
    super(client, model);
  }

  get providerName() { return 'openai'; }

  dimension() { return 1536; }

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
        channel.log('embedding', `OpenAI embed slow: ${_elapsed}ms, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}`);
      }
      return response.data[0].embedding;
    } catch (err) {
      const _elapsed = Date.now() - _t0;
      channel.log('embedding', `OpenAI embed error after ${_elapsed}ms: ${err.message}, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}, status=${err.status || 'n/a'}`);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Search (gpt-5-search-api, gpt-5.2-search-api, etc.)
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAISearch extends BaseSearch {
  get providerName() { return 'openai'; }

  async search(query, opts = {}) {
    const systemPrompt = opts.systemPrompt || 'You are a helpful research assistant. Search the web and provide accurate, cited answers.';
    const maxTokens = opts.maxTokens || 2000;

    const params = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
      ],
      max_completion_tokens: maxTokens,
    };
    const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
    const completion = await this.client.chat.completions.create(params, options);

    const text = completion.choices[0].message.content?.trim() || '';
    const usage = {
      input: completion.usage?.prompt_tokens || 0,
      output: completion.usage?.completion_tokens || 0
    };
    // OpenAI search models may include annotations/citations in the response
    const citations = completion.choices[0].message?.annotations || [];
    return { text, citations, usage };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Image Generation (gpt-image-1, gpt-image-1.5, dall-e-3, etc.)
// ─────────────────────────────────────────────────────────────────────────────

// Normalized aspect ratio → OpenAI size mapping
const _OPENAI_IMG_ASPECT_MAP = {
  '1:1':  '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '4:3':  '1536x1024',  // closest supported
  '3:4':  '1024x1536',
  '3:2':  '1792x1024',
  '2:3':  '1024x1792',
  '21:9': '1792x1024',
};

// Normalized resolution → OpenAI size multiplier
const _OPENAI_IMG_RES_MAP = {
  'low':    '512x512',
  'medium': '1024x1024',
  'high':   '2048x2048',  // dall-e-3: not available, falls back to 1024
  'ultra':  '4096x4096',
};

function _openaiImageSize(aspectRatio, resolution) {
  // If aspect ratio specified, use it (resolution affects quality param instead)
  if (aspectRatio && _OPENAI_IMG_ASPECT_MAP[aspectRatio]) {
    return _OPENAI_IMG_ASPECT_MAP[aspectRatio];
  }
  // Fallback to resolution-based square
  return _OPENAI_IMG_RES_MAP[resolution] || '1024x1024';
}

export class OpenAIImageGen extends BaseImageGen {
  constructor(client, model = 'gpt-image-1') {
    super(client, model);
  }

  get providerName() { return 'openai'; }

  get capabilities() {
    const isGptImage = this.model.startsWith('gpt-image') || this.model.startsWith('chatgpt-image');
    return {
      referenceImages: isGptImage,    // gpt-image-1+ supports image input for style ref
      maxReferenceImages: isGptImage ? 1 : 0,
      edit: true,
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
      resolutions: ['low', 'medium', 'high'],
      qualities: ['auto', 'low', 'medium', 'high'],
      maxN: isGptImage ? 4 : 1,      // dall-e-3 only supports n=1
      outputFormats: ['png', 'webp', 'jpeg', 'b64_json'],
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '1:1';
    const resolution = opts.resolution || 'medium';
    const size = _openaiImageSize(aspectRatio, resolution);
    const quality = opts.quality || 'auto';
    const n = opts.n || 1;
    const outputFormat = opts.outputFormat || 'b64_json';

    channel.log('image', `OpenAI image generate: model=${this.model}, aspect=${aspectRatio}→size=${size}, quality=${quality}, n=${n}`);
    const _t0 = Date.now();

    try {
      const params = {
        model: this.model,
        prompt,
        n,
        size,
        quality,
      };

      // gpt-image-1+ supports output_format; dall-e-3 uses response_format
      const isGptImage = this.model.startsWith('gpt-image') || this.model.startsWith('chatgpt-image');
      if (isGptImage) {
        params.output_format = outputFormat === 'url' ? 'png' : outputFormat;
      } else {
        params.response_format = outputFormat === 'b64_json' ? 'b64_json' : 'url';
      }

      // Reference images: gpt-image-1+ accepts them as additional image inputs
      if (opts.referenceImages?.length && isGptImage) {
        const ref = opts.referenceImages[0];
        params.image = typeof ref.data === 'string' ? ref.data : ref.data;
      }

      const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
      const response = await this.client.images.generate(params, options);

      const _elapsed = Date.now() - _t0;
      channel.log('image', `OpenAI image generate completed in ${_elapsed}ms`);

      const images = (response.data || []).map(img => ({
        url: img.url || undefined,
        b64: img.b64_json || undefined,
        revisedPrompt: img.revised_prompt || undefined,
      }));

      return {
        images,
        usage: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
        },
      };
    } catch (err) {
      channel.log('image', `OpenAI image generate FAILED: ${err.message}`);
      throw err;
    }
  }

  async edit(prompt, image, opts = {}) {
    const aspectRatio = opts.aspectRatio || '1:1';
    const resolution = opts.resolution || 'medium';
    const size = _openaiImageSize(aspectRatio, resolution);
    const n = opts.n || 1;

    channel.log('image', `OpenAI image edit: model=${this.model}, aspect=${aspectRatio}→size=${size}, n=${n}`);
    const _t0 = Date.now();

    try {
      const params = {
        model: this.model,
        prompt,
        image,
        n,
        size,
      };
      if (opts.mask) params.mask = opts.mask;

      const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
      const response = await this.client.images.edit(params, options);

      const _elapsed = Date.now() - _t0;
      channel.log('image', `OpenAI image edit completed in ${_elapsed}ms`);

      const images = (response.data || []).map(img => ({
        url: img.url || undefined,
        b64: img.b64_json || undefined,
        revisedPrompt: img.revised_prompt || undefined,
      }));

      return {
        images,
        usage: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
        },
      };
    } catch (err) {
      channel.log('image', `OpenAI image edit FAILED: ${err.message}`);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Audio Generation (TTS + STT)
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIAudioGen extends BaseAudioGen {
  constructor(client, model = 'tts-1') {
    super(client, model);
  }

  get providerName() { return 'openai'; }

  async speech(text, opts = {}) {
    const voice = opts.voice || 'alloy';
    const outputFormat = opts.outputFormat || 'mp3';
    const speed = opts.speed || 1.0;

    channel.log('audio', `OpenAI TTS: model=${this.model}, voice=${voice}, format=${outputFormat}, chars=${text.length}`);
    const _t0 = Date.now();

    try {
      const params = {
        model: this.model,
        input: text,
        voice,
        response_format: outputFormat,
        speed,
      };
      const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
      const response = await this.client.audio.speech.create(params, options);

      const buffer = Buffer.from(await response.arrayBuffer());
      const _elapsed = Date.now() - _t0;
      channel.log('audio', `OpenAI TTS completed in ${_elapsed}ms, ${buffer.length} bytes`);

      return {
        audio: buffer,
        format: outputFormat,
        usage: { characters: text.length },
      };
    } catch (err) {
      channel.log('audio', `OpenAI TTS FAILED: ${err.message}`);
      throw err;
    }
  }

  async transcribe(audio, opts = {}) {
    const language = opts.language;
    const format = opts.format || 'json';

    channel.log('audio', `OpenAI STT: model=whisper-1, format=${format}`);
    const _t0 = Date.now();

    try {
      const params = {
        model: 'whisper-1',
        file: audio,
        response_format: format,
      };
      if (language) params.language = language;

      const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
      const response = await this.client.audio.transcriptions.create(params, options);

      const _elapsed = Date.now() - _t0;
      channel.log('audio', `OpenAI STT completed in ${_elapsed}ms`);

      const text = typeof response === 'string' ? response : response.text;
      return {
        text,
        segments: response.segments || undefined,
        usage: { duration: response.duration || 0 },
      };
    } catch (err) {
      channel.log('audio', `OpenAI STT FAILED: ${err.message}`);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Video Generation (Sora)
// ─────────────────────────────────────────────────────────────────────────────

// Normalized aspect ratio → Sora size mapping
const _SORA_ASPECT_MAP = {
  '1:1':  '1080x1080',
  '16:9': '1920x1080',
  '9:16': '1080x1920',
  '4:3':  '1440x1080',
  '3:4':  '1080x1440',
  '3:2':  '1620x1080',
  '2:3':  '1080x1620',
  '21:9': '1920x820',
};

// Normalized resolution → Sora resolution scaling
const _SORA_RES_MAP = {
  '360p':  '640x360',
  '480p':  '854x480',
  '720p':  '1280x720',
  '1080p': '1920x1080',
  '2k':    '1920x1080',
  '4k':    '1920x1080', // Sora max is 1080p
};

function _soraSize(aspectRatio, resolution) {
  if (aspectRatio && _SORA_ASPECT_MAP[aspectRatio]) {
    return _SORA_ASPECT_MAP[aspectRatio];
  }
  return _SORA_RES_MAP[resolution] || '1920x1080';
}

export class OpenAIVideoGen extends BaseVideoGen {
  constructor(client, model = 'sora') {
    super(client, model);
  }

  get providerName() { return 'openai'; }

  get capabilities() {
    return {
      startFrame: true,
      endFrame: false,
      referenceImages: false,
      maxReferenceImages: 0,
      withAudio: false,
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'],
      resolutions: ['480p', '720p', '1080p'],
      qualities: ['auto', 'high'],
      durations: [5, 10, 15, 20],
      maxDuration: 20,
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '16:9';
    const resolution = opts.resolution || '1080p';
    const size = _soraSize(aspectRatio, resolution);
    const duration = opts.duration || 5;

    channel.log('video', `OpenAI video generate: model=${this.model}, aspect=${aspectRatio}→size=${size}, duration=${duration}s`);
    const _t0 = Date.now();

    try {
      const input = [{ type: 'text', text: prompt }];

      // Start frame: send as image input
      if (opts.startFrame?.data) {
        const imgData = typeof opts.startFrame.data === 'string'
          ? opts.startFrame.data
          : opts.startFrame.data.toString('base64');
        const mime = opts.startFrame.mimeType || 'image/png';
        input.unshift({ type: 'image_url', image_url: { url: `data:${mime};base64,${imgData}` } });
      }

      const params = {
        model: this.model,
        input,
        size,
        duration,
        n: 1,
      };
      const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
      const response = await this.client.responses.create(params, options);

      const _elapsed = Date.now() - _t0;
      channel.log('video', `OpenAI video generate submitted in ${_elapsed}ms`);

      return {
        id: response.id,
        status: response.status || 'pending',
        url: response.output?.[0]?.url || undefined,
        usage: { durationSec: duration },
      };
    } catch (err) {
      channel.log('video', `OpenAI video generate FAILED: ${err.message}`);
      throw err;
    }
  }

  async getStatus(jobId, opts = {}) {
    try {
      const options = opts.abortSignal ? { signal: opts.abortSignal } : {};
      const response = await this.client.responses.retrieve(jobId, options);

      return {
        id: response.id,
        status: response.status || 'pending',
        url: response.output?.[0]?.url || undefined,
        error: response.error?.message || undefined,
      };
    } catch (err) {
      channel.log('video', `OpenAI video status FAILED: ${err.message}`);
      throw err;
    }
  }
}
