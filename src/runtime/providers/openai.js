/**
 * OpenAI provider implementations: Chat Completions LLM, Responses API LLM,
 * Embeddings, and Search.
 */

import { BaseLLM, BaseEmbedding, BaseSearch } from './base.js';
import { getModelCaps } from '../cost-center.js';
import { cliLogger } from '../cli-logger.js';

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

    try {
      const params = this._cleanParams({
        model: this.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true }
      });
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.chat.completions.create(params, options);

      const race = this._abortRace(abortSignal);
      let _thinkChars = 0;

      const _iterate = async () => {
        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
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
    if (!text) throw new Error('OpenAI returned no content');
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
// OpenAI Responses API LLM (codex / reasoning models)
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIResponsesLLM extends BaseLLM {
  get providerName() { return 'openai'; }

  async streamReactive(messages, opts = {}) {
    const { abortSignal, onChunk, onHeartbeat } = opts;

    // Responses API: system → instructions, user/assistant → input
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    let inputMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

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

      let _thinkChars = 0;
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
              output: event.response.usage.output_tokens || 0
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
    if (!text) throw new Error('OpenAI Responses API returned no content');
    return { text, usage };
  }

  async complete(messages, opts = {}) {
    // Responses API models can also use Chat Completions for simple calls
    // Delegate to the chat path since complete() doesn't need reasoning
    const chatLLM = new OpenAIChatLLM(this.client, this.model, {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      caps: this.caps,
    });
    return chatLLM.complete(messages, opts);
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
        cliLogger.log('embedding', `OpenAI embed slow: ${_elapsed}ms, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}`);
      }
      return response.data[0].embedding;
    } catch (err) {
      const _elapsed = Date.now() - _t0;
      cliLogger.log('embedding', `OpenAI embed error after ${_elapsed}ms: ${err.message}, baseURL=${_baseURL}, model=${this.model}, inputLen=${text.length}, status=${err.status || 'n/a'}`);
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
      max_tokens: maxTokens,
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
