/**
 * ContextMemory — DEPRECATED thin shim.
 *
 * The tier-based memory model (SHORT/MEDIUM/LONG/LATENT) was replaced by the
 * Event Log + Ori vault + Context Compiler pipeline (Phase 8b). Real storage
 * lives in `src/runtime/memory/`. This file remains only to keep the existing
 * call sites (~133 across `agent.js` and `llm-provider.js`) working without a
 * mass rewrite — every method here either:
 *
 *   - emits to the Event Log (add)
 *   - reads from the Event Log (toMessages, hasHistory)
 *   - is a no-op kept for API compatibility (serialize, restore, hydrate, tick)
 *
 * Once those call sites are migrated to import from `runtime/memory/index.js`
 * directly, this file goes away.
 *
 * `classifyFeedback` and `classifyResponse` were moved to
 * `state/feedback-classifier.js`. They are re-exported here so existing
 * imports `from '../state/context-memory.js'` keep resolving.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as memory from '../memory/index.js';
import * as eventTypes from '../memory/event-log/types.js';

export { classifyFeedback, classifyResponse } from './feedback-classifier.js';

/**
 * @typedef {object} ContextMemoryOpts
 * @property {string} [agentName]
 * @property {object} [llmProvider]    ignored — retained for backward-compat constructor signature
 * @property {number} [shortTermTTL]   ignored
 * @property {number} [mediumTermTTL]  ignored
 * @property {string} [latentDbPath]   ignored — no latent store
 */

export class ContextMemory {
  constructor(opts = {}) {
    this.agentName = opts.agentName || 'unknown';
    this.systemPrompt = '';
    /** Kept as an empty array — legacy callers iterate over it for filtering;
     *  the Event Log is the real store. */
    this.entries = [];
    this.turnCounter = 0;
    /** Legacy fields kept zeroed for any code that peeks at them. */
    this._latentCount = 0;
  }

  // ── Setters / counters ───────────────────────────────────────────────

  setSystem(prompt) { this.systemPrompt = typeof prompt === 'string' ? prompt : ''; }
  /**
   * Increment the turn counter. Returns a Promise so existing call sites that
   * use the legacy `contextMemory.tick().catch(() => {})` fire-and-forget
   * pattern keep working — a sync return would crash on `.catch`.
   */
  tick() { this.turnCounter += 1; return Promise.resolve(); }
  clear() {
    this.systemPrompt = '';
    this.entries.length = 0;
    this.turnCounter = 0;
    this._writeCount = 0;
  }

  // ── Write path ───────────────────────────────────────────────────────

  /**
   * Forward to the Event Log. Mirrors the old API so call sites don't
   * change. The legacy {immediate, shortTerm, permanent, opts} signature
   * is preserved; only `immediate` and `opts.intent`/`opts.successKey`/
   * `opts.failureKey` matter under the new system.
   */
  add(role, immediate, _shortTerm = null, _permanent = null, opts = {}) {
    this._writeCount = (this._writeCount || 0) + 1;
    // Track the in-flight emission so toMessages() can await every pending
    // write before reading. Without this, the read may run before
    // _emitToEventLog has even queued the append (it's still inside its
    // dynamic import or _ensureEventLogReady), and writer.flush() — which
    // only drains the writer queue — wouldn't help.
    const p = _emitToEventLog(this.agentName, role, immediate, opts).catch(() => {});
    _addPending(p);
  }

  // ── Read path ────────────────────────────────────────────────────────

  /**
   * Build messages array for the LLM, sourced from the Event Log.
   * NOTE: now async (was sync). Callers must await.
   *
   * Reads as long as the event log itself is initialised (projectRoot +
   * sessionId from env), even if the full memory module hasn't been
   * lazily initialised yet by an action handler.
   */
  async toMessages(_opts = {}) {
    let mod;
    try { mod = await import('../memory/event-log/index.js'); } catch {
      return this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : [];
    }
    if (!(await _ensureEventLogReady(mod))) {
      return this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : [];
    }
    // Drain the shim's in-flight emissions first (covers the window
    // between cm.add() returning and the append() landing on the writer
    // queue), then flush the writer queue itself to disk.
    await _drainPendingEmits();
    await mod.flush();
    const sid = mod.currentSessionId();
    const conversational = [
      eventTypes.UserMessage,
      eventTypes.AgentPlanned,
      eventTypes.ToolResultReceived,
    ];
    const events = await mod.load(
      path.join(process.env.KOI_PROJECT_ROOT || process.cwd(), '.koi', 'memory'),
      sid,
      { types: conversational },
    );
    const messages = [];
    if (this.systemPrompt) messages.push({ role: 'system', content: this.systemPrompt });
    for (const e of events) {
      let role, content;
      if (e.type === eventTypes.UserMessage) {
        role = 'user';
        content = e.payload?.content ?? '';
      } else if (e.type === eventTypes.AgentPlanned) {
        role = 'assistant';
        content = e.payload?.reasoning ?? '';
      } else if (e.type === eventTypes.ToolResultReceived) {
        role = 'user';
        content = e.payload?.result ?? '';
      } else continue;
      if (typeof content !== 'string' || content.length === 0) continue;
      messages.push({ role, content });
    }
    // Merge consecutive same-role messages (mirrors the legacy ContextMemory
    // behaviour: an action result + Continue. nudge would otherwise land
    // as two adjacent user-role entries).
    const out = [];
    for (const m of messages) {
      const last = out[out.length - 1];
      if (last && last.role === m.role && m.role !== 'system') {
        last.content = `${last.content}\n\n${m.content}`;
      } else out.push({ ...m });
    }
    return out;
  }

  /**
   * Sync: returns true once the shim has seen at least one add() call this
   * session. Several call sites in agent.js / llm-provider.js test this
   * inside synchronous `if (... || contextMemory.hasHistory() || ...)`
   * blocks, so making it async would silently truthy-leak (a Promise is
   * always truthy) and skip the rebuild branch unconditionally.
   */
  hasHistory() { return (this._writeCount || 0) > 0; }

  get length() { return this.entries.length; }

  // ── Persistence (no-ops — Event Log is the persistent layer) ─────────

  serialize() {
    return { version: 3, systemPrompt: this.systemPrompt };
  }
  restore(_data) { /* no-op — Event Log on disk replaces session-tracker persistence */ }
  hydrate() { /* no-op — latent pool removed */ }
}

// ─── Event-log emission helper (was inside this file pre-Phase 8b.3) ────

/**
 * Lazy-init the Event Log on first emit. The full memory subsystem
 * (vault + retrieval + cloud embeddings) needs an LLMProvider and is
 * initialised later via `memory.ensureInit(agent)`. The event log only
 * needs `projectRoot` + `sessionId` (both come from environment vars
 * set by koi-cli's bin-entry.js), so we bring it up here as soon as the
 * first ContextMemory.add() fires — otherwise events emitted at boot
 * are silently dropped and the conversational loop reads an empty log.
 */
// Pending emit promises — toMessages awaits all of these before reading
// so events from add() calls that haven't yet reached the writer queue
// are still seen by the next read.
const _pendingEmits = new Set();
function _addPending(p) {
  _pendingEmits.add(p);
  p.finally(() => _pendingEmits.delete(p));
}
async function _drainPendingEmits() {
  if (_pendingEmits.size === 0) return;
  await Promise.all(_pendingEmits);
}

let _eventLogBootstrapped = false;
async function _ensureEventLogReady(mod) {
  if (_eventLogBootstrapped) return true;
  if (mod.currentSessionId()) { _eventLogBootstrapped = true; return true; }
  const projectRoot = process.env.KOI_PROJECT_ROOT;
  const sessionId = process.env.KOI_SESSION_ID;
  if (!projectRoot || !sessionId) return false;
  const vaultRoot = path.join(projectRoot, '.koi', 'memory');
  try {
    await fs.mkdir(path.join(vaultRoot, '.ori'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'ops', 'sessions'), { recursive: true });
    await mod.init({ vaultRoot, sessionId });
    _eventLogBootstrapped = true;
    return true;
  } catch {
    return false;
  }
}

async function _emitToEventLog(agentName, role, immediate, opts) {
  let mod;
  try {
    mod = await import('../memory/event-log/index.js');
  } catch {
    return;
  }
  if (!(await _ensureEventLogReady(mod))) return;
  let type, payload;
  if (role === 'assistant') {
    type = mod.types.AgentPlanned;
    payload = { reasoning: typeof immediate === 'string' ? immediate.slice(0, 4000) : '' };
  } else if (opts && (opts.intent || opts.successKey || opts.failureKey)) {
    type = mod.types.ToolResultReceived;
    const ok = !opts.failureKey;
    payload = {
      name: opts.intent || 'unknown',
      ok,
      result: typeof immediate === 'string' ? immediate.slice(0, 4000) : null,
    };
    if (opts.failureKey) payload.failureKey = opts.failureKey;
  } else {
    type = eventTypes.UserMessage;
    payload = { content: typeof immediate === 'string' ? immediate.slice(0, 4000) : '' };
  }
  await mod.append(type, agentName || 'agent', payload);
}
