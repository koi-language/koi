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
import { autoAttachMentions, assignPositionalAliases, listAvailableMentions } from './_auto-attach-mentions.js';
import { slugifyDescription, buildDescribedFilename } from './util/slugify-description.js';
import {
  padIfNeeded,
  recoverFromPadded,
  pickEnvelopeResolution,
  targetDimsForResolutionAspect,
  stripVideoEditList,
} from './_pad-and-recover.js';
import { spawn as _spawnForProbe } from 'child_process';
import { ensureFfmpeg as _ensureFfmpegForProbe } from '../../media/ffmpeg-installer.js';

/** Probe a media file's dimensions so we can pick a model-supported
 *  envelope BEFORE spending a padding round on a wrong target. Tries
 *  ffprobe first, falls back to ffmpeg's stderr-summary. Returns
 *  `{ width, height }` or null. Mirrors the helper in
 *  `_pad-and-recover.js` but inlined here so we can probe ahead of
 *  the padIfNeeded call without circular imports. */
async function _probeRefDims(filePath) {
  const envFf = process.env.KOI_FFMPEG_PATH;
  const envFp = process.env.KOI_FFPROBE_PATH;
  let bins = null;
  if (envFf && envFp && fs.existsSync(envFf) && fs.existsSync(envFp)) {
    bins = { ffmpeg: envFf, ffprobe: envFp };
  } else if (envFf && fs.existsSync(envFf)) {
    bins = { ffmpeg: envFf, ffprobe: null };
  } else {
    try { bins = await _ensureFfmpegForProbe(); } catch { return null; }
  }
  if (!bins?.ffmpeg) return null;
  if (bins.ffprobe) {
    const dims = await new Promise((resolve) => {
      const proc = _spawnForProbe(bins.ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        filePath,
      ]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => {
        const m = out.trim().match(/^(\d+),(\d+)/);
        if (!m) return resolve(null);
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        if (!w || !h) return resolve(null);
        resolve({ width: w, height: h });
      });
      proc.on('error', () => resolve(null));
    });
    if (dims) return dims;
  }
  return await new Promise((resolve) => {
    const proc = _spawnForProbe(bins.ffmpeg, [
      '-hide_banner', '-i', filePath, '-f', 'null', '-frames:v', '1', '-',
    ]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', () => {
      const m = err.match(/Stream #\d+:\d+(?:[^\n]*?Video:[^\n]*?)\b(\d{2,5})x(\d{2,5})\b/);
      if (!m) return resolve(null);
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      if (!w || !h) return resolve(null);
      resolve({ width: w, height: h });
    });
    proc.on('error', () => resolve(null));
  });
}

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
export async function _uploadVideoRef(ref, opts = {}) {
  if (!ref) return null;
  if (typeof ref !== 'string') return null;
  if (/^https?:\/\//i.test(ref)) return ref; // already a URL
  const original = path.resolve(ref);
  if (!fs.existsSync(original)) {
    channel.log('video', `reference video not found: ${original}`);
    return null;
  }
  // Defensive temporal pad at the upload site. Some models reject inputs
  // below a hard duration floor (Seedance 2.0 reference-to-video observed:
  // 2.0 s minimum, fal returns `body.video_urls.0: Video duration is too
  // short. Minimum is 2.0 seconds. Found 1.633333 seconds.`). The
  // upstream `padIfNeeded` branch in execute() only fires for the
  // `caps.videoToVideo` path; reference-to-video routes upload through
  // here without going through that branch and used to hit the
  // backend with the raw short clip. Guaranteeing the minimum at THIS
  // layer protects every callsite (v2v, reference-to-video, v2v extend,
  // future buckets) with one block of code.
  //
  // We probe dimensions first and pass them as `targetDims` so
  // `padIfNeeded` does TEMPORAL pad only — no spatial scaling/padding
  // (which would re-encode the canvas unnecessarily and could change
  // resolution underneath the model's envelope picker). The temporal
  // pad appends a black tail via ffmpeg's `tpad` filter; recovery
  // already trims it back to the original duration so the user never
  // sees the filler.
  let resolved = original;
  if (Number.isFinite(opts.minDurationSec) && opts.minDurationSec > 0) {
    try {
      const dims = await _probeRefDims(original);
      const padOpts = { minDurationMs: opts.minDurationSec * 1000 };
      if (dims && dims.width > 0 && dims.height > 0) {
        padOpts.targetDims = { w: dims.width, h: dims.height };
      }
      const r = await padIfNeeded(original, 'video', padOpts);
      if (r?.paddedPath && r.geometry?.needsTemporalPad) {
        channel.log(
          'video',
          `pre-upload temporal pad: ${path.basename(original)} → ` +
          `${path.basename(r.paddedPath)} ` +
          `(source < ${opts.minDurationSec.toFixed(3)}s min, padded with black tail)`,
        );
        resolved = r.paddedPath;
      }
    } catch (err) {
      channel.log(
        'video',
        `pre-upload temporal pad failed (uploading original — may be rejected): ${err?.message || err}`,
      );
    }
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
/**
 * Redirect any `saveTo` that points INSIDE a workflow workspace
 * (`<root>/.koi/workflows/<run_id>/...`) to the canonical home for
 * media of this kind (`~/.koi/<kind>/`). Workflow workspaces are
 * ephemeral — they get cleaned up at run-end (or by manual garbage
 * collection), and anything persisted there silently disappears.
 * Generated artefacts MUST live in stable storage if downstream code
 * (timelines, gallery, chat history) is going to reference them by
 * absolute path; otherwise the user sees clips turn into black
 * rectangles with "file missing" cartouches days later. See the
 * "de repente un clip ha desaparecido" diagnosis for the exact
 * incident this guards against. Kind is one of `videos` / `images` /
 * `audio` (drives the destination directory under `~/.koi/`).
 */
function _canonicalKoiSaveDir(resolvedDir, kind) {
  if (typeof resolvedDir !== 'string' || !resolvedDir) return resolvedDir;
  const segs = resolvedDir.split(path.sep);
  // Detect `<...>/.koi/workflows/<...>` anywhere in the path. The leading
  // dot keeps us from triggering on a user folder literally named
  // `workflows`.
  let inWorkflowWorkspace = false;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === '.koi' && segs[i + 1] === 'workflows') {
      inWorkflowWorkspace = true;
      break;
    }
  }
  if (!inWorkflowWorkspace) return resolvedDir;
  const canonical = path.join(os.homedir(), '.koi', kind);
  channel.log(
    'video',
    `saveTo "${resolvedDir}" is inside a workflow workspace (ephemeral); ` +
    `redirecting to canonical home "${canonical}" so the artefact survives ` +
    `workspace cleanup. Workflows that need true intermediates should keep ` +
    `them outside generator output paths.`,
  );
  return canonical;
}

export async function saveVideoFromUrl(url, { saveTo, provider, model, id, prompt } = {}) {
  if (!url) return { path: null, error: 'No video URL returned by provider.' };
  const saveDir = _canonicalKoiSaveDir(
    typeof saveTo === 'string' && saveTo.trim()
      ? path.resolve(saveTo.trim())
      : path.join(os.homedir(), '.koi', 'videos'),
    'videos',
  );

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
      // Derive a descriptive name from the prompt when the caller
      // supplied one. Falls back to the legacy `video_<id>` shape when
      // there's no prompt (e.g. when this util is called from a path
      // that just stitches segments — no descriptive text to slug).
      const slug = slugifyDescription(prompt);
      let filename;
      if (slug) {
        filename = buildDescribedFilename({ slug, fallback: 'video', index: 0, ext });
      } else {
        const tag = (id || 'video').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
        filename = `video_${Date.now()}_${tag}.${ext}`;
      }
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
  description: 'Generate a video from a text prompt. Blocks internally until the video is ready and returns { success, savedTo, url, ... } — no second call is needed. Supports start/end frames, reference images and video-to-video references, plus optional per-shot overrides for multishot models. Reference fields (referenceImages, referenceVideos, startFrame, endFrame) ALL accept `@mention` handles in addition to paths/URLs — e.g. `referenceImages: ["@tom"]` resolves via the cross-project MediaLibrary to whatever tag_media last pinned to `@tom` (most-recent-first when several match). Real parameter enums (aspectRatio, resolution, cameraMovement, durations, maxShots) are populated live from the active model catalog. Pass wait=false to start it as a background koi job and retrieve the result with await_job / get_job_status. To EXTEND or CONTINUE an existing video, call `extract_frame` first to grab the source\'s last (or any) frame and pass its `savedTo` here as `startFrame` — never assume a frame file already exists on disk; if you didn\'t extract it in this turn, it doesn\'t exist.',
  thinkingHint: 'Generating video',
  permission: 'generate_video',

  schema: {
    type: 'object',
    properties: {
      prompt:          { type: 'string',  description: 'Text description of the desired video. MANDATORY: write the prompt in English regardless of the user\'s language — video models are trained on English-heavy datasets and lose motion fidelity / scene coherence with non-English prompts. The ONLY exception is dialogue, lyrics, voice-over lines, or on-screen text the model must reproduce verbatim — keep that in the user\'s language, wrapped in quotes inside the otherwise-English prompt.' },
      duration:        { type: 'number',  description: 'Duration in seconds (default: 5)' },
      aspectRatio:     { type: 'string',  description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4 (default: 16:9)' },
      resolution:      { type: 'string',  description: 'Resolution: 360p, 480p, 720p, 1080p, 2k, 4k (default: 720p)' },
      quality:         { type: 'string',  description: 'Quality: auto, low, medium, high (default: auto)' },
      startFrame:      { type: 'string',  description: 'LITERAL first frame of the output video — the exact pixels the generated video must begin from (image-to-video). Frame 0 of the result will look IDENTICAL to this image. Use ONLY when the user wants the video to start FROM this exact picture (e.g. "animate this photo", "make a video starting with this image", "extend this frame"). \n\n**HARD RULE — do NOT pass any of these as `startFrame`:**\n  - storyboards / sheets / multi-panel designs (those describe multiple shots; a single video can\'t "begin" from a grid of 10 panels);\n  - mood boards, character sheets, style references (those are LOOK guidance, not a literal frame);\n  - any image that doesn\'t already match the EXACT first second of the generation prompt (a wide shot, a different framing, the wrong scene = wrong field).\n\nIf the workflow / user message says "use the storyboard" or "reference the sheet", that asset describes COMPOSITION across shots — it goes into `referenceImages` (when the chosen model accepts visual refs) or is consumed ONLY as guidance for the prompt TEXT itself, never here. If unsure between `startFrame` and `referenceImages`, choose `referenceImages` — `startFrame` is a strict commitment to identical pixels at t=0. **BUT this caveat does NOT apply when the user explicitly names a frame:** "start/first frame = this image", "begin with this photo", "animate FROM this picture" → that is exactly `startFrame`, use it (and if they also name the end/last frame, set `endFrame` to the second image — see `endFrame`). Never answer such an explicit FROM→TO request with a frameless text-only prompt. Also accepts a `@mention` handle (e.g. "@hero_pose").' },
      endFrame:        { type: 'string',  description: 'LITERAL last frame of the output video — the exact image the generated video must END on. Same semantics as `startFrame` (literal, not stylistic). **Pair it with `startFrame` whenever the user asks to animate FROM one image TO another** — e.g. "first frame = this photo, last frame = that photo", "make a video that starts with A and ends with B", "transition from this image to that one". In that case pass `startFrame` = the first image AND `endFrame` = the second; the model interpolates between them. Do NOT collapse such a request into a text-only prompt with no frames — the two images ARE the request. Also accepts a `@mention` handle.' },
      referenceImages: { type: 'array',   description: 'Visual REFERENCES — style sheets, storyboards, character designs, mood boards, subject photos — that the model may use as guidance for look/composition/identity but NOT as the literal first frame. Use this whenever the image is "what the result should LOOK like or RESEMBLE", never "what frame 1 must be". For a storyboard or multi-panel sheet, list every panel here. Routes to multi-image reference-to-video models when available; if the catalog only has image-to-video slugs the call will fail rather than silently treating the first reference as a start frame. Accepts file paths, attachment IDs (att-N), or `@mention` handles (e.g. "@tom"); `@`-handles resolve via MediaLibrary against whatever tag_media last pinned to that handle, most-recent-first when several match — same model the chat input bar uses.', items: { type: 'string' } },
      referenceVideos: { type: 'array',   description: 'Video REFERENCES for style/motion/continuation guidance — NOT a literal frame source. Local video paths, https URLs, or `@mention` handles. Local paths are uploaded to the gateway transparently; `@name` resolves via MediaLibrary the same way as referenceImages. Only honored when the selected model advertises videoToVideo.', items: { type: 'string' } },
      withAudio:       { type: 'boolean', description: 'Generate an audio track (SFX, dialogue, voiceover, ambient) alongside the video. DEFAULT: true — videos come back WITH sound unless you explicitly pass false. Only set false for a deliberately silent clip. NOTE: this does NOT control background music; excluding music is done via the prompt text, not by silencing the whole clip.' },
      cameraMovement:  { type: 'string',  description: 'Camera movement / shot type, e.g. "static", "pan_left", "zoom_in", "dolly_in", "orbit_right". Provider-dependent — unknown values are ignored.' },
      characterOrientation: { type: 'string', enum: ['image', 'video'], description: 'Only consumed by models that perform pose / motion transfer from a reference video onto a still character (see the catalog snapshot — the label slug for this family lives in the per-model labels list, alongside its glossary entry). "image" preserves the still photo\'s character pose/orientation while inheriting motion from the reference video (default — natural for "make my character do that"); "video" reorients the character to match the reference video\'s pose (use for dance / body-mimicry where the reference body shape is the target). Ignored by every other model.' },
      keepOriginalSound: { type: 'boolean', description: 'Only consumed by models that perform motion transfer from a reference video (see the catalog snapshot — same family as `characterOrientation`). When true (default) preserves the audio track of the reference video in the output. Ignored by every other model.' },
      numShots:        { type: 'number',  description: 'Number of independent clips to emit in a single call (multishot). Default 1. Only models with maxShots > 1 honor it. Ignored when "shots" is present.' },
      shots:           {
        type: 'array',
        description: 'Per-shot overrides for multishot models. Each entry can customise prompt / duration / cameraMovement / startFrame / endFrame / referenceImages / referenceVideos / aspectRatio for THAT shot; missing fields inherit from the top-level settings. When present, "numShots" is ignored and the clip count equals shots.length.',
        items: {
          type: 'object',
          properties: {
            prompt:          { type: 'string', description: 'Per-shot prompt override. MANDATORY: English (same rule as the top-level prompt — only dialogue / voice-over / on-screen text stays in the user\'s language).' },
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
      timeoutMs:       { type: 'number',  description: 'Max wall-clock to wait for the provider (default 1200000 = 20 min). On timeout, success=false and status=pending — call generate_video again to retry.' },
      pollIntervalMs:  { type: 'number',  description: 'Poll cadence for the provider in milliseconds (default 8000, clamped to [2000, 30000]).' },
      model:           { type: 'string',  description: 'Specific model to use (optional — auto-selects if omitted)' },
      excludeModels:   { type: 'array',   items: { type: 'string' }, description: 'Slugs to skip on the next auto-pick. CRITICAL: pass the FULL MODEL SLUG (e.g. "bytedance/seedance-2.0/image-to-video"), NOT a provider/family name like "fal-ai", "google", or "openai" — provider names will silently match nothing because the router compares against slugs. There is NO `excludeProviders` parameter for video; do not invent one. Workflow: when a previous call returned `success:false`, copy the slug from that response\'s `model` field verbatim into this array, then retry. The router will skip those slugs and pick the next best candidate from the same category.' },
      includeModels:   { type: 'array',   items: { type: 'string' }, description: 'Whitelist: when set (non-empty), the auto-picker considers ONLY these slugs and ignores every other model in the catalog. Pass FULL slugs (e.g. "fal-ai/veo3.1/first-last-frame-to-video") — provider/family names match nothing. Use when the user explicitly says "use this model / try with X / only use Y". Combines with excludeModels (the whitelist is reduced by the blacklist). If the resulting set is empty after both filters and the regular category/capability checks, the call fails with no_model_matches.' },
      preferQuality:   { type: 'boolean', description: 'When true (DEFAULT), the auto-picker prefers MORE EXPENSIVE models on tiebreaks — price is treated as a quality proxy and the user is assumed to want the best result. Set to false ONLY when the user explicitly asks for the cheapest option / a budget run.' },
      kind:            { type: 'string',  enum: ['edit', 'continuation', 'extend', 'bg-remove'], description: 'Routes to a curated model bucket on the backoffice. DEFAULT behaviour mirrors `generate_image`: OMIT for plain text-to-video generation; pass `referenceVideos` (without `kind`) and the request automatically routes to `video_editing` (v2v transform — restyle, colour grade, repaint, motion swap; pool = kling-style v2v slugs). The transformation replaces the source content; identity is anchored by the source itself. EXPLICIT VALUES — use ONLY when you want to override the default: "continuation" → opt OUT of editing when the previous clip is being passed in `referenceVideos` purely as a STYLE / IDENTITY carry-over (storyboard-to-video continuity, multi-shot character lock); routes back to `video_generation` so seedance reference-to-video and similar continuation-aware slugs stay in the pool. Use this when the prompt describes a NEW scene that should keep the look of the reference, not a transformation of the reference itself. "edit" → explicit alias for the default v2v editing path; redundant when `referenceVideos` is already present, but accepted for clarity. "extend" → continue / make-longer an existing video (`video_extend` bucket); pair with referenceVideos=[<source>] and pass `duration` as the EXTENSION length in seconds (NOT the total — e.g. to extend a 6 s clip by 4 s, send duration=4). The tool guarantees a unified return shape: the saved output is ALWAYS the full source+extension video, regardless of whether the chosen adapter natively returns the full stitched result (Veo3.1 extend, Kling extend) or only the new tail slice (Seedance reference-to-video — the tool concats the source on the front for you). "bg-remove" → strip the background out of the input video producing a transparent-background MP4 (`video_background_removal` bucket; e.g. Bria video matting). Combine with referenceVideos=[<source>].' },
      suppressPresent: { type: 'boolean', description: 'When true, the result is NOT auto-presented in the GUI work area (no tab opens, no preview takeover). Pass this when the generation is destined for a specific timeline AI clip — the assignment tool drops the media onto the clip directly and the user expects the timeline to stay focused. Default false (the GUI opens the result for inspection on free-form generations).' },
      summary:         { type: 'string',  description: 'OPTIONAL. One-line "what was this for" — pinned to this session\'s creations ledger so you can later list / recall it via `recall_creations` without searching the filesystem. Examples: "Ferrari pulling out of garage — opening shot", "Continuation of shot 2 with rain". Keep it short and self-evident; the agent is the one who will read it back later. When omitted, the ledger falls back to the prompt — usable but less semantic.' },
    },
    required: ['prompt']
  },

  examples: [
    { intent: 'generate_video', prompt: 'A drone shot flying over a misty forest at sunrise', duration: 10, aspectRatio: '16:9' },
    { intent: 'generate_video', prompt: 'Product rotating on a turntable', startFrame: '/tmp/product.png', duration: 5 },
    // FIRST-frame → LAST-frame interpolation. When the user gives two images and
    // says "start/first frame = image A, end/last frame = image B" (animate from
    // one photo to another), pass BOTH `startFrame` (A) and `endFrame` (B). The
    // model in-betweens from A to B. This is the literal request — do NOT drop the
    // frames and fall back to a text-only transition prompt.
    { intent: 'generate_video', prompt: 'Smooth cinematic transition from the closed car to its 3D exploded view', startFrame: '/tmp/car.png', endFrame: '/tmp/car-exploded.png', duration: 5 },
    { intent: 'generate_video', prompt: 'Animated character walking', referenceImages: ['/tmp/character.png'], withAudio: true },
    // Auto-routes to video_editing (kling-style v2v) because referenceVideos is present and no `kind` overrides it.
    { intent: 'generate_video', prompt: 'Apply cinematic grading and add slow motion', referenceVideos: ['/tmp/source.mp4'], duration: 5 },
    // Continuation example — opts out of editing so the picker stays in `video_generation` and seedance reference-to-video can win.
    { intent: 'generate_video', prompt: 'The astronaut now floats in zero-g inside the cabin, same character, same lighting style', referenceVideos: ['/tmp/previous-shot.mp4'], kind: 'continuation', duration: 5 },
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
    // Guard — see generate-image.js for rationale.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('generate_video', agent);
    if (_guard) return _guard;

    // ── Strip agent-supplied `model` ─────────────────────────────────
    // The auto-picker (pickVideoModel + the live catalog) is the SOLE
    // authority for model selection. Agents that pin a slug via
    // `action.model` bypass the picker and routinely land on a slug
    // whose adapter rejects the request shape (e.g. forcing
    // `fal-ai/wan/v2.7/image-to-video` for a text-only prompt with no
    // image input). Strip it loudly so the user sees the override
    // happen in the log and the agent eventually stops doing it.
    // `excludeModels` / `includeModels` / `label` remain the legit
    // levers for biasing the picker.
    if (action.model && action.model !== 'auto') {
      channel.log(
        'video',
        `Stripping agent-supplied model="${action.model}" — auto-picker drives selection. ` +
        `Use excludeModels / includeModels / label to bias instead.`,
      );
      action.model = undefined;
    }

    // ── Auto-correct misplaced image files in referenceVideos ────────
    // `referenceVideos` is for MP4/MOV/WebM/AVI/M4V URLs or paths.
    // Agents frequently confuse it with `referenceImages` / `startFrame`
    // and shove a PNG path there ("the GUI gave me a file, it's
    // referenceMedia, must be referenceVideos"). The downstream
    // adapter then fails with "image_url required" because the actual
    // image input is empty. Detect by extension and move:
    //   • If `startFrame` is empty → first misplaced file lands there.
    //   • Remaining (or all when startFrame is busy) → `referenceImages`.
    const _IMG_EXTS = new Set([
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tif', '.tiff',
    ]);
    const _isImagePath = (p) => {
      if (typeof p !== 'string' || p.length === 0) return false;
      const dot = p.lastIndexOf('.');
      if (dot < 0) return false;
      return _IMG_EXTS.has(p.slice(dot).toLowerCase());
    };
    if (Array.isArray(action.referenceVideos) && action.referenceVideos.length > 0) {
      const _keptVideos = [];
      const _misplaced = [];
      for (const entry of action.referenceVideos) {
        if (_isImagePath(entry)) _misplaced.push(entry);
        else _keptVideos.push(entry);
      }
      if (_misplaced.length > 0) {
        action.referenceVideos = _keptVideos;
        if (!action.startFrame) {
          action.startFrame = _misplaced.shift();
          channel.log(
            'video',
            `Auto-correct: moved 1 image file from referenceVideos → startFrame (${action.startFrame}).` +
            (_misplaced.length > 0 ? ` Remaining ${_misplaced.length} → referenceImages.` : ''),
          );
        }
        if (_misplaced.length > 0) {
          action.referenceImages = Array.isArray(action.referenceImages)
            ? [...action.referenceImages, ..._misplaced]
            : [..._misplaced];
          channel.log(
            'video',
            `Auto-correct: moved ${_misplaced.length} image file(s) from referenceVideos → referenceImages: ${_misplaced.join(', ')}`,
          );
        }
      }
    }

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

    // Per-slot aliases captured during the reference-resolution block
    // below; consumed by the prompt-build legend so the final prompt
    // tells the model "IMAGE 1 = <alias>" / "VIDEO 1 = <alias>" and
    // auto-annotates backtick-alias mentions with their slot index.
    // Hoisted here because both writers (inside the `{}` reconciliation
    // block) and readers (the prompt build hundreds of lines later)
    // need the same scope. Default to empty arrays so the legend
    // pass is a no-op when no aliases were provided.
    let _refImageAliases = [];
    let _refVideoAliases = [];

    // ── Auto-attach @mentions from the prompt ────────────────────────
    // The agent often writes prompts like
    //   "Continue the camera move from @hero_walk, matching @burrow_001"
    // and forgets to wire those handles into referenceVideos /
    // referenceImages. We resolve each @ in the prompt against the
    // gallery and merge in the matching rows BEFORE the model picker
    // peeks (so a video-kind handle correctly drives the picker
    // toward a v2v model). Image-kind handles wire into
    // referenceImages; video-kind ones wire into referenceVideos.
    //
    // Hallucinated handles (referenced in the prompt but missing
    // from the gallery) → fail fast. The model would otherwise
    // invent visuals for a non-existent reference.
    {
      const _refImgs = action.referenceImages || [];
      const _refVids = action.referenceVideos || [];
      const _imgRes = await autoAttachMentions({
        prompt,
        refs: _refImgs,
        mediaKind: 'image',
        maxRefs: caps.maxReferenceImages || (caps.referenceImages ? 4 : 0),
      });
      const _vidRes = await autoAttachMentions({
        prompt,
        refs: _refVids,
        mediaKind: 'video',
        maxRefs: caps.maxReferenceVideos || (caps.videoToVideo ? 2 : 0),
      });
      // Merge resolved (gallery) handles first so the post-attach
      // ref lists are current before we try positional reconciliation.
      if (_imgRes.added.length > 0) {
        channel.log('video', `Auto-attached image @mentions from prompt: ${_imgRes.added.join(', ')}`);
        action.referenceImages = _imgRes.merged;
      } else if (_imgRes.merged.length !== (action.referenceImages || []).length) {
        action.referenceImages = _imgRes.merged;
      }
      if (_vidRes.added.length > 0) {
        channel.log('video', `Auto-attached video @mentions from prompt: ${_vidRes.added.join(', ')}`);
        action.referenceVideos = _vidRes.merged;
      } else if (_vidRes.merged.length !== (action.referenceVideos || []).length) {
        action.referenceVideos = _vidRes.merged;
      }

      // Positional reconciliation: handles still unresolved in the
      // gallery are interpreted as the agent's chosen names for the
      // already-attached refs. We walk the unresolved list in prompt
      // order and bind each handle as an alias to the next unaliased
      // ref — images first, then videos. The downstream prompt-
      // aliasing pass picks the alias up and the model resolves
      // `@ref1` / `@whatever` correctly. Both worlds coexist: gallery
      // handles bring in NEW refs from the catalogue; positional
      // handles label EXISTING refs the agent already wired.
      const _trulyUnknown = _imgRes.unknown; // invariant across mediaKind
      let _leftover = _trulyUnknown;
      if (_leftover.length > 0) {
        const _imgFix = assignPositionalAliases(action.referenceImages || [], _leftover);
        if (_imgFix.assigned.length > 0) {
          action.referenceImages = _imgFix.merged;
          channel.log(
            'video',
            `Bound positional aliases to image refs: ${
              _imgFix.assigned.map((a) => `${a.handle}→${a.path}`).join(', ')
            }`,
          );
        }
        _leftover = _imgFix.leftover;
      }
      if (_leftover.length > 0) {
        const _vidFix = assignPositionalAliases(action.referenceVideos || [], _leftover);
        if (_vidFix.assigned.length > 0) {
          action.referenceVideos = _vidFix.merged;
          channel.log(
            'video',
            `Bound positional aliases to video refs: ${
              _vidFix.assigned.map((a) => `${a.handle}→${a.path}`).join(', ')
            }`,
          );
        }
        _leftover = _vidFix.leftover;
      }
      // Only what we couldn't bind — neither gallery hit nor
      // positional slot left — is treated as a true hallucination.
      if (_leftover.length > 0) {
        const available = await listAvailableMentions({ limit: 60 });
        const availableStr = (available && available.length)
          ? available.join(', ')
          : '(no @-handles tagged yet — use tag_media to assign one)';
        return {
          // Pre-flight lint: the agent built the prompt with handles that
          // don't bind to anything. Nothing was submitted to the provider
          // (no charge) and the agent is expected to silently re-issue, so
          // flag it as a validation failure — the banner middleware removes
          // the banner instead of flashing a red error mid-correction.
          success: false,
          validationError: true,
          error:
            `Prompt references @-handles that don't match any gallery item OR any attached reference slot: ${_leftover.join(', ')}.\n` +
            `Either remove them from the prompt, attach matching references in referenceImages/referenceVideos, or use one of the tagged handles: ${availableStr}`,
        };
      }
      // `assignPositionalAliases` may have wrapped some entries as
      // `{alias, path}` to carry a label for the prompt aliasing pass.
      // Every downstream call here (padIfNeeded, _loadFrame,
      // _loadReferenceImages, _uploadVideoRef) expects RAW string
      // paths, so unwrap before anything else touches these fields.
      // Without this `path.resolve(...)` throws ERR_INVALID_ARG_TYPE
      // the first time it sees an object — the user-reported crash
      // "TypeError: paths[0] must be of type string, received an
      // instance of Object" in `_loadReferenceImages`.
      //
      // BEFORE the unwrap, capture each ref's alias (when present) so
      // the prompt-build pass below can prepend an "IMAGE N = <alias>"
      // / "VIDEO N = <alias>" legend and auto-inject positional
      // annotations after backtick alias mentions. Without this, the
      // model receives a prompt that refers to `prev_clip` /
      // `sheet_part_2` / `ferrari_reference` but has no idea which
      // attached file each name binds to — exactly the reported bug
      // ("the prompt mentions `prev_clip` but never tells the model
      // it's the attached predecessor video"). Mirrors the legend
      // logic in generate-image.js so video calls get the same
      // alias↔slot binding the image side already has.
      const _toPathStr = (it) => {
        if (typeof it === 'string') return it;
        if (it && typeof it === 'object' && typeof it.path === 'string') {
          return it.path;
        }
        return null;
      };
      const _aliasOf = (it) =>
        (it && typeof it === 'object' && typeof it.alias === 'string' && it.alias)
          ? it.alias
          : '';
      _refImageAliases = Array.isArray(action.referenceImages)
        ? action.referenceImages.map(_aliasOf).filter((_, i, arr) => arr[i] !== null)
        : [];
      _refVideoAliases = Array.isArray(action.referenceVideos)
        ? action.referenceVideos.map(_aliasOf).filter((_, i, arr) => arr[i] !== null)
        : [];
      if (Array.isArray(action.referenceImages)) {
        action.referenceImages = action.referenceImages
          .map(_toPathStr)
          .filter((p) => typeof p === 'string' && p);
        // Align alias array length to the post-filter paths length —
        // dropped paths drop their aliases too (rare, but possible if
        // a path was unresolvable). We trim from the end since we
        // can't tell which got dropped; in practice the filter only
        // drops trailing entries when refs failed to resolve.
        if (_refImageAliases.length > action.referenceImages.length) {
          _refImageAliases = _refImageAliases.slice(0, action.referenceImages.length);
        }
      } else {
        _refImageAliases = [];
      }
      if (Array.isArray(action.referenceVideos)) {
        action.referenceVideos = action.referenceVideos
          .map(_toPathStr)
          .filter((p) => typeof p === 'string' && p);
        if (_refVideoAliases.length > action.referenceVideos.length) {
          _refVideoAliases = _refVideoAliases.slice(0, action.referenceVideos.length);
        }
      } else {
        _refVideoAliases = [];
      }
      if (action.startFrame != null && typeof action.startFrame !== 'string') {
        action.startFrame = _toPathStr(action.startFrame) || undefined;
      }
      if (action.endFrame != null && typeof action.endFrame !== 'string') {
        action.endFrame = _toPathStr(action.endFrame) || undefined;
      }
    }

    // ── Guard: prompt cites positional refs that aren't attached ─────
    // The positional convention (defined by this tool + the visual-storyboard
    // skills) is that the prompt body cites `Image 1`, `Image 2`, `Video 1` …
    // and the matching files ride in referenceImages / referenceVideos in that
    // order (position 1 = Image 1). When the agent writes those citations but
    // forgets to attach the files — the storyboard sheet, the character refs,
    // the previous clip for continuity — the model generates from TEXT ALONE:
    // no visual blueprint, no identity lock, no seam continuity, and the prompt
    // points at images that don't exist. (Reported: a storyboard→video clip
    // whose prompt said "Use Image 1 as the blueprint" but attached nothing.)
    // This matches a structural token the skill defines, not free-form intent —
    // so it's a lint, not NL classification. Fail fast and force a re-issue.
    {
      const _promptStr = typeof action.prompt === 'string' ? action.prompt : '';
      const _maxCited = (re) => {
        let m; let max = 0;
        while ((m = re.exec(_promptStr)) !== null) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
        return max;
      };
      const _imgCited = _maxCited(/\bimage\s+(\d+)\b/gi);
      const _vidCited = _maxCited(/\bvideo\s+(\d+)\b/gi);
      const _imgHave = Array.isArray(action.referenceImages) ? action.referenceImages.length : 0;
      const _vidHave = Array.isArray(action.referenceVideos) ? action.referenceVideos.length : 0;
      const _missing = [];
      if (_imgCited > _imgHave) _missing.push(`prompt cites "Image ${_imgCited}" but only ${_imgHave} reference image(s) are attached`);
      if (_vidCited > _vidHave) _missing.push(`prompt cites "Video ${_vidCited}" but only ${_vidHave} reference video(s) are attached`);
      if (_missing.length > 0) {
        return {
          // Pre-flight lint (no provider call, no charge): the prompt cites
          // positional refs that aren't attached. The agent re-issues with
          // the slots populated, so this is a validation failure — the
          // banner middleware silently removes the banner rather than
          // flashing red while the agent corrects itself.
          success: false,
          validationError: true,
          error:
            `generate_video did NOT run — ${_missing.join('; ')}. ` +
            `Your prompt cites positional references (Image N / Video N) but the matching files were not attached, so the model would have nothing to follow (no storyboard blueprint, no character identity, no previous-clip continuity). ` +
            `Re-issue with the references populated IN ORDER. For a storyboard clip: referenceImages = [ the sheet itself (→ Image 1), then any prior PART sheets, then character/product/location refs ]; for clip K≥2 also pass the previous clip in referenceVideos (→ Video 1). The Image N / Video N citations in your prompt must each map to an attached file.`,
        };
      }
    }

    // ── Pad-if-too-small for provider input minimums ─────────────────
    // The user's reference inputs may come from the GUI's clip cropper
    // honouring an arbitrary canvas rect — sometimes well under the
    // provider's accepted dimensions (e.g. Kling rejects <720 height).
    // We pad the primary input with solid black to reach the envelope,
    // BIT-FOR-BIT preserving the original pixels, then crop the borders
    // off the model's output post-generation. The whole dance is
    // INTERNAL to this tool — agents and the GUI never see padded media.
    //
    // ── Padding pipeline (deferred until we know the actual model) ──
    // The router-level "auto" caps don't tell us which specific model
    // will run the call — Kling video edit, Veo, Seedance and friends
    // each have their own published `resolutions` list, and padding
    // against the broad fallback (which advertises every resolution any
    // active model has ever supported) lets us pick a candidate the
    // chosen model actually rejects. Wait until the gateway's local
    // router has resolved the slug, look up THAT model's caps in the
    // catalog, and only then decide the pad envelope.
    //
    // We drive the resolution by peeking at the resolver: for video-to-
    // video the agent already has `referenceVideos` set and the resolver
    // takes that into account, so the pick is stable across the peek
    // and the actual generate() call.
    let envelope = null;
    let recoveryGeometry = null;
    let paddedRefVideos = action.referenceVideos;
    let paddedStartFrame = action.startFrame;
    let pickedModelSlug = null;
    let pickedCaps = null;

    if (typeof instance.peekResolvedModel === 'function') {
      // Build the same opts the resolver will see, so the pick is the
      // one the actual generate() will land on. We don't have the
      // loaded frame `data` blobs yet, so signal start/end frame
      // PRESENCE via dummy `.data` truthy values — that's all the
      // router checks. (For `referenceVideos`/`referenceImages` it
      // counts the array length, so passing the raw paths is fine.)
      try {
        const peek = await instance.peekResolvedModel({
          aspectRatio: action.aspectRatio,
          resolution: action.resolution,
          startFrame: action.startFrame ? { data: '_peek' } : undefined,
          endFrame: action.endFrame ? { data: '_peek' } : undefined,
          referenceImages: action.referenceImages,
          referenceVideos: action.referenceVideos,
          withAudio: action.withAudio !== false,
          shots: action.shots,
          label: action.label,
          excludeModels: action.excludeModels,
          includeModels: action.includeModels,
          preferQuality: action.preferQuality !== false,
          kind: action.kind,
        });
        pickedModelSlug = peek?.slug || null;
        pickedCaps = peek?.caps || null;
        if (pickedModelSlug) {
          channel.log('pad', `resolver picked model: ${pickedModelSlug}`);
        }
        if (pickedCaps) {
          // Defensive `.join`: malformed catalog rows have shipped
          // these as strings instead of arrays (Veo3.1/extend-video
          // observed: `aspectRatios: '16:9'`), which crashes the log
          // line and short-circuits the rest of the peek flow. Wrap
          // anything non-array in `[…]` so the log just shows the raw
          // value verbatim instead of throwing.
          const _fmtList = (v) =>
            Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
          channel.log(
            'pad',
            `picked-model caps: resolutions=[${_fmtList(pickedCaps.resolutions)}] `
            + `aspectRatios=[${_fmtList(pickedCaps.aspectRatios)}] `
            + `durations=[${_fmtList(pickedCaps.durations)}]`,
          );

          // Pick the envelope + pad. ONLY uses the resolutions /
          // aspectRatios the picked model actually accepts.
          const probeTarget =
            (Array.isArray(action.referenceVideos) && action.referenceVideos.length > 0)
              ? { path: action.referenceVideos[0], kind: 'video' }
              : (action.startFrame
                  ? { path: action.startFrame, kind: 'image' }
                  : null);

          if (probeTarget) {
            const refDims = await _probeRefDims(probeTarget.path);
            if (refDims) {
              envelope = pickEnvelopeResolution({
                contentWidth: refDims.width,
                contentHeight: refDims.height,
                resolutions: pickedCaps.resolutions,
                aspectRatios: pickedCaps.aspectRatios,
              });
              if (envelope) {
                channel.log(
                  'pad',
                  `envelope: source ${refDims.width}×${refDims.height} → ${envelope.resolution}+${envelope.aspectRatio} = ${envelope.w}×${envelope.h}`,
                );
                action.resolution = envelope.resolution;
                action.aspectRatio = envelope.aspectRatio;
              }
            }
          }
        }
      } catch (err) {
        channel.log('pad', `peekResolvedModel failed (continuing without padding): ${err.message}`);
      }
    }

    // Decide the pad envelope. Two paths:
    //   1. Caps-driven: `pickEnvelopeResolution` chose a resolution +
    //      aspect from the model's catalog row that envelopes the
    //      source. Use those dims AND align action.resolution/aspect
    //      to them (already done above).
    //   2. Caps-empty: the catalog row arrived under-populated
    //      (`resolutions=[] aspectRatios=[]` — observed for the Kling
    //      video-to-video edit row). The agent still set
    //      action.aspectRatio + action.resolution from the GUI's
    //      request. Pad the input to EXACTLY that output canvas
    //      (`targetDimsForResolutionAspect`). Without this we'd fall
    //      to the legacy `minSide=1080` square envelope (1080×1080,
    //      1:1) and ask the model for a 1280×720 (16:9) output —
    //      input/output dim mismatch breaks the recovery crop entirely.
    let padTargetDims = null;
    if (envelope) {
      padTargetDims = { w: envelope.w, h: envelope.h };
    } else {
      // The agent doesn't always emit explicit `resolution` /
      // `aspectRatio` — line 552 below applies `'720p'` / `'16:9'`
      // defaults at the LATER `globalAspect` / `globalResolution`
      // step. We need those same defaults HERE so we pad to whatever
      // canvas the model will be asked to emit; otherwise (when the
      // agent leaves them unset and we don't apply defaults), this
      // branch falls through and `padIfNeeded` lands on the legacy
      // `minSide=1080` square envelope while the model gets asked
      // for 720p+16:9 — input/output dim mismatch the recovery
      // crop can't realign. Apply the same defaults eagerly.
      const padRes = action.resolution || '720p';
      const padAsp = action.aspectRatio || '16:9';
      const dims = targetDimsForResolutionAspect(padRes, padAsp);
      if (dims) {
        padTargetDims = dims;
        // Mirror the defaults onto `action` so the model is asked for
        // the SAME canvas we padded to (the later `globalAspect` /
        // `globalResolution` step would also do this, but pinning
        // them now makes the relationship explicit and removes any
        // chance of drift if that fallback evolves separately).
        action.resolution = padRes;
        action.aspectRatio = padAsp;
        channel.log(
          'pad',
          `caps lacked resolutions/aspectRatios — padding to requested ${padRes}+${padAsp} = ${dims.w}×${dims.h}`,
        );
      }
    }
    const padOpts = padTargetDims
      ? { targetDims: padTargetDims }
      : {};
    // Some video-to-video providers reject inputs below a hard duration
    // floor (Kling video edit observed: 3.0 s minimum). Resolution
    // order:
    //   1. Explicit `caps.minInputDurationSec` from the catalog row.
    //   2. `caps.durations[0]` — smallest output length the model
    //      offers, which in practice tracks its input floor.
    //   3. Conservative 3 s fallback when the model is video-to-video
    //      and the catalog row is missing duration data (we've
    //      observed Kling's edit row arrive with `resolutions=[]
    //      aspectRatios=[]` — clearly under-populated upstream).
    //      Every video-to-video provider in the catalog requires
    //      ≥3 s, so this is safe and explicit rather than guessing.
    // When the cropper produced something shorter (e.g. 2.958 s),
    // `padIfNeeded` extends with a black tail; recovery trims it
    // back to the original duration so the user never sees the
    // filler. Same pattern as the spatial pad → submit → recover.
    let minDurSec = null;
    let minDurSource = null;
    if (pickedCaps) {
      if (Number.isFinite(pickedCaps.minInputDurationSec) && pickedCaps.minInputDurationSec > 0) {
        minDurSec = pickedCaps.minInputDurationSec;
        minDurSource = 'caps.minInputDurationSec';
      } else if (Array.isArray(pickedCaps.durations) && pickedCaps.durations.length > 0) {
        minDurSec = pickedCaps.durations[0];
        minDurSource = 'caps.durations[0]';
      } else if (pickedCaps.videoToVideo) {
        minDurSec = 3;
        minDurSource = 'video-to-video catalog-row-empty fallback';
      }
    }
    if (Number.isFinite(minDurSec) && minDurSec > 0) {
      padOpts.minDurationMs = minDurSec * 1000;
      channel.log('pad', `min input duration floor: ${minDurSec}s (${minDurSource})`);
    }
    // Project frame rate plumbed from the GUI's `selectedClipMeta`.
    // Forwarded to padIfNeeded → recoverFromPadded so both the input
    // we send the model AND the recovered output lock to the same
    // fps grid as V1 on the timeline. Eliminates the AI-clip ↔ V1
    // frame phase drift the user reported as "1-2 frames adelantado".
    const projectFps = Number(action.projectFps);
    if (Number.isFinite(projectFps) && projectFps > 0) {
      padOpts.outputFps = projectFps;
      channel.log('pad', `project fps: ${projectFps} (forced through pad/recover)`);
    }

    if (caps.videoToVideo && Array.isArray(action.referenceVideos) && action.referenceVideos.length > 0) {
      const padded = [];
      for (let i = 0; i < action.referenceVideos.length; i++) {
        const rv = action.referenceVideos[i];
        const r = await padIfNeeded(rv, 'video', padOpts);
        if (i === 0 && r.geometry?.needsPadding) {
          recoveryGeometry = { ...r.geometry, kind: 'video' };
        }
        if (!r.paddedPath && r.geometry?.needsPadding) {
          // Pad was requested but ffmpeg failed. Falling back to the
          // un-padded source — the model will get a smaller canvas
          // than its expected envelope and may reject the request
          // outright (or pad it server-side with whatever defaults
          // it uses, drifting the output dims off our recovery
          // crop). Make this explicit in the log so a downstream
          // failure traces back here instead of looking like a
          // mystery 504 / dimension mismatch.
          channel.log(
            'pad',
            `pad failed for ref video #${i} — uploading ORIGINAL ` +
            `(${r.geometry.contentW}×${r.geometry.contentH}) ` +
            `instead of the requested ${r.geometry.paddedW}×${r.geometry.paddedH} envelope. ` +
            `Downstream model may reject the size — see the ffmpeg ` +
            `stderr block above for the underlying cause.`,
          );
        }
        padded.push(r.paddedPath || rv);
      }
      paddedRefVideos = padded;
    }

    if (!recoveryGeometry && caps.startFrame && action.startFrame) {
      const r = await padIfNeeded(action.startFrame, 'image', padOpts);
      if (r.geometry?.needsPadding) {
        recoveryGeometry = { ...r.geometry, kind: 'video' /* output is still a video */ };
      }
      if (r.paddedPath) paddedStartFrame = r.paddedPath;
    }

    // ── Top-level (global) resolution — used directly for single-shot,
    //    and as fallback defaults for each entry in shots[] ──────────
    let globalStartFrame = await _loadFrame(paddedStartFrame, caps.startFrame, resolved, 'start');
    if (globalStartFrame?._error) return { success: false, error: globalStartFrame._error };

    let globalEndFrame = await _loadFrame(action.endFrame, caps.endFrame, resolved, 'end');
    if (globalEndFrame?._error) return { success: false, error: globalEndFrame._error };

    let globalReferenceImages = await _loadReferenceImages(action.referenceImages, caps, resolved);
    if (globalReferenceImages?._error) return { success: false, error: globalReferenceImages._error };

    // Per-model INPUT restrictions for image-typed frames. The router
    // already resolved `pickedModelSlug` above; look up the full
    // catalog row to read `constraints.inputs.{startFrame|endFrame|
    // referenceImages}` and shrink any oversized buffer BEFORE
    // dispatch. Same pattern as `generate-avatar-video.js` (which
    // adapts `imageUrl`) and `generate-image.js` (which adapts
    // `referenceImages`). No-op when the adapter declares nothing.
    let pickedVideoModelObj = null;
    if (pickedModelSlug) {
      try {
        const mediaCaps = await fetchMediaCapabilities('video');
        if (mediaCaps && Array.isArray(mediaCaps.models)) {
          pickedVideoModelObj = mediaCaps.models.find((m) => m && m.slug === pickedModelSlug) || null;
        }
      } catch { /* peek failed → no restriction → ship originals */ }
    }
    globalStartFrame      = await _adaptFrameToConstraints(globalStartFrame, pickedVideoModelObj, 'startFrame');
    globalEndFrame        = await _adaptFrameToConstraints(globalEndFrame, pickedVideoModelObj, 'endFrame');
    globalReferenceImages = await _adaptFramesToConstraints(globalReferenceImages, pickedVideoModelObj, 'referenceImages');

    // Videos are uploaded (not inlined) — see _uploadVideoRef above.
    // Padded variants flow through transparently.
    const globalReferenceVideos = await _resolveReferenceVideos(paddedRefVideos, caps, resolved);

    // Audio is ON by default — a generated video keeps its scene sound (SFX,
    // dialogue, voiceover, ambient) unless the caller EXPLICITLY opts out with
    // withAudio:false. Agents kept shipping silent clips by omitting the flag
    // (old default was false) or by setting false to "exclude music" — but
    // withAudio governs the whole audio track, not music. Music exclusion is a
    // prompt concern; silence is opt-in only.
    const withAudio = action.withAudio !== false;
    if (withAudio && !caps.withAudio) {
      channel.log('video', `Provider ${resolved.provider}/${resolved.model} does not support audio generation — ignoring withAudio`);
    }

    let globalDuration = action.duration || 5;
    const requestedDurationSec = globalDuration;
    // Duration clamp UP — same dance as spatial padding but on the
    // time axis. When the agent asks for a duration BELOW the picked
    // model's minimum supported length (e.g. clip is 5 s but the
    // chosen model only emits 7 s outputs), bump the submission to
    // the minimum the model accepts. Per user spec: "ampliaremos
    // internamente a 7 segundos en la tool y devolveremos el clip
    // completo". The output is returned in full — NOT trimmed back
    // to the agent's request — so the caller (timeline / gallery)
    // gets all the generated content and can decide what to do with
    // the extra tail.
    let durationClampedUp = false;
    if (pickedCaps) {
      // Catalog rows can ship `durations` as numbers, strings ("7s"),
      // or — for legacy rows — a single string. Normalise to a sorted
      // numeric list, then take the smallest as the model's minimum.
      // Also honour an explicit `minDurationSec` if the row exposes it.
      const _toNum = (v) => {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
        if (typeof v === 'string') {
          const m = v.match(/^(\d+(?:\.\d+)?)/);
          if (m) {
            const parsed = parseFloat(m[1]);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
          }
        }
        return null;
      };
      let minSupported = null;
      if (Number.isFinite(pickedCaps.minDurationSec) && pickedCaps.minDurationSec > 0) {
        minSupported = pickedCaps.minDurationSec;
      } else {
        const raw = pickedCaps.durations;
        const list = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
        const nums = list.map(_toNum).filter((n) => n != null).sort((a, b) => a - b);
        if (nums.length > 0) minSupported = nums[0];
      }
      if (minSupported != null && globalDuration < minSupported) {
        channel.log(
          'video',
          `duration clamp: requested ${globalDuration}s < model minimum ${minSupported}s — `
          + `submitting at ${minSupported}s; output returned in full (not trimmed back).`,
        );
        globalDuration = minSupported;
        durationClampedUp = true;
      }
    }
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
          // Pre-flight lint (no charge): too many shots for this model. The
          // agent re-issues with fewer shots, so treat as a validation
          // failure (banner removed, no red flash).
          success: false,
          validationError: true,
          error: `Model ${resolved.model} supports at most ${maxShots} shots per call; got ${action.shots.length}.`,
        };
      } else {
        shots = [];
        for (let i = 0; i < action.shots.length; i++) {
          const s = action.shots[i] || {};
          // Frame/ref resolution per shot, with inheritance. Any missing
          // override reuses the top-level artifact we already loaded so
          // we don't re-read the same file N times.
          // Per-shot loads run through the same constraint-adapt pass
          // as the globals above. When the shot inherits a global,
          // it's already adapted; only freshly-loaded override buffers
          // need the extra call.
          let shotStart = s.startFrame
            ? await _loadFrame(s.startFrame, caps.startFrame, resolved, `shot[${i}].start`)
            : globalStartFrame;
          if (shotStart?._error) return { success: false, error: shotStart._error };
          if (s.startFrame) shotStart = await _adaptFrameToConstraints(shotStart, pickedVideoModelObj, 'startFrame');

          let shotEnd = s.endFrame
            ? await _loadFrame(s.endFrame, caps.endFrame, resolved, `shot[${i}].end`)
            : globalEndFrame;
          if (shotEnd?._error) return { success: false, error: shotEnd._error };
          if (s.endFrame) shotEnd = await _adaptFrameToConstraints(shotEnd, pickedVideoModelObj, 'endFrame');

          let shotRefImgs = Array.isArray(s.referenceImages)
            ? await _loadReferenceImages(s.referenceImages, caps, resolved)
            : globalReferenceImages;
          if (shotRefImgs?._error) return { success: false, error: shotRefImgs._error };
          if (Array.isArray(s.referenceImages)) {
            shotRefImgs = await _adaptFramesToConstraints(shotRefImgs, pickedVideoModelObj, 'referenceImages');
          }

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
    const refImagesCount = Array.isArray(globalReferenceImages)
      ? globalReferenceImages.length
      : 0;
    // What the AGENT actually passed in `action.referenceImages` —
    // independent from `globalReferenceImages` (which may have been
    // dropped by `_loadReferenceImages` if the picked model doesn't
    // support reference images, or if the file was missing on disk).
    // Surface both counts so the symptom "user attached image, log
    // shows nothing" gets a clear cause: tool-level drop vs.
    // agent-level drop.
    const actionRefImagesCount = Array.isArray(action.referenceImages)
      ? action.referenceImages.length
      : 0;
    channel.log(
      'video',
      `generate_video: ${resolved.provider}/${resolved.model}, prompt="${prompt.substring(0, 150)}...", ` +
      `duration=${globalDuration}s, aspectRatio=${globalAspect}, resolution=${globalResolution}, ` +
      `quality=${globalQuality}` +
      (refFrame ? `, startFrame=${refFrame}` : '') +
      (refVideosCount ? `, refVideos=${refVideosCount}` : '') +
      // Always print refImages — both the action's request and what
      // actually reached the provider — so a silent drop is visible.
      `, refImages=${refImagesCount}/${actionRefImagesCount}` +
      (globalCamera ? `, camera=${globalCamera}` : '') +
      (shots ? `, shots=${shots.length}(explicit)` : (numShots ? `, shots=${numShots}` : '')) +
      `, saveTo=${action.saveTo || 'default'}`,
    );

    // Forward the agent's `label` selector down to the gateway so the
    // client-side router can apply it as a model-variant filter (e.g.
    // "storyboard-to-video" or "motion-transfer" route to specific
    // models tuned for those workloads). Without this, the agent's
    // label was silently dropped here and the router fell through to
    // the "no label requested" branch, which pins to non-labelled
    // models — picking the cheapest generic instead of the specialised
    // variant the agent explicitly asked for.
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

    // If any reference image or start frame is a user-annotation overlay
    // (composite-snapshot baked by the GUI on every annotation submit —
    // filename convention `braxil-annotation-*.png`, see media-library.js)
    // the underlying video model sees the drawn marks as literal pixels and
    // burns them into every output frame. Prepend an explicit disclaimer so
    // the model treats arrows/circles/scribbles as intent, not content.
    const _isAnnotationPath = (p) =>
      typeof p === 'string' && /(^|[\\/])braxil-annotation-/.test(p);
    const _annotationPaths = [
      action.startFrame,
      ...(Array.isArray(action.referenceImages) ? action.referenceImages : []),
      ...((Array.isArray(action.shots) ? action.shots : []).flatMap((s) => [
        s?.startFrame,
        ...(Array.isArray(s?.referenceImages) ? s.referenceImages : []),
      ])),
    ].filter(_isAnnotationPath);
    // Step 1 — annotation disclaimer (if any user-drawn markup is in the inputs).
    let _bodyPrompt = _annotationPaths.length > 0
      ? `[ANNOTATION CONTEXT: One or more reference images contain user-drawn markup (red arrows, circles, lines, scribbles, handwritten notes) placed on top of the source image as guidance. These marks indicate intent — motion paths, areas of focus, things to add/move/remove — they are NOT content. DO NOT reproduce the arrows, circles, lines, or any drawn markup in the generated video; they must not appear in the output frames. Interpret what they mean and apply that intent instead.]\n\n${prompt}`
      : prompt;
    if (_annotationPaths.length > 0) {
      channel.log('video', `Annotation overlay detected in inputs (${_annotationPaths.length}) — prepended disclaimer to prompt.`);
    }

    // Step 2 — reference legend + alias→slot auto-annotation. Mirrors
    // the logic in generate-image.js so video prompts that mention
    // `sheet_part_1` / `prev_clip` / `ferrari_reference` etc. have a
    // legend at the top binding each alias to its actual slot. Without
    // this, the model sees the alias as a literal string with no clue
    // which attached file it refers to — the reported bug ("agent
    // attached a predecessor video and the prompt mentions `prev_clip`
    // but never tells the model it's the attached video"). The auto-
    // annotation then appends `(IMAGE N)` / `(VIDEO N)` after every
    // backtick alias mention in the body so even weak-instruction-
    // following models pick up the positional slot.
    const _hasImageAliases = _refImageAliases.some((a) => a && a.length > 0);
    const _hasVideoAliases = _refVideoAliases.some((a) => a && a.length > 0);
    if (_hasImageAliases || _hasVideoAliases) {
      const _legendBlocks = [];
      if (_hasImageAliases) {
        const _imgLines = _refImageAliases.map((alias, i) => {
          const n = i + 1;
          return alias ? `  • IMAGE ${n} = "${alias}"` : `  • IMAGE ${n} = (unnamed)`;
        });
        _legendBlocks.push(`Reference images (by position):\n${_imgLines.join('\n')}`);
      }
      if (_hasVideoAliases) {
        const _vidLines = _refVideoAliases.map((alias, i) => {
          const n = i + 1;
          return alias ? `  • VIDEO ${n} = "${alias}"` : `  • VIDEO ${n} = (unnamed)`;
        });
        _legendBlocks.push(`Reference videos (by position):\n${_vidLines.join('\n')}`);
      }
      // Build alias → "(IMAGE N)" / "(VIDEO N)" maps for the body
      // annotation pass. Same alias never collides across image/video
      // slots in practice — the agent picks distinct names — and even
      // if they did, the model would see two equally-positioned
      // annotations on the same alias and treat them as a synonym set.
      const _aliasToTag = new Map();
      for (let i = 0; i < _refImageAliases.length; i++) {
        const a = _refImageAliases[i];
        if (a && a.length > 0) _aliasToTag.set(a, `IMAGE ${i + 1}`);
      }
      for (let i = 0; i < _refVideoAliases.length; i++) {
        const a = _refVideoAliases[i];
        if (a && a.length > 0 && !_aliasToTag.has(a)) {
          _aliasToTag.set(a, `VIDEO ${i + 1}`);
        }
      }
      // Sort longest first so `sheet_part_10` isn't partially matched
      // by `sheet_part_1`.
      const _aliases = [..._aliasToTag.keys()].sort((a, b) => b.length - a.length);
      for (const alias of _aliases) {
        const tag = _aliasToTag.get(alias);
        const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Strip any pre-existing positional annotation the agent
        // hand-typed (`(IMAGE N)` / `(VIDEO N)` / `(reference #N)`)
        // — the agent's count is unreliable; the runtime owns the
        // authoritative number.
        const stripRe = new RegExp(
          '`' + esc + '`\\s*\\((?:IMAGE\\s*|VIDEO\\s*|reference\\s*#\\s*)\\d+\\s*\\)',
          'g',
        );
        _bodyPrompt = _bodyPrompt.replace(stripRe, '`' + alias + '`');
        // Append correct (IMAGE N) / (VIDEO N) annotation.
        const annotateRe = new RegExp('`' + esc + '`', 'g');
        _bodyPrompt = _bodyPrompt.replace(annotateRe, '`' + alias + '` (' + tag + ')');
      }
      _bodyPrompt =
        `${_legendBlocks.join('\n\n')}\n\n` +
        `When the prompt below references "IMAGE N" or "VIDEO N", it points to the reference at that position above. The "(IMAGE N)" / "(VIDEO N)" annotations the runtime added next to any backtick alias are authoritative — trust them over any number the prompt's author may have written.\n\n` +
        _bodyPrompt;
      channel.log(
        'video',
        `Reference aliases: ${[
          ..._refImageAliases.map((a, i) => `img${i + 1}=${a || '-'}`),
          ..._refVideoAliases.map((a, i) => `vid${i + 1}=${a || '-'}`),
        ].join(', ')}`,
      );
    }

    const finalPrompt = _bodyPrompt;

    // Cost consent is handled UP FRONT by the media banner wrapper
    // (action-registry.js → preflightMediaCost), before the banner and any
    // request — so by this point the user has already approved.

    reportProgress?.(0.02, 'Submitting to provider…');
    const submitted = await instance.generate(finalPrompt, {
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
      // Stored so a crash-recovery resume in pending-jobs-watcher can
      // tell whether it needs to re-run the extend reconcile (concat
      // source + slice) before assigning the result to the clip.
      // Without this, the watcher would happily overwrite the source
      // with the slice-only output.
      kind: action.kind || null,
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
      // Forwarded to MediaLibrary.save({summary}) → per-session ledger.
      // The same generationParams object is reused for the primary
      // save AND each multishot saveGeneratedVideo call below, so the
      // summary lands on every produced clip without per-call wiring.
      summary: typeof action.summary === 'string' ? action.summary : undefined,
    };

    if (submitted.id) _stashJobMetadata(submitted.id, generationParams);

    // ── Persist the job to disk so it survives an engine crash ──────
    // recordJob writes `~/.koi/pending-jobs/<jobId>.json`. The
    // pending-jobs-watcher singleton (booted at engine startup) scans
    // that dir on launch and resumes any job whose poller died — fal
    // already has the result server-side, we just need somewhere to
    // catch it. acquireLock is best-effort: if a watcher in some
    // other engine already owns this job, we still proceed to poll
    // (the lock is for the WATCHER's benefit, not the original
    // submitter's). The poll's onTick callback below heartbeats the
    // lock + mirrors the latest fal status to disk so the watcher
    // can see this poller is alive and where the job stands.
    let _persistedJob = null;
    if (submitted.id) {
      const { recordJob: _recordJob, acquireLock: _acquireLock } = await import('../../state/pending-jobs.js');
      try {
        _persistedJob = _recordJob({
          jobId: submitted.id,
          kind: 'video',
          slug: submitted.model || resolved.model,
          provider: resolved.provider,
          prompt,
          params: generationParams,
          savePath: action.saveTo || null,
          clipContext: (action.assignToClip && action.assignToClip.timelineId && action.assignToClip.clipId)
            ? {
                timelineId: action.assignToClip.timelineId,
                clipId: action.assignToClip.clipId,
                placeholderPath: action.assignToClip.placeholderPath || null,
              }
            : null,
          status: submitted.status || 'submitted',
        });
        _acquireLock(submitted.id, process.pid);
      } catch (err) {
        // Persistence is a safety net; never fail the actual generation
        // just because we couldn't write the recovery file.
        channel.log('video', `pending-jobs: recordJob failed (${err.message}) — continuing without disk recovery`);
      }
    }

    // Heartbeat / status-mirror callback for the poll loop. Three jobs:
    //   1. Refresh the disk-state lock (so a recovery watcher in
    //      another engine sees we're alive and doesn't try to steal).
    //   2. Mirror the latest fal status into the job file (so a
    //      watcher inheriting the job knows the last known state).
    //   3. Emit a `clipMediaGenerating` ws event to the GUI so the
    //      per-clip orphan watchdog (5 min ceiling) re-arms instead
    //      of dropping the stripes overlay on a long but legitimate
    //      generation (Veo 3.1 with refs, Kling 1080p, etc.).
    let _onPollTick = null;
    const _emitBannerStatus = typeof action._emitMediaStatus === 'function'
      ? action._emitMediaStatus
      : null;
    if ((_persistedJob && submitted.id) || _emitBannerStatus) {
      const { updateJob: _updateJob, refreshLock: _refreshLock } = await import('../../state/pending-jobs.js');
      _onPollTick = (latest) => {
        if (_persistedJob && submitted.id) {
          try {
            _refreshLock(submitted.id, process.pid);
            _updateJob(submitted.id, {
              lastSeenStatus: latest?.status || 'unknown',
              lastPolledAt: new Date().toISOString(),
            });
          } catch { /* observability is best-effort */ }
          // GUI heartbeat — only meaningful when this job was kicked
          // off from a timeline placeholder (clipContext present).
          try {
            if (_persistedJob.clipContext?.clipId) {
              channel.clipMediaGenerating({
                clipId: _persistedJob.clipContext.clipId,
                status: latest?.status || 'pending',
              });
            }
          } catch { /* non-fatal */ }
        }
        // Fal-status passthrough to the chat banner. The runtime normalizes
        // fal's IN_QUEUE/IN_PROGRESS to 'pending'/'processing'; map back so
        // the GUI sees the original fal vocabulary it already understands.
        if (_emitBannerStatus) {
          const falStatus = latest?.status === 'pending' ? 'IN_QUEUE'
            : latest?.status === 'processing' ? 'IN_PROGRESS'
            : null;
          if (falStatus) {
            _emitBannerStatus({
              falStatus,
              queuePosition: typeof latest?.queuePosition === 'number'
                ? latest.queuePosition
                : undefined,
            });
          }
        }
      };
    }

    // Poll the provider until the job reaches a terminal state. Sync
    // providers return `status === 'completed'` straight away and the
    // loop exits immediately on the first iteration.
    const final = await _pollUntilTerminal(instance, submitted, {
      abortSignal,
      reportProgress,
      onTick: _onPollTick,
      timeoutMs: _resolveTimeoutMs(action),
      pollIntervalMs: typeof action.pollIntervalMs === 'number' && action.pollIntervalMs > 0
        ? action.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS,
    });

    if (final.status === 'failed') {
      if (submitted.id) {
        clearJobMetadata(submitted.id);
        try {
          const { markFailed: _markFailed } = await import('../../state/pending-jobs.js');
          _markFailed(submitted.id, final.error || 'Provider reported failure with no error message.');
        } catch { /* non-fatal */ }
      }
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
      //
      // IMPORTANT: do NOT mark the persisted job as completed/failed
      // here — the job is still in-flight on fal. Release our lock so
      // the recovery watcher can pick it up on the next scan (or the
      // next engine startup) and complete it when fal terminates.
      if (submitted.id && _persistedJob) {
        try {
          const { releaseLock: _releaseLock } = await import('../../state/pending-jobs.js');
          _releaseLock(submitted.id, process.pid);
        } catch { /* non-fatal */ }
      }
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
    let chainedExtend = false;
    if (final.url) {
      reportProgress?.(0.95, 'Downloading video…');
      const saveResult = await saveVideoFromUrl(final.url, {
        saveTo: action.saveTo,
        provider: resolved.provider,
        model: resolved.model,
        id: final.id,
        // Pass the user's prompt so the saved file name describes the
        // content (`mouse-with-cheese-mh4n5p_0.mp4`) instead of being
        // an opaque timestamp.
        prompt: action.prompt,
      });
      savedTo = saveResult.path;
      saveError = saveResult.error;
      // Strip the black borders we padded on at submit time (transparent
      // to the agent — only fires when an input was actually padded). The
      // model's output preserves the input envelope (diffusion video
      // models anchor output dims to the dominant input), so cropping at
      // the recorded content rect yields the original-sized media.
      if (savedTo && recoveryGeometry?.needsPadding) {
        try {
          const recovered = await recoverFromPadded(savedTo, recoveryGeometry, 'video');
          if (recovered && recovered !== savedTo) {
            savedTo = recovered;
          }
        } catch (err) {
          channel.log('video', `recoverFromPadded failed (keeping padded): ${err.message}`);
        }
      }
      // Always strip the mov edit list from the final video. libx264
      // (used by recovery AND by some providers' encoders) stamps an
      // `edts/elst` atom that tells AVFoundation to skip the first
      // 1-2 samples, so the AI clip plays 1-2 frames ahead of the
      // linked source on the timeline — the user-reported "1/15s
      // adelantado". Done as a separate re-mux pass (no re-encode)
      // so this runs independently of whether recovery fired.
      if (savedTo) {
        try {
          const stripped = await stripVideoEditList(savedTo);
          if (stripped && stripped !== savedTo) {
            savedTo = stripped;
          }
        } catch (err) {
          channel.log('video', `stripVideoEditList failed (keeping with edts): ${err.message}`);
        }
      }

      // ── Pure-extend reconciliation: unify adapter return shapes ────
      // Different extend providers return DIFFERENT slices of the
      // timeline given the same `kind:'extend'` + `duration` request:
      //
      //   * Veo3.1 extend, Kling extend → return the FULL concatenated
      //     video (source + new tail). For these, `duration` means
      //     "add this much beyond the source" and the output length
      //     is roughly `source + duration`.
      //   * Seedance reference-to-video → returns ONLY the new tail
      //     (`duration` seconds of new content). The output length is
      //     roughly `duration` (NOT source + duration).
      //
      // Caller contract: the saved file is ALWAYS the full
      // source-plus-extension video, so the GUI/agent never has to
      // know which adapter ran. To honour that we probe both durations
      // and decide by closeness:
      //
      //   expected_full  = source_duration + requested_extension
      //   expected_slice = requested_extension
      //
      // Whichever the output duration is closer to wins. Previous
      // heuristic compared `output < source - 0.5s` to detect slice,
      // which misfired when the requested extension matched the
      // source length (Seedance returned an N-second slice when the
      // source happened to also be N seconds; `output < source - 0.5`
      // was false, the tool assumed full, no concat, GUI showed the
      // clip's AI-extend zone still missing the new frames — exactly
      // the user-reported "no ha hecho nada" failure).
      const _isPureExtend =
        action.kind === 'extend' &&
        Array.isArray(action.referenceVideos) &&
        action.referenceVideos.length > 0 &&
        action.referenceVideos[0];
      if (savedTo && _isPureExtend) {
        const _reconciled = await _reconcileExtendOutput({
          outputPath: savedTo,
          sourcePath: action.referenceVideos[0],
          requestedExtensionSec: action.duration,
          modelSlug: resolved.model,
        });
        if (_reconciled.error) {
          return {
            success: false,
            provider: resolved.provider,
            model: resolved.model,
            id: final.id || submitted.id,
            status: 'failed',
            error: _reconciled.error,
          };
        }
        savedTo = _reconciled.path;
      }

      // ── Hybrid chain (Case 3): edit → extend → concat ────────────
      // The GUI sets `extendAfterMs > 0` when the AI clip's range
      // overlaps the linked source's range AND extends past its end:
      // we ran the EDIT just above, now extend that edit's output by
      // `extendAfterMs` ms with the same prompt, then concatenate
      // both into a single output. Only the concat lands in the
      // gallery / presents to the GUI — the intermediate edit and
      // extend files stay local.
      const extendAfterMs = Number.isFinite(action.extendAfterMs)
        ? Math.max(0, Math.floor(action.extendAfterMs))
        : 0;
      if (savedTo && extendAfterMs > 0) {
        try {
          reportProgress?.(0.97, 'Extending edited segment…');
          const concatPath = await _runHybridExtendChain({
            instance,
            primaryPath: savedTo,
            prompt,
            extendAfterMs,
            aspectRatio: globalAspect,
            resolution: globalResolution,
            quality: globalQuality,
            action,
            agent,
            reportProgress,
            resolved,
          });
          if (concatPath) {
            channel.log('video', `Hybrid chain complete: edit + extend → ${path.basename(concatPath)}`);
            savedTo = concatPath;
            chainedExtend = true;
          } else {
            channel.log('video', `Hybrid chain returned no path; keeping primary edit only`);
          }
        } catch (err) {
          channel.log('video', `Hybrid chain failed (returning primary edit only): ${err.message}`);
        }
      }

      // Skip the auto-present when the caller is staging the result for
      // a specific clip (the GUI's timeline tab handles the visual swap;
      // opening a separate work-area tab on top steals focus from the
      // timeline the user is editing). Run AFTER the optional hybrid
      // chain so only the final concat (not the intermediate edit) is
      // presented and saved to the gallery.
      if (savedTo && !action.suppressPresent && channel.canPresentResources?.()) {
        channel.presentResource({ type: 'video', path: savedTo });
      }
      if (savedTo) {
        try {
          const params = { ...generationParams };
          if (final.model) params.model = final.model;
          if (chainedExtend) {
            params.extendAfterMs = extendAfterMs;
            params.hybridChain = true;
          }
          // Per-creation billing trail — credits charged by the
          // backend + upstream provider job id (fal request_id).
          // These travel on the gateway response (`final.creditsCost`,
          // `final.providerRequestId`) and we persist them in the
          // saved media's metadata so the GUI's Info panel can show
          // "Cost: X credits" without an extra roundtrip.
          if (typeof final.creditsCost === 'number') {
            params.creditsCost = final.creditsCost;
          }
          if (typeof final.providerRequestId === 'string') {
            params.providerRequestId = final.providerRequestId;
          }
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
            // Multishot pieces inherit the parent prompt's slug so
            // they sit alphabetically next to it in the drawer.
            prompt: action.prompt,
          });
          shotSavedTo = sr.path;
          shotSaveError = sr.error;
          if (shotSavedTo) {
            // Strip mov edit list — same fix as the primary path,
            // applied to multishot outputs so they're frame-aligned
            // when placed on the timeline.
            try {
              const stripped = await stripVideoEditList(shotSavedTo);
              if (stripped && stripped !== shotSavedTo) shotSavedTo = stripped;
            } catch (err) {
              channel.log('video', `shot ${shot.index} stripVideoEditList failed: ${err.message}`);
            }
          }
          if (shotSavedTo && !action.suppressPresent && channel.canPresentResources?.()) {
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

    // Disk recovery handoff complete — the job has been downloaded
    // and (if the caller wired clipContext) the watcher's resume
    // path is no longer needed. Delete the pending-jobs file.
    if (submitted.id && _persistedJob) {
      try {
        const { markCompleted: _markCompleted } = await import('../../state/pending-jobs.js');
        _markCompleted(submitted.id);
      } catch { /* non-fatal */ }
    }

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
      // Surface duration clamping when it happened, so the caller
      // (agent → user-facing report; or the timeline GUI later) can
      // explain why the file is longer than what was asked. The full
      // generated content is in `savedTo` — no trimming.
      ...(durationClampedUp
        ? {
            requestedDurationSec,
            generatedDurationSec: globalDuration,
            durationClampedUp: true,
          }
        : {}),
      usage: final.usage,
    };
  }
};

// ── Provider polling (collapsed from the old await_video_generation) ─
const DEFAULT_POLL_INTERVAL_MS = 8000;
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30000;

// No wall-clock timeout by default. As long as the provider keeps
// reporting the job is alive (IN_QUEUE / IN_PROGRESS) we keep waiting —
// fal jobs like seedance reference-to-video routinely run 10-20 min and
// occasionally longer, and the old 20-min cap surfaced a client error
// even when the video DID finish server-side. The only things that stop
// the wait now are: a terminal state (completed/failed), the user
// cancelling (abortSignal), or the provider going silent (the
// consecutive-error backstop inside _pollUntilTerminal). A finite cap
// can still be set explicitly via `action.timeoutMs` (ms) or the
// KOI_VIDEO_POLL_TIMEOUT_MS env var for callers that want one.
export const _resolveTimeoutMs = (action) => {
  if (action && typeof action.timeoutMs === 'number' && action.timeoutMs > 0) {
    return action.timeoutMs;
  }
  const env = Number(process.env.KOI_VIDEO_POLL_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return Infinity; // wait while the job is alive
};

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
export async function _pollUntilTerminal(instance, submitted, { abortSignal, reportProgress, timeoutMs, pollIntervalMs, onTick }) {
  const pollMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs));
  // `timeoutMs` of Infinity / 0 / non-positive ⇒ no wall-clock deadline:
  // wait while the provider keeps reporting the job is alive.
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const deadline = hasDeadline ? Date.now() + timeoutMs : Infinity;
  const t0 = Date.now();

  // `onTick(result)` — optional, fires after every successful poll
  // iteration (and once on synchronous completion). The
  // pending-jobs-aware caller uses this to refresh the heartbeat lock
  // and persist the latest fal status to disk, so another engine
  // (recovery watcher) can take over if this poller dies mid-loop.
  // Errors inside onTick MUST NOT abort the poll — the loop is
  // best-effort observability, not control flow.
  const _tick = (r) => {
    if (!onTick) return;
    try { onTick(r); } catch { /* observability is best-effort */ }
  };

  // Sync completion right out of the gate. Some providers omit `status`
  // and just return the URL — treat that as completed too.
  if (submitted.status === 'completed' || submitted.status === 'failed') {
    _tick(submitted);
    return submitted;
  }
  if (!submitted.status && submitted.url) {
    const synthetic = { ...submitted, status: 'completed' };
    _tick(synthetic);
    return synthetic;
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
      _tick(result);
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
      // With a finite deadline, scale linearly to it. With no deadline,
      // ease toward (but never reach) 0.92 on a half-life curve so the
      // bar still advances on long, open-ended waits.
      const frac = hasDeadline
        ? Math.min(1, elapsed / Math.max(1, timeoutMs))
        : 1 - Math.pow(0.5, elapsed / (5 * 60 * 1000));
      const pct = Math.min(0.92, 0.05 + 0.87 * frac);
      reportProgress(pct, `Waiting for provider… ${Math.round(elapsed / 1000)}s`);
    }

    if (hasDeadline && Date.now() + pollMs > deadline) {
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

/**
 * Hybrid-extend chain (Case 3 in the GUI's video-op classification):
 * runs after a successful EDIT generation. Takes the edit's output as
 * a base and asks an extend-capable model to continue it for
 * `extendAfterMs` ms with the SAME prompt. Concatenates the edit
 * output with the extension into a single video and returns its path.
 *
 * Padding is applied to the base video for the extend model's input
 * dimension constraints (mirrors what `execute()` does for the edit
 * step). The extend output is recovered (un-padded) before concat.
 *
 * Returns null on any failure — the caller falls back to the primary
 * edit output and surfaces a partial-success result.
 */
async function _runHybridExtendChain({
  instance, primaryPath, prompt, extendAfterMs,
  aspectRatio, resolution, quality, action, agent, reportProgress, resolved,
}) {
  if (!primaryPath || !fs.existsSync(primaryPath)) {
    channel.log('video', `extend chain: primary path missing — ${primaryPath}`);
    return null;
  }

  // 1. Peek the extend model's caps so we can pad the input correctly
  //    (same dance as the primary edit — see execute()).
  let extendCaps = null;
  let extendAspect = aspectRatio;
  let extendResolution = resolution;
  if (typeof instance.peekResolvedModel === 'function') {
    try {
      const peek = await instance.peekResolvedModel({
        aspectRatio,
        resolution,
        referenceVideos: [primaryPath],
        kind: 'extend',
        excludeModels: action.excludeModels,
        includeModels: action.includeModels,
        preferQuality: action.preferQuality !== false,
      });
      extendCaps = peek?.caps || null;
      if (peek?.slug) channel.log('pad', `extend chain: resolver picked ${peek.slug}`);
      if (extendCaps) {
        channel.log(
          'pad',
          `extend chain caps: resolutions=[${(extendCaps.resolutions || []).join(', ')}] `
          + `aspectRatios=[${(extendCaps.aspectRatios || []).join(', ')}]`,
        );
      }
    } catch (err) {
      channel.log('pad', `extend chain: peek failed (continuing without): ${err.message}`);
    }
  }

  // 2. Build pad target dims + minDuration from the extend model's caps,
  //    falling back to the primary's aspect/resolution when caps are empty.
  let padTargetDims = null;
  if (extendCaps) {
    const refDims = await _probeRefDims(primaryPath);
    if (refDims) {
      const envelope = pickEnvelopeResolution({
        contentWidth: refDims.width,
        contentHeight: refDims.height,
        resolutions: extendCaps.resolutions,
        aspectRatios: extendCaps.aspectRatios,
      });
      if (envelope) {
        padTargetDims = { w: envelope.w, h: envelope.h };
        extendAspect = envelope.aspectRatio;
        extendResolution = envelope.resolution;
      }
    }
  }
  if (!padTargetDims) {
    const dims = targetDimsForResolutionAspect(extendResolution || '720p', extendAspect || '16:9');
    if (dims) padTargetDims = dims;
  }

  const padOpts = padTargetDims ? { targetDims: padTargetDims } : {};
  let minDurSec = null;
  if (extendCaps) {
    if (Number.isFinite(extendCaps.minInputDurationSec) && extendCaps.minInputDurationSec > 0) {
      minDurSec = extendCaps.minInputDurationSec;
    } else if (Array.isArray(extendCaps.durations) && extendCaps.durations.length > 0) {
      minDurSec = extendCaps.durations[0];
    } else if (extendCaps.videoToVideo || extendCaps.videoExtend) {
      minDurSec = 3;
    }
  }
  if (Number.isFinite(minDurSec) && minDurSec > 0) {
    padOpts.minDurationMs = minDurSec * 1000;
  }
  // Same project-fps plumbing as the primary generate path — keeps
  // the extend pipeline in lockstep with V1's frame grid too.
  const extendProjectFps = Number(action?.projectFps);
  if (Number.isFinite(extendProjectFps) && extendProjectFps > 0) {
    padOpts.outputFps = extendProjectFps;
  }

  // 3. Pad the primary as the extend model's seed.
  const padResult = await padIfNeeded(primaryPath, 'video', padOpts);
  const seedPath = padResult.paddedPath || primaryPath;
  const seedRecoveryGeom = padResult.geometry?.needsPadding
    ? { ...padResult.geometry, kind: 'video' }
    : null;

  // 4. Submit the extend job. Mirrors execute()'s instance.generate
  //    call but pinned to `kind: 'extend'` so the router lands a
  //    video-extend model (Veo3-extend, Kling motion-control, etc.).
  reportProgress?.(0.975, 'Submitting extend job…');
  const submitted = await instance.generate(prompt, {
    duration: extendAfterMs / 1000,
    aspectRatio: extendAspect,
    resolution: extendResolution,
    quality: quality || 'auto',
    referenceVideos: [seedPath],
    kind: 'extend',
    excludeModels: Array.isArray(action.excludeModels) ? action.excludeModels : undefined,
    includeModels: Array.isArray(action.includeModels) ? action.includeModels : undefined,
    preferQuality: action.preferQuality !== false,
  });

  const final = await _pollUntilTerminal(instance, submitted, {
    abortSignal: agent?.abortSignal,
    reportProgress,
    timeoutMs: _resolveTimeoutMs(action),
    pollIntervalMs: typeof action.pollIntervalMs === 'number' && action.pollIntervalMs > 0
      ? action.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS,
  });

  if (final.status !== 'completed' || !final.url) {
    throw new Error(final.error || 'Extend pass did not complete');
  }

  // 5. Download the extend output to a temp path (no gallery — only
  //    the final concat goes there). Recover any padding we applied.
  const sr = await saveVideoFromUrl(final.url, {
    saveTo: null, // → default tmp landing
    provider: resolved.provider,
    model: submitted.model || final.model,
    id: `${final.id || submitted.id}-extend`,
  });
  let extendOutput = sr.path;
  if (!extendOutput) throw new Error(sr.error || 'Failed to download extend output');
  if (seedRecoveryGeom?.needsPadding) {
    try {
      const recovered = await recoverFromPadded(extendOutput, seedRecoveryGeom, 'video');
      if (recovered && recovered !== extendOutput) extendOutput = recovered;
    } catch (err) {
      channel.log('video', `extend recoverFromPadded failed (keeping padded): ${err.message}`);
    }
  }
  // Strip mov edit list (same fix as the main video flow — the extend
  // output will be concatenated with the edit output, and the edit
  // output is also strip-ed below; without this both halves would
  // start ~67ms ahead of where they should be).
  try {
    const stripped = await stripVideoEditList(extendOutput);
    if (stripped && stripped !== extendOutput) extendOutput = stripped;
  } catch (err) {
    channel.log('video', `extend stripVideoEditList failed: ${err.message}`);
  }

  // 6. Concatenate primary edit + extend — but ONLY when the extend
  //    model returns a slice-only output. Modern extend endpoints
  //    (fal-ai/veo3.1/extend-video, the only one we currently route
  //    to) return the FULL concatenated video instead: `[source +
  //    new 7s slice]`. Concatenating that with `primaryPath` again
  //    duplicates the source at the start of the output AND makes
  //    the seam land between "end of original" and "start of original"
  //    (a wraparound), which the user noticed as "se pega el principio
  //    del vídeo" + "no encaja el último fotograma con el primero
  //    de la extensión".
  //
  //    Detect by probing durations: if the extend output is at least
  //    as long as the primary, assume it already contains it and
  //    return as-is. Otherwise fall back to the legacy concat path
  //    (kept so a future slice-only adapter still works without code
  //    changes here).
  reportProgress?.(0.99, 'Joining edit + extension…');
  const primaryDurSec = await _probeVideoDurationSec(primaryPath);
  const extendDurSec = await _probeVideoDurationSec(extendOutput);
  if (
    Number.isFinite(primaryDurSec) &&
    Number.isFinite(extendDurSec) &&
    extendDurSec >= primaryDurSec - 0.5
  ) {
    channel.log(
      'video',
      `extend output (${extendDurSec.toFixed(2)}s) ≥ primary (${primaryDurSec.toFixed(2)}s) → `
      + 'model returned the full concatenated video; skipping our concat',
    );
    return extendOutput;
  }
  channel.log(
    'video',
    `extend output (${extendDurSec}s) < primary (${primaryDurSec}s) → `
    + 'assuming slice-only; concatenating primary + extend',
  );
  const outDir = path.dirname(primaryPath);
  const concatPath = await _concatVideoSegments([primaryPath, extendOutput], outDir);
  if (!concatPath) throw new Error('ffmpeg concat failed');
  return concatPath;
}

/** Probe the duration (in seconds, float) of a video file. Tries
 *  ffprobe first, falls back to ffmpeg's stderr-summary `Duration:`
 *  line. Returns NaN on failure so the caller can decide what to do. */
async function _probeVideoDurationSec(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return NaN;
  let bins = null;
  try { bins = await _ensureFfmpegForProbe(); } catch { return NaN; }
  if (!bins?.ffmpeg) return NaN;
  if (bins.ffprobe) {
    const dur = await new Promise((resolve) => {
      const proc = _spawnForProbe(bins.ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath,
      ]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => {
        const v = parseFloat(out.trim());
        resolve(Number.isFinite(v) && v > 0 ? v : NaN);
      });
      proc.on('error', () => resolve(NaN));
    });
    if (Number.isFinite(dur)) return dur;
  }
  return await new Promise((resolve) => {
    const proc = _spawnForProbe(bins.ffmpeg, [
      '-hide_banner', '-i', filePath, '-f', 'null', '-frames:v', '1', '-',
    ]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', () => {});
    proc.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(NaN);
      const h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      const s = parseFloat(m[3]);
      const total = h * 3600 + mi * 60 + s;
      resolve(Number.isFinite(total) && total > 0 ? total : NaN);
    });
    proc.on('error', () => resolve(NaN));
  });
}

/**
 * Reconcile the output of a video-extend call so the saved file is
 * ALWAYS the full source+extension video, no matter which adapter ran.
 *
 * Probes [outputPath] against [sourcePath]:
 *   • If the output duration is closer to `source + requestedExtension`
 *     → the adapter already returned the full concat. Returns { path: outputPath }.
 *   • If the output duration is closer to just `requestedExtension` (Seedance
 *     reference-to-video and friends), runs ffmpeg concat of [source, output]
 *     and returns { path: <concat> }.
 *   • If concat fails, returns { error: <message> } — the caller MUST treat
 *     this as a generation failure and NOT assign the slice to the clip
 *     (otherwise the source content is lost; this was the "ha asignado pero
 *     no lo ha hecho" recurring bug).
 *
 * [requestedExtensionSec] may be null when the caller didn't request a
 * specific duration — in that case the function falls back to the
 * "output shorter than source" heuristic (still hard-fails on concat
 * failure for the same reason).
 *
 * Always resolves; never throws. The modelSlug is only used to build
 * actionable error messages for the agent.
 */
export async function _reconcileExtendOutput({
  outputPath,
  sourcePath,
  requestedExtensionSec,
  modelSlug,
}) {
  if (!outputPath || !sourcePath) return { path: outputPath };
  try {
    const srcDurSec = await _probeVideoDurationSec(sourcePath);
    const outDurSec = await _probeVideoDurationSec(outputPath);
    const reqExtSec = Number.isFinite(requestedExtensionSec) &&
      requestedExtensionSec > 0
      ? Number(requestedExtensionSec)
      : null;
    let isSliceOnly = false;
    if (
      Number.isFinite(srcDurSec) &&
      Number.isFinite(outDurSec) &&
      reqExtSec !== null
    ) {
      const expectedFull = srcDurSec + reqExtSec;
      const expectedSlice = reqExtSec;
      const distFull = Math.abs(outDurSec - expectedFull);
      const distSlice = Math.abs(outDurSec - expectedSlice);
      isSliceOnly = distSlice < distFull;
      channel.log(
        'video',
        `extend reconcile: output=${outDurSec.toFixed(2)}s, ` +
        `source=${srcDurSec.toFixed(2)}s, req-ext=${reqExtSec.toFixed(2)}s, ` +
        `expected-full=${expectedFull.toFixed(2)}s, ` +
        `expected-slice=${expectedSlice.toFixed(2)}s ` +
        `→ ${isSliceOnly ? 'SLICE-ONLY (concat)' : 'FULL (as-is)'}`,
      );
    } else if (
      Number.isFinite(srcDurSec) &&
      Number.isFinite(outDurSec) &&
      outDurSec < srcDurSec - 0.5
    ) {
      // Fallback heuristic when reqExt is missing: any output noticeably
      // shorter than the source is treated as slice-only.
      isSliceOnly = true;
      channel.log(
        'video',
        `extend reconcile (fallback, no req-ext): output ${outDurSec.toFixed(2)}s < ` +
        `source ${srcDurSec.toFixed(2)}s → assuming slice-only; concatenating`,
      );
    }
    if (!isSliceOnly) return { path: outputPath };
    const concatDir = path.dirname(outputPath);
    const concatPath = await _concatVideoSegments(
      [sourcePath, outputPath],
      concatDir,
    );
    if (concatPath) {
      channel.log(
        'video',
        `extend reconcile: concat OK → ${path.basename(concatPath)}`,
      );
      return { path: concatPath };
    }
    const _slug = modelSlug || 'unknown';
    const _outDurStr = Number.isFinite(outDurSec)
      ? ` (${outDurSec.toFixed(2)}s)`
      : '';
    return {
      error:
        `[model=${_slug}] Could not assemble extended video: provider ` +
        `returned a slice-only output${_outDurStr} and the ffmpeg concat ` +
        `of source + extension failed. The original clip was left ` +
        `untouched. Try a different extend model ` +
        `(e.g. excludeModels: ['${_slug}']) or retry with a shorter duration.`,
    };
  } catch (err) {
    // Probe failures etc. — don't punish the caller for an unprobeable
    // file; let the original output through unchanged (matches the
    // previous best-effort behaviour for unknown durations).
    channel.log(
      'video',
      `extend reconcile failed (returning model output unchanged): ${err.message}`,
    );
    return { path: outputPath };
  }
}

/** Probe a video's width/height/fps via ffprobe. Returns null when any
 *  field is missing — the caller falls back to a default spec. */
async function _probeVideoSpec(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let bins = null;
  try { bins = await _ensureFfmpegForProbe(); } catch { return null; }
  if (!bins?.ffprobe) return null;
  return await new Promise((resolve) => {
    const proc = _spawnForProbe(bins.ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'csv=p=0',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      // Output looks like "1920,1080,30000/1001" (one line, comma-separated).
      const line = out.trim().split(/\r?\n/)[0] || '';
      const parts = line.split(',');
      if (parts.length < 3) return resolve(null);
      const w = parseInt(parts[0], 10);
      const h = parseInt(parts[1], 10);
      const r = parts[2]; // "num/den"
      const [rn, rd] = r.split('/').map((n) => parseFloat(n));
      const fps = Number.isFinite(rn) && Number.isFinite(rd) && rd > 0
        ? rn / rd
        : NaN;
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return resolve(null);
      }
      resolve({
        width: w,
        height: h,
        fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
      });
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * ffmpeg concat via the concat filter (re-encodes; safe across codecs).
 * Drops audio — the AI clips we're chaining are visual-only by design
 * and the model regenerates any soundscape on its own pass anyway.
 *
 * The concat filter requires every input to share width, height, SAR
 * and pixel format. Provider outputs routinely violate this (e.g. the
 * source is 1924×1076 while the extension slice comes back at 1280×720,
 * which makes libx264 abort with `-22 Invalid argument` and the whole
 * extend flow silently fall back to a slice-only clip). We probe the
 * FIRST input — the source — and pre-normalize every subsequent input
 * with `scale + pad + setsar + fps + format` so the concat filter
 * never sees mismatched specs.
 *
 * Returns the absolute path of the concatenated output, or null on
 * failure. Output lives next to the inputs (under [outDir]).
 */
async function _concatVideoSegments(paths, outDir) {
  if (!Array.isArray(paths) || paths.length < 2) return null;
  let bins = null;
  try {
    bins = await _ensureFfmpegForProbe();
  } catch (err) {
    channel.log('video', `concat: ensureFfmpeg failed: ${err.message}`);
    return null;
  }
  if (!bins?.ffmpeg) {
    channel.log('video', 'concat: no ffmpeg binary available');
    return null;
  }
  // Use the SOURCE video's spec as the target so the concatenated
  // output preserves the user's expected resolution and frame rate.
  // Fallback when probe fails: 1920×1080@30 (safe defaults that libx264
  // accepts and that won't surprise users with degraded resolution).
  const refSpec = await _probeVideoSpec(paths[0]);
  const targetW = refSpec?.width ?? 1920;
  const targetH = refSpec?.height ?? 1080;
  const targetFps = refSpec?.fps ?? 30;
  // libx264 requires even dimensions for yuv420p — round down to the
  // nearest even number rather than failing later in the encode.
  const evenW = targetW % 2 === 0 ? targetW : targetW - 1;
  const evenH = targetH % 2 === 0 ? targetH : targetH - 1;
  channel.log(
    'video',
    `concat normalize target: ${evenW}×${evenH}@${targetFps.toFixed(2)}fps` +
    `${refSpec ? '' : ' (probe failed → defaults)'}`,
  );
  const outFile = path.join(outDir, `concat-${Date.now()}.mp4`);
  const inputArgs = [];
  for (const p of paths) {
    inputArgs.push('-i', p);
  }
  // Per-input normalize step: scale-fit, pad to fill, force square
  // pixels, resample to target fps, force yuv420p. All inputs land in
  // the same spec, so the concat filter has nothing to complain about.
  const normalizeParts = paths.map((_, i) =>
    `[${i}:v]scale=${evenW}:${evenH}:force_original_aspect_ratio=decrease,` +
    `pad=${evenW}:${evenH}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,fps=${targetFps},format=yuv420p[v${i}]`,
  ).join(';');
  const concatInputs = paths.map((_, i) => `[v${i}]`).join('');
  const filter =
    `${normalizeParts};${concatInputs}concat=n=${paths.length}:v=1:a=0[outv]`;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...inputArgs,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', outFile,
  ];
  return new Promise((resolve) => {
    const proc = _spawnForProbe(bins.ffmpeg, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        channel.log('video', `concat exit=${code}: ${err.trim().slice(-300)}`);
        resolve(null);
      } else {
        resolve(outFile);
      }
    });
    proc.on('error', (e) => {
      channel.log('video', `concat spawn failed: ${e.message}`);
      resolve(null);
    });
  });
}

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

/** Adapt a single loaded frame against the picked model's declared
 *  input restrictions for `role` — same generic adapter the avatar
 *  tool uses, just wired for each of the video tool's canonical image
 *  roles (`startFrame` / `endFrame` / `referenceImages`). No-op when
 *  the frame is missing, when the model declared no constraint for
 *  this role, or when the original bytes already fit. Mirrors the
 *  block in `generate-avatar-video.js` — keeping the constraint-aware
 *  upload path consistent across every media tool. */
async function _adaptFrameToConstraints(frame, model, role) {
  if (!frame || frame._error || !model) return frame;
  try {
    const { adaptImageInput } = await import('../../llm/providers/_constraints.js');
    const adapted = await adaptImageInput(frame.data, model, role);
    if (adapted.changed) {
      return { data: adapted.buffer, mimeType: adapted.mimeType };
    }
  } catch (err) {
    channel.log(
      'video',
      `generate_video: adapt-image skipped for ${role} (${err?.message || err}) — uploading original`,
    );
  }
  return frame;
}

/** Array variant — adapts each entry in place. Safe with undefined /
 *  empty / `_error` payloads (`_loadReferenceImages` either returns
 *  an array or a `{_error}` sentinel). */
async function _adaptFramesToConstraints(frames, model, role) {
  if (!Array.isArray(frames) || frames.length === 0 || !model) return frames;
  for (let i = 0; i < frames.length; i++) {
    frames[i] = await _adaptFrameToConstraints(frames[i], model, role);
  }
  return frames;
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
  // Derive the model's minimum input-video duration from caps (same
  // resolution order as the upstream pad branch in execute()). The
  // value is forwarded to `_uploadVideoRef`, which now does a defensive
  // temporal pad before sending the bytes to the gateway. This catches
  // routes (reference-to-video, future buckets) that skip the
  // upstream pad branch — without it, the model rejects the upload
  // with `Video duration is too short. Minimum is X seconds.`.
  let minDurSec = null;
  if (caps && Number.isFinite(caps.minInputDurationSec) && caps.minInputDurationSec > 0) {
    minDurSec = caps.minInputDurationSec;
  } else if (caps && Array.isArray(caps.durations) && caps.durations.length > 0) {
    minDurSec = caps.durations[0];
  } else if (caps && caps.videoToVideo) {
    minDurSec = 3; // matches the legacy "video-to-video catalog-row-empty" fallback
  }
  const urls = [];
  for (const input of pathArr) {
    const url = await _uploadVideoRef(input, { minDurationSec: minDurSec });
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

  // `kind` enum is curated dynamically: each value only appears when
  // at least one model carries the matching `categories` tag.
  // Without a backing model the parameter would just dead-end the
  // picker, so we trim absent values from the enum (and drop the
  // field altogether when neither bucket has a model).
  {
    const kinds = [];
    if (caps.anyExtend) kinds.push('extend');
    if (caps.anyBgRemove) kinds.push('bg-remove');
    if (kinds.length === 0) {
      delete props.kind;
    } else {
      props.kind = { ...props.kind, enum: kinds };
    }
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
    fields.push('optional "withAudio" — boolean; generate an audio track (SFX/dialogue/voiceover/ambient) alongside the video. DEFAULT true — pass false ONLY for a deliberately silent clip. Does NOT control background music.');
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
    // `other` and `default` are admin placeholders, not semantic choices.
    // Hiding them from the agent's option list stops the agent from
    // picking them as a "neutral / no-preference" flag — the router
    // already treats no-label as "rank by quality" and exposing these
    // names only makes the agent narrow the pool to a single model that
    // happens to carry the placeholder tag (real-world bug:
    // `label: 'other'` filtered the catalog down to kling because kling
    // was the only model carrying that tag, even though seedance i2v
    // was cheaper, smaller-payload-friendly, and tagged `default`).
    const meaningfulLabels = caps.labels.filter(
      (slug) => slug !== 'other' && slug !== 'default',
    );
    if (meaningfulLabels.length > 0) {
      const lines = meaningfulLabels.map((slug) => {
        const d = details.find((x) => x && x.slug === slug);
        const desc = d && d.description ? ` — ${d.description}` : '';
        return `    • "${slug}"${desc}`;
      }).join('\n');
      fields.push(`optional "label" — ranking preference for a domain-tuned variant. Check whether your task — and any involved source image/video, look at them — matches one of the slugs below; setting the right label routes to a specialised model and gives a better result. Omit this field for the default routing.\n${lines}`);
    }
  }
  if (caps.anyExtend || caps.anyBgRemove) {
    const parts = ['optional "kind" — routes to a curated specialist model bucket instead of the default generation/edit shop:'];
    if (caps.anyExtend) {
      parts.push('  • "extend" — CONTINUE / EXTEND / make-longer an existing video (`video_extend` bucket). Combine with referenceVideos=[<source>] (or startFrame=<last frame>).');
    }
    if (caps.anyBgRemove) {
      parts.push('  • "bg-remove" — strip the background out of the input video, returning a transparent-background MP4 (`video_background_removal` bucket; e.g. Bria video matting). Pass referenceVideos=[<source>].');
    }
    parts.push('Omit for fresh generations / restyles / regular edits.');
    fields.push(parts.join('\n'));
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
