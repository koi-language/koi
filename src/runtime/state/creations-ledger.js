// Per-session ledger of creations the agent produced this session.
//
// Why this exists:
//   The user reported that the agent forgets the IDs of creations it just
//   made and resorts to `find` / `ls` on disk to recover them — which often
//   finds files from OTHER sessions and mixes them in incorrectly. The
//   ledger pins every NEW save in `MediaLibrary.save()` to a per-session
//   JSONL file the agent can read via the `recall_creations` tool. The
//   ledger is a memory aid, NOT a source of truth: the real metadata lives
//   in MediaLibrary; this file is a chronological index of "what this
//   session produced and why".
//
// Persistence:
//   `<projectRoot>/.koi/sessions/<sessionId>/creations.jsonl`, one entry
//   per line:
//     { "id":"media-...","kind":"timeline","summary":"...","ts":1748728000000 }
//   Append-only — no rewrite, no compaction. The session log is the same
//   shape; both survive process restarts and session resumes.
//
// Session resolution:
//   Reads `process.env.KOI_SESSION_ID` + `KOI_PROJECT_ROOT` ON EVERY CALL
//   (never cached). This matches `work-queue.js` / `pending-jobs.js` /
//   `context-memory.js` — when `SessionTracker.repointToSession()` swaps
//   the env vars to resume an older session, the next ledger write lands
//   in the resumed session's directory automatically.
//
// Failure mode:
//   Silent no-op when either env var is unset (batch / headless / boot
//   before session-init). The agent can still work without a ledger; this
//   feature is purely additive.

import fs from 'fs';
import os from 'os';
import path from 'path';

function _sessionDir() {
  const sessionId = process.env.KOI_SESSION_ID;
  if (!sessionId) return null;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  return path.join(projectRoot, '.koi', 'sessions', sessionId);
}

function _ledgerPath() {
  const dir = _sessionDir();
  if (!dir) return null;
  return path.join(dir, 'creations.jsonl');
}

/**
 * Append a creation entry to the current session's ledger. Fire-and-
 * forget — failures are swallowed so a ledger I/O hiccup never blocks
 * the actual save in MediaLibrary.
 *
 * @param {Object} entry
 * @param {string} entry.id        — MediaLibrary row id.
 * @param {string} entry.kind      — media_type (image | video | audio |
 *                                    timeline | storyboard | voice | …).
 * @param {string} [entry.summary] — short human-readable "what was this
 *                                    for". Caller MUST resolve this from
 *                                    its best signal (user-supplied
 *                                    summary > description > prompt >
 *                                    filename) — the ledger is dumb and
 *                                    just writes what it's given.
 * @param {string} [entry.filePath] — absolute path of the produced file,
 *                                    for tools that show paths to users.
 * @param {string} [entry.storyboard] — id of the storyboard/project this
 *                                    creation belongs to (e.g. derived from
 *                                    `metadata.sourceStoryboard`). Lets a
 *                                    single session that produced several
 *                                    DIFFERENT videos scope a recall to one
 *                                    project, so a Part-2 generation never
 *                                    grabs another video's sheet. Empty when
 *                                    the creation isn't tied to a storyboard.
 */
export async function recordCreation(entry) {
  if (!entry || !entry.id || !entry.kind) return;
  const fp = _ledgerPath();
  if (!fp) return;
  const dir = path.dirname(fp);
  const line = JSON.stringify({
    id: entry.id,
    kind: entry.kind,
    summary: entry.summary || '',
    filePath: entry.filePath || '',
    storyboard: entry.storyboard || '',
    // Optional finer-grained linkage (from generation metadata): which scene
    // and shot(s) of that storyboard the creation covers. Consumed by the
    // GUI's project browser to nest generations under their scene. Empty
    // when the generation wasn't tagged.
    scene: entry.scene || '',
    shot: entry.shot || '',
    ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
  }) + '\n';
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(fp, line, 'utf8');
  } catch {
    // Best-effort: failing the ledger must not fail the save.
  }
  // GLOBAL cross-session index (<project>/creations-index.jsonl): same line,
  // home-based like every other artefact store the GUI reads directly
  // (storyboards/characters/locations). The session ledger stays the
  // authority for per-session recall; this copy exists so the GUI's
  // project browser can list a storyboard's generations across ALL
  // sessions without knowing any engine project root. Append-only,
  // best-effort, never blocks the save.
  try {
    const globalFp = path.join(documentsRoot(), 'creations-index.jsonl');
    await fs.promises.appendFile(globalFp, line, 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Read the current session's ledger back as an array, optionally
 * filtered. Returns most-recent first (reverse-chronological). Used by
 * the `recall_creations` agent tool — exposed here so other runtime
 * code (snapshot builders, debug helpers) can consume the same view
 * without reaching into the JSONL format directly.
 *
 * @param {Object} [opts]
 * @param {string} [opts.kind]   — when set, return only entries with
 *                                  this `kind` (image / video / …).
 * @param {number} [opts.since]  — when set, return only entries with
 *                                  `ts >= since` (epoch ms).
 * @param {number} [opts.limit]  — when set, cap result length AFTER
 *                                  reverse-chronological sort.
 * @param {string} [opts.storyboard] — when set, return only entries tied to
 *                                  this storyboard/project id. Entries with
 *                                  no storyboard link are excluded by the
 *                                  filter (they belong to no project).
 * @returns {Promise<Array<{id:string,kind:string,summary:string,
 *                           filePath:string,storyboard:string,ts:number}>>}
 */
export async function readCreations(opts = {}) {
  const fp = _ledgerPath();
  if (!fp) return [];
  let raw;
  try {
    raw = await fs.promises.readFile(fp, 'utf8');
  } catch {
    return []; // no ledger yet → nothing to recall
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || !obj.id) continue;
    if (opts.kind && obj.kind !== opts.kind) continue;
    if (opts.storyboard && (obj.storyboard || '') !== opts.storyboard) continue;
    if (typeof opts.since === 'number' && (obj.ts || 0) < opts.since) continue;
    out.push(obj);
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (typeof opts.limit === 'number' && opts.limit > 0) {
    return out.slice(0, opts.limit);
  }
  return out;
}
