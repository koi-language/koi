import OpenAI from 'openai';

/**
 * EmbeddingProvider — extracted from LLMProvider.
 *
 * Handles embedding generation (single + batch) with retry/timeout logic
 * and serialization lock for batch requests.
 *
 * Constructor dependencies:
 *   createEmbeddingFn       – creates the embedding adapter (from factory.js)
 *   getEmbeddingDimensionFn – gets dimension for a provider (from factory.js)
 *   logFn                   – function(category, message) for logging (channel.log)
 */
export class EmbeddingProvider {
  constructor({ createEmbeddingFn, getEmbeddingDimensionFn, logFn }) {
    this._createEmbedding = createEmbeddingFn;
    this._getEmbeddingDimension = getEmbeddingDimensionFn;
    this._log = logFn;

    // Lazy-initialized provider instances
    this._gatewayEmbeddingInstance = null;
    this._embeddingClient = null;
    this._embeddingInstance = null;
    this._geminiEmbeddingClient = null;
    this._geminiEmbeddingInstance = null;

    // Serialization lock for batch requests
    this._embeddingBatchLock = null;
  }

  /**
   * Returns the embedding vector dimension for the active embedding provider.
   * OpenAI text-embedding-3-small = 1536, Gemini text-embedding-004 = 768.
   * Used by ContextMemory to initialize LanceDB with the correct schema.
   */
  getEmbeddingDim() {
    if (process.env.KOI_AUTH_TOKEN) return 1536; // gateway uses text-embedding-3-small
    if (process.env.OPENAI_API_KEY) return this._getEmbeddingDimension('openai');
    if (process.env.GEMINI_API_KEY) return this._getEmbeddingDimension('gemini');
    return this._getEmbeddingDimension('openai'); // fallback default
  }

  /**
   * Generate embeddings for semantic search.
   * Priority: OpenAI (text-embedding-3-small, 1536-dim)
   *         → Gemini (text-embedding-004, 768-dim via OpenAI-compat endpoint)
   * Anthropic has no embedding API — throws if only Anthropic key is available.
   */
  async getEmbedding(text) {
    if (!text || typeof text !== 'string' || text.trim() === '') {
      throw new Error('getEmbedding requires non-empty text input');
    }

    const MAX_RETRIES = 2;
    const TIMEOUT_MS = 15000;
    const _provider = process.env.KOI_AUTH_TOKEN ? 'koi-gateway' : process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'none';
    // Fail fast when no credentials are configured — retrying the same 'none'
    // provider with 2s+4s backoff just wastes the startup window while the
    // agent is blocked on memory restore / semantic index warmup.
    if (_provider === 'none') {
      throw new Error('No embedding provider available (need KOI_AUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY)');
    }
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 2000 * attempt; // 2s, 4s
        this._log('memory', `Embedding retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      const ac = new AbortController();
      const _timer = setTimeout(() => ac.abort(new Error('embedding timeout')), TIMEOUT_MS);
      const _t0 = Date.now();
      this._log('memory', `Embedding request: provider=${_provider}, textLen=${text.length}, attempt=${attempt}, preview="${text.substring(0, 80).replace(/\n/g, ' ')}..."`);

      try {
        // Gateway mode: use braxil.ai backend for embeddings
        if (process.env.KOI_AUTH_TOKEN) {
          if (!this._gatewayEmbeddingInstance) {
            const { GatewayEmbedding } = await import('./providers/gateway.js');
            this._gatewayEmbeddingInstance = new GatewayEmbedding();
          }
          const result = await this._gatewayEmbeddingInstance.embed(text, { abortSignal: ac.signal });
          clearTimeout(_timer);
          this._log('memory', `Embedding OK: ${Date.now() - _t0}ms, dim=${result.length}${attempt > 0 ? `, retry=${attempt}` : ''}`);
          return result;
        }

        if (process.env.OPENAI_API_KEY) {
          if (!this._embeddingClient) {
            this._embeddingClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
          }
          if (!this._embeddingInstance) {
            this._embeddingInstance = this._createEmbedding('openai', this._embeddingClient);
          }
          const result = await this._embeddingInstance.embed(text, { abortSignal: ac.signal });
          clearTimeout(_timer);
          this._log('memory', `Embedding OK: ${Date.now() - _t0}ms, dim=${result.length}${attempt > 0 ? `, retry=${attempt}` : ''}`);
          return result;
        }

        if (process.env.GEMINI_API_KEY) {
          if (!this._geminiEmbeddingClient) {
            this._geminiEmbeddingClient = new OpenAI({
              apiKey: process.env.GEMINI_API_KEY,
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              maxRetries: 0
            });
          }
          if (!this._geminiEmbeddingInstance) {
            this._geminiEmbeddingInstance = this._createEmbedding('gemini', this._geminiEmbeddingClient);
          }
          const result = await this._geminiEmbeddingInstance.embed(text, { abortSignal: ac.signal });
          clearTimeout(_timer);
          this._log('memory', `Embedding OK: ${Date.now() - _t0}ms, dim=${result.length}${attempt > 0 ? `, retry=${attempt}` : ''}`);
          return result;
        }

        throw new Error('No embedding provider available (need OPENAI_API_KEY or GEMINI_API_KEY)');
      } catch (error) {
        clearTimeout(_timer);
        const elapsed = Date.now() - _t0;
        const isTimeout = ac.signal.aborted;
        const msg = isTimeout ? `embedding timeout after ${elapsed}ms` : error.message;
        this._log('memory', `Embedding FAILED: ${msg} (provider=${_provider}, textLen=${text.length}, elapsed=${elapsed}ms, attempt=${attempt})`);
        lastError = error; // preserve typed errors (e.g. QuotaExceededError) for upstream detection
        // Surface 402 once so the user sees "no credits" instead of a frozen UI.
        try {
          const { isQuotaExceededError, surfaceQuotaIfDetected } = await import('./quota-exceeded-error.js');
          if (isQuotaExceededError(error)) {
            await surfaceQuotaIfDetected(error);
            throw error;
          }
        } catch (_e) {
          if (_e === error) throw error;
        }
        // Retry on timeout or 5xx errors; don't retry auth/validation errors
        const status = error.status || 0;
        if (!isTimeout && status > 0 && status < 500) throw lastError;
      }
    }
    throw lastError;
  }

  /**
   * Batch embed multiple texts via the gateway batch API.
   * Non-gateway mode falls back to sequential individual calls.
   *
   * Batches are serialized: only one batch runs at a time.
   * Uses a while-loop lock to prevent the race condition where multiple
   * waiters wake up simultaneously when the previous batch completes.
   */
  async getEmbeddingBatch(texts) {
    if (!texts.length) return [];

    // Serialize batch requests — re-check lock after waking up to prevent
    // multiple waiters from proceeding concurrently.
    while (this._embeddingBatchLock) {
      await this._embeddingBatchLock;
    }

    let _unlock;
    this._embeddingBatchLock = new Promise(r => { _unlock = r; });

    try {
      return await this._doEmbeddingBatch(texts);
    } finally {
      this._embeddingBatchLock = null;
      _unlock();
    }
  }

  async _doEmbeddingBatch(texts) {
    // Gateway mode: always use batch API — never fall back to individual calls.
    if (process.env.KOI_AUTH_TOKEN) {
      if (!this._gatewayEmbeddingInstance) {
        const { GatewayEmbedding } = await import('./providers/gateway.js');
        this._gatewayEmbeddingInstance = new GatewayEmbedding();
      }
      const _t0 = Date.now();
      this._log('memory', `Embedding batch: ${texts.length} texts via gateway`);
      const results = await this._gatewayEmbeddingInstance.embedBatch(texts);
      this._log('memory', `Embedding batch OK: ${Date.now() - _t0}ms, count=${results.length}`);
      return results;
    }

    // Non-gateway: sequential individual calls (direct API keys)
    const results = [];
    for (const text of texts) {
      try {
        results.push(await this.getEmbedding(text));
      } catch {
        results.push(null);
      }
    }
    return results;
  }
}
