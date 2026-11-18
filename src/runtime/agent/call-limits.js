/**
 * Per-call limits for an agent invoked from code (see ../library.js).
 *
 * The limits travel with the async context, so every session the call starts
 * (the agent's own and any delegate it spawns) reads them without a parameter
 * being threaded through the reactive loop.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const _storage = new AsyncLocalStorage();

/** Run `fn` with `limits` ({ maxSteps }) active for everything it awaits. */
export function runWithCallLimits(limits, fn) {
  return _storage.run(limits, fn);
}

/** The limits active in this async context, or null outside a library call. */
export function getCallLimits() {
  return _storage.getStore() ?? null;
}

/** Base class of every error a library call rejects with. */
export class KoiCallError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'KoiCallError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** The agent took more steps than `maxSteps` allowed. */
export class KoiStepLimitError extends KoiCallError {
  constructor(agentName, maxSteps) {
    super(`${agentName} stopped after ${maxSteps} steps without finishing (maxSteps).`, 'KOI_MAX_STEPS', { agentName, maxSteps });
    this.name = 'KoiStepLimitError';
  }
}

/** The call ran longer than `timeoutMs`. */
export class KoiTimeoutError extends KoiCallError {
  constructor(agentName, timeoutMs) {
    super(`${agentName} did not finish within ${timeoutMs} ms (timeoutMs).`, 'KOI_TIMEOUT', { agentName, timeoutMs });
    this.name = 'KoiTimeoutError';
  }
}

/** The caller's AbortSignal fired. */
export class KoiAbortError extends KoiCallError {
  constructor(agentName, reason) {
    super(`${agentName} was aborted${reason ? `: ${reason}` : ''}.`, 'KOI_ABORTED', { agentName, reason });
    this.name = 'KoiAbortError';
  }
}
