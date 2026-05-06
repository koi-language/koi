/**
 * ContextMemory — task-scoped turn buffer + audit emitter.
 *
 * After Phase 8c (the "tucán bug" fix) ContextMemory is the per-slot, in-
 * process buffer of the LLM-visible conversation. It does TWO things on
 * every `add()`:
 *
 *   1. Push the turn into an in-memory ring buffer used by `toMessages()`.
 *   2. Emit the same payload to the Event Log as an audit / RL signal.
 *
 * The Event Log is NO LONGER replayed into the LLM prompt. That was the
 * source of cross-task contamination: a single long-lived KOI_SESSION_ID
 * accumulated hundreds of events and mixed yesterday's task with today's
 * request ("by the way the user mentioned a toucan three hours ago").
 *
 * The Ori-Mnemos design we follow now: the conversation history is the
 * agent runtime's responsibility (in-process buffer, task-scoped). Long-
 * term knowledge lives in the memory vault and is retrieved on demand via
 * `recall_memory` / `explore_memory` / `memory_status` tools — not auto-
 * replayed at every turn.
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
     *  the buffer below is the real store. */
    this.entries = [];
    this.turnCounter = 0;
    /** Legacy fields kept zeroed for any code that peeks at them. */
    this._latentCount = 0;
    /**
     * Task-scoped in-memory buffer of LLM-visible turns. Each entry is
     * `{ role: 'user'|'assistant', content: string }`. Capped via
     * `_maxBufferSize` below. NOT persisted — when the agent restarts the
     * buffer starts empty (and that's the point: no replay across tasks).
     */
    this._buffer = [];
    this._writeCount = 0;
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
    this._buffer.length = 0;
  }
  /**
   * Reset the in-process buffer without clearing systemPrompt. Use this at
   * task boundaries (new top-level user message, /clear, delegate spawn)
   * to ensure the LLM doesn't carry forward turns from an unrelated task.
   * Audit history in the Event Log is untouched.
   */
  resetTurnBuffer() {
    this._buffer.length = 0;
    this.entries.length = 0;
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

    // 1) Push to the in-process turn buffer. This is what the LLM sees on
    //    the next toMessages() call. Apply the scaffolding filter here so
    //    the buffer never grows with internal nudges.
    //
    // No size cap. The buffer starts empty per process and only accumulates
    // turns from the current run, so cross-task contamination is structurally
    // impossible (that was the bug the cap was patching). If a single task
    // grows large enough to stress a model's context window, the LLM
    // provider's auto model-selector already picks a bigger-context model
    // based on the estimated token count (see llm-provider.js _minContextK).
    // If the user wants a hard reset mid-session, they call /clear.
    const content = typeof immediate === 'string' ? immediate : '';
    if (content.length > 0 && !_isScaffoldingMessage(content)) {
      const bufRole = role === 'assistant' ? 'assistant' : 'user';
      this._buffer.push({ role: bufRole, content });
    }

    // 2) Audit-emit to the Event Log (fire-and-forget). The log is no longer
    //    the source of truth for `toMessages()` — it's audit + RL signal.
    _emitToEventLog(this.agentName, role, immediate, opts).catch(() => {});
  }

  // ── Read path ────────────────────────────────────────────────────────

  /**
   * Build messages array for the LLM from the in-process turn buffer.
   * NOTE: kept async (was async pre-Phase 8c when it read from disk) so
   * call sites that already `await` keep working without changes.
   *
   * Source: this._buffer — populated by add(). NOT the Event Log.
   * Adjacent same-role messages are merged (matches legacy ContextMemory
   * behaviour the LLM providers expect — many models reject two consecutive
   * user-role messages).
   */
  async toMessages(_opts = {}) {
    const messages = [];
    if (this.systemPrompt) messages.push({ role: 'system', content: this.systemPrompt });
    for (const m of this._buffer) {
      messages.push({ role: m.role, content: m.content });
    }
    // Merge consecutive same-role messages (an action result + a Continue.
    // nudge that escaped the scaffolding filter would otherwise land as two
    // adjacent user-role entries).
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
/**
 * Filter scaffolding events the inbox/classifier injects as UserMessages.
 * Examples seen in the wild:
 *   "[INBOX] Message from user: ... (classifier: ...)"
 *   "[INBOX] User said: '...'"
 *   "Return your FIRST action."
 *   "Continue."
 * These are internal runtime nudges and would only confuse the LLM if
 * surfaced as turn history.
 */
function _isScaffoldingMessage(content) {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (t.startsWith('[INBOX]')) return true;
  if (t === 'Continue.' || t === 'Continue') return true;
  if (/^Return your FIRST action\.?$/i.test(t)) return true;
  return false;
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
