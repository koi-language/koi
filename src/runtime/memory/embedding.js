/**
 * Memory ↔ Koi embedding bridge.
 *
 * Wraps a Koi `EmbeddingProvider` instance so that:
 *   - rmh/_koi-bridge.js can call .getEmbedding(text) directly
 *   - The wrapper here exposes the same shape rmh/ expects
 *
 * Why a separate file (instead of just passing the provider): keeps the
 * shape of what rmh sees decoupled from how Koi instantiates providers,
 * so we can swap embedding backends without touching rmh code.
 */

/**
 * Build an adapter object suitable for `configureKoiBridge({embeddingProvider})`.
 *
 * @param {object} koiEmbeddingProvider  An instance of Koi's EmbeddingProvider.
 * @returns {object} Adapter with getEmbedding(text) and getEmbeddingDim().
 */
export function makeEmbeddingAdapter(koiEmbeddingProvider) {
  if (!koiEmbeddingProvider || typeof koiEmbeddingProvider.getEmbedding !== 'function') {
    throw new Error('makeEmbeddingAdapter: requires a Koi EmbeddingProvider instance');
  }
  return {
    getEmbedding: (text) => koiEmbeddingProvider.getEmbedding(text),
    getEmbeddingDim: () => koiEmbeddingProvider.getEmbeddingDim(),
  };
}
