const GLOVE_XMAX = 100;
const GLOVE_ALPHA = 0.75;
const EBBINGHAUS_BASE_DAYS = 30;
const STRENGTH_RATE = 0.2;
const DECAY_FLOOR = 0.05;
const HOMEOSTASIS_TARGET = 0.5;
const BOOTSTRAP_BCS_THRESHOLD = 0.1;
const BOOTSTRAP_INIT_WEIGHT = 0.15;
function initCoOccurrenceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_occurrence (
      note_a TEXT NOT NULL,
      note_b TEXT NOT NULL,
      co_retrieval_count INTEGER NOT NULL DEFAULT 1,
      npmi_weight REAL,
      trust_weight REAL NOT NULL DEFAULT 1.0,
      first_observed TEXT NOT NULL DEFAULT (datetime('now')),
      last_co_retrieved TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'retrieval',
      PRIMARY KEY (note_a, note_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cooc_a ON co_occurrence(note_a);
    CREATE INDEX IF NOT EXISTS idx_cooc_b ON co_occurrence(note_b);
  `);
}
function computeNPMI(countAB, countA, countB, totalEvents) {
  if (countAB === 0 || totalEvents === 0) return -1;
  const pAB = countAB / totalEvents;
  const pA = countA / totalEvents;
  const pB = countB / totalEvents;
  if (pA === 0 || pB === 0) return -1;
  const pmi = Math.log(pAB / (pA * pB));
  const denom = -Math.log(pAB);
  return denom === 0 ? 0 : pmi / denom;
}
function gloveWeight(count) {
  return count < GLOVE_XMAX ? Math.pow(count / GLOVE_XMAX, GLOVE_ALPHA) : 1;
}
function edgeDecay(daysSince, coRetrievalCount) {
  const strength = 1 + STRENGTH_RATE * Math.log1p(coRetrievalCount);
  const retention = Math.exp(-daysSince / (EBBINGHAUS_BASE_DAYS * strength));
  return Math.max(DECAY_FLOOR, retention);
}
function computeEdgeWeight(coRetrievalCount, totalRetrievalsA, totalRetrievalsB, totalEvents, daysSince, trustWeight = 1) {
  const npmi = computeNPMI(
    coRetrievalCount,
    totalRetrievalsA,
    totalRetrievalsB,
    totalEvents
  );
  const freq = gloveWeight(coRetrievalCount);
  const decay = edgeDecay(daysSince, coRetrievalCount);
  return Math.max(0, npmi * freq * trustWeight * decay);
}
function recordCoRetrieval(db, noteA, noteB, trustWeight = 1) {
  const [a, b] = noteA < noteB ? [noteA, noteB] : [noteB, noteA];
  db.prepare(
    `
    INSERT INTO co_occurrence (note_a, note_b, co_retrieval_count, trust_weight, source)
    VALUES (?, ?, 1, ?, 'retrieval')
    ON CONFLICT(note_a, note_b) DO UPDATE SET
      co_retrieval_count = co_retrieval_count + 1,
      last_co_retrieved = datetime('now')
  `
  ).run(a, b, trustWeight);
}
function extractCoOccurrencePairs(db, sessionId) {
  const rows = db.prepare(
    `
    SELECT query_text, GROUP_CONCAT(note_id) as notes
    FROM retrieval_log
    WHERE session_id = ?
    GROUP BY query_text
  `
  ).all(sessionId);
  for (const row of rows) {
    const notes = row.notes.split(",");
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        recordCoRetrieval(db, notes[i], notes[j]);
      }
    }
  }
}
function runHomeostasis(db) {
  const nodeStats = db.prepare(
    `
    SELECT node, AVG(w) as mean_w FROM (
      SELECT note_a as node, npmi_weight as w FROM co_occurrence WHERE npmi_weight IS NOT NULL
      UNION ALL
      SELECT note_b as node, npmi_weight as w FROM co_occurrence WHERE npmi_weight IS NOT NULL
    )
    GROUP BY node
  `
  ).all();
  const tx = db.transaction(() => {
    for (const { node, mean_w } of nodeStats) {
      if (mean_w === 0 || mean_w === HOMEOSTASIS_TARGET) continue;
      const scale = HOMEOSTASIS_TARGET / mean_w;
      db.prepare(
        `
        UPDATE co_occurrence SET npmi_weight = npmi_weight * ?
        WHERE note_a = ? AND npmi_weight IS NOT NULL
      `
      ).run(scale, node);
      db.prepare(
        `
        UPDATE co_occurrence SET npmi_weight = npmi_weight * ?
        WHERE note_b = ? AND npmi_weight IS NOT NULL
      `
      ).run(scale, node);
    }
  });
  tx();
}
function recomputeAllNPMI(db) {
  const totalEvents = db.prepare(
    "SELECT COUNT(DISTINCT session_id || '|' || query_text) as n FROM retrieval_log"
  ).get().n;
  if (totalEvents === 0) return;
  const edges = db.prepare(
    "SELECT note_a, note_b, co_retrieval_count, last_co_retrieved FROM co_occurrence"
  ).all();
  const noteCounts = /* @__PURE__ */ new Map();
  const rows = db.prepare(
    "SELECT note_id, COUNT(*) as cnt FROM retrieval_log GROUP BY note_id"
  ).all();
  for (const r of rows) noteCounts.set(r.note_id, r.cnt);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const edge of edges) {
      const countA = noteCounts.get(edge.note_a) ?? 0;
      const countB = noteCounts.get(edge.note_b) ?? 0;
      const daysSince = (now - new Date(edge.last_co_retrieved).getTime()) / 864e5;
      const weight = computeEdgeWeight(
        edge.co_retrieval_count,
        countA,
        countB,
        totalEvents,
        daysSince
      );
      db.prepare(
        "UPDATE co_occurrence SET npmi_weight = ? WHERE note_a = ? AND note_b = ?"
      ).run(weight, edge.note_a, edge.note_b);
    }
  });
  tx();
}
function bootstrapFromWikiLinks(db, noteLinks) {
  const notes = [...noteLinks.keys()].sort();
  const tx = db.transaction(() => {
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const linksA = noteLinks.get(notes[i]);
        const linksB = noteLinks.get(notes[j]);
        const intersection = new Set(
          [...linksA].filter((x) => linksB.has(x))
        );
        if (intersection.size === 0) continue;
        const bcs = intersection.size / Math.sqrt(linksA.size * linksB.size);
        if (bcs < BOOTSTRAP_BCS_THRESHOLD) continue;
        db.prepare(
          `
          INSERT OR IGNORE INTO co_occurrence
            (note_a, note_b, co_retrieval_count, npmi_weight, source)
          VALUES (?, ?, 0, ?, 'bootstrap')
        `
        ).run(notes[i], notes[j], bcs * BOOTSTRAP_INIT_WEIGHT);
      }
    }
  });
  tx();
}
export {
  BOOTSTRAP_BCS_THRESHOLD,
  BOOTSTRAP_INIT_WEIGHT,
  DECAY_FLOOR,
  EBBINGHAUS_BASE_DAYS,
  GLOVE_ALPHA,
  GLOVE_XMAX,
  HOMEOSTASIS_TARGET,
  STRENGTH_RATE,
  bootstrapFromWikiLinks,
  computeEdgeWeight,
  computeNPMI,
  edgeDecay,
  extractCoOccurrencePairs,
  gloveWeight,
  initCoOccurrenceTables,
  recomputeAllNPMI,
  recordCoRetrieval,
  runHomeostasis
};
