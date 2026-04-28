/**
 * Await Video Generation Action — Block until an async video job finishes.
 *
 * Polls the provider internally and only resolves when the job reaches a
 * terminal state (`completed` / `failed`) or the timeout fires. The agent
 * makes ONE call after generate_video and gets back the final result —
 * no LLM tokens are spent during the wait.
 *
 * Permission: 'generate_video' (same as generate — it's the same operation)
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { saveVideoFromUrl, getJobMetadata, clearJobMetadata } from './generate-video.js';
import { channel } from '../../io/channel.js';

const DEFAULT_POLL_INTERVAL_MS = 8000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — covers slow providers (Kling, Veo, Sora) on long durations
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30000;

const _sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) {
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    if (signal.aborted) { clearTimeout(t); reject(new Error('aborted')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

export default {
  type: 'await_video_generation',
  intent: 'await_video_generation',
  // Hidden as of 2026-04: generate_video now does the kick-off + polling +
  // download in a single call (or returns a koi jobId when wait=false). The
  // file is kept callable as a fallback for legacy code paths but no longer
  // advertised to the agent. New code should call generate_video directly
  // and use await_job for background mode.
  hidden: true,
  description:
    'DEPRECATED — generate_video now blocks internally until the provider finishes and returns the final video. This tool is kept only for legacy callers and is no longer advertised to agents. For background runs, call generate_video with wait=false and use await_job(jobId).\n' +
    '\n' +
    'Fields:\n' +
    '  - "id" (required) — job ID returned by generate_video\n' +
    '  - optional "provider" / "model" — pass them through if generate_video returned them\n' +
    '  - optional "saveTo" — directory where the finished video is downloaded. Pass the same value you gave generate_video.\n' +
    '  - optional "pollIntervalMs" — poll cadence in ms (default 8000, clamped to [2000, 30000]).\n' +
    '  - optional "timeoutMs" — max wall-clock to wait (default 600000 = 10 min).\n' +
    '\n' +
    'Returns: { success, id, status: completed|failed|pending, url?, savedTo?, shots?, error? }\n' +
    '  - status="pending" only happens when the timeout fired before the provider finished. Call await_video_generation again with the same id to keep waiting, or surface the timeout to the user.\n' +
    '\n' +
    'HANDLING `status: "failed"` (MANDATORY):\n' +
    '  Do NOT silently retry or pretend the job succeeded. Read the `error` string — it is the verbatim provider message (fal / ByteDance / Google / etc.) — and decide:\n' +
    '    - If it describes a provider-side content/policy rejection (safety filter, real-person / celebrity detector, NSFW, copyrighted subject, partner validation, …): STOP and tell the user what the provider rejected and why, using the provider\'s own wording. Then suggest concrete alternatives (use a different image, drop `startFrame`/`referenceImages` so the router picks a more permissive model, rephrase the prompt, …). These rejections are NOT bypassable by retrying.\n' +
    '    - If it describes a payload/validation problem the caller can fix (missing field, wrong enum value, bad format): report the error to the user, then retry once with the fix if the correction is unambiguous.\n' +
    '    - If it is transient (timeout, rate limit, "try again later"): call generate_video again, then await_video_generation on the new id.\n' +
    '    - Otherwise: surface the `error` to the user verbatim without inventing a cause.',
  thinkingHint: 'Waiting for video',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      id:             { type: 'string', description: 'Job/task ID returned by generate_video' },
      provider:       { type: 'string', description: 'Provider name (returned by generate_video)' },
      model:          { type: 'string', description: 'Model name (returned by generate_video)' },
      saveTo:         { type: 'string', description: 'Directory to save the video when the job completes. Pass the same value you gave generate_video. Defaults to ~/.koi/videos/ when omitted.' },
      pollIntervalMs: { type: 'number', description: 'Polling cadence in milliseconds. Default 8000. Clamped to [2000, 30000].' },
      timeoutMs:      { type: 'number', description: 'Max wall-clock to wait, in milliseconds. Default 600000 (10 min).' }
    },
    required: ['id']
  },

  examples: [
    { intent: 'await_video_generation', id: 'task_abc123', provider: 'kling', model: 'kling-v3' },
    { intent: 'await_video_generation', id: 'resp_xyz789' },
    { intent: 'await_video_generation', id: 'task_abc123', provider: 'kling', saveTo: '/Users/me/project/assets' }
  ],

  async execute(action, agent) {
    const jobId = action.id;
    if (!jobId) throw new Error('await_video_generation: "id" is required');

    const clients = agent?.llmProvider?.getClients?.() || {};

    let resolved;
    try {
      resolved = resolveModel({ type: 'video', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const pollMs = Math.min(
      MAX_POLL_INTERVAL_MS,
      Math.max(MIN_POLL_INTERVAL_MS, Number(action.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS),
    );
    const timeoutMs = Number(action.timeoutMs) > 0 ? Number(action.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const abortSignal = agent?.abortSignal;

    channel.log(
      'video',
      `await_video_generation: ${resolved.provider}/${resolved.model} job=${jobId} ` +
      `poll=${pollMs}ms timeout=${timeoutMs}ms`,
    );

    let result;
    let consecutiveErrors = 0;

    while (true) {
      if (abortSignal?.aborted) {
        return { success: false, id: jobId, status: 'pending', error: 'Aborted before video finished.' };
      }

      try {
        result = await resolved.instance.getStatus(jobId, { abortSignal });
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        // Transient errors (network blip, gateway hiccup) — back off and try
        // again. Bail after 5 consecutive failures to avoid pinning the loop
        // forever on a permanently-broken endpoint.
        if (consecutiveErrors >= 5) {
          return { success: false, id: jobId, error: `Polling failed repeatedly: ${err.message}` };
        }
        channel.log('video', `await_video_generation: transient poll error (${consecutiveErrors}/5): ${err.message}`);
        result = { id: jobId, status: 'processing' };
      }

      if (result.status === 'completed' || result.status === 'failed') break;

      if (Date.now() + pollMs > deadline) {
        return {
          success: false,
          provider: resolved.provider,
          model: resolved.model,
          id: jobId,
          status: 'pending',
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for video. Call await_video_generation again with the same id to keep waiting.`,
        };
      }

      try {
        await _sleep(pollMs, abortSignal);
      } catch {
        return { success: false, id: jobId, status: 'pending', error: 'Aborted before video finished.' };
      }
    }

    let savedTo = null;
    let saveError = null;
    if (result.status === 'completed' && result.url) {
      const saveResult = await saveVideoFromUrl(result.url, {
        saveTo: action.saveTo,
        provider: resolved.provider,
        model: resolved.model,
        id: result.id,
      });
      savedTo = saveResult.path;
      saveError = saveResult.error;
      if (savedTo && channel.canPresentResources?.()) {
        channel.presentResource({ type: 'video', path: savedTo });
      }
      if (savedTo) {
        try {
          const stashed = getJobMetadata(result.id) || getJobMetadata(jobId);
          const params = { ...(stashed || {}) };
          if (!params.provider) params.provider = resolved.provider;
          // The stashed model is whatever the user requested at submit
          // time — frequently the literal "auto" when the gateway picks
          // the model. Overwrite with the actual model the provider
          // returned (composite jobId / completion payload) so the GUI
          // info panel shows the real model, not "auto".
          if (result.model) params.model = result.model;
          else if (!params.model) params.model = resolved.model;
          const { saveGeneratedVideo } = await import('../../state/media-library.js');
          const llm = agent?.llmProvider || null;
          await saveGeneratedVideo(savedTo, params, llm);
          clearJobMetadata(result.id);
          clearJobMetadata(jobId);
        } catch {
          // Library save is non-critical — the file still made it to disk,
          // the GUI just won't show generation metadata for it.
        }
      }
    }

    let savedShots;
    if (Array.isArray(result.shots) && result.shots.length > 0) {
      savedShots = [];
      for (const shot of result.shots) {
        let shotSavedTo = null;
        let shotSaveError = null;
        if (shot.status === 'completed' && shot.url) {
          const shotSaveResult = await saveVideoFromUrl(shot.url, {
            saveTo: action.saveTo,
            provider: resolved.provider,
            model: resolved.model,
            id: `shot${shot.index}-${shot.id || ''}`,
          });
          shotSavedTo = shotSaveResult.path;
          shotSaveError = shotSaveResult.error;
          if (shotSavedTo && channel.canPresentResources?.()) {
            channel.presentResource({ type: 'video', path: shotSavedTo });
          }
        }
        savedShots.push({
          index: shot.index,
          id: shot.id,
          status: shot.status,
          url: shot.url,
          ...(shotSavedTo ? { savedTo: shotSavedTo } : {}),
          ...(shotSaveError ? { saveError: shotSaveError } : {}),
          error: shot.error,
        });
      }
    }

    return {
      success: result.status === 'completed',
      provider: resolved.provider,
      model: resolved.model,
      id: result.id,
      status: result.status,
      url: result.url,
      ...(savedTo ? { savedTo } : {}),
      ...(saveError ? { saveError } : {}),
      ...(savedShots ? { shots: savedShots } : {}),
      error: result.error,
    };
  }
};
