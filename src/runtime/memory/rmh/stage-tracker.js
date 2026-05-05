class StageTracker {
  snapshots = /* @__PURE__ */ new Map();
  results = [];
  before(stageId, currentQuality) {
    this.snapshots.set(stageId, {
      stageId,
      qualityBefore: currentQuality,
      startTime: performance.now()
    });
  }
  after(stageId, currentQuality) {
    const snap = this.snapshots.get(stageId);
    if (!snap) return;
    this.results.push({
      stageId,
      qualityBefore: snap.qualityBefore,
      qualityAfter: currentQuality,
      computeMs: performance.now() - snap.startTime
    });
    this.snapshots.delete(stageId);
  }
  getResults() {
    return this.results;
  }
  hasResults() {
    return this.results.length > 0;
  }
  /** Drain results for per-query processing and reset for the next query. */
  drain() {
    const drained = this.results;
    this.results = [];
    return drained;
  }
}
function measureCurrentQuality(candidates) {
  const top5 = candidates.slice(0, 5);
  return top5.reduce((s, c) => s + c.score, 0) / (top5.length || 1);
}
export {
  StageTracker,
  measureCurrentQuality
};
