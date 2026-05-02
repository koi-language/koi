/**
 * Generate Video Action — Generate videos from text prompts.
 *
 * Delegates to the provider factory which auto-selects the best available
 * video provider: Kling → Seedance → OpenAI (Sora) → Gemini (Veo) → Google (Nano Banana).
 *
 * `execute()` does the WHOLE pipeline in one call: kick off the provider job,
 * poll until terminal, download the URL, persist to the media library, and
 * return the final result. The agent calls `generate_video` once and gets
 * either `{ success: true, savedTo, ... }` or `{ success: false, error }` —
 * no second call is needed.
 *
 * Wrapped with `asyncCapable` so the agent can opt into background mode by
 * passing `wait: false` — that returns `{ jobId }` immediately and the same
 * pipeline runs inside a koi job. Use `await_job` / `get_job_status` to
 * retrieve the result. (Default `wait: true` keeps the simple inline UX.)
 *
 * Permission: 'generate_video' (individual permission for video generation)
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities, getGatewayBase, getAuthHeaders } from '../../llm/providers/gateway.js';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { channel } from '../../io/channel.js';
import { normalizeImageForProvider } from './_normalize-image-for-provider.js';

/**
 * In-process job-id → generation-params cache for the async path.
 *
 * Sync providers complete inside `execute()` and we can call
 * `saveGeneratedVideo()` immediately. Async providers return only a
 * job id; the actual download happens later inside
 * `await-video-generation.js`, which has none of the call-site context
 * (prompt, model, references, …). We stash the metadata here at
 * job-creation time and `getJobMetadata()` reads it back on completion
 * so the saved row carries the same fields as a sync save.
 *
 * Map is in-process, not persisted — if the engine restarts before
 * the job completes the metadata is lost (best-effort: the video file
 * still saves, just without prompt/model details). Acceptable trade-off
 * for the common case where sessions outlive jobs.
 */
const _pendingJobMetadata = new Map();

export function _stashJobMetadata(jobId, params) {
  if (!jobId) return;
  _pendingJobMetadata.set(String(jobId), params);
}

export function getJobMetadata(jobId) {
  if (!jobId) return null;
  return _pendingJobMetadata.get(String(jobId)) || null;
}

export function clearJobMetadata(jobId) {
  if (!jobId) return;
  _pendingJobMetadata.delete(String(jobId));
}

/** Upload a local video file to the gateway and return a provider-hosted
 *  URL. URL inputs pass through unchanged. Used for `referenceVideos` —
 *  videos are too large to inline as base64 the way we do for images, so
 *  the client streams the bytes to /gateway/uploads/video and the backend
 *  persists them on fal storage.
 *
 *  Returns null (and logs) on any failure so the caller can continue
 *  without the reference instead of aborting the whole generation.
 */
export async function _uploadVideoRef(ref) {
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
 * generate_video (for synchronous completions) and await_video_generation
 * (for async jobs). Returns { path, error } — `path` is the absolute saved
 * path on success, `error` is a human-readable message on failure (path is
 * null in that case). `saveTo` is treated as a DIRECTORY.
 *
 * Streams the response body straight to disk via stream pipeline + retries
 * on transient `terminated` / network resets — `arrayBuffer()` was unreliable
 * for the 10-15MB outputs typical of Kling/Veo: undici aborts mid-body and
 * the call returned null silently with no signal to the agent.
 */
export async function saveVideoFromUrl(url, { saveTo, provider, model, id } = {}) {
  if (!url) return { path: null, error: 'No video URL returned by provider.' };
  const saveDir = typeof saveTo === 'string' && saveTo.trim()
    ? path.resolve(saveTo.trim())
    : path.join(os.homedir(), '.koi', 'videos');

  try {
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  } catch (err) {
    const msg = `Cannot create save directory ${saveDir}: ${err.message}`;
    channel.log('video', msg);
    return { path: null, error: msg };
  }

  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let filePath = null;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        const msg = `HTTP ${resp.status} ${resp.statusText}`;
        channel.log('video', `Download failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${msg}`);
        lastErr = msg;
        if (resp.status >= 400 && resp.status < 500) break; // 4xx won't recover
        continue;
      }
      const contentType = resp.headers.get('content-type') || '';
      const ext = /mp4/i.test(contentType) ? 'mp4'
        : /webm/i.test(contentType) ? 'webm'
        : /quicktime/i.test(contentType) ? 'mov'
        : 'mp4';
      const tag = (id || 'video').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
      const filename = `video_${Date.now()}_${tag}.${ext}`;
      filePath = path.join(saveDir, filename);

      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(filePath));

      const { size } = fs.statSync(filePath);
      channel.log('video', `Saved: ${filePath} (${(size / 1024 / 1024).toFixed(1)}MB)${provider ? ` from ${provider}/${model}` : ''}`);
      return { path: filePath, error: null };
    } catch (err) {
      lastErr = err.message || String(err);
      channel.log('video', `Download failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastErr}`);
      if (filePath) { try { fs.unlinkSync(filePath); } catch { /* ignore */ } }
      // Brief backoff before retry; common cause is mid-stream socket reset.
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }

  return { path: null, error: `Could not download video after ${MAX_ATTEMPTS} attempts: ${lastErr || 'unknown'}` };
}

const generateVideoAction = {
  type: 'generate_video',
  intent: 'generate_video',
  bannerKind: 'video',
  bannerLabel: 'Generando vídeo',
  bannerIconId: 'generate-video',
  // Static fallback for the rare case fetchMediaCapabilities('video') isn't
  // reachable (API-keys-only mode, gateway down at boot). Keep it short —
  // the real, catalog-driven description is rebuilt at the bottom of this
  // file by the fetchMediaCapabilities('video') block and replaces both
  // the description AND the schema enums in place.
  description: 'Generate a video from a text prompt. Blocks internally until the video is ready and returns { success, savedTo, url, ... } — no second call is needed. Supports start/end frames, reference images and video-to-video references, plus optional per-shot overrides for multishot models. Real parameter enums (aspectRatio, resolution, cameraMovement, durations, maxShots) are populated live from the active model catalog. Pass wait=false to start it as a background koi job and retrieve the result with await_job / get_job_status. To EXTEND or CONTINUE an existing video, call `extract_frame` first to grab the source\'s last (or any) frame and pass its `savedTo` here as `startFrame` — never assume a frame file already exists on disk; if you didn\'t extract it in this turn, it doesn\'t exist.',
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
      characterOrientation: { type: 'string', enum: ['image', 'video'], description: 'Motion-transfer models only (label="motion-transfer"): "image" preserves the still photo\'s character pose/orientation while inheriting motion from the reference video (default — natural for "make my character do that"); "video" reorients the character to match the reference video\'s pose (use for dance / body-mimicry where the reference body shape is the target). Ignored by every other model.' },
      keepOriginalSound: { type: 'boolean', description: 'Motion-transfer models only (label="motion-transfer"): when true (default) preserves the audio track of the reference video in the output. Ignored by every other model.' },
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
      saveTo:          { type: 'string',  description: 'Directory to save the final video file in. Defaults to ~/.koi/videos/ when omitted.' },
      timeoutMs:       { type: 'number',  description: 'Max wall-clock to wait for the provider (default 600000 = 10 min). On timeout, success=false and status=pending — call generate_video again to retry.' },
      pollIntervalMs:  { type: 'number',  description: 'Poll cadence for the provider in milliseconds (default 8000, clamped to [2000, 30000]).' },
      model:           { type: 'string',  description: 'Specific model to use (optional — auto-selects if omitted)' },
      excludeModels:   { type: 'array',   items: { type: 'string' }, description: 'Slugs to skip on the next auto-pick. CRITICAL: pass the FULL MODEL SLUG (e.g. "bytedance/seedance-2.0/image-to-video"), NOT a provider/family name like "fal-ai", "google", or "openai" — provider names will silently match nothing because the router compares against slugs. There is NO `excludeProviders` parameter for video; do not invent one. Workflow: when a previous call returned `success:false`, copy the slug from that response\'s `model` field verbatim into this array, then retry. The router will skip those slugs and pick the next best candidate from the same category.' },
      includeModels:   { type: 'array',   items: { type: 'string' }, description: 'Whitelist: when set (non-empty), the auto-picker considers ONLY these slugs and ignores every other model in the catalog. Pass FULL slugs (e.g. "fal-ai/veo3.1/first-last-frame-to-video") — provider/family names match nothing. Use when the user explicitly says "use this model / try with X / only use Y". Combines with excludeModels (the whitelist is reduced by the blacklist). If the resulting set is empty after both filters and the regular category/capability checks, the call fails with no_model_matches.' },
      preferQuality:   { type: 'boolean', description: 'When true (DEFAULT), the auto-picker prefers MORE EXPENSIVE models on tiebreaks — price is treated as a quality proxy and the user is assumed to want the best result. Set to false ONLY when the user explicitly asks for the cheapest option / a budget run.' },
      kind:            { type: 'string',  enum: ['extend'], description: 'Set to "extend" when the user asks to CONTINUE / EXTEND / make-longer an existing video. Routes to the dedicated `video_extend` model bucket (curated in the backoffice). Combine with referenceVideos=[<source>] (or startFrame=<last frame> via extract_frame). Omit for fresh generations / restyles / edits.' },
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

    // Forward the agent's `label` selector down to the gateway so the
    // client-side router can apply it as a model-variant filter (e.g.
    // "sketch-guided" routes to a model that interprets drawn marks).
    // Without this, the agent's label was silently dropped here and the
    // router fell through to the "no label requested" branch, which
    // pins to non-labelled models — picking the cheapest generic instead
    // of the specialised variant the agent explicitly asked for.
    const label = typeof action.label === 'string' && action.label.trim()
      ? action.label.trim()
      : null;

    // Motion-transfer-specific knobs. The backend's adapter for Kling V3
    // motion-control (and any future motion-transfer model) reads these;
    // every other model ignores them. Default character_orientation is
    // not set here — the backend defaults to "image" when missing.
    const characterOrientation = (action.characterOrientation === 'image' || action.characterOrientation === 'video')
      ? action.characterOrientation
      : null;
    const keepOriginalSound = typeof action.keepOriginalSound === 'boolean'
      ? action.keepOriginalSound
      : null;

    const abortSignal = agent?.abortSignal;
    const reportProgress = typeof agent?.reportProgress === 'function' ? agent.reportProgress : null;

    reportProgress?.(0.02, 'Submitting to provider…');
    const submitted = await instance.generate(prompt, {
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
      label,
      characterOrientation,
      keepOriginalSound,
      // Forward auto-picker hints. The router consumes these client-side
      // (see GatewayVideoGen.generate → pickVideoModel) — they never leave
      // the device; the chosen slug is what travels to the backend.
      excludeModels: Array.isArray(action.excludeModels) ? action.excludeModels : undefined,
      includeModels: Array.isArray(action.includeModels) ? action.includeModels : undefined,
      // Default true — quality wins ties unless the agent / user
      // explicitly opts out for budget runs.
      preferQuality: action.preferQuality !== false,
      // `extend` routes to the curated `video_extend` category bucket
      // in pickVideoModel (see media-model-router.js).
      kind: action.kind,
    });

    // Build the generation-params record once — used both for the
    // in-process job cache (kept for backwards-compat with hidden
    // await_video_generation) AND for the saveGeneratedVideo() call.
    const generationParams = {
      prompt,
      model: submitted?.model || resolved.model,
      provider: resolved.provider,
      duration: globalDuration,
      aspectRatio: globalAspect,
      resolution: globalResolution,
      quality: globalQuality,
      cameraMovement: globalCamera || null,
      withAudio: !!(withAudio && caps.withAudio),
      startFrame: action.startFrame || null,
      endFrame: action.endFrame || null,
      referenceImagePaths: Array.isArray(action.referenceImages) ? action.referenceImages : [],
      referenceVideoPaths: Array.isArray(action.referenceVideos) ? action.referenceVideos : [],
      shotCount: shots?.length || numShots || 1,
      saveTo: action.saveTo || null,
    };

    if (submitted.id) _stashJobMetadata(submitted.id, generationParams);

    // Poll the provider until the job reaches a terminal state. Sync
    // providers return `status === 'completed'` straight away and the
    // loop exits immediately on the first iteration.
    const final = await _pollUntilTerminal(instance, submitted, {
      abortSignal,
      reportProgress,
      timeoutMs: typeof action.timeoutMs === 'number' && action.timeoutMs > 0
        ? action.timeoutMs
        : DEFAULT_TIMEOUT_MS,
      pollIntervalMs: typeof action.pollIntervalMs === 'number' && action.pollIntervalMs > 0
        ? action.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS,
    });

    if (final.status === 'failed') {
      if (submitted.id) clearJobMetadata(submitted.id);
      // Prefix the error string with the resolved slug so the agent
      // sees WHICH model rejected the call — even when the action
      // result is summarised as a single line (`❌ generate_video
      // FAILED: <error>`). Without this prefix the slug only shows up
      // as a structured field that some renderers swallow, and the
      // agent ends up guessing wrong (e.g. `excludeProviders:
      // ['fal-ai']` instead of `excludeModels: [<slug>]`).
      const _failSlug = final.model || resolved.model;
      const _failMsg = final.error || 'Provider reported failure with no error message.';
      return {
        success: false,
        provider: resolved.provider,
        model: _failSlug,
        id: final.id || submitted.id,
        status: 'failed',
        error: `[model=${_failSlug}] ${_failMsg}`,
      };
    }

    if (final.status === 'pending') {
      // Timed out before the provider finished. Surface as a soft
      // failure so the agent can retry (the provider's request id is
      // returned for advanced manual recovery, but the agent should
      // typically just call generate_video again).
      const _pendingSlug = final.model || resolved.model;
      const _pendingMsg = final.error || `Timed out waiting for provider to finish.`;
      return {
        success: false,
        provider: resolved.provider,
        model: _pendingSlug,
        id: final.id || submitted.id,
        status: 'pending',
        error: `[model=${_pendingSlug}] ${_pendingMsg}`,
      };
    }

    // ── status === 'completed' from here ────────────────────────────
    let savedTo = null;
    let saveError = null;
    if (final.url) {
      reportProgress?.(0.95, 'Downloading video…');
      const saveResult = await saveVideoFromUrl(final.url, {
        saveTo: action.saveTo,
        provider: resolved.provider,
        model: resolved.model,
        id: final.id,
      });
      savedTo = saveResult.path;
      saveError = saveResult.error;
      if (savedTo && channel.canPresentResources?.()) {
        channel.presentResource({ type: 'video', path: savedTo });
      }
      if (savedTo) {
        try {
          const params = { ...generationParams };
          if (final.model) params.model = final.model;
          const { saveGeneratedVideo } = await import('../../state/media-library.js');
          await saveGeneratedVideo(savedTo, params, agent?.llmProvider || null);
          channel.log('video', `Saved to media library: ${savedTo}`);
        } catch (err) {
          channel.log('video', `Media library save failed (continuing): ${err.message}`);
        }
      }
    }

    // Per-shot downloads for multishot completions. Each shot is also
    // registered in the MediaLibrary so it appears in the creations
    // drawer alongside the parent video — without this, multishot
    // generations only put their first/last shot in the drawer.
    let savedShots;
    if (Array.isArray(final.shots) && final.shots.length > 0) {
      savedShots = [];
      const { saveGeneratedVideo } = await import('../../state/media-library.js');
      for (const shot of final.shots) {
        let shotSavedTo = null;
        let shotSaveError = null;
        if (shot.status === 'completed' && shot.url) {
          const sr = await saveVideoFromUrl(shot.url, {
            saveTo: action.saveTo,
            provider: resolved.provider,
            model: resolved.model,
            id: `shot${shot.index}-${shot.id || ''}`,
          });
          shotSavedTo = sr.path;
          shotSaveError = sr.error;
          if (shotSavedTo && channel.canPresentResources?.()) {
            channel.presentResource({ type: 'video', path: shotSavedTo });
          }
          if (shotSavedTo) {
            try {
              const shotParams = {
                ...generationParams,
                ...(final.model ? { model: final.model } : {}),
                shotIndex: shot.index,
                ...(shot.prompt ? { prompt: shot.prompt } : {}),
              };
              await saveGeneratedVideo(shotSavedTo, shotParams, agent?.llmProvider || null);
            } catch (err) {
              channel.log('video', `Media library save failed for shot ${shot.index} (continuing): ${err.message}`);
            }
          }
        }
        savedShots.push({
          index: shot.index,
          id: shot.id,
          status: shot.status,
          url: shot.url,
          ...(shotSavedTo ? { savedTo: shotSavedTo } : {}),
          ...(shotSaveError ? { saveError: shotSaveError } : {}),
          error: shot.error,
        });
      }
    }

    if (submitted.id) clearJobMetadata(submitted.id);
    if (final.id && final.id !== submitted.id) clearJobMetadata(final.id);

    reportProgress?.(1, 'Done');
    return {
      success: true,
      provider: resolved.provider,
      model: final.model || resolved.model,
      capabilities: caps,
      id: final.id || submitted.id,
      status: 'completed',
      url: final.url,
      ...(savedTo ? { savedTo } : {}),
      ...(saveError ? { saveError } : {}),
      ...(savedShots ? { shots: savedShots } : {}),
      usage: final.usage,
    };
  }
};

// ── Provider polling (collapsed from the old await_video_generation) ─
const DEFAULT_POLL_INTERVAL_MS = 8000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — covers slow providers (Kling, Veo, Sora) on long durations
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30000;

const _sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) {
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    if (signal.aborted) { clearTimeout(t); reject(new Error('aborted')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

/**
 * Poll the provider until the job reaches a terminal state (completed
 * or failed). Returns the final status snapshot with at least
 * { id, status, url?, model?, shots?, error?, usage? }. Status `pending`
 * means we hit the timeout — caller should surface it.
 *
 * Sync providers return `status: 'completed'` from the kick-off itself;
 * the loop returns on the first call without polling.
 */
export async function _pollUntilTerminal(instance, submitted, { abortSignal, reportProgress, timeoutMs, pollIntervalMs }) {
  const pollMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs));
  const deadline = Date.now() + timeoutMs;
  const t0 = Date.now();

  // Sync completion right out of the gate. Some providers omit `status`
  // and just return the URL — treat that as completed too.
  if (submitted.status === 'completed' || submitted.status === 'failed') {
    return submitted;
  }
  if (!submitted.status && submitted.url) {
    return { ...submitted, status: 'completed' };
  }

  let result = submitted;
  let consecutiveErrors = 0;
  const jobId = submitted.id;
  if (!jobId) {
    return { ...submitted, status: 'failed', error: 'Provider returned no job id and no synchronous URL.' };
  }

  while (true) {
    if (abortSignal?.aborted) {
      return { ...result, status: 'pending', error: 'Aborted before video finished.' };
    }
    try {
      result = await instance.getStatus(jobId, { abortSignal });
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        return { ...result, status: 'failed', error: `Polling failed repeatedly: ${err.message}` };
      }
      channel.log('video', `generate_video polling: transient error (${consecutiveErrors}/5): ${err.message}`);
      // Reuse last good `result` and try again after backoff.
    }
    if (result.status === 'completed' || result.status === 'failed') return result;

    // Time-elapsed driven progress: 0.05..0.92 reserved for polling.
    if (reportProgress) {
      const elapsed = Date.now() - t0;
      const pct = Math.min(0.92, 0.05 + 0.87 * Math.min(1, elapsed / Math.max(1, timeoutMs)));
      reportProgress(pct, `Waiting for provider… ${Math.round(elapsed / 1000)}s`);
    }

    if (Date.now() + pollMs > deadline) {
      return {
        ...result,
        status: 'pending',
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for video.`,
      };
    }
    try {
      await _sleep(pollMs, abortSignal);
    } catch {
      return { ...result, status: 'pending', error: 'Aborted before video finished.' };
    }
  }
}

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
    // Self-healing hint: missing frames are almost always the
    // "extend / continue this video" flow where the agent assumed a
    // previous step already extracted the still. Tell it where the
    // file is missing AND which tool to call instead, so the next
    // iteration produces the right action automatically.
    return {
      _error:
        `${label === 'start' ? 'Start' : label === 'end' ? 'End' : label} frame image not found: ${pathStr}. ` +
        `If you need a still from an existing video (e.g. last/specific frame to use as startFrame), call the \`extract_frame\` tool first ` +
        `(intent: "extract_frame", video: "<source.mp4>", timeMs|timeSeconds: <position>), then pass its \`savedTo\` here as the frame path. ` +
        `For "extend video from last frame", use timeMs equal to the source's duration in ms minus a few frames (e.g. duration - 33).`,
    };
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

import asyncCapable from '../_async-capable.js';
import { formatModelCatalog } from './_format-model-catalog.js';

// Wrap FIRST so the catalog refresh below mutates the registered object.
// asyncCapable spreads a fresh schema/description, so any in-place edit to
// the source `generateVideoAction` would land on a copy nobody reads.
const wrappedAction = asyncCapable(generateVideoAction);

// Fire-and-forget: rewrite the tool schema + description from the backend's
// active video model set so the agent only ever sees values the catalog can
// actually serve. Mirrors the pattern in generate-image.js — the description
// is the string the agent sees in AVAILABLE ACTIONS, so the enums must live
// there, not just in schema metadata the renderer doesn't unfold.
//
// Exposed as `_descriptionReady` so `get_tool_info` can await the rewrite
// before reading the description (otherwise the first lookup hits the
// static fallback).
wrappedAction._descriptionReady = fetchMediaCapabilities('video').then((caps) => {
  if (!caps) return;
  const props = wrappedAction.schema.properties;

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

  // `kind: "extend"` only surfaces when at least one model in the
  // catalog is tagged with the `video_extend` category. Without a
  // backing model the parameter would just dead-end the picker.
  if (!caps.anyExtend) {
    delete props.kind;
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
    const details = Array.isArray(caps.labelDetails) ? caps.labelDetails : [];
    const lines = caps.labels.map((slug) => {
      const d = details.find((x) => x && x.slug === slug);
      const desc = d && d.description ? ` — ${d.description}` : '';
      return `    • "${slug}"${desc}`;
    }).join('\n');
    fields.push(`optional "label" — ranking preference. Soft hint only, never filters. Pick the slug whose description matches the task; omit when no specialisation is needed:\n${lines}`);
  }
  if (caps.anyExtend) {
    fields.push('optional "kind" — set to "extend" when the user wants to CONTINUE / EXTEND / make-longer an existing video. Routes to the dedicated extension-tuned model. Combine with referenceVideos=[<source>] (or startFrame=<last frame>). Omit for fresh generations / restyles / edits.');
  }
  fields.push('optional "saveTo" — absolute directory path where the final video will be saved. Defaults to ~/.koi/videos/.');
  fields.push('optional "wait" — boolean (default true). When true, the call blocks until the video is ready and returns the final result inline. Set to false to start it as a background koi job and get back { jobId } immediately — use await_job(jobId) to retrieve the result.');

  const header = 'Generate a video from a text prompt. Blocks internally until the provider finishes and returns { success, savedTo, url, error? } — the agent does NOT need a second call. The router auto-picks one model from the active catalog based on your params — see the per-model breakdown at the end of this description for what each option supports. Provider failures (validation, content policy, rate-limit, …) come back as success=false with the verbatim provider error in the `error` field. Pass wait=false to run it as a background koi job (then poll with await_job / get_job_status). Every parameter and its allowed values are listed below (values are pulled live from the active model catalog — anything outside the enum will be rejected).';
  const fieldsBlock = '\n' + fields.map((f) => `  - ${f}`).join('\n');
  const returns = '\nReturns: { success, provider, model, capabilities, savedTo?, url?, status, shots?, error? }. On success=false, read `error` to see what the provider rejected.';
  const asyncSuffix = ' This tool is async-capable: pass wait=false to kick it off as a background job (returns { jobId }) instead of blocking.';
  const catalog = formatModelCatalog(caps.models);
  wrappedAction.description = header + fieldsBlock + returns + catalog + asyncSuffix;
}).catch(() => {});

export default wrappedAction;
