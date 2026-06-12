/**
 * Pending-jobs persistence layer for long-running media generations.
 *
 * Why this module exists:
 * Each `generate_video` / `generate_image` call submits a job to fal
 * and then polls (`await getStatus(jobId)`) for 30–90 s until terminal.
 * Today that wait is a single in-process promise — if the engine dies,
 * hot-reloads, the WebSocket to the GUI flaps, or anything else kills
 * the promise, the fal job becomes a zombie: fal completes it
 * server-side, but no local code knows the result URL exists and which
 * timeline/clip it belongs to. The placeholder on the timeline stays
 * in "generating" until a 5-minute orphan watchdog clears it. The user
 * paid for a generation that disappeared.
 *
 * Recovery path with this module:
 *   1. On submit, the action writes
 *      `~/.koi/pending-jobs/<jobId>.json` with everything a recovery
 *      poller needs to finish the job from scratch (slug, params,
 *      clipContext, savePath, …).
 *   2. The poll loop heartbeats the file so other engines know somebody
 *      is on it.
 *   3. On terminal success the action calls `markCompleted` which
 *      deletes the file. On failure → `markFailed` moves it to
 *      `.failed/` for postmortem.
 *   4. A startup watcher (see pending-jobs-watcher.js) scans the dir
 *      and resumes any job whose lock is missing or stale (>30 s without
 *      heartbeat = previous poller died). Resume runs the same
 *      pollUntilTerminal → saveVideoFromUrl → assign_to_clip chain a
 *      live agent would have run.
 *
 * The file is the source of truth. Both the action-driven poller and
 * the recovery watcher coordinate through the heartbeat lock so two
 * engines never poll the same job at once.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Filesystem layout — under `~/.koi/`:
 *    pending-jobs/<jobId>.json     — active jobs (in-flight or
 *                                     awaiting recovery)
 *    pending-jobs/.failed/<jobId>.json — terminal failures, kept for
 *                                         postmortem (manual cleanup) */
function _pendingDir() {
  return path.join(os.homedir(), '.koi', 'pending-jobs');
}
function _failedDir() {
  return path.join(_pendingDir(), '.failed');
}

/** fal returns composite ids like `<slug>|<request_id>`; slugs contain
 *  slashes which would break filesystem layout. URL-encode for safety
 *  and round-trip via decode on read. */
function _filePath(jobId) {
  return path.join(_pendingDir(), encodeURIComponent(String(jobId)) + '.json');
}
function _failedPath(jobId) {
  return path.join(_failedDir(), encodeURIComponent(String(jobId)) + '.json');
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* race-tolerant */ }
}

/** Atomic write: write to tmp + rename. Prevents readers from seeing
 *  half-written JSON during concurrent updates. */
function _atomicWrite(filePath, body) {
  _ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, filePath);
}

/** Record a freshly-submitted job. Overwrites if a file already exists
 *  for this jobId — callers must use unique composite ids. */
export function recordJob(record) {
  if (!record || !record.jobId) throw new Error('recordJob: jobId required');
  const body = {
    // Identity
    jobId: String(record.jobId),
    kind: record.kind || 'video',                 // 'video' | 'image' | 'audio'
    slug: record.slug || null,                    // resolved fal slug
    provider: record.provider || 'koi-gateway',

    // Inputs (enough to reconstruct context, NOT enough to re-submit —
    // we never re-submit a job; we only complete what fal already has).
    prompt: record.prompt || null,
    params: record.params || null,                // canonical request bag

    // Target: where the result should land. Used by the recovery
    // watcher's download + assign_to_clip step.
    savePath: record.savePath || null,
    clipContext: record.clipContext || null,      // { timelineId, clipId, placeholderPath }

    // Status mirror (the file is updated each poll iteration).
    status: record.status || 'submitted',
    lastSeenStatus: record.status || 'submitted',
    error: null,

    // Bookkeeping
    submittedAt: record.submittedAt || new Date().toISOString(),
    submittedFromSession: record.submittedFromSession || process.env.KOI_SESSION_ID || null,
    lastPolledAt: null,

    // Heartbeat lock — see acquireLock/refreshLock/releaseLock below.
    pollerPid: null,
    pollerHeartbeat: 0,
  };
  _atomicWrite(_filePath(body.jobId), body);
  return body;
}

/** Read a single job by id. Returns null if absent or malformed. */
export function readJob(jobId) {
  try {
    const raw = fs.readFileSync(_filePath(jobId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Partial update — merges `patch` into the existing record and
 *  re-writes atomically. Returns the updated record, or null if the
 *  file was deleted between read and write. */
export function updateJob(jobId, patch) {
  const cur = readJob(jobId);
  if (!cur) return null;
  const merged = { ...cur, ...patch };
  _atomicWrite(_filePath(jobId), merged);
  return merged;
}

/** Terminal success: the result has been downloaded and (where
 *  applicable) assigned to its clip. Deletes the file — no audit
 *  trail needed for the happy path. */
export function markCompleted(jobId) {
  try { fs.unlinkSync(_filePath(jobId)); } catch { /* idempotent */ }
}

/** Terminal failure: provider rejected, all retries exhausted, or
 *  unrecoverable error during download/assign. Moves the file to
 *  `.failed/` for postmortem (the user can grep the dir to see what
 *  fal said). Caller passes the human-readable reason. */
export function markFailed(jobId, error) {
  const cur = readJob(jobId);
  if (!cur) return;
  const failed = {
    ...cur,
    status: 'failed',
    error: typeof error === 'string' ? error : (error?.message || String(error)),
    failedAt: new Date().toISOString(),
  };
  _ensureDir(_failedDir());
  _atomicWrite(_failedPath(jobId), failed);
  try { fs.unlinkSync(_filePath(jobId)); } catch { /* race tolerant */ }
}

/** List every active job on disk. The watcher uses this at startup to
 *  find orphaned jobs that need resuming. Returns parsed records;
 *  silently skips malformed files. */
export function listPending() {
  const dir = _pendingDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    // Skip files in `.failed/` — readdir of pending-jobs/ doesn't
    // descend into subdirs by default, but stay defensive.
    if (name.startsWith('.')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const rec = JSON.parse(raw);
      if (rec && rec.jobId) out.push(rec);
    } catch { /* ignore corrupt entries */ }
  }
  return out;
}

// ── Heartbeat lock ─────────────────────────────────────────────────────
// Coordinates: when two engines see the same pending-job file (e.g. the
// original session's owner is still alive AND a new engine boots after a
// reload), only ONE of them polls fal. The other backs off and lets the
// owner finish.
//
// Lock primitive:
//   • acquireLock(jobId, pid)   — sets pollerPid + heartbeat; refuses if
//                                  there's ANY non-stale lock (same-pid
//                                  included: the watcher shares the live
//                                  poller's process).
//   • refreshLock(jobId, pid)   — bumps the heartbeat; call this every
//                                  ≤10 s while polling so other engines
//                                  see the lock is alive.
//   • releaseLock(jobId, pid)   — clears the lock cleanly when we
//                                  intentionally hand it off (rare —
//                                  normally we finish with mark*).
//
// Staleness: a lock older than `LOCK_STALE_MS` is treated as abandoned.
// 90 s: comfortably above the slowest legitimate heartbeat gap — gateway
// polls tick every 3–5 s, but an MCP long-poll iteration (creations_wait
// with timeoutSeconds ≈ 25–30 s) only heartbeats when the call returns,
// so 30 s used to race the live poller and let the watcher steal its job.

const LOCK_STALE_MS = 90_000;

export function acquireLock(jobId, pid) {
  const cur = readJob(jobId);
  if (!cur) return false;
  const now = Date.now();
  if (cur.pollerPid && cur.pollerHeartbeat) {
    const age = now - cur.pollerHeartbeat;
    if (age < LOCK_STALE_MS) {
      // A FRESH lock is owned, even when pollerPid === pid: the recovery
      // watcher runs in the SAME process as the live poller, so a same-pid
      // bypass let it steal every active job seconds after submission and
      // double-poll it (fatally, for MCP jobs resumed through the gateway).
      // A crashed owner can't renew its heartbeat — staleness alone is the
      // correct (and only) re-acquire signal.
      return false;
    }
    // Stale lock → abandoned → take it.
  }
  const updated = updateJob(jobId, { pollerPid: pid, pollerHeartbeat: now });
  return !!updated;
}

export function refreshLock(jobId, pid) {
  const cur = readJob(jobId);
  if (!cur) return false;
  if (cur.pollerPid !== pid) return false; // we lost ownership somehow
  updateJob(jobId, { pollerHeartbeat: Date.now() });
  return true;
}

export function releaseLock(jobId, pid) {
  const cur = readJob(jobId);
  if (!cur) return;
  if (cur.pollerPid !== pid) return;
  updateJob(jobId, { pollerPid: null, pollerHeartbeat: 0 });
}

/** Constants exposed for tests / introspection. */
export const _internals = {
  LOCK_STALE_MS,
  pendingDir: _pendingDir,
  failedDir: _failedDir,
};
