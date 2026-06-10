/**
 * Data-derived, language-agnostic query-intent classifier.
 *
 * Replaces rmh/intent.js's English-only keyword regexes (/when did/, /how to/,
 * /why did we/, …) which classified every non-English query as "semantic" and
 * broke the project's "no hardcoded literal matching" rule.
 *
 * How it works — NO hardcoded prototypes, NO keyword lists:
 *   - Each note already carries a reliable `type` (the agent/LLM sets it on
 *     add_memory). We average the embeddings of all notes of each type into a
 *     per-type CENTROID, computed from vectors already loaded in the snapshot
 *     (cost ≈ a few vector sums, no extra embedding calls).
 *   - A query is classified by which type-centroid its embedding is nearest to
 *     — i.e. against the user's OWN notes, in whatever language they wrote them.
 *   - A relative MARGIN (winner must clearly beat the runner-up) plus a minimum
 *     note count per type keep it conservative: when in doubt it falls back to
 *     the neutral "semantic" profile rather than over-specialising.
 *
 * The type taxonomy (idea/decision/learning/insight/blocker/opportunity/episode)
 * doesn't map 1:1 to the retrieval weight profiles (episodic/procedural/decision/
 * semantic), so TYPE_TO_PROFILE maps the two types with a distinctive profile
 * (decision, episode) and routes the rest to "semantic". That mapping is policy
 * (how to rank), not literal matching of query words.
 */

import { cosine } from './rmh/engine.js';
import { getSpaceWeights, getSplitWeights } from './rmh/intent.js';

// Note type → retrieval weight profile (see rmh/intent.js SPACE_WEIGHTS).
// Only decision/episode carry a distinctive profile; the rest are knowledge
// notes best served by the plain semantic profile.
const TYPE_TO_PROFILE = {
  decision: 'decision',
  episode: 'episodic',
  learning: 'semantic',
  insight: 'semantic',
  idea: 'semantic',
  opportunity: 'semantic',
  blocker: 'semantic',
};

// A centroid built from fewer than this many notes is too noisy to trust.
const MIN_TYPE_NOTES = 3;
// The winning centroid must beat the runner-up by at least this cosine margin,
// else the query isn't clearly any one type → stay semantic. Tunable; biased
// toward NOT specialising. Relative-style guard (winner vs runner-up) so it's
// robust to how a given embedding model scales its cosines.
const CENTROID_MARGIN = 0.03;

/**
 * Average note embeddings into one centroid per `type`, from vectors already
 * loaded in the snapshot. Returns { centroids: Map<type,Float32Array>,
 * counts: Map<type,number> }. Uses the description vector (topical, without
 * the injected type label that bodyVec carries).
 */
export function computeTypeCentroids(storedVectors, noteIndex) {
  const sums = new Map();
  const counts = new Map();
  for (const [title, vecs] of storedVectors) {
    const type = noteIndex?.frontmatter?.get(title)?.type;
    if (!type) continue;
    const v = vecs?.descVec;
    if (!v || v.length === 0) continue;
    let sum = sums.get(type);
    if (!sum) { sum = new Float32Array(v.length); sums.set(type, sum); }
    if (sum.length !== v.length) continue; // dim mismatch — skip safely
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const centroids = new Map();
  for (const [type, sum] of sums) {
    const n = counts.get(type) || 1;
    const c = new Float32Array(sum.length);
    for (let i = 0; i < sum.length; i++) c[i] = sum[i] / n;
    centroids.set(type, c);
  }
  return { centroids, counts };
}

// Language-agnostic: matches the query against ACTUAL note titles, not a
// hardcoded vocabulary. Mirrors rmh/intent.js extractEntities.
function extractEntities(query, titles = []) {
  const q = String(query).toLowerCase();
  const out = [];
  for (const t of titles) {
    const tl = t.toLowerCase();
    if (tl.length >= 3 && q.includes(tl)) out.push(t);
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * Classify intent by nearest note-type centroid. Returns the same shape as
 * rmh/intent.js's classifyIntent so it's a drop-in for the orchestrator.
 *
 * @param {Float32Array|null} queryVec     Pre-computed query embedding.
 * @param {string} query
 * @param {string[]} titles
 * @param {{centroids: Map, counts: Map}|null} typeCentroids  From computeTypeCentroids.
 */
export function classifyIntentByEmbedding(queryVec, query, titles = [], typeCentroids = null) {
  let intent = 'semantic';
  let confidence = 0.5;
  try {
    const centroids = typeCentroids?.centroids;
    const counts = typeCentroids?.counts;
    if (queryVec && centroids && centroids.size > 0) {
      const scored = [];
      for (const [type, vec] of centroids) {
        if ((counts.get(type) ?? 0) < MIN_TYPE_NOTES) continue;
        if (vec.length !== queryVec.length) continue;
        scored.push([type, cosine(queryVec, vec)]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      // Need ≥2 eligible types to have a contrast; a single type gives no
      // signal (everything would map to it) → leave semantic.
      if (scored.length >= 2) {
        const [bestType, bestSim] = scored[0];
        const runnerUp = scored[1][1];
        if (bestSim > 0 && bestSim - runnerUp >= CENTROID_MARGIN) {
          const profile = TYPE_TO_PROFILE[bestType];
          if (profile && profile !== 'semantic') {
            intent = profile;
            confidence = Math.min(1, bestSim + 0.3);
          }
        }
      }
    }
  } catch {
    intent = 'semantic';
    confidence = 0.5;
  }
  return {
    intent,
    confidence,
    query,
    entities: extractEntities(query, titles),
    spaceWeights: getSpaceWeights(intent),
    splitWeights: getSplitWeights(intent),
  };
}
