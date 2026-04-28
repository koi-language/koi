/**
 * Request cancellation of a running async job.
 *
 * Best-effort — runners cooperate via AbortSignal. ffmpeg renders are
 * killed promptly; provider-poll runners stop polling but the remote
 * provider job may continue server-side until it expires there.
 */

import { cancelJob, getJob } from '../../state/jobs.js';

export default {
  type: 'cancel_job',
  intent: 'cancel_job',
  description:
    'Cancel a running async job by jobId. Returns: { success, cancelled, job }. ' +
    'cancelled=false means the job was already terminal (or unknown). ' +
    'For provider-side jobs (image/video generation), the remote may still finish on the provider — we just stop tracking it.',
  thinkingHint: 'Cancelling job',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id to cancel' },
      reason: { type: 'string', description: 'Optional human-readable reason recorded on the job' },
    },
    required: ['jobId'],
  },

  async execute(action) {
    const cancelled = cancelJob(action.jobId, action.reason);
    const job = getJob(action.jobId);
    return { success: true, cancelled, job };
  },
};
