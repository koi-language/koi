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

import { resolve as resolveModel } from '../../llm/providers/factory.js';

import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../io/channel.js';

export default {
  type: 'generate_image',
  intent: 'generate_image',
  description: 'Generate an image from a text prompt. Supports reference images for style guidance (provider-dependent). Fields: "prompt" (required), optional "aspectRatio", optional "resolution" (low|medium|high|ultra), optional "quality" (auto|low|medium|high), optional "n" (number of images, default 1), optional "referenceImages" (array of file paths for style reference), optional "saveTo" (directory to save images). Returns: { success, provider, model, capabilities, images: [{ url?, b64?, savedTo?, revisedPrompt? }] }',
  thinkingHint: 'Generating image',
  permission: 'generate_image',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string', description: 'Text description of the desired image' },
      aspectRatio:     { type: 'string', description: 'Aspect ratio (REQUIRED — choose based on user intent): 1:1 (square), 16:9 (landscape wide), 9:16 (portrait tall/vertical), 4:3 (landscape standard), 3:4 (portrait standard), 3:2 (landscape photo), 2:3 (portrait photo), 21:9 (ultrawide). For portrait/vertical/tall requests use 9:16 or 2:3. For landscape/wide use 16:9 or 3:2. Default: 1:1' },
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

    // Load reference images from file paths.
    // Each reference image used for generation is saved to the media library
    // (deduplicated by content hash — won't store duplicates).
    let referenceImages;
    const _savedRefIds = {}; // filePath → media library ID
    if (action.referenceImages?.length) {
      if (!caps.referenceImages) {
        channel.log('image', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
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

          // Save reference image to media library (dedup by hash, non-blocking)
          try {
            const { MediaLibrary } = await import('../../state/media-library.js');
            const lib = MediaLibrary.global();
            const result = await lib.save({
              filePath: resolvedPath,
              metadata: { source: 'reference', usedForGeneration: true },
              description: `Reference image: ${path.basename(resolvedPath)}`,
            });
            _savedRefIds[resolvedPath] = result.id;
            channel.log('image', `Reference image ${result.isNew ? 'saved to' : 'already in'} media library: ${result.id}`);
          } catch (mlErr) {
            channel.log('image', `Media library ref save failed (non-fatal): ${mlErr.message}`);
          }
        }
      }
    }

    // Log full generation request details
    const refPaths = action.referenceImages?.length ? action.referenceImages : [];
    channel.log('image', `generate_image: ${resolved.provider}/${resolved.model}, prompt="${prompt.substring(0, 150)}...", aspectRatio=${action.aspectRatio || 'default'}, resolution=${action.resolution || 'default'}, quality=${action.quality || 'auto'}, n=${action.n || 1}, refs=${refPaths.length}${refPaths.length ? ' [' + refPaths.map(p => path.basename(p)).join(', ') + ']' : ''}, saveTo=${action.saveTo || 'default'}`);

    // Validate aspectRatio against model capabilities
    const requestedRatio = action.aspectRatio || '1:1';
    if (caps.aspectRatios && !caps.aspectRatios.includes(requestedRatio)) {
      return {
        success: false,
        error: `Aspect ratio "${requestedRatio}" is not supported by ${resolved.model}. Supported ratios: ${caps.aspectRatios.join(', ')}. Please retry with a supported ratio.`,
        provider: resolved.provider,
        model: resolved.model,
        supportedAspectRatios: caps.aspectRatios,
        capabilities: caps,
      };
    }

    // Call provider with normalized parameters
    let result;
    try {
      result = await instance.generate(prompt, {
        aspectRatio: action.aspectRatio || '1:1',
        resolution: action.resolution || 'medium',
        quality: action.quality || 'auto',
        n: action.n || 1,
        outputFormat: action.outputFormat || (action.saveTo ? 'png' : 'b64_json'),
        referenceImages,
      });
    } catch (genErr) {
      const errMsg = genErr.message || String(genErr);
      // Detect common error types for the agent to interpret
      const isContentPolicy = /safety|policy|nsfw|blocked|prohibited|inappropriate|harmful/i.test(errMsg);
      const isTimeout = /timeout|timed out|deadline/i.test(errMsg);
      const isQuota = /quota|rate.limit|429|too many/i.test(errMsg);
      const errorType = isContentPolicy ? 'content_policy' : isTimeout ? 'timeout' : isQuota ? 'rate_limit' : 'generation_error';
      return {
        success: false,
        provider: resolved.provider,
        model: resolved.model,
        error: errMsg,
        errorType,
        capabilities: caps,
      };
    }

    // Always save images to disk — persistent dir so they survive across sessions
    if (result.images?.length) {
      const saveDir = path.join(os.homedir(), '.koi', 'images');
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        // Download from URL if no base64 data
        if (!img.b64 && img.url) {
          try {
            const resp = await fetch(img.url);
            if (resp.ok) {
              const contentType = resp.headers.get('content-type') || '';
              const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'png';
              const filename = `image_${Date.now()}_${i}.${ext}`;
              const filePath = path.join(saveDir, filename);
              const buffer = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(filePath, buffer);
              img.savedTo = filePath;
              channel.log('image', `Downloaded and saved: ${filePath} (${(buffer.length / 1024).toFixed(0)}KB)`);
            }
          } catch (dlErr) {
            channel.log('image', `Failed to download ${img.url}: ${dlErr.message}`);
          }
        }
        if (img.b64) {
          const ext = action.outputFormat || 'png';
          const filename = `image_${Date.now()}_${i}.${ext}`;
          const filePath = path.join(saveDir, filename);
          fs.writeFileSync(filePath, Buffer.from(img.b64, 'base64'));
          img.savedTo = filePath;
          channel.log('image', `Saved: ${filePath}`);
        }
      }
    }

    // Verify images were actually generated
    const images = result.images || [];
    const hasImages = images.length > 0 && images.some(img => img.url || img.b64 || img.savedTo);
    if (!hasImages) {
      return {
        success: false,
        provider: resolved.provider,
        model: resolved.model,
        error: result.error || result.message || 'Image generation returned no images. The model may have rejected the prompt (content policy) or timed out.',
        capabilities: caps,
      };
    }

    // Build a clean response with only saved paths (strip large b64 data)
    const savedImages = images
      .filter(img => img.savedTo || img.url)
      .map(img => ({
        ...(img.savedTo ? { savedTo: img.savedTo } : {}),
        ...(img.url ? { url: img.url } : {}),
        ...(img.width ? { width: img.width } : {}),
        ...(img.height ? { height: img.height } : {}),
      }));

    // Auto-save generated images to media library (non-blocking)
    try {
      const { saveGeneratedImage } = await import('../../state/media-library.js');
      for (const img of savedImages) {
        if (img.savedTo) {
          await saveGeneratedImage(img.savedTo, {
            prompt: action.prompt,
            negativePrompt: action.negativePrompt || null,
            model: resolved.model,
            provider: resolved.provider,
            aspectRatio: action.aspectRatio || null,
            outputFormat: action.outputFormat || 'png',
            stylePreset: action.stylePreset || null,
            // Store media library IDs of reference images (not file paths)
            referenceImageIds: Object.values(_savedRefIds),
            referenceImagePaths: (action.referenceImages || []).map(r => typeof r === 'string' ? r : r.filePath).filter(Boolean),
            seed: action.seed || null,
            steps: action.steps || null,
            guidanceScale: action.guidanceScale || null,
            width: img.width || null,
            height: img.height || null,
          }, agent?.llmProvider || null);
          channel.log('image', `Saved to media library: ${img.savedTo}`);
        }
      }
    } catch (mlErr) {
      channel.log('image', `Media library save failed (non-fatal): ${mlErr.message}`);
    }

    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      supportedAspectRatios: caps.aspectRatios,
      imageCount: savedImages.length,
      images: savedImages,
      usage: result.usage,
    };
  }
};
