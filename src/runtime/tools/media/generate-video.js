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
import { fetchMediaCapabilities, getGatewayBase, getAuthHeaders } from '../../llm/providers/gateway.js';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { channel } from '../../io/channel.js';
import { normalizeImageForProvider } from './_normalize-image-for-provider.js';

/** Upload a local video file to the gateway and return a provider-hosted
 *  URL. URL inputs pass through unchanged. Used for `referenceVideos` —
 *  videos are too large to inline as base64 the way we do for images, so
 *  the client streams the bytes to /gateway/uploads/video and the backend
 *  persists them on fal storage.
 *
 *  Returns null (and logs) on any failure so the caller can continue
 *  without the reference instead of aborting the whole generation.
 */
async function _uploadVideoRef(ref) {
  if (!ref) return null;
  if (typeof ref !== 'string') return null;
  if (/^https?:\/\//i.test(ref)) return ref; // already a URL
  const resolved = path.resolve(ref);
  if (!fs.existsSync(resolved)) {
    channel.log('video', `reference video not found: ${resolved}`);
    return null;
  }
  try {
    const buf = fs.readFileSync(resolved);
    // Use application/octet-stream — it's the only raw-binary parser the
    // backend registers on /uploads/video. The backend sniffs the real
    // mime from the `filename` query param, so the video/* headers we
    // used to send were pointless and also tripped 415 errors on hosts
    // whose fastify config rejects unregistered content types.
    const url = `${getGatewayBase()}/uploads/video?filename=${encodeURIComponent(path.basename(resolved))}`;
    const headers = { ...getAuthHeaders() };
    delete headers['content-type'];
    delete headers['Content-Type'];
    headers['Content-Type'] = 'application/octet-stream';
    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', headers, body: buf });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      channel.log('video', `reference video upload failed (${res.status}): ${body.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    channel.log(
      'video',
      `reference video uploaded: ${path.basename(resolved)} (${Math.round(buf.length / 1024 / 1024)}MB) ` +
      `in ${Date.now() - t0}ms → ${(json.url || '').slice(0, 80)}`,
    );
    return json.url || null;
  } catch (err) {
    channel.log('video', `reference video upload threw: ${err.message}`);
    return null;
  }
}

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
  // Static fallback for the rare case fetchMediaCapabilities('video') isn't
  // reachable (API-keys-only mode, gateway down at boot). Keep it short —
  // the real, catalog-driven description is rebuilt at the bottom of this
  // file by the fetchMediaCapabilities('video') block and replaces both
  // the description AND the schema enums in place.
  description: 'Generate a video from a text prompt. Async — returns a job ID to poll with check_video_status. Supports start/end frames, reference images and video-to-video references, plus optional per-shot overrides for multishot models. Real parameter enums (aspectRatio, resolution, cameraMovement, durations, maxShots) are populated live from the active model catalog.',
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
      referenceVideos: { type: 'array',   description: 'Array of local video paths OR https URLs for video-to-video guidance (style/motion transfer, continuation). Local paths are uploaded to the gateway transparently. Only honored when the selected model advertises videoToVideo.', items: { type: 'string' } },
      withAudio:       { type: 'boolean', description: 'Generate audio track alongside video (default: false)' },
      cameraMovement:  { type: 'string',  description: 'Camera movement / shot type, e.g. "static", "pan_left", "zoom_in", "dolly_in", "orbit_right". Provider-dependent — unknown values are ignored.' },
      numShots:        { type: 'number',  description: 'Number of independent clips to emit in a single call (multishot). Default 1. Only models with maxShots > 1 honor it. Ignored when "shots" is present.' },
      shots:           {
        type: 'array',
        description: 'Per-shot overrides for multishot models. Each entry can customise prompt / duration / cameraMovement / startFrame / endFrame / referenceImages / referenceVideos / aspectRatio for THAT shot; missing fields inherit from the top-level settings. When present, "numShots" is ignored and the clip count equals shots.length.',
        items: {
          type: 'object',
          properties: {
            prompt:          { type: 'string' },
            duration:        { type: 'number' },
            cameraMovement:  { type: 'string' },
            startFrame:      { type: 'string' },
            endFrame:        { type: 'string' },
            referenceImages: { type: 'array', items: { type: 'string' } },
            referenceVideos: { type: 'array', items: { type: 'string' } },
            aspectRatio:     { type: 'string' },
          },
        },
      },
      saveTo:          { type: 'string',  description: 'Directory to save the final video file in. If the job finishes synchronously the file is saved immediately. If it needs polling, pass the SAME saveTo to check_video_status when status becomes "completed" so the result is downloaded there. Defaults to ~/.koi/videos/ when omitted.' },
      model:           { type: 'string',  description: 'Specific model to use (optional — auto-selects if omitted)' }
    },
    required: ['prompt']
  },

  examples: [
    { intent: 'generate_video', prompt: 'A drone shot flying over a misty forest at sunrise', duration: 10, aspectRatio: '16:9' },
    { intent: 'generate_video', prompt: 'Product rotating on a turntable', startFrame: '/tmp/product.png', duration: 5 },
    { intent: 'generate_video', prompt: 'Animated character walking', referenceImages: ['/tmp/character.png'], withAudio: true },
    { intent: 'generate_video', prompt: 'Apply cinematic grading and add slow motion', referenceVideos: ['/tmp/source.mp4'], duration: 5 },
    {
      intent: 'generate_video',
      prompt: 'Short teaser about an astronaut',
      duration: 5, aspectRatio: '16:9',
      shots: [
        { prompt: 'Wide shot of the rocket on the pad at dawn', cameraMovement: 'static', duration: 3 },
        { prompt: 'Astronaut climbing the ladder — close-up', cameraMovement: 'dolly_in', duration: 4 },
        { prompt: 'Rocket liftoff — tracking up', cameraMovement: 'pan_up', duration: 5 },
      ],
    },
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

    // ── Top-level (global) resolution — used directly for single-shot,
    //    and as fallback defaults for each entry in shots[] ──────────
    const globalStartFrame = await _loadFrame(action.startFrame, caps.startFrame, resolved, 'start');
    if (globalStartFrame?._error) return { success: false, error: globalStartFrame._error };

    const globalEndFrame = await _loadFrame(action.endFrame, caps.endFrame, resolved, 'end');
    if (globalEndFrame?._error) return { success: false, error: globalEndFrame._error };

    const globalReferenceImages = await _loadReferenceImages(action.referenceImages, caps, resolved);
    if (globalReferenceImages?._error) return { success: false, error: globalReferenceImages._error };

    // Videos are uploaded (not inlined) — see _uploadVideoRef above.
    const globalReferenceVideos = await _resolveReferenceVideos(action.referenceVideos, caps, resolved);

    const withAudio = action.withAudio || false;
    if (withAudio && !caps.withAudio) {
      channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support audio generation — ignoring withAudio`);
    }

    const globalDuration = action.duration || 5;
    const globalAspect = action.aspectRatio || '16:9';
    const globalResolution = action.resolution || '720p';
    const globalQuality = action.quality || 'auto';
    const globalCamera = _sanitiseCameraMovement(action.cameraMovement, caps, resolved);

    // ── Shots: resolve per-shot overrides against the globals ─────────
    // Only accepted when the selected model advertises multishot AND
    // caller actually passed a non-empty array.
    let shots;
    if (Array.isArray(action.shots) && action.shots.length > 0) {
      const maxShots = caps.maxShots ?? 1;
      if (maxShots <= 1) {
        channel.log('video', `Provider ${resolved.provider}/${resolved.model} is single-shot — ignoring shots[]`);
      } else if (action.shots.length > maxShots) {
        return {
          success: false,
          error: `Model ${resolved.model} supports at most ${maxShots} shots per call; got ${action.shots.length}.`,
        };
      } else {
        shots = [];
        for (let i = 0; i < action.shots.length; i++) {
          const s = action.shots[i] || {};
          // Frame/ref resolution per shot, with inheritance. Any missing
          // override reuses the top-level artifact we already loaded so
          // we don't re-read the same file N times.
          const shotStart = s.startFrame
            ? await _loadFrame(s.startFrame, caps.startFrame, resolved, `shot[${i}].start`)
            : globalStartFrame;
          if (shotStart?._error) return { success: false, error: shotStart._error };

          const shotEnd = s.endFrame
            ? await _loadFrame(s.endFrame, caps.endFrame, resolved, `shot[${i}].end`)
            : globalEndFrame;
          if (shotEnd?._error) return { success: false, error: shotEnd._error };

          const shotRefImgs = Array.isArray(s.referenceImages)
            ? await _loadReferenceImages(s.referenceImages, caps, resolved)
            : globalReferenceImages;
          if (shotRefImgs?._error) return { success: false, error: shotRefImgs._error };

          const shotRefVideos = Array.isArray(s.referenceVideos)
            ? await _resolveReferenceVideos(s.referenceVideos, caps, resolved)
            : globalReferenceVideos;

          shots.push({
            prompt: typeof s.prompt === 'string' && s.prompt.trim() ? s.prompt : prompt,
            duration: typeof s.duration === 'number' && s.duration > 0 ? s.duration : globalDuration,
            aspectRatio: s.aspectRatio || globalAspect,
            cameraMovement: _sanitiseCameraMovement(s.cameraMovement, caps, resolved) ?? globalCamera,
            startFrame: shotStart,
            endFrame: shotEnd,
            referenceImages: shotRefImgs,
            referenceVideos: shotRefVideos,
          });
        }
      }
    }

    // Legacy numShots — still honoured when shots[] isn't provided, just
    // clamped to the model's maxShots. Once shots[] is used, this is a
    // no-op (shots.length is the source of truth).
    let numShots;
    if (!shots && typeof action.numShots === 'number' && action.numShots > 1) {
      const maxShots = caps.maxShots ?? 1;
      if (maxShots > 1) {
        numShots = Math.min(Math.floor(action.numShots), maxShots);
      } else {
        channel.log('video', `Provider ${resolved.provider}/${resolved.model} is single-shot — ignoring numShots=${action.numShots}`);
      }
    }

    const refFrame = action.startFrame || action.referenceImage || null;
    const refVideosCount = globalReferenceVideos?.length || 0;
    channel.log(
      'video',
      `generate_video: ${resolved.provider}/${resolved.model}, prompt="${prompt.substring(0, 150)}...", ` +
      `duration=${globalDuration}s, aspectRatio=${globalAspect}, resolution=${globalResolution}, ` +
      `quality=${globalQuality}` +
      (refFrame ? `, startFrame=${refFrame}` : '') +
      (refVideosCount ? `, refVideos=${refVideosCount}` : '') +
      (globalCamera ? `, camera=${globalCamera}` : '') +
      (shots ? `, shots=${shots.length}(explicit)` : (numShots ? `, shots=${numShots}` : '')) +
      `, saveTo=${action.saveTo || 'default'}`,
    );

    const result = await instance.generate(prompt, {
      duration: globalDuration,
      aspectRatio: globalAspect,
      resolution: globalResolution,
      quality: globalQuality,
      startFrame: globalStartFrame,
      endFrame: globalEndFrame,
      referenceImages: globalReferenceImages,
      referenceVideos: globalReferenceVideos,
      withAudio: withAudio && caps.withAudio,
      cameraMovement: globalCamera,
      numShots,
      shots,
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
      ...(Array.isArray(result.shots) && result.shots.length > 0 ? { shots: result.shots } : {}),
      usage: result.usage,
    };
  }
};

// ── Internal helpers (hoisted so execute() reads top-down) ────────────

/** Load a single start/end frame image. Returns:
 *    - `{ data, mimeType }` when loaded successfully
 *    - `undefined` when no input was supplied OR the model doesn't support
 *      this kind of frame (we silently drop with a log)
 *    - `{ _error }` when the path was supplied but missing on disk.
 */
async function _loadFrame(pathStr, capFlag, resolved, label) {
  if (!pathStr) return undefined;
  if (!capFlag) {
    channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support ${label} frame — ignoring`);
    return undefined;
  }
  const resolvedPath = path.resolve(pathStr);
  if (!fs.existsSync(resolvedPath)) {
    return { _error: `${label === 'start' ? 'Start' : label === 'end' ? 'End' : label} frame image not found: ${pathStr}` };
  }
  const normalized = await normalizeImageForProvider(resolvedPath);
  if (normalized.converted) {
    channel.log('video', `${label} frame normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
  }
  const data = fs.readFileSync(normalized.path);
  return { data, mimeType: normalized.mimeType };
}

/** Load a list of reference images. See _loadFrame return-shape notes. */
async function _loadReferenceImages(pathArr, caps, resolved) {
  if (!Array.isArray(pathArr) || pathArr.length === 0) return undefined;
  if (!caps.referenceImages) {
    channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support reference images — ignoring`);
    return undefined;
  }
  const maxRef = caps.maxReferenceImages || 1;
  const out = [];
  for (const filePath of pathArr.slice(0, maxRef)) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return { _error: `Reference image not found: ${filePath}` };
    }
    const normalized = await normalizeImageForProvider(resolvedPath);
    if (normalized.converted) {
      channel.log('video', `Reference normalized ${path.extname(resolvedPath)} → png: ${path.basename(resolvedPath)}`);
    }
    const data = fs.readFileSync(normalized.path);
    out.push({ data, mimeType: normalized.mimeType });
  }
  return out;
}

/** Upload a list of reference videos to the gateway storage and return
 *  the resulting URL list. Drops inputs whose upload failed. Logs a
 *  warning and returns undefined when the selected model doesn't do
 *  video-to-video, so we don't waste bandwidth uploading content the
 *  backend will ignore. */
async function _resolveReferenceVideos(pathArr, caps, resolved) {
  if (!Array.isArray(pathArr) || pathArr.length === 0) return undefined;
  if (!caps.videoToVideo) {
    channel.log(
      'video',
      `Provider ${resolved.provider}/${resolved.model} does not support video-to-video — ignoring ${pathArr.length} referenceVideo(s)`,
    );
    return undefined;
  }
  const urls = [];
  for (const input of pathArr) {
    const url = await _uploadVideoRef(input);
    if (url) urls.push(url);
  }
  return urls.length > 0 ? urls : undefined;
}

/** Accept the camera movement string only when the model either
 *  explicitly lists it OR doesn't publish its supported set (open list
 *  → trust the agent, let the backend reject if it's wrong). */
function _sanitiseCameraMovement(cameraMovement, caps, resolved) {
  if (typeof cameraMovement !== 'string') return undefined;
  const want = cameraMovement.trim();
  if (!want) return undefined;
  const known = Array.isArray(caps.cameraMovements) && caps.cameraMovements.length > 0;
  if (!known) return want;
  if (caps.cameraMovements.includes(want)) return want;
  channel.log(
    'video',
    `Provider ${resolved.provider}/${resolved.model} does not support camera movement "${want}" — ignoring`,
  );
  return undefined;
}

// Fire-and-forget: rewrite the tool schema + description from the backend's
// active video model set so the agent only ever sees values the catalog can
// actually serve. Mirrors the pattern in generate-image.js — the description
// is the string the agent sees in AVAILABLE ACTIONS, so the enums must live
// there, not just in schema metadata the renderer doesn't unfold.
fetchMediaCapabilities('video').then((caps) => {
  if (!caps) return;
  const props = generateVideoAction.schema.properties;

  if (caps.aspectRatios?.length) {
    props.aspectRatio = { type: 'string', enum: caps.aspectRatios };
  } else {
    delete props.aspectRatio;
  }

  if (caps.resolutions?.length) {
    props.resolution = { type: 'string', enum: caps.resolutions };
  } else {
    delete props.resolution;
  }

  if (caps.durations?.length) {
    props.duration = { type: 'number', enum: caps.durations };
  }

  const startFrameOk = !!caps.anyImageToVideo;
  const endFrameOk = !!caps.anyFrameControl;
  if (!startFrameOk) delete props.startFrame;
  if (!endFrameOk) delete props.endFrame;

  const refsEnabled = !!caps.hasRefImageSupport;
  if (refsEnabled) {
    props.referenceImages = { type: 'array', items: { type: 'string' } };
  } else {
    delete props.referenceImages;
  }

  // referenceVideos gated by anyVideoToVideo — no point surfacing the
  // field when no active model can actually consume a video input.
  const videoRefsEnabled = !!caps.anyVideoToVideo;
  if (videoRefsEnabled) {
    props.referenceVideos = { type: 'array', items: { type: 'string' } };
  } else {
    delete props.referenceVideos;
  }

  if (!caps.anyAudio) {
    delete props.withAudio;
  }

  // Camera movement: surface only when at least one active model advertises
  // a non-empty cameraMovements CSV. Using an enum keeps the agent from
  // inventing tokens the backend can't route. When no model advertises any,
  // we still leave the free-form string so the agent CAN pass one if it
  // knows about it — the gateway silently drops unknown fields.
  if (caps.cameraMovements?.length) {
    props.cameraMovement = { type: 'string', enum: caps.cameraMovements };
  }

  if (caps.maxShots && caps.maxShots > 1) {
    props.numShots = { type: 'number', minimum: 1, maximum: caps.maxShots };
    // Full per-shot schema only surfaces when there's a model that can
    // actually honour it. Shape mirrors the top-level fields but every
    // entry is optional (unset entries inherit from the global level in
    // execute()).
    const shotItemProps = {
      prompt:          { type: 'string' },
      duration:        { type: 'number' },
      cameraMovement:  caps.cameraMovements?.length
        ? { type: 'string', enum: caps.cameraMovements }
        : { type: 'string' },
    };
    if (startFrameOk) shotItemProps.startFrame = { type: 'string' };
    if (endFrameOk)   shotItemProps.endFrame   = { type: 'string' };
    if (refsEnabled)  shotItemProps.referenceImages = { type: 'array', items: { type: 'string' } };
    if (videoRefsEnabled) shotItemProps.referenceVideos = { type: 'array', items: { type: 'string' } };
    if (caps.aspectRatios?.length) {
      shotItemProps.aspectRatio = { type: 'string', enum: caps.aspectRatios };
    }
    props.shots = {
      type: 'array',
      maxItems: caps.maxShots,
      items: { type: 'object', properties: shotItemProps },
    };
  } else {
    delete props.numShots;
    delete props.shots;
  }

  if (caps.labels?.length) {
    props.label = { type: 'string', enum: caps.labels };
  } else {
    delete props.label;
  }

  // Build the human-readable field list the agent actually reads. Values
  // come from the live catalog — anything outside the enums will be
  // rejected at submit time. No field is listed unless at least one active
  // model supports it (e.g. withAudio disappears entirely when the fleet
  // has no audio-capable video model).
  const fields = ['"prompt" (required) — text description of the desired video'];

  if (caps.durations?.length) {
    const list = caps.durations.map((v) => `${v}`).join(', ');
    fields.push(`optional "duration" — number of seconds. One of: ${list}. Omit to let the backend pick a default.`);
  } else {
    fields.push('optional "duration" — number of seconds (provider-dependent; typical: 4, 5, 6, 8, 10). Omit to use the provider default.');
  }

  if (caps.aspectRatios?.length) {
    const list = caps.aspectRatios.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "aspectRatio" — one of: ${list}. Omit to let the backend pick.`);
  }
  if (caps.resolutions?.length) {
    const list = caps.resolutions.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "resolution" — one of: ${list}. Omit to let the backend pick.`);
  }
  fields.push('optional "quality" — one of: "auto", "low", "medium", "high". Omit to use "auto".');

  if (startFrameOk) {
    fields.push('optional "startFrame" — absolute file path to the first frame image (image-to-video).');
  }
  if (endFrameOk) {
    fields.push('optional "endFrame" — absolute file path to the last frame image (requires a model with frame-control).');
  }
  if (refsEnabled) {
    fields.push('optional "referenceImages" — array of absolute file paths for style / subject guidance.');
  }
  if (videoRefsEnabled) {
    fields.push('optional "referenceVideos" — array of local video file paths (mp4/mov/webm) OR https URLs. Local files are uploaded to the gateway automatically. Use this for video-to-video (style transfer, continuation, restyle).');
  }
  if (caps.anyAudio) {
    fields.push('optional "withAudio" — boolean; generate an audio track alongside the video (default false).');
  }
  if (caps.cameraMovements?.length) {
    const list = caps.cameraMovements.map((v) => `"${v}"`).join(', ');
    fields.push(`optional "cameraMovement" — camera/shot type, one of: ${list}. Omit for free composition.`);
  }
  if (caps.maxShots && caps.maxShots > 1) {
    fields.push(`optional "numShots" — number of independent clips to emit in one call (1..${caps.maxShots}). Omit for a single shot. Ignored when "shots" is present.`);
    const shotKeys = ['prompt?', 'duration?', 'cameraMovement?'];
    if (startFrameOk) shotKeys.push('startFrame?');
    if (endFrameOk) shotKeys.push('endFrame?');
    if (refsEnabled) shotKeys.push('referenceImages?');
    if (videoRefsEnabled) shotKeys.push('referenceVideos?');
    if (caps.aspectRatios?.length) shotKeys.push('aspectRatio?');
    fields.push(
      `optional "shots" — array of per-shot overrides (up to ${caps.maxShots}): ` +
      `{${shotKeys.join(', ')}}. Any field omitted inherits from the top-level. ` +
      `When present, "shots.length" is the clip count and "numShots" is ignored.`,
    );
  }
  if (caps.labels?.length) {
    const list = caps.labels.map((l) => `"${l}"`).join(', ');
    fields.push(`optional "label" — ranking preference, one of: ${list}. Soft hint only, never filters.`);
  }
  fields.push('optional "saveTo" — absolute directory path where the final video will be saved. If the job polls async, pass the SAME saveTo to check_video_status when it completes.');

  const header = 'Generate a video from a text prompt. Video generation is ASYNC — returns a job ID to poll with check_video_status. Every parameter and its allowed values are listed below (values are pulled live from the active model catalog — anything outside the enum will be rejected).';
  const fieldsBlock = '\n' + fields.map((f) => `  - ${f}`).join('\n');
  const returns = '\nReturns: { success, provider, model, capabilities, id, status, savedTo? }';
  generateVideoAction.description = header + fieldsBlock + returns;
}).catch(() => {});

export default generateVideoAction;
