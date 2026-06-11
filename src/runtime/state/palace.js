/**
 * Conversation memory palace — verbatim per-exchange recall with topic rooms.
 *
 * MemPalace-inspired hierarchy over past conversations:
 *   - WING   = a project (`projectRoot`). Implicit — a column, not a table.
 *   - ROOM   = a topic, discovered by online embedding-centroid clustering.
 *              The LLM is consulted ONCE per room, at creation time, only to
 *              produce a human label (never to classify — assignment is pure
 *              cosine-vs-centroid, no keyword matching).
 *   - DRAWER = one verbatim user→assistant exchange + one embedding.
 *
 * This complements (does NOT replace) two existing systems:
 *   - The RMH memory vault (`.koi/memory`) — curated notes. Untouched.
 *   - The `conversations` table — one title+summary row per session for the
 *     GUI session list. Untouched; the palace stores per-MESSAGE drawers so
 *     recall finds the literal sentence from three weeks ago, not just a
 *     lossy session summary.
 *
 * Storage — same `~/.koi/media-library/vector-cache/index.sqlite` the
 * conversations index uses (one SQLite to ship), dedicated `palace_*` tables.
 *
 * Ingestion — `sweepSessionIntoPalace()` rides the conversations debounce
 * (called from `_runIndex()` in conversations.js), so flush-on-exit and the
 * per-session inflight guard come for free. Idempotent via a per-session
 * watermark (`palace_meta.sweptPairStart`) + per-drawer content hash: the
 * LAST swept pair is always re-swept so assistant chunks that land after a
 * sweep get folded into the same drawer (INSERT OR REPLACE by id).
 *
 * Failure model — every call swallows errors and writes to stderr. Palace
 * work must NEVER block agent execution.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { buildBM25Index, searchBM25 } from '../memory/rmh/bm25.js';
import { fuseScoreWeightedRRF } from '../memory/rmh/fusion.js';

const DB_DIR = path.join(os.homedir(), '.koi', 'media-library', 'vector-cache');
const DRAWERS_TABLE = 'palace_drawers';
const ROOMS_TABLE = 'palace_rooms';
const META_TABLE = 'palace_meta';

// Cosine-similarity floor for joining an existing room. Below it, a new room
// is created. OpenAI text-embedding-3 puts same-topic pairs around 0.4-0.6
// and unrelated text below ~0.25 — start at 0.45 and tune via env if rooms
// proliferate (lower = fewer, broader rooms).
const ROOM_THRESHOLD = Number(process.env.KOI_PALACE_ROOM_THRESHOLD) || 0.45;
// Hard cap per wing — beyond it, drawers join their nearest room regardless
// of threshold so a degenerate corpus can't mint unbounded rooms.
const MAX_ROOMS_PER_WING = 200;
// The STORED drawer text is always full (verbatim contract). Only the
// embedding input is truncated — enough signal for retrieval, bounded cost.
const EMBED_USER_BUDGET = 2500;
const EMBED_ASSISTANT_BUDGET = 3500;
// Caps for the snippet returned to the agent in tool payloads.
const SNIPPET_USER_CAP = 500;
const SNIPPET_ASSISTANT_CAP = 700;
// dialogue.jsonl logs user-visible assistant prose as `action` turns with
// these intents and the FULL text in `result` (see agent.js — other actions
// only carry a 200-char preview, which would pollute verbatim recall).
const ASSISTANT_PROSE_INTENTS = new Set(['print', 'assistant_message', 'show_result']);

// KOI_PALACE_DEBUG=1 → verbose stderr tracing (per-pair sweep decisions,
// room joins, search candidates). Default logging is success-summary only
// (drawers written, rooms created, backfill) + every failure.
const DEBUG = process.env.KOI_PALACE_DEBUG === '1';
function _log(msg) {
  process.stderr.write(`[palace] ${msg}\n`);
}
function _debug(msg) {
  if (DEBUG) process.stderr.write(`[palace:debug] ${msg}\n`);
}

// ─── Singleton DB / table handles ───────────────────────────────────────

let _db = null;
let _dbPromise = null;
const _tables = new Map(); // name -> table
const _tablePromises = new Map(); // name -> promise

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

/**
 * Open-or-create a palace table. Same seed-row trick as conversations.js:
 * the adapter infers column types from the first sample, then we delete the
 * seed so the table reads empty.
 */
async function _ensureTable(name, seedFactory, embeddingDim) {
  if (_tables.has(name)) return _tables.get(name);
  if (_tablePromises.has(name)) return _tablePromises.get(name);
  const promise = (async () => {
    const db = await _ensureDb();
    const names = await db.tableNames();
    let table;
    if (names.includes(name)) {
      table = await db.openTable(name);
    } else {
      const seed = seedFactory(embeddingDim || 1536);
      table = await db.createTable(name, [seed]);
      await table.delete(`id = '__seed__'`);
    }
    _tables.set(name, table);
    return table;
  })();
  _tablePromises.set(name, promise);
  return promise;
}

function _ensureDrawersTable(dim) {
  return _ensureTable(DRAWERS_TABLE, (d) => ({
    id: '__seed__',
    sessionId: '',
    sessionDir: '',
    projectRoot: '',
    roomId: '',
    turnIndex: 0,
    userText: '',
    assistantText: '',
    ts: 0,
    contentHash: '',
    dim: 0,
    embedding: new Float32Array(d),
  }), dim);
}

function _ensureRoomsTable(dim) {
  return _ensureTable(ROOMS_TABLE, (d) => ({
    id: '__seed__',
    projectRoot: '',
    label: '',
    drawerCount: 0,
    dim: 0,
    created: '',
    updatedAt: '',
    centroid: new Float32Array(d),
  }), dim);
}

function _ensureMetaTable() {
  return _ensureTable(META_TABLE, () => ({
    id: '__seed__',
    sessionId: '',
    sweptPairStart: -1,
    updatedAt: '',
  }));
}

// ─── Sweep: dialogue.jsonl → drawers ────────────────────────────────────

/**
 * Sweep a session's dialogue into the palace. Idempotent and resume-safe:
 *   - pairs below the watermark are never re-read
 *   - the LAST swept pair IS re-read (watermark is inclusive) so assistant
 *     output that arrives after a sweep folds into the same drawer
 *   - unchanged content (same hash) skips the embedding entirely
 *   - an embedding failure stops watermark advancement at the last
 *     contiguous success, so the failed pairs retry on the next debounce
 *
 * @param {Object} req
 * @param {string} req.sessionId
 * @param {string} req.sessionDir — dir containing dialogue.jsonl
 * @param {string} req.projectRoot — the wing
 * @param {Object} req.llmProvider — getEmbedding()/getEmbeddingBatch()/simpleChat()
 * @param {Array}  [req.turns] — pre-read dialogue turns (avoids a re-read
 *   when the caller already has them, e.g. conversations.js's _runIndex)
 * @returns {{swept: number}} number of drawers written/updated
 */
export async function sweepSessionIntoPalace({ sessionId, sessionDir, projectRoot, llmProvider, turns = null }) {
  try {
    if (!sessionId || !sessionDir || !llmProvider) return { swept: 0 };
    const allTurns = Array.isArray(turns) ? turns : _readDialogueTurns(sessionDir);
    if (allTurns.length === 0) return { swept: 0 };
    const pairs = _pairTurns(allTurns);
    if (pairs.length === 0) return { swept: 0 };

    const watermark = await _readWatermark(sessionId);
    const todo = pairs.filter((p) => p.turnIndex >= watermark);
    _debug(`sweep ${sessionId}: ${allTurns.length} turn(s) → ${pairs.length} pair(s), watermark=${watermark}, todo=${todo.length}`);
    if (todo.length === 0) return { swept: 0 };

    const drawersTable = await _ensureDrawersTable();

    // Fetch the existing rows for the candidate ids in one query so we can
    // skip unchanged pairs (hash match) and preserve roomId on re-embeds.
    const existingById = new Map();
    try {
      const idList = todo.map((p) => `'${_escapeSqlString(`${sessionId}:${p.turnIndex}`)}'`).join(', ');
      const rows = await drawersTable.query().where(`id IN (${idList})`).toArray();
      for (const r of rows) existingById.set(r.id, r);
    } catch { /* table may be empty — treat all as fresh */ }

    // Partition: unchanged (skip) / changed (re-embed, keep room) / fresh.
    const work = [];
    let unchanged = 0;
    for (const p of todo) {
      const id = `${sessionId}:${p.turnIndex}`;
      const hash = _hashPair(p);
      const existing = existingById.get(id);
      if (existing && existing.contentHash === hash) { unchanged++; continue; } // settled, no embed
      work.push({ pair: p, id, hash, keepRoomId: existing ? (existing.roomId || '') : null });
    }
    const freshCount = work.filter((w) => w.keepRoomId === null).length;
    _debug(`sweep ${sessionId}: ${unchanged} unchanged, ${work.length - freshCount} changed (re-embed), ${freshCount} fresh`);

    // Embed all changed/fresh pairs in one batch; per-item nulls are
    // tolerated (the watermark walk below handles partial failure).
    let embeddings = [];
    if (work.length > 0) {
      const inputs = work.map((w) =>
        w.pair.userText.slice(0, EMBED_USER_BUDGET) + '\n' + w.pair.assistantText.slice(0, EMBED_ASSISTANT_BUDGET));
      embeddings = await _embedBatch(llmProvider, inputs);
    }

    // Walk todo IN ORDER. The watermark only advances over settled pairs
    // (unchanged or successfully embedded); the first failure freezes it so
    // everything after retries next sweep. Room assignment is sequential so
    // pair N+1 can land in the room pair N just created.
    const workIndexById = new Map(work.map((w, i) => [w.id, i]));
    const rows = [];
    let settled = watermark;
    let broken = false;
    for (const p of todo) {
      const id = `${sessionId}:${p.turnIndex}`;
      const wi = workIndexById.get(id);
      if (wi === undefined) {
        if (!broken) settled = p.turnIndex; // unchanged pair — already settled
        continue;
      }
      const w = work[wi];
      const rawEmb = embeddings[wi];
      const emb = rawEmb instanceof Float32Array
        ? rawEmb
        : (Array.isArray(rawEmb) && rawEmb.length ? Float32Array.from(rawEmb) : null);
      if (!emb || emb.length === 0) {
        if (!broken) {
          _log(`sweep ${sessionId}: embedding failed at pair turnIndex=${p.turnIndex} — watermark frozen at ${settled}, will retry next sweep`);
        }
        broken = true;
        continue;
      }
      let roomId = w.keepRoomId;
      if (roomId === null) {
        try {
          roomId = await _assignRoom(emb, w.pair, projectRoot || '', llmProvider);
        } catch (err) {
          process.stderr.write(`[palace] room assignment failed: ${err.message}\n`);
          roomId = ''; // drawer still lands, just unfiled — browseable via search
        }
      }
      rows.push({
        id,
        sessionId,
        sessionDir,
        projectRoot: projectRoot || '',
        roomId: roomId || '',
        turnIndex: p.turnIndex,
        userText: p.userText, // FULL verbatim text — never truncated
        assistantText: p.assistantText,
        ts: p.ts || 0,
        contentHash: w.hash,
        dim: emb.length,
        embedding: emb,
      });
      if (!broken) settled = p.turnIndex;
    }

    if (rows.length > 0) {
      await drawersTable.add(rows); // INSERT OR REPLACE
      const newCount = rows.filter((r) => !existingById.has(r.id)).length;
      _log(`sweep ${sessionId}: wrote ${rows.length} drawer(s) (${newCount} new, ${rows.length - newCount} updated) — wing ${projectRoot || '(none)'}`);
    }
    if (settled > watermark || watermark < 0) {
      const metaTable = await _ensureMetaTable();
      await metaTable.add([{
        id: String(sessionId),
        sessionId: String(sessionId),
        sweptPairStart: settled,
        updatedAt: new Date().toISOString(),
      }]);
      _debug(`sweep ${sessionId}: watermark ${watermark} → ${settled}`);
    }
    return { swept: rows.length };
  } catch (err) {
    process.stderr.write(`[palace] sweep ${sessionId} failed: ${err.message}\n`);
    return { swept: 0 };
  }
}

/**
 * Backfill the palace for every session under `<projectRoot>/.koi/sessions/`
 * whose dialogue has pairs beyond its watermark. Idempotent; designed to run
 * once per (process × project), fired by session-tracker. Deliberately does
 * NOT ride the conversations backfill — that one skips sessions whose
 * summary row is mtime-fresh, which would starve the palace for history
 * that was summary-indexed before the palace existed.
 */
export async function backfillPalace({ projectRoot, llmProvider, maxConcurrency = 1 }) {
  if (!projectRoot || !llmProvider) return;
  const sessionsDir = path.join(projectRoot, '.koi', 'sessions');
  let sessionDirs;
  try {
    sessionDirs = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, dir: path.join(sessionsDir, d.name) }));
  } catch {
    return; // No sessions dir yet.
  }
  if (sessionDirs.length === 0) return;

  // One query for all watermarks so up-to-date sessions skip without I/O
  // beyond the dialogue read.
  const watermarks = new Map();
  try {
    const metaTable = await _ensureMetaTable();
    const rows = await metaTable.query().limit(100000).toArray();
    for (const r of rows) watermarks.set(r.sessionId, r.sweptPairStart);
  } catch { /* meta table missing — everything is fresh */ }

  const todo = [];
  for (const { id, dir } of sessionDirs) {
    const turns = _readDialogueTurns(dir);
    if (turns.length === 0) continue;
    const pairs = _pairTurns(turns);
    if (pairs.length === 0) continue;
    const wm = watermarks.has(id) ? watermarks.get(id) : -1;
    const last = pairs[pairs.length - 1].turnIndex;
    // `>` not `>=`: the inclusive-watermark re-sweep of the last pair only
    // matters for LIVE sessions still receiving turns; for backfill a
    // session whose last pair IS the watermark is already fully swept.
    if (last > wm || wm < 0) todo.push({ id, dir, turns });
  }
  if (todo.length === 0) {
    _debug(`backfill: ${sessionDirs.length} session(s) under ${projectRoot} — all up to date`);
    return;
  }

  _log(`backfill: ${todo.length}/${sessionDirs.length} session(s) need sweeping under ${projectRoot}`);

  const started = Date.now();
  let done = 0;
  let totalSwept = 0;
  const queue = todo.slice();
  const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, () =>
    (async () => {
      while (queue.length) {
        const { id, dir, turns } = queue.shift();
        try {
          const { swept } = await sweepSessionIntoPalace({
            sessionId: id,
            sessionDir: dir,
            projectRoot,
            llmProvider,
            turns,
          });
          totalSwept += swept || 0;
          done++;
          // Heartbeat every 10 sessions so long backfills are visibly alive.
          if (done % 10 === 0) _log(`backfill: ${done}/${todo.length} session(s), ${totalSwept} drawer(s) so far`);
        } catch (err) {
          done++;
          process.stderr.write(`[palace] backfill ${id} failed: ${err.message}\n`);
        }
      }
    })(),
  );
  await Promise.all(workers);
  _log(`backfill complete: ${totalSwept} drawer(s) from ${todo.length} session(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * GLOBAL one-shot migration of ALL historical conversations into the
 * palace — across every project, not just the one being opened.
 *
 * Why this exists on top of backfillPalace(): the per-project backfill
 * only fires when a project is OPENED, so old conversations of projects
 * the user never reopens would stay unmigrated forever, and home-level
 * sessions (`~/.koi/sessions/`, GUI sessions without a project) have no
 * "open" event at all.
 *
 * Session discovery (union, deduped by sessionDir):
 *   1. Every row of the `conversations` index (carries sessionDir +
 *      projectRoot for all 4xx historical sessions) — read directly via
 *      the shared adapter, NOT via conversations.js (import cycle).
 *   2. A dir scan of `<projectRoot>/.koi/sessions/` for every DISTINCT
 *      projectRoot found in that index (sessions that never got a
 *      summary row).
 *   3. A dir scan of `~/.koi/sessions/` (home-level sessions; wing '').
 *
 * Idempotent at two levels: per-drawer watermarks (sweep) + a persistent
 * completion marker in palace_meta, so subsequent processes skip the
 * whole walk. The marker is only written when the migration COMPLETES —
 * a crash mid-way simply resumes (cheaply, via watermarks) next run.
 */
const GLOBAL_MIGRATION_MARKER = '__global_migration_v1__';
let _globalMigrationKicked = false; // once per process

export async function migratePalaceGlobal({ llmProvider }) {
  if (_globalMigrationKicked || !llmProvider) return;
  _globalMigrationKicked = true;
  try {
    const metaTable = await _ensureMetaTable();
    // KOI_PALACE_REMIGRATE=1 forces a re-walk (cheap: per-session
    // watermarks skip everything already swept) — useful to pick up
    // sessions that failed during a previous migration.
    const force = process.env.KOI_PALACE_REMIGRATE === '1';
    if (!force) {
      const marker = await metaTable
        .query()
        .where(`id = '${GLOBAL_MIGRATION_MARKER}'`)
        .limit(1)
        .toArray();
      if (marker.length > 0) {
        _debug('global migration: already completed, skipping');
        return;
      }
    }

    // 1. Sessions known to the conversations index (all projects).
    const found = new Map(); // sessionDir -> { sessionId, projectRoot }
    const projectRoots = new Set();
    try {
      const db = await _ensureDb();
      const names = await db.tableNames();
      if (names.includes('conversations')) {
        const convTable = await db.openTable('conversations');
        const rows = await convTable.query().limit(100000).toArray();
        for (const r of rows) {
          if (r.sessionDir) found.set(r.sessionDir, { sessionId: r.sessionId, projectRoot: r.projectRoot || '' });
          if (r.projectRoot) projectRoots.add(r.projectRoot);
        }
      }
    } catch { /* no conversations index yet */ }

    // 2. Dir scan of every known projectRoot (sessions without a summary row).
    for (const root of projectRoots) {
      _collectSessionDirs(path.join(root, '.koi', 'sessions'), root, found);
    }

    // 3. Home-level sessions (no project — wing '').
    _collectSessionDirs(path.join(os.homedir(), '.koi', 'sessions'), '', found);

    if (found.size === 0) {
      await _writeGlobalMigrationMarker(metaTable);
      return;
    }

    _log(`global migration: ${found.size} historical session(s) across ${projectRoots.size || 1} wing(s)`);
    const started = Date.now();
    let done = 0;
    let totalSwept = 0;
    let failures = 0;
    for (const [dir, { sessionId, projectRoot }] of found) {
      try {
        const { swept } = await sweepSessionIntoPalace({
          sessionId: sessionId || path.basename(dir),
          sessionDir: dir,
          projectRoot,
          llmProvider,
        });
        totalSwept += swept || 0;
      } catch (err) {
        failures++;
        process.stderr.write(`[palace] global migration ${sessionId || dir} failed: ${err.message}\n`);
      }
      done++;
      if (done % 25 === 0) {
        _log(`global migration: ${done}/${found.size} session(s), ${totalSwept} drawer(s) so far`);
      }
    }

    // Only mark complete when every session was at least attempted and
    // nothing systemic failed; isolated per-session failures don't block
    // the marker (their watermarks stayed put — a manual re-run via
    // KOI_PALACE_REMIGRATE=1 can pick them up).
    await _writeGlobalMigrationMarker(metaTable);
    _log(
      `global migration complete: ${totalSwept} drawer(s) from ${found.size} session(s)` +
      `${failures ? ` (${failures} failed)` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    process.stderr.write(`[palace] global migration failed: ${err.message}\n`);
  }
}

function _collectSessionDirs(sessionsDir, projectRoot, found) {
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(sessionsDir, entry.name);
      if (!found.has(dir)) found.set(dir, { sessionId: entry.name, projectRoot });
    }
  } catch { /* dir doesn't exist */ }
}

async function _writeGlobalMigrationMarker(metaTable) {
  await metaTable.add([{
    id: GLOBAL_MIGRATION_MARKER,
    sessionId: GLOBAL_MIGRATION_MARKER,
    sweptPairStart: 1,
    updatedAt: new Date().toISOString(),
  }]);
}

// ─── Room assignment (online centroid clustering) ───────────────────────

// Serialises room create/update across concurrent sweeps in this process so
// two pairs about the same new topic can't race into duplicate rooms.
let _assignChain = Promise.resolve();
function _withAssignLock(fn) {
  const run = _assignChain.then(fn, fn);
  _assignChain = run.then(() => {}, () => {});
  return run;
}

async function _assignRoom(emb, pair, projectRoot, llmProvider) {
  return _withAssignLock(async () => {
    const roomsTable = await _ensureRoomsTable(emb.length);
    const wingRooms = await roomsTable
      .query()
      .where(`projectRoot = '${_escapeSqlString(projectRoot)}'`)
      .limit(MAX_ROOMS_PER_WING + 1)
      .toArray();

    let best = null;
    let bestSim = -1;
    for (const room of wingRooms) {
      const c = room.centroid;
      // Skip rooms built on a different embedding dimension (provider
      // switch) — new rooms simply form in the new space.
      if (!c || c.length !== emb.length) continue;
      const sim = _cosine(emb, c);
      if (sim > bestSim) { bestSim = sim; best = room; }
    }

    const atCap = wingRooms.length >= MAX_ROOMS_PER_WING;
    if (best && (bestSim >= ROOM_THRESHOLD || atCap)) {
      // Join: running-mean centroid update. No renormalisation needed —
      // cosine is scale-invariant.
      const n = Math.max(1, best.drawerCount || 1);
      const c = best.centroid;
      const next = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) next[i] = (c[i] * n + emb[i]) / (n + 1);
      await roomsTable.update(
        { centroid: next, drawerCount: n + 1, updatedAt: new Date().toISOString() },
        { where: `id = '${_escapeSqlString(best.id)}'` },
      );
      _debug(`room join: "${best.label}" sim=${bestSim.toFixed(3)} n=${n + 1}${atCap ? ' (wing at cap, forced nearest)' : ''} — "${pair.userText.slice(0, 60)}"`);
      return best.id;
    }

    // New room. The label is cosmetic (browsing aid) — its failure must
    // never block the drawer insert.
    const label = await _labelRoom(pair, llmProvider);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await roomsTable.add([{
      id,
      projectRoot,
      label,
      drawerCount: 1,
      dim: emb.length,
      created: now,
      updatedAt: now,
      centroid: emb,
    }]);
    _log(`new room "${label}" — wing ${projectRoot || '(none)'} (${wingRooms.length + 1} room(s); best existing sim=${bestSim < 0 ? 'n/a' : bestSim.toFixed(3)} < ${ROOM_THRESHOLD})`);
    return id;
  });
}

async function _labelRoom(pair, llmProvider) {
  const fallback = () =>
    pair.userText.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ') || 'Untitled topic';
  try {
    const prompt = [
      'Name the TOPIC of this exchange for a memory-palace room label.',
      'Reply with ONLY the label: 2-5 words, no quotes, no punctuation,',
      'same language as the user. Examples: "Stripe webhook retries",',
      '"Logo color exploration", "Deploy pipeline failures".',
      '---',
      `User: ${pair.userText.slice(0, 800)}`,
      `Assistant: ${pair.assistantText.slice(0, 800)}`,
    ].join('\n');
    const raw = await llmProvider.simpleChat(prompt, { timeoutMs: 10000 });
    const label = String(raw || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40 || label.includes('\n')) return fallback();
    return label;
  } catch {
    return fallback();
  }
}

// ─── Retrieval ──────────────────────────────────────────────────────────

/**
 * Verbatim drawer search: vector KNN → BM25 keyword rescore over the
 * candidates → weighted RRF fusion. Optionally scoped to a wing
 * (`projectRoot`) and/or a room (by label, case-insensitive).
 *
 * Degrades gracefully: empty query or unavailable embeddings → most
 * recent drawers (same contract as searchConversations).
 *
 * @returns Array<{sessionId, turnIndex, title, room, ts, snippet, dialoguePath, score}>
 */
export async function searchPalace({ query, projectRoot = null, roomLabel = null, k = 8, llmProvider }) {
  try {
    const roomId = roomLabel ? await _resolveRoomId(projectRoot, roomLabel) : null;
    if (roomLabel && !roomId) return []; // explicit room that doesn't exist → no hits

    if (!query || !String(query).trim() || !llmProvider) {
      _log(`search: no ${llmProvider ? 'query' : 'provider'} — degrading to recents (wing ${projectRoot || 'all'})`);
      return await _recentHits({ projectRoot, roomId, k });
    }
    let queryVec = null;
    try { queryVec = await llmProvider.getEmbedding(String(query)); } catch { /* offline */ }
    if (!queryVec || (queryVec.length || 0) === 0) {
      _log(`search "${String(query).slice(0, 60)}": embedding unavailable — degrading to recents`);
      return await _recentHits({ projectRoot, roomId, k });
    }

    const drawersTable = await _ensureDrawersTable(queryVec.length);
    const wheres = [];
    if (projectRoot) wheres.push(`projectRoot = '${_escapeSqlString(projectRoot)}'`);
    if (roomId) wheres.push(`roomId = '${_escapeSqlString(roomId)}'`);
    const N = Math.max(k * 4, 40);
    let builder = drawersTable.search(queryVec);
    if (wheres.length) builder = builder.where(wheres.join(' AND '));
    const candidates = await builder.limit(N).toArray();
    if (candidates.length === 0) {
      _log(`search "${String(query).slice(0, 60)}": 0 candidates (wing ${projectRoot || 'all'}${roomLabel ? `, room "${roomLabel}"` : ''})`);
      return [];
    }

    // BM25 over the candidate pool only — keyword evidence rescoring the
    // semantic shortlist. Doc key must be the unique drawer id; ids
    // tokenize to non-words so the title_boost is inert (harmless).
    const bm25Index = buildBM25Index(candidates.map((r) => ({
      title: r.id,
      description: (r.userText || '').slice(0, 400),
      body: (r.assistantText || '').slice(0, 2000),
    })));
    const keywordRanked = searchBM25(String(query), bm25Index, undefined, N);
    const vectorRanked = candidates.map((r) => ({
      title: r.id,
      score: Math.max(0, 1 - (typeof r._distance === 'number' ? r._distance : 1)),
    }));
    const fused = fuseScoreWeightedRRF(
      { composite: vectorRanked, keyword: keywordRanked, graph: [], warmth: [] },
      { rrf_k: 60, signal_weights: { composite: 0.65, keyword: 0.35, graph: 0, warmth: 0 } },
    );

    const byId = new Map(candidates.map((r) => [r.id, r]));
    const top = [];
    for (const f of fused) {
      const row = byId.get(f.title);
      if (!row) continue;
      top.push({ row, score: f.score });
      if (top.length >= k) break;
    }
    const hits = await _decorateHits(top.map((t) => ({ ...t.row, _score: t.score })));
    _log(
      `search "${String(query).slice(0, 60)}": ${candidates.length} candidate(s) → ` +
      `${keywordRanked.length} keyword match(es) → ${hits.length} hit(s)` +
      (hits.length ? ` (top: ${hits[0].room ? `[${hits[0].room}] ` : ''}"${(top[0].row.userText || '').slice(0, 50)}" score=${hits[0].score})` : ''),
    );
    if (DEBUG) {
      for (const h of hits) {
        _debug(`  hit ${h.sessionId}:${h.turnIndex} [${h.room || 'unfiled'}] score=${h.score} — "${h.snippet.slice(0, 80).replace(/\n/g, ' ')}"`);
      }
    }
    return hits;
  } catch (err) {
    process.stderr.write(`[palace] search failed: ${err.message}\n`);
    return [];
  }
}

/** Rooms of a wing, busiest first. Centroids stripped (browsing payload). */
export async function listRooms({ projectRoot = null } = {}) {
  try {
    const roomsTable = await _ensureRoomsTable();
    let q = roomsTable.query().orderBy('drawerCount', 'desc').limit(MAX_ROOMS_PER_WING);
    if (projectRoot) q = q.where(`projectRoot = '${_escapeSqlString(projectRoot)}'`);
    const rows = await q.toArray();
    return rows.map(({ centroid, ...rest }) => rest);
  } catch {
    return [];
  }
}

/** Drawers newest-first, optionally scoped to a room. Embeddings stripped. */
export async function listDrawers({ projectRoot = null, roomId = null, limit = 20, offset = 0 } = {}) {
  try {
    const drawersTable = await _ensureDrawersTable();
    const wheres = [];
    if (projectRoot) wheres.push(`projectRoot = '${_escapeSqlString(projectRoot)}'`);
    if (roomId) wheres.push(`roomId = '${_escapeSqlString(roomId)}'`);
    let q = drawersTable.query().orderBy('ts', 'desc').limit(limit).offset(offset);
    if (wheres.length) q = q.where(wheres.join(' AND '));
    const rows = await q.toArray();
    return rows.map(({ embedding, ...rest }) => rest);
  } catch {
    return [];
  }
}

/** Cheap existence check — drives the recall_memory palace-vs-legacy fork. */
export async function countPalaceDrawers(projectRoot = null) {
  try {
    const drawersTable = await _ensureDrawersTable();
    const sql = projectRoot
      ? `SELECT COUNT(*) AS c FROM ${drawersTable.tableId} WHERE projectRoot = ?`
      : `SELECT COUNT(*) AS c FROM ${drawersTable.tableId}`;
    const row = await drawersTable.rawScalar(sql, projectRoot ? [projectRoot] : []);
    return row?.c || 0;
  } catch {
    return 0;
  }
}

// ─── Hit shaping ────────────────────────────────────────────────────────

async function _recentHits({ projectRoot, roomId, k }) {
  const rows = await listDrawers({ projectRoot, roomId, limit: k });
  return _decorateHits(rows.map((r) => ({ ...r, _score: 0 })));
}

/** Attach room labels + session titles, shape the tool-facing hit. */
async function _decorateHits(rows) {
  if (rows.length === 0) return [];

  const labelByRoomId = new Map();
  try {
    const roomIds = [...new Set(rows.map((r) => r.roomId).filter(Boolean))];
    if (roomIds.length > 0) {
      const roomsTable = await _ensureRoomsTable();
      const idList = roomIds.map((id) => `'${_escapeSqlString(id)}'`).join(', ');
      const roomRows = await roomsTable.query().where(`id IN (${idList})`).toArray();
      for (const r of roomRows) labelByRoomId.set(r.id, r.label || '');
    }
  } catch { /* labels are cosmetic */ }

  // Session titles come from the conversations table (same SQLite file).
  // Best-effort: a fresh install may not have it yet.
  const titleBySession = new Map();
  try {
    const db = await _ensureDb();
    const names = await db.tableNames();
    if (names.includes('conversations')) {
      const convTable = await db.openTable('conversations');
      const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter(Boolean))];
      if (sessionIds.length > 0) {
        const idList = sessionIds.map((id) => `'${_escapeSqlString(id)}'`).join(', ');
        const convRows = await convTable.query().where(`id IN (${idList})`).toArray();
        for (const r of convRows) titleBySession.set(r.sessionId, r.title || '');
      }
    }
  } catch { /* titles are cosmetic */ }

  return rows.map((r) => {
    const userPart = `User: ${(r.userText || '').slice(0, SNIPPET_USER_CAP)}`;
    const assistantPart = r.assistantText
      ? `\nAssistant: ${r.assistantText.slice(0, SNIPPET_ASSISTANT_CAP)}`
      : '';
    return {
      sessionId: r.sessionId,
      turnIndex: r.turnIndex,
      title: titleBySession.get(r.sessionId) || '',
      room: labelByRoomId.get(r.roomId) || '',
      ts: r.ts || 0,
      snippet: userPart + assistantPart, // verbatim excerpt, capped for the payload
      dialoguePath: r.sessionDir ? path.join(r.sessionDir, 'dialogue.jsonl') : '',
      score: Number((r._score ?? 0).toFixed(4)),
    };
  });
}

// ─── Dialogue parsing ───────────────────────────────────────────────────

/**
 * Pair dialogue turns into user→assistant exchanges.
 *
 * Wire reality (agent.js): user prose is `{type:'user_input', text}`;
 * user-visible assistant prose is `{type:'action', intent: print|
 * assistant_message|show_result, result: <full text>}`. Other action turns
 * carry truncated tool previews — skipped, they'd pollute verbatim recall.
 * Bare `assistant_message`/`assistant_response` types (legacy/GUI) are also
 * honoured, mirroring conversations.js's _buildSummaryInput.
 */
function _pairTurns(turns) {
  const pairs = [];
  let current = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'user_input') {
      if (current) pairs.push(current);
      current = {
        turnIndex: i,
        userText: _stripUserInputPreamble(typeof t.text === 'string' ? t.text : ''),
        assistantText: '',
        ts: typeof t.ts === 'number' ? t.ts : 0,
      };
      continue;
    }
    if (!current) continue; // assistant output before any user input — no anchor
    let chunk = '';
    if (t.type === 'action' && ASSISTANT_PROSE_INTENTS.has(t.intent)) {
      chunk = typeof t.result === 'string' ? t.result : '';
    } else if (t.type === 'assistant_message' || t.type === 'assistant_response') {
      chunk = typeof t.text === 'string' ? t.text : '';
    }
    if (chunk) {
      current.assistantText = current.assistantText
        ? current.assistantText + '\n\n' + chunk
        : chunk;
    }
  }
  if (current) pairs.push(current);
  return pairs.filter((p) => p.userText || p.assistantText);
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

// Local copy of conversations.js's preamble stripper (the `# User request`
// marker GUI flows prepend). Duplicated deliberately — conversations.js
// statically imports this module, so importing back would be a cycle.
function _stripUserInputPreamble(text) {
  if (typeof text !== 'string' || text.length === 0) return text || '';
  const marker = '# User request';
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return text;
  const after = text.slice(idx + marker.length);
  return after.replace(/^\s*\n/, '').trim();
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function _readWatermark(sessionId) {
  try {
    const metaTable = await _ensureMetaTable();
    const rows = await metaTable
      .query()
      .where(`id = '${_escapeSqlString(sessionId)}'`)
      .limit(1)
      .toArray();
    if (rows.length && typeof rows[0].sweptPairStart === 'number') return rows[0].sweptPairStart;
  } catch { /* table missing — fresh */ }
  return -1;
}

async function _resolveRoomId(projectRoot, roomLabel) {
  const rooms = await listRooms({ projectRoot });
  const wanted = String(roomLabel).trim().toLowerCase();
  const match = rooms.find((r) => (r.label || '').trim().toLowerCase() === wanted);
  return match ? match.id : null;
}

/**
 * Batch-embed with per-item null tolerance. Prefers getEmbeddingBatch();
 * if the batch path throws or returns the wrong shape, falls back to
 * sequential getEmbedding() so one bad item doesn't sink the whole sweep.
 */
async function _embedBatch(llmProvider, inputs) {
  if (typeof llmProvider.getEmbeddingBatch === 'function') {
    try {
      const out = await llmProvider.getEmbeddingBatch(inputs);
      if (Array.isArray(out) && out.length === inputs.length) return out;
    } catch { /* fall through to sequential */ }
  }
  const out = [];
  for (const input of inputs) {
    try { out.push(await llmProvider.getEmbedding(input)); }
    catch { out.push(null); }
  }
  return out;
}

function _hashPair(pair) {
  return crypto
    .createHash('sha256')
    .update(pair.userText)
    .update('\x00')
    .update(pair.assistantText)
    .digest('hex');
}

// Tiny local cosine — deliberately NOT imported from rmh/engine.js, whose
// module top-level requires better-sqlite3 (native). This module is
// statically imported by conversations.js → session-tracker → agent, and
// must stay cheap to load.
function _cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function _escapeSqlString(s) {
  return String(s).replace(/'/g, "''");
}
