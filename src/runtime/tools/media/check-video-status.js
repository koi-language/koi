/**
 * Check Video Status Action — Poll the status of an async video generation job.
 *
 * Video generation is asynchronous — generate_video returns a job ID that
 * should be polled with this action until status is 'completed' or 'failed'.
 *
 * Permission: 'generate_video' (same as generate — it's the same operation)
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { saveVideoFromUrl } from './generate-video.js';

export default {
  type: 'check_video_status',
  intent: 'check_video_status',
  description: 'Check the status of an async video generation job. Use the job ID returned by generate_video. Fields: "id" (required, job ID), optional "provider" (if known), optional "model" (if known), optional "saveTo" (directory — when status becomes completed the video is downloaded there). Returns: { success, id, status: pending|processing|completed|failed, url?, savedTo?, error? }',
  thinkingHint: 'Checking video status',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      id:       { type: 'string', description: 'Job/task ID returned by generate_video' },
      provider: { type: 'string', description: 'Provider name (returned by generate_video)' },
      model:    { type: 'string', description: 'Model name (returned by generate_video)' },
      saveTo:   { type: 'string', description: 'Directory to save the video when the job completes. Pass the same value you gave generate_video. Defaults to ~/.koi/videos/ when omitted.' }
    },
    required: ['id']
  },

  examples: [
    { intent: 'check_video_status', id: 'task_abc123', provider: 'kling', model: 'kling-v3' },
    { intent: 'check_video_status', id: 'resp_xyz789' },
    { intent: 'check_video_status', id: 'task_abc123', provider: 'kling', saveTo: '/Users/me/project/assets' }
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

    // Auto-save on completion so the caller gets a usable path without a
    // second round-trip. Skipped silently on earlier statuses.
    let savedTo = null;
    if (result.status === 'completed' && result.url) {
      savedTo = await saveVideoFromUrl(result.url, {
        saveTo: action.saveTo,
        provider: resolved.provider,
        model: resolved.model,
        id: result.id,
      });
    }

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      id: result.id,
      status: result.status,
      url: result.url,
      ...(savedTo ? { savedTo } : {}),
      error: result.error,
    };
  }
};
