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
    // Persist only the DIALOGUE turns — strip the agent's internal
    // plumbing (raw action JSON, `✅` feedback markers, `Continue.`
    // nudges, runtime recovery messages). Keeping that noise meant
    // that on resume the LLM saw a sopa of action JSONs and ended
    // up regurgitating past `print` messages to the user as if they
    // were a recap — the "wall of unformatted text after restore"
    // bug. The clean buffer is also smaller on disk and cheaper to
    // re-embed.
    return {
      version: 5,
      systemPrompt: this.systemPrompt,
      buffer: _cleanBufferForSerialize(this._buffer),
    };
  }
  /**
   * Repopulate the LLM-facing turn buffer from a serialized snapshot.
   * The snapshot shape is `{version, systemPrompt, buffer:[{role,
   * content}, …]}` — anything else is ignored (no legacy compat).
   *
   * Symptom that this fixes: app restart used to leave the agent with
   * an empty buffer (the previous restore was a no-op), so the LLM
   * saw zero conversation history on resume and "where were we?"
   * defaulted to active-document / task-queue heuristics.
   */
  restore(data) {
    if (!data || !Array.isArray(data.buffer)) return;
    if (typeof data.systemPrompt === 'string') this.systemPrompt = data.systemPrompt;
    this._buffer.length = 0;
    // Defensive re-clean on restore. If the file was written by an
    // older serialize that didn't strip scaffolding (≤ v4), this
    // still drops the noise so the LLM never sees raw action JSON.
    for (const e of _cleanBufferForSerialize(data.buffer)) {
      this._buffer.push(e);
    }
    // Mark as having history so callers gating on hasHistory() see
    // the restored state instead of treating this as a cold start.
    this._writeCount = (this._writeCount || 0) + this._buffer.length;
  }
  hydrate() { /* no-op — latent pool removed */ }
}

/**
 * Convert the live `_buffer` (which captures EVERY string the agent
 * loop pushes — including its own action JSONs, feedback markers,
 * runtime nudges) into a clean DIALOGUE-only sequence suitable for
 * persistence + cross-session replay.
 *
 * Rules:
 *   • USER entries that start with `✅`, `❌`, `📎` (feedback markers
 *     emitted by classifyFeedback for action results) → DROPPED. The
 *     human never typed those.
 *   • USER entries that match scaffolding markers (`Continue.`,
 *     `Task completed…`, `[INBOX]`, `Return your FIRST action.`,
 *     etc.) → DROPPED.
 *   • ASSISTANT entries whose content parses as JSON — we extract
 *     the user-facing string from `print.message`,
 *     `prompt_user.question`, `prompt_user.message`. If the action
 *     has no user-visible content (queue_add, task_list, delegate,
 *     update_state, return…) we DROP it. The LLM never needs to
 *     re-see its own past tool calls; toMessages already collapses
 *     them and they're noise on restore.
 *   • Plain-text USER and ASSISTANT entries (real prose) → KEPT
 *     as-is.
 */
function _cleanBufferForSerialize(buffer) {
  if (!Array.isArray(buffer)) return [];
  const out = [];
  for (const e of buffer) {
    if (!e || typeof e.content !== 'string') continue;
    const role = e.role === 'assistant' ? 'assistant' : 'user';
    const trimmed = e.content.trim();
    if (!trimmed) continue;
    if (_isScaffoldingMessage(trimmed)) continue;
    if (role === 'user') {
      // Drop action-feedback markers emitted by classifyFeedback /
      // the runtime's recovery prompts — the human never typed
      // these and they confuse the LLM on resume.
      const head = trimmed.charAt(0);
      if (head === '✅' || head === '❌' || head === '📎' || head === '⚠') continue;
      if (/^(Continue\.?|Return your FIRST action|Task completed)/i.test(trimmed)) continue;
      if (/^AUTO[- ]RECOVERY/i.test(trimmed)) continue;
      out.push({ role, content: e.content });
      continue;
    }
    // ASSISTANT — extract user-visible text from action JSON. Plain
    // prose passes through.
    const visible = _extractAssistantVisible(trimmed);
    if (visible) {
      out.push({ role: 'assistant', content: visible });
    }
  }
  return out;
}

/**
 * If `text` looks like an LLM-emitted action JSON, return ONLY the
 * user-visible payload (print message, prompt_user question, …). If
 * it's not JSON, return the original text. If it's JSON but carries
 * nothing user-facing (queue_add, task_list, delegate, …) return
 * null so the caller drops it entirely.
 */
function _extractAssistantVisible(text) {
  // Fast path — not JSON-shaped.
  if (text.charAt(0) !== '{' && text.charAt(0) !== '[') return text;
  let parsed;
  try {
    // The LLM sometimes wraps responses in ```json fences — strip
    // those before parsing. Also tolerate trailing whitespace.
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    parsed = JSON.parse(stripped);
  } catch {
    return text; // not JSON after all — treat as prose
  }
  // Normalise to a list of action objects (handles {batch:[…]},
  // single action, or a top-level array).
  let actions;
  if (Array.isArray(parsed)) actions = parsed;
  else if (Array.isArray(parsed?.batch)) actions = parsed.batch;
  else actions = [parsed];

  const pieces = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const intent = a.intent || a.type || '';
    if (intent === 'print' || intent === 'printCompact' || intent === 'show_result') {
      const m = a.message || a.text || '';
      if (typeof m === 'string' && m.trim()) pieces.push(m.trim());
    } else if (intent === 'prompt_user' || intent === 'prompt_form') {
      // Both the lead message and the question are user-facing.
      if (typeof a.message === 'string' && a.message.trim()) pieces.push(a.message.trim());
      if (typeof a.question === 'string' && a.question.trim()) pieces.push(a.question.trim());
    }
    // Every other intent (delegate, queue_add, task_list, return,
    // update_state, get_tool_info, …) carries no chat-facing text.
    // Skip — the LLM doesn't need to re-see its own past tool
    // calls on restore, and they're the bulk of the noise that was
    // showing up as the "wall" bug.
  }
  if (pieces.length === 0) return null;
  return pieces.join('\n\n');
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
