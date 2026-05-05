const LINUCB_ALPHA = 0.25;
const D = 8;
const MIN_SAMPLES = 15;
const PRECISION_SWITCH = 50;
const VARIANCE_THRESHOLD = 0.05;
const ABSTAIN_THRESHOLD = 0.1;
const COST_PENALTY_ALPHA = 0.2;
const LOAD_BALANCE_LAMBDA = 0.01;
const TIME_BUDGET_MS = 500;
const SOFT_CUTOFF = 0.8;
function initStageTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_q (
      stage_id TEXT PRIMARY KEY,
      a_matrix TEXT NOT NULL,
      b_vector TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      total_reward REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      query_features TEXT NOT NULL,
      decision TEXT NOT NULL,
      quality_before REAL,
      quality_after REAL,
      compute_time_ms REAL,
      reward REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stage_log_stage ON stage_log(stage_id);
    CREATE INDEX IF NOT EXISTS idx_stage_log_session ON stage_log(session_id);
  `);
}
const STAGE_CONFIGS = [
  {
    id: "semantic_search",
    computeCostMs: 20,
    skipThreshold: 0.15,
    essential: true
  },
  { id: "bm25", computeCostMs: 10, skipThreshold: 0.15, essential: false },
  {
    id: "pagerank",
    computeCostMs: 30,
    skipThreshold: 0.2,
    essential: false
  },
  { id: "warmth", computeCostMs: 30, skipThreshold: 0.2, essential: false },
  {
    id: "hub_dampening",
    computeCostMs: 15,
    skipThreshold: 0.2,
    essential: false
  },
  {
    id: "gravity_dampening",
    computeCostMs: 10,
    skipThreshold: 0.2,
    essential: false
  },
  {
    id: "q_reranking",
    computeCostMs: 25,
    skipThreshold: 0.2,
    essential: false
  },
  {
    id: "cooccurrence_ppr",
    computeCostMs: 50,
    skipThreshold: 0.3,
    essential: false
  },
  {
    id: "rrf_fusion",
    computeCostMs: 5,
    skipThreshold: 0.1,
    essential: true
  }
];
function extractQueryFeatures(query, embeddingEntropy, vaultSize, queryDepth) {
  const tokens = query.split(/\s+/);
  const unique = new Set(tokens.map((t) => t.toLowerCase()));
  return [
    tokens.length / 50,
    Math.log1p(unique.size) / 10,
    /\?/.test(query) ? 1 : 0,
    /\b(recent|latest|today|yesterday|when)\b/i.test(query) ? 1 : 0,
    /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/.test(query) ? 1 : 0,
    embeddingEntropy / 10,
    vaultSize / 1e3,
    queryDepth / 10
  ];
}
class LinUCBStage {
  A;
  b;
  _sampleCount;
  _totalReward;
  config;
  constructor(config, saved) {
    this.config = config;
    if (saved) {
      this.A = saved.a;
      this.b = saved.b;
      this._sampleCount = saved.sampleCount;
      this._totalReward = saved.totalReward;
    } else {
      this.A = Array.from(
        { length: D },
        (_, i) => Array.from({ length: D }, (_2, j) => i === j ? 1 : 0)
      );
      this.b = new Array(D).fill(0);
      this._sampleCount = 0;
      this._totalReward = 0;
    }
  }
  get sampleCount() {
    return this._sampleCount;
  }
  get totalReward() {
    return this._totalReward;
  }
  getUCB(x) {
    const Ainv = invertMatrix(this.A);
    const theta = matVecMul(Ainv, this.b);
    const exploit = dot(theta, x);
    const explore = LINUCB_ALPHA * Math.sqrt(Math.max(0, dot(x, matVecMul(Ainv, x))));
    return exploit + explore;
  }
  update(x, reward) {
    for (let i = 0; i < D; i++) {
      for (let j = 0; j < D; j++) {
        this.A[i][j] += x[i] * x[j];
      }
    }
    for (let i = 0; i < D; i++) {
      this.b[i] += reward * x[i];
    }
    this._sampleCount++;
    this._totalReward += reward;
  }
  serialize() {
    return { a: this.A.map((row) => [...row]), b: [...this.b] };
  }
}
function getStageDecision(stage, x, elapsedMs, sampleCount) {
  if (stage.config.essential) return "run";
  if (elapsedMs > TIME_BUDGET_MS * SOFT_CUTOFF) return "skip";
  if (sampleCount < MIN_SAMPLES) return "run";
  const ucb = stage.getUCB(x);
  if (ucb < ABSTAIN_THRESHOLD) return "abstain";
  if (ucb < stage.config.skipThreshold) return "skip";
  return "run";
}
function computeStageReward(qualityBefore, qualityAfter, computeTimeMs) {
  const delta = qualityAfter - qualityBefore;
  const reward = delta * 10 - COST_PENALTY_ALPHA * (computeTimeMs / 100);
  return Math.max(-1, Math.min(1, reward));
}
function loadBalancePenalty(stageRunCounts, lambda = LOAD_BALANCE_LAMBDA) {
  const counts = [...stageRunCounts.values()];
  if (counts.length === 0) return 0;
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  if (mean === 0) return 0;
  const cv = Math.sqrt(
    counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length
  ) / mean;
  return lambda * cv * cv;
}
function saveStage(db, stage) {
  const { a, b } = stage.serialize();
  db.prepare(
    `
    INSERT INTO stage_q (stage_id, a_matrix, b_vector, sample_count, total_reward, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(stage_id) DO UPDATE SET
      a_matrix = ?, b_vector = ?, sample_count = ?, total_reward = ?, last_updated = datetime('now')
  `
  ).run(
    stage.config.id,
    JSON.stringify(a),
    JSON.stringify(b),
    stage.sampleCount,
    stage.totalReward,
    JSON.stringify(a),
    JSON.stringify(b),
    stage.sampleCount,
    stage.totalReward
  );
}
function loadStage(db, config) {
  const row = db.prepare(
    "SELECT a_matrix, b_vector, sample_count, total_reward FROM stage_q WHERE stage_id = ?"
  ).get(config.id);
  if (row) {
    return new LinUCBStage(config, {
      a: JSON.parse(row.a_matrix),
      b: JSON.parse(row.b_vector),
      sampleCount: row.sample_count,
      totalReward: row.total_reward
    });
  }
  return new LinUCBStage(config);
}
function logStageDecision(db, sessionId, stageId, queryFeatures, decision, qualityBefore, qualityAfter, computeTimeMs, reward) {
  db.prepare(
    `
    INSERT INTO stage_log
      (session_id, stage_id, query_features, decision,
       quality_before, quality_after, compute_time_ms, reward)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    sessionId,
    stageId,
    JSON.stringify(queryFeatures),
    decision,
    qualityBefore,
    qualityAfter,
    computeTimeMs,
    reward
  );
}
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
function matVecMul(M, v) {
  return M.map((row) => dot(row, v));
}
function invertMatrix(M) {
  const n = M.length;
  const aug = M.map(
    (row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]
  );
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col]))
        maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }
  return aug.map((row) => row.slice(n));
}
export {
  ABSTAIN_THRESHOLD,
  COST_PENALTY_ALPHA,
  D,
  LINUCB_ALPHA,
  LOAD_BALANCE_LAMBDA,
  LinUCBStage,
  MIN_SAMPLES,
  PRECISION_SWITCH,
  SOFT_CUTOFF,
  STAGE_CONFIGS,
  TIME_BUDGET_MS,
  VARIANCE_THRESHOLD,
  computeStageReward,
  dot,
  extractQueryFeatures,
  getStageDecision,
  initStageTables,
  invertMatrix,
  loadBalancePenalty,
  loadStage,
  logStageDecision,
  matVecMul,
  saveStage
};
