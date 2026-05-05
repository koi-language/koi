import {
  getDecayedQ,
  getRewardStats,
  getTotalQUpdates,
  getTotalQueryCount,
  explorationBonus,
  incrementExposure,
  logRetrieval
} from "./qvalue.js";
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 0.5;
const LAMBDA_MATURITY = 200;
const MAX_CUMULATIVE_BIAS = 3;
const EXCESS_COMPRESSION = 0.3;
const K2 = 8;
const QUERY_TYPE_SHIFTS = {
  semantic: -0.1,
  procedural: 0.15,
  decision: 0.05,
  episodic: 0
};
function zNormalize(values) {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return values.map((v) => (v - mean) / std);
}
function computeLambda(totalQUpdates, queryType) {
  const base = LAMBDA_MIN + (LAMBDA_MAX - LAMBDA_MIN) * Math.min(totalQUpdates / LAMBDA_MATURITY, 1);
  const shift = QUERY_TYPE_SHIFTS[queryType] ?? 0;
  return Math.max(0.1, Math.min(0.6, base + shift));
}
function phaseB(db, candidates, queryText, queryType, sessionId) {
  if (candidates.length === 0) return [];
  const totalUpdates = getTotalQUpdates(db);
  const totalQueries = getTotalQueryCount(db);
  const lambda = computeLambda(totalUpdates, queryType);
  const simRaw = candidates.map((c) => c.score);
  const qRaw = candidates.map((c) => getDecayedQ(db, c.title));
  const simNorm = zNormalize(simRaw);
  const qNorm = zNormalize(qRaw);
  const results = candidates.map((c, i) => {
    const blended = (1 - lambda) * simNorm[i] + lambda * qNorm[i];
    const stats = getRewardStats(db, c.title);
    const ucb = explorationBonus(stats, totalQueries);
    let score = blended + ucb;
    const maxAllowed = c.score * MAX_CUMULATIVE_BIAS;
    if (score > maxAllowed) {
      score = maxAllowed + (score - maxAllowed) * EXCESS_COMPRESSION;
    }
    incrementExposure(db, c.title);
    return {
      ...c,
      score,
      _phaseB: { simNorm: simNorm[i], qNorm: qNorm[i], ucb, lambda }
    };
  });
  results.sort((a, b) => b.score - a.score);
  const topK = results.slice(0, K2);
  for (let rank = 0; rank < topK.length; rank++) {
    const r = topK[rank];
    logRetrieval(
      db,
      sessionId,
      queryText,
      queryType,
      r.title,
      rank,
      r._phaseB.simNorm,
      r._phaseB.qNorm,
      r._phaseB.ucb,
      r.score
    );
  }
  return topK.map(({ _phaseB, ...rest }) => rest);
}
export {
  EXCESS_COMPRESSION,
  K2,
  LAMBDA_MATURITY,
  LAMBDA_MAX,
  LAMBDA_MIN,
  MAX_CUMULATIVE_BIAS,
  computeLambda,
  phaseB,
  zNormalize
};
