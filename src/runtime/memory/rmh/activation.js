const DEFAULT_ACTIVATION_CONFIG = {
  enabled: true,
  damping: 0.6,
  max_hops: 2,
  min_boost: 0.01
};
function computeActivationSpread(source, utility, linkGraph, config = DEFAULT_ACTIVATION_CONFIG) {
  const propagated = /* @__PURE__ */ new Map();
  if (!config.enabled || utility <= 0 || config.max_hops <= 0) {
    return { source, utility, propagated };
  }
  const visited = /* @__PURE__ */ new Set();
  visited.add(source);
  let frontier = [[source, 0]];
  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const [node, hop] of frontier) {
      if (hop >= config.max_hops) continue;
      const outgoing = linkGraph.outgoing.get(node);
      const incoming = linkGraph.incoming.get(node);
      const neighbors = /* @__PURE__ */ new Set();
      if (outgoing) for (const n of outgoing) neighbors.add(n);
      if (incoming) for (const n of incoming) neighbors.add(n);
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        const nextHop = hop + 1;
        const boost = utility * Math.pow(config.damping, nextHop);
        if (boost >= config.min_boost) {
          propagated.set(neighbor, boost);
          nextFrontier.push([neighbor, nextHop]);
        }
      }
    }
    frontier = nextFrontier;
  }
  return { source, utility, propagated };
}
const BASE_DECAY_RATE = 0.1;
const PER_QUERY_CAP = 0.05;
function ebbinghausDecayRate(accessCount, sessionCount) {
  const strengthening = 0.2 * Math.log1p(accessCount) + 0.3 * Math.log1p(sessionCount);
  return BASE_DECAY_RATE / (1 + strengthening);
}
function loadBoosts(db) {
  const rows = db.prepare("SELECT title, boost, updated, access_count, sessions FROM boosts").all();
  const now = /* @__PURE__ */ new Date();
  const result = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const updatedDate = new Date(row.updated);
    const daysSinceUpdate = Math.max(0, (now.getTime() - updatedDate.getTime()) / (1e3 * 60 * 60 * 24));
    const accessCount = row.access_count ?? 1;
    const sessionCount = row.sessions ? row.sessions.split(",").filter(Boolean).length : 1;
    const decayRate = ebbinghausDecayRate(accessCount, sessionCount);
    const decayedBoost = row.boost * Math.exp(-decayRate * daysSinceUpdate);
    if (decayedBoost >= 1e-3) {
      result.set(row.title, decayedBoost);
    }
  }
  return result;
}
function applyActivationBoosts(db, boosts, sessionId) {
  if (boosts.size === 0) return;
  const now = /* @__PURE__ */ new Date();
  const nowISO = now.toISOString();
  const selectStmt = db.prepare("SELECT boost, updated, access_count, sessions FROM boosts WHERE title = ?");
  const upsertStmt = db.prepare(
    "INSERT OR REPLACE INTO boosts (title, boost, updated, access_count, sessions) VALUES (?, ?, ?, ?, ?)"
  );
  const transaction = db.transaction(() => {
    for (const [title, newBoost] of boosts) {
      const cappedBoost = Math.min(newBoost, PER_QUERY_CAP);
      const existing = selectStmt.get(title);
      const accessCount = (existing?.access_count ?? 0) + 1;
      const existingSessions = existing?.sessions ? existing.sessions.split(",").filter(Boolean) : [];
      const sessionSet = new Set(existingSessions);
      if (sessionId) sessionSet.add(sessionId);
      const sessionCount = sessionSet.size || 1;
      const decayRate = ebbinghausDecayRate(accessCount - 1, sessionCount);
      const decayedExisting = existing ? existing.boost * Math.exp(-decayRate * Math.max(
        0,
        (now.getTime() - new Date(existing.updated).getTime()) / (1e3 * 60 * 60 * 24)
      )) : 0;
      const finalBoost = 1 - (1 - decayedExisting) * (1 - cappedBoost);
      const sessionsStr = [...sessionSet].slice(-20).join(",");
      upsertStmt.run(title, finalBoost, nowISO, accessCount, sessionsStr);
    }
  });
  transaction();
}
export {
  DEFAULT_ACTIVATION_CONFIG,
  applyActivationBoosts,
  computeActivationSpread,
  ebbinghausDecayRate,
  loadBoosts
};
