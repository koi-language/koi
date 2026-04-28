/**
 * Block until a job reaches a terminal state (succeeded / failed /
 * cancelled), or until the supplied timeout fires.
 *
 * Works for ANY job kicked off through the generic job system —
 * timeline renders, image generations launched with wait=false, future
 * tools, etc. No LLM tokens are spent during the wait.
 */

import { awaitJob, getJob } from '../../state/jobs.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

export default {
  type: 'await_job',
  intent: 'await_job',
  description:
    'Wait for an async job to finish. Pass the jobId returned by any tool that ran in async mode (e.g. render_timeline, generate_image with wait=false). ' +
    'Blocks internally — no LLM tokens used during the wait. ' +
    'Returns: { success, job } where job = { id, type, status, progress, result?, error?, … }. ' +
    'status="running" only happens if the timeout fired before the job finished — call again with the same id to keep waiting.',
  thinkingHint: 'Waiting for job',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id returned by the async tool' },
      timeoutMs: { type: 'number', description: 'Max wall-clock to wait, in milliseconds. Default 600000 (10 min).' },
    },
    required: ['jobId'],
  },

  async execute(action, agent) {
    const jobId = action.jobId;
    if (!jobId) return { success: false, error: 'await_job: jobId is required' };
    const initial = getJob(jobId);
    if (!initial) return { success: false, error: `Job ${jobId} not found` };
    const timeoutMs = Number(action.timeoutMs) > 0 ? Number(action.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const final = await awaitJob(jobId, { timeoutMs, signal: agent?.abortSignal });
    if (!final) return { success: false, error: `Job ${jobId} not found` };
    return { success: final.status === 'succeeded', job: final };
  },
};
