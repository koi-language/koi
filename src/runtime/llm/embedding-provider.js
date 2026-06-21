import OpenAI from 'openai';
import { isNetworkError } from './is-network-error.js';

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

    // ── Coalescing cache ────────────────────────────────────────────
    // The prompt builder declares N slots that all embed the SAME
    // `{{trigger.payload.task}}` text (see builtin-slot-maps.js — the
    // System agent has 4 such slots: relevant_notes, active_blockers,
    // recent_decisions, previous_sessions). Without dedup we paid for
    // 4 sequential gateway round-trips on every LLM turn, ~4 s of
    // wasted wall time + 4× the cost. The cache solves it on two
    // levels:
    //   • `_embeddingInflight` (Map<text, Promise>) — concurrent
    //     callers asking for the SAME text join the in-flight request
    //     instead of starting a new one. Cleared when the request
    //     resolves.
    //   • `_embeddingCache` (Map<text, {vector, expiresAt}>) — the
    //     resolved vector lingers for `_embeddingCacheTtlMs` so a
    //     follow-up call for the same text within that window skips
    //     the network entirely. Short TTL on purpose: prompt builds
    //     within a single agent turn dedupe perfectly, but stale
    //     vectors from old turns never sneak in.
    this._embeddingInflight = new Map();
    this._embeddingCache = new Map();
    this._embeddingCacheTtlMs = 30_000;
    this._embeddingCacheMaxEntries = 64;

    // ── Circuit breaker ─────────────────────────────────────────────
    // Embeddings power a BEST-EFFORT enhancement (semantic memory recall).
    // Every caller already treats a failure as non-fatal (try/catch →
    // proceed without recall). The historical failure mode was not a
    // crash but a HANG: when the gateway is unreachable the provider would
    // burn up to 3×timeout + serial backoff (~45-75s) per call, on EVERY
    // turn, freezing the agent for minutes. The breaker turns that into a
    // single slow failure followed by instant (<1ms) fail-fast for a
    // cooldown window, so a flaky/down gateway degrades gracefully instead
    // of stalling the turn. Reset on the first success.
    this._embConsecutiveNetFailures = 0;
    this._embCircuitOpenUntil = 0;
    this._embCircuitThreshold = 3;     // trip after 3 consecutive network failures
    this._embCircuitCooldownMs = 30_000; // stay open 30s, then probe again
  }

  _embeddingCacheGet(text) {
    const hit = this._embeddingCache.get(text);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this._embeddingCache.delete(text);
      return null;
    }
    return hit.vector;
  }

  _embeddingCachePut(text, vector) {
    // LRU-ish: when full, drop the oldest insertion (Maps preserve
    // insertion order in JS). Cheap, no priority queue needed for a
    // 64-entry cache.
    if (this._embeddingCache.size >= this._embeddingCacheMaxEntries) {
      const oldest = this._embeddingCache.keys().next().value;
      if (oldest !== undefined) this._embeddingCache.delete(oldest);
    }
    this._embeddingCache.set(text, {
      vector,
      expiresAt: Date.now() + this._embeddingCacheTtlMs,
    });
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

    // Resolved-vector cache — within the TTL window we never hit the
    // network. Prompt builds that re-embed the same task text across
    // multiple slots become a single lookup.
    const cached = this._embeddingCacheGet(text);
    if (cached) return cached;

    // In-flight cache — concurrent calls for the SAME text share one
    // request. This is the case the prompt compiler hits: 4 slots
    // resolve in parallel and all embed the same `{{trigger.payload.task}}`.
    const inflight = this._embeddingInflight.get(text);
    if (inflight) return inflight;

    const promise = this._getEmbeddingUncached(text)
      .then((vec) => {
        // Any success closes the circuit breaker immediately.
        this._embConsecutiveNetFailures = 0;
        this._embCircuitOpenUntil = 0;
        this._embeddingCachePut(text, vec);
        return vec;
      })
      .finally(() => {
        this._embeddingInflight.delete(text);
      });
    this._embeddingInflight.set(text, promise);
    return promise;
  }

  /** Original embedding logic — bypasses the dedup cache. Called only
   *  from `getEmbedding` after the cache misses. */
  async _getEmbeddingUncached(text) {
    const MAX_RETRIES = 1;
    // Per-attempt timeout. 8s was too tight: the gateway (single replica)
    // has legitimate latency spikes — observed gemini round-trips of ~11.7s
    // and embedding round-trips in that ballpark under load. At 8s those
    // slow-but-WORKING requests were force-failed, which tripped the circuit
    // breaker and blacked out recall. Back to 15s so a normal spike rides
    // through; the circuit breaker (below) still caps a genuinely-down
    // gateway to a couple of slow failures, then fast-fails — so we get
    // resilience WITHOUT false-failing healthy-but-slow embeddings.
    const TIMEOUT_MS = 15000;
    const _provider = process.env.KOI_AUTH_TOKEN ? 'koi-gateway' : process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'none';
    // Fail fast when no credentials are configured — retrying the same 'none'
    // provider with backoff just wastes the startup window while the
    // agent is blocked on memory restore / semantic index warmup.
    if (_provider === 'none') {
      throw new Error('No embedding provider available (need KOI_AUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY)');
    }

    // Circuit breaker: if the embedding backend has failed repeatedly with
    // network errors, fail INSTANTLY for a cooldown window instead of paying
    // another timeout. Callers treat embedding failure as non-fatal (recall
    // degrades), so this turns a multi-minute hang into an instant skip.
    if (this._embCircuitOpenUntil > Date.now()) {
      const secsLeft = Math.ceil((this._embCircuitOpenUntil - Date.now()) / 1000);
      const err = new Error(`embedding circuit open (gateway unreachable, retrying in ${secsLeft}s)`);
      err.code = 'EMB_CIRCUIT_OPEN';
      throw err;
    }

    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 500; // single quick retry; the breaker handles a down backend
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
        // Track network-level failures for the circuit breaker. A timeout
        // (gateway not responding) counts the same as a connection error —
        // both mean "the backend is not reachable right now".
        if (isTimeout || isNetworkError(error)) {
          this._embConsecutiveNetFailures++;
          if (this._embConsecutiveNetFailures >= this._embCircuitThreshold) {
            this._embCircuitOpenUntil = Date.now() + this._embCircuitCooldownMs;
            this._log('memory', `Embedding circuit OPEN: ${this._embConsecutiveNetFailures} consecutive network failures — fast-failing recall for ${this._embCircuitCooldownMs / 1000}s`);
            // Don't burn the remaining retry once the circuit is open.
            throw lastError;
          }
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

    // A single-text "batch" is just one embed. Route it through the cached,
    // coalesced, lock-FREE single path: callers that embed one query at a time
    // (conversation KNN, conversation indexing) then dedupe with the prompt
    // builder's other same-text embeds AND stop serializing behind the global
    // batch lock below. This is the common case in the per-turn recall (the
    // trace showed repeated "Embedding batch: 1 texts" calls queued on the
    // lock). Errors propagate exactly as the gateway batch path would.
    if (texts.length === 1) {
      return [await this.getEmbedding(texts[0])];
    }

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
