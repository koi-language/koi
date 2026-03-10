/**
 * Anthropic provider implementations: LLM (Messages API).
 * Anthropic does not offer embedding or search-augmented models.
 */

import { BaseLLM } from './base.js';

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

    try {
      const options = abortSignal ? { signal: abortSignal } : {};
      const stream = await this.client.messages.create(createParams, options);
      const race = this._abortRace(abortSignal);

      let _thinkChars = 0;
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
    if (!text) throw new Error('Anthropic returned no content');
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

    const message = await this.client.messages.create(params);
    const text = (message.content.find(b => b.type === 'text')?.text ?? '').trim();
    const usage = {
      input: message.usage?.input_tokens || 0,
      output: message.usage?.output_tokens || 0
    };
    return { text, usage };
  }
}
