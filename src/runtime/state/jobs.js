/**
 * Generic async job registry.
 *
 * Any tool that can take a while (image gen, video gen, transcription,
 * timeline render) registers a job here. The agent can then come back
 * with `await_job` / `get_job_status` / `cancel_job` instead of being
 * forced to block on a single tool call.
 *
 * Two flavours of runner are supported uniformly:
 *
 *   - **In-process runner** — a Promise-returning function that does
 *     work inside this Node process (e.g. `child_process.spawn` of
 *     ffmpeg, an HTTP poll loop). Cancel = AbortSignal.
 *   - **External-poll runner** — a function that polls a remote
 *     provider's `getStatus(jobId)` until terminal. Cancel = AbortSignal
 *     (the runner stops polling; the remote job lives on, but we no
 *     longer surface it).
 *
 * Status lifecycle:
 *   queued → running → (succeeded | failed | cancelled)
 *
 * Persistence: each job is mirrored to <projectRoot>/.koi/jobs/<id>.json
 * so the agent can list/inspect them across sessions. In-flight runners
 * are NOT recovered on process restart — any job left in `running` when
 * jobs.js loads is reaped to `failed` ("process restarted before completion")
 * so callers don't wait forever.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

// Process-local registry of live AbortControllers, keyed by jobId.
// Only valid for jobs started in THIS process — restored jobs from
// disk have no controller.
const _controllers = new Map();

// Process-local pub/sub so awaitJob doesn't need to poll the disk.
const _bus = new EventEmitter();
_bus.setMaxListeners(0);

// ── Filesystem ───────────────────────────────────────────────────────

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

function _dir() {
  return path.join(_projectRoot(), '.koi', 'jobs');
}

function _ensureDir() {
  const dir = _dir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _filePath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(id)) {
    throw new Error(`Invalid job id: ${JSON.stringify(id)}`);
  }
  return path.join(_dir(), `${id}.json`);
}

function _newJobId(type) {
  const prefix = (typeof type === 'string' && type ? type : 'job')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'job';
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function _now() {
  return new Date().toISOString();
}

function _readRaw(id) {
  const fp = _filePath(id);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function _writeRaw(job) {
  _ensureDir();
  const fp = _filePath(job.id);
  // Atomic replace — write to .tmp, rename. Concurrent reads of `_writeRaw`
  // collisions resolve last-writer-wins, which is fine for status/progress
  // updates (each runner owns its own jobId).
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, fp);
}

// ── Crash recovery ───────────────────────────────────────────────────

let _reaped = false;
function _reapStaleOnce() {
  if (_reaped) return;
  _reaped = true;
  const dir = _dir();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const job = _readRaw(id);
    if (!job) continue;
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      job.error = 'Process restarted before job finished';
      job.finishedAt = _now();
      job.updatedAt = job.finishedAt;
      try { _writeRaw(job); } catch { /* best effort */ }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start a new job.
 *
 * `runner` is `async (ctx) => result` where ctx is:
 *   - signal: AbortSignal — runner MUST honour this and exit promptly
 *   - reportProgress(value, message?) — 0..1 + optional human-readable note
 *   - jobId — string id of this job
 *
 * The runner's resolved value becomes `job.result` on success. Throwing
 * (anything that isn't an AbortError) sets `failed` with `error: e.message`.
 * Returning normally after the signal aborts marks the job `cancelled`.
 *
 * Returns the initial job record (includes the minted id) — the runner
 * runs in the background; callers track progress via getJob/awaitJob.
 */
export function startJob({ type, params, runner }) {
  _reapStaleOnce();
  if (typeof type !== 'string' || !type) throw new Error('startJob: type is required');
  if (typeof runner !== 'function') throw new Error('startJob: runner must be a function');
  const id = _newJobId(type);
  const ac = new AbortController();
  _controllers.set(id, ac);
  const job = {
    id,
    type,
    status: 'queued',
    progress: 0,
    progressMessage: null,
    params: params ?? null,
    result: null,
    error: null,
    createdAt: _now(),
    updatedAt: _now(),
    startedAt: null,
    finishedAt: null,
  };
  _writeRaw(job);
  _bus.emit(id, job);

  // Kick off runner on next tick so the caller has the id before any
  // progress event fires.
  Promise.resolve().then(async () => {
    let current = _readRaw(id) || job;
    current.status = 'running';
    current.startedAt = _now();
    current.updatedAt = current.startedAt;
    _writeRaw(current);
    _bus.emit(id, current);
    try {
      const result = await runner({
        signal: ac.signal,
        jobId: id,
        reportProgress: (value, message) => {
          const j = _readRaw(id);
          if (!j || TERMINAL.has(j.status)) return;
          j.progress = Math.min(1, Math.max(0, Number(value) || 0));
          if (message !== undefined) j.progressMessage = String(message);
          j.updatedAt = _now();
          _writeRaw(j);
          _bus.emit(id, j);
        },
      });
      const j = _readRaw(id) || current;
      if (ac.signal.aborted) {
        j.status = 'cancelled';
        j.error = j.error || 'Cancelled';
      } else {
        j.status = 'succeeded';
        j.result = result ?? null;
        j.progress = 1;
      }
      j.finishedAt = _now();
      j.updatedAt = j.finishedAt;
      _writeRaw(j);
      _bus.emit(id, j);
    } catch (err) {
      const j = _readRaw(id) || current;
      const aborted = ac.signal.aborted ||
        err?.name === 'AbortError' ||
        /aborted/i.test(err?.message || '');
      j.status = aborted ? 'cancelled' : 'failed';
      j.error = err?.message || String(err);
      j.finishedAt = _now();
      j.updatedAt = j.finishedAt;
      _writeRaw(j);
      _bus.emit(id, j);
    } finally {
      _controllers.delete(id);
    }
  });

  return job;
}

/** Read a job by id, or null if not found. */
export function getJob(id) {
  _reapStaleOnce();
  return _readRaw(id);
}

/**
 * List jobs, newest first. `filter`:
 *   - status: string | string[]   — restrict to one or more statuses
 *   - type:   string | string[]   — restrict to one or more types
 *   - limit:  number              — cap results
 */
export function listJobs(filter = {}) {
  _reapStaleOnce();
  const dir = _dir();
  if (!fs.existsSync(dir)) return [];
  const wantStatus = filter.status
    ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    : null;
  const wantType = filter.type
    ? new Set(Array.isArray(filter.type) ? filter.type : [filter.type])
    : null;
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const job = _readRaw(id);
    if (!job) continue;
    if (wantStatus && !wantStatus.has(job.status)) continue;
    if (wantType && !wantType.has(job.type)) continue;
    out.push(job);
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    return out.slice(0, filter.limit);
  }
  return out;
}

/**
 * Wait for a job to reach a terminal state (or `timeoutMs` to elapse).
 * Resolves with the final job record either way — caller checks
 * `job.status` to distinguish completion vs. timeout (status will still
 * be `running` when we returned because of timeout).
 *
 * If `signal` aborts, resolves immediately with whatever the latest
 * snapshot is.
 */
export function awaitJob(id, { timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    const initial = _readRaw(id);
    if (!initial) {
      resolve(null);
      return;
    }
    if (TERMINAL.has(initial.status)) {
      resolve(initial);
      return;
    }
    let timer = null;
    let externalAbort = null;
    const cleanup = () => {
      _bus.off(id, onUpdate);
      if (timer) clearTimeout(timer);
      if (externalAbort && signal) signal.removeEventListener('abort', externalAbort);
    };
    const onUpdate = (job) => {
      if (TERMINAL.has(job.status)) {
        cleanup();
        resolve(job);
      }
    };
    _bus.on(id, onUpdate);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        resolve(_readRaw(id));
      }, timeoutMs);
    }
    if (signal) {
      if (signal.aborted) {
        cleanup();
        resolve(_readRaw(id));
        return;
      }
      externalAbort = () => {
        cleanup();
        resolve(_readRaw(id));
      };
      signal.addEventListener('abort', externalAbort, { once: true });
    }
  });
}

/**
 * Request cancellation of a job. Aborts the runner's signal — it's the
 * runner's job to bail promptly. Returns true if the job exists and
 * wasn't already terminal, false otherwise.
 */
export function cancelJob(id, reason) {
  const job = _readRaw(id);
  if (!job || TERMINAL.has(job.status)) return false;
  const ac = _controllers.get(id);
  if (ac) {
    try { ac.abort(reason || 'cancelled'); } catch { /* */ }
  } else {
    // No live runner in this process — likely an orphaned record. Mark
    // it cancelled directly so awaiters unblock instead of hanging.
    job.status = 'cancelled';
    job.error = reason || 'Cancelled (runner not in this process)';
    job.finishedAt = _now();
    job.updatedAt = job.finishedAt;
    _writeRaw(job);
    _bus.emit(id, job);
  }
  return true;
}

/** Delete a job record. Refuses to drop a still-running one. */
export function deleteJob(id) {
  const job = _readRaw(id);
  if (!job) return false;
  if (!TERMINAL.has(job.status)) {
    throw new Error(`Cannot delete job ${id}: still ${job.status}`);
  }
  fs.unlinkSync(_filePath(id));
  return true;
}
