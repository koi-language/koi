/**
 * Lipsync Video Action — re-articulate the lips of an EXISTING video so it
 * appears to speak a new audio track (dub / re-voice a clip). Everything else
 * in the source (framing, motion, background, dimensions, length) is
 * preserved; only the mouth changes. Produces a NEW video.
 *
 * This is NOT the avatar tool: avatar animates a still face IMAGE, this takes
 * a real VIDEO. Distinct tool, distinct backend route (/media/video/lipsync),
 * distinct model bucket (video_lipsync → veed/lipsync/v2).
 *
 * Inputs:
 *   - video (required): file path to the source clip.
 *   - audioFile (required): file path to the new audio track.
 *   - optional saveTo / label / timeoutMs / pollIntervalMs.
 *
 * Same flow as generate_video: kicks off the provider job, polls
 * internally until terminal, downloads the URL, saves to the media library,
 * and returns the final result. Pass `wait: false` to run as a background koi
 * job and use await_job / get_job_status to retrieve it.
 *
 * Permission: 'generate_video' (shares the video budget — same fal queue,
 * same billing path).
 */

import fs from 'fs';
import path from 'path';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { saveVideoFromUrl, _pollUntilTerminal, _resolveTimeoutMs, _stashJobMetadata, getJobMetadata, clearJobMetadata } from './generate-video.js';
import { exportMediaCopy } from './util/export-copy.js';
import { channel } from '../../io/channel.js';

const DEFAULT_POLL_INTERVAL_MS = 8000;

const lipsyncVideoAction = {
  type: 'lipsync_video',
  intent: 'lipsync_video',
  bannerKind: 'video',
  bannerLabel: 'Sincronizando labios',
  bannerIconId: 'generate-video',
  description:
    'Lip-sync an EXISTING video to a new audio track: re-articulates the on-screen mouth so the person appears to speak the given audio, preserving everything else (framing, motion, background, dimensions, length). Use to dub / re-voice a clip you already have — NOT to animate a still photo (that is generate_video in avatar mode: startFrame + audioFile + a video_avatar model). Blocks internally until the video is ready and returns { success, savedTo, url, error? } — no second call is needed. Pass wait=false to run as a background koi job (use await_job / get_job_status).\n' +
    '\n' +
    'Required:\n' +
    '  - "video": absolute file path to the source clip whose lips get re-synced.\n' +
    '  - "audioFile": absolute file path to the new audio track (mp3 / wav / ogg / flac / aac / m4a / opus).\n' +
    '\n' +
    'Optional:\n' +
    '  - "saveTo": directory (or full file path) where a COPY of the finished video is saved. The original always stays in ~/.koi/videos/.\n' +
    '  - "label": ranking hint for the model picker.\n' +
    '  - "timeoutMs" / "pollIntervalMs": tuning knobs for the internal poll loop (defaults: 1200000 ms / 8000 ms).\n' +
    '\n' +
    'Returns: { success, savedTo?, exportedTo?, url?, error?, provider, model, status }. On failure, `error` carries the verbatim provider message.',
  thinkingHint: 'Lip-syncing video',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      video:          { type: 'string', description: 'Absolute path to the source video whose lips get re-synced.' },
      audioFile:      { type: 'string', description: 'Absolute path to the new audio track the video should lip-sync to.' },
      saveTo:         { type: 'string', description: 'Where to place a COPY of the final video (a directory, or a full video file path). The original always stays in ~/.koi/videos/ (returned as `savedTo`); the copy is returned as `exportedTo`.' },
      timeoutMs:      { type: 'number', description: 'Max wall-clock to wait for the provider in ms (default 1200000 = 20 min).' },
      pollIntervalMs: { type: 'number', description: 'Poll cadence in ms (default 8000, clamped to [2000, 30000]).' },
    },
    required: ['video', 'audioFile'],
  },

  examples: [
    {
      intent: 'lipsync_video',
      video: '/Users/me/clips/spokesperson.mp4',
      audioFile: '/Users/me/voiceovers/spanish-dub.mp3',
    },
  ],

  async execute(action, agent) {
    // Guard — see generate-image.js for rationale.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('lipsync_video', agent);
    if (_guard) return _guard;

    const videoPath = action.video;
    const audioPath = action.audioFile;
    if (!videoPath) return { success: false, error: 'lipsync_video: "video" is required' };
    if (!audioPath) return { success: false, error: 'lipsync_video: "audioFile" is required' };

    const resolvedVideo = path.resolve(videoPath);
    if (!fs.existsSync(resolvedVideo)) {
      return { success: false, error: `Video not found: ${videoPath}` };
    }
    const resolvedAudio = path.resolve(audioPath);
    if (!fs.existsSync(resolvedAudio)) {
      return { success: false, error: `Audio file not found: ${audioPath}` };
    }

    const clients = agent?.llmProvider?.getClients?.() || {};
    let resolved;
    try {
      resolved = resolveModel({ type: 'video', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }
    const instance = resolved.instance;
    if (typeof instance.generateLipsync !== 'function') {
      return {
        success: false,
        error: 'Lip-sync is only available when signed in (gateway mode). The current video provider does not expose generateLipsync.',
        provider: resolved.provider,
      };
    }

    const videoBuf = fs.readFileSync(resolvedVideo);
    const audioBuf = fs.readFileSync(resolvedAudio);
    channel.log(
      'video',
      `lipsync_video: video=${path.basename(resolvedVideo)} (${(videoBuf.length / 1024).toFixed(0)}KB), ` +
      `audio=${path.basename(resolvedAudio)} (${(audioBuf.length / 1024).toFixed(0)}KB)`,
    );

    const abortSignal = agent?.abortSignal;
    const reportProgress = typeof agent?.reportProgress === 'function' ? agent.reportProgress : null;

    // Cost consent handled up front by the media banner wrapper.
    reportProgress?.(0.02, 'Submitting to provider…');
    let submitted;
    try {
      submitted = await instance.generateLipsync(videoBuf, audioBuf, {
        videoFilename: path.basename(resolvedVideo),
        audioFilename: path.basename(resolvedAudio),
        label: action.label,
        abortSignal,
      });
    } catch (err) {
      return { success: false, provider: resolved.provider, error: err.message || String(err) };
    }
    if (!submitted?.id && !submitted?.url) {
      return {
        success: false,
        provider: resolved.provider,
        model: submitted?.model,
        error: 'Lipsync submission returned no job id and no URL.',
      };
    }

    const generationParams = {
      kind: 'lipsync',
      model: submitted.model,
      provider: submitted.provider || resolved.provider,
      videoPath: resolvedVideo,
      audioPath: resolvedAudio,
      saveTo: action.saveTo || null,
    };
    if (submitted.id) _stashJobMetadata(submitted.id, generationParams);

    channel.log('video', `lipsync_video: queued id=${submitted.id} model=${submitted.model}`);

    const _emitBannerStatus = typeof action._emitMediaStatus === 'function'
      ? action._emitMediaStatus
      : null;
    const _onPollTick = _emitBannerStatus
      ? (latest) => {
          const rawLc = typeof latest?.rawStatus === 'string' ? latest.rawStatus.toLowerCase() : '';
          let falStatus = null;
          if (rawLc) {
            if (/(progress|process|running|generat|render|encod|upscal|active|start)/.test(rawLc)) falStatus = 'IN_PROGRESS';
            else if (/(queue|pending|wait|submit|creat|accept|init)/.test(rawLc)) falStatus = 'IN_QUEUE';
          }
          falStatus ??= latest?.status === 'pending' ? 'IN_QUEUE'
            : latest?.status === 'processing' ? 'IN_PROGRESS'
            : null;
          if (falStatus) {
            _emitBannerStatus({
              falStatus,
              queuePosition: typeof latest?.queuePosition === 'number' ? latest.queuePosition : undefined,
            });
          }
        }
      : null;

    const final = await _pollUntilTerminal(instance, submitted, {
      abortSignal,
      reportProgress,
      onTick: _onPollTick,
      timeoutMs: _resolveTimeoutMs(action),
      pollIntervalMs: typeof action.pollIntervalMs === 'number' && action.pollIntervalMs > 0
        ? action.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS,
    });

    if (final.status === 'failed') {
      if (submitted.id) clearJobMetadata(submitted.id);
      return {
        success: false,
        provider: resolved.provider,
        model: final.model || submitted.model || resolved.model,
        id: final.id || submitted.id,
        status: 'failed',
        error: final.error || 'Provider reported failure with no error message.',
      };
    }
    if (final.status === 'pending') {
      return {
        success: false,
        provider: resolved.provider,
        model: final.model || submitted.model || resolved.model,
        id: final.id || submitted.id,
        status: 'pending',
        error: final.error || 'Timed out waiting for provider to finish.',
      };
    }

    let savedTo = null;
    let exportedTo = null;
    let saveError = null;
    if (final.url) {
      reportProgress?.(0.95, 'Downloading video…');
      const sr = await saveVideoFromUrl(final.url, {
        provider: resolved.provider,
        model: final.model || submitted.model || resolved.model,
        id: final.id || submitted.id,
      });
      savedTo = sr.path;
      saveError = sr.error;
      if (savedTo && channel.canPresentResources?.()) {
        channel.presentResource({ type: 'video', path: savedTo });
      }
      if (savedTo) {
        try {
          const params = { ...generationParams };
          if (final.model) params.model = final.model;
          const { saveGeneratedVideo } = await import('../../state/media-library.js');
          await saveGeneratedVideo(savedTo, params, agent?.llmProvider || null);
          channel.log('video', `Saved to media library: ${savedTo}`);
        } catch (err) {
          channel.log('video', `Media library save failed (continuing): ${err.message}`);
        }
        if (action.saveTo) {
          exportedTo = exportMediaCopy(savedTo, action.saveTo, { logTag: 'video' });
        }
      }
    }
    if (submitted.id) clearJobMetadata(submitted.id);

    reportProgress?.(1, 'Done');
    return {
      success: true,
      provider: resolved.provider,
      model: final.model || submitted.model || resolved.model,
      id: final.id || submitted.id,
      status: 'completed',
      url: final.url,
      ...(savedTo ? { savedTo } : {}),
      ...(exportedTo ? { exportedTo } : {}),
      ...(saveError ? { saveError } : {}),
    };
  },
};

// Auto-disable when no lipsync-capable model is active in the catalog: the
// sole signal is at least one model row carrying the Koi-owned
// `video_lipsync` category.
fetchMediaCapabilities('video').then((caps) => {
  if (!caps) return;
  if (!caps.hasLipsync) {
    lipsyncVideoAction.description =
      'Unavailable: no active model carries the `video_lipsync` category.';
  }
}).catch(() => {});

import asyncCapable from '../_async-capable.js';
export default asyncCapable(lipsyncVideoAction);
