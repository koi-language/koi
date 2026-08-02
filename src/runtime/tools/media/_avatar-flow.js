/**
 * Avatar flow — drive a still face image with an audio track to produce a
 * talking-avatar video. UNIFIED into `generate_video`: the agent calls
 * generate_video with `startFrame` (the face photo) + `audioFile` (the
 * driving audio) + a REQUIRED `model` carrying the `video_avatar`
 * category, and generate-video.js delegates here. There is no separate
 * `generate_avatar_video` tool anymore (same surface on MCP).
 *
 * Same job plumbing as the rest of generate_video: kicks off the provider
 * job, polls internally until terminal, downloads the URL, saves to the
 * media library, and returns the final result. `wait:false` rides
 * generate_video's own asyncCapable wrapper.
 */

import fs from 'fs';
import path from 'path';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { _stashJobMetadata, clearJobMetadata, saveVideoFromUrl, _pollUntilTerminal, _resolveTimeoutMs } from './generate-video.js';
import { exportMediaCopy } from './util/export-copy.js';
import { channel } from '../../io/channel.js';

const DEFAULT_POLL_INTERVAL_MS = 8000;

/** Run the avatar generation for a generate_video action in avatar mode.
 *  Expects on [action]: image (mapped from startFrame by the caller),
 *  audioFile, model (already validated non-empty by generate_video),
 *  and optionally prompt / aspectRatio / seed / saveTo / label / extra. */
export async function runAvatarFlow(action, agent) {
  const imagePath = action.image;
  const audioPath = action.audioFile;
  if (!imagePath) {
    return {
      success: false,
      error: 'generate_video (avatar): "startFrame" is required — the face photo the avatar performs from. audioFile without a face photo has nothing to animate.',
    };
  }
  if (!audioPath) return { success: false, error: 'generate_video (avatar): "audioFile" is required' };

  // Resolve paths via MediaLibrary lookup when the literal path doesn't
  // exist (workers routinely hallucinate `~/.koi/media/<id>.png`-style
  // paths from recall results; the library row is authoritative).
  let resolvedImage = path.resolve(imagePath);
  if (!fs.existsSync(resolvedImage)) {
    const fallback = await _resolveViaLibrary(imagePath);
    if (fallback) {
      resolvedImage = fallback;
    } else {
      return { success: false, error: `Image not found: ${imagePath}` };
    }
  }
  let resolvedAudio = path.resolve(audioPath);
  if (!fs.existsSync(resolvedAudio)) {
    const fallback = await _resolveViaLibrary(audioPath);
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

  // Find the CHOSEN model's catalog row so input adaptation runs against
  // ITS declared caps (model is pinned now — no router peek needed; fall
  // back to null → no adaptation when the row can't be fetched).
  let avatarModelRow = null;
  try {
    const { fetchMediaCapabilities } = await import('../../llm/providers/gateway.js');
    const caps = await fetchMediaCapabilities('video');
    avatarModelRow = (caps?.models || []).find((m) => m.slug === action.model) || null;
  } catch { /* no row → no restriction → ship original */ }

  // Generic constraint-aware adaptation: dim caps first, then iterative
  // lossless PNG shrink for any maxBytes overshoot. No-op when the
  // adapter declared nothing. adaptImageInput logs its own trace.
  channel.log(
    'constraints',
    `[tool  ] generate_video(avatar): source ${(imageBuf.length / 1024).toFixed(0)}KB — ` +
    `checking ${avatarModelRow?.slug ?? action.model}.imageUrl caps…`,
  );
  try {
    const { adaptImageInput } = await import('../../llm/providers/_constraints.js');
    const adapted = await adaptImageInput(imageBuf, avatarModelRow, 'imageUrl');
    if (adapted.changed) {
      imageBuf = adapted.buffer;
    }
  } catch (err) {
    channel.log(
      'video',
      `generate_video(avatar): adapt-image step skipped (${err?.message || err}) — uploading original`,
    );
  }

  // Audio: catalog may cap bytes (e.g. omnihuman).
  try {
    const { checkAudioInput } = await import('../../llm/providers/_constraints.js');
    const check = checkAudioInput(audioBuf, {}, avatarModelRow, 'audioUrl');
    if (!check.ok) {
      return {
        success: false,
        error: check.error,
        hint: 'The chosen model has a hard cap on this audio input declared in its adapter.',
      };
    }
  } catch { /* no helper → skip check */ }
  channel.log(
    'video',
    `generate_video(avatar): image=${imageFilename} (${(imageBuf.length / 1024).toFixed(0)}KB), ` +
    `audio=${path.basename(resolvedAudio)} (${(audioBuf.length / 1024).toFixed(0)}KB), ` +
    `model=${action.model}, aspect=${action.aspectRatio ?? '-'}`,
  );

  const abortSignal = agent?.abortSignal;
  const reportProgress = typeof agent?.reportProgress === 'function' ? agent.reportProgress : null;

  // Cost consent handled up front by the media banner wrapper.

  // Native per-model escape hatch. The tool field is `extraParams` (the old
  // `action.extra` name never existed on the schema — that's why extra params
  // silently never reached avatar models). If a LOCAL mask image path rides in
  // `extraParams.mask_url` (OmniHuman's subject selector: white = speaks), read
  // it here so the gateway can upload it to fal storage and swap in the URL — a
  // raw local path would 400 upstream.
  let extraParams = action.extraParams || action.extra_params || undefined;
  let maskBuffer = null;
  let maskFilename = null;
  if (extraParams && typeof extraParams.mask_url === 'string' && !/^https?:\/\//i.test(extraParams.mask_url)) {
    try {
      const _mp = path.resolve(extraParams.mask_url);
      if (fs.existsSync(_mp)) {
        maskBuffer = fs.readFileSync(_mp);
        maskFilename = path.basename(_mp);
        extraParams = { ...extraParams };
        delete extraParams.mask_url; // gateway re-adds it as a fal URL post-upload
      }
    } catch { /* leave mask_url as-is; gateway forwards it verbatim */ }
  }

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
      extraParams,
      maskBuffer,
      maskFilename,
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

  channel.log('video', `generate_video(avatar): queued id=${submitted.id} model=${submitted.model}`);

  // Stream fal-status updates to the chat banner (IN_QUEUE / IN_PROGRESS).
  const _emitBannerStatus = typeof action._emitMediaStatus === 'function'
    ? action._emitMediaStatus
    : null;
  const _onPollTick = _emitBannerStatus
    ? (latest) => {
        const rawLc = typeof latest?.rawStatus === 'string'
          ? latest.rawStatus.toLowerCase() : '';
        let falStatus = null;
        if (rawLc) {
          if (/(progress|process|running|generat|render|encod|upscal|active|start)/.test(rawLc)) {
            falStatus = 'IN_PROGRESS';
          } else if (/(queue|pending|wait|submit|creat|accept|init)/.test(rawLc)) {
            falStatus = 'IN_QUEUE';
          }
        }
        falStatus ??= latest?.status === 'pending' ? 'IN_QUEUE'
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
  let exportedTo = null; // copy at the caller's saveTo (original stays in ~/.koi/videos)
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
        // Per-creation billing trail — same fields the non-avatar path
        // pins (final.creditsCost / final.providerRequestId travel on the
        // gateway status response). The old standalone avatar tool never
        // copied them, which is why avatar videos showed no "Cost: X
        // credits" in the Info panel while normal generations did.
        if (typeof final.creditsCost === 'number') {
          params.creditsCost = final.creditsCost;
        }
        if (typeof final.providerRequestId === 'string') {
          params.providerRequestId = final.providerRequestId;
        }
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
}

/** Best-effort MediaLibrary lookup for a hallucinated path — see
 *  generate-video.js for the rationale. Returns the row's on-disk path
 *  or null. */
async function _resolveViaLibrary(input) {
  if (typeof input !== 'string' || !input) return null;
  const base = path.basename(input, path.extname(input));
  if (!base) return null;
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
        channel.log('video',
            `generate_video(avatar): resolved via library: "${input}" → ${row.filePath}`);
        return row.filePath;
      }
    } catch { /* try next */ }
  }
  return null;
}
