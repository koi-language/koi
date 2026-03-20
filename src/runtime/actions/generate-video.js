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

import { resolve as resolveModel } from '../providers/factory.js';
import { cliLogger } from '../cli-logger.js';
import fs from 'fs';
import path from 'path';

export default {
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
      model:           { type: 'string',  description: 'Specific model to use (optional — auto-selects if omitted)' }
    },
    required: ['prompt']
  },

  examples: [
    { intent: 'generate_video', prompt: 'A drone shot flying over a misty forest at sunrise', duration: 10, aspectRatio: '16:9' },
    { intent: 'generate_video', prompt: 'Product rotating on a turntable', startFrame: '/tmp/product.png', duration: 5 },
    { intent: 'generate_video', prompt: 'Animated character walking', referenceImages: ['/tmp/character.png'], withAudio: true }
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
        cliLogger.log('video', `Provider ${resolved.provider}/${resolved.model} does not support start frame — ignoring`);
      } else {
        const resolvedPath = path.resolve(action.startFrame);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `Start frame image not found: ${action.startFrame}` };
        }
        const data = fs.readFileSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
        startFrame = { data, mimeType: mimeMap[ext] || 'image/png' };
      }
    }

    // Load end frame from file path
    let endFrame;
    if (action.endFrame) {
      if (!caps.endFrame) {
        cliLogger.log('video', `Provider ${resolved.provider}/${resolved.model} does not support end frame — ignoring`);
      } else {
        const resolvedPath = path.resolve(action.endFrame);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `End frame image not found: ${action.endFrame}` };
        }
        const data = fs.readFileSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
        endFrame = { data, mimeType: mimeMap[ext] || 'image/png' };
      }
    }

    // Load reference images from file paths
    let referenceImages;
    if (action.referenceImages?.length) {
      if (!caps.referenceImages) {
        cliLogger.log('video', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
      } else {
        referenceImages = [];
        const maxRef = caps.maxReferenceImages || 1;
        for (const filePath of action.referenceImages.slice(0, maxRef)) {
          const resolvedPath = path.resolve(filePath);
          if (!fs.existsSync(resolvedPath)) {
            return { success: false, error: `Reference image not found: ${filePath}` };
          }
          const data = fs.readFileSync(resolvedPath);
          const ext = path.extname(resolvedPath).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
          referenceImages.push({ data, mimeType: mimeMap[ext] || 'image/png' });
        }
      }
    }

    // Warn if audio requested but not supported
    const withAudio = action.withAudio || false;
    if (withAudio && !caps.withAudio) {
      cliLogger.log('video', `Provider ${resolved.provider}/${resolved.model} does not support audio generation — ignoring withAudio`);
    }

    const duration = action.duration || 5;
    cliLogger.log('video', `generate_video: ${resolved.provider}/${resolved.model}, duration=${duration}s, prompt="${prompt.substring(0, 60)}..."`);

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

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      capabilities: caps,
      id: result.id,
      status: result.status,
      url: result.url,
      usage: result.usage,
    };
  }
};
