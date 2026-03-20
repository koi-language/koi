/**
 * Check Video Status Action — Poll the status of an async video generation job.
 *
 * Video generation is asynchronous — generate_video returns a job ID that
 * should be polled with this action until status is 'completed' or 'failed'.
 *
 * Permission: 'generate_video' (same as generate — it's the same operation)
 */

import { resolve as resolveModel } from '../providers/factory.js';

export default {
  type: 'check_video_status',
  intent: 'check_video_status',
  description: 'Check the status of an async video generation job. Use the job ID returned by generate_video. Fields: "id" (required, job ID), optional "provider" (if known), optional "model" (if known). Returns: { success, id, status: pending|processing|completed|failed, url?, error? }',
  thinkingHint: 'Checking video status',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      id:       { type: 'string', description: 'Job/task ID returned by generate_video' },
      provider: { type: 'string', description: 'Provider name (returned by generate_video)' },
      model:    { type: 'string', description: 'Model name (returned by generate_video)' }
    },
    required: ['id']
  },

  examples: [
    { intent: 'check_video_status', id: 'task_abc123', provider: 'kling', model: 'kling-v3' },
    { intent: 'check_video_status', id: 'resp_xyz789' }
  ],

  async execute(action, agent) {
    const jobId = action.id;
    if (!jobId) throw new Error('check_video_status: "id" is required');

    const clients = agent?.llmProvider?.getClients?.() || {};

    let resolved;
    try {
      resolved = resolveModel({ type: 'video', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const result = await resolved.instance.getStatus(jobId);

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      id: result.id,
      status: result.status,
      url: result.url,
      error: result.error,
    };
  }
};
