import { cosine, embedText } from "./engine.js";
const DEFAULT_MAX_SEEDS = 30;
const DEFAULT_GAP_THRESHOLD = 0.15;
const NOISE_FLOOR_FACTOR = 0.5;
function detectSurprise(current, cached, threshold) {
  if (!cached) return true;
  return 1 - cosine(current, cached) > threshold;
}
function selectSeeds(similarities, threshold, maxSeeds = DEFAULT_MAX_SEEDS, gapThreshold = DEFAULT_GAP_THRESHOLD) {
  const seeds = /* @__PURE__ */ new Map();
  for (let i = 0; i < similarities.length && seeds.size < maxSeeds; i++) {
    const { title, sim } = similarities[i];
    if (sim < threshold) break;
    if (i > 0 && similarities[i - 1].sim - sim > gapThreshold) break;
    seeds.set(title, sim);
  }
  return seeds;
}
function computePPR(seeds, linkGraph, alpha, iterations) {
  if (seeds.size === 0) return /* @__PURE__ */ new Map();
  const allNodes = /* @__PURE__ */ new Set();
  for (const node of seeds.keys()) allNodes.add(node);
  for (const [node, targets] of linkGraph.outgoing) {
    allNodes.add(node);
    for (const target of targets) allNodes.add(target);
  }
  for (const [node, sources] of linkGraph.incoming) {
    allNodes.add(node);
    for (const source of sources) allNodes.add(source);
  }
  let seedSum = 0;
  for (const score of seeds.values()) seedSum += score;
  if (seedSum <= 0) return /* @__PURE__ */ new Map();
  const teleport = /* @__PURE__ */ new Map();
  for (const [title, score] of seeds) {
    teleport.set(title, score / seedSum);
  }
  let scores = new Map(teleport);
  for (let iter = 0; iter < iterations; iter++) {
    const next = /* @__PURE__ */ new Map();
    for (const node of allNodes) {
      next.set(node, 0);
    }
    for (const [title, tp] of teleport) {
      next.set(title, alpha * tp);
    }
    for (const node of allNodes) {
      const nodeScore = scores.get(node) ?? 0;
      if (nodeScore === 0) continue;
      const neighbors = /* @__PURE__ */ new Set();
      const outgoing = linkGraph.outgoing.get(node);
      const incoming = linkGraph.incoming.get(node);
      if (outgoing) {
        for (const neighbor of outgoing) neighbors.add(neighbor);
      }
      if (incoming) {
        for (const neighbor of incoming) neighbors.add(neighbor);
      }
      if (neighbors.size === 0) continue;
      const share = (1 - alpha) * nodeScore / neighbors.size;
      for (const neighbor of neighbors) {
        next.set(neighbor, (next.get(neighbor) ?? 0) + share);
      }
    }
    scores = next;
  }
  return scores;
}
function normalizeScores(scores) {
  let maxScore = 0;
  for (const score of scores.values()) {
    if (score > maxScore) maxScore = score;
  }
  if (maxScore <= 0) return /* @__PURE__ */ new Map();
  const normalized = /* @__PURE__ */ new Map();
  for (const [title, score] of scores) {
    normalized.set(title, score / maxScore);
  }
  return normalized;
}
function mergeWarmthScores(similarities, graphScores, seeds, config, limit = config.max_results) {
  const embeddingScores = /* @__PURE__ */ new Map();
  for (const { title, sim } of similarities) {
    embeddingScores.set(title, sim);
  }
  const normalizedGraph = normalizeScores(graphScores);
  const mergedTitles = /* @__PURE__ */ new Set([
    ...embeddingScores.keys(),
    ...normalizedGraph.keys()
  ]);
  const noiseFloor = config.activation_threshold * NOISE_FLOOR_FACTOR;
  const merged = [];
  for (const title of mergedTitles) {
    const embeddingScore = embeddingScores.get(title) ?? 0;
    const graphScore = normalizedGraph.get(title) ?? 0;
    const finalScore = (1 - config.graph_weight) * embeddingScore + config.graph_weight * graphScore;
    if (finalScore < noiseFloor) continue;
    const hasSeed = seeds.has(title);
    const hasGraph = graphScore > 0;
    const source = hasSeed && hasGraph ? "both" : hasSeed ? "embedding" : "graph";
    merged.push({ title, score: finalScore, source });
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}
class WarmthService {
  constructor(embedder = embedText) {
    this.embedder = embedder;
  }
  cache = null;
  async scan(context, storedVectors, linkGraph, engineConfig, warmthConfig, options) {
    if (!warmthConfig.enabled || storedVectors.size === 0) return [];
    const requestedLimit = options?.limit ?? warmthConfig.max_results;
    const contextEmbedding = await this.embedder(context, engineConfig);
    if (this.cache && this.cache.vectorCount === storedVectors.size && !detectSurprise(
      contextEmbedding,
      this.cache.contextEmbedding,
      warmthConfig.surprise_threshold
    )) {
      return this.cache.signals.slice(0, requestedLimit);
    }
    const similarities = [];
    for (const [title, vectors] of storedVectors) {
      const vector = vectors.bodyVec.length > 0 ? vectors.bodyVec : vectors.descVec;
      if (vector.length === 0) continue;
      similarities.push({ title, sim: cosine(contextEmbedding, vector) });
    }
    similarities.sort((a, b) => b.sim - a.sim);
    const seeds = selectSeeds(similarities, warmthConfig.activation_threshold);
    if (seeds.size === 0) {
      this.cache = {
        contextEmbedding,
        signals: [],
        vectorCount: storedVectors.size
      };
      return [];
    }
    const graphScores = computePPR(
      seeds,
      linkGraph,
      warmthConfig.ppr_alpha,
      warmthConfig.ppr_iterations
    );
    const signals = mergeWarmthScores(
      similarities,
      graphScores,
      seeds,
      warmthConfig,
      Math.max(requestedLimit, warmthConfig.max_results)
    );
    this.cache = {
      contextEmbedding,
      signals,
      vectorCount: storedVectors.size
    };
    return signals.slice(0, requestedLimit);
  }
  clearCache() {
    this.cache = null;
  }
}
export {
  WarmthService,
  computePPR,
  detectSurprise,
  mergeWarmthScores,
  selectSeeds
};
