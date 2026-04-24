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
  description:
    'Check the status of an async video generation job. Use the job ID returned by generate_video.\n' +
    '\n' +
    'Fields:\n' +
    '  - "id" (required) — job ID from generate_video\n' +
    '  - optional "provider" / "model" — pass them through if generate_video returned them\n' +
    '  - optional "saveTo" — directory; when status becomes "completed" the video is downloaded there. Pass the same value you gave generate_video.\n' +
    '\n' +
    'Returns: { success, id, status: pending|processing|completed|failed, url?, savedTo?, error? }\n' +
    '\n' +
    'HANDLING `status: "failed"` (MANDATORY):\n' +
    '  Do NOT silently retry or pretend the job succeeded. Read the `error` string — it is the verbatim provider message (fal / ByteDance / Google / etc.) — and decide:\n' +
    '    - If it describes a provider-side content/policy rejection (safety filter, real-person / celebrity detector, NSFW, copyrighted subject, partner validation, …): STOP polling and tell the user what the provider rejected and why, using the provider\'s own wording. Then suggest concrete alternatives (use a different image, drop `startFrame`/`referenceImages` so the router picks a more permissive model, rephrase the prompt, …). These rejections are NOT bypassable by retrying.\n' +
    '    - If it describes a payload/validation problem the caller can fix (missing field, wrong enum value, bad format): report the error to the user, then retry once with the fix if the correction is unambiguous.\n' +
    '    - If it is transient (timeout, rate limit, "try again later"): wait briefly and retry.\n' +
    '    - Otherwise: surface the `error` to the user verbatim without inventing a cause.',
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

    // Multishot: save each shot's URL that has completed. The
    // per-shot file lands in the same saveTo directory, tagged with
    // its index so the caller can reassemble the sequence. Still-
    // pending shots are reported with url=null; the caller can poll
    // again later.
    let savedShots;
    if (Array.isArray(result.shots) && result.shots.length > 0) {
      savedShots = [];
      for (const shot of result.shots) {
        let shotSavedTo = null;
        if (shot.status === 'completed' && shot.url) {
          shotSavedTo = await saveVideoFromUrl(shot.url, {
            saveTo: action.saveTo,
            provider: resolved.provider,
            model: resolved.model,
            id: `shot${shot.index}-${shot.id || ''}`,
          });
        }
        savedShots.push({
          index: shot.index,
          id: shot.id,
          status: shot.status,
          url: shot.url,
          ...(shotSavedTo ? { savedTo: shotSavedTo } : {}),
          error: shot.error,
        });
      }
    }

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      id: result.id,
      status: result.status,
      url: result.url,
      ...(savedTo ? { savedTo } : {}),
      ...(savedShots ? { shots: savedShots } : {}),
      error: result.error,
    };
  }
};
