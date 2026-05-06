/**
 * Event Log writer.
 *
 * Append-only JSONL per session at <vault>/ops/sessions/<sessionId>.jsonl.
 *
 * Design choices:
 *   - Atomic per-line via fs.appendFile (kernel guarantees up to PIPE_BUF on
 *     POSIX; for sub-PIPE_BUF lines we're fine, and our payloads are small).
 *   - In-memory append buffer NOT used: simplicity > throughput. The agent
 *     loop emits tens of events per turn, not thousands. If we ever hit
 *     contention, we add a 16ms-batched flush — for now, direct.
 *   - Events get a monotonic id per session: evt_000001, evt_000002, ...
 *   - parent_ids forms a DAG (an event can have N parents). The id of the
 *     immediately-prior event is automatically added unless `noAutoParent`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Emitter that fires an `event` event for each appended log entry.
 * Memory Extractor (and others) subscribe to receive events as they happen.
 * Subscribers should be tolerant of high frequency and never block.
 */
export const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let _vaultRoot = null;
let _sessionId = null;
let _counter = 0;
let _logPath = null;
let _initPromise = null;

/**
 * Initialize the writer. Must be called once at session start before any
 * append(). Idempotent: calling twice with same args is a no-op.
 *
 * @param {object} opts
 * @param {string} opts.vaultRoot  Path to the vault root (e.g., <repo>/.koi/memory).
 * @param {string} opts.sessionId  Unique session id (e.g., timestamp-random).
 */
export async function init({ vaultRoot, sessionId }) {
  if (!vaultRoot) throw new Error('eventLog.init: vaultRoot required');
  if (!sessionId) throw new Error('eventLog.init: sessionId required');
  if (_vaultRoot === vaultRoot && _sessionId === sessionId) return;
  _vaultRoot = vaultRoot;
  _sessionId = sessionId;
  _counter = 0;
  _logPath = path.join(vaultRoot, 'ops', 'sessions', `${sessionId}.jsonl`);
  _initPromise = fs.mkdir(path.dirname(_logPath), { recursive: true });
  await _initPromise;
  // Write a session-start marker so JSONL files are never zero-length.
  await _writeRaw({
    id: _nextId(),
    ts: new Date().toISOString(),
    type: 'SessionStarted',
    actor: 'system',
    session_id: sessionId,
    parent_ids: [],
    payload: { vault: vaultRoot },
  });
}

function _nextId() {
  _counter += 1;
  return `evt_${String(_counter).padStart(6, '0')}`;
}

let _lastId = null;

// Serialised write queue. Multiple append() calls may arrive concurrently
// (e.g. fire-and-forget mirrors from ContextMemory.add); without queueing
// they race and produce out-of-order JSONL. We chain every write off a
// single tail promise so events land on disk in the exact order they were
// requested.
let _writeChain = Promise.resolve();
async function _writeRaw(event) {
  const next = _writeChain.then(() => fs.appendFile(_logPath, JSON.stringify(event) + '\n', 'utf8'));
  // Keep the chain alive even when one write fails — drop the error here so
  // a single broken write doesn't poison subsequent appends.
  _writeChain = next.catch(() => {});
  await next;
  _lastId = event.id;
  // Fire-and-forget notification to subscribers (extractor, dashboards, …).
  try { emitter.emit('event', event); } catch { /* ignore */ }
  return event.id;
}

/**
 * Wait until every pending append has been flushed to disk.
 *
 * Critical for the read-after-write pattern: ContextMemory.add() fires
 * _emitToEventLog as fire-and-forget; if the runtime then calls
 * toMessages() (which reads the JSONL from disk) before that promise
 * settles, the read sees an incomplete view and the LLM is handed an
 * empty conversation. Callers about to read should await flush() first.
 *
 * Idempotent and cheap when nothing's pending — resolves on the next
 * microtask.
 */
export async function flush() {
  // Snapshot the current chain — by the time it settles, every append
  // queued before this call has hit disk.
  await _writeChain;
}

/**
 * Append an event to the log.
 *
 * @param {string} type     Event type — see types.js
 * @param {string} actor    Who emitted: 'user', 'system', or agent name.
 * @param {object} payload  Type-specific payload (see types.js JSDoc).
 * @param {object} [opts]
 * @param {string[]} [opts.parents]   Explicit parent event ids.
 * @param {boolean}  [opts.noAutoParent] If true, don't auto-link to last event.
 * @returns {Promise<string>} The id of the appended event.
 */
export async function append(type, actor, payload = {}, opts = {}) {
  if (!_logPath) {
    // Boot phase: writer not yet configured. Drop silently — caller should
    // wait for init(). We return a stub id so call sites aren't disrupted.
    return '__pre_init__';
  }
  if (_initPromise) await _initPromise;

  const parents = opts.parents
    ? [...opts.parents]
    : (opts.noAutoParent || _lastId == null) ? [] : [_lastId];

  const event = {
    id: _nextId(),
    ts: new Date().toISOString(),
    type,
    actor,
    session_id: _sessionId,
    parent_ids: parents,
    payload,
  };
  return await _writeRaw(event);
}

/** Current session id (or null before init). */
export function currentSessionId() { return _sessionId; }

/** Current log path (or null before init). */
export function currentLogPath() { return _logPath; }

/** Reset state — for tests. */
export function _reset() {
  _vaultRoot = null;
  _sessionId = null;
  _counter = 0;
  _logPath = null;
  _initPromise = null;
  _lastId = null;
}
