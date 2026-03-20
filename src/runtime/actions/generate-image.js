/**
 * Generate Image Action — Generate images from text prompts.
 *
 * Delegates to the provider factory which auto-selects the best available
 * image provider: OpenAI (gpt-image-1) → Gemini (gemini-2.5-flash-image).
 *
 * All parameters use NORMALIZED values (aspect ratios, resolutions, etc.)
 * — each provider maps them to its native format internally.
 *
 * Permission: 'generate_image' (individual permission for image generation)
 */

import { resolve as resolveModel } from '../providers/factory.js';
import { cliLogger } from '../cli-logger.js';
import fs from 'fs';
import path from 'path';

export default {
  type: 'generate_image',
  intent: 'generate_image',
  description: 'Generate an image from a text prompt. Supports reference images for style guidance (provider-dependent). Fields: "prompt" (required), optional "aspectRatio" (1:1|16:9|9:16|4:3|3:4|3:2|2:3), optional "resolution" (low|medium|high|ultra), optional "quality" (auto|low|medium|high), optional "n" (number of images, default 1), optional "referenceImages" (array of file paths for style reference), optional "saveTo" (directory to save images). Returns: { success, provider, model, capabilities, images: [{ url?, b64?, savedTo?, revisedPrompt? }] }',
  thinkingHint: 'Generating image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string', description: 'Text description of the desired image' },
      aspectRatio:     { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9 (default: 1:1)' },
      resolution:      { type: 'string', description: 'Resolution: low (~512px), medium (~1024px), high (~2048px), ultra (~4096px) (default: medium)' },
      quality:         { type: 'string', description: 'Quality: auto, low, medium, high (default: auto)' },
      n:               { type: 'number', description: 'Number of images to generate (default: 1)' },
      referenceImages: { type: 'array',  description: 'Array of file paths to reference images for style/subject guidance', items: { type: 'string' } },
      outputFormat:    { type: 'string', description: 'Output format: png, webp, jpeg, b64_json (default: png)' },
      saveTo:          { type: 'string', description: 'Directory path to save generated images. If omitted, images are returned as base64.' },
      model:           { type: 'string', description: 'Specific model to use (optional — auto-selects if omitted)' }
    },
    required: ['prompt']
  },

  examples: [
    { intent: 'generate_image', prompt: 'A serene mountain lake at sunset, oil painting style' },
    { intent: 'generate_image', prompt: 'Logo for a tech startup', aspectRatio: '1:1', resolution: 'high', quality: 'high' },
    { intent: 'generate_image', prompt: 'Product photo in this style', referenceImages: ['/tmp/style-ref.png'], aspectRatio: '4:3' }
  ],

  async execute(action, agent) {
    const prompt = action.prompt;
    if (!prompt) throw new Error('generate_image: "prompt" is required');

    // Get clients from the agent's LLM provider
    const clients = agent?.llmProvider?.getClients?.() || {};

    // Resolve image provider
    let resolved;
    try {
      resolved = resolveModel({ type: 'image', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const instance = resolved.instance;
    const caps = instance.capabilities;

    // Load reference images from file paths
    let referenceImages;
    if (action.referenceImages?.length) {
      if (!caps.referenceImages) {
        cliLogger.log('image', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
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
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
          referenceImages.push({ data, mimeType: mimeMap[ext] || 'image/png' });
        }
      }
    }

    cliLogger.log('image', `generate_image: ${resolved.provider}/${resolved.model}, prompt="${prompt.substring(0, 60)}..."`);

    // Call provider with normalized parameters
    const result = await instance.generate(prompt, {
      aspectRatio: action.aspectRatio || '1:1',
      resolution: action.resolution || 'medium',
      quality: action.quality || 'auto',
      n: action.n || 1,
      outputFormat: action.outputFormat || (action.saveTo ? 'png' : 'b64_json'),
      referenceImages,
    });

    // Save images to disk if saveTo is specified
    if (action.saveTo && result.images?.length) {
      const saveDir = path.resolve(action.saveTo);
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        if (img.b64) {
          const ext = action.outputFormat || 'png';
          const filename = `image_${Date.now()}_${i}.${ext}`;
          const filePath = path.join(saveDir, filename);
          fs.writeFileSync(filePath, Buffer.from(img.b64, 'base64'));
          img.savedTo = filePath;
          cliLogger.log('image', `Saved: ${filePath}`);
        }
      }
    }

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      capabilities: caps,
      images: result.images,
      usage: result.usage,
    };
  }
};
