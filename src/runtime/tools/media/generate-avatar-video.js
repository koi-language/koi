/**
 * Generate Avatar Video Action — drive a still face image with an audio
 * track to produce a talking-avatar video.
 *
 * Inputs:
 *   - image (required): file path to the source face photo.
 *   - audioFile (required): file path to the driving audio.
 *   - optional prompt / aspectRatio / seed / saveTo / label / extra.
 *
 * Same flow as generate_video: kicks off the provider job, polls
 * internally until terminal, downloads the URL, saves to the media
 * library, and returns the final result. Pass `wait: false` to run as a
 * background koi job and use await_job / get_job_status to retrieve it.
 *
 * Permission: 'generate_video' (avatar shares the video budget — same
 * fal queue, same billing path).
 */

import fs from 'fs';
import path from 'path';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { _stashJobMetadata, getJobMetadata, clearJobMetadata, saveVideoFromUrl, _pollUntilTerminal } from './generate-video.js';
import { channel } from '../../io/channel.js';

const DEFAULT_POLL_INTERVAL_MS = 8000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const generateAvatarVideoAction = {
  type: 'generate_avatar_video',
  intent: 'generate_avatar_video',
  bannerKind: 'video',
  bannerLabel: 'Animando avatar',
  bannerIconId: 'generate-video',
  description:
    'Generate a talking-avatar video by driving a still face image with an audio track. Blocks internally until the video is ready and returns { success, savedTo, url, error? } — no second call is needed. Pass wait=false to run as a background koi job (use await_job / get_job_status).\n' +
    '\n' +
    'Required:\n' +
    '  - "image": absolute file path to the source face photo (front-facing portraits work best).\n' +
    '  - "audioFile": absolute file path to the driving audio (mp3 / wav / ogg / flac / aac / m4a / opus). Typical providers cap around 60 s.\n' +
    '\n' +
    'Optional:\n' +
    '  - "prompt": short scene/style hint forwarded to providers that accept one. Most avatar models ignore it.\n' +
    '  - "aspectRatio": "1:1" | "16:9" | "9:16" — provider-dependent enum.\n' +
    '  - "seed": integer seed for reproducible output.\n' +
    '  - "saveTo": directory where the finished video is saved. Defaults to ~/.koi/videos/.\n' +
    '  - "label": ranking hint for the model picker.\n' +
    '  - "timeoutMs" / "pollIntervalMs": tuning knobs for the internal poll loop (defaults: 600000 ms / 8000 ms).\n' +
    '\n' +
    'Returns: { success, savedTo?, url?, error?, provider, model, status }. On failure, `error` carries the verbatim provider message.',
  thinkingHint: 'Generating avatar video',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      image:        { type: 'string', description: 'Absolute path to the source face photo (jpg / png / webp).' },
      audioFile:    { type: 'string', description: 'Absolute path to the driving audio file.' },
      prompt:       { type: 'string', description: 'Optional scene / style hint (most avatar models ignore this).' },
      aspectRatio:  { type: 'string', description: 'Aspect ratio: "1:1", "16:9", "9:16" (provider-dependent).' },
      seed:         { type: 'number', description: 'Optional seed for reproducible output.' },
      saveTo:       { type: 'string', description: 'Directory to save the final video. Defaults to ~/.koi/videos/.' },
      timeoutMs:    { type: 'number', description: 'Max wall-clock to wait for the provider in ms (default 600000 = 10 min).' },
      pollIntervalMs: { type: 'number', description: 'Poll cadence in ms (default 8000, clamped to [2000, 30000]).' },
    },
    required: ['image', 'audioFile'],
  },

  examples: [
    {
      intent: 'generate_avatar_video',
      image: '/Users/me/portraits/anita.jpg',
      audioFile: '/Users/me/voiceovers/intro.mp3',
    },
    {
      intent: 'generate_avatar_video',
      image: '/tmp/founder.png',
      audioFile: '/tmp/announcement.wav',
      aspectRatio: '9:16',
      saveTo: '/Users/me/project/social',
    },
  ],

  async execute(action, agent) {
    const imagePath = action.image;
    const audioPath = action.audioFile;
    if (!imagePath) return { success: false, error: 'generate_avatar_video: "image" is required' };
    if (!audioPath) return { success: false, error: 'generate_avatar_video: "audioFile" is required' };

    const resolvedImage = path.resolve(imagePath);
    const resolvedAudio = path.resolve(audioPath);
    if (!fs.existsSync(resolvedImage)) {
      return { success: false, error: `Image not found: ${imagePath}` };
    }
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
    if (typeof instance.generateAvatar !== 'function') {
      return {
        success: false,
        error: 'Avatar video generation is only available when signed in (gateway mode). The current video provider does not expose generateAvatar.',
        provider: resolved.provider,
      };
    }

    const imageBuf = fs.readFileSync(resolvedImage);
    const audioBuf = fs.readFileSync(resolvedAudio);
    channel.log(
      'video',
      `generate_avatar_video: image=${path.basename(resolvedImage)} (${(imageBuf.length / 1024).toFixed(0)}KB), ` +
      `audio=${path.basename(resolvedAudio)} (${(audioBuf.length / 1024).toFixed(0)}KB), ` +
      `aspect=${action.aspectRatio ?? '-'}`,
    );

    const abortSignal = agent?.abortSignal;
    const reportProgress = typeof agent?.reportProgress === 'function' ? agent.reportProgress : null;

    reportProgress?.(0.02, 'Submitting to provider…');
    let submitted;
    try {
      submitted = await instance.generateAvatar(imageBuf, audioBuf, {
        imageFilename: path.basename(resolvedImage),
        audioFilename: path.basename(resolvedAudio),
        prompt: action.prompt,
        aspectRatio: action.aspectRatio,
        seed: action.seed,
        label: action.label,
        extra: action.extra,
      });
    } catch (err) {
      return { success: false, provider: resolved.provider, error: err.message || String(err) };
    }
    if (!submitted?.id && !submitted?.url) {
      return {
        success: false,
        provider: resolved.provider,
        model: submitted?.model,
        error: 'Avatar video submission returned no job id and no URL.',
      };
    }

    const generationParams = {
      kind: 'avatar',
      model: submitted.model,
      provider: submitted.provider || resolved.provider,
      prompt: action.prompt || null,
      aspectRatio: action.aspectRatio || null,
      seed: typeof action.seed === 'number' ? action.seed : null,
      imagePath: resolvedImage,
      audioPath: resolvedAudio,
      saveTo: action.saveTo || null,
    };
    if (submitted.id) _stashJobMetadata(submitted.id, generationParams);

    channel.log('video', `generate_avatar_video: queued id=${submitted.id} model=${submitted.model}`);

    const final = await _pollUntilTerminal(instance, submitted, {
      abortSignal,
      reportProgress,
      timeoutMs: typeof action.timeoutMs === 'number' && action.timeoutMs > 0
        ? action.timeoutMs
        : DEFAULT_TIMEOUT_MS,
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
    let saveError = null;
    if (final.url) {
      reportProgress?.(0.95, 'Downloading video…');
      const sr = await saveVideoFromUrl(final.url, {
        saveTo: action.saveTo,
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
      ...(saveError ? { saveError } : {}),
    };
  },
};

// Auto-disable when no avatar-capable model is active in the catalog.
// We accept three signals (any one is enough): the explicit `m.avatar`
// flag, an `'avatar'` entry in `m.operations`, or a recognisable
// avatar slug (Kling AI Avatar, Hedra, etc.) — the slug fallback
// avoids forcing the operator to manually retag every avatar row in
// the backoffice when the runtime can already tell from the slug.
fetchMediaCapabilities('video').then((caps) => {
  if (!caps) return;
  const looksLikeAvatarSlug = (s) =>
    typeof s === 'string'
    && /(?:^|[\/\-_])ai[-_]?avatar(?:$|[\/\-_])|(?:^|\/)avatar(?:$|\/)/i.test(s);
  const hasAvatar = Array.isArray(caps.models)
    && caps.models.some((m) => m?.avatar
      || (Array.isArray(m?.operations) && m.operations.includes('avatar'))
      || looksLikeAvatarSlug(m?.slug));
  if (!hasAvatar) {
    generateAvatarVideoAction.description =
      'Unavailable: no active avatar-capable video model in the catalog.';
  }
}).catch(() => {});

import asyncCapable from '../_async-capable.js';
export default asyncCapable(generateAvatarVideoAction);
