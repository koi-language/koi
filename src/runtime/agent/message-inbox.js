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
      // User messages go through the GLOBAL classifier (sees all queues,
      // all plan tasks, running delegates, recent dialogue) so it can
      // decide to modify tasks owned by any agent — not just this one's
      // local workQueue. Agent-to-agent broadcasts and other
      // non-user messages stay on the local per-agent classifier path.
      if (entry.from === 'user') {
        const { classifyGlobalMessage } = await import('../llm/global-classifier.js');
        const global = await classifyGlobalMessage(this._agent, entry);
        // Adapt to the legacy shape so `_applyInboxResult` can consume
        // it unchanged for backward compat. Additional fields
        // (`target`, `abortInFlight`, `targetDelegateAgent`) ride along
        // for the dispatcher to act on source-aware routing and
        // abort-in-flight behaviour.
        result = _adaptGlobalResult(global);
      } else {
        const { classifyInboxMessage } = await import('../llm/message-classifier.js');
        result = await classifyInboxMessage(this._agent, entry);
      }
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: classifier failed (${err?.message || err}) — falling back to noop`);
      result = { kind: 'noop', reasoning: `classifier error: ${err?.message || err}` };
    }

    this._processed.push({ message: entry, result });
    channel.log('inbox', `${this._agent.name}: classified "${entry.text.substring(0, 60)}" → ${result.kind}${result.targetTaskId ? ` (task #${result.targetTaskId})` : ''}${result.target?.source ? ` [${result.target.source}]` : ''}`);

    // Cross-agent modifications can't wait for the classifier agent's
    // reactive loop to drain the inbox — when System delegates and is
    // blocked awaiting the delegate, its drain doesn't run until the
    // delegate returns, which it won't without learning about the
    // change. Apply the cross-agent mutation + target inbox push +
    // abort-in-flight IMMEDIATELY here, so the delegate sees the
    // update in its very next iteration. The local bookkeeping
    // (contextMemory notes, language update) still happens in the
    // normal drain — it's not time-critical.
    //
    // We mark the result with `_crossAgentApplied` so the drain-side
    // `_applyInboxResult` can skip the queue/inbox/abort work this
    // function just did (otherwise the modification fires twice,
    // once now and once when System finally iterates).
    if (entry.from === 'user') {
      try {
        let applied = false;
        if (result.kind === 'modify_task' && result.target?.source) {
          applied = await this._applyCrossAgentModifyIfNeeded(entry, result);
        } else if (result.kind === 'cancel_task' && result.target?.source) {
          applied = await this._applyCrossAgentCancelIfNeeded(entry, result);
        } else if (result.kind === 'cancel_plan') {
          applied = await this._applyCrossAgentCancelPlan(entry, result);
        }
        if (applied) result._crossAgentApplied = true;
      } catch (err) {
        channel.log('inbox', `${this._agent.name}: cross-agent ${result.kind} failed: ${err?.message || err}`);
      }
    }

    // Wake up the main loop so it drains the result. Two cases:
    //
    // 1) Agent is awaiting `_wakeupPromise` between iterations → the
    //    resolve below unparks it and the top-of-loop drain runs.
    //
    // 2) Agent is blocked INSIDE a prompt_user action — very common on
    //    cold start when the user sends their first message right as the
    //    reactive loop is firing up. The top-of-loop drain will NOT run
    //    again until prompt_user resolves, so `_wakeAgent()` alone is not
    //    enough: we also have to deliver the text to the pending input
    //    waiter. That unblocks prompt_user, the loop continues, the next
    //    iteration's drain applies the classified result normally.
    //
    //    We mark the entry as `_preDelivered` so `_applyInboxResult` does
    //    not re-deliver the same text (which would queue a duplicate for
    //    the next prompt_user).
    try {
      const cliHooks = this._agent?.constructor?._cliHooks;
      const uiBridge = cliHooks?.getUiBridge?.();
      if (uiBridge?.hasInputWaiter && entry.from === 'user' && typeof cliHooks?.deliverClassifiedInput === 'function') {
        entry._preDelivered = true;
        cliHooks.deliverClassifiedInput(entry.text);
        channel.log('inbox', `${this._agent.name}: unblocked waiting prompt_user with classified input`);
      }
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: pre-deliver failed: ${err?.message || err}`);
    }

    this._wakeAgent();
  }

  /**
   * Apply modify_task mutations that target another agent IMMEDIATELY,
   * without waiting for the classifier agent (usually System) to drain
   * its inbox. When System is blocked in a delegate await, its drain
   * doesn't run until the delegate returns — which it won't without
   * learning about the change. This function closes that loop.
   *
   * Does THREE things for `source = workqueue:<Agent>`:
   *   1. Rewrites the queue item on the target agent's workQueue.
   *   2. Pushes the raw user message to the target agent's inbox so its
   *      own reactive loop surfaces it as context on the next turn.
   *   3. If the classifier flagged `abortInFlight`, fires the global
   *      abort so the target's in-flight LLM stream cancels and the
   *      reactive loop re-enters with the updated task immediately.
   *
   * `source = taskManager` is handled later in `_applyInboxResult`
   * because taskManager modifications are safe to defer — the target
   * delegate will re-read the task from the global plan on its next
   * iteration either way. The urgent case is per-agent workqueue
   * rewrites where the delegate has no reason to re-read otherwise.
   */
  async _applyCrossAgentModifyIfNeeded(entry, result) {
    const target = result.target;
    if (!target || !target.source || !target.source.startsWith('workqueue:')) return false;

    const targetAgentName = target.source.substring('workqueue:'.length);
    const AgentClass = this._agent?.constructor;
    if (!AgentClass || !AgentClass._inboxRegistry) return false;

    const targetAgent = AgentClass._inboxRegistry.get(String(targetAgentName).toLowerCase());
    if (!targetAgent || !targetAgent._workQueue) {
      channel.log('inbox', `${this._agent.name}: cross-agent target ${targetAgentName} not in registry — deferring to drain`);
      return false;
    }

    // 1. Rewrite the queue item.
    const queue = targetAgent._workQueue;
    let existing;
    try { existing = queue.get(String(target.id)); } catch { existing = null; }
    if (!existing || existing.status === 'deleted') {
      channel.log('inbox', `${this._agent.name}: cross-agent target ${targetAgentName}#${target.id} gone — deferring`);
      return false;
    }
    const rewrite = result.rewrittenTask || {};
    try {
      queue.update(String(target.id), {
        subject: rewrite.subject || existing.subject,
        description: rewrite.description || existing.description,
        replaceDescription: !!rewrite.description,
      });
      channel.log('inbox', `${this._agent.name}: immediately modified workqueue:${targetAgentName}#${target.id} "${rewrite.subject || existing.subject}"`);
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: queue rewrite failed: ${err?.message || err}`);
      return false;
    }

    // 2. Push an IMPERATIVE note to the target's inbox with parentTaskId
    //    set, so the target's classifier skips re-classification and
    //    the note lands in contextMemory on the next drain. The target's
    //    original task spec (injected at delegate boot) would otherwise
    //    outweigh a one-liner "[INBOX] user said X" — LLMs keep working
    //    on the old subject because it's more prominent in the prompt.
    //    The note below restates the new subject/description explicitly
    //    and commands the target to abandon the previous work.
    try {
      if (typeof targetAgent._inbox?.push === 'function') {
        const _newSubject = rewrite.subject || existing.subject;
        const _newDesc = rewrite.description || existing.description || '';
        const _noteText =
          `⚠️ TASK UPDATED by user mid-execution.\n\n` +
          `User said: "${entry.text}"\n\n` +
          `Your new task supersedes the original task spec you received at boot. Use THIS as your authoritative instruction going forward:\n\n` +
          `  NEW SUBJECT: ${_newSubject}\n` +
          `  NEW DESCRIPTION: ${_newDesc}\n\n` +
          `Do NOT continue with the previous subject. Discard any work-in-progress that was specific to the old task. Re-plan from here.`;
        targetAgent._inbox.push({
          from: this._agent.name,
          text: _noteText,
          attachments: entry.attachments,
          correlationId: entry.correlationId,
          parentTaskId: String(target.id),
        });
        channel.log('inbox', `${this._agent.name}: pushed modification note to ${targetAgentName}'s inbox (task #${target.id}, new subject="${_newSubject}")`);
      }
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: inbox push to ${targetAgentName} failed: ${err?.message || err}`);
    }

    // 3. Abort in-flight on the TARGET agent only. Uses the per-agent
    //    AbortController so System (usually awaiting the delegate) is
    //    NOT collaterally aborted. Reason 'modify' tells the target's
    //    reactive loop to resume (re-read the updated task) instead
    //    of exiting on abort.
    if (result.abortInFlight) {
      try {
        if (typeof targetAgent.abort === 'function') {
          targetAgent.abort('modify');
          channel.log('inbox', `${this._agent.name}: aborted ${targetAgentName}'s in-flight LLM (reason=modify) so it re-reads the updated task`);
        }
      } catch (err) {
        channel.log('inbox', `${this._agent.name}: abort failed: ${err?.message || err}`);
      }
    }

    // Wake the target agent so its reactive loop drains the inbox and
    // processes the new instruction on its next iteration.
    try {
      const fn = targetAgent._wakeupResolve;
      if (typeof fn === 'function') {
        targetAgent._wakeupResolve = null;
        targetAgent._wakeupPromise = null;
        fn();
      }
    } catch { /* non-fatal */ }

    return true;
  }

  /**
   * Apply cancel_task on a target agent's workqueue IMMEDIATELY.
   *
   *   1. Mark the queue item as `deleted` so the target stops when it
   *      re-reads the queue.
   *   2. Push a cancellation note to the target's inbox (parentTaskId
   *      set so the local classifier skips re-classification).
   *   3. Abort the target's in-flight LLM with reason='cancel' — the
   *      target's reactive loop EXITS (does not resume as it would
   *      for 'modify').
   *
   * Returns true on success, false if the target / task vanished.
   */
  async _applyCrossAgentCancelIfNeeded(entry, result) {
    const target = result.target;
    if (!target || !target.source || !target.source.startsWith('workqueue:')) return false;

    const targetAgentName = target.source.substring('workqueue:'.length);
    const AgentClass = this._agent?.constructor;
    if (!AgentClass || !AgentClass._inboxRegistry) return false;

    const targetAgent = AgentClass._inboxRegistry.get(String(targetAgentName).toLowerCase());
    if (!targetAgent || !targetAgent._workQueue) {
      channel.log('inbox', `${this._agent.name}: cancel target ${targetAgentName} not in registry — deferring`);
      return false;
    }

    const queue = targetAgent._workQueue;
    let existing;
    try { existing = queue.get(String(target.id)); } catch { existing = null; }
    if (!existing || existing.status === 'deleted' || existing.status === 'completed') {
      channel.log('inbox', `${this._agent.name}: cancel target ${targetAgentName}#${target.id} already gone — skip`);
      return false;
    }

    try {
      queue.update(String(target.id), { status: 'deleted' });
      channel.log('inbox', `${this._agent.name}: cancelled workqueue:${targetAgentName}#${target.id} "${existing.subject}"`);
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: queue cancel failed: ${err?.message || err}`);
      return false;
    }

    // Push cancellation note to target's inbox so its next drain sees
    // the user's instruction even though the queue item is now gone.
    try {
      if (typeof targetAgent._inbox?.push === 'function') {
        targetAgent._inbox.push({
          from: this._agent.name,
          text: entry.text,
          attachments: entry.attachments,
          correlationId: entry.correlationId,
          parentTaskId: String(target.id),
        });
        channel.log('inbox', `${this._agent.name}: pushed cancellation to ${targetAgentName}'s inbox (task #${target.id})`);
      }
    } catch (err) {
      channel.log('inbox', `${this._agent.name}: inbox push to ${targetAgentName} failed: ${err?.message || err}`);
    }

    // Abort with reason='cancel' → the target's reactive loop EXITS
    // (unlike 'modify' which makes it resume).
    if (result.abortInFlight) {
      try {
        if (typeof targetAgent.abort === 'function') {
          targetAgent.abort('cancel');
          channel.log('inbox', `${this._agent.name}: aborted ${targetAgentName} (reason=cancel) — its loop will exit`);
        }
      } catch (err) {
        channel.log('inbox', `${this._agent.name}: abort failed: ${err?.message || err}`);
      }
    }

    try {
      const fn = targetAgent._wakeupResolve;
      if (typeof fn === 'function') {
        targetAgent._wakeupResolve = null;
        targetAgent._wakeupPromise = null;
        fn();
      }
    } catch { /* non-fatal */ }

    return true;
  }

  /**
   * Apply cancel_plan — the nuclear option. Clears every pending /
   * in_progress task across the global taskManager AND every agent's
   * per-agent workqueue, then aborts every running delegate with
   * reason='cancel'. After this returns, the runtime is effectively
   * idle: the classifier agent (root) can respond naturally and wait
   * for the user's next instruction.
   *
   * Always returns true (the "applied" flag is informational — the
   * local drain still writes a contextMemory note so the classifier
   * agent's next LLM turn knows what happened).
   */
  async _applyCrossAgentCancelPlan(entry, result) {
    const AgentClass = this._agent?.constructor;
    if (typeof AgentClass?.cancelAll === 'function') {
      const { cancelledTasks, abortedAgents } = await AgentClass.cancelAll();
      channel.log('inbox', `${this._agent.name}: cancel_plan swept ${cancelledTasks} task(s), aborted ${abortedAgents} delegate(s)`);
    }
    return true;
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
 * @property {string|null} [language]
 *
 * When the result comes from the global classifier the following extras
 * ride along — they're optional so legacy paths that still produce the
 * local shape stay compatible:
 * @property {{id: string, source: string, owner: string|null}|null} [target]
 * @property {string|null} [targetDelegateAgent]
 * @property {boolean} [abortInFlight]
 */

/**
 * Adapt a GlobalClassifierResult to the legacy ClassifierResult shape
 * that `_applyInboxResult` expects. Keeps the additional fields
 * (`target`, `targetDelegateAgent`, `abortInFlight`) available so the
 * dispatcher can act on source-aware routing and interrupt in-flight
 * delegates when needed.
 */
function _adaptGlobalResult(g) {
  return {
    kind: g.kind,
    targetTaskId: g.target?.id || null,
    rewrittenTask: g.rewrite || null,
    language: g.language || null,
    reasoning: g.reasoning || '',
    // Extras from the global shape — preserved for the dispatcher.
    target: g.target || null,
    targetDelegateAgent: g.targetDelegateAgent || null,
    abortInFlight: !!g.abortInFlight,
  };
}
