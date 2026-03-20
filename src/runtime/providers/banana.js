/**
 * Nano Banana 2 provider — Image generation by Google.
 *
 * Nano Banana 2 is Google's fast image generation model, technically
 * known as gemini-3.1-flash-image-preview. Part of the Gemini API.
 *
 * Models:
 *   - gemini-3.1-flash-image-preview  (Nano Banana 2 — fast, efficient)
 *   - gemini-3-pro-image-preview      (Nano Banana Pro — higher quality)
 *
 * API: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * Auth: x-goog-api-key header (same as Gemini)
 *
 * NORMALIZED INTERFACE:
 *   aspectRatio → imageConfig.aspectRatio (supports 14 ratios natively)
 *   resolution  → imageConfig.imageSize: '512'|'1K'|'2K'|'4K'
 *   referenceImages → inline_data parts (up to 14: 10 objects + 4 characters)
 *   quality → thinkingConfig.thinkingLevel: 'High'|'Minimal'
 */

import { BaseImageGen } from './base.js';
import { cliLogger } from '../cli-logger.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function _getApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Nano Banana 2 requires GEMINI_API_KEY environment variable');
  return key;
}

// ── Normalized → Nano Banana 2 mapping ──────────────────────────────────────

// Nano Banana 2 supports these aspect ratios natively
const _NB2_ASPECT_RATIOS = [
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3',
  '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'
];

// Normalized resolution → imageSize
const _NB2_RES_MAP = {
  'low':    '512',
  'medium': '1K',
  'high':   '2K',
  'ultra':  '4K',
};

// Normalized quality → thinkingLevel
function _nb2ThinkingLevel(quality) {
  if (quality === 'high') return 'High';
  return 'Minimal';
}

// ─────────────────────────────────────────────────────────────────────────────
// Nano Banana 2 Image Generation
// ─────────────────────────────────────────────────────────────────────────────

export class NanoBanana2ImageGen extends BaseImageGen {
  constructor(client, model = 'gemini-3.1-flash-image-preview') {
    // client is unused — uses direct REST calls with API key
    super(client, model);
  }

  get providerName() { return 'google'; }

  get capabilities() {
    const is31Flash = this.model.includes('3.1-flash');
    return {
      referenceImages: true,
      maxReferenceImages: is31Flash ? 14 : 4,   // 3.1 Flash: 10 objects + 4 characters
      edit: true,                                 // Multi-turn editing via conversation
      aspectRatios: _NB2_ASPECT_RATIOS,
      resolutions: is31Flash ? ['low', 'medium', 'high', 'ultra'] : ['medium', 'high'],
      qualities: ['auto', 'high'],                // Maps to thinkingLevel
      maxN: 1,
      outputFormats: ['png', 'jpeg'],
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '1:1';
    const resolution = opts.resolution || 'medium';
    const imageSize = _NB2_RES_MAP[resolution] || '1K';
    const quality = opts.quality || 'auto';

    cliLogger.log('image', `NanoBanana2 generate: model=${this.model}, aspect=${aspectRatio}, size=${imageSize}, quality=${quality}`);
    const _t0 = Date.now();

    try {
      const apiKey = _getApiKey();
      const url = `${GEMINI_API_BASE}/models/${this.model}:generateContent`;

      // Build content parts: reference images first, then text prompt
      const parts = [];

      // Reference images as inline_data parts
      if (opts.referenceImages?.length) {
        const maxRef = this.capabilities.maxReferenceImages;
        for (const ref of opts.referenceImages.slice(0, maxRef)) {
          const imgData = typeof ref.data === 'string'
            ? ref.data
            : ref.data.toString('base64');
          parts.push({
            inlineData: {
              mimeType: ref.mimeType || 'image/png',
              data: imgData,
            },
          });
        }
      }

      parts.push({ text: prompt });

      const body = {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio,
            imageSize,
          },
        },
      };

      // Thinking config (Nano Banana 2 / 3.1 Flash only)
      if (this.model.includes('3.1-flash')) {
        body.generationConfig.thinkingConfig = {
          thinkingLevel: _nb2ThinkingLevel(quality),
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`NanoBanana2 API error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      const _elapsed = Date.now() - _t0;
      cliLogger.log('image', `NanoBanana2 generate completed in ${_elapsed}ms`);

      // Extract images from response parts
      const images = [];
      const resParts = data.candidates?.[0]?.content?.parts || [];
      for (const part of resParts) {
        if (part.inlineData) {
          images.push({
            b64: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png',
          });
        }
      }

      return {
        images,
        usage: {
          input: data.usageMetadata?.promptTokenCount || 0,
          output: data.usageMetadata?.candidatesTokenCount || 0,
        },
      };
    } catch (err) {
      cliLogger.log('image', `NanoBanana2 generate FAILED: ${err.message}`);
      throw err;
    }
  }

  async edit(prompt, image, opts = {}) {
    // Nano Banana 2 supports editing via multi-turn conversation:
    // send the original image + edit instruction in the same request
    const imgData = typeof image === 'string'
      ? image
      : image.toString('base64');

    const refImages = [{ data: imgData, mimeType: 'image/png' }];
    if (opts.referenceImages?.length) {
      refImages.push(...opts.referenceImages);
    }

    return this.generate(prompt, {
      ...opts,
      referenceImages: refImages,
    });
  }
}
