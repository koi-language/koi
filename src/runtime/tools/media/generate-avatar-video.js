/**
 * Generate Avatar Video Action — drive a still face image with an audio
 * track to produce a talking-avatar video.
 *
 * Inputs:
 *   - image (required): file path to the source face photo.
 *   - audioFile (required): file path to the driving audio.
 *   - optional prompt / aspectRatio / seed / saveTo / label / extra.
 *
 * The async path matches generate_video: this tool returns a job id;
 * the agent then calls await_video_generation with that id to block
 * until the avatar video is ready and download it.
 *
 * Permission: 'generate_video' (avatar shares the video budget — same
 * fal queue, same billing path).
 */

import fs from 'fs';
import path from 'path';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { _stashJobMetadata } from './generate-video.js';
import { channel } from '../../io/channel.js';

const generateAvatarVideoAction = {
  type: 'generate_avatar_video',
  intent: 'generate_avatar_video',
  description:
    'Generate a talking-avatar video by driving a still face image with an audio track. Async — returns a job id; pass it to await_video_generation to block until the video is ready.\n' +
    '\n' +
    'Required:\n' +
    '  - "image": absolute file path to the source face photo (front-facing portraits work best).\n' +
    '  - "audioFile": absolute file path to the driving audio (mp3 / wav / ogg / flac / aac / m4a / opus). Typical providers cap around 60 s.\n' +
    '\n' +
    'Optional:\n' +
    '  - "prompt": short scene/style hint forwarded to providers that accept one. Most avatar models ignore it.\n' +
    '  - "aspectRatio": "1:1" | "16:9" | "9:16" — provider-dependent enum.\n' +
    '  - "seed": integer seed for reproducible output.\n' +
    '  - "saveTo": directory where the finished video is saved. Pass the SAME value to await_video_generation.\n' +
    '  - "label": ranking hint for the model picker.\n' +
    '\n' +
    'Returns: { success, id, status, model, provider }. Always async — call await_video_generation next.',
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
      saveTo:       { type: 'string', description: 'Directory to save the final video. Pass the same value to await_video_generation. Defaults to ~/.koi/videos/.' },
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

    let result;
    try {
      result = await instance.generateAvatar(imageBuf, audioBuf, {
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
    if (!result?.id) {
      return {
        success: false,
        provider: resolved.provider,
        model: result?.model,
        error: 'Avatar video submission returned no job id.',
      };
    }

    // Stash generation metadata so await_video_generation persists the
    // canonical fields (prompt, aspectRatio, ...) when the file lands.
    const generationParams = {
      kind: 'avatar',
      model: result.model,
      provider: result.provider || resolved.provider,
      prompt: action.prompt || null,
      aspectRatio: action.aspectRatio || null,
      seed: typeof action.seed === 'number' ? action.seed : null,
      imagePath: resolvedImage,
      audioPath: resolvedAudio,
      saveTo: action.saveTo || null,
    };
    _stashJobMetadata(result.id, generationParams);

    channel.log(
      'video',
      `generate_avatar_video: queued id=${result.id} model=${result.model}`,
    );

    return {
      success: true,
      id: result.id,
      status: result.status || 'pending',
      model: result.model,
      provider: result.provider || resolved.provider,
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

export default generateAvatarVideoAction;
