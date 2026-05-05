const SIGNAL_NAMES = [
  "composite",
  "keyword",
  "graph",
  "warmth"
];
function buildIndex(notes) {
  const map = /* @__PURE__ */ new Map();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    map.set(n.title, { rank: i, score: n.score, note: n });
  }
  return map;
}
function normalizeSignalWeights(weights) {
  const total = SIGNAL_NAMES.reduce((sum, name) => sum + Math.max(0, weights[name] ?? 0), 0);
  if (total <= 0) {
    const equal = 1 / SIGNAL_NAMES.length;
    return {
      composite: equal,
      keyword: equal,
      graph: equal,
      warmth: equal
    };
  }
  return {
    composite: Math.max(0, weights.composite) / total,
    keyword: Math.max(0, weights.keyword) / total,
    graph: Math.max(0, weights.graph) / total,
    warmth: Math.max(0, weights.warmth) / total
  };
}
function fuseScoreWeightedRRF(signals, config) {
  const k = config.rrf_k;
  const weights = normalizeSignalWeights(config.signal_weights);
  const indexes = {
    composite: buildIndex(signals.composite),
    keyword: buildIndex(signals.keyword),
    graph: buildIndex(signals.graph),
    warmth: buildIndex(signals.warmth)
  };
  const titles = /* @__PURE__ */ new Set();
  for (const name of SIGNAL_NAMES) {
    for (const entry of signals[name]) {
      titles.add(entry.title);
    }
  }
  const results = [];
  const titleArray = Array.from(titles);
  for (let ti = 0; ti < titleArray.length; ti++) {
    const title = titleArray[ti];
    let baseScore = 0;
    let fusedScore = 0;
    const signalScores = {};
    let metadata;
    let spaces;
    for (const name of SIGNAL_NAMES) {
      const entry = indexes[name].get(title);
      if (entry) {
        const w = weights[name];
        const contribution = w * entry.score / (k + entry.rank + 1);
        fusedScore += contribution;
        if (name !== "warmth") {
          baseScore += contribution;
        }
        signalScores[name] = entry.score;
        if (entry.note.metadata && !metadata) metadata = entry.note.metadata;
        if (entry.note.spaces && !spaces) spaces = entry.note.spaces;
      }
    }
    signalScores.rrf_base = baseScore;
    signalScores.rrf = fusedScore;
    const fused = {
      title,
      score: fusedScore,
      signals: signalScores
    };
    if (spaces) fused.spaces = spaces;
    if (metadata) fused.metadata = metadata;
    results.push(fused);
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
function fuseSimpleRRF(signals, k) {
  const indexes = {
    composite: buildIndex(signals.composite),
    keyword: buildIndex(signals.keyword),
    graph: buildIndex(signals.graph),
    warmth: buildIndex(signals.warmth)
  };
  const titles = /* @__PURE__ */ new Set();
  for (const name of SIGNAL_NAMES) {
    for (const entry of signals[name]) {
      titles.add(entry.title);
    }
  }
  const results = [];
  const titleArray = Array.from(titles);
  for (let ti = 0; ti < titleArray.length; ti++) {
    const title = titleArray[ti];
    let baseScore = 0;
    let fusedScore = 0;
    const signalScores = {};
    let metadata;
    let spaces;
    for (const name of SIGNAL_NAMES) {
      const entry = indexes[name].get(title);
      if (entry) {
        const contribution = 1 / (k + entry.rank + 1);
        fusedScore += contribution;
        if (name !== "warmth") {
          baseScore += contribution;
        }
        signalScores[name] = entry.score;
        if (entry.note.metadata && !metadata) metadata = entry.note.metadata;
        if (entry.note.spaces && !spaces) spaces = entry.note.spaces;
      }
    }
    signalScores.rrf_base = baseScore;
    signalScores.rrf = fusedScore;
    const fused = {
      title,
      score: fusedScore,
      signals: signalScores
    };
    if (spaces) fused.spaces = spaces;
    if (metadata) fused.metadata = metadata;
    results.push(fused);
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
export {
  fuseScoreWeightedRRF,
  fuseSimpleRRF,
  normalizeSignalWeights
};
