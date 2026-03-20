/**
 * Kling AI provider — Video generation by Kuaishou.
 *
 * Official API docs: https://app.klingai.com/global/dev/document-api/apiReference/model/textToVideo
 *
 * Base URL: https://api.klingai.com
 * Auth: JWT HS256 with access_key (iss) + secret_key (HMAC secret)
 *
 * Models (model_name values):
 *   - kling-v1-5, kling-v1-6          (legacy, support cfg_scale/mode/duration)
 *   - kling-v2-0                       (does NOT support cfg_scale/duration/mode/camera_control)
 *   - kling-v3-0                       (Kling 3.0 — native audio, multi-shot, up to 15s/4K/60fps)
 *
 * Endpoints:
 *   - Text-to-video:  POST /v1/videos/text2video
 *   - Image-to-video: POST /v1/videos/image2video
 *   - Poll status:    GET  /v1/videos/text2video/{task_id}
 *
 * NORMALIZED INTERFACE:
 *   aspectRatio '1:1'|'16:9'|'9:16' → aspect_ratio (same values natively)
 *   duration  5|10|15               → duration (string, e.g. "5")
 *   quality   'auto'|'high'         → mode: 'std'|'pro' (v1.x only; v2/v3 ignore)
 *   startFrame → image2video with image URL (must upload via /v1/images/assets first)
 *   endFrame   → image_tail URL (v1.5+ only, not v2.1 master)
 *   withAudio  → generate_audio (v3 only)
 *
 * NOTE: For image2video, Kling expects image URLs (not base64).
 * Images must be uploaded first via POST /v1/images/assets, or be publicly accessible URLs.
 * For simplicity, we send base64 data URLs which Kling also accepts on recent versions.
 */

import { BaseVideoGen } from './base.js';
import { cliLogger } from '../cli-logger.js';

const KLING_BASE_URL = 'https://api.klingai.com';

// ── JWT generation (HS256) ──────────────────────────────────────────────────

function _base64url(data) {
  return Buffer.from(data).toString('base64url');
}

function _createJWT(accessKey, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = _base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = _base64url(JSON.stringify({
    iss: accessKey,
    iat: now,
    exp: now + 1800, // 30min validity
  }));

  const { createHmac } = require('crypto');
  const signature = createHmac('sha256', secretKey)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

function _getAuthHeaders() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error('Kling requires KLING_ACCESS_KEY and KLING_SECRET_KEY environment variables');
  }
  const token = _createJWT(accessKey, secretKey);
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ── Version detection ───────────────────────────────────────────────────────

function _isV3(model) { return model.includes('v3'); }
function _isV2(model) { return model.includes('v2'); }
function _isV1(model) { return model.includes('v1'); }

// ─────────────────────────────────────────────────────────────────────────────
// Kling Video Generation
// ─────────────────────────────────────────────────────────────────────────────

export class KlingVideoGen extends BaseVideoGen {
  constructor(client, model = 'kling-v3-0') {
    super(client, model);
  }

  get providerName() { return 'kling'; }

  get capabilities() {
    const v3 = _isV3(this.model);
    const v2 = _isV2(this.model);
    const v1 = _isV1(this.model);
    return {
      startFrame: true,                          // All versions support image-to-video
      endFrame: v1 || v3,                        // v1.5+, v3 (NOT v2.1 master)
      referenceImages: false,
      maxReferenceImages: 0,
      withAudio: v3,                             // Kling 3.0 has native audio generation
      aspectRatios: ['1:1', '16:9', '9:16'],
      resolutions: v3 ? ['720p', '1080p', '4k'] : ['720p', '1080p'],
      qualities: v1 ? ['auto', 'high'] : ['auto'],  // mode std/pro only on v1.x
      durations: v3 ? [5, 10, 15] : [5, 10],
      maxDuration: v3 ? 15 : 10,
    };
  }

  async generate(prompt, opts = {}) {
    const aspectRatio = opts.aspectRatio || '16:9';
    const duration = String(opts.duration || 5);
    const caps = this.capabilities;
    const v1 = _isV1(this.model);
    const v3 = _isV3(this.model);

    // Determine endpoint: image2video if startFrame provided, otherwise text2video
    const hasStartFrame = !!opts.startFrame?.data;
    const endpoint = hasStartFrame ? 'image2video' : 'text2video';

    cliLogger.log('video', `Kling ${endpoint}: model=${this.model}, aspect=${aspectRatio}, duration=${duration}s`);
    const _t0 = Date.now();

    try {
      const body = {
        model_name: this.model,
        prompt,
        aspect_ratio: aspectRatio,               // Kling uses same format as normalized
      };

      // duration, mode, cfg_scale: only supported on v1.x (NOT v2, v3)
      if (v1) {
        body.duration = duration;
        body.mode = (opts.quality === 'high') ? 'pro' : 'std';
        body.cfg_scale = opts.cfgScale ?? 0.5;
      }

      if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;
      if (opts.callbackUrl) body.callback_url = opts.callbackUrl;

      // Audio generation (Kling 3.0)
      if (v3 && opts.withAudio) {
        body.generate_audio = true;
      }

      // Start frame → image2video
      if (hasStartFrame) {
        const imgData = typeof opts.startFrame.data === 'string'
          ? opts.startFrame.data
          : opts.startFrame.data.toString('base64');
        const mime = opts.startFrame.mimeType || 'image/png';
        body.image = `data:${mime};base64,${imgData}`;
      }

      // End frame → image_tail (v1.5+, v3)
      if (opts.endFrame?.data && caps.endFrame) {
        const imgData = typeof opts.endFrame.data === 'string'
          ? opts.endFrame.data
          : opts.endFrame.data.toString('base64');
        const mime = opts.endFrame.mimeType || 'image/png';
        body.image_tail = `data:${mime};base64,${imgData}`;
      }

      const res = await fetch(`${KLING_BASE_URL}/v1/videos/${endpoint}`, {
        method: 'POST',
        headers: _getAuthHeaders(),
        body: JSON.stringify(body),
        signal: opts.abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Kling API error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      if (data.code !== 0) {
        throw new Error(`Kling API error (code ${data.code}): ${data.message}`);
      }

      const _elapsed = Date.now() - _t0;
      cliLogger.log('video', `Kling video task submitted in ${_elapsed}ms: ${data.data?.task_id}`);

      return {
        id: data.data?.task_id,
        status: _mapKlingStatus(data.data?.task_status),
        url: undefined,
        usage: { durationSec: parseInt(duration, 10) },
      };
    } catch (err) {
      cliLogger.log('video', `Kling video generate FAILED: ${err.message}`);
      throw err;
    }
  }

  async getStatus(jobId, opts = {}) {
    try {
      const res = await fetch(`${KLING_BASE_URL}/v1/videos/text2video/${jobId}`, {
        method: 'GET',
        headers: _getAuthHeaders(),
        signal: opts.abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Kling status error (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      if (data.code !== 0) {
        throw new Error(`Kling status error (code ${data.code}): ${data.message}`);
      }

      const taskData = data.data || {};
      const videos = taskData.task_result?.videos || [];

      return {
        id: jobId,
        status: _mapKlingStatus(taskData.task_status),
        url: videos[0]?.url || undefined,
        error: taskData.task_status_msg || undefined,
      };
    } catch (err) {
      cliLogger.log('video', `Kling video status FAILED: ${err.message}`);
      throw err;
    }
  }
}

/** Map Kling-specific statuses to our standard enum. */
function _mapKlingStatus(klingStatus) {
  switch (klingStatus) {
    case 'submitted':  return 'pending';
    case 'processing': return 'processing';
    case 'succeed':    return 'completed';
    case 'failed':     return 'failed';
    default:           return 'pending';
  }
}
