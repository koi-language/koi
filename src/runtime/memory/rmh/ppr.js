const PPR_ALPHA = 0.5;
const PPR_ITERATIONS = 20;
const COOC_BLEND_BETA = 0.3;
function personalizedPageRankCombined(db, seeds, wikiLinks, maxResults = 15) {
  if (seeds.size === 0) return [];
  const adj = /* @__PURE__ */ new Map();
  for (const [src, targets] of wikiLinks) {
    if (!adj.has(src)) adj.set(src, /* @__PURE__ */ new Map());
    for (const tgt of targets) {
      adj.get(src).set(tgt, (adj.get(src).get(tgt) ?? 0) + 1);
    }
  }
  const coocEdges = db.prepare(
    `
    SELECT note_a, note_b, COALESCE(npmi_weight, 0.1) as w
    FROM co_occurrence WHERE COALESCE(npmi_weight, 0.1) > 0
  `
  ).all();
  for (const { note_a, note_b, w } of coocEdges) {
    if (!adj.has(note_a)) adj.set(note_a, /* @__PURE__ */ new Map());
    if (!adj.has(note_b)) adj.set(note_b, /* @__PURE__ */ new Map());
    adj.get(note_a).set(
      note_b,
      (adj.get(note_a).get(note_b) ?? 0) + COOC_BLEND_BETA * w
    );
    adj.get(note_b).set(
      note_a,
      (adj.get(note_b).get(note_a) ?? 0) + COOC_BLEND_BETA * w
    );
  }
  const allNodes = /* @__PURE__ */ new Set();
  for (const [src, targets] of adj) {
    allNodes.add(src);
    for (const tgt of targets.keys()) allNodes.add(tgt);
  }
  for (const s of seeds.keys()) allNodes.add(s);
  const seedTotal = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  let ppr = /* @__PURE__ */ new Map();
  for (const node of allNodes) {
    ppr.set(node, (seeds.get(node) ?? 0) / seedTotal);
  }
  for (let iter = 0; iter < PPR_ITERATIONS; iter++) {
    const next = /* @__PURE__ */ new Map();
    for (const node of allNodes) next.set(node, 0);
    for (const [src, neighbors] of adj) {
      const srcScore = ppr.get(src) ?? 0;
      const totalWeight = [...neighbors.values()].reduce(
        (a, b) => a + b,
        0
      );
      if (totalWeight === 0) continue;
      for (const [tgt, w] of neighbors) {
        next.set(
          tgt,
          (next.get(tgt) ?? 0) + (1 - PPR_ALPHA) * srcScore * (w / totalWeight)
        );
      }
    }
    for (const node of allNodes) {
      const teleport = PPR_ALPHA * ((seeds.get(node) ?? 0) / seedTotal);
      next.set(node, (next.get(node) ?? 0) + teleport);
    }
    ppr = next;
  }
  return [...ppr.entries()].map(([noteId, score]) => ({ noteId, score })).sort((a, b) => b.score - a.score).slice(0, maxResults);
}
export {
  COOC_BLEND_BETA,
  PPR_ALPHA,
  PPR_ITERATIONS,
  personalizedPageRankCombined
};
