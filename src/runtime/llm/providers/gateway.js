/**
 * Gateway providers — used when the user is authenticated via a braxil.ai account.
 *
 * All calls are routed through the braxil.ai backend gateway, which proxies
 * to the actual providers server-side (OpenAI, Gemini, Kling, Seedance, etc.).
 *
 * The gateway exposes a UNIFIED API inspired by fal.ai's pattern:
 *
 *   LLM:       POST /gateway/chat/completions          (OpenAI-compatible)
 *   Embedding: POST /gateway/embeddings                 (OpenAI-compatible)
 *   Search:    POST /gateway/search
 *
 *   Image:     POST /gateway/media/image/generate       (sync — returns images)
 *   Audio TTS: POST /gateway/media/audio/speech         (sync — returns audio buffer)
 *   Audio STT: POST /gateway/media/audio/transcribe     (sync — returns text)
 *   Video:     POST /gateway/media/video/generate       (async — returns job ID)
 *   Video:     GET  /gateway/media/video/status/:id     (poll job status)
 *
 * The gateway accepts ANY model from ANY provider — the backend routes it.
 * Capabilities are resolved dynamically from models.json mediaCaps.
 */

import { BaseEmbedding, BaseSearch, BaseImageGen, BaseAudioGen, BaseVideoGen } from './base.js';
import { lookupModel } from '../cost-center.js';
import { parseQuotaExceededResponse } from '../quota-exceeded-error.js';
import { channel } from '../../io/channel.js';

/**
 * Throw a QuotaExceededError if the response is HTTP 402. Callers should
 * `await throwIfQuotaExceeded(res)` immediately after `fetch()` so that the
 * no-credits case short-circuits any per-endpoint error handling below.
 */
async function throwIfQuotaExceeded(res) {
  if (res.status === 402) {
    throw await parseQuotaExceededResponse(res);
  }
}

/**
 * Exported so the per-tool actions (generate-video.js etc.) can run
 * the same auto-retry classifier the gateway providers use internally
 * — see `_isRouteableError` consumers.
 */
export { _isContentPolicyError, _isInputShapeError, _isRouteableError };

/**
 * True when the error message matches a known provider/model
 * content-policy / safety-filter / moderation rejection. These are
 * the cases where switching to a different slug in the same bucket
 * can plausibly succeed (Imagen rejects → Seedream might accept).
 *
 * Patterns observed live across providers:
 *  • OpenAI gpt-image-2: "content checker", "flagged by a content checker"
 *  • Google Imagen / Gemini: "safety filter", "violates safety policy", "blocked by safety"
 *  • Anthropic / Claude: "policy violation"
 *  • fal generic: "moderation", "content policy", "not allowed", "refused"
 *  • Seedance: "content could not be processed"
 */
function _isContentPolicyError(err) {
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('content checker') ||
    msg.includes('content policy') ||
    msg.includes('content could not be processed') ||
    msg.includes('safety policy') ||
    msg.includes('safety filter') ||
    msg.includes('blocked by safety') ||
    msg.includes('flagged') ||
    msg.includes('moderation') ||
    msg.includes('policy violation') ||
    msg.includes('violates our policies') ||
    msg.includes('not allowed by') ||
    msg.includes('refused due to content')
  );
}

/**
 * True when the error message matches an input-shape mismatch — the
 * picker landed on a model whose adapter requires inputs the
 * canonical request didn't carry. Same retry tactic as content
 * policy: exclude the slug and try the next-best candidate (which
 * may belong to a different input-shape family within the same
 * category bucket).
 *
 * Real example from production: text-only `generate_video` lands on
 * `fal-ai/wan/v2.7/image-to-video` (image-to-video model in the
 * `video_generation` bucket); adapter rejects with
 *   `body.image_url: At least one media input is required: provide
 *    image_url (first frame), video_url (video continuation), or
 *    audio_url (with image/video)`
 * — clearly a shape mismatch, not a content policy issue. Without
 * this detector the agent has to re-craft the call manually with
 * excludeModels, which it rarely does correctly on a delegate's
 * first retry.
 */
function _isInputShapeError(err) {
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('at least one media input is required') ||
    /\bimage_url\b[^\n]*\brequired\b/.test(msg) ||
    /\bvideo_url\b[^\n]*\brequired\b/.test(msg) ||
    /\bimage_urls\b[^\n]*\brequired\b/.test(msg) ||
    /\baudio_url\b[^\n]*\brequired\b/.test(msg) ||
    /\bstart_image_url\b[^\n]*\brequired\b/.test(msg) ||
    /\bfirst_frame_url\b[^\n]*\brequired\b/.test(msg) ||
    msg.includes('field required') ||
    msg.includes('reference image required') ||
    msg.includes('first frame required') ||
    msg.includes('start frame required')
  );
}

/**
 * Single check for "this error is recoverable by re-routing to a
 * different model in the same bucket". Used by the auto-retry loop
 * in GatewayImageGen.generate / GatewayVideoGen.generate to decide
 * whether to exclude+retry or surface the error verbatim.
 */
function _isRouteableError(err) {
  return _isContentPolicyError(err) || _isInputShapeError(err);
}

// ── Gateway base URL ─────────────────────────────────────────────────────────

export function getGatewayBase() {
  return (process.env.KOI_API_URL || 'http://localhost:3000') + '/gateway';
}

export function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${process.env.KOI_AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// NOTE: 401 recovery (refresh → retry, or re-show login) is handled ONCE for
// EVERY backend call by the global fetch interceptor installed in each koi-cli
// process (auth-fetch-interceptor.js). gateway.js just uses plain `fetch`; do
// NOT re-add per-endpoint 401 handling here.

// ── Per-request stall timeouts for media calls ──────────────────────────────
// A fetch whose only signal is the caller's (often undefined) abortSignal
// NEVER settles when the TCP connection stalls mid-request — no rejection, no
// response, nothing for the retry loops to catch. That was the MCP
// generate_image hang: the /media/image/submit upload (tens of MB of base64
// reference images) stalled on a flaky uplink, `generate()` never returned,
// the child never wrote result.json, and Claude's tool call sat busy until
// the MCP server's own 10-min cap. Every media request now carries a stall
// timeout composed with the caller's abortSignal:
//   • submits / uploads / sync work  → _MEDIA_SUBMIT_TIMEOUT_MS (generous —
//     big payloads on slow uplinks are legitimate; a stalled socket is not)
//   • status polls                   → _MEDIA_POLL_TIMEOUT_MS (quick GETs)
// A timeout REJECTS the fetch, which the existing poll loops already treat
// as a transient error (image/audio tolerate 8 consecutive, video 5) and
// submit paths surface as a normal tool error instead of hanging forever.
const _MEDIA_SUBMIT_TIMEOUT_MS = Number(process.env.KOI_MEDIA_SUBMIT_TIMEOUT_MS) || 300 * 1000;
const _MEDIA_POLL_TIMEOUT_MS = Number(process.env.KOI_MEDIA_POLL_TIMEOUT_MS) || 30 * 1000;

function _stallSignal(abortSignal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([abortSignal, t]) : t;
}

// ── Shared: resolve mediaCaps from models.json ──────────────────────────────

function _getMediaCaps(model) {
  const info = lookupModel(model);
  return info?.mediaCaps || null;
}

// ── Dynamic media capabilities from the backend models list ────────────────
//
// Source of truth: GET /gateway/models/{image,video,audio}.json — the
// authoritative list of currently active media models from the backend DB.
// We fetch once per process per kind, take the DISTINCT union of the
// capability columns, and expose a single blob the runtime tools use to
// build dynamic schemas so the agent only ever sees values the backend can
// actually serve (no phantom aspect ratios, no phantom resolutions, no
// phantom labels).
//
// Design intent (important):
//   - Labels are a RANKING preference, not a filter. A model without the
//     label is still eligible, it just ranks lower.
//   - Any parameter (label, resolution, aspectRatio, n, refs, withAudio…)
//     is surfaced to the agent ONLY when at least one active model in the
//     set supports it. Empty → omit from the schema entirely.
//
// Returns null on any failure (offline, unauth, 5xx). Callers treat that
// as "unknown, fall back to static defaults".
//
// NO CACHE — every call fetches a fresh `/models/{kind}.json`. We had a
// process-lifetime memo here once and it bit us hard: a Seedance row
// that no longer carried `video_editing` in its `categories[]` still
// got picked for v2v requests for hours on already-running clients
// because the cached entry pinned the stale category list. The backend
// already returns a compact, gzip-friendly JSON, the call lands inside
// a tool invocation (not a hot loop), and the freshness matters more
// than the saved roundtrip. If we ever bring memoisation back, do it
// with a short TTL (≤60s) and tie it to a backoffice publish event so
// changes propagate the same minute they happen.

const _splitCsv = (s) => {
  if (typeof s !== 'string') return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
};

// Normalize a label entry into a {slug, description} pair. The backend now
// ships labels as `{slug, description}` per model (see getMediaModels), but
// the runtime tolerates the legacy plain-string shape so older catalogs
// don't break the description block.
function _normLabel(l) {
  if (typeof l === 'string') return { slug: l.trim(), description: '' };
  if (l && typeof l === 'object' && typeof l.slug === 'string') {
    return { slug: l.slug.trim(), description: typeof l.description === 'string' ? l.description : '' };
  }
  return null;
}

function _collectCommon(models) {
  // Aggregate ONLY Koi-owned signals:
  //   • labels[]:    de-duped union of {slug, description} pairs across
  //                  the active catalog. Tools surface the slug list as
  //                  an agent-facing enum and the description in
  //                  prompt-time guidance.
  //   • categories[]: de-duped union of the Koi buckets present in the
  //                  catalog. Lets tools surface a `kind` enum only for
  //                  buckets that actually have at least one active
  //                  model — no phantom options.
  // Vendor-derived signals (resolutions, aspectRatios, durations,
  // cameraMovements, maxShots, t2v/i2v/v2v flags, operations[],
  // canEdit/canGenerate, maxRefImages, frameControl, hasAudio, lipsync,
  // tts/sfx/music/transcribe/voiceSelect, inputImage/Video/Audio) are
  // INTENTIONALLY not collected: the backend doesn't ship them in
  // models.json anymore, and the runtime tools don't depend on them
  // either. The per-slug adapter is the sole place that knows what a
  // model physically accepts.
  const labelMap = new Map();
  const categorySet = new Set();
  for (const m of models) {
    if (Array.isArray(m?.labels)) {
      for (const raw of m.labels) {
        const norm = _normLabel(raw);
        if (!norm || !norm.slug) continue;
        const prev = labelMap.get(norm.slug);
        if (!prev || (prev && !prev.description && norm.description)) {
          labelMap.set(norm.slug, norm);
        }
      }
    }
    if (Array.isArray(m?.categories)) {
      for (const c of m.categories) {
        if (typeof c === 'string' && c.trim()) categorySet.add(c.trim());
      }
    }
  }
  const labels = [...labelMap.keys()].sort();
  const labelDetails = labels.map((slug) => labelMap.get(slug));
  return {
    labels,
    labelDetails,
    categories: [...categorySet].sort(),
  };
}

function _aggregateImage(models) {
  const common = _collectCommon(models);
  // Bucket-presence flags surface tool parameters only when the catalog
  // actually carries the relevant Koi category. Sourced from
  // `common.categories`, NOT from vendor flags.
  const cats = new Set(common.categories);
  return {
    models,
    ...common,
    hasGenerate:        cats.has('image_generation'),
    hasEdit:            cats.has('image_editing'),
    hasBackgroundRemove: cats.has('image_background_removal'),
    hasUpscale:         cats.has('image_upscaling'),
    hasExtend:          cats.has('image_extend'),
  };
}

function _aggregateVideo(models) {
  const common = _collectCommon(models);
  const cats = new Set(common.categories);
  return {
    models,
    ...common,
    hasGenerate:        cats.has('video_generation'),
    hasEditing:         cats.has('video_editing'),
    hasExtend:          cats.has('video_extend'),
    hasAvatar:          cats.has('video_avatar'),
    hasLipsync:         cats.has('video_lipsync'),
    hasBackgroundRemove: cats.has('video_background_removal'),
  };
}

function _aggregateAudio(models) {
  const common = _collectCommon(models);
  const cats = new Set(common.categories);
  const kinds = [];
  if (cats.has('audio_tts')) kinds.push('tts');
  if (cats.has('audio_transcription')) kinds.push('transcribe');
  if (cats.has('audio_music')) kinds.push('music');
  if (cats.has('audio_sfx')) kinds.push('sfx');
  if (cats.has('audio_voice_clone')) kinds.push('voice-clone');
  return {
    models,
    ...common,
    kinds,
    hasTts:        cats.has('audio_tts'),
    hasTranscribe: cats.has('audio_transcription'),
    hasMusic:      cats.has('audio_music'),
    hasSfx:        cats.has('audio_sfx'),
    hasVoiceClone: cats.has('audio_voice_clone'),
  };
}

const _aggregateByKind = {
  image: _aggregateImage,
  video: _aggregateVideo,
  audio: _aggregateAudio,
};

/**
 * Fetch the active media models of a given kind plus a union of the
 * user-facing capability signals the runtime tools need to build
 * dynamic schemas. **Always hits the network** — no in-memory cache
 * (see the long note above the `_aggregateByKind` table). Returns null
 * on any failure (offline, unauth, 5xx). Callers treat null as
 * "unknown, fall back to static defaults".
 */
export async function fetchMediaCapabilities(kind) {
  if (!Object.prototype.hasOwnProperty.call(_aggregateByKind, kind)) {
    return null;
  }
  try {
    const res = await fetch(`${getGatewayBase()}/models/${kind}.json`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    const models = await res.json();
    if (!Array.isArray(models) || models.length === 0) return null;
    return _aggregateByKind[kind](models);
  } catch {
    return null;
  }
}

/**
 * Fetch the RAW active media model rows for a kind — a lean projection
 * { slug, displayName, categories, labels } per active model (price != null,
 * mirroring the router's active filter). Unlike fetchMediaCapabilities (which
 * aggregates capability columns), this preserves per-model identity so callers
 * can bind catalog slugs to an external provider's model ids (e.g. the MCP media
 * mapper mapping `fal-ai/nano-banana-pro/edit` → Magnific `imagen-nano-banana-2`).
 * Returns [] on any failure — callers treat empty as "no catalog to map against".
 */
export async function fetchMediaModelRows(kind) {
  if (!Object.prototype.hasOwnProperty.call(_aggregateByKind, kind)) return [];
  try {
    const res = await fetch(`${getGatewayBase()}/models/${kind}.json`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return [];
    const models = await res.json();
    if (!Array.isArray(models)) return [];
    // Normalise categories to their canonical bucket. Catalog rows may still
    // carry the legacy short forms (`sfx`, `text-to-video`, `avatar`, …); the
    // router picks alias-aware, but consumers of THIS function (the GUI model
    // picker, getActiveModelsByLabel) do a raw `.includes(category)` and would
    // otherwise miss every short-form row — the cause of empty per-operation
    // dropdowns in the chat-options panel.
    const { canonicalizeCategories } = await import('./media-model-router.js');
    return models
      .filter((m) => m && typeof m.slug === 'string' && m.pricePerUnit != null)
      .map((m) => ({
        slug: m.slug,
        displayName: typeof m.displayName === 'string' ? m.displayName : '',
        categories: canonicalizeCategories(Array.isArray(m.categories) ? m.categories : []),
        labels: Array.isArray(m.labels)
          ? m.labels.map((l) => (typeof l === 'string' ? l : l && l.slug)).filter(Boolean)
          : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Return the ACTIVE media models (rows from fetchMediaModelRows) whose `labels`
 * include `label`, optionally narrowed to a single `category`. Rows keep the
 * `{ slug, displayName, categories, labels }` shape. Empty array when nothing
 * matches (or the catalog is unreachable).
 *
 * A label is a koi-owned purpose bucket (e.g. `storyboard_card`) tagged on a
 * curated model. Programmatic pipelines that must pin a slug — the tool now
 * REQUIRES `model`, there is no auto-selection — use this to look up the slug
 * for their label instead of hardcoding it: e.g. the interactive storyboard
 * visor resolves the `storyboard_card` model before calling generate_image.
 */
export async function mediaModelsByLabel(kind, label, category = null) {
  if (typeof label !== 'string' || !label.trim()) return [];
  const want = label.trim();
  const rows = await fetchMediaModelRows(kind);
  return rows.filter((m) =>
    Array.isArray(m.labels) && m.labels.includes(want) &&
    (!category || (Array.isArray(m.categories) && m.categories.includes(category))));
}

// ── Client-side media model resolver ────────────────────────────────────────
//
// Mirrors how text LLMs work: the backend is a dumb proxy that runs whatever
// slug the client sends. Hard filters + soft ranking live in the runtime
// (see media-model-router.js), fed by the live /gateway/models/{kind}.json
// list. When the caller provides an explicit slug we trust it verbatim and
// skip the router.

function _toNoMatchError(routingErr) {
  const details = { code: 'no_model_matches', ...(routingErr.details || {}) };
  // Enrich the agent-visible message: only `err.message` reaches the
  // agent's "Action failed" feedback — `err.details` stays in-process.
  // Without a summary the worker just sees "no active model matches"
  // and has nothing to pivot on, so it retries with the same shape.
  const hint = _summariseNoMatch(details);
  const message = hint ? `${routingErr.message} — ${hint}` : routingErr.message;
  const err = new Error(message);
  err.details = details;
  try {
    const summary = {
      requirements: details.requirements,
      candidates: details.candidates,
      rejections: details.rejections,
    };
    console.error('[media-router] no_model_matches', JSON.stringify(summary, null, 2));
  } catch { /* non-fatal */ }
  return err;
}

// Compact one-line summary of why the catalog collapsed: top rejection
// reasons grouped by frequency, plus which dimensions still have viable
// models (so the agent knows what to drop). The `alternatives` map is
// per-dimension `{ "videoRefsCount>0": [{slug,...}, ...] }`.
function _summariseNoMatch(details) {
  const parts = [];
  const rejections = Array.isArray(details.rejections) ? details.rejections : [];
  if (rejections.length > 0) {
    const counts = new Map();
    for (const r of rejections) {
      for (const reason of (r.reasons || [])) {
        counts.set(reason, (counts.get(reason) || 0) + 1);
      }
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${reason} (${n})`)
      .join(', ');
    if (top) parts.push(`tried ${rejections.length} model(s); top reasons: ${top}`);
  } else if (typeof details.candidates === 'number') {
    parts.push(`candidates=${details.candidates}`);
  }
  const alts = details.alternatives;
  if (alts && typeof alts === 'object') {
    const viable = [];
    for (const [dim, list] of Object.entries(alts)) {
      if (Array.isArray(list) && list.length > 0) {
        const slugs = list.slice(0, 3).map((m) => m?.slug).filter(Boolean).join(',');
        viable.push(`${dim}=${list.length} model(s)${slugs ? ` [${slugs}${list.length > 3 ? ',…' : ''}]` : ''}`);
      }
    }
    if (viable.length > 0) parts.push(`viable per-dimension: ${viable.join(' | ')}`);
  }
  if (Array.isArray(details.included) && details.included.length > 0) {
    parts.push(`includeModels=[${details.included.join(',')}]`);
  }
  if (Array.isArray(details.excluded) && details.excluded.length > 0) {
    parts.push(`excludeModels=[${details.excluded.join(',')}]`);
  }
  return parts.join(' — ');
}

// Normalize the handful of shapes Fal / OpenAI / Google / custom proxies
// use when returning image results. Handles, in priority order:
//   - `data.images: [{url|b64|b64_json, revised_prompt?}]` — OpenAI / Flux
//   - `data.data:   [{url|b64|b64_json, revised_prompt?}]` — DALL·E style
//   - `data.image:  {url|b64|b64_json}`                    — Fal nano-banana/edit, rembg
//   - `data.image_url: "https://…"`                        — Fal upscaler legacy
// Silently ignores shapes without an image payload so callers can still
// surface the raw body (NSFW flag, finishReason, blockReason…) in the
// "no images" branch rather than crashing on parse.
function _collectImages(data) {
  const images = [];
  if (!data || typeof data !== 'object') return images;
  const push = (img) => {
    if (!img || typeof img !== 'object') return;
    const url = img.url || img.image_url || undefined;
    const b64 = img.b64 || img.b64_json || undefined;
    if (!url && !b64) return;
    images.push({
      url,
      b64,
      revisedPrompt: img.revised_prompt || img.revisedPrompt || undefined,
    });
  };
  if (Array.isArray(data.images)) data.images.forEach(push);
  else if (Array.isArray(data.data)) data.data.forEach(push);
  else if (data.image && typeof data.image === 'object') push(data.image);
  else if (typeof data.image_url === 'string') push({ url: data.image_url });
  return images;
}

async function _resolveMediaModel(kind, explicit, opts, pickFn, req) {
  if (explicit && explicit !== 'auto') {
    // GENERIC CATEGORY GUARD: a pinned model bypasses the router (and its
    // per-operation category bucket). Every media operation requires a
    // category (image/audio/video: edit, upscale, tts, video_editing…), so
    // validate the pinned slug carries it. Positively-wrong pins fail with a
    // self-describing error listing the models that DO support the category.
    await _assertPinnedModelCategory(kind, explicit, req);
    return explicit;
  }
  const caps = await fetchMediaCapabilities(kind);
  if (!caps || !Array.isArray(caps.models) || caps.models.length === 0) {
    const err = new Error(`No active ${kind} models available from the backend`);
    err.details = { code: 'no_model_matches', requirements: req };
    throw err;
  }
  return await pickFn(caps.models, req);
}

/**
 * GENERIC CATEGORY GUARD for an EXPLICITLY PINNED media model. Every media
 * operation (image/audio/video) maps to a required Koi category; the router
 * enforces it when it picks, but an explicit `this.model` pin short-circuits
 * `_resolveMediaModel` and skips that filter, so validate here too. Only
 * throws when it can POSITIVELY confirm the model lacks the category (the
 * row exists in the active catalog and does not carry it); when it cannot
 * verify (offline, unknown kind, slug absent from the catalog) it stays out
 * of the way. The error lists the models that DO support the category and the
 * recommended default, so the agent can pivot instead of forcing a wrong model.
 */
async function _assertPinnedModelCategory(kind, slug, req) {
  let wanted, inCat;
  try {
    ({ wantedCategoryFor: wanted, modelInCategory: inCat } = await import('./media-model-router.js'));
  } catch { return; }
  const wantedCat = wanted(kind, req || {});
  if (!wantedCat) return; // unknown media kind: nothing to enforce
  let rows;
  try { rows = await fetchMediaModelRows(kind); } catch { rows = []; }
  if (!Array.isArray(rows) || rows.length === 0) return; // can't verify: don't block
  const row = rows.find((m) => m.slug === slug);
  if (!row) return; // pinned slug not in the active catalog: a different error surfaces at submit
  if (inCat(row, wantedCat)) return; // the pinned model supports the operation: allow

  const eligible = rows.filter((m) => inCat(m, wantedCat));
  const list = eligible.map((m) => m.slug).join(', ') || '(none configured on the backend)';
  const def = eligible.find((m) => Array.isArray(m.labels) && m.labels.includes('default'));
  const rec = def ? def.slug : (eligible[0] ? eligible[0].slug : null);
  const err = new Error(
    `Model "${slug}" cannot perform this ${kind} operation: it is not in the required "${wantedCat}" category. `
    + `Only models tagged "${wantedCat}" can. Allowed: [${list}]`
    + (rec ? `. Recommended: ${rec}.` : '.')
    + ` Do NOT pin a different model or switch operation to bypass this; pick one of the allowed models or omit the model to let the backend choose.`,
  );
  err.details = {
    code: 'model_category_mismatch',
    kind,
    requiredCategory: wantedCat,
    attemptedModel: slug,
    allowedModels: eligible.map((m) => m.slug),
    recommended: rec,
  };
  throw err;
}

// ── GatewayEmbedding ─────────────────────────────────────────────────────────

export class GatewayEmbedding extends BaseEmbedding {
  constructor() {
    // Pass dummy client/model — we use fetch directly
    super({ _gateway: true }, 'text-embedding-3-small');
    this._dim = 1536;
  }

  get providerName() { return 'koi-gateway'; }

  dimension() { return this._dim; }

  async embed(text, opts = {}) {
    const res = await fetch(`${getGatewayBase()}/embeddings`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        input: text,
        model: this.model,
      }),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway embedding error (${res.status}): ${body}`);
    }

    const data = await res.json();
    // OpenAI-compatible response: { data: [{ embedding: [...] }] }
    return data.data?.[0]?.embedding || data.embedding || [];
  }

  /**
   * Batch embed multiple texts in chunks to respect rate limits.
   * Sends chunks of CHUNK_SIZE with pauses between them.
   * On 429, respects the server's Retry-After header (or waits 60s).
   */
  async embedBatch(texts, opts = {}) {
    if (!texts.length) return [];
    if (texts.length === 1) return [await this.embed(texts[0], opts)];

    const CHUNK_SIZE = 20;
    const CHUNK_PAUSE = 1000;
    const MAX_RETRIES = 4;

    const allVectors = [];
    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CHUNK_SIZE);
      if (i > 0) await new Promise(r => setTimeout(r, CHUNK_PAUSE));

      let vectors;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(`${getGatewayBase()}/embeddings`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ input: chunk, model: this.model }),
          signal: opts.abortSignal,
        });

        if (res.ok) {
          const data = await res.json();
          const sorted = (data.data || []).sort((a, b) => a.index - b.index);
          vectors = sorted.map(d => d.embedding);
          break;
        }

        // 402 = no credits — abort the whole batch loop immediately.
        await throwIfQuotaExceeded(res);

        if (res.status === 429 && attempt < MAX_RETRIES) {
          // Respect Retry-After header; default to 60s (gateway says "retry in 1 minute")
          const retryAfter = parseInt(res.headers.get('retry-after'), 10);
          const wait = (retryAfter > 0 ? retryAfter : 60) * 1000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        const body = await res.text().catch(() => '');
        throw new Error(`Gateway embedding error (${res.status}): ${body}`);
      }

      allVectors.push(...vectors);
    }

    return allVectors;
  }
}

// ── GatewaySearch ────────────────────────────────────────────────────────────

export class GatewaySearch extends BaseSearch {
  constructor() {
    super({ _gateway: true }, 'gateway-search');
  }

  get providerName() { return 'koi-gateway'; }

  async search(query, opts = {}) {
    const res = await fetch(`${getGatewayBase()}/search`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        query,
        count: opts.count || 5,
      }),
      signal: opts.abortSignal,
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway search error (${res.status}): ${body}`);
    }

    const data = await res.json();
    // Backend returns a flat array; wrap in { results } for consistency with other providers
    return { results: Array.isArray(data) ? data : (data.results || []) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GatewayImageGen — Unified image generation via gateway
//
// Accepts ANY image model (gpt-image-1, gemini-3.1-flash-image-preview, etc.)
// The gateway backend routes to the correct provider.
// Capabilities are resolved dynamically from models.json mediaCaps.
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayImageGen extends BaseImageGen {
  constructor(model = 'auto') {
    super({ _gateway: true }, model);
  }

  get providerName() { return 'koi-gateway'; }

  // UNKNOWN ≠ ZERO, and unknown ≠ some number we made up. The backend catalog
  // ships no capability columns today, so every field below is `undefined`
  // unless the catalog actually said something. `undefined` means "unconstrained":
  // callers must NOT clamp, snap or enumerate on it. The per-model parameter
  // contract lives in the `image-generator` / `video-generator` skill docs, which
  // are the single source of truth the agent reads before choosing a model.
  get capabilities() {
    const mc = _getMediaCaps(this.model) || {};
    return {
      referenceImages: mc.referenceImages ?? true,
      maxReferenceImages: mc.maxRefImages ?? undefined,
      edit: mc.edit ?? true,
      aspectRatios: mc.aspectRatios || undefined,
      resolutions: mc.resolutions || undefined,
      qualities: mc.qualities || undefined,
      maxN: mc.maxN ?? undefined,
      outputFormats: mc.outputFormats || undefined,
    };
  }

  async generate(prompt, opts = {}) {
    // Auto-retry on content-policy / safety-filter rejections.
    //
    // When the picker lands on a model whose moderation layer rejects
    // the prompt (gpt-image-2's content checker, Imagen's safety
    // filter, etc.) the failure is the model's choice, not the
    // request's fault — a different model in the same bucket may well
    // accept it. Without this loop the agent has to detect the
    // rejection text, build `excludeModels` manually, and reissue —
    // which it rarely does correctly (the log usually shows three
    // identical retries that all land on the same blocked slug).
    //
    // The loop is bounded by MAX_POLICY_RETRIES so a prompt that
    // EVERY model in the catalog rejects fails cleanly. Excluded
    // slugs accumulate across iterations so the picker keeps cycling
    // forward.
    const MAX_POLICY_RETRIES = 5;
    const _policyExcluded = new Set(
      Array.isArray(opts.excludeModels) ? opts.excludeModels : [],
    );
    let _policyAttempt = 0;
    let _lastError = null;

    while (_policyAttempt < MAX_POLICY_RETRIES) {
      const _attemptOpts = {
        ...opts,
        excludeModels: [..._policyExcluded],
      };

      let resolvedModel;
      try {
        resolvedModel = await _resolveMediaModel('image', this.model, _attemptOpts, (models, req) =>
          import('./media-model-router.js').then(({ pickImageModel, MediaModelRoutingError }) => {
            try {
              return pickImageModel(models, req);
            } catch (e) {
              if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
              throw e;
            }
          }),
          {
            n: _attemptOpts.n,
            resolution: _attemptOpts.resolution,
            aspectRatio: _attemptOpts.aspectRatio,
            refsCount: _attemptOpts.referenceImages?.length || 0,
            label: _attemptOpts.label,
            // Agent-side intent — pickImageModel maps this to the curated
            // category bucket (e.g. 'outpaint' → 'image_extend'). Tolerate
            // the legacy `opts.operation` key during the rename rollout.
            intent: _attemptOpts.intent ?? _attemptOpts.operation,
            excludeModels: _attemptOpts.excludeModels,
            // Forwarded so pickImageModel can short-circuit to the
            // camera-angle LoRA when these sliders are present (any
            // other image-edit model would ignore them and return the
            // input unchanged).
            cameraAngles: _attemptOpts.cameraAngles,
            // Presence flags consumed by `_filterByRequires` to drop
            // adapters whose declared `requires` map doesn't cover an
            // input the caller wired into the request. Kept as booleans
            // (not the values themselves) — the router doesn't need the
            // payload, just the "is this present" signal.
            hasMaskImage: !!_attemptOpts.maskImage,
            hasSourceImage: !!_attemptOpts.sourceImage,
            hasTargetSize: !!(_attemptOpts.targetSize?.width && _attemptOpts.targetSize?.height),
            hasSourceImageOffset: !!(_attemptOpts.sourceImageOffset
              && typeof _attemptOpts.sourceImageOffset.x === 'number'
              && typeof _attemptOpts.sourceImageOffset.y === 'number'),
          },
        );
      } catch (resolveErr) {
        // Picker exhausted. Surface the original content-policy error
        // (if any) so the agent sees WHY the catalog drained; the
        // bare "no_model_matches" doesn't make the policy-cascade
        // explicit. When no policy error preceded this (first
        // resolve failed), rethrow the resolve error as-is.
        if (_lastError) throw _lastError;
        throw resolveErr;
      }

      // Log the resolved slug BEFORE submitting, so a content-checker
      // 4xx or any other downstream failure can be traced back to a
      // specific slug. Retries get a marker so the cascade is obvious
      // in the log.
      channel.log(
        'image',
        _policyAttempt === 0
          ? `Model resolved → ${resolvedModel}`
          : `Model resolved → ${resolvedModel} (retry ${_policyAttempt} after content-policy rejection by [${[..._policyExcluded].join(', ')}])`,
      );

      // Only include fields that the gateway/fal understand — omit undefined/unsupported
      const payload = { model: resolvedModel, prompt };
      if (opts.n && opts.n > 1) payload.num_images = opts.n;
      if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;
      if (opts.outputFormat) payload.output_format = opts.outputFormat;
      // resolution/quality are passed through to the Fal model as-is.
      if (opts.resolution) payload.resolution = opts.resolution;
      // Quality knob — separate from resolution (pixel count). Used by
      // openai/gpt-image-2(-edit); fal slugs that don't expose an
      // equivalent ignore it. Forwarded only when the caller set it
      // explicitly so unset → adapter falls back to deriving quality
      // from resolution (legacy behaviour).
      if (typeof opts.quality === 'string') {
        const q = opts.quality.toLowerCase();
        if (q === 'low' || q === 'medium' || q === 'high' || q === 'auto') {
          payload.quality = q;
        }
      }
      // Seed propagation — fal image adapters (flux, seedream, etc)
      // expose a `seed` parameter that locks the noise tensor; reusing
      // the same seed across sibling calls keeps character / style
      // consistency stable. Forward when explicitly set; otherwise
      // omit so the provider rolls a fresh seed.
      if (typeof opts.seed === 'number' && Number.isFinite(opts.seed)) {
        payload.seed = Math.floor(opts.seed);
      }

      if (opts.referenceImages?.length) {
        payload.reference_images = opts.referenceImages.map(ref => ({
          data: typeof ref.data === 'string' ? ref.data : ref.data.toString('base64'),
          mime_type: ref.mimeType || 'image/png',
        }));
      }
      if (opts.maskImage) {
        const m = opts.maskImage;
        payload.mask_image = {
          data: typeof m.data === 'string' ? m.data : m.data.toString('base64'),
          mime_type: m.mimeType || 'image/png',
        };
      }
      if (opts.sourceImage) {
        const s = opts.sourceImage;
        payload.source_image = {
          data: typeof s.data === 'string' ? s.data : s.data.toString('base64'),
          mime_type: s.mimeType || 'image/png',
        };
      }
      if (opts.targetSize?.width && opts.targetSize?.height) {
        payload.target_size = {
          width: opts.targetSize.width,
          height: opts.targetSize.height,
        };
      }
      if (opts.sourceImageOffset
          && typeof opts.sourceImageOffset.x === 'number'
          && typeof opts.sourceImageOffset.y === 'number') {
        payload.source_image_offset = {
          x: opts.sourceImageOffset.x,
          y: opts.sourceImageOffset.y,
        };
      }
      // Camera-angle sliders for view-synthesis models. Forwarded as a
      // typed object; the backend's `canonicalizeImagePayload` reads it
      // and only the qwen-image-edit-2511-multiple-angles adapter
      // currently consumes it. Other adapters ignore the field. Each
      // axis is independently optional — only forward the keys actually
      // present in opts.cameraAngles.
      if (opts.cameraAngles && typeof opts.cameraAngles === 'object') {
        const picked = {};
        if (typeof opts.cameraAngles.horizontal === 'number') picked.horizontal = opts.cameraAngles.horizontal;
        if (typeof opts.cameraAngles.vertical === 'number') picked.vertical = opts.cameraAngles.vertical;
        if (typeof opts.cameraAngles.zoom === 'number') picked.zoom = opts.cameraAngles.zoom;
        if (Object.keys(picked).length > 0) {
          payload.camera_angles = picked;
          channel.log('image', `[cameraAngles] gateway → backend payload: ${JSON.stringify(picked)}`);
        }
      }

      // Model-specific escape hatch: forward as a NESTED object (backend adapter
      // merges it into the fal input; top-level unknown keys would be dropped).
      if (opts.extraParams && typeof opts.extraParams === 'object' && !Array.isArray(opts.extraParams)) {
        payload.extra_params = opts.extraParams;
      }

      // Submit + poll. The sync `/media/image/generate` endpoint exists for
      // fast slugs, but Railway's edge proxy ~100s timeout cuts long calls
      // (gpt-image-2 with refs) before fal returns — using the queue path
      // avoids that entirely.
      try {
        const submitRes = await fetch(`${getGatewayBase()}/media/image/submit`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload),
          signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
        });

        await throwIfQuotaExceeded(submitRes);
        if (!submitRes.ok) {
          const bodyText = await submitRes.text().catch(() => '');
          let structured = null;
          try { structured = JSON.parse(bodyText); } catch {}
          const err = new Error(
            structured?.error || `Gateway image submit error (${submitRes.status}): ${bodyText}`,
          );
          err.status = submitRes.status;
          if (structured) err.details = structured;
          throw err;
        }

        const { id } = await submitRes.json();
        if (!id) throw new Error('Gateway image submit returned no id');

        // Poll. Fal usually completes in a few seconds for fast slugs and
        // 30–90s for gpt-image-2 + refs — BUT heavy 4K + multi-reference jobs
        // on nano-banana-pro / gpt-image-2 routinely run several minutes under
        // load (observed real gens >5 min), and a wall-clock cap surfaced a
        // client error even when the image DID finish server-side. This poll
        // runs in the background (generate_image is a backgrounded action),
        // so there's nothing to unblock by giving up — we wait while the job
        // is alive (IN_QUEUE / IN_PROGRESS) and let the backend either return
        // the image or report FAILED. A finite cap can still be forced via
        // KOI_IMAGE_POLL_TIMEOUT_MS (milliseconds); unset / 0 ⇒ no deadline.
        const _imgPollTimeoutMs = Number(process.env.KOI_IMAGE_POLL_TIMEOUT_MS);
        const _imgHasDeadline = Number.isFinite(_imgPollTimeoutMs) && _imgPollTimeoutMs > 0;
        const pollDeadline = _imgHasDeadline ? Date.now() + _imgPollTimeoutMs : Infinity;
        let pollDelay = 1500;
        // With no wall-clock cap a slow job runs hundreds of polls, so a
        // single transient blip (network drop, gateway 5xx/429) must not
        // kill a job that's still alive server-side. Tolerate a handful of
        // CONSECUTIVE transient failures, resetting on any good response.
        // FAILED status, auth/quota and other 4xx stay fatal-immediate.
        const MAX_POLL_ERRORS = 8;
        let pollErrors = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (_imgHasDeadline && Date.now() > pollDeadline) {
            throw new Error(`Gateway image timeout after ${Math.round(_imgPollTimeoutMs / 60000)} min waiting on ${id}`);
          }
          await new Promise(r => setTimeout(r, pollDelay));
          pollDelay = Math.min(pollDelay * 1.4, 5000);

          let pollRes;
          try {
            pollRes = await fetch(
              `${getGatewayBase()}/media/image/result?id=${encodeURIComponent(id)}`,
              { headers: getAuthHeaders(), signal: _stallSignal(opts.abortSignal, _MEDIA_POLL_TIMEOUT_MS) },
            );
          } catch (netErr) {
            if (opts.abortSignal?.aborted) throw netErr;
            if (++pollErrors >= MAX_POLL_ERRORS) throw netErr;
            continue; // transient network error — the job may still be alive
          }
          await throwIfQuotaExceeded(pollRes);
          if (!pollRes.ok) {
            const _transient = pollRes.status >= 500 || pollRes.status === 408 || pollRes.status === 429;
            if (_transient && ++pollErrors < MAX_POLL_ERRORS) continue;
            const bodyText = await pollRes.text().catch(() => '');
            let structured = null;
            try { structured = JSON.parse(bodyText); } catch {}
            const err = new Error(
              structured?.error || `Gateway image poll error (${pollRes.status}): ${bodyText}`,
            );
            err.status = pollRes.status;
            if (structured) err.details = structured;
            throw err;
          }
          pollErrors = 0;
          const data = await pollRes.json();
          if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') {
            // Bubble the raw fal status up to the caller (the tool layer)
            // so it can forward it to the chat banner. The callback is
            // best-effort observability — errors must not abort the poll.
            if (typeof opts.onStatus === 'function') {
              try {
                opts.onStatus({
                  falStatus: data.status,
                  queuePosition: typeof data.queuePosition === 'number'
                    ? data.queuePosition
                    : undefined,
                });
              } catch { /* non-fatal */ }
            }
            continue;
          }
          if (data.status === 'FAILED') {
            const err = new Error(data.error || `Image generation failed (${id})`);
            err.status = 502;
            err.failedModel = resolvedModel;
            throw err;
          }
          const images = _collectImages(data);
          const ret = { images, usage: data.usage || { input: 0, output: 0 }, model: resolvedModel };
          // Forward per-creation billing fields verbatim — the backend's
          // /media/image/result handler stamps `creditsCost` (USD × 100,
          // 4-decimal precision) and `providerRequestId` (fal request id)
          // on every COMPLETED payload. `generate-image.js` reads them
          // off this return value and pins them into the saved media
          // metadata so the GUI's Info panel can render "Cost: X
          // credits" without an extra roundtrip. Dropping them here
          // (the prior shape kept only images/usage/model) is exactly
          // why generated images came back to the engine with no cost
          // info — the data was there, the wrapper just didn't pass
          // it through.
          if (typeof data.creditsCost === 'number') ret.creditsCost = data.creditsCost;
          if (typeof data.providerRequestId === 'string') ret.providerRequestId = data.providerRequestId;
          if (images.length === 0) ret.raw = data;
          return ret;
        }
      } catch (callErr) {
        // Input-shape mismatch is MECHANICAL (the picker landed on a model
        // whose adapter requires inputs the canonical request didn't carry).
        // A different shape-family model in the same bucket may fit, and
        // these errors return fast, so exclude this slug and walk to the
        // next-best — the cascade is cheap.
        if (_isInputShapeError(callErr)) {
          _policyExcluded.add(resolvedModel);
          _lastError = callErr;
          _policyAttempt += 1;
          channel.log(
            'image',
            `input-shape reject from ${resolvedModel} (${(callErr.message || '').slice(0, 120)}) — trying next-best model`,
          );
          continue;
        }
        // Content-policy / safety rejection: STOP immediately — do NOT
        // cascade through fallback models. Silently re-routing across up to
        // MAX_POLICY_RETRIES models (each a multi-minute call) is the
        // reported bug: the GUI banner spun ~8 min on a job that was already
        // blocked, with zero feedback, and the user only found out by
        // killing it manually. By product decision a moderation block is
        // TERMINAL and user-facing. Throw a classified error → generate-
        // image.js maps it to a blocked result → the banner wrapper fires
        // mediaToolEnd (spinner closes at once) → the agent surfaces it to
        // the user and asks how to proceed, instead of churning models or
        // retrying the same flagged concept.
        if (_isContentPolicyError(callErr)) {
          channel.log(
            'image',
            `content-policy reject from ${resolvedModel} (${(callErr.message || '').slice(0, 120)}) — STOPPING (no fallback) and surfacing to the user`,
          );
          const err = new Error(
            `Image generation blocked by ${resolvedModel}'s content policy: ${callErr.message}`,
          );
          err.cause = callErr;
          err.contentPolicyBlocked = true;
          err.blockedModel = resolvedModel;
          throw err;
        }
        // Any other failure (network, timeout, provider 500, …): don't
        // retry. Switching models won't help and would burn quota.
        throw callErr;
      }
    }

    // All MAX_POLICY_RETRIES cycles exhausted with policy rejections.
    // Surface the LAST policy error verbatim so the agent / user
    // sees the actual reject message, not a generic "all retries failed".
    if (_lastError) {
      const err = new Error(
        `Image generation refused by ${_policyExcluded.size} model(s) on content-policy grounds. ` +
        `Last error: ${_lastError.message}. Excluded: [${[..._policyExcluded].join(', ')}].`,
      );
      err.cause = _lastError;
      err.policyExhausted = true;
      err.excludedModels = [..._policyExcluded];
      throw err;
    }
    // Unreachable in practice (we either return on success or hit
    // the throw above), but keep a safety throw.
    throw new Error('Image generation failed: max retries exhausted without a recorded error');
  }

  /**
   * Run a semantic image operation (bg-remove, upscale, inpaint, …) against
   * whichever active model lives in the matching Koi category (mapped by
   * pickImageModel: `bg-remove`/`background-removal`/`rembg` →
   * `image_background_removal`, `upscale`/`upscaling` → `image_upscaling`,
   * `outpaint`/`extend` → `image_extend`, `edit`/`inpaint` →
   * `image_editing`). Unlike `generate`, the input shape depends on the
   * concrete Fal model — most take just `image_url` (no prompt, no
   * aspect ratio). We post through /gateway/fal/raw which uploads a
   * base64 data URI to Fal storage and forwards the call verbatim.
   *
   * @param {string} operation - e.g. 'background-removal', 'upscale'
   * @param {string|Buffer} image - data URI ("data:image/png;base64,...")
   *   or raw base64 string or Buffer. A plain base64 string is wrapped in
   *   a data URI before posting.
   */
  async runOperation(operation, image, opts = {}) {
    // Normalize to a base64 data URI so /fal/raw can upload it to Fal.
    let dataUri;
    if (Buffer.isBuffer(image)) {
      dataUri = `data:image/png;base64,${image.toString('base64')}`;
    } else if (typeof image === 'string') {
      dataUri = image.startsWith('data:')
        ? image
        : `data:image/png;base64,${image}`;
    } else {
      throw new Error('runOperation: image must be a data URI, base64 string, or Buffer');
    }

    const resolvedModel = await _resolveMediaModel('image', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickImageModel, MediaModelRoutingError }) => {
        try {
          return pickImageModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      // bg-remove / upscale flows: the source `image` IS a reference,
      // just transported as `image_url` in the payload instead of
      // `referenceImages[]`. Tell the router so adapters declaring
      // `referenceImages: 'required'` (bria, pixelcut, recraft, topaz)
      // aren't excluded.
      { intent: operation, refsCount: 1 },
    );

    // /fal/raw expects { model, ...passthroughInput }. Most BG-remove /
    // upscaler models take `image_url`; we set it here and let Fal-side
    // input validation reject if a model needs a different field (rare).
    const payload = { model: resolvedModel, image_url: dataUri };
    if (opts.outputFormat) payload.output_format = opts.outputFormat;

    // Upscaler options — map the provider-neutral contract (see
    // tools/media/upscale-image.js) to Fal field names. Unknown-to-Fal
    // fields are harmless (Fal's input validation rejects extras only
    // when strictInput is on, which the upscaler schemas don't use).
    if (operation === 'upscale') {
      if (typeof opts.upscaleFactor === 'number') {
        payload.upscale_factor = opts.upscaleFactor;
      }
      if (typeof opts.prompt === 'string' && opts.prompt.length > 0) {
        payload.prompt = opts.prompt;
      }
      if (typeof opts.creativity === 'number') {
        // Normalize 0–1 → Topaz's 1–6 integer scale. Other upscalers
        // that accept a 0–1 creativity field also get the raw value as
        // a fallback key so they see it too.
        const topazCreativity = Math.max(1, Math.min(6, Math.round(1 + opts.creativity * 5)));
        payload.creativity = topazCreativity;
        payload.creativity_level = opts.creativity; // generic 0–1 fallback
      }
      if (typeof opts.faceEnhancement === 'boolean') {
        payload.face_enhancement = opts.faceEnhancement;
      }
      // Source pixel dims (probed by the upscale tool). Generative "upscalers"
      // (nano-banana-pro) have no scale-factor knob and render at a fixed
      // resolution LABEL, so the backend adapter maps source*factor to the
      // nearest label. Harmless to Topaz/Recraft (they ignore unknown fields).
      if (typeof opts.sourceWidth === 'number') payload.source_width = opts.sourceWidth;
      if (typeof opts.sourceHeight === 'number') payload.source_height = opts.sourceHeight;
      // Escape hatch for model-specific fields (Topaz model variant,
      // texture, subject_detection, denoise, …). Object.assign after the
      // normalized keys so callers can override if they really mean to.
      if (opts.extra && typeof opts.extra === 'object') {
        for (const [k, v] of Object.entries(opts.extra)) {
          if (v !== undefined) payload[k] = v;
        }
      }
    }

    const res = await fetch(`${getGatewayBase()}/fal/raw`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
      signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let structured = null;
      try { structured = JSON.parse(bodyText); } catch {}
      // Pick the most specific message available. Fastify's default error
      // formatter returns `{ statusCode, error: "Unprocessable Entity",
      // message: "..." }` where the useful text lives in `message` — if
      // we prefer `error` we end up with a meaningless "Unprocessable
      // Entity" label. The backend's handleError was updated to emit
      // `{error, provider, upstreamStatus, upstreamBody}` for upstream
      // provider failures so `structured.error` is now informative; fall
      // back to `message` for legacy shapes, then the raw text.
      const msg =
        structured?.error ||
        structured?.message ||
        `Gateway ${operation} error (${res.status}): ${bodyText}`;
      const err = new Error(msg);
      err.status = res.status;
      if (structured) err.details = structured;
      throw err;
    }

    const data = await res.json();
    const images = _collectImages(data);
    const ret = { images, usage: data.usage || { input: 0, output: 0 }, model: resolvedModel };
    // Same billing forwarding as the queue path above — `/gateway/fal/raw`
    // (the sync handler behind bg-remove / upscale / inpaint /
    // gpt-image-2 edits) stamps `creditsCost` + `providerRequestId` on
    // the response. Without this the operations branch ate the cost
    // info too.
    if (typeof data.creditsCost === 'number') ret.creditsCost = data.creditsCost;
    if (typeof data.providerRequestId === 'string') ret.providerRequestId = data.providerRequestId;
    return ret;
  }

}

// ─────────────────────────────────────────────────────────────────────────────
// GatewayAudioGen — Unified audio generation via gateway
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayAudioGen extends BaseAudioGen {
  constructor(model = 'auto') {
    super({ _gateway: true }, model);
  }

  get providerName() { return 'koi-gateway'; }

  /** Submit an audio job to the backend's queue endpoint, then poll
   *  /media/audio/<kind>/result until COMPLETED or FAILED. Mirrors the
   *  image submit+poll path in GatewayImageGen so the runtime can
   *  surface fal's IN_QUEUE / IN_PROGRESS state to the chat banner.
   *
   *  `kind` is the URL fragment ('speech' / 'sfx' / 'music'). `body` is
   *  the JSON payload — same canonical shape the legacy sync handlers
   *  accept (so we share the kind→canonical mapping with the backend).
   *  `opts.onStatus(info)` is invoked on every IN_QUEUE / IN_PROGRESS
   *  poll so the tool layer can forward to the banner. Errors inside
   *  onStatus MUST NOT abort the poll.
   *
   *  Returns: { buffer: Buffer, format: string, model: string,
   *             durationMs?: number, creditsCost?, providerRequestId? }
   */
  async _submitAndPollAudio(kind, body, opts = {}) {
    // Model-specific escape hatch: forward as a NESTED object (backend adapter
    // merges it into the provider input; top-level unknown keys would be dropped).
    if (opts.extraParams && typeof opts.extraParams === 'object' && !Array.isArray(opts.extraParams)) {
      body.extra_params = opts.extraParams;
    }
    const submitRes = await fetch(`${getGatewayBase()}/media/audio/${kind}/submit`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body),
      signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
    });
    await throwIfQuotaExceeded(submitRes);
    if (!submitRes.ok) {
      const bodyText = await submitRes.text().catch(() => '');
      let structured = null;
      try { structured = JSON.parse(bodyText); } catch {}
      const err = new Error(
        structured?.error || `Gateway audio submit error (${submitRes.status}): ${bodyText}`,
      );
      err.status = submitRes.status;
      if (structured) err.details = structured;
      throw err;
    }
    const { id } = await submitRes.json();
    if (!id) throw new Error('Gateway audio submit returned no id');

    // Poll. Speech is usually < 10 s, sfx 5–30 s, music 30–90 s. We wait
    // while the job is alive (IN_QUEUE / IN_PROGRESS) and let the backend
    // either return the audio or report FAILED — no wall-clock cap, so a
    // slow-but-live job is never killed mid-flight. A finite cap can be
    // forced via KOI_AUDIO_POLL_TIMEOUT_MS (ms); unset / 0 ⇒ no deadline.
    const _audPollTimeoutMs = Number(process.env.KOI_AUDIO_POLL_TIMEOUT_MS);
    const _audHasDeadline = Number.isFinite(_audPollTimeoutMs) && _audPollTimeoutMs > 0;
    const pollDeadline = _audHasDeadline ? Date.now() + _audPollTimeoutMs : Infinity;
    let pollDelay = 1200;
    // Tolerate transient blips on long waits (see image poll above).
    const MAX_POLL_ERRORS = 8;
    let pollErrors = 0;
    while (true) {
      if (_audHasDeadline && Date.now() > pollDeadline) {
        throw new Error(`Gateway audio timeout after ${Math.round(_audPollTimeoutMs / 60000)} min waiting on ${id}`);
      }
      await new Promise(r => setTimeout(r, pollDelay));
      pollDelay = Math.min(pollDelay * 1.4, 4000);

      let pollRes;
      try {
        pollRes = await fetch(
          `${getGatewayBase()}/media/audio/${kind}/result?id=${encodeURIComponent(id)}`,
          { headers: getAuthHeaders(), signal: _stallSignal(opts.abortSignal, _MEDIA_POLL_TIMEOUT_MS) },
        );
      } catch (netErr) {
        if (opts.abortSignal?.aborted) throw netErr;
        if (++pollErrors >= MAX_POLL_ERRORS) throw netErr;
        continue; // transient network error — the job may still be alive
      }
      await throwIfQuotaExceeded(pollRes);
      if (!pollRes.ok) {
        const _transient = pollRes.status >= 500 || pollRes.status === 408 || pollRes.status === 429;
        if (_transient && ++pollErrors < MAX_POLL_ERRORS) continue;
        const bodyText = await pollRes.text().catch(() => '');
        let structured = null;
        try { structured = JSON.parse(bodyText); } catch {}
        const err = new Error(
          structured?.error || `Gateway audio poll error (${pollRes.status}): ${bodyText}`,
        );
        err.status = pollRes.status;
        if (structured) err.details = structured;
        throw err;
      }
      pollErrors = 0;
      const data = await pollRes.json();
      if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') {
        if (typeof opts.onStatus === 'function') {
          try {
            opts.onStatus({
              falStatus: data.status,
              queuePosition: typeof data.queuePosition === 'number'
                ? data.queuePosition
                : undefined,
            });
          } catch { /* non-fatal */ }
        }
        continue;
      }
      if (data.status === 'FAILED') {
        const err = new Error(data.error || `Audio generation failed (${id})`);
        err.status = 502;
        err.failedModel = data.model;
        throw err;
      }
      // COMPLETED
      if (!data.audioBase64) {
        throw new Error(`Gateway audio result missing audioBase64 (${id})`);
      }
      const buffer = Buffer.from(data.audioBase64, 'base64');
      return {
        buffer,
        format: data.format || 'audio/mpeg',
        model: data.model,
        ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
        ...(typeof data.creditsCost === 'number' ? { creditsCost: data.creditsCost } : {}),
        ...(typeof data.providerRequestId === 'string' ? { providerRequestId: data.providerRequestId } : {}),
      };
    }
  }

  async speech(text, opts = {}) {
    const resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
        try {
          return pickAudioModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      {
        kind: 'tts',
        label: opts.label,
        // Presence flags for `_filterByRequires` (AudioRequires keys).
        // Lets the router drop TTS adapters that don't honour the knob
        // the caller actually wired up.
        hasVoice: !!opts.voice,
        hasLanguage: !!opts.language,
        hasEmotion: !!opts.emotion,
        pitch: opts.pitch,
        volume: opts.volume,
        speed: opts.speed,
      },
    );

    const body = {
      model: resolvedModel,
      text,
      ...(opts.voice ? { voice: opts.voice } : {}),
      outputFormat: opts.outputFormat || 'mp3',
      ...(typeof opts.speed === 'number' ? { speed: opts.speed } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.emotion ? { emotion: opts.emotion } : {}),
      ...(typeof opts.pitch === 'number' ? { pitch: opts.pitch } : {}),
      ...(typeof opts.volume === 'number' ? { volume: opts.volume } : {}),
    };
    const result = await this._submitAndPollAudio('speech', body, {
      onStatus: opts.onStatus,
      abortSignal: opts.abortSignal,
      extraParams: opts.extraParams,
    });
    const ret = {
      audio: result.buffer,
      format: opts.outputFormat || 'mp3',
      usage: { characters: text.length },
      model: result.model || resolvedModel,
    };
    if (typeof result.creditsCost === 'number') ret.creditsCost = result.creditsCost;
    if (typeof result.providerRequestId === 'string') ret.providerRequestId = result.providerRequestId;
    if (typeof result.durationMs === 'number') ret.durationMs = result.durationMs;
    return ret;
  }

  /** Transcribe a speech sample. Two-step: upload bytes to fal storage,
   *  then call /media/audio/transcribe with the resulting URL.
   *
   *  `audio` is the canonical input — accepts either a Buffer (raw bytes,
   *  the common case from a tool reading a local file) or an `https://` URL
   *  (skip the upload, send straight). `opts.audioUrl` is honoured the
   *  same way for callers that already have a hosted sample.
   *
   *  Returns: { text, language?, segments?, usage }. `language` is the
   *  detected language code when the provider reports one — Whisper sets
   *  it via `inferred_languages[0]`, Scribe via `language_code`. The
   *  agent uses it to localise the voice-clone preview text.
   */
  async transcribe(audio, opts = {}) {
    const resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
        try {
          return pickAudioModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      { kind: 'transcribe', label: opts.label },
    );

    // Resolve audio → URL. Bypass the upload when the caller already
    // gave us a URL (e.g. a fal preview from a previous step).
    let audioUrl = opts.audioUrl;
    if (!audioUrl && typeof audio === 'string' && /^https?:\/\//i.test(audio)) {
      audioUrl = audio;
    }
    if (!audioUrl) {
      if (!Buffer.isBuffer(audio)) {
        throw new Error('transcribe: pass a Buffer of audio bytes or opts.audioUrl');
      }
      const filename = opts.sampleFilename || 'audio.mp3';
      const mime = opts.sampleMimeType || _audioMimeFromFilename(filename);
      const uploadHeaders = { ...getAuthHeaders() };
      delete uploadHeaders['content-type'];
      delete uploadHeaders['Content-Type'];
      uploadHeaders['Content-Type'] = mime;
      const uploadRes = await fetch(
        `${getGatewayBase()}/uploads/audio?filename=${encodeURIComponent(filename)}`,
        { method: 'POST', headers: uploadHeaders, body: audio, signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS) },
      );
      await throwIfQuotaExceeded(uploadRes);
      if (!uploadRes.ok) {
        const body = await uploadRes.text().catch(() => '');
        throw new Error(`Gateway audio upload error (${uploadRes.status}): ${body}`);
      }
      const uploaded = await uploadRes.json();
      audioUrl = uploaded.url;
    }

    const res = await fetch(`${getGatewayBase()}/media/audio/transcribe`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: resolvedModel,
        audio_url: audioUrl,
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.task ? { task: opts.task } : {}), // 'transcribe' (default) or 'translate'
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.diarize ? { diarize: true } : {}),
        ...(opts.numSpeakers ? { num_speakers: opts.numSpeakers } : {}),
      }),
      signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway transcribe error (${res.status}): ${body}`);
    }

    const data = await res.json();
    return {
      text: data.text || '',
      language: data.language || undefined,
      segments: data.segments || data.chunks || undefined,
      model: data.model || resolvedModel,
      usage: { duration: data.duration || 0 },
    };
  }

  /** Generate a sound effect from a text prompt. Single-shot POST to
   *  /media/audio/sfx — the backend resolves the per-category adapter
   *  (ElevenLabs sound-effects v2, etc.) and returns audio bytes inline.
   *
   *  Returns: { audio: Buffer, format, usage }.
   */
  async sfx(prompt, opts = {}) {
    const hasVideoRef = !!opts.videoUrl;
    let resolvedModel;
    let usingVideoRef = hasVideoRef;
    try {
      resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
        import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
          try {
            return pickAudioModel(models, req);
          } catch (e) {
            if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
            throw e;
          }
        }),
        {
          kind: 'sfx',
          label: opts.label,
          hasVideoRef: usingVideoRef,
          // AudioRequires presence flags. `hasVideoUrl` lets the
          // router drop pure text-to-sfx adapters (mmaudio text-only)
          // when the caller wired up a reference video, AND drop
          // video-conditioned-only adapters (controlfoley) when they
          // didn't. `loop` lets it pick elevenlabs-sound-effects-v2
          // specifically when the user asked for a seamless loop.
          hasVideoUrl: !!usingVideoRef,
          loop: opts.loop,
        },
      );
    } catch (err) {
      // Graceful fallback: caller asked for video-conditioned SFX but no
      // active model has `input_video: true` (likely a catalog-config gap
      // — e.g. fal-ai/mmaudio-v2 not activated, or activated without the
      // input_video flag). Rather than failing the whole call, retry once
      // with the constraint dropped and surface a warning. The agent
      // gets text-only audio that's at least usable; the user gets a
      // signal in the logs that the catalog needs fixing.
      const isNoMatch = err && err.details && err.details.code === 'no_model_matches';
      if (!hasVideoRef || !isNoMatch) throw err;
      console.warn(
        '[gateway/sfx] no audio model with input_video=true is active; ' +
        'falling back to text-only SFX. To enable video-conditioned SFX activate ' +
        '"fal-ai/mmaudio-v2" (base slug) in model_prices and set input_video=true.',
      );
      usingVideoRef = false;
      resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
        import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
          try {
            return pickAudioModel(models, req);
          } catch (e) {
            if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
            throw e;
          }
        }),
        { kind: 'sfx', label: opts.label, hasVideoRef: false, hasVideoUrl: false, loop: opts.loop },
      );
    }

    // Surface WHICH SFX model the router actually picked. The koi-cli
    // log line above only shows the upstream alias `koi-gateway/auto`;
    // the real model name (e.g. `fal-ai/mmaudio-v2`, `elevenlabs/sound-
    // effects-2`, …) lives behind that and matters when the call
    // fails with a 502/504 — different models have different proxy
    // budgets and capabilities.
    try {
      console.log(
        `[gateway/sfx] picked model: ${resolvedModel} ` +
        `(videoRef=${usingVideoRef ? 'yes' : 'no'})`,
      );
    } catch (_) {}

    // Build canonical body — videoUrl is always forwarded when the
    // caller provided one, regardless of `usingVideoRef`. The router's
    // `usingVideoRef` flag only controls model selection; the adapter
    // server-side decides whether to consume or ignore the field.
    const body = {
      model: resolvedModel,
      prompt,
      outputFormat: opts.outputFormat || 'mp3',
      ...(typeof opts.durationSeconds === 'number' ? { durationSeconds: opts.durationSeconds } : {}),
      ...(typeof opts.promptInfluence === 'number' ? { promptInfluence: opts.promptInfluence } : {}),
      ...(typeof opts.loop === 'boolean' ? { loop: opts.loop } : {}),
      ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
      ...(opts.videoUrl ? { videoUrl: opts.videoUrl } : {}),
    };
    try {
      console.log(
        `[gateway/sfx] sending body keys=${JSON.stringify(Object.keys(body))} ` +
        `usingVideoRef=${usingVideoRef}`,
      );
    } catch (_) {}

    // submit+poll via /media/audio/sfx/submit + /result — bypasses the
    // proxy timeout that bit video-conditioned SFX with the sync path,
    // and pipes IN_QUEUE / IN_PROGRESS through opts.onStatus so the
    // chat banner can pause its timer while queued.
    const result = await this._submitAndPollAudio('sfx', body, {
      onStatus: opts.onStatus,
      abortSignal: opts.abortSignal,
      extraParams: opts.extraParams,
    });
    const ret = {
      audio: result.buffer,
      format: opts.outputFormat || 'mp3',
      usage: { characters: prompt.length },
      model: result.model || resolvedModel,
    };
    if (typeof result.creditsCost === 'number') ret.creditsCost = result.creditsCost;
    if (typeof result.providerRequestId === 'string') ret.providerRequestId = result.providerRequestId;
    if (typeof result.durationMs === 'number') ret.durationMs = result.durationMs;
    return ret;
  }

  /** Generate music from a text prompt. Distinct from sfx(): music is
   *  text-only (no video conditioning today), uses its own backend route
   *  and adapter kind. Single-shot POST to /media/audio/music — the
   *  backend resolves the per-slug adapter (ElevenLabs Music, etc.) and
   *  returns audio bytes inline.
   *
   *  Returns: { audio: Buffer, format, usage }.
   */
  async music(prompt, opts = {}) {
    const resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
        try {
          return pickAudioModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      {
        kind: 'music',
        label: opts.label,
        // AudioRequires presence — instrumental only present when caller
        // explicitly opted in/out; type:boolean check mirrors the body
        // assembly below so the router's filter stays in sync.
        instrumental: opts.instrumental,
      },
    );

    const body = {
      model: resolvedModel,
      prompt,
      outputFormat: opts.outputFormat || 'mp3',
      ...(typeof opts.durationSeconds === 'number' ? { durationSeconds: opts.durationSeconds } : {}),
      ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
    };
    const result = await this._submitAndPollAudio('music', body, {
      onStatus: opts.onStatus,
      abortSignal: opts.abortSignal,
      extraParams: opts.extraParams,
    });
    const ret = {
      audio: result.buffer,
      format: opts.outputFormat || 'mp3',
      usage: { characters: prompt.length },
      model: result.model || resolvedModel,
    };
    if (typeof result.creditsCost === 'number') ret.creditsCost = result.creditsCost;
    if (typeof result.providerRequestId === 'string') ret.providerRequestId = result.providerRequestId;
    if (typeof result.durationMs === 'number') ret.durationMs = result.durationMs;
    return ret;
  }

  /** Clone a voice from a sample. Two-step: upload the sample bytes to
   *  fal storage via /uploads/audio, then call /media/audio/voice-clone
   *  with the canonical request. The backend resolves the per-model
   *  adapter (ElevenLabs / PlayAI / generic) and normalises the
   *  response, so this method is provider-agnostic.
   *
   *  Returns: { voiceId, model, name?, sampleUrl?, provider }.
   */
  async cloneVoice(audioBuffer, opts = {}) {
    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('cloneVoice: audioBuffer must be a Buffer');
    }
    const resolvedModel = await _resolveMediaModel('audio', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickAudioModel, MediaModelRoutingError }) => {
        try {
          return pickAudioModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      { kind: 'voice-clone', label: opts.label },
    );

    // Step 1: upload the sample to fal storage so the actual clone call
    // can reference it by URL (cheaper, and fal models expect URLs not
    // base64 for audio inputs above ~1 MB).
    const filename = opts.sampleFilename || 'sample.mp3';
    const mime = opts.sampleMimeType || _audioMimeFromFilename(filename);
    const uploadHeaders = { ...getAuthHeaders() };
    delete uploadHeaders['content-type'];
    delete uploadHeaders['Content-Type'];
    uploadHeaders['Content-Type'] = mime;
    const uploadRes = await fetch(
      `${getGatewayBase()}/uploads/audio?filename=${encodeURIComponent(filename)}`,
      { method: 'POST', headers: uploadHeaders, body: audioBuffer, signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS) },
    );
    await throwIfQuotaExceeded(uploadRes);
    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => '');
      throw new Error(`Gateway audio upload error (${uploadRes.status}): ${body}`);
    }
    const { url: sampleUrl } = await uploadRes.json();

    // Step 2: trigger the clone. Backend handleVoiceClone runs the
    // canonical request through the right per-model adapter.
    const cloneRes = await fetch(`${getGatewayBase()}/media/audio/voice-clone`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: resolvedModel,
        sample_url: sampleUrl,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.labels ? { labels: opts.labels } : {}),
      }),
      signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
    });
    await throwIfQuotaExceeded(cloneRes);
    if (!cloneRes.ok) {
      const body = await cloneRes.text().catch(() => '');
      throw new Error(`Gateway voice-clone error (${cloneRes.status}): ${body}`);
    }
    const data = await cloneRes.json();
    return {
      voiceId: data.voiceId,
      model: data.model || resolvedModel,
      name: data.name,
      sampleUrl: data.sampleUrl || sampleUrl,
      provider: _voiceCloneProviderFromSlug(data.model || resolvedModel),
      // Cost/telemetry the backend stamps on the clone (USD × 100). Was being
      // dropped here, so the cloned-voice creation showed no cost in the UI.
      ...(typeof data.creditsCost === 'number' ? { creditsCost: data.creditsCost } : {}),
      ...(typeof data.providerRequestId === 'string' ? { providerRequestId: data.providerRequestId } : {}),
    };
  }
}

/** Best-effort mime guess from extension when the caller didn't pass
 *  one explicitly. Mirrors the backend's /uploads/audio default. */
function _audioMimeFromFilename(name) {
  const ext = name.toLowerCase();
  if (ext.endsWith('.mp3')) return 'audio/mpeg';
  if (ext.endsWith('.wav')) return 'audio/wav';
  if (ext.endsWith('.ogg')) return 'audio/ogg';
  if (ext.endsWith('.flac')) return 'audio/flac';
  if (ext.endsWith('.aac')) return 'audio/aac';
  if (ext.endsWith('.m4a')) return 'audio/mp4';
  if (ext.endsWith('.webm')) return 'audio/webm';
  return 'audio/mpeg';
}

/** Extract a friendly provider tag from the resolved fal slug. Used
 *  purely for logging / GUI display — generate_audio's voice resolution
 *  uses the model slug directly, so a wrong-but-readable tag here is
 *  harmless. */
function _voiceCloneProviderFromSlug(slug) {
  if (typeof slug !== 'string') return 'fal';
  if (/elevenlabs/i.test(slug)) return 'elevenlabs';
  if (/playai/i.test(slug)) return 'playai';
  if (/openai/i.test(slug)) return 'openai';
  return 'fal';
}

// ─────────────────────────────────────────────────────────────────────────────
// GatewayVideoGen — Unified async video generation via gateway
//
// Accepts ANY video model (sora, kling-v3-0, veo-3.1-generate-preview,
// seedance-2-0-lite, etc.). The gateway backend routes to the correct provider.
// Capabilities are resolved dynamically from models.json mediaCaps.
//
// Async pattern (like fal.ai queue):
//   POST /gateway/media/video/generate → { id, status }
//   GET  /gateway/media/video/status/:id → { id, status, url? }
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayVideoGen extends BaseVideoGen {
  constructor(model = 'auto') {
    super({ _gateway: true }, model);
  }

  get providerName() { return 'koi-gateway'; }

  // UNKNOWN ≠ ZERO, and unknown ≠ some number we made up.
  //
  // This getter used to answer with invented numbers whenever the catalog had
  // nothing to say — and since the backend catalog ships NO capability columns
  // at all (every `constraints` is null), that fallback answered for EVERY
  // model. Seedance 2.0 reference-to-video, which takes up to 9 refs and does
  // real multi-shot, was reported to the agent as `maxReferenceImages: 4`,
  // `durations: [4,5,6,8,10,15,20]`, `maxShots: 1`. The agent believed the tool
  // over the skill doc (correctly — a tool result outranks a doc) and silently
  // downgraded the user's work.
  //
  // So: report only what the catalog actually knows. `undefined` = unconstrained;
  // callers must NOT clamp, snap, enumerate or reject on it. The per-model
  // parameter contract lives in the `video-generator` skill doc.
  get capabilities() {
    const mc = _getMediaCaps(this.model) || {};
    return {
      startFrame: mc.startFrame ?? true,
      endFrame: mc.endFrame ?? true,
      referenceImages: mc.referenceImages ?? true,
      maxReferenceImages: mc.maxRefImages ?? undefined,
      imageToVideo: mc.imageToVideo ?? true,
      videoToVideo: mc.videoToVideo ?? true,
      withAudio: mc.withAudio ?? true,
      aspectRatios: mc.aspectRatios || undefined,
      resolutions: mc.resolutions || undefined,
      qualities: mc.qualities || undefined,
      durations: mc.durations || undefined,
      maxDuration: mc.maxDuration ?? undefined,
      cameraMovements: mc.cameraMovements || undefined,
      maxShots: mc.maxShots ?? undefined,
    };
  }

  /**
   * Resolve the specific model the router would pick for [opts] WITHOUT
   * actually generating. Returns `{ slug, caps }` where `caps` is the
   * picked model's row from the live `/gateway/models/video.json`
   * catalog — `caps.aspectRatios` and `caps.resolutions` are the
   * model-specific lists, NOT the generic union. Lets callers (e.g.
   * the generate_video tool's padding stage) do model-specific work
   * AFTER the auto-router has chosen, instead of guessing from the
   * broad "model=auto" fallback caps.
   *
   * Throws the same routing errors as `generate()`. Idempotent: each
   * call re-runs the router with the given opts, so passing different
   * opts yields different picks.
   */
  async peekResolvedModel(opts = {}) {
    const shots = Array.isArray(opts.shots) && opts.shots.length > 0 ? opts.shots : null;
    const shotCount = shots ? shots.length : 1;
    const slug = await _resolveMediaModel('video', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickVideoModel, MediaModelRoutingError }) => {
        try {
          return pickVideoModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      {
        resolution: opts.resolution,
        aspectRatio: opts.aspectRatio,
        hasStartFrame: !!opts.startFrame?.data || (shots ? shots.some((s) => s.startFrame?.data) : false),
        hasEndFrame:   !!opts.endFrame?.data   || (shots ? shots.some((s) => s.endFrame?.data)   : false),
        withAudio: !!opts.withAudio,
        refsCount: opts.referenceImages?.length || 0,
        videoRefsCount: Array.isArray(opts.referenceVideos) ? opts.referenceVideos.length : 0,
        // Presence flags for `_filterByRequires` — kept in sync with
        // the keys of `VideoRequires` on the adapter side. Without
        // these, adapters declaring imageUrl / audioUrl / characterOrientation
        // as required would silently be excluded.
        hasImageUrl: !!opts.imageUrl,
        hasAudioUrl: !!opts.audioUrl,
        characterOrientation: !!opts.characterOrientation,
        shotCount,
        label: opts.label,
        excludeModels: Array.isArray(opts.excludeModels) ? opts.excludeModels : undefined,
        includeModels: Array.isArray(opts.includeModels) ? opts.includeModels : undefined,
        preferQuality: opts.preferQuality !== false,
        kind: opts.kind,
      },
    );
    // Look the picked slug up in the LIVE media catalog (the same one
    // the router consumed). Going through `_getMediaCaps` instead would
    // hit `/gateway/models.json` (the cost-center catalog), which holds
    // pricing data — its `mediaCaps` field is unset for video rows so
    // the lookup silently returned null and the padding fell back to a
    // generic 1080×1080 envelope.
    let caps = null;
    try {
      const mediaCatalog = await fetchMediaCapabilities('video');
      const row = Array.isArray(mediaCatalog?.models)
        ? mediaCatalog.models.find((m) => m?.slug === slug)
        : null;
      if (row) {
        caps = {
          aspectRatios: row.aspectRatios || [],
          resolutions: row.resolutions || [],
          startFrame: !!row.startFrame,
          endFrame: !!row.endFrame,
          referenceImages: !!row.referenceImages,
          maxRefImages: row.maxRefImages || 0,
          videoToVideo: !!row.videoToVideo,
          imageToVideo: !!row.imageToVideo,
          withAudio: !!row.withAudio,
          maxShots: row.maxShots || 1,
          durations: row.durations || [],
          maxDuration: row.maxDuration || 0,
          // Optional hard floor on INPUT video duration (video-to-video
          // edit models like Kling reject inputs below ~3s even when
          // their nominal `durations` array suggests otherwise). When
          // the catalog declares it, `generate-video.js` uses it to
          // black-pad short reference videos to the floor.
          minInputDurationSec:
            Number.isFinite(row.minInputDurationSec) && row.minInputDurationSec > 0
              ? row.minInputDurationSec
              : 0,
        };
      }
    } catch {
      caps = null;
    }
    return { slug, caps };
  }

  async generate(prompt, opts = {}) {
    // When shots[] is explicit, the shot count becomes a hard filter —
    // the router must pick a model with `maxShots >= shots.length`.
    // Otherwise we only send shotCount=1 (the default) so existing
    // single-clip requests keep selecting from the full pool.
    const shots = Array.isArray(opts.shots) && opts.shots.length > 0 ? opts.shots : null;
    const shotCount = shots ? shots.length : 1;

    // Auto-retry on content-policy / safety-filter rejections — same
    // pattern as GatewayImageGen. Without this loop, the agent LLM has
    // to detect a "blocked" response and reissue generate_video itself,
    // and in practice it routinely DROPS referenceImages / startFrame
    // when rewriting the action JSON — producing a second call that
    // hits the same (or another) model with NO image context and
    // returns whatever the model invents. The bug that prompted this:
    // seedance-2.0/reference-to-video succeeded on retry but with
    // `hasStart=false hasEnd=false` and no `image_urls`, because the
    // agent's second JSON only carried `prompt` and `excludeModels`.
    //
    // Retrying HERE preserves opts across attempts (`...opts` spread)
    // so referenceImages / startFrame / endFrame / referenceVideos /
    // shots all stay intact — only the failed slug accumulates in
    // _policyExcluded so the picker walks to the next candidate.
    const MAX_POLICY_RETRIES = 5;
    const _policyExcluded = new Set(
      Array.isArray(opts.excludeModels) ? opts.excludeModels : [],
    );
    let _policyAttempt = 0;
    let _lastError = null;

    while (_policyAttempt < MAX_POLICY_RETRIES) {
      const _attemptOpts = {
        ...opts,
        excludeModels: [..._policyExcluded],
      };

      let resolvedModel;
      try {
        resolvedModel = await _resolveMediaModel('video', this.model, _attemptOpts, (models, req) =>
          import('./media-model-router.js').then(({ pickVideoModel, MediaModelRoutingError }) => {
            try {
              return pickVideoModel(models, req);
            } catch (e) {
              if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
              throw e;
            }
          }),
          {
            resolution: _attemptOpts.resolution,
            aspectRatio: _attemptOpts.aspectRatio,
            hasStartFrame: !!_attemptOpts.startFrame?.data || (shots ? shots.some((s) => s.startFrame?.data) : false),
            hasEndFrame:   !!_attemptOpts.endFrame?.data   || (shots ? shots.some((s) => s.endFrame?.data)   : false),
            withAudio: !!_attemptOpts.withAudio,
            refsCount: _attemptOpts.referenceImages?.length || 0,
            videoRefsCount: Array.isArray(_attemptOpts.referenceVideos) ? _attemptOpts.referenceVideos.length : 0,
            hasImageUrl: !!_attemptOpts.imageUrl,
            hasAudioUrl: !!_attemptOpts.audioUrl,
            characterOrientation: !!_attemptOpts.characterOrientation,
            shotCount,
            label: _attemptOpts.label,
            excludeModels: _attemptOpts.excludeModels,
            includeModels: Array.isArray(_attemptOpts.includeModels) ? _attemptOpts.includeModels : undefined,
            preferQuality: _attemptOpts.preferQuality !== false,
            kind: _attemptOpts.kind,
          },
        );
      } catch (resolveErr) {
        if (_lastError) throw _lastError;
        throw resolveErr;
      }

    channel.log(
      'video',
      _policyAttempt === 0
        ? `Model resolved → ${resolvedModel}`
        : `Model resolved → ${resolvedModel} (retry ${_policyAttempt} after content-policy rejection by [${[..._policyExcluded].join(', ')}])`,
    );

    // Log every reference modality the caller handed us, so we can
    // confirm at a glance that the agent didn't drop referenceImages /
    // startFrame on the way down. Mirrors the backend's expanded
    // `[fal/video] submit` log so both sides report the same shape.
    channel.log(
      'video',
      `[refs] caller opts: referenceImages=${opts.referenceImages?.length || 0}, ` +
      `referenceVideos=${Array.isArray(opts.referenceVideos) ? opts.referenceVideos.length : 0}, ` +
      `startFrame=${!!opts.startFrame?.data}, endFrame=${!!opts.endFrame?.data}, ` +
      `shots=${shots ? shots.length : 0}`,
    );

    const payload = {
      model: resolvedModel,
      prompt,
      aspect_ratio: opts.aspectRatio || '16:9',
      resolution: opts.resolution || '720p',
      duration: opts.duration || 5,
      quality: opts.quality || 'auto',
      with_audio: opts.withAudio || false,
    };

    // Camera movement + multishot fallback. Both are forwarded to the
    // backend as-is; provider-specific adapters on the gateway side
    // (fal Kling `camera_control`, Runway multi-clip `num_videos`, …)
    // translate these to whatever the underlying model expects. Unknown
    // keys are ignored by fal, so pass-through is safe when the
    // provider doesn't recognize them.
    if (typeof opts.cameraMovement === 'string' && opts.cameraMovement.trim()) {
      payload.camera_control = opts.cameraMovement.trim();
    }
    // Kling V3 motion-control specific knobs. Pass-through to the backend
    // adapter; ignored by every other model. character_orientation tells
    // the model whether to keep the still's pose ("image") or reorient
    // the character to match the reference video's pose ("video").
    if (opts.characterOrientation === 'image' || opts.characterOrientation === 'video') {
      payload.character_orientation = opts.characterOrientation;
    }
    if (typeof opts.keepOriginalSound === 'boolean') {
      payload.keep_original_sound = opts.keepOriginalSound;
    }
    // numShots: legacy scalar path, only honoured when no explicit
    // shots[] array is present.
    if (!shots && typeof opts.numShots === 'number' && opts.numShots > 1) {
      payload.num_shots = opts.numShots;
    }

    if (opts.startFrame?.data) {
      payload.start_frame = {
        data: typeof opts.startFrame.data === 'string' ? opts.startFrame.data : opts.startFrame.data.toString('base64'),
        mime_type: opts.startFrame.mimeType || 'image/png',
      };
    }
    if (opts.endFrame?.data) {
      payload.end_frame = {
        data: typeof opts.endFrame.data === 'string' ? opts.endFrame.data : opts.endFrame.data.toString('base64'),
        mime_type: opts.endFrame.mimeType || 'image/png',
      };
    }
    if (opts.referenceImages?.length) {
      payload.reference_images = opts.referenceImages.map(ref => ({
        data: typeof ref.data === 'string' ? ref.data : ref.data.toString('base64'),
        mime_type: ref.mimeType || 'image/png',
      }));
    }
    // referenceVideos are ALREADY URLs at this point — the client
    // uploaded them to the gateway via /uploads/video before calling
    // this method. We just pass the URL array through; the backend
    // wires them into the provider-specific field (video_url /
    // video_urls) when building the fal input.
    if (Array.isArray(opts.referenceVideos) && opts.referenceVideos.length > 0) {
      payload.reference_videos = opts.referenceVideos.slice();
    }
    // Per-shot overrides. Each entry mirrors the top-level fields;
    // binary media (frames, ref images) is base64-encoded here, ref
    // videos stay as URLs (already uploaded). The backend iterates this
    // array and emits one fal submission per shot (for providers that
    // don't natively multishot) — see handleVideoGenerate.
    if (shots) {
      payload.shots = shots.map((s) => {
        const shotPayload = {};
        if (typeof s.prompt === 'string' && s.prompt.trim()) shotPayload.prompt = s.prompt;
        if (typeof s.duration === 'number') shotPayload.duration = s.duration;
        if (typeof s.aspectRatio === 'string') shotPayload.aspect_ratio = s.aspectRatio;
        if (typeof s.cameraMovement === 'string' && s.cameraMovement.trim()) {
          shotPayload.camera_control = s.cameraMovement.trim();
        }
        if (s.startFrame?.data) {
          shotPayload.start_frame = {
            data: typeof s.startFrame.data === 'string' ? s.startFrame.data : s.startFrame.data.toString('base64'),
            mime_type: s.startFrame.mimeType || 'image/png',
          };
        }
        if (s.endFrame?.data) {
          shotPayload.end_frame = {
            data: typeof s.endFrame.data === 'string' ? s.endFrame.data : s.endFrame.data.toString('base64'),
            mime_type: s.endFrame.mimeType || 'image/png',
          };
        }
        if (Array.isArray(s.referenceImages) && s.referenceImages.length > 0) {
          shotPayload.reference_images = s.referenceImages.map((ref) => ({
            data: typeof ref.data === 'string' ? ref.data : ref.data.toString('base64'),
            mime_type: ref.mimeType || 'image/png',
          }));
        }
        if (Array.isArray(s.referenceVideos) && s.referenceVideos.length > 0) {
          shotPayload.reference_videos = s.referenceVideos.slice();
        }
        return shotPayload;
      });
    }

    // Model-specific escape hatch: forward caller extra params the tool doesn't
    // expose as first-class fields (e.g. Seedance `bitrate_mode`) as a NESTED
    // object. The backend adapter merges it into the fal input (adapters build
    // an explicit whitelist, so top-level unknown keys would be dropped — it
    // must arrive as its own field). Keys are the exact fal field names.
    if (opts.extraParams && typeof opts.extraParams === 'object' && !Array.isArray(opts.extraParams)) {
      payload.extra_params = opts.extraParams;
    }

      try {
        const res = await fetch(`${getGatewayBase()}/media/video/generate`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload),
          signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
        });

        await throwIfQuotaExceeded(res);
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          let structured = null;
          try { structured = JSON.parse(bodyText); } catch {}
          const err = new Error(
            structured?.error || `Gateway video error (${res.status}): ${bodyText}`,
          );
          err.status = res.status;
          if (structured) err.details = structured;
          throw err;
        }

        const data = await res.json();
        // The gateway encodes the resolved fal model into the composite id as
        // `<model>|<request_id>` — surface it explicitly here when present so
        // the caller doesn't have to pattern-match on the id string. Falls
        // back to data.model (newer backends ship it as a top-level field).
        const id = data.id || data.request_id || data.name;
        const finalModel = data.model
          || (typeof id === 'string' && id.includes('|') ? id.split('|', 1)[0] : resolvedModel);
        return {
          id,
          status: _mapGatewayVideoStatus(data.status),
          url: data.url || undefined,
          model: finalModel,
          usage: { durationSec: opts.duration || 5 },
        };
      } catch (callErr) {
        // Input-shape mismatch is MECHANICAL — exclude this slug and walk
        // to the next-best candidate. CRITICAL: opts (and thus
        // referenceImages / startFrame / referenceVideos / shots) is
        // preserved across the retry — that's the whole point of looping
        // here instead of letting the agent reissue with a stripped-down
        // JSON. These errors return fast, so the cascade is cheap.
        if (_isInputShapeError(callErr)) {
          _policyExcluded.add(resolvedModel);
          _lastError = callErr;
          _policyAttempt += 1;
          channel.log(
            'video',
            `input-shape reject from ${resolvedModel} (${(callErr.message || '').slice(0, 120)}) — trying next-best model (refs preserved: images=${opts.referenceImages?.length || 0}, videos=${opts.referenceVideos?.length || 0}, startFrame=${!!opts.startFrame?.data}, endFrame=${!!opts.endFrame?.data})`,
          );
          continue;
        }
        // Content-policy / safety rejection: STOP immediately — do NOT
        // cascade through fallback models (same product decision as the
        // image branch). Silently re-routing across multi-minute model
        // calls left the GUI banner spinning for minutes on an
        // already-blocked job. Throw a classified error so the tool maps it
        // to a blocked result, the banner closes at once, and the agent
        // surfaces it to the user instead of churning models.
        if (_isContentPolicyError(callErr)) {
          channel.log(
            'video',
            `content-policy reject from ${resolvedModel} (${(callErr.message || '').slice(0, 120)}) — STOPPING (no fallback) and surfacing to the user`,
          );
          const err = new Error(
            `Video generation blocked by ${resolvedModel}'s content policy: ${callErr.message}`,
          );
          err.cause = callErr;
          err.contentPolicyBlocked = true;
          err.blockedModel = resolvedModel;
          throw err;
        }
        // Any other failure (network, timeout, provider 500, …): don't
        // retry. Switching models won't help and would burn quota.
        throw callErr;
      }
    }

    // All MAX_POLICY_RETRIES cycles exhausted with policy rejections.
    if (_lastError) {
      const err = new Error(
        `Video generation refused by ${_policyExcluded.size} model(s) on content-policy grounds. ` +
        `Last error: ${_lastError.message}. Excluded: [${[..._policyExcluded].join(', ')}].`,
      );
      err.cause = _lastError;
      err.policyExhausted = true;
      err.excludedModels = [..._policyExcluded];
      throw err;
    }
    throw new Error('Video generation failed: max retries exhausted without a recorded error');
  }

  async getStatus(jobId, opts = {}) {
    // Query param (not path param) because the backend encodes the id as
    // `<model>|<falRequestId>` and fal model slugs contain slashes.
    const url = `${getGatewayBase()}/media/video/status?id=${encodeURIComponent(jobId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: getAuthHeaders(),
      signal: _stallSignal(opts.abortSignal, _MEDIA_POLL_TIMEOUT_MS),
    });

    await throwIfQuotaExceeded(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway video status error (${res.status}): ${body}`);
    }

    const data = await res.json();
    // jobId is `<resolvedModel>|<falRequestId>` (composite). Surface the
    // model so the caller can persist the actual model used instead of
    // the literal "auto" the user passed at submit time.
    const finalModel = data.model
      || (typeof jobId === 'string' && jobId.includes('|') ? jobId.split('|', 1)[0] : undefined);
    const out = {
      id: jobId,
      status: _mapGatewayVideoStatus(data.status),
      url: data.url || undefined,
      model: finalModel,
      error: data.error || undefined,
    };
    // Forward billing fields the backend stamps on COMPLETED video jobs
    // so generate-video.js can pin them into the saved video's metadata
    // (Info panel's "Cost: X credits" + "Provider job"). Same reason as
    // the image queue path above.
    if (typeof data.creditsCost === 'number') out.creditsCost = data.creditsCost;
    if (typeof data.providerRequestId === 'string') out.providerRequestId = data.providerRequestId;
    // Multishot: surface each shot's status so the tool can save every
    // URL as it completes. Each entry follows the same shape as the
    // top-level (id/status/url) but with an `index` so callers keep
    // shot ordering. Absent when the job was single-shot.
    if (Array.isArray(data.shots) && data.shots.length > 0) {
      out.shots = data.shots.map((s) => ({
        index: s.index,
        id: s.id,
        status: _mapGatewayVideoStatus(s.status),
        url: s.url || undefined,
        error: s.error || undefined,
      }));
    }
    return out;
  }

  /** Drive a still face image with an audio track to produce a
   *  talking-avatar video. Three steps:
   *    1. Pick the cheapest avatar-capable model via pickVideoModel
   *       (req.kind = 'avatar').
   *    2. Upload audio bytes to fal storage via /uploads/audio so the
   *       backend gets a URL — same path voice-clone uses.
   *    3. POST canonical {model, image_url, audio_url, ...} to
   *       /media/video/avatar; backend resolves the per-model adapter
   *       and queues the fal job.
   *
   *  The returned jobId is the same composite shape (`<slug>|<reqId>`)
   *  as plain text-to-video, so `await_video_generation` polls without
   *  any new code path. */
  async generateAvatar(imageBuffer, audioBuffer, opts = {}) {
    if (!Buffer.isBuffer(imageBuffer)) {
      throw new Error('generateAvatar: imageBuffer must be a Buffer');
    }
    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('generateAvatar: audioBuffer must be a Buffer');
    }
    const resolvedModel = await _resolveMediaModel('video', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickVideoModel, MediaModelRoutingError }) => {
        try {
          return pickVideoModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      // `hasImageUrl` / `hasAudioUrl` MUST be set here so the router's
      // `_filterByRequires` doesn't drop avatar models whose `requires`
      // contract declares `["imageUrl", "audioUrl"]` (e.g. OmniHuman
      // v1.5). The buffers ARE already in hand at this point — the
      // upload to /uploads happens right after — so the presence
      // signal is unconditionally true. Without these flags the
      // filter discarded every avatar-capable model and `_pickByBucket`
      // then failed with `No active model in bucket="video_avatar"`
      // even though the catalog contained a viable row.
      {
        kind: 'avatar',
        label: opts.label,
        hasImageUrl: true,
        hasAudioUrl: true,
      },
    );

    // Upload audio.
    const audioFilename = opts.audioFilename || 'audio.mp3';
    const audioMime = opts.audioMimeType || _audioMimeFromFilename(audioFilename);
    const aHeaders = { ...getAuthHeaders() };
    delete aHeaders['content-type'];
    delete aHeaders['Content-Type'];
    aHeaders['Content-Type'] = audioMime;
    const audioRes = await fetch(
      `${getGatewayBase()}/uploads/audio?filename=${encodeURIComponent(audioFilename)}`,
      { method: 'POST', headers: aHeaders, body: audioBuffer, signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS) },
    );
    await throwIfQuotaExceeded(audioRes);
    if (!audioRes.ok) {
      const body = await audioRes.text().catch(() => '');
      throw new Error(`Gateway audio upload error (${audioRes.status}): ${body}`);
    }
    const { url: audioUrl } = await audioRes.json();

    // Upload image — reuses /uploads/video, which is just a fal-storage
    // wrapper and accepts any mime. Avoids adding /uploads/image just
    // for this one consumer.
    const imageFilename = opts.imageFilename || 'image.png';
    const imageMime = opts.imageMimeType || _imageMimeFromFilename(imageFilename);
    const iHeaders = { ...getAuthHeaders() };
    delete iHeaders['content-type'];
    delete iHeaders['Content-Type'];
    iHeaders['Content-Type'] = imageMime;
    const imgRes = await fetch(
      `${getGatewayBase()}/uploads/video?filename=${encodeURIComponent(imageFilename)}`,
      { method: 'POST', headers: iHeaders, body: imageBuffer, signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS) },
    );
    await throwIfQuotaExceeded(imgRes);
    if (!imgRes.ok) {
      const body = await imgRes.text().catch(() => '');
      throw new Error(`Gateway image upload error (${imgRes.status}): ${body}`);
    }
    const { url: imageUrl } = await imgRes.json();

    // Submit the avatar job.
    const submitRes = await fetch(`${getGatewayBase()}/media/video/avatar`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: resolvedModel,
        image_url: imageUrl,
        audio_url: audioUrl,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
        ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
      }),
      signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
    });
    await throwIfQuotaExceeded(submitRes);
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => '');
      throw new Error(`Gateway avatar error (${submitRes.status}): ${body}`);
    }
    const data = await submitRes.json();
    return {
      id: data.id,
      status: _mapGatewayVideoStatus(data.status),
      model: data.model || resolvedModel,
      provider: 'koi-gateway',
    };
  }

  /** Re-lipsync an EXISTING video to a new audio track (dub / re-voice a
   *  clip). Same three steps as generateAvatar, but the primary input is a
   *  VIDEO, not a still image:
   *    1. Pick the cheapest lipsync-capable model via pickVideoModel
   *       (req.kind = 'lipsync'; the source video counts as one videoRef and
   *       the audio as hasAudioUrl, so the `requires:['referenceVideos',
   *       'audioUrl']` filter keeps veed/lipsync/v2 in the running).
   *    2. Upload audio + video bytes to fal storage via /uploads/audio and
   *       /uploads/video → URLs.
   *    3. POST canonical {model, video_url, audio_url} to
   *       /media/video/lipsync; backend resolves the veed adapter and queues.
   *
   *  Returns the same composite jobId shape as the other video paths, so
   *  `await_video_generation` polls it without a new code path. */
  async generateLipsync(videoBuffer, audioBuffer, opts = {}) {
    if (!Buffer.isBuffer(videoBuffer)) {
      throw new Error('generateLipsync: videoBuffer must be a Buffer');
    }
    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('generateLipsync: audioBuffer must be a Buffer');
    }
    const resolvedModel = await _resolveMediaModel('video', this.model, opts, (models, req) =>
      import('./media-model-router.js').then(({ pickVideoModel, MediaModelRoutingError }) => {
        try {
          return pickVideoModel(models, req);
        } catch (e) {
          if (e instanceof MediaModelRoutingError) throw _toNoMatchError(e);
          throw e;
        }
      }),
      // The source video is present as one videoRef and the audio as
      // hasAudioUrl, so the router's `_filterByRequires` keeps models whose
      // contract is `["referenceVideos","audioUrl"]` (veed/lipsync/v2).
      {
        kind: 'lipsync',
        label: opts.label,
        videoRefsCount: 1,
        hasAudioUrl: true,
      },
    );

    // Upload audio.
    const audioFilename = opts.audioFilename || 'audio.mp3';
    const audioMime = opts.audioMimeType || _audioMimeFromFilename(audioFilename);
    const aHeaders = { ...getAuthHeaders() };
    delete aHeaders['content-type'];
    delete aHeaders['Content-Type'];
    aHeaders['Content-Type'] = audioMime;
    const audioRes = await fetch(
      `${getGatewayBase()}/uploads/audio?filename=${encodeURIComponent(audioFilename)}`,
      { method: 'POST', headers: aHeaders, body: audioBuffer, signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS) },
    );
    await throwIfQuotaExceeded(audioRes);
    if (!audioRes.ok) {
      const body = await audioRes.text().catch(() => '');
      throw new Error(`Gateway audio upload error (${audioRes.status}): ${body}`);
    }
    const { url: audioUrl } = await audioRes.json();

    // Upload the source video via /uploads/video (fal-storage wrapper).
    const videoFilename = opts.videoFilename || 'source.mp4';
    const vHeaders = { ...getAuthHeaders() };
    delete vHeaders['content-type'];
    delete vHeaders['Content-Type'];
    vHeaders['Content-Type'] = opts.videoMimeType || 'video/mp4';
    const vidRes = await fetch(
      `${getGatewayBase()}/uploads/video?filename=${encodeURIComponent(videoFilename)}`,
      { method: 'POST', headers: vHeaders, body: videoBuffer, signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS) },
    );
    await throwIfQuotaExceeded(vidRes);
    if (!vidRes.ok) {
      const body = await vidRes.text().catch(() => '');
      throw new Error(`Gateway video upload error (${vidRes.status}): ${body}`);
    }
    const { url: videoUrl } = await vidRes.json();

    // Submit the lipsync job.
    const submitRes = await fetch(`${getGatewayBase()}/media/video/lipsync`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        model: resolvedModel,
        video_url: videoUrl,
        audio_url: audioUrl,
      }),
      signal: _stallSignal(opts.abortSignal, _MEDIA_SUBMIT_TIMEOUT_MS),
    });
    await throwIfQuotaExceeded(submitRes);
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => '');
      throw new Error(`Gateway lipsync error (${submitRes.status}): ${body}`);
    }
    const data = await submitRes.json();
    return {
      id: data.id,
      status: _mapGatewayVideoStatus(data.status),
      model: data.model || resolvedModel,
      provider: 'koi-gateway',
    };
  }
}

function _imageMimeFromFilename(name) {
  const ext = name.toLowerCase();
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.webp')) return 'image/webp';
  if (ext.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

/** Map gateway/fal-style statuses to our standard enum. */
function _mapGatewayVideoStatus(status) {
  switch (status) {
    case 'IN_QUEUE':    return 'pending';
    case 'IN_PROGRESS': return 'processing';
    case 'COMPLETED':   return 'completed';
    case 'FAILED':      return 'failed';
    // Also accept our own standard values
    case 'pending':     return 'pending';
    case 'processing':  return 'processing';
    case 'completed':   return 'completed';
    case 'failed':      return 'failed';
    default:            return 'pending';
  }
}
