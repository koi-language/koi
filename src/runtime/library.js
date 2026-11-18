/**
 * Calling Koi agents from code: an agent is an async function.
 *
 *   import { InvoiceAuditor } from 'my-agents';        // a package built by `koi build`
 *   const summary = await InvoiceAuditor.audit({ folder: './invoices' }, { timeoutMs: 300_000 });
 *
 * A call runs the agent in DELEGATE mode, the same way one agent calls another:
 * it never waits for a user, and a question it asks goes to the caller
 * (`onQuestion`) instead of a terminal. Each call gets its own I/O channel, so
 * nothing is printed and nothing is read from stdin; what the agent does is
 * reported through `onEvent`. Calls are independent: the same agent can be
 * called several times at once.
 *
 * Model access is the usual configuration: KOI_API_URL + KOI_API_KEY (the Koi
 * API, needed for image, video and audio), or the providers' own keys for chat.
 */

import { Channel, runWithChannel } from './io/channel.js';
import {
  runWithCallLimits, KoiCallError, KoiStepLimitError, KoiTimeoutError, KoiAbortError,
} from './agent/call-limits.js';

export { KoiCallError, KoiStepLimitError, KoiTimeoutError, KoiAbortError };

/** What the agent is told when it asks something and the caller gave no answer. */
export const DEFAULT_ANSWER =
  'Nobody is available to answer. Decide yourself with sensible defaults, say which assumptions you made, and finish the task.';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
const plain = (text) => String(text ?? '').replace(ANSI, '');

/**
 * The channel of one call: silent, never reads stdin, reports through
 * `onEvent`, answers through `onQuestion` or, without one, the safe default
 * (DEFAULT_ANSWER for a question, «no» for a permission).
 */
export class HeadlessChannel extends Channel {
  constructor({ agentName, onEvent = null, onQuestion = null } = {}) {
    super();
    this.agentName = agentName;
    this._onEvent = onEvent;
    this._onQuestion = onQuestion;
  }

  _emit(type, data) {
    if (!this._onEvent) return;
    try { this._onEvent({ type, agent: this.agentName, ...data }); } catch { /* a listener must never break the agent */ }
  }

  /** Ask the caller. `q` = { kind: 'text'|'select'|'form', question, choices?, fields? }. */
  async ask(q) {
    this._emit('question', { question: q.question, kind: q.kind });
    let answer;
    if (this._onQuestion) {
      answer = await this._onQuestion({ ...q, agent: this.agentName });
    }
    if (answer === undefined || answer === null) {
      if (q.kind === 'select') {
        const no = (q.choices || []).find((c) => c?.value === 'no');
        answer = no ? no.value : null;
      } else if (q.kind === 'form') {
        answer = null;
      } else {
        answer = DEFAULT_ANSWER;
      }
    }
    this._emit('answer', { question: q.question, answer });
    return answer;
  }

  // ── Output: reported, never printed ────────────────────────────────────
  print(text) { this._emit('output', { text: plain(text) }); }
  printStreaming(text) { this._emit('stream', { text: plain(text) }); }
  printStreamingEnd() {}
  printCompact(text) { this._emit('output', { text: plain(text) }); }
  printToScroll(text) { this._emit('output', { text: plain(text) }); }
  progress(message) { this._emit('progress', { message: plain(message) }); }
  planning(prefix) { this._emit('progress', { message: plain(prefix) }); }
  success(message) { this._emit('status', { level: 'success', message: plain(message) }); }
  error(message) { this._emit('status', { level: 'error', message: plain(message) }); }
  info(message) { this._emit('status', { level: 'info', message: plain(message) }); }
  clear() {}
  clearProgress() {}
  beginAction(type, detail, description) { this._emit('action', { phase: 'start', action: type, detail: plain(detail), description }); }
  endAction(success, detail) { this._emit('action', { phase: 'end', success: !!success, detail: plain(detail) }); }

  // ── Input: from the caller, never from stdin ───────────────────────────
  async prompt(promptText) {
    return this.ask({ kind: 'text', question: plain(promptText) });
  }

  async select(message, choices = []) {
    const answer = await this.ask({ kind: 'select', question: plain(message), choices: choices.map((c) => ({ title: c.title, value: c.value })) });
    const hit = choices.find((c) => c.value === answer || c.title === answer);
    return hit ? hit.value : answer;
  }

  async form(title, fields = []) {
    return this.ask({ kind: 'form', question: plain(title), fields });
  }

  async files() {
    return null;
  }

  log(category, message) {
    super.log(category, message);
    this._emit('log', { category, message });
  }
}

/** The failure a delegate returns when it gives up; anything else is a result. */
function _isGiveUp(result, agentName) {
  if (!result || typeof result !== 'object' || result.success !== false || !result.error) return false;
  const keys = Object.keys(result);
  return result.agentName === agentName && keys.every((k) => ['success', 'error', 'agentName'].includes(k));
}

/**
 * Run one handler of an agent and resolve with what it returns.
 *
 * @param {import('./agent/agent.js').Agent} agent
 * @param {string} event   the handler (`on <event>` in the .koi file)
 * @param {object} [args]
 * @param {object} [options]
 * @param {number} [options.timeoutMs]   reject with KoiTimeoutError after this long
 * @param {AbortSignal} [options.signal] reject with KoiAbortError when it fires
 * @param {number} [options.maxSteps]    cap the steps of each agent session the call starts
 * @param {boolean} [options.autoApprove] approve shell, file-write and media-cost permissions (default: deny)
 * @param {(event: object) => void} [options.onEvent]   progress, actions, output, questions
 * @param {(question: object) => any} [options.onQuestion] answer the agent; return null for the default
 */
export async function callAgent(agent, event, args = {}, options = {}) {
  const { timeoutMs, signal, maxSteps, autoApprove = false, onEvent = null, onQuestion = null } = options;

  if (!agent || typeof agent.handle !== 'function') {
    throw new KoiCallError('callAgent: the first argument is not a Koi agent.', 'KOI_BAD_AGENT');
  }
  if (!agent.handlers || typeof agent.handlers[event] !== 'function') {
    const known = Object.keys(agent.handlers || {}).join(', ') || 'none';
    throw new KoiCallError(`${agent.name} has no handler "${event}" (has: ${known}).`, 'KOI_UNKNOWN_HANDLER', { agentName: agent.name, event });
  }
  if (signal?.aborted) throw new KoiAbortError(agent.name, String(signal.reason ?? ''));

  // Markdown subagents (.koi/agents/*.md) are otherwise loaded only when a ROOT
  // agent starts; a call from code runs in delegate mode, so load them here (once).
  try {
    const { initUserAgents } = await import('./agent/md-agent-loader.js');
    await initUserAgents();
  } catch { /* non-fatal: the agent still runs, without markdown subagents */ }

  const channel = new HeadlessChannel({ agentName: agent.name, onEvent, onQuestion });
  const answerParent = (question) => channel.ask({ kind: 'text', question: plain(question) });
  const limits = { maxSteps: maxSteps || null, autoApprove: !!autoApprove };

  const work = runWithCallLimits(limits, () =>
    runWithChannel(channel, () => agent.handle(event, args ?? {}, true, answerParent)),
  );

  const stops = [];
  const cleanups = [];
  if (timeoutMs) {
    stops.push(new Promise((_, reject) => {
      const t = setTimeout(() => {
        try { agent.abort('user-stop'); } catch { /* best effort */ }
        reject(new KoiTimeoutError(agent.name, timeoutMs));
      }, timeoutMs);
      cleanups.push(() => clearTimeout(t));
    }));
  }
  if (signal) {
    stops.push(new Promise((_, reject) => {
      const onAbort = () => {
        try { agent.abort('user-stop'); } catch { /* best effort */ }
        reject(new KoiAbortError(agent.name, String(signal.reason ?? '')));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }));
  }

  try {
    const result = await Promise.race([work, ...stops]);
    if (_isGiveUp(result, agent.name)) {
      throw new KoiCallError(result.error, 'KOI_AGENT_FAILED', { agentName: agent.name, event });
    }
    return result;
  } finally {
    for (const c of cleanups) c();
    work.catch(() => {}); // a call abandoned on timeout/abort must not surface as an unhandled rejection
  }
}

/**
 * The object a built package exports for an agent: one async method per public
 * handler, plus `$agent` (the Agent itself) for whoever needs the low level.
 */
export function createAgentApi(agent, events) {
  const api = {};
  for (const event of events) {
    api[event] = (args, options) => callAgent(agent, event, args, options);
  }
  Object.defineProperty(api, '$agent', { value: agent, enumerable: false });
  return Object.freeze(api);
}
