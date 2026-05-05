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
  tick() { this.turnCounter += 1; }
  clear() { this.systemPrompt = ''; this.entries.length = 0; this.turnCounter = 0; }

  // ── Write path ───────────────────────────────────────────────────────

  /**
   * Forward to the Event Log. Mirrors the old API so call sites don't
   * change. The legacy {immediate, shortTerm, permanent, opts} signature
   * is preserved; only `immediate` and `opts.intent`/`opts.successKey`/
   * `opts.failureKey` matter under the new system.
   */
  add(role, immediate, _shortTerm = null, _permanent = null, opts = {}) {
    _emitToEventLog(this.agentName, role, immediate, opts).catch(() => {});
  }

  // ── Read path ────────────────────────────────────────────────────────

  /**
   * Build messages array for the LLM, sourced from the Event Log.
   * NOTE: now async (was sync). Callers must await.
   */
  async toMessages(_opts = {}) {
    if (!memory.isInitialized()) {
      return this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : [];
    }
    return await memory.eventLogToMessages({ systemPrompt: this.systemPrompt });
  }

  async hasHistory() {
    if (!memory.isInitialized()) return false;
    const msgs = await memory.eventLogToMessages({});
    return msgs.length > 0;
  }

  get length() { return this.entries.length; }

  // ── Persistence (no-ops — Event Log is the persistent layer) ─────────

  serialize() {
    return { version: 3, systemPrompt: this.systemPrompt };
  }
  restore(_data) { /* no-op — Event Log on disk replaces session-tracker persistence */ }
  hydrate() { /* no-op — latent pool removed */ }
}

// ─── Event-log emission helper (was inside this file pre-Phase 8b.3) ────

async function _emitToEventLog(agentName, role, immediate, opts) {
  let mod;
  try {
    mod = await import('../memory/event-log/index.js');
  } catch {
    return;
  }
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
