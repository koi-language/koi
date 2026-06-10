/**
 * Internal retrieve orchestrator.
 *
 * Assembles rmh/ primitives into the full retrieval pipeline:
 *   query
 *     → composite vector search (semantic, vitality-weighted)
 *     → BM25 keyword search
 *     → PPR graph expansion seeded from the semantic hits
 *     → warmth (ACT-R activation) scan
 *     → RRF fuse of all four signals
 *     → Q-value + UCB exploration re-rank (reinforcement learning)
 *     → top K, with exposure + retrieval logging for reward credit
 *
 * The reward half of the RL loop (forward-citation credit → updateQ) lives
 * in index.js, which knows about write() outcomes.
 *
 * NOT exported from index.js — this is module-internal.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { listNoteTitles, getVaultPaths } from './rmh/vault.js';
import { loadConfig } from './rmh/config.js';
import { buildGraph } from './rmh/graph.js';
import { buildNoteIndex } from './rmh/noteindex.js';
import {
  computeGraphMetrics,
} from './rmh/importance.js';
import {
  buildIndex as buildEmbeddingIndex,
  initDB,
  loadVectors,
  searchComposite,
  embedText,
} from './rmh/engine.js';
import {
  buildBM25IndexFromVault,
  searchBM25,
} from './rmh/bm25.js';
import { fuseScoreWeightedRRF } from './rmh/fusion.js';
import { classifyIntentByEmbedding, computeTypeCentroids } from './intent-embedding.js';
import { computeVitalityFull } from './rmh/vitality.js';
import { computePPR, WarmthService } from './rmh/warmth.js';
import {
  initQValueTables,
  getDecayedQ,
  getRewardStats,
  explorationBonus,
  incrementExposure,
  logRetrieval,
  getTotalQueryCount,
} from './rmh/qvalue.js';

// Graph (PPR) signal: how far query-seeded relevance spreads through the
// wiki-link graph. alpha = restart-to-seed probability (higher = stay near
// seeds); mirrors rmh/ppr.js's own constants.
const GRAPH_PPR_ALPHA = 0.5;
const GRAPH_PPR_ITERATIONS = 20;
const GRAPH_SEED_COUNT = 10;

// Q-rerank blend. At cold start every note's Q is the 0.5 neutral default
// and exploration bonuses are uniform, so this is a no-op until the reward
// loop has taught the table something — the ranking only ever drifts as
// real forward-citation rewards accrue.
const Q_NUDGE = 0.4; // ± up to 20% from learned Q (q-0.5 ∈ [-0.5, 0.5])

// One warmth service per process so its surprise-gated embedding cache
// survives across queries (that caching is the whole point of warmth).
let _warmthService = null;

/**
 * Build a snapshot of vault state needed for retrieve.
 * Caches indexes lazily; pass an existing snapshot to reuse.
 *
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {object} [opts.previousSnapshot] If passed and vault unchanged, returned as-is.
 * @returns {Promise<object>} Snapshot
 */
export async function buildSnapshot({ vaultRoot, previousSnapshot }) {
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const titles = await listNoteTitles(paths.notes);

  // If notes/ is empty, skip everything but still return a usable snapshot
  // so retrieve() can short-circuit to an empty result.
  if (titles.length === 0) {
    return {
      vaultRoot,
      paths,
      config,
      titles: [],
      noteIndex: { frontmatter: new Map() },
      linkGraph: { incoming: new Map(), outgoing: new Map() },
      graphMetrics: null,
      db: null,
      storedVectors: new Map(),
      bm25Index: null,
      vitalityScores: new Map(),
      typeCentroids: { centroids: new Map(), counts: new Map() },
    };
  }

  // Build link graph + note frontmatter index
  const linkGraph = await buildGraph(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, titles);
  const graphMetrics = computeGraphMetrics(linkGraph, noteIndex);

  // Open / build the embedding DB
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  let dbExists = true;
  try { await fs.access(dbPath); } catch { dbExists = false; }
  if (!dbExists) {
    await buildEmbeddingIndex(vaultRoot, config.engine);
  }
  let db = initDB(dbPath);
  let rowCount = db.prepare('SELECT COUNT(*) AS cnt FROM embeddings').get().cnt;
  if (rowCount === 0) {
    // buildEmbeddingIndex opens its own connection and closes it, so drop
    // ours first, then REOPEN and keep a live handle — the snapshot (and
    // the RL writes below) need an open connection, not the closed one.
    db.close();
    await buildEmbeddingIndex(vaultRoot, config.engine);
    db = initDB(dbPath);
    rowCount = db.prepare('SELECT COUNT(*) AS cnt FROM embeddings').get().cnt;
  }
  const storedVectors = loadVectors(db);

  // BM25 index
  const bm25Index = await buildBM25IndexFromVault(vaultRoot, config.bm25);

  // RL tables (note_q / q_history / retrieval_log). Idempotent — safe to
  // call on every snapshot; only creates them the first time.
  initQValueTables(db);

  // ACT-R vitality per note — recency × usage × structural centrality.
  // "Usage" comes from the RL exposure counter (note_q.exposure_count),
  // which retrieve() bumps for every surfaced note, so vitality reflects
  // how often a note actually gets pulled, not just how it was authored.
  const exposureByTitle = new Map();
  try {
    for (const row of db.prepare('SELECT note_id, exposure_count FROM note_q').all()) {
      exposureByTitle.set(row.note_id, row.exposure_count ?? 0);
    }
  } catch { /* table may be empty — fine */ }
  const vitalityScores = computeVitalityScores(noteIndex, linkGraph, graphMetrics, exposureByTitle);

  // Per-`type` embedding centroids for data-derived intent classification
  // (replaces hardcoded keyword/prototype matching). Cheap — averages
  // vectors already loaded into storedVectors.
  const typeCentroids = computeTypeCentroids(storedVectors, noteIndex);

  return {
    vaultRoot,
    paths,
    config,
    titles,
    noteIndex,
    linkGraph,
    graphMetrics,
    db,
    storedVectors,
    bm25Index,
    vitalityScores,
    typeCentroids,
  };
}

/**
 * Build the vitalityScores Map searchComposite needs. Each note's vitality
 * is an ACT-R activation in [0,1] from access count (retrieval exposure),
 * note age, in-degree, and bridge status. Missing/invalid fields fall back
 * to a neutral 0.5 so a sparse note never poisons the whole map.
 */
function computeVitalityScores(noteIndex, linkGraph, graphMetrics, exposureByTitle) {
  const scores = new Map();
  const bridges = graphMetrics?.bridges ?? new Set();
  for (const [title, fm] of noteIndex.frontmatter) {
    const inDegree = linkGraph.incoming.get(title)?.size ?? 0;
    const accessCount = exposureByTitle.get(title) ?? Number(fm?.access_count) ?? 0;
    const created = fm?.created || new Date().toISOString().slice(0, 10);
    let v = 0.5;
    try {
      v = computeVitalityFull({ accessCount, created, noteTitle: title, inDegree, bridges });
    } catch { v = 0.5; }
    scores.set(title, Number.isFinite(v) ? v : 0.5);
  }
  return scores;
}

/**
 * Run a retrieve query against a snapshot. Returns scored notes.
 *
 * @param {object} snapshot  From buildSnapshot()
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {object} [opts.filter]   { type?: string|string[], status?: string }
 * @returns {Promise<Array<{title, score, signals?, frontmatter}>>}
 */
export async function runRetrieve(snapshot, query, opts = {}) {
  if (snapshot.titles.length === 0) return [];

  const config = snapshot.config;
  const limit = opts.limit ?? config.retrieval.default_limit;
  const candidateLimit = limit * config.retrieval.candidate_multiplier;
  const sessionId = opts.sessionId || 'unknown';

  // 1. Embed the query ONCE (shared with composite search below), then
  //    classify intent by nearest note-`type` centroid — data-derived,
  //    language-agnostic, no keyword regexes. Used to weight composite search.
  let queryVec = null;
  try { queryVec = await embedText(query, config.engine); } catch { queryVec = null; }
  const intent = classifyIntentByEmbedding(queryVec, query, snapshot.titles, snapshot.typeCentroids);

  // 2. Signal A — composite vector search (semantic, vitality-weighted)
  let compositeResults = [];
  try {
    compositeResults = await searchComposite({
      queryText: query,
      queryVec,
      intent,
      storedVectors: snapshot.storedVectors,
      graphMetrics: snapshot.graphMetrics,
      vitalityScores: snapshot.vitalityScores,
      limit: candidateLimit,
      config: config.engine,
    });
  } catch (err) {
    // If the embeddings provider is unavailable, fall back to BM25-only.
    compositeResults = [];
  }

  // 3. Signal B — BM25 keyword search
  const keywordResults = searchBM25(query, snapshot.bm25Index, config.bm25, candidateLimit);

  // 4. Signal C — PPR graph expansion seeded from the semantic hits. Surfaces
  //    notes structurally linked to relevant ones even when their own text
  //    doesn't match the query. Needs seeds → no-ops when composite is empty.
  let graphResults = [];
  try {
    if (compositeResults.length > 0 && snapshot.linkGraph) {
      const seeds = new Map();
      for (const r of compositeResults.slice(0, GRAPH_SEED_COUNT)) {
        if (r.score > 0) seeds.set(r.title, r.score);
      }
      if (seeds.size > 0) {
        const ppr = computePPR(seeds, snapshot.linkGraph, GRAPH_PPR_ALPHA, GRAPH_PPR_ITERATIONS);
        graphResults = [...ppr.entries()]
          .filter(([, s]) => s > 0)
          .map(([title, score]) => ({ title, score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, candidateLimit);
      }
    }
  } catch (err) {
    graphResults = [];
  }

  // 5. Signal D — warmth: ACT-R spreading activation over contextually/recently
  //    relevant notes, self-cached per process via surprise detection.
  let warmthResults = [];
  try {
    if (config.warmth?.enabled !== false && snapshot.storedVectors.size > 0) {
      if (!_warmthService) _warmthService = new WarmthService();
      warmthResults = await _warmthService.scan(
        query,
        snapshot.storedVectors,
        snapshot.linkGraph,
        config.engine,
        config.warmth,
        { limit: candidateLimit },
      );
    }
  } catch (err) {
    warmthResults = [];
  }

  // 6. RRF fuse all four signals.
  const fused = fuseScoreWeightedRRF(
    {
      composite: compositeResults,
      keyword: keywordResults,
      graph: graphResults,
      warmth: warmthResults,
    },
    {
      rrf_k: config.retrieval.rrf_k,
      signal_weights: config.retrieval.signal_weights,
    },
  );

  // 7. RL re-rank — nudge by learned Q-value + UCB exploration bonus.
  //    Neutral at cold start (Q defaults to 0.5, exploration uniform); the
  //    ranking only drifts as forward-citation rewards (index.js) train it.
  const db = snapshot.db;
  if (db && fused.length > 0) {
    const exploreBudget = config.retrieval.exploration_budget ?? 0.1;
    let totalQueries = 1;
    try { totalQueries = getTotalQueryCount(db) + 1; } catch { /* keep 1 */ }
    for (const r of fused) {
      let q = 0.5;
      let ucb = 0;
      try {
        q = getDecayedQ(db, r.title);
        ucb = explorationBonus(getRewardStats(db, r.title), totalQueries);
      } catch { /* leave neutral */ }
      r.signals = r.signals || {};
      r.signals.q = q;
      r.signals.ucb = ucb;
      r.score = r.score * (1 + Q_NUDGE * (q - 0.5) + exploreBudget * ucb);
    }
    fused.sort((a, b) => b.score - a.score);
  }

  // 8. Apply filters and slice to limit
  const filter = opts.filter || {};
  const filtered = fused.filter((r) => _matchesFilter(r, snapshot.noteIndex, filter));
  const top = filtered.slice(0, limit);

  // 9. Record exposure + retrieval log for surfaced notes (RL credit
  //    assignment reads these back). Best-effort; never blocks a retrieval.
  if (db && top.length > 0) {
    try {
      const tx = db.transaction(() => {
        top.forEach((r, i) => {
          incrementExposure(db, r.title);
          logRetrieval(
            db, sessionId, query, intent.intent, r.title, i,
            r.signals?.composite ?? null, r.signals?.q ?? null,
            r.signals?.ucb ?? null, r.score,
          );
        });
      });
      tx();
    } catch { /* logging is non-critical */ }
  }

  // 10. Hydrate with frontmatter for the caller
  const out = [];
  for (const r of top) {
    const fm = snapshot.noteIndex.frontmatter.get(r.title) || {};
    out.push({
      title: r.title,
      score: r.score,
      frontmatter: fm,
    });
  }
  return out;
}

function _matchesFilter(result, noteIndex, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  const fm = noteIndex.frontmatter.get(result.title);
  if (!fm) return false;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(fm.type)) return false;
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(fm.status)) return false;
  }
  if (filter.project) {
    const wanted = Array.isArray(filter.project) ? filter.project : [filter.project];
    const fmProj = Array.isArray(fm.project) ? fm.project : [];
    if (!wanted.some((w) => fmProj.includes(w))) return false;
  }
  return true;
}
