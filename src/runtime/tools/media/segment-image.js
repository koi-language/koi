/**
 * Segment Image — Use SAM 2 (Segment Anything Model 2) to segment objects in an image.
 *
 * Calls fal.ai SAM 2 API via the gateway. Returns mask images (PNG) for each
 * detected segment. Can be called with specific click points or auto-segments
 * the entire image with a grid of points.
 *
 * Permission: 'read'
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../../io/channel.js';

// SAM models on fal.ai — SAM 3.1 for best quality, SAM 2 as fallback
const SAM_MODEL = 'fal-ai/sam-3-1/image';

export default {
  type: 'segment_image',
  intent: 'segment_image',
  description: 'Segment objects in an image using SAM 2. Pass an image path and optional click points. Returns masks as local PNG files. Use without points for auto-segmentation of the whole image.',
  thinkingHint: 'Segmenting image',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to a local image file' },
      image_url: { type: 'string', description: 'URL of an image (alternative to path)' },
      points: {
        type: 'array',
        description: 'Click points [{x, y, label}]. x/y are pixel coordinates. label: 1=foreground, 0=background. If omitted, auto-segments with a grid.',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            label: { type: 'number' },
          },
        },
      },
    },
  },

  async execute(params) {
    let imageUrl = params.image_url;

    // If local path, convert to base64 data URI
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

    const hasPoints = params.points?.length > 0;
    const isGrid = hasPoints && params.points.length > 1;

    // For grid (multi-point): run parallel SAM2 calls (one per point).
    // SAM 3.1 multi-point doesn't work on fal.ai, so we parallelize SAM2 instead.
    if (isGrid) {
      channel.log('image', `segment_image: parallel SAM 3.1 grid with ${params.points.length} points`);
      const { getGatewayBase, getAuthHeaders } = await import('../../llm/providers/gateway.js');
      const base = getGatewayBase();
      const headers = getAuthHeaders();

      // Run all points in parallel (max 8 concurrent to avoid overwhelming the API)
      const BATCH = 8;
      const masksDir = path.join(os.tmpdir(), 'braxil-masks');
      fs.mkdirSync(masksDir, { recursive: true });
      const localMasks = [];

      for (let b = 0; b < params.points.length; b += BATCH) {
        const batch = params.points.slice(b, b + BATCH);
        const results = await Promise.all(batch.map(async (pt, idx) => {
          try {
            const singleInput = {
              image_url: imageUrl,
              apply_mask: false,
              point_prompts: [{ x: Math.round(pt.x), y: Math.round(pt.y), label: pt.label ?? 1 }],
            };
            const res = await fetch(`${base}/fal/raw`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: SAM_MODEL, ...singleInput }),
              signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) return null;
            const r = await res.json();
            // SAM 3.1: mask in image.url or masks[0].url
            return r.image?.url || r.masks?.[0]?.url || null;
          } catch { return null; }
        }));

        for (let i = 0; i < results.length; i++) {
          const maskUrl = results[i];
          if (!maskUrl) continue;
          const fileName = `mask_${Date.now()}_${b + i}.png`;
          const localPath = path.join(masksDir, fileName);
          try {
            const maskRes = await fetch(maskUrl);
            if (maskRes.ok) {
              const buffer = Buffer.from(await maskRes.arrayBuffer());
              fs.writeFileSync(localPath, buffer);
              localMasks.push({ localPath, maskUrl, score: 1.0, bbox: null });
            }
          } catch {}
        }
      }

      channel.log('image', `segment_image: grid done, ${localMasks.length}/${params.points.length} masks`);
      return { success: true, maskCount: localMasks.length, masks: localMasks, imagePath: params.path || null };
    }

    // Single point: one SAM 3.1 call
    const model = SAM_MODEL;
    const input = { image_url: imageUrl, apply_mask: false };

    if (hasPoints) {
      input.point_prompts = params.points.map(p => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
        label: p.label ?? 1,
      }));
    }

    channel.log('image', `segment_image: calling ${model} with ${hasPoints ? params.points.length + ' point(s)' : 'no points'}`);

    try {
      // Call gateway's raw fal.ai endpoint
      const { getGatewayBase, getAuthHeaders } = await import('../../llm/providers/gateway.js');
      const base = getGatewayBase();
      const headers = getAuthHeaders();
      const url = `${base}/fal/raw`;
      const bodySize = JSON.stringify(input).length;
      channel.log('image', `segment_image: POST ${url} (body ~${Math.round(bodySize / 1024)}KB, base64=${input.image_url?.startsWith('data:') ?? false})`);

      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...input }),
        signal: AbortSignal.timeout(120000), // 2 min timeout
      });

      channel.log('image', `segment_image: response status=${res.status}`);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        channel.log('image', `segment_image: error body: ${body.substring(0, 300)}`);
        return { success: false, error: `SAM 2 error (${res.status}): ${body.substring(0, 200)}` };
      }

      const result = await res.json();

      const masksDir = path.join(os.tmpdir(), 'braxil-masks');
      fs.mkdirSync(masksDir, { recursive: true });
      const localMasks = [];

      // SAM 3.1: image.url or masks[0].url
      const maskUrl = result.image?.url || result.masks?.[0]?.url;
      if (maskUrl) {
        const fileName = `mask_${Date.now()}_0.png`;
        const localPath = path.join(masksDir, fileName);
        try {
          const maskRes = await fetch(maskUrl);
          if (maskRes.ok) {
            const buffer = Buffer.from(await maskRes.arrayBuffer());
            fs.writeFileSync(localPath, buffer);
            localMasks.push({ localPath, maskUrl, score: 1.0, bbox: null });
          }
        } catch (e) {
          channel.log('image', `Failed to download mask: ${e.message}`);
        }
      }

      channel.log('image', `segment_image: ${localMasks.length} mask(s) ready`);

      return {
        success: true,
        maskCount: localMasks.length,
        masks: localMasks,
        imagePath: params.path || null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
