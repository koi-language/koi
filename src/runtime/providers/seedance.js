/**
 * Seedance provider — Video generation by ByteDance (via Volcengine/Ark).
 *
 * Supports Seedance 1.5 and Seedance 2.0 in lite and pro variants.
 * Uses Bearer token auth from SEEDANCE_API_KEY.
 *
 * Models:
 *   - seedance-1-5-lite, seedance-1-5-pro
 *   - seedance-2-0-lite, seedance-2-0-pro
 *
 * API (Volcengine Ark):
 *   - Create task: POST /api/v3/contents/generations/tasks
 *   - Poll status: GET  /api/v3/contents/generations/tasks/{task_id}
 *
 * NORMALIZED INTERFACE:
 *   aspectRatio '16:9'|'9:16'|'1:1' → Seedance aspect_ratio (same string)
 *   resolution  '720p'|'1080p'      → Seedance resolution (same string)
 *   quality     → mapped by model variant (lite/pro)
 *   startFrame  → first_frame_image
 *   endFrame    → not supported (Seedance 2.0 may add it)
 *   referenceImages → subject_reference (Seedance 2.0)
 *   withAudio   → Seedance 2.0 supports audio generation
 */

import { BaseVideoGen } from './base.js';
import { cliLogger } from '../cli-logger.js';

const SEEDANCE_BASE_URL = process.env.SEEDANCE_API_URL || 'https://ark.cn-beijing.volces.com';

function _getAuthHeaders() {
  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey) {
    throw new Error('Seedance requires SEEDANCE_API_KEY environment variable');
  }
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

// ── Version detection ───────────────────────────────────────────────────────

function _isSeedance2(model) {
  return model.includes('2-0');
}

// ─────────────────────────────────────────────────────────────────────────────
// Seedance Video Generation
// ─────────────────────────────────────────────────────────────────────────────

export class SeedanceVideoGen extends BaseVideoGen {
  constructor(client, model = 'seedance-2-0-lite') {
    super(client, model);
  }

  get providerName() { return 'seedance'; }

  get capabilities() {
    const isV2 = _isSeedance2(this.model);
    return {
      startFrame: true,                         // Both 1.5 and 2.0 support first frame
      endFrame: false,                          // Not yet supported
      referenceImages: isV2,                    // 2.0 supports subject reference images
      maxReferenceImages: isV2 ? 3 : 0,
      withAudio: isV2,                          // 2.0 can generate audio track
      aspectRatios: ['1:1', '16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      qualities: ['auto'],                      // Quality determined by model variant (lite/pro)
      durations: [5, 10],
      maxDuration: 10,
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '16:9';
    const duration = opts.duration || 5;
    const resolution = opts.resolution || '720p';

    cliLogger.log('video', `Seedance video generate: model=${this.model}, aspect=${aspectRatio}, duration=${duration}s, res=${resolution}`);
    const _t0 = Date.now();

    try {
      const videoParam = {
        prompt,
        seed: opts.seed ?? -1,
        duration_seconds: duration,
        resolution,                             // Seedance uses '720p', '1080p' directly
        aspect_ratio: aspectRatio,              // Seedance uses '16:9', '9:16', '1:1' directly
        fps: opts.fps || 24,
      };

      // Start frame → first_frame_image
      if (opts.startFrame?.data) {
        const imgData = typeof opts.startFrame.data === 'string'
          ? opts.startFrame.data
          : opts.startFrame.data.toString('base64');
        videoParam.first_frame_image = imgData;
      }

      // Reference images → subject_reference (Seedance 2.0)
      if (opts.referenceImages?.length && _isSeedance2(this.model)) {
        videoParam.subject_references = opts.referenceImages.map(ref => {
          const data = typeof ref.data === 'string'
            ? ref.data
            : ref.data.toString('base64');
          return { image: data, mime_type: ref.mimeType || 'image/png' };
        });
      }

      // Audio generation (Seedance 2.0)
      if (opts.withAudio && _isSeedance2(this.model)) {
        videoParam.generate_audio = true;
      }

      const body = {
        model: this.model,
        content: [{
          type: 'video_generation',
          video_generation_param: videoParam,
        }],
      };

      const res = await fetch(`${SEEDANCE_BASE_URL}/api/v3/contents/generations/tasks`, {
        method: 'POST',
        headers: _getAuthHeaders(),
        body: JSON.stringify(body),
        signal: opts.abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Seedance API error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      if (data.code !== 0 && data.code !== undefined) {
        throw new Error(`Seedance API error (code ${data.code}): ${data.message}`);
      }

      const _elapsed = Date.now() - _t0;
      cliLogger.log('video', `Seedance video task submitted in ${_elapsed}ms: ${data.data?.task_id}`);

      return {
        id: data.data?.task_id || data.task_id,
        status: _mapSeedanceStatus(data.data?.status || data.status),
        url: undefined,
        usage: { durationSec: duration },
      };
    } catch (err) {
      cliLogger.log('video', `Seedance video generate FAILED: ${err.message}`);
      throw err;
    }
  }

  async getStatus(jobId, opts = {}) {
    try {
      const res = await fetch(`${SEEDANCE_BASE_URL}/api/v3/contents/generations/tasks/${jobId}`, {
        method: 'GET',
        headers: _getAuthHeaders(),
        signal: opts.abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Seedance status error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      const taskData = data.data || data;

      return {
        id: jobId,
        status: _mapSeedanceStatus(taskData.status),
        url: taskData.output?.video_url || undefined,
        error: taskData.error?.message || undefined,
      };
    } catch (err) {
      cliLogger.log('video', `Seedance video status FAILED: ${err.message}`);
      throw err;
    }
  }
}

/** Map Seedance-specific statuses to our standard enum. */
function _mapSeedanceStatus(seedanceStatus) {
  switch (seedanceStatus) {
    case 'queued':     return 'pending';
    case 'running':    return 'processing';
    case 'processing': return 'processing';
    case 'succeeded':  return 'completed';
    case 'failed':     return 'failed';
    default:           return 'pending';
  }
}
