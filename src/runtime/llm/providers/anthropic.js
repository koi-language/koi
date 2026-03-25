/**
 * Anthropic provider implementations: LLM (Messages API) + Web Search.
 */

import { BaseLLM, BaseSearch } from './base.js';
import { channel } from '../../io/channel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API LLM
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicLLM extends BaseLLM {
  get providerName() { return 'anthropic'; }

  async streamReactive(messages, opts = {}) {
    const { abortSignal, onChunk, onHeartbeat } = opts;

    // Anthropic needs system prompt separate from messages
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    // Append JSON-only reminder to last user message (Anthropic tends to add preamble)
    const lastUserIdx = chatMessages.map(m => m.role).lastIndexOf('user');
    const _jsonReminder = '\n\nRespond with ONLY a valid JSON object. No text, no explanation, no preamble. Start with {';
    const messagesWithReminder = chatMessages.map((m, i) => {
      if (i !== lastUserIdx) return m;
      if (Array.isArray(m.content)) {
        const hasText = m.content.some(p => p.type === 'text');
        if (hasText) return { ...m, content: m.content.map(p => p.type === 'text' ? { ...p, text: p.text + _jsonReminder } : p) };
        return { ...m, content: [...m.content, { type: 'text', text: _jsonReminder }] };
      }
      return { ...m, content: m.content + _jsonReminder };
    });

    this._logStart();

    const createParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: messagesWithReminder,
      stream: true
    };
    if (this.caps.thinking && this.useThinking) {
      // Extended thinking: remove temperature (unsupported) and add thinking config
      delete createParams.temperature;
      createParams.thinking = { type: 'enabled', budget_tokens: 5000 };
      createParams.max_tokens = 16000; // thinking tokens count toward max_tokens
    }

    let buffer = '';
    let usage = { input: 0, output: 0 };
    let outChars = 0;
    let _thinkChars = 0;

    try {
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.messages.create(createParams, options);
      const race = this._abortRace(abortSignal);
      const _iterate = async () => {
        for await (const event of stream) {
          if (abortSignal?.aborted) break;
          // Track thinking tokens
          if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
            _thinkChars += (event.delta.thinking || '').length;
          }
          onHeartbeat?.(_thinkChars ? Math.ceil(_thinkChars / 4) : 0);

          if (event.type === 'message_start') {
            usage.input = event.message?.usage?.input_tokens || 0;
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const delta = event.delta.text || '';
            if (delta) {
              buffer += delta;
              outChars += delta.length;
              onChunk?.(delta, Math.ceil(outChars / 4));
              if (buffer.trimEnd().endsWith('}')) {
                try { JSON.parse(buffer.trim()); break; } catch {}
              }
            }
          } else if (event.type === 'message_delta') {
            usage.output = event.usage?.output_tokens || 0;
            if (event.delta?.stop_reason === 'max_tokens') {
              channel.log('llm', `[anthropic] Response hit max_tokens limit (${this.maxTokens}), output truncated at ${outChars} chars`);
            }
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
    // Anthropic includes thinking tokens in output_tokens; estimate from chars if thinking was used
    if (_thinkChars > 0 && !usage.thinking) usage.thinking = Math.ceil(_thinkChars / 4);
    this._logEnd(outChars);

    const text = buffer.trim();
    if (!text) throw new Error('Anthropic returned no content');
    if (text.startsWith('{') || text.startsWith('[')) {
      try { JSON.parse(text); } catch {
        throw new Error(`Anthropic returned truncated response (${text.length} chars): ${text.substring(0, 80)}...`);
      }
    }
    return { text, usage };
  }

  async complete(messages, opts = {}) {
    const maxTokens = opts.maxTokens ?? this.maxTokens;
    const temperature = opts.temperature ?? this.temperature;

    // Extract system from messages
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    const params = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: chatMessages,
    };
    if (systemMsg) params.system = systemMsg.content;

    // Anthropic requires streaming for high max_tokens (10min timeout).
    // Use streaming transparently to avoid the error.
    if (maxTokens > 4096) {
      params.stream = true;
      let buffer = '';
      const usage = { input: 0, output: 0, thinking: 0 };
      const stream = await this.client.messages.create(params);
      for await (const event of stream) {
        if (event.type === 'message_start') {
          usage.input = event.message?.usage?.input_tokens || 0;
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          buffer += event.delta.text || '';
        } else if (event.type === 'message_delta') {
          usage.output = event.usage?.output_tokens || 0;
        }
      }
      if (usage.output === 0 && buffer.length > 0) usage.output = Math.ceil(buffer.length / 4);
      return { text: buffer.trim(), usage };
    }

    const message = await this.client.messages.create(params);
    const text = (message.content.find(b => b.type === 'text')?.text ?? '').trim();
    const usage = {
      input: message.usage?.input_tokens || 0,
      output: message.usage?.output_tokens || 0,
      thinking: 0,
    };
    const thinkingBlocks = message.content.filter(b => b.type === 'thinking');
    if (thinkingBlocks.length > 0) {
      const thinkChars = thinkingBlocks.reduce((sum, b) => sum + (b.thinking || '').length, 0);
      if (thinkChars > 0) usage.thinking = Math.ceil(thinkChars / 4);
    }
    return { text, usage };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Web Search (server-side tool via Messages API)
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicSearch extends BaseSearch {
  /**
   * @param {Object} client - Anthropic SDK client
   * @param {string} [model] - Model to use for search (default: claude-sonnet-4-20250514)
   */
  constructor(client, model = 'claude-sonnet-4-20250514') {
    super(client, model);
  }

  get providerName() { return 'anthropic'; }

  async search(query, opts = {}) {
    const count = Math.min(opts.count || 5, 10);

    const params = {
      model: this.model,
      max_tokens: 1024,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: count,
      }],
      messages: [{ role: 'user', content: query }],
    };

    const message = await this.client.messages.create(params);

    // Extract search results from tool_use content blocks
    const results = [];
    for (const block of message.content) {
      if (block.type === 'web_search_tool_result') {
        for (const sr of (block.content || [])) {
          if (sr.type === 'web_search_result') {
            results.push({
              title: sr.title || '',
              url: sr.url || '',
              snippet: sr.encrypted_content ? '(encrypted)' : (sr.page_content || ''),
            });
          }
        }
      }
    }

    // Also grab any text summary Claude produced
    const textBlocks = message.content.filter(b => b.type === 'text');
    const summary = textBlocks.map(b => b.text).join('\n').trim();

    const text = summary ||
      results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');

    const usage = {
      input: message.usage?.input_tokens || 0,
      output: message.usage?.output_tokens || 0,
    };

    return { text, results, usage };
  }
}
