/**
 * Segment Image — SAM 3 (text-prompted) + SAM 2 (point fallback).
 *
 * Two modes:
 *   1. precompute: Vision model describes objects → SAM 3 segments each by text → cached masks.
 *   2. point: SAM 2 single-point fallback for clicks that miss precomputed masks.
 *
 * The Flutter ImageViewerTab calls precompute on load, then point on click if needed.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../io/channel.js';

// SAM 3 — text-prompted for precompute, point+text for fallback clicks.
const SAM3_MODEL = 'fal-ai/sam-3/image';

export default {
  type: 'segment_image',
  intent: 'segment_image',
  description: 'Segment objects in an image. Mode "precompute" uses vision+SAM3 text prompts. Mode "point" uses SAM2 with click coordinates.',
  thinkingHint: 'Segmenting image',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to a local image file' },
      image_url: { type: 'string', description: 'URL of an image (alternative to path)' },
      mode: { type: 'string', enum: ['precompute', 'point'], description: 'precompute=vision+SAM3 text, point=SAM2 click' },
      points: {
        type: 'array',
        description: 'Click points [{x, y, label}] for mode=point.',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'number' } } },
      },
    },
  },

  async execute(params) {
    let imageUrl = params.image_url;

    if (!imageUrl && params.path) {
      const filePath = path.resolve(params.path);
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      const mime = mimeMap[ext] || 'image/png';
      imageUrl = `data:${mime};base64,${data.toString('base64')}`;
    }

    if (!imageUrl) {
      return { success: false, error: 'Provide "path" or "image_url"' };
    }

    const { getGatewayBase, getAuthHeaders } = await import('../../llm/providers/gateway.js');
    const base = getGatewayBase();
    const headers = getAuthHeaders();
    // Persistent masks directory (survives reboots, unlike /tmp)
    const home = os.homedir();
    const masksDir = path.join(home, '.koi', 'media-library', 'masks');
    fs.mkdirSync(masksDir, { recursive: true });

    const mode = params.mode || (params.points?.length > 0 ? 'point' : 'precompute');

    // ══════════════════════════════════════════════════════════════════════
    // MODE: precompute — vision model → object list → SAM 3 per concept
    // ══════════════════════════════════════════════════════════════════════
    if (mode === 'precompute') {
      channel.log('image', `segment_image: PRECOMPUTE mode — detecting objects with vision model...`);

      // Step 1: Use the cheapest vision-capable LLM to describe objects
      let concepts = [];
      try {
        const { selectAutoModel } = await import('../../llm/auto-model-selector.js');
        const { getAvailableProviders } = await import('../../llm/auto-model-selector.js');
        const { createLLM } = await import('../../llm/providers/factory.js');

        // Get a cheap vision model via the auto-selector
        const availableProviders = getAvailableProviders();
        const selected = selectAutoModel('reasoning', 20, availableProviders, { requiresImage: true });

        channel.log('image', `segment_image: auto-model selected=${selected?.model ?? 'NONE'}, provider=${selected?.provider ?? 'NONE'}`);
        if (selected) {
          // In gateway mode, all providers use the gateway client
          const OpenAI = (await import('openai')).default;
          const client = process.env.KOI_AUTH_TOKEN
            ? new OpenAI({ apiKey: process.env.KOI_AUTH_TOKEN, baseURL: `${base.replace('/gateway', '')}/gateway`, maxRetries: 0 })
            : null;

          channel.log('image', `segment_image: client=${client ? 'OK' : 'NULL (no KOI_AUTH_TOKEN)'}, base=${base}`);
          if (client) {
            const llm = createLLM('openai', client, selected.model, { temperature: 0, maxTokens: 500, useThinking: false });
            const { text: content } = await llm.complete([{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: 'List every distinct object, person, animal, or element visible in this image. If there are MULTIPLE instances of the same type, list each separately with a short spatial qualifier (2-4 words max per item). Return ONLY a JSON array, e.g. ["person left","person right","red chair","table","small dog"]. Max 20 items. No explanation.' },
              ],
            }], { timeoutMs: 15000, responseFormat: 'json_object' });

            channel.log('image', `segment_image: vision model (${selected.model}) response: ${content.substring(0, 300)}`);
            channel.log('image', `segment_image: content type=${typeof content}, length=${content.length}`);
            // Parse robustly — LLMs return wildly different JSON shapes.
            // Strategy: extract ALL short strings from any JSON structure.
            try {
              const clean = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
              const parsed = JSON.parse(clean);
              channel.log('image', `segment_image: parsed type=${typeof parsed}, isArray=${Array.isArray(parsed)}, keys=${typeof parsed === 'object' && parsed ? Object.keys(parsed).length : 'N/A'}`);

              // Recursively collect all string values from any structure
              const collectStrings = (obj) => {
                const result = [];
                if (typeof obj === 'string') {
                  // Try to parse strings that look like embedded JSON (double-encoded)
                  const trimmed = obj.trim();
                  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { return collectStrings(JSON.parse(trimmed)); } catch {}
                  }
                  // Valid concept: short, no JSON chars
                  if (obj.length > 1 && !obj.includes('{') && !obj.includes('[')) {
                    result.push(obj);
                  }
                } else if (Array.isArray(obj)) {
                  for (const item of obj) result.push(...collectStrings(item));
                } else if (typeof obj === 'object' && obj !== null) {
                  for (const val of Object.values(obj)) result.push(...collectStrings(val));
                }
                return result;
              };

              concepts = [...new Set(collectStrings(parsed))]; // deduplicate
              channel.log('image', `segment_image: collected ${concepts.length} concepts: ${JSON.stringify(concepts).substring(0, 200)}`);
            } catch (parseErr) {
              channel.log('image', `segment_image: JSON parse failed: ${parseErr.message}, attempting recovery...`);
              // Fallback 1: extract any complete JSON array from the text
              const match = content.match(/\[.*\]/s);
              if (match) try { concepts = JSON.parse(match[0]).filter(x => typeof x === 'string'); } catch {}
              // Fallback 2: truncated JSON — extract all quoted strings via regex
              if (concepts.length === 0) {
                const strings = [...content.matchAll(/"([^"]{2,50})"/g)].map(m => m[1]);
                // Deduplicate and filter out JSON-like keys that are just repeated values
                concepts = [...new Set(strings)].filter(s => !s.includes('{') && !s.includes('['));
                channel.log('image', `segment_image: recovered ${concepts.length} concepts from truncated JSON`);
              }
            }
          }
        }
      } catch (e) {
        channel.log('image', `segment_image: vision model failed: ${e.message}`);
      }

      if (concepts.length === 0) {
        channel.log('image', `segment_image: vision model returned no usable concepts — skipping precompute`);
        return { success: true, maskCount: 0, masks: [], imagePath: params.path || null };
      }
      channel.log('image', `segment_image: detected ${concepts.length} concepts: ${JSON.stringify(concepts)}`);

      // Step 2: Call SAM 3 for each concept (parallel, batches of 4)
      const BATCH = 4;
      const localMasks = [];

      // Helper: call SAM 3 with a text prompt, return mask URLs
      const callSam3 = async (prompt) => {
        const res = await fetch(`${base}/fal/raw`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: SAM3_MODEL,
            image_url: imageUrl,
            prompt,
            sync_mode: true,
            apply_mask: false,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { maskUrls: [], scores: [], status: res.status };
        const r = await res.json();
        const maskUrls = [];
        if (r.image?.url) maskUrls.push(r.image.url);
        if (r.masks?.length) {
          for (const m of r.masks) {
            if (m.url && !maskUrls.includes(m.url)) maskUrls.push(m.url);
          }
        }
        return { maskUrls, scores: r.scores || [] };
      };

      // Helper: simplify a concept by stripping spatial/descriptive qualifiers
      const simplify = (concept) => {
        // Remove common spatial/positional/descriptive words
        return concept
          .replace(/\b(left|right|top|bottom|center|front|back|rear|foreground|background|upper|lower|far|near|middle)\b/gi, '')
          .replace(/\b(on shelf|on table|on wall|on counter|on floor)\b/gi, '')
          .replace(/\b(black|white|red|blue|green|yellow|dark|light|clear|transparent|small|large|big|little)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
      };

      for (let b = 0; b < concepts.length; b += BATCH) {
        const batch = concepts.slice(b, b + BATCH);
        const results = await Promise.all(batch.map(async (concept) => {
          try {
            // First attempt: original concept
            let result = await callSam3(concept);
            if (result.status) {
              channel.log('image', `segment_image: SAM3 FAILED "${concept}": HTTP ${result.status}`);
              return { concept, maskUrls: [] };
            }
            if (result.maskUrls.length > 0) {
              channel.log('image', `segment_image: SAM3 "${concept}" → ${result.maskUrls.length} mask(s)`);
              return { concept, ...result };
            }

            // Retry with simplified prompt (strip qualifiers)
            const simple = simplify(concept);
            if (simple && simple !== concept && simple.length > 1) {
              result = await callSam3(simple);
              if (result.maskUrls.length > 0) {
                channel.log('image', `segment_image: SAM3 "${concept}" → retry "${simple}" → ${result.maskUrls.length} mask(s)`);
                return { concept, ...result };
              }
            }

            channel.log('image', `segment_image: SAM3 "${concept}" → 0 mask(s) (tried: "${simple || concept}")`);
            return { concept, maskUrls: [] };
          } catch (e) {
            channel.log('image', `segment_image: SAM3 ERROR "${concept}": ${e.message}`);
            return { concept, maskUrls: [] };
          }
        }));

        for (const r of results) {
          for (let i = 0; i < (r.maskUrls?.length || 0); i++) {
            const maskUrl = r.maskUrls[i];
            const fileName = `mask_${Date.now()}_${localMasks.length}.png`;
            const localPath = path.join(masksDir, fileName);
            try {
              const maskRes = await fetch(maskUrl);
              if (maskRes.ok) {
                const buffer = Buffer.from(await maskRes.arrayBuffer());
                fs.writeFileSync(localPath, buffer);
                localMasks.push({
                  localPath,
                  maskUrl,
                  score: r.scores?.[i] ?? 0.9,
                  bbox: null,
                  concept: r.concept,
                });
              }
            } catch {}
          }
        }
      }

      channel.log('image', `segment_image: precomputed ${localMasks.length} masks from ${concepts.length} concepts`);

      // Persist masks to media library DB (if the image is in the gallery)
      if (params.path && localMasks.length > 0) {
        try {
          const { MediaLibrary } = await import('../../state/media-library.js');
          const lib = MediaLibrary.global();
          const item = await lib.getByPath(path.resolve(params.path));
          if (item) {
            await lib.setSam2Masks(item.id, localMasks);
            channel.log('image', `segment_image: persisted ${localMasks.length} masks to DB for ${item.id}`);
          }
        } catch (e) {
          channel.log('image', `segment_image: DB persist failed (non-critical): ${e.message}`);
        }
      }

      return { success: true, maskCount: localMasks.length, masks: localMasks, imagePath: params.path || null };
    }

    // ══════════════════════════════════════════════════════════════════════
    // MODE: point — Fallback for clicks that missed precomputed masks.
    // SAM 3 text prompt mode works on fal.ai. We try a generic prompt
    // "object" and return the mask if it contains the clicked point.
    // The Flutter side checks containsPoint to verify it covers the click.
    // ══════════════════════════════════════════════════════════════════════
    if (!params.points?.length) {
      return { success: true, maskCount: 0, masks: [], imagePath: params.path || null };
    }

    const clickX = Math.round(params.points[0].x);
    const clickY = Math.round(params.points[0].y);
    channel.log('image', `segment_image: POINT fallback at (${clickX},${clickY}) via SAM 3 text prompt`);

    try {
      const res = await fetch(`${base}/fal/raw`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: SAM3_MODEL,
          image_url: imageUrl,
          prompt: 'object',
          sync_mode: true,
        }),
        signal: AbortSignal.timeout(15000),
      });

      const localMasks = [];
      if (res.ok) {
        const result = await res.json();
        const maskUrl = result.image?.url || result.masks?.[0]?.url;
        if (maskUrl) {
          const fileName = `mask_${Date.now()}_0.png`;
          const localPath = path.join(masksDir, fileName);
          const maskRes = await fetch(maskUrl);
          if (maskRes.ok) {
            const buffer = Buffer.from(await maskRes.arrayBuffer());
            fs.writeFileSync(localPath, buffer);
            localMasks.push({ localPath, maskUrl, score: 0.8, bbox: null });
            channel.log('image', `segment_image: fallback returned a mask`);
          }
        }
      }

      channel.log('image', `segment_image: ${localMasks.length} fallback mask(s)`);
      return { success: true, maskCount: localMasks.length, masks: localMasks, imagePath: params.path || null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
