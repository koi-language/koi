/**
 * Internal retrieve orchestrator.
 *
 * Assembles rmh/ primitives into a working pipeline:
 *   query → BM25 + composite vector → RRF fuse → top K
 *
 * v1 is intentionally minimal — no warmth re-ranking, no PPR boost on the
 * candidate set, no RL stage gating. Those are added incrementally once the
 * basic loop is proven end-to-end.
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
} from './rmh/engine.js';
import {
  buildBM25IndexFromVault,
  searchBM25,
} from './rmh/bm25.js';
import { fuseScoreWeightedRRF } from './rmh/fusion.js';
import { classifyIntent } from './rmh/intent.js';

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
  const db = initDB(dbPath);
  const rowCount = db.prepare('SELECT COUNT(*) AS cnt FROM embeddings').get().cnt;
  if (rowCount === 0) {
    db.close();
    await buildEmbeddingIndex(vaultRoot, config.engine);
  }
  const storedVectors = loadVectors(rowCount === 0 ? initDB(dbPath) : db);

  // BM25 index
  const bm25Index = await buildBM25IndexFromVault(vaultRoot, config.bm25);

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
  };
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

  // 1. Classify query intent (used by composite vector weighting)
  const intent = classifyIntent(query, snapshot.titles);

  // 2. Signal A — composite vector search
  let compositeResults = [];
  try {
    compositeResults = await searchComposite({
      queryText: query,
      intent,
      storedVectors: snapshot.storedVectors,
      graphMetrics: snapshot.graphMetrics,
      vitalityScores: undefined, // v1: skip vitality boost
      limit: candidateLimit,
      config: config.engine,
    });
  } catch (err) {
    // If embeddings provider unavailable, fall back to BM25-only.
    compositeResults = [];
  }

  // 3. Signal B — BM25 keyword search
  const keywordResults = searchBM25(query, snapshot.bm25Index, config.bm25, candidateLimit);

  // 4. RRF fuse — fusion expects all 4 signal arrays; for v1 we leave
  //    graph + warmth empty. Their default weights (config.retrieval.signal_weights)
  //    apply but contribute nothing because the arrays are empty.
  const fused = fuseScoreWeightedRRF(
    {
      composite: compositeResults,
      keyword: keywordResults,
      graph: [],
      warmth: [],
    },
    {
      rrf_k: config.retrieval.rrf_k,
      signal_weights: config.retrieval.signal_weights,
    },
  );

  // 5. Apply filters and slice to limit
  const filter = opts.filter || {};
  const filtered = fused.filter((r) => _matchesFilter(r, snapshot.noteIndex, filter));
  const top = filtered.slice(0, limit);

  // 6. Hydrate with frontmatter + body for caller
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
