/**
 * Conversations index — searchable metadata for every chat session.
 *
 * Each user "session" (a `~/.koi/sessions/<id>/` directory containing
 * `dialogue.jsonl` + per-agent `conversation-*.json` files) gets one
 * row in a SQLite-backed table here. The row carries an auto-generated
 * title + 2-3 sentence summary + a single embedding vector of that
 * summary, so the GUI can:
 *   - list recent sessions ("Recent Sessions" submenu / drawer tab)
 *   - vector-search across them ("Open Session…" dialog)
 *
 * Storage layout — same `~/.koi/media-library/vector-cache/index.sqlite`
 * the media library uses, but a dedicated table `conversations` (not
 * the `media` table). Reusing the file keeps backups and ops simple
 * (one SQLite to ship), and the dedicated table avoids leaking
 * conversation rows into media queries.
 *
 * Indexing cadence — `scheduleConversationIndex()` debounces work for
 * 30 s after the last call per session. The debounce only fires when
 * at least 2 turns have happened since the last successful embed
 * (cheap guard against burning Haiku tokens on every keystroke /
 * tool result). On app exit / explicit flush, callers can fire the
 * pending job synchronously via `flushConversationIndex(sessionId)`.
 *
 * Failure model — every persistence call swallows errors and writes
 * to stderr. Indexing must NEVER block agent execution.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DB_DIR = path.join(os.homedir(), '.koi', 'media-library', 'vector-cache');
const TABLE = 'conversations';
const DEBOUNCE_MS = 30 * 1000;
const MIN_TURNS_BETWEEN_EMBEDS = 2;
// Cheap upper bound on the prompt we feed Haiku — the full conversation
// can be huge (long-running sessions accumulate hundreds of turns) and
// we only need enough context for a 2-3 sentence summary. Truncated
// from the TAIL because the most recent turns are the most informative
// for "what is this session about right now".
const SUMMARY_PROMPT_CHAR_BUDGET = 8000;

// ─── Singleton DB handle ────────────────────────────────────────────────

let _db = null;
let _dbPromise = null;
let _table = null;
let _tablePromise = null;

async function _ensureDb() {
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const { connect } = await import('./_sqlite-vector-adapter.js');
    fs.mkdirSync(DB_DIR, { recursive: true });
    _db = await connect(DB_DIR);
    return _db;
  })();
  return _dbPromise;
}

async function _ensureTable(embeddingDim) {
  if (_table) return _table;
  if (_tablePromise) return _tablePromise;
  _tablePromise = (async () => {
    const db = await _ensureDb();
    const names = await db.tableNames();
    if (names.includes(TABLE)) {
      _table = await db.openTable(TABLE);
    } else {
      // Seed row sets the schema (the adapter infers column types from
      // the first sample). We immediately delete it so the table reads
      // empty to consumers. The vector column needs a Float32Array of
      // the right size; if no embedding has been computed yet we fall
      // back to a sensible default.
      const dim = embeddingDim || 1536;
      const seed = {
        id: '__seed__',
        sessionId: '',
        sessionDir: '',
        projectRoot: '',
        title: '',
        summary: '',
        lastUserMsg: '',
        messageCount: 0,
        startedAt: '',
        updatedAt: '',
        embedding: new Float32Array(dim),
      };
      _table = await db.createTable(TABLE, [seed]);
      await _table.delete(`id = '__seed__'`);
    }
    return _table;
  })();
  return _tablePromise;
}

// ─── CRUD ───────────────────────────────────────────────────────────────

/**
 * Upsert (insert-or-replace) a conversation row by `sessionId`.
 * Caller is responsible for providing the embedding (computed via
 * `llmProvider.getEmbedding(summary)` upstream). We tolerate a missing
 * embedding by zero-filling — the row is still listable, just won't
 * surface in vector search until the next index pass.
 */
export async function upsertConversation(row) {
  if (!row?.sessionId) throw new Error('upsertConversation: sessionId required');
  const dim = row.embedding?.length || 1536;
  const table = await _ensureTable(dim);
  const now = new Date().toISOString();
  const out = {
    id: String(row.sessionId),
    sessionId: String(row.sessionId),
    sessionDir: row.sessionDir || '',
    projectRoot: row.projectRoot || '',
    title: row.title || '',
    summary: row.summary || '',
    lastUserMsg: row.lastUserMsg || '',
    messageCount: row.messageCount | 0,
    startedAt: row.startedAt || now,
    updatedAt: row.updatedAt || now,
    embedding: row.embedding instanceof Float32Array
      ? row.embedding
      : (Array.isArray(row.embedding) ? Float32Array.from(row.embedding) : new Float32Array(dim)),
  };
  await table.add([out]);
  return out;
}

/**
 * Newest-first list, optionally filtered to a working dir.
 * `after` is an updatedAt ISO string — strictly less-than for paging.
 */
export async function listConversations({ projectRoot = null, limit = 50, after = null } = {}) {
  const table = await _ensureTable();
  const wheres = [];
  if (projectRoot) wheres.push(`projectRoot = '${_escapeSqlString(projectRoot)}'`);
  if (after) wheres.push(`updatedAt < '${_escapeSqlString(after)}'`);
  const where = wheres.length ? wheres.join(' AND ') : null;
  // The adapter's query builder doesn't have ORDER BY — pull what fits
  // and sort client-side. With realistic session counts (low
  // thousands) this is fine; if it ever bites we add ORDER BY into
  // the adapter.
  const rows = where
    ? await table.query().where(where).limit(Math.max(limit * 4, 200)).toArray()
    : await table.query().limit(Math.max(limit * 4, 200)).toArray();
  rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // Strip the embedding from list responses — it's a 6 KB float blob
  // per row that the GUI never needs in this codepath. Search is the
  // only consumer, and search reads it directly from SQLite.
  return rows.slice(0, limit).map(_stripEmbedding);
}

/**
 * Vector KNN search. Caller passes the QUERY text + an llmProvider so
 * we can embed locally; this keeps the API symmetrical with the
 * upsert path (callers don't have to import the embedding module).
 */
export async function searchConversations({ query, projectRoot = null, k = 20, llmProvider }) {
  if (!query || !String(query).trim()) {
    return await listConversations({ projectRoot, limit: k });
  }
  if (!llmProvider) throw new Error('searchConversations: llmProvider required for vector search');
  const queryVec = await llmProvider.getEmbedding(String(query));
  if (!queryVec || (queryVec.length || 0) === 0) {
    // Embedding unavailable (offline / model down) — degrade to recents.
    return await listConversations({ projectRoot, limit: k });
  }
  const table = await _ensureTable(queryVec.length);
  let builder = table.search(queryVec);
  if (projectRoot) {
    builder = builder.where(`projectRoot = '${_escapeSqlString(projectRoot)}'`);
  }
  const rows = await builder.limit(k).toArray();
  return rows.map(_stripEmbedding);
}

/** Single-row lookup. Returns null if not indexed yet. */
export async function getConversation(sessionId) {
  if (!sessionId) return null;
  const table = await _ensureTable();
  const rows = await table.query().where(`id = '${_escapeSqlString(sessionId)}'`).limit(1).toArray();
  return rows.length ? _stripEmbedding(rows[0]) : null;
}

/** Manual delete — removes the row but does NOT touch the on-disk
 *  session dir (the dialogue / git history is canonical). */
export async function deleteConversation(sessionId) {
  if (!sessionId) return;
  const table = await _ensureTable();
  await table.delete(`id = '${_escapeSqlString(sessionId)}'`);
}

// ─── Indexing pipeline (title + summary + embedding) ────────────────────

/**
 * Per-session debounce state. Each entry tracks:
 *   - pending timer (Node Timeout)
 *   - last successful index's messageCount (for the ≥N-turns guard)
 *   - inflight flag (so a flush during an in-progress run is a no-op
 *     instead of stacking jobs)
 *
 * Lives in module scope — agents call schedule() from their save
 * paths and the same Map decides whether a previous job is still
 * cooking.
 */
const _state = new Map(); // sessionId -> { timer, lastEmbeddedCount, inflight, llmProvider, projectRoot, sessionDir }

/**
 * Queue an index pass for a session. Cheap to call repeatedly; the
 * debounce coalesces bursts (typing → tool call → assistant response
 * all save in quick succession) into a single Haiku + embed round.
 *
 * @param {Object} req
 * @param {string} req.sessionId
 * @param {string} req.projectRoot
 * @param {Object} req.llmProvider — must expose simpleChat() + getEmbedding()
 * @param {string} [req.sessionDir] — overrides the default sessions path lookup
 */
export function scheduleConversationIndex({ sessionId, projectRoot, llmProvider, sessionDir }) {
  if (!sessionId || !llmProvider) return;
  const dir = sessionDir || _defaultSessionDir(projectRoot, sessionId);
  let entry = _state.get(sessionId);
  if (!entry) {
    entry = { timer: null, lastEmbeddedCount: 0, inflight: false };
    _state.set(sessionId, entry);
  }
  // Refresh the bookkeeping in case projectRoot or llmProvider changed
  // between calls (e.g. user switched working dir mid-session).
  entry.projectRoot = projectRoot;
  entry.sessionDir = dir;
  entry.llmProvider = llmProvider;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    _runIndex(sessionId).catch((err) => {
      process.stderr.write(`[conversations] index ${sessionId} failed: ${err.message}\n`);
    });
  }, DEBOUNCE_MS);
}

/**
 * Backfill the conversations index for every session under
 * `<projectRoot>/.koi/sessions/` that doesn't have a row yet (or whose
 * row is older than the dialogue file's mtime). Idempotent: rows that
 * are already up-to-date get skipped.
 *
 * Designed to run ONCE per (process × projectRoot), fired by
 * session-tracker the first time it sees a project. Best-effort, fully
 * concurrent — failures on a single session never block the others.
 *
 * @param {Object} req
 * @param {string} req.projectRoot
 * @param {Object} req.llmProvider — must expose simpleChat() + getEmbedding()
 * @param {number} [req.maxConcurrency=2] — bound LLM calls so backfill
 *   doesn't drown out the active session's traffic.
 */
export async function backfillConversationIndex({ projectRoot, llmProvider, maxConcurrency = 2 }) {
  if (!projectRoot || !llmProvider) return;
  const sessionsDir = path.join(projectRoot, '.koi', 'sessions');
  let sessionDirs;
  try {
    sessionDirs = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, dir: path.join(sessionsDir, d.name) }));
  } catch {
    return; // No sessions dir yet — nothing to backfill.
  }
  if (sessionDirs.length === 0) return;

  // Pre-fetch existing rows so we don't ping the LLM for sessions
  // already indexed at the same dialogue mtime. Cheap: one query.
  const indexed = new Map(); // sessionId -> updatedAt ISO
  try {
    const existing = await listConversations({ projectRoot, limit: 10000 });
    for (const row of existing) indexed.set(row.sessionId, row.updatedAt);
  } catch { /* ignore — table may not exist yet */ }

  const todo = [];
  for (const { id, dir } of sessionDirs) {
    const dialogueFp = path.join(dir, 'dialogue.jsonl');
    let mtime;
    try { mtime = fs.statSync(dialogueFp).mtimeMs; }
    catch { continue; } // No dialogue → nothing to summarise.
    const indexedAt = indexed.get(id);
    if (indexedAt) {
      const indexedMs = Date.parse(indexedAt);
      if (Number.isFinite(indexedMs) && indexedMs >= mtime) continue;
    }
    todo.push({ id, dir });
  }
  if (todo.length === 0) return;

  process.stderr.write(
    `[conversations] backfill: ${todo.length} session(s) under ${projectRoot}\n`,
  );

  // Hand-rolled concurrency limiter (avoids pulling in p-limit). Slot
  // budget = maxConcurrency; each worker pulls from the queue until
  // empty. Keeps the LLM hot but bounded.
  const queue = todo.slice();
  const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, () =>
    (async () => {
      while (queue.length) {
        const { id, dir } = queue.shift();
        try {
          // Reuse the schedule path so the same code that runs
          // live-during-typing also handles backfill — single source
          // of truth for title/summary/embedding logic.
          scheduleConversationIndex({
            sessionId: id,
            projectRoot,
            llmProvider,
            sessionDir: dir,
          });
          // ...then force-flush so the timer doesn't wait its full
          // 30s window per session (we'd be here for hours otherwise).
          await flushConversationIndex(id);
        } catch (err) {
          process.stderr.write(`[conversations] backfill ${id} failed: ${err.message}\n`);
        }
      }
    })(),
  );
  await Promise.all(workers);
  process.stderr.write(`[conversations] backfill complete\n`);
}

/**
 * Force the pending index for a session to run NOW (await-able).
 * Useful at session-close / app exit so we don't lose the last debounce
 * window. No-op if no work pending.
 */
export async function flushConversationIndex(sessionId) {
  const entry = _state.get(sessionId);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.inflight) return; // Concurrent run already in flight.
  await _runIndex(sessionId);
}

async function _runIndex(sessionId) {
  const entry = _state.get(sessionId);
  if (!entry) return;
  if (entry.inflight) return;
  entry.inflight = true;
  try {
    const turns = _readDialogueTurns(entry.sessionDir);
    if (turns.length < 2) return; // Nothing meaningful to summarise yet.
    const turnCount = turns.length;
    if (turnCount - entry.lastEmbeddedCount < MIN_TURNS_BETWEEN_EMBEDS) {
      return; // Not enough new material since last embed.
    }
    const summaryInput = _buildSummaryInput(turns);
    const lastUserMsg = _extractLastUserMsg(turns);
    const startedAt = _readSessionStartedAt(entry.sessionDir, turns);

    let title = '';
    let summary = '';
    try {
      const raw = await entry.llmProvider.simpleChat(_titleSummaryPrompt(summaryInput), {
        timeoutMs: 20000,
      });
      ({ title, summary } = _parseTitleSummary(raw));
    } catch (err) {
      process.stderr.write(`[conversations] LLM title/summary failed for ${sessionId}: ${err.message}\n`);
      // Fall back to a degraded entry — better an indexed row with a
      // mediocre title than no row at all (the user still sees it in
      // the recent list, search just won't find it semantically yet).
      title = _degradedTitle(turns);
      summary = lastUserMsg.slice(0, 280);
    }

    let embedding = null;
    try {
      embedding = await entry.llmProvider.getEmbedding(summary || title || lastUserMsg);
    } catch (err) {
      process.stderr.write(`[conversations] embedding failed for ${sessionId}: ${err.message}\n`);
    }

    await upsertConversation({
      sessionId,
      sessionDir: entry.sessionDir,
      projectRoot: entry.projectRoot || '',
      title,
      summary,
      lastUserMsg,
      messageCount: turnCount,
      startedAt,
      updatedAt: new Date().toISOString(),
      embedding,
    });
    entry.lastEmbeddedCount = turnCount;
  } finally {
    entry.inflight = false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function _defaultSessionDir(projectRoot, sessionId) {
  if (!projectRoot || !sessionId) return '';
  return path.join(projectRoot, '.koi', 'sessions', sessionId);
}

function _readDialogueTurns(sessionDir) {
  if (!sessionDir) return [];
  const fp = path.join(sessionDir, 'dialogue.jsonl');
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

function _readSessionStartedAt(sessionDir, turns) {
  // Prefer the timestamp on the first dialogue entry — that's the
  // user's first input. Fall back to the sessions dir mtime.
  const first = turns.find((t) => typeof t.ts === 'number');
  if (first) return new Date(first.ts).toISOString();
  try {
    const stat = fs.statSync(sessionDir);
    return new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function _extractLastUserMsg(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.type === 'user_input' && typeof t.text === 'string') return t.text;
  }
  return '';
}

/**
 * Pack the most recent turns into a budget-bounded transcript for
 * Haiku. Tail-first because recent context is the most signal-dense
 * for "what is this session about right now".
 */
function _buildSummaryInput(turns) {
  const parts = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    let line;
    if (t.type === 'user_input') line = `User: ${t.text || ''}`;
    else if (t.type === 'action') line = `Assistant action ${t.intent || ''}: ${t.result || ''}`;
    else if (t.type === 'assistant_message' || t.type === 'assistant_response') line = `Assistant: ${t.text || ''}`;
    else continue;
    line = line.slice(0, 600); // Cap any single line so a giant tool result doesn't eat the whole budget.
    if (used + line.length + 1 > SUMMARY_PROMPT_CHAR_BUDGET) break;
    parts.unshift(line);
    used += line.length + 1;
  }
  return parts.join('\n');
}

function _titleSummaryPrompt(transcript) {
  return [
    'You are summarising a chat transcript for a "Recent Sessions" sidebar (think ChatGPT history).',
    'Output EXACTLY this format and nothing else:',
    'TITLE: <a single short title, max 6 words, no quotes, no trailing punctuation, in the same language the user wrote>',
    'SUMMARY: <2-3 sentences describing what the user is trying to do and what was discussed; objective, not a recap of "the user asked X and the assistant replied Y">',
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

function _parseTitleSummary(raw) {
  const text = String(raw || '').trim();
  // Tolerant parser — accept lowercase keys, extra whitespace, missing
  // SUMMARY (treat the rest as summary).
  const titleMatch = text.match(/^\s*title\s*:\s*(.+?)\s*$/im);
  const summaryMatch = text.match(/summary\s*:\s*([\s\S]+?)\s*$/i);
  let title = titleMatch ? titleMatch[1].trim() : '';
  let summary = summaryMatch ? summaryMatch[1].trim() : '';
  // Strip stray surrounding quotes Haiku sometimes adds.
  title = title.replace(/^["'`]|["'`]$/g, '').trim();
  // Cap defensively — keeps the GUI rows compact and the embedding
  // input bounded.
  if (title.length > 80) title = title.slice(0, 77) + '…';
  if (summary.length > 800) summary = summary.slice(0, 797) + '…';
  if (!title && summary) {
    // Fallback: derive a title from the first sentence of the summary.
    const firstSent = summary.split(/[.!?]/)[0].trim();
    title = firstSent.length > 60 ? firstSent.slice(0, 57) + '…' : firstSent;
  }
  return { title, summary };
}

function _degradedTitle(turns) {
  const firstUser = turns.find((t) => t.type === 'user_input');
  if (firstUser?.text) {
    const t = firstUser.text.replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }
  return 'Session';
}

function _stripEmbedding(row) {
  if (!row) return row;
  const { embedding, ...rest } = row;
  return rest;
}

/** Minimal escaper for SQL string literals — the adapter accepts
 *  legacy double-quoted strings, but we keep single-quote escapes
 *  conservative since session ids and project paths can contain
 *  quotes. Doubling single-quotes is the SQL-standard escape. */
function _escapeSqlString(s) {
  return String(s).replace(/'/g, "''");
}
