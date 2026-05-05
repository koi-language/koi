const ALPHA = 0.1;
const DEFAULT_Q = 0.5;
const DECAY_RATE = 7e-3;
const EXPOSURE_BETA = 0.5;
function initQValueTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_q (
      note_id TEXT PRIMARY KEY,
      q_value REAL NOT NULL DEFAULT 0.5,
      update_count INTEGER NOT NULL DEFAULT 0,
      exposure_count INTEGER NOT NULL DEFAULT 0,
      reward_sum REAL NOT NULL DEFAULT 0,
      reward_sq_sum REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      last_reward REAL,
      created TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS q_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      old_q REAL NOT NULL,
      new_q REAL NOT NULL,
      reward REAL NOT NULL,
      reward_source TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS retrieval_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      query_text TEXT NOT NULL,
      query_type TEXT,
      note_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      similarity_score REAL,
      q_score REAL,
      ucb_bonus REAL,
      final_score REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_q_history_note ON q_history(note_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_note ON retrieval_log(note_id);
  `);
}
function getQ(db, noteId) {
  const row = db.prepare("SELECT q_value FROM note_q WHERE note_id = ?").get(noteId);
  return row?.q_value ?? DEFAULT_Q;
}
function getDecayedQ(db, noteId) {
  const row = db.prepare("SELECT q_value, last_updated FROM note_q WHERE note_id = ?").get(noteId);
  if (!row) return DEFAULT_Q;
  const daysSince = (Date.now() - new Date(row.last_updated).getTime()) / 864e5;
  let mult = 1;
  if (row.q_value >= 0.7) mult = 0.7;
  else if (row.q_value <= 0.3) mult = 1.3;
  return row.q_value * Math.exp(-DECAY_RATE * mult * daysSince);
}
function getRewardStats(db, noteId) {
  const row = db.prepare(
    "SELECT update_count, reward_sum, reward_sq_sum FROM note_q WHERE note_id = ?"
  ).get(noteId);
  if (!row || row.update_count === 0)
    return { mean: 0, variance: 0.25, count: 0 };
  const mean = row.reward_sum / row.update_count;
  const variance = row.reward_sq_sum / row.update_count - mean * mean;
  return { mean, variance: Math.max(0, variance), count: row.update_count };
}
function getExposureCount(db, noteId) {
  const row = db.prepare("SELECT exposure_count FROM note_q WHERE note_id = ?").get(noteId);
  return row?.exposure_count ?? 0;
}
function getTotalQUpdates(db) {
  const row = db.prepare("SELECT COALESCE(SUM(update_count), 0) as total FROM note_q").get();
  return row.total;
}
function getTotalQueryCount(db) {
  const row = db.prepare(
    "SELECT COUNT(DISTINCT session_id || '|' || query_text) as total FROM retrieval_log"
  ).get();
  return row.total;
}
function updateQ(db, noteId, reward, sessionId) {
  const oldQ = getQ(db, noteId);
  const newQ = oldQ + ALPHA * (reward - oldQ);
  db.prepare(
    `
    INSERT INTO note_q (note_id, q_value, update_count, reward_sum, reward_sq_sum, last_updated, last_reward)
    VALUES (?, ?, 1, ?, ?, datetime('now'), ?)
    ON CONFLICT(note_id) DO UPDATE SET
      q_value = ?,
      update_count = update_count + 1,
      reward_sum = reward_sum + ?,
      reward_sq_sum = reward_sq_sum + ?,
      last_updated = datetime('now'),
      last_reward = ?
  `
  ).run(
    noteId,
    newQ,
    reward,
    reward * reward,
    reward,
    newQ,
    reward,
    reward * reward,
    reward
  );
  db.prepare(
    `
    INSERT INTO q_history (note_id, old_q, new_q, reward, reward_source, session_id)
    VALUES (?, ?, ?, ?, 'session_batch', ?)
  `
  ).run(noteId, oldQ, newQ, reward, sessionId);
}
function incrementExposure(db, noteId) {
  db.prepare(
    `
    INSERT INTO note_q (note_id, exposure_count)
    VALUES (?, 1)
    ON CONFLICT(note_id) DO UPDATE SET exposure_count = exposure_count + 1
  `
  ).run(noteId);
}
function logRetrieval(db, sessionId, queryText, queryType, noteId, rank, simScore, qScore, ucbBonus, finalScore) {
  db.prepare(
    `
    INSERT INTO retrieval_log
      (session_id, query_text, query_type, note_id, rank,
       similarity_score, q_score, ucb_bonus, final_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    sessionId,
    queryText,
    queryType,
    noteId,
    rank,
    simScore,
    qScore,
    ucbBonus,
    finalScore
  );
}
function explorationBonus(stats, totalQueries, c = 0.2) {
  if (stats.count === 0) return c * 2.5;
  const logT = Math.log(totalQueries + 1);
  const V = stats.variance + Math.sqrt(2 * logT / stats.count);
  return c * Math.sqrt(logT / stats.count * Math.min(0.25, V));
}
function batchUpdateQ(db, rewards, sessionId) {
  const tx = db.transaction(() => {
    for (const [noteId, reward] of rewards) {
      updateQ(db, noteId, reward, sessionId);
    }
  });
  tx();
}
export {
  ALPHA,
  DECAY_RATE,
  DEFAULT_Q,
  EXPOSURE_BETA,
  batchUpdateQ,
  explorationBonus,
  getDecayedQ,
  getExposureCount,
  getQ,
  getRewardStats,
  getTotalQUpdates,
  getTotalQueryCount,
  incrementExposure,
  initQValueTables,
  logRetrieval,
  updateQ
};
