const STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "don",
  "now",
  "and",
  "but",
  "or",
  "if",
  "while",
  "about",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "am",
  "it",
  "its",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their",
  "i",
  "me",
  "we",
  "you",
  "he",
  "she",
  "they",
  "them",
  "up"
]);
function extractKeyTerms(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}
function applyGravityDampening(results, query, noteTitles, threshold = 0.3) {
  const queryTerms = extractKeyTerms(query);
  if (queryTerms.size === 0) return results;
  return results.map((note) => {
    if (note.score <= threshold) return note;
    const titleTerms = extractKeyTerms(note.title);
    let overlap = 0;
    for (const term of queryTerms) {
      if (titleTerms.has(term)) {
        overlap++;
        break;
      }
    }
    if (overlap === 0) {
      return { ...note, score: note.score * 0.5 };
    }
    return note;
  });
}
function applyHubDampening(results, linkGraph, queryEntities = []) {
  const degrees = /* @__PURE__ */ new Map();
  for (const [node, targets] of linkGraph.outgoing) {
    degrees.set(node, (degrees.get(node) ?? 0) + targets.size);
  }
  for (const [node, sources] of linkGraph.incoming) {
    degrees.set(node, (degrees.get(node) ?? 0) + sources.size);
  }
  const allDegrees = [...degrees.values()].sort((a, b) => a - b);
  if (allDegrees.length === 0) return results;
  const p90Index = Math.floor(allDegrees.length * 0.9);
  const p90 = allDegrees[p90Index] ?? 0;
  const maxDeg = allDegrees[allDegrees.length - 1] ?? 0;
  if (maxDeg <= p90) return results;
  const entitySet = new Set(queryEntities.map((e) => e.toLowerCase()));
  return results.map((note) => {
    const degree = degrees.get(note.title) ?? 0;
    if (degree <= p90) return note;
    if (entitySet.has(note.title.toLowerCase())) return note;
    const ratio = (degree - p90) / (maxDeg - p90);
    const penalty = 1 - 0.6 * ratio;
    const dampened = note.score * Math.max(0.2, penalty);
    return { ...note, score: dampened };
  });
}
const RESOLUTION_TYPES = /* @__PURE__ */ new Set([
  "decision",
  "learning"
]);
function applyResolutionBoost(results, noteTypes, boost = 1.25) {
  return results.map((note) => {
    const noteType = noteTypes.get(note.title);
    if (noteType && RESOLUTION_TYPES.has(noteType.toLowerCase())) {
      return { ...note, score: note.score * boost };
    }
    return note;
  });
}
export {
  applyGravityDampening,
  applyHubDampening,
  applyResolutionBoost,
  extractKeyTerms
};
