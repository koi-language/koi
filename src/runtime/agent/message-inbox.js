/**
 * MessageInbox — Per-agent async message inbox ("oreja").
 *
 * Every Agent instance owns a MessageInbox. Anyone (user via CLI, another
 * agent via broadcast) can push a message into the inbox WITHOUT blocking
 * the agent's main execution loop. A background classifier decides what
 * to do with each incoming message:
 *
 *   - new_task       → enqueue in the agent's WorkQueue
 *   - modify_task    → rewrite an existing queue item; if in_progress,
 *                      broadcast the message to delegates that are working
 *                      on tasks derived from it.
 *   - noop           → inject as a plain context note (no task action)
 *
 * Concurrency model:
 *   - push() returns immediately.
 *   - Classification runs serially per-agent (chained promise) so two
 *     consecutive messages cannot race on the same queue state.
 *   - Results are buffered in _processed and drained by the agent's main
 *     loop between iterations (non-blocking).
 *   - When a message arrives OR a classification finishes, the agent's
 *     _wakeup promise is resolved so a sleeping loop wakes up.
 *
 * Memory-only — no disk persistence (messages + classifications are
 * ephemeral for the running session).
 */

import { channel } from '../io/channel.js';

export class MessageInbox {
  /**
   * @param {import('./agent.js').Agent} agent
   */
  constructor(agent) {
    this._agent = agent;
    /** @type {Array<InboxMessage>} pending messages awaiting classification */
    this._pending = [];
    /** @type {Array<{ message: InboxMessage, result: ClassifierResult }>} classified results awaiting drain by the main loop */
    this._processed = [];
    /** Serializes classification so two pushes in a row don't race. */
    this._processChain = Promise.resolve();
    /** Counter for inbox message ids */
    this._nextId = 1;
  }

  /**
   * Push a message into the inbox. Returns the message id immediately.
   * Fires classification in the background.
   *
   * @param {Object} msg
   * @param {string} [msg.from]          - Sender ('user' | agent name)
   * @param {string} msg.text            - The message text
   * @param {Array}  [msg.attachments]   - Optional attachments
   * @param {string} [msg.correlationId] - Optional correlation id
   * @param {string} [msg.parentTaskId]  - If set, marks this as a broadcast
   *                                       related to an existing task (skip
   *                                       the "is this a modification?" check
   *                                       — it already is).
   */
  push(msg = {}) {
    // `from` is mandatory — it distinguishes user input (which may change
    // the agent's active language) from agent-to-agent broadcasts (which
    // must NEVER change the language). No default: callers must be
    // explicit so we never confuse an internal push with a user message.
    if (!msg.from || typeof msg.from !== 'string') {
      throw new Error(
        `MessageInbox.push: "from" is required (e.g. "user" or an agent name). ` +
        `Got: ${JSON.stringify(msg.from)}`
      );
    }
    const entry = {
      id: `inbox-${this._agent.name}-${this._nextId++}`,
      from: msg.from,
      text: String(msg.text || ''),
      attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
      correlationId: msg.correlationId || null,
      parentTaskId: msg.parentTaskId || null,
      arrivedAt: new Date().toISOString(),
    };
    this._pending.push(entry);

    channel.log('inbox', `${this._agent.name}: ← message from ${entry.from}: "${entry.text.substring(0, 80)}"`);

    // Chain classification — serialized per agent
    this._processChain = this._processChain
      .then(() => this._processNext())
      .catch((err) => {
        channel.log('inbox', `${this._agent.name}: classifier chain error: ${err?.message || err}`);
      });

    // Wake up the main loop if it was sleeping
    this._wakeAgent();

    return entry.id;
  }

  /**
   * Drain classified messages. Called by the main loop at the start of
   * each iteration. Returns the list of { message, result } and clears
   * the buffer.
   */
  drainProcessed() {
    if (this._processed.length === 0) return [];
    const out = this._processed;
    this._processed = [];
    return out;
  }

  /** True if there are any pending (unprocessed or undrained) messages. */
  hasWork() {
    return this._pending.length > 0 || this._processed.length > 0;
  }

  /** ─────────────────────── Internal ─────────────────────── */

  async _processNext() {
    const entry = this._pending.shift();
    if (!entry) return;

    let result;
    try {
      // Lazy import to avoid circular deps with llm-provider.
      const { classifyInboxMessage } = await import('../llm/message-classifier.js');
      result = await classifyInboxMessage(this._agent, entry);
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: classifier failed (${err?.message || err}) — falling back to noop`);
      result = { kind: 'noop', reasoning: `classifier error: ${err?.message || err}` };
    }

    this._processed.push({ message: entry, result });
    channel.log('inbox', `${this._agent.name}: classified "${entry.text.substring(0, 60)}" → ${result.kind}${result.targetTaskId ? ` (task #${result.targetTaskId})` : ''}`);

    // Wake up the main loop so it drains the result
    this._wakeAgent();
  }

  _wakeAgent() {
    const fn = this._agent._wakeupResolve;
    if (typeof fn === 'function') {
      this._agent._wakeupResolve = null;
      this._agent._wakeupPromise = null;
      try { fn(); } catch { /* non-fatal */ }
    }
  }
}

/**
 * @typedef {Object} InboxMessage
 * @property {string} id
 * @property {string} from
 * @property {string} text
 * @property {Array}  attachments
 * @property {string|null} correlationId
 * @property {string|null} parentTaskId
 * @property {string} arrivedAt
 */

/**
 * @typedef {Object} ClassifierResult
 * @property {'new_task'|'modify_task'|'noop'} kind
 * @property {string|null} [targetTaskId]
 * @property {{ subject: string, description: string, activeForm?: string }|null} [rewrittenTask]
 * @property {string} [reasoning]
 */
