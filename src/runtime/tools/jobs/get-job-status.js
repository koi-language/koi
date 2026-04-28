/**
 * Snapshot the current state of an async job without blocking.
 *
 * Cheap — single disk read. Use this when you want to show progress
 * to the user without committing to a full await.
 */

import { getJob } from '../../state/jobs.js';

export default {
  type: 'get_job_status',
  intent: 'get_job_status',
  description:
    'Return the current state of an async job without waiting. Returns: { success, job } with job = { id, type, status, progress, progressMessage?, result?, error?, … } or null if missing. ' +
    'For blocking until the job finishes, use await_job instead.',
  thinkingHint: 'Reading job status',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id returned by the async tool' },
    },
    required: ['jobId'],
  },

  async execute(action) {
    const job = getJob(action.jobId);
    if (!job) return { success: false, error: `Job ${action.jobId} not found` };
    return { success: true, job };
  },
};
