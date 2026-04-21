/**
 * Generate Video Action — Generate videos from text prompts.
 *
 * Delegates to the provider factory which auto-selects the best available
 * video provider: Kling → Seedance → OpenAI (Sora) → Gemini (Veo) → Google (Nano Banana).
 *
 * Video generation is ASYNC — returns a job ID that can be polled with check_video_status.
 * All parameters use NORMALIZED values (aspect ratios, resolutions, etc.)
 *
 * Permission: 'generate_video' (individual permission for video generation)
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { channel } from '../../io/channel.js';
import { normalizeImageForProvider } from './_normalize-image-for-provider.js';

/**
 * Download a finished video URL to disk. Shared helper used by
 * generate_video (for synchronous completions) and check_video_status (for
 * async polling). Returns the absolute saved path, or null if the URL could
 * not be downloaded. `saveTo` is treated as a DIRECTORY — filename is
 * auto-generated to match the generate_image convention.
 */
export async function saveVideoFromUrl(url, { saveTo, provider, model, id } = {}) {
  if (!url) return null;
  const saveDir = typeof saveTo === 'string' && saveTo.trim()
    ? path.resolve(saveTo.trim())
    : path.join(os.homedir(), '.koi', 'videos');
  try {
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    const resp = await fetch(url);
    if (!resp.ok) {
      channel.log('video', `Failed to download ${url}: HTTP ${resp.status}`);
      return null;
    }
    const contentType = resp.headers.get('content-type') || '';
    const ext = /mp4/i.test(contentType) ? 'mp4'
      : /webm/i.test(contentType) ? 'webm'
      : /quicktime/i.test(contentType) ? 'mov'
      : 'mp4';
    const tag = (id || 'video').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
    const filename = `video_${Date.now()}_${tag}.${ext}`;
    const filePath = path.join(saveDir, filename);
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    channel.log('video', `Saved: ${filePath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)${provider ? ` from ${provider}/${model}` : ''}`);
    return filePath;
  } catch (err) {
    channel.log('video', `Failed to save ${url}: ${err.message}`);
    return null;
  }
}

const generateVideoAction = {
  type: 'generate_video',
  intent: 'generate_video',
  description: 'Generate a video from a text prompt. Video generation is async — returns a job ID to poll with check_video_status. Supports start/end frames and reference images (provider-dependent). Fields: "prompt" (required), optional "duration" (seconds, default 5), optional "aspectRatio" (1:1|16:9|9:16|4:3|3:4), optional "resolution" (360p|480p|720p|1080p|2k|4k), optional "quality" (auto|low|medium|high), optional "startFrame" (file path to first frame image), optional "endFrame" (file path to last frame image), optional "referenceImages" (array of file paths), optional "withAudio" (boolean, generate audio track). Returns: { success, provider, model, capabilities, id, status }',
  thinkingHint: 'Generating video',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string',  description: 'Text description of the desired video' },
      duration:        { type: 'number',  description: 'Duration in seconds (default: 5)' },
      aspectRatio:     { type: 'string',  description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4 (default: 16:9)' },
      resolution:      { type: 'string',  description: 'Resolution: 360p, 480p, 720p, 1080p, 2k, 4k (default: 720p)' },
      quality:         { type: 'string',  description: 'Quality: auto, low, medium, high (default: auto)' },
      startFrame:      { type: 'string',  description: 'File path to first frame image (image-to-video)' },
      endFrame:        { type: 'string',  description: 'File path to last frame image' },
      referenceImages: { type: 'array',   description: 'Array of file paths to reference images for style/subject guidance', items: { type: 'string' } },
      withAudio:       { type: 'boolean', description: 'Generate audio track alongside video (default: false)' },
      saveTo:          { type: 'string',  description: 'Directory to save the final video file in. If the job finishes synchronously the file is saved immediately. If it needs polling, pass the SAME saveTo to check_video_status when status becomes "completed" so the result is downloaded there. Defaults to ~/.koi/videos/ when omitted.' },
      model:           { type: 'string',  description: 'Specific model to use (optional — auto-selects if omitted)' }
    },
    required: ['prompt']
  },

  examples: [
    { intent: 'generate_video', prompt: 'A drone shot flying over a misty forest at sunrise', duration: 10, aspectRatio: '16:9' },
    { intent: 'generate_video', prompt: 'Product rotating on a turntable', startFrame: '/tmp/product.png', duration: 5 },
    { intent: 'generate_video', prompt: 'Animated character walking', referenceImages: ['/tmp/character.png'], withAudio: true },
    { intent: 'generate_video', prompt: 'Cinematic sunset timelapse', duration: 6, saveTo: '/Users/me/project/assets' }
  ],

  async execute(action, agent) {
    const prompt = action.prompt;
    if (!prompt) throw new Error('generate_video: "prompt" is required');

    const clients = agent?.llmProvider?.getClients?.() || {};

    let resolved;
    try {
      resolved = resolveModel({ type: 'video', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const instance = resolved.instance;
    const caps = instance.capabilities;

    // Load start frame from file path
    let startFrame;
    if (action.startFrame) {
      if (!caps.startFrame) {
        channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support start frame — ignoring`);
      } else {
        const resolvedPath = path.resolve(action.startFrame);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `Start frame image not found: ${action.startFrame}` };
        }
        const normalized = await normalizeImageForProvider(resolvedPath);
        if (normalized.converted) {
          channel.log('video', `Start frame normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
        }
        const data = fs.readFileSync(normalized.path);
        startFrame = { data, mimeType: normalized.mimeType };
      }
    }

    // Load end frame from file path
    let endFrame;
    if (action.endFrame) {
      if (!caps.endFrame) {
        channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support end frame — ignoring`);
      } else {
        const resolvedPath = path.resolve(action.endFrame);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `End frame image not found: ${action.endFrame}` };
        }
        const normalized = await normalizeImageForProvider(resolvedPath);
        if (normalized.converted) {
          channel.log('video', `End frame normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
        }
        const data = fs.readFileSync(normalized.path);
        endFrame = { data, mimeType: normalized.mimeType };
      }
    }

    // Load reference images from file paths
    let referenceImages;
    if (action.referenceImages?.length) {
      if (!caps.referenceImages) {
        channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
      } else {
        referenceImages = [];
        const maxRef = caps.maxReferenceImages || 1;
        for (const filePath of action.referenceImages.slice(0, maxRef)) {
          const resolvedPath = path.resolve(filePath);
          if (!fs.existsSync(resolvedPath)) {
            return { success: false, error: `Reference image not found: ${filePath}` };
          }
          const normalized = await normalizeImageForProvider(resolvedPath);
          if (normalized.converted) {
            channel.log('video', `Reference normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
          }
          const data = fs.readFileSync(normalized.path);
          referenceImages.push({ data, mimeType: normalized.mimeType });
        }
      }
    }

    // Warn if audio requested but not supported
    const withAudio = action.withAudio || false;
    if (withAudio && !caps.withAudio) {
      channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support audio generation — ignoring withAudio`);
    }

    const duration = action.duration || 5;
    const refFrame = action.startFrame || action.referenceImage || null;
    channel.log('video', `generate_video: ${resolved.provider}/${resolved.model}, prompt="${prompt.substring(0, 150)}...", duration=${duration}s, aspectRatio=${action.aspectRatio || '16:9'}, resolution=${action.resolution || '720p'}, quality=${action.quality || 'auto'}${refFrame ? ', startFrame=' + refFrame : ''}, saveTo=${action.saveTo || 'default'}`);

    const result = await instance.generate(prompt, {
      duration,
      aspectRatio: action.aspectRatio || '16:9',
      resolution: action.resolution || '720p',
      quality: action.quality || 'auto',
      startFrame,
      endFrame,
      referenceImages,
      withAudio: withAudio && caps.withAudio,
    });

    // If the provider returned a ready URL (some models complete
    // synchronously), try to save it right away. Async providers return
    // just an id — check_video_status handles the save later.
    let savedTo = null;
    if (result.url && (result.status === 'completed' || !result.status)) {
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
      capabilities: caps,
      id: result.id,
      status: result.status,
      url: result.url,
      ...(savedTo ? { savedTo } : {}),
      usage: result.usage,
    };
  }
};

// Fire-and-forget: rewrite the tool schema from the backend's active video
// model set so the agent only ever sees parameters the backend can serve.
// Mirrors the pattern in generate-image.js.
fetchMediaCapabilities('video').then((caps) => {
  if (!caps) return;
  const props = generateVideoAction.schema.properties;

  if (caps.aspectRatios?.length) {
    props.aspectRatio = {
      type: 'string',
      enum: caps.aspectRatios,
      description: `Aspect ratio for the generated video. One of: ${caps.aspectRatios.map((v) => `"${v}"`).join(', ')}.`,
    };
  } else {
    delete props.aspectRatio;
  }

  if (caps.resolutions?.length) {
    props.resolution = {
      type: 'string',
      enum: caps.resolutions,
      description: `Resolution for the generated video. One of: ${caps.resolutions.map((v) => `"${v}"`).join(', ')}.`,
    };
  } else {
    delete props.resolution;
  }

  if (!caps.anyFrameControl) {
    delete props.startFrame;
    delete props.endFrame;
  }
  if (!caps.hasRefImageSupport) {
    delete props.referenceImages;
  }
  if (!caps.anyAudio) {
    delete props.withAudio;
  }

  if (caps.labels?.length) {
    const list = caps.labels.map((l) => `"${l}"`).join(', ');
    props.label = {
      type: 'string',
      enum: caps.labels,
      description: `Optional ranking preference — the router prefers (but does not require) a model tagged with this label. Available: ${list}.`,
    };
    generateVideoAction.description += ` Optional "label" ranking hint (one of: ${list}).`;
  } else {
    delete props.label;
  }
}).catch(() => {});

export default generateVideoAction;
