/**
 * Wrap any tool with async-capable behaviour.
 *
 * When the agent calls the tool with `wait: false` (or any falsy value
 * other than the default true), the original execute is kicked off
 * inside a job — the call returns `{ success, jobId, message }` straight
 * away and the work runs in the background. The agent then uses
 * `await_job` / `get_job_status` / `cancel_job` to track it.
 *
 * `wait: true` (the default) preserves the historical synchronous
 * behaviour bit-for-bit — the original execute runs inline and its
 * return value is forwarded unchanged. This means existing call sites
 * that don't pass `wait` keep working without modification.
 *
 * Usage at the bottom of a tool file:
 *
 *   import asyncCapable from '../_async-capable.js';
 *   export default asyncCapable(actionDef);
 */

import { startJob } from '../state/jobs.js';

const _SENTINEL = Symbol.for('koi.asyncCapable.inJob');

export default function asyncCapable(actionDef) {
  if (!actionDef || typeof actionDef.execute !== 'function') return actionDef;

  // Make sure the schema advertises the `wait` option so the agent sees it.
  const schema = actionDef.schema && typeof actionDef.schema === 'object'
    ? { ...actionDef.schema, properties: { ...(actionDef.schema.properties || {}) } }
    : { type: 'object', properties: {} };
  if (!schema.properties.wait) {
    schema.properties.wait = {
      type: 'boolean',
      description:
        'Run synchronously and return the full result inline (default true). ' +
        'Set to false to start the work as a background job and return { jobId } immediately — ' +
        'use await_job / get_job_status to retrieve the result.',
    };
  }

  const description = (actionDef.description || '') +
    ' This tool is async-capable: pass wait=false to kick it off as a background job ' +
    '(returns { jobId }) instead of blocking.';

  const originalExecute = actionDef.execute;

  async function execute(action, agent) {
    // Recursive-call guard: when our runner re-enters execute, the
    // sentinel is set so we drop straight into the original.
    if (action && action[_SENTINEL]) {
      const cleaned = { ...action };
      delete cleaned[_SENTINEL];
      delete cleaned.wait;
      return originalExecute.call(this, cleaned, agent);
    }
    // Default behaviour preserved: wait undefined / true → run sync.
    if (action?.wait !== false) {
      return originalExecute.call(this, action, agent);
    }
    // Async kick-off: register a job, run the original execute inside
    // it on a fresh signal so cancel_job aborts cleanly.
    const intent = actionDef.intent || actionDef.type || 'job';
    const job = startJob({
      type: intent,
      params: { ...action, wait: false },
      runner: async ({ signal, reportProgress }) => {
        const wrappedAgent = {
          ...(agent || {}),
          abortSignal: signal,
          reportProgress,
        };
        return originalExecute.call(actionDef, { ...action, [_SENTINEL]: true }, wrappedAgent);
      },
    });
    return {
      success: true,
      jobId: job.id,
      message: `${intent} started in background — call await_job with this jobId to retrieve the result.`,
    };
  }

  return { ...actionDef, schema, description, execute };
}
