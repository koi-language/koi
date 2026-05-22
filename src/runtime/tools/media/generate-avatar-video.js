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
import sharp from 'sharp';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { _stashJobMetadata, getJobMetadata, clearJobMetadata, saveVideoFromUrl, _pollUntilTerminal } from './generate-video.js';
import { channel } from '../../io/channel.js';

// Fal's hard cap for file_too_large is 10 MB / 10485760 bytes (see
// `docs.fal.ai/model-apis/errors`). Originals that exceed this also
// occasionally trigger `body.image_url: Failed to download the file`
// on the worker side even when the upload itself succeeded, so we keep
// a small safety margin below the documented ceiling.
//
// Re-encoding strategy: ALWAYS lossless PNG (`compressionLevel: 9`).
// JPEG is forbidden — we never want to silently degrade pixel values
// the model relies on for face / lipsync work. When the original
// already fits, we ship the original bytes untouched (zero re-encode).
// When it doesn't, we shrink the longest side by 15 % per iteration
// and re-encode until it fits, capped at 8 iterations so a pathological
// file can't loop forever.
// Image adaptation now lives in `_constraints.adaptImageInput` —
// generic algorithm used across every media tool. This file no
// longer carries shrink-loop parameters.

const DEFAULT_POLL_INTERVAL_MS = 8000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

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
    '  - "timeoutMs" / "pollIntervalMs": tuning knobs for the internal poll loop (defaults: 1200000 ms / 8000 ms).\n' +
    '\n' +
    'Returns: { success, savedTo?, url?, error?, provider, model, status }. On failure, `error` carries the verbatim provider message.',
  thinkingHint: 'Generating avatar video',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      image:        { type: 'string', description: 'Absolute path to the source face photo (jpg / png / webp).' },
      audioFile:    { type: 'string', description: 'Absolute path to the driving audio file.' },
      prompt:       { type: 'string', description: 'Optional scene / style hint (most avatar models ignore this). MANDATORY when set: write it in English regardless of the user\'s language — avatar models that DO read this field are trained on English. The spoken content is driven by `audioFile`, not by this prompt; this field is for visual scene direction only.' },
      aspectRatio:  { type: 'string', description: 'Aspect ratio: "1:1", "16:9", "9:16" (provider-dependent).' },
      seed:         { type: 'number', description: 'Optional seed for reproducible output.' },
      saveTo:       { type: 'string', description: 'Directory to save the final video. Defaults to ~/.koi/videos/.' },
      timeoutMs:    { type: 'number', description: 'Max wall-clock to wait for the provider in ms (default 1200000 = 20 min).' },
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
    // Guard — see generate-image.js for rationale.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('generate_avatar_video', agent);
    if (_guard) return _guard;

    const imagePath = action.image;
    const audioPath = action.audioFile;
    if (!imagePath) return { success: false, error: 'generate_avatar_video: "image" is required' };
    if (!audioPath) return { success: false, error: 'generate_avatar_video: "audioFile" is required' };

    // Resolve the image path via MediaLibrary lookup if the literal
    // path doesn't exist. Workers routinely hallucinate paths like
    // `~/.koi/media/<media-id>.png` from a `recall_image` result —
    // the library row is the authoritative source. Falling back to
    // the lookup turns those drive-by mistakes into successful calls.
    let resolvedImage = path.resolve(imagePath);
    if (!fs.existsSync(resolvedImage)) {
      const fallback = await _resolveImageViaLibrary(imagePath);
      if (fallback) {
        resolvedImage = fallback;
      } else {
        return { success: false, error: `Image not found: ${imagePath}` };
      }
    }
    let resolvedAudio = path.resolve(audioPath);
    if (!fs.existsSync(resolvedAudio)) {
      const fallback = await _resolveImageViaLibrary(audioPath);
      if (fallback) {
        resolvedAudio = fallback;
      } else {
        return { success: false, error: `Audio file not found: ${audioPath}` };
      }
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

    const audioBuf = fs.readFileSync(resolvedAudio);
    let imageBuf = fs.readFileSync(resolvedImage);
    const imageFilename = path.basename(resolvedImage); // .png kept; never JPEG

    // Ask the router which avatar slug it would dispatch to so we
    // adapt inputs against THAT model's restrictions (not some
    // hardcoded conservative cap). When peek isn't available we
    // ship inputs untouched.
    let pickedAvatarModel = null;
    try {
      if (typeof agent?.videoGen?.peekModel === 'function') {
        pickedAvatarModel = await agent.videoGen.peekModel({
          kind: 'avatar',
          hasImageUrl: true,
          hasAudioUrl: true,
        });
      }
    } catch { /* no peek → no restriction → ship original */ }

    // Generic constraint-aware adaptation. The helper applies
    // dim caps first (maxWidth / maxHeight / maxArea on `imageUrl`),
    // then iterative lossless PNG shrink for any remaining
    // maxBytes overshoot. No-op when the adapter declared nothing.
    try {
      const { adaptImageInput } = await import('../../llm/providers/_constraints.js');
      const adapted = await adaptImageInput(imageBuf, pickedAvatarModel, 'imageUrl');
      if (adapted.changed) {
        imageBuf = adapted.buffer;
        channel.log('video', `generate_avatar_video: ${adapted.reason}`);
      }
    } catch (err) {
      // Sharp parse / re-encode failed — fall back to the original
      // bytes and let the model try its luck. Logging only so the
      // user can see why an oversized image might still slip through.
      channel.log(
        'video',
        `generate_avatar_video: adapt-image step skipped (${err?.message || err}) — uploading original`,
      );
    }

    // Audio: catalog may cap bytes (e.g. omnihuman). Duration checks
    // would need an ffprobe-style helper we don't have in-runtime
    // yet — skip those and let the model reject if the clip is too
    // long. Once a duration probe is wired in, swap the meta arg.
    try {
      const { checkAudioInput } = await import('../../llm/providers/_constraints.js');
      const check = checkAudioInput(audioBuf, {}, pickedAvatarModel, 'audioUrl');
      if (!check.ok) {
        return {
          success: false,
          error: check.error,
          hint: 'The picked model has a hard cap on this audio input declared in its adapter.',
        };
      }
    } catch { /* no helper → skip check */ }
    channel.log(
      'video',
      `generate_avatar_video: image=${imageFilename} (${(imageBuf.length / 1024).toFixed(0)}KB), ` +
      `audio=${path.basename(resolvedAudio)} (${(audioBuf.length / 1024).toFixed(0)}KB), ` +
      `aspect=${action.aspectRatio ?? '-'}`,
    );

    const abortSignal = agent?.abortSignal;
    const reportProgress = typeof agent?.reportProgress === 'function' ? agent.reportProgress : null;

    reportProgress?.(0.02, 'Submitting to provider…');
    let submitted;
    try {
      submitted = await instance.generateAvatar(imageBuf, audioBuf, {
        imageFilename: imageFilename,
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

    // Stream fal-status updates to the chat banner so the GUI can show
    // IN_QUEUE / IN_PROGRESS instead of just an asymptotic timer. The
    // emitter is set by the action-registry's banner wrapper.
    const _emitBannerStatus = typeof action._emitMediaStatus === 'function'
      ? action._emitMediaStatus
      : null;
    const _onPollTick = _emitBannerStatus
      ? (latest) => {
          const falStatus = latest?.status === 'pending' ? 'IN_QUEUE'
            : latest?.status === 'processing' ? 'IN_PROGRESS'
            : null;
          if (falStatus) {
            _emitBannerStatus({
              falStatus,
              queuePosition: typeof latest?.queuePosition === 'number'
                ? latest.queuePosition
                : undefined,
            });
          }
        }
      : null;

    const final = await _pollUntilTerminal(instance, submitted, {
      abortSignal,
      reportProgress,
      onTick: _onPollTick,
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
// Sole signal: at least one model row carries the Koi-owned
// `video_avatar` category. Vendor `m.avatar` flag, `operations[]`
// containing 'avatar', and slug heuristics were retired — categories
// is the authoritative source now (gateway aggregator exposes
// `caps.hasAvatar` derived from `categories[]`).
fetchMediaCapabilities('video').then((caps) => {
  if (!caps) return;
  if (!caps.hasAvatar) {
    generateAvatarVideoAction.description =
      'Unavailable: no active model carries the `video_avatar` category.';
  }
}).catch(() => {});

/**
 * Best-effort lookup: when an image/audio path the agent passes doesn't
 * exist on disk, try to recover it from the MediaLibrary by treating
 * the path's basename (without extension) as a media id. Worker LLMs
 * often invent `~/.koi/media/<media-id>.png`-style paths from a prior
 * `recall_image` result instead of using the row's actual `filePath`;
 * this fallback turns that miss into a hit.
 *
 * Returns the absolute on-disk path of the matched row, or null if no
 * row matches / the row's file is missing / the library is unavailable.
 */
async function _resolveImageViaLibrary(input) {
  if (typeof input !== 'string' || !input) return null;
  // Strip directory and extension — what the agent passes as the
  // basename is typically the media id verbatim.
  const base = path.basename(input, path.extname(input));
  if (!base) return null;
  // Try basename + the full string (so callers that pass just the id
  // also work without inventing a path first).
  const candidates = base === input ? [base] : [base, input];
  let lib;
  try {
    const mod = await import('../../state/media-library.js');
    lib = mod.MediaLibrary.global();
  } catch { return null; }
  if (!lib) return null;
  for (const id of candidates) {
    try {
      const row = await lib.get(id);
      if (row && row.filePath && fs.existsSync(row.filePath)) {
        channel.log('generate_avatar_video',
            `Resolved image via library: "${input}" → ${row.filePath}`);
        return row.filePath;
      }
    } catch { /* try next */ }
  }
  return null;
}

import asyncCapable from '../_async-capable.js';
export default asyncCapable(generateAvatarVideoAction);
