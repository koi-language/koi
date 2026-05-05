// koi-fork: NOT vendored. This is the single point where rmh/ reaches into
// Koi runtime. All koi-fork imports in vendored files point here.
//
// Lifecycle: Koi's memory wrapper (../index.js) calls configureKoiBridge()
// at boot with the runtime providers. Until then the bridge throws or no-ops
// depending on the call.

let _embeddingProvider = null;
let _llmProvider = null;
let _eventLog = null;

/**
 * Wire bridge to Koi runtime. Called from src/runtime/memory/index.js.
 * Pass undefined to leave a slot unchanged; pass null to clear it.
 */
export function configureKoiBridge({ embeddingProvider, llmProvider, eventLog } = {}) {
  if (embeddingProvider !== undefined) _embeddingProvider = embeddingProvider;
  if (llmProvider !== undefined) _llmProvider = llmProvider;
  if (eventLog !== undefined) _eventLog = eventLog;
}

// ─── Embeddings ─────────────────────────────────────────────────────────

/**
 * Embed text via Koi's EmbeddingProvider.
 * Replaces upstream Ori's @huggingface/transformers pipeline.
 * Returns Float32Array (or array of numbers).
 */
export async function embedText(text) {
  if (!_embeddingProvider) {
    throw new Error('rmh: embedding provider not configured. Call configureKoiBridge({embeddingProvider}) at boot.');
  }
  return await _embeddingProvider.getEmbedding(text);
}

export function getEmbeddingDim() {
  if (!_embeddingProvider) return 1536; // OpenAI text-embedding-3-small default
  return _embeddingProvider.getEmbeddingDim();
}

// ─── LLM adapter ────────────────────────────────────────────────────────

/**
 * Wraps Koi's LLMProvider into the .chat(messages, opts) interface that
 * upstream explore.js expects. Returns null if no LLM configured (caller
 * should fall back to non-LLM path).
 */
export function makeLlmAdapter(llmProvider) {
  const provider = llmProvider ?? _llmProvider;
  if (!provider) return NullLLM;
  return {
    chat: async (messages, opts = {}) => {
      const prompt = messages
        .map((m) => (m.role ? `${m.role}: ${m.content}` : String(m.content ?? m)))
        .join('\n\n');
      const text = await provider.simpleChat(prompt, {
        timeoutMs: opts.timeoutMs ?? 15000,
      });
      return { content: text };
    },
  };
}

/** Sentinel replacing upstream NullProvider class. Detected via isNullLlm(). */
export const NullLLM = Object.freeze({
  isNull: true,
  chat: async () => {
    throw new Error('NullLLM.chat() invoked — no LLM configured');
  },
});

export function isNullLlm(provider) {
  return provider == null || provider === NullLLM || provider?.isNull === true;
}

// ─── Event Log emission ─────────────────────────────────────────────────

/**
 * Append an event to Koi's event log. No-op if the log isn't wired yet
 * (e.g. during boot before event-log/writer.js is configured).
 */
export function emitEvent(type, actor, payload, parents) {
  if (!_eventLog) return;
  try {
    const r = _eventLog.append(type, actor, payload, parents);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    // swallow — event log emission must never break memory writes
  }
}
