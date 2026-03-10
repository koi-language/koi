/**
 * Base interfaces for the 3 model types: LLM, Embedding, Search.
 *
 * Each provider (OpenAI, Anthropic, Gemini) implements these interfaces
 * with its own proprietary API calls. The common parametrization lives here;
 * each subclass converts it to the provider-specific format.
 */

import { cliLogger } from '../cli-logger.js';

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
    this.maxTokens = opts.maxTokens ?? 8192;
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
  _logStart() { cliLogger.log('llm', `HTTP request starting (streaming)...`); }
  _logEnd(chars) { cliLogger.log('llm', `HTTP request completed (streamed ${chars} chars)`); }
  _logFail(msg) { cliLogger.log('llm', `HTTP request FAILED: ${msg}`); }
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
