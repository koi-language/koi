/**
 * McpMediaProvider — a media "provider instance" whose methods call a connected
 * MCP server instead of the Koi backend gateway. It mirrors the method surface
 * the media tools already call, so NO tool changes are needed — the existing
 * tools become a facade (see docs/mcp-media-facade.md).
 *
 * Lifecycle parity with Braxil:
 *   - image / audio / operations → INLINE: submit → poll → fetch, return the
 *     asset (images:[{url}] / audio:Buffer) in one call.
 *   - video / avatar            → DEFERRED jobs: generate()/generateAvatar()
 *     return { id, status:'pending' } and the tool drives `getStatus(jobId)`
 *     via _pollUntilTerminal — exactly like the gateway video provider.
 *
 * Self-adaptation (so a Magnific rename degrades instead of breaking):
 *   - tool names are reconciled against the live `tools/list` (`_resolveToolName`)
 *   - param names are reconciled against each tool's live `inputSchema`
 *     (`_param`). The profile is a HINT; the live schema is the source of truth.
 *   - if a mapped tool no longer exists → throw → the caller falls back to the
 *     backend gateway (per-operation coexistence).
 *
 * Coexistence (decision 2): any method/op not covered by the active MCP delegates
 * to the wrapped `fallback` gateway instance (or throws a clear error when there
 * is no fallback, e.g. logged out).
 *
 * Response field names (identifier / url / presigned PUT fields) are read
 * defensively because they vary by server; the profile pins the tool names.
 */

import { mcpRegistry } from '../../mcp/mcp-registry.js';
import { channel } from '../../io/channel.js';
import yaml from 'yaml';

const MAX_POLL_ATTEMPTS = 40; // ~40 × up-to-25s long-polls = generous ceiling

/** Thrown when the MCP can't serve a route → caller falls back to the gateway. */
export class MediaRouteUnavailable extends Error {}

export class McpMediaProvider {
  /**
   * @param {object} o
   * @param {string} o.kind     'image' | 'video' | 'audio'
   * @param {string} o.server   MCP registry server name
   * @param {object} o.media    the resolved media mapping for that server
   * @param {object} [o.fallback] a gateway provider instance for uncovered methods
   */
  constructor({ kind, server, media, fallback = null }) {
    this.kind = kind;
    this.server = server;
    this.media = media || {};
    this.fallback = fallback;
    this.model = `mcp:${server}`;
    // The media tools read `instance.capabilities` (a sync object on the gateway
    // provider). The MCP provider doesn't have the backend catalog, so expose a
    // permissive default: refs allowed, dimensions/labels left to the MCP. The
    // tool's CANONICAL_* fallbacks cover the empty enums.
    this.capabilities = {
      referenceImages: true,
      hasRefImageSupport: true,
      maxReferenceImages: 12,
      maxRefImages: 12,
      maxImages: 1,
      aspectRatios: [],
      resolutions: [],
      labels: [],
      labelDetails: [],
      models: [],
    };
  }

  // ── Public provider surface ────────────────────────────────────────────────

  /** Image (inline) or video (deferred) generation. */
  async generate(prompt, opts = {}) {
    const media = this.media;

    // Camera-angle one-shot → Magnific's reframe tool (image, inline).
    if (this.kind === 'image' && opts.cameraAngles && media.cameraAngles && this._anyAngle(opts.cameraAngles)) {
      return this._cameraAngle(prompt, opts);
    }

    const route = media.generate && media.generate[this.kind];
    if (!route) return this._fallback('generate', [prompt, opts]);

    // Coverage-aware model selection. The HOST picker (catalog category+labels) is
    // the source of truth for WHICH model to use. We run THIS provider only if it
    // covers the picked slug — passing the mapped provider model id into the tool's
    // model param. An uncovered slug delegates to the gateway fallback; we never
    // silently fall back to the MCP's own auto-pick when the host made a choice.
    let mappedModel = null;
    if (route.modelParam && media.modelCoverage && media.modelCoverage[this.kind]) {
      const picked = await this._pickHostSlug(opts);
      if (picked) {
        mappedModel = media.modelCoverage[this.kind][picked] || null;
        if (!mappedModel) {
          channel.log('media-router', `[mcp:${this.server}] picked ${picked} not covered by ${this.server} → gateway`);
          return this._fallback('generate', [prompt, opts]);
        }
        channel.log('media-router', `[mcp:${this.server}] host picked ${picked} → ${route.modelParam}=${mappedModel}`);
      }
    }

    const tool = this._resolveToolName(route.tool);
    const args = {};
    args[this._param(tool, ['prompt', 'text', 'query', 'video'], route.promptParam)] = prompt;
    if (mappedModel) {
      const mk = this._param(tool, [route.modelParam, 'mode', 'model', 'engine', 'slug'], route.modelParam, true);
      if (mk) args[mk] = mappedModel;
    }
    if (opts.aspectRatio) {
      const k = this._param(tool, ['aspectRatio', 'aspect_ratio', 'ratio', 'size'], route.aspectRatioParam, true);
      if (k) args[k] = opts.aspectRatio;
    }
    if (typeof opts.n === 'number') {
      const k = this._param(tool, ['count', 'numImages', 'n'], route.countParam, true);
      if (k) args[k] = opts.n;
    }
    if (Array.isArray(opts.referenceImages) && opts.referenceImages.length) {
      const ids = [];
      for (const ref of opts.referenceImages) ids.push(await this._uploadOne(ref, opts));
      const k = this._param(tool, ['references', 'reference_images', 'referenceImages', 'images'], route.refsParam, true);
      if (k) args[k] = this._shapeRefs(tool, k, ids);
    }

    // Video is a deferred job: submit and hand back an id for getStatus().
    if (this.kind === 'video') {
      const id = await this._submit(tool, args, opts, route);
      return { id, status: 'pending', model: `${this.server}:${mappedModel || tool}`, provider: this.model };
    }

    // Image is inline.
    const images = await this._submitPollFetch(tool, args, opts, 'image', route);
    return { images, model: `${this.server}:${mappedModel || tool}` };
  }

  /** Image operations: upscale, background_removal, … (inline). */
  async runOperation(operation, image, opts = {}) {
    const route = this.media.operations && this.media.operations[operation];
    if (!route) return this._fallback('runOperation', [operation, image, opts]);

    const tool = this._resolveToolName(route.tool);
    const srcId = await this._uploadOne(image, opts);
    const args = { [this._param(tool, ['creationIdentifier', 'identifier', 'id'], route.idParam)]: srcId };
    if (operation === 'upscale' && typeof opts.upscaleFactor === 'number') {
      const k = this._param(tool, ['scale', 'upscaleFactor', 'factor'], route.scaleParam, true);
      if (k) args[k] = opts.upscaleFactor;
    }
    if (route.params && typeof route.params === 'object') Object.assign(args, route.params);

    const images = await this._submitPollFetch(tool, args, opts, 'image', route);
    return { images, model: `${this.server}:${tool}` };
  }

  /** TTS (inline) — returns { audio: Buffer }. */
  async speech(text, opts = {}) { return this._audio('speech', text, opts); }
  /** Music (inline) — returns { audio: Buffer }. */
  async music(prompt, opts = {}) { return this._audio('music', prompt, opts); }
  /** SFX — Magnific has no equivalent; delegate. */
  async sfx(prompt, opts = {}) { return this._fallback('sfx', [prompt, opts]); }

  /** Avatar / talking-head — DEFERRED job, like video. */
  async generateAvatar(imageBuf, audioBuf, opts = {}) {
    const route = this.media.avatar;
    if (!route) return this._fallback('generateAvatar', [imageBuf, audioBuf, opts]);
    const tool = this._resolveToolName(route.tool);
    const imageId = imageBuf ? await this._uploadOne(imageBuf, opts) : null;
    const audioId = audioBuf ? await this._uploadOne({ data: audioBuf, mimeType: 'audio/mpeg' }, opts) : null;
    const args = {};
    if (audioId) args[this._param(tool, ['audioUrl', 'audio', 'audioIdentifier'], route.audioParam)] = audioId;
    if (imageId) {
      const k = this._param(tool, ['imageUrl', 'image', 'imageIdentifier'], route.imageParam, true);
      if (k) args[k] = imageId;
    }
    if (route.params && typeof route.params === 'object') Object.assign(args, route.params);
    const id = await this._submit(tool, args, opts, route);
    return { id, status: 'pending', model: `${this.server}:${tool}`, provider: this.model };
  }

  /** Voice cloning / transcription — Magnific has no equivalent; delegate. */
  async cloneVoice(audioBuf, opts = {}) { return this._fallback('cloneVoice', [audioBuf, opts]); }
  async transcribe(audioBuf, opts = {}) { return this._fallback('transcribe', [audioBuf, opts]); }

  /**
   * Poll a deferred job (video / avatar). Called by _pollUntilTerminal in
   * generate-video.js. Returns { id, status: 'pending'|'completed'|'failed', url?, model }.
   */
  async getStatus(jobId, opts = {}) {
    const a = this.media.async || {};
    const statusTool = this._resolveToolName(a.status || a.poll, true);
    if (!statusTool) {
      // No status tool: assume the submit already returned a terminal asset.
      return { id: jobId, status: 'completed', model: this.model };
    }
    const idParam = this._param(statusTool, ['creationIdentifier', 'identifiers', 'identifier', 'id'], a.statusIdParam || a.pollIdParam);
    const res = await this._call(statusTool, { [idParam]: this._maybeArray(statusTool, idParam, jobId) });

    if (this._isFailed(res)) {
      return { id: jobId, status: 'failed', model: this.model, error: this._deepFindString(res, ['error', 'message', 'failureReason']) || 'failed' };
    }
    if (this._isPending(res)) {
      return { id: jobId, status: 'pending', model: this.model };
    }
    // Terminal → resolve the asset URL (inline in the status payload, else fetch).
    let url = this._resolveUrl(res);
    if (!url && a.fetch) {
      const fetchTool = this._resolveToolName(a.fetch, true);
      if (fetchTool) {
        const fres = await this._call(fetchTool, { [this._param(fetchTool, ['creationIdentifier', 'identifier', 'id'], a.fetchIdParam)]: jobId });
        url = this._resolveUrl(fres);
      }
    }
    return { id: jobId, status: url ? 'completed' : 'pending', url, model: this.model };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async _cameraAngle(prompt, opts) {
    const route = this.media.cameraAngles;
    const tool = this._resolveToolName(route.tool);
    const srcRef = (opts.referenceImages && opts.referenceImages[0]) || null;
    if (!srcRef) return this._fallback('generate', [prompt, opts], 'cameraAngles needs a reference image');
    const srcId = await this._uploadOne(srcRef, opts);
    const args = { [this._param(tool, ['creationIdentifier', 'identifier', 'id'], route.idParam)]: srcId };
    const map = route.map || {};
    for (const axis of ['horizontal', 'vertical', 'zoom']) {
      if (typeof opts.cameraAngles[axis] === 'number' && map[axis]) {
        const k = this._param(tool, [map[axis]], map[axis], true);
        if (k) args[k] = opts.cameraAngles[axis];
      }
    }
    const images = await this._submitPollFetch(tool, args, opts, 'image', route);
    return { images, model: `${this.server}:${tool}` };
  }

  async _audio(mode, input, opts) {
    const audio = this.media.generate && this.media.generate.audio;
    const route = audio && audio[mode];
    if (!route) return this._fallback(mode === 'music' ? 'music' : 'speech', [input, opts]);
    const tool = this._resolveToolName(route.tool);
    const args = {};
    args[this._param(tool, mode === 'music' ? ['prompt', 'text'] : ['text', 'prompt'], route.textParam || route.promptParam)] = input;
    if (route.params && typeof route.params === 'object') Object.assign(args, route.params);
    const assets = await this._submitPollFetch(tool, args, opts, 'audio', route);
    const url = assets[0] && assets[0].url;
    const buffer = url ? await this._downloadBuffer(url, opts) : null;
    if (!buffer) throw new Error(`MCP ${this.server}: audio generation returned no playable asset`);
    return { audio: buffer, model: `${this.server}:${tool}` };
  }

  _anyAngle(ca) {
    return typeof ca.horizontal === 'number' || typeof ca.vertical === 'number' || typeof ca.zoom === 'number';
  }

  /**
   * Shape an array of uploaded creation ids for a reference param, driven by the
   * tool's LIVE inputSchema (no hardcoded per-provider assumptions). Some servers
   * (e.g. Magnific) require objects — `references: [{ type:"image", identifier }]`
   * — and reject bare id strings; others accept the ids directly. We read the
   * param's `items` schema: object items with an id-ish (+ optional type) field →
   * build objects (type defaults to "image" when that's an allowed enum value);
   * otherwise pass the ids through unchanged.
   */
  _shapeRefs(tool, paramKey, ids) {
    const props = this._schemaProps(tool);
    const items = props && props[paramKey] && props[paramKey].items;
    const itemProps = items && (items.type === 'object' || items.properties) ? items.properties : null;
    if (!itemProps || typeof itemProps !== 'object') return ids; // server takes bare ids
    const idField = ['identifier', 'id', 'creationIdentifier', 'creationId', 'url'].find((f) => itemProps[f]) || 'identifier';
    const typeField = ['type', 'kind', 'referenceType'].find((f) => itemProps[f]);
    return ids.map((id) => {
      const o = { [idField]: id };
      if (typeField) {
        const en = itemProps[typeField].enum;
        o[typeField] = (Array.isArray(en) && en.includes('image')) ? 'image' : ((en && en[0]) || 'image');
      }
      return o;
    });
  }

  /**
   * Which catalog slug would the HOST picker choose for this request? Uses the
   * SAME catalog + picker as the gateway (category + labels source of truth), so
   * an MCP route honours the host's choice instead of the MCP's own auto-pick.
   * Returns null when it can't pick (logged out, no catalog, picker error) — the
   * caller then proceeds with the MCP's default (auto) rather than failing.
   */
  async _pickHostSlug(opts) {
    if (!process.env.KOI_AUTH_TOKEN) return null; // no gateway/catalog without login
    try {
      const { fetchMediaCapabilities } = await import('./gateway.js');
      const caps = await fetchMediaCapabilities(this.kind);
      if (!caps || !Array.isArray(caps.models) || !caps.models.length) return null;
      const router = await import('./media-model-router.js');
      const pick = this.kind === 'image' ? router.pickImageModel
        : this.kind === 'video' ? router.pickVideoModel
          : this.kind === 'audio' ? router.pickAudioModel : null;
      if (!pick) return null;
      try {
        return pick(caps.models, this._buildPickReq(opts));
      } catch (e) {
        // No model matched the request (MediaModelRoutingError) — let the MCP try
        // its own auto rather than hard-failing here.
        channel.log('media-router', `[mcp:${this.server}] host picker no-match (${e.message}) → MCP auto`);
        return null;
      }
    } catch (e) {
      channel.log('media-router', `[mcp:${this.server}] host pick failed (${e.message}) → MCP auto`);
      return null;
    }
  }

  /** Build the picker's request fields from generate opts (mirrors the gateway). */
  _buildPickReq(opts) {
    return {
      n: opts.n,
      resolution: opts.resolution,
      aspectRatio: opts.aspectRatio,
      refsCount: (opts.referenceImages && opts.referenceImages.length) || 0,
      label: opts.label,
      intent: opts.intent ?? opts.operation,
      excludeModels: opts.excludeModels,
      cameraAngles: opts.cameraAngles,
      hasMaskImage: !!opts.maskImage,
      hasSourceImage: !!opts.sourceImage,
      hasTargetSize: !!(opts.targetSize && opts.targetSize.width && opts.targetSize.height),
      hasSourceImageOffset: !!(opts.sourceImageOffset
        && typeof opts.sourceImageOffset.x === 'number'
        && typeof opts.sourceImageOffset.y === 'number'),
    };
  }

  /** Submit a tool and return the creation id (deferred jobs). */
  async _submit(tool, args, opts, route) {
    const res = await this._call(tool, args);
    const ids = this._resolveIds(res, route);
    if (ids.length) return ids[0];
    const direct = this._extractAssets(res);
    if (direct.length && direct[0].url) return `__sync__:${direct[0].url}`;
    this._logRaw(tool, res);
    throw new Error(`MCP ${this.server}.${tool}: no creation identifier in result`);
  }

  /** Inline: submit, long-poll until terminal, fetch the asset URL(s). */
  async _submitPollFetch(tool, args, opts, assetKey = 'image', route = null) {
    const submitRes = await this._call(tool, args);

    // Synchronous asset directly in the submit response?
    const directUrl = this._resolveUrl(submitRes);
    if (directUrl) return [{ url: directUrl }];
    const directAssets = this._extractAssets(submitRes);
    if (directAssets.length) return directAssets;

    const ids = this._resolveIds(submitRes, route);
    if (!ids.length) {
      this._logRaw(tool, submitRes);
      throw new Error(`MCP ${this.server}.${tool}: no creation identifier or asset in result`);
    }

    const async_ = this.media.async || {};
    if (async_.poll) await this._poll(ids, opts);

    const assets = [];
    const fetchTool = this._resolveToolName(async_.fetch, true);
    if (fetchTool) {
      for (const id of ids) {
        const fres = await this._call(fetchTool, { [this._param(fetchTool, ['creationIdentifier', 'identifier', 'id'], async_.fetchIdParam)]: id });
        const found = this._extractAnyAssets(fres);
        if (found.length) assets.push(...found);
        else this._logRaw(fetchTool, fres); // surface the unrecognised shape for diagnosis
      }
    }
    if (!assets.length) {
      throw new Error(`MCP ${this.server}: generation finished but no ${assetKey} URL was returned`);
    }
    return assets;
  }

  /** Long-poll until terminal — uses the agent-mapped pending/done signals. */
  async _poll(ids, opts) {
    const a = this.media.async || {};
    const pollTool = this._resolveToolName(a.poll, true);
    if (!pollTool) return;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (opts.abortSignal && opts.abortSignal.aborted) throw new Error('Aborted');
      const idParam = this._param(pollTool, ['identifiers', 'creationIdentifier', 'identifier'], a.pollIdParam);
      const args = { [idParam]: this._maybeArray(pollTool, idParam, ids) };
      const tk = this._param(pollTool, ['timeoutSeconds', 'timeout'], a.timeoutParam, true);
      if (tk) args[tk] = a.timeoutSeconds || 25;
      const res = await this._call(pollTool, args);
      try { opts.onStatus && opts.onStatus({ falStatus: 'IN_PROGRESS' }); } catch { /* best-effort */ }
      if (this._isFailed(res)) throw new Error(`MCP ${this.server}: generation reported failure`);
      if (!this._isPending(res)) return;
    }
    throw new Error(`MCP ${this.server}: generation did not finish within the poll budget`);
  }

  // ── Mapped response resolution (paths the agent mapped from descriptions) ───

  /** Creation id(s) from a response: mapped idPath first, then generic. */
  _resolveIds(res, route) {
    if (route && route.idPath) {
      const v = this._pathStrings(res, route.idPath);
      if (v.length) return [...new Set(v)];
    }
    return this._extractIds(res);
  }

  /** Final asset URL: mapped async.urlPath first, then generic. */
  _resolveUrl(res) {
    const a = this.media.async || {};
    if (a.urlPath) { const v = this._pathFirst(res, a.urlPath); if (v) return v; }
    const keys = ['url', 'previewUrl', 'thumbnailUrl'];
    if (a.urlField && !keys.includes(a.urlField)) keys.unshift(a.urlField); // honour the profile-mapped field name
    return this._deepFindString(res, keys);
  }

  /** Still-running? mapped pendingField presence, or statusPath ≠ doneValue. */
  _isPending(res) {
    const a = this.media.async || {};
    if (a.pendingField) return this._deepHasKey(res, a.pendingField);
    if (a.statusPath && a.doneValue) {
      const sts = this._pathStrings(res, a.statusPath);
      if (sts.length) return !sts.every(s => s.toLowerCase() === String(a.doneValue).toLowerCase());
    }
    // A retry hint (poll_after_seconds) unambiguously means "still running".
    if (this._deepHasKey(res, 'poll_after_seconds')) return true;
    if (a.retryField && this._deepHasKey(res, a.retryField)) return true;
    // Generic status-string detection — Magnific doesn't map an explicit
    // doneValue, and its in-progress responses don't always carry the retry
    // hint, so an in-progress status used to be misread as "done" → premature
    // fetch of an empty creation → instant "no image URL" failure.
    const status = this._deepFindString(res, ['status', 'state']);
    if (status) {
      if (/(pending|progress|process|queue|wait|running|start|creat|init|submitt)/i.test(status)) return true;
      if (/(complet|done|success|succeed|finish|ready)/i.test(status)) return false;
    }
    // No clear signal → terminal ONLY if an asset is actually present; otherwise
    // keep polling rather than fetch-then-fail on a job that's still running.
    return !this._extractAnyAssets(res).length;
  }

  _isFailed(res) {
    const a = this.media.async || {};
    if (a.statusPath && a.failValue) {
      const sts = this._pathStrings(res, a.statusPath);
      if (sts.some(s => s.toLowerCase() === String(a.failValue).toLowerCase())) return true;
    }
    return this._looksFailed(res); // generic status ~ /fail|error|cancel/ for unmapped profiles
  }

  /** Send id as an array when the tool's param schema is an array, else scalar. */
  _maybeArray(tool, preferredParam, id) {
    const props = this._schemaProps(tool);
    const key = this._param(tool, ['identifiers', 'creationIdentifier', 'identifier', 'id'], preferredParam);
    const prop = props && props[key];
    if (prop && prop.type === 'array') return Array.isArray(id) ? id : [id];
    return Array.isArray(id) ? id[0] : id;
  }

  _logRaw(tool, res) {
    try { channel.log('mcp', `[mcp-media] ${this.server}.${tool} raw result: ${JSON.stringify(res).slice(0, 2000)}`); } catch { /* */ }
  }

  /** Generic JSON path getter: supports "a.b" and "a[].b" (descend arrays). */
  _getPath(obj, path) {
    if (!path) return [];
    let cur = [obj];
    for (let part of String(path).split('.')) {
      const isArr = part.endsWith('[]');
      if (isArr) part = part.slice(0, -2);
      const next = [];
      for (const c of cur) {
        if (c == null || typeof c !== 'object') continue;
        const v = part === '' ? c : c[part];
        if (isArr) { if (Array.isArray(v)) next.push(...v); }
        else if (v !== undefined) next.push(v);
      }
      cur = next;
    }
    return cur;
  }
  _pathStrings(res, path) { return this._getPath(res, path).filter(v => typeof v === 'string' && v); }
  _pathFirst(res, path) { return this._pathStrings(res, path)[0] || null; }

  /** Upload a local image/audio (Buffer / data-URI / base64 / {data,mimeType}) → creation id. */
  async _uploadOne(ref, opts = {}) {
    const up = this.media.uploadRef || {};

    // Public URL fast-path (uses the agent-mapped byUrlIdPath for the result id).
    if (typeof ref === 'string' && /^https?:\/\//i.test(ref) && up.byUrl) {
      const byUrlTool = this._resolveToolName(up.byUrl, true);
      if (byUrlTool) {
        const res = await this._call(byUrlTool, { [this._param(byUrlTool, ['url', 'imageUrl', 'image'], 'url')]: ref });
        const id = (up.byUrlIdPath ? this._pathStrings(res, up.byUrlIdPath) : this._extractIds(res))[0];
        if (id) return id;
        this._logRaw(byUrlTool, res); // unrecognised shape → surface for diagnosis
      }
    }

    const { buffer, mimeType } = this._toBuffer(ref);
    const reqTool = this._resolveToolName(up.request, true);
    const finTool = this._resolveToolName(up.finalize, true);
    if (!reqTool || !finTool) {
      throw new Error(`MCP ${this.server}: no uploadRef config — cannot send a local reference`);
    }

    // 1) Request a presigned slot. Do NOT send `count` — omitting it yields the
    //    single-slot shape ({ directUploadUrl, path, … }); sending it wraps the
    //    result in { uploads: [ … ] }. We upload one file per call, and the
    //    extractors below handle BOTH shapes anyway.
    const reqArgs = {};
    const mimeKey = this._param(reqTool, ['mimeType', 'contentType', 'mime', 'type'], null, true);
    if (mimeKey) reqArgs[mimeKey] = mimeType;
    const reqRes = await this._call(reqTool, reqArgs);

    // PUT target — mapped path first, then known presigned-URL field names
    // (`directUploadUrl`/`proxyUploadUrl` for Freepik/Magnific), then ANY http(s)
    // URL in the response. `||` chains so a mapped path that yields nothing (e.g.
    // map says `uploads[].url` but the server returned a flat object) still falls
    // through to the generic finders instead of dead-ending.
    const putUrl = (up.requestUrlPath && this._pathFirst(reqRes, up.requestUrlPath))
      || this._deepFindString(reqRes, ['directUploadUrl', 'uploadUrl', 'putUrl', 'proxyUploadUrl', 'url', 'presignedUrl', 'signedUrl'])
      || this._deepFindUrlStrings(reqRes)[0]
      || null;
    // The slot handle finalize needs — mapped path first, then a `path`-ish key
    // (found recursively, so it works for both the flat and the uploads[] shapes).
    const tempPath = (up.requestPathPath && this._pathFirst(reqRes, up.requestPathPath))
      || this._deepFindString(reqRes, ['path', 'tempPath', 'key', 'fileId', 'uploadId', 'filePath', 'objectKey'])
      || null;
    if (!putUrl) {
      this._logRaw(reqTool, reqRes); // surface the unrecognised shape for diagnosis
      throw new Error(`MCP ${this.server}.${reqTool}: no presigned upload URL in result`);
    }
    const putRes = await fetch(putUrl, { method: 'PUT', body: buffer, headers: { 'Content-Type': mimeType } });
    if (!putRes.ok) throw new Error(`MCP ${this.server}: presigned PUT failed (HTTP ${putRes.status})`);

    // 2) Finalize → creation id. The finalize tool takes EITHER a scalar handle
    //    (`path`) OR a batch (`uploads: [{ path }]`) — send `{}` and it errors
    //    "path/uploads required". Prefer the scalar; fall back to the batch echo.
    const finArgs = {};
    if (tempPath) {
      const pathKey = this._param(finTool, ['path', 'key', 'tempPath', 'fileId', 'uploadId', 'filePath', 'objectKey'], null, true);
      finArgs[pathKey || 'path'] = tempPath;
    } else {
      const paths = this._pathStrings(reqRes, 'uploads[].path');
      if (paths.length) finArgs.uploads = paths.map((p) => ({ path: p }));
    }
    const finRes = await this._call(finTool, finArgs);

    // The creation id may surface at finalize OR already at request time (some
    // servers mint the id when the slot is created and finalize just commits it).
    // Try the mapped finalizeIdPath FIRST, but `||`-fall through to the generic
    // id finder when it yields nothing — the map's guessed path is often wrong
    // (e.g. `creations[].identifier` when finalize actually returns a flat
    // `{ identifier, status }`), and dead-ending there discards a perfectly good id.
    const id = (up.finalizeIdPath && this._pathStrings(finRes, up.finalizeIdPath)[0])
      || this._extractIds(finRes)[0]
      || this._extractIds(reqRes)[0];
    if (!id) {
      this._logRaw(reqTool, reqRes); // surface BOTH shapes so the id field can be pinned
      this._logRaw(finTool, finRes);
      throw new Error(`MCP ${this.server}.${finTool}: no creation identifier after upload`);
    }
    return id;
  }

  async _downloadBuffer(url, opts = {}) {
    const res = await fetch(url, { signal: opts.abortSignal });
    if (!res.ok) throw new Error(`MCP ${this.server}: asset download failed (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async _call(tool, args) {
    const raw = await mcpRegistry.callTool(this.server, tool, args);
    return this._normalize(raw);
  }

  /**
   * MCP servers often return their payload as a TEXT content block, which the
   * client surfaces as `{ result: "<text>" }` (or a bare string). Magnific even
   * prefixes a `<system_reminder>…</system_reminder>` before the real payload,
   * and serialises its `creations_get` / `creations_create` responses as YAML
   * (`status: completed\nurl: "https://…"`), NOT JSON. Pull the embedded
   * structured data out so the extractors see an object, not an opaque string —
   * otherwise a perfectly good `url:` line sits inside a string value and the
   * resolver reports "no image URL was returned" on a job that actually finished.
   */
  _normalize(raw) {
    if (typeof raw === 'string') return this._parseEmbeddedStructured(raw) || raw;
    if (raw && typeof raw === 'object' && typeof raw.result === 'string') {
      return this._parseEmbeddedStructured(raw.result) || raw;
    }
    return raw;
  }

  /** Parse an embedded payload: JSON first, then YAML. Returns an object/array or null. */
  _parseEmbeddedStructured(str) {
    return this._parseEmbeddedJson(str) || this._parseEmbeddedYaml(str);
  }

  /**
   * Parse a YAML text block into structured data. Strips a leading
   * `<system_reminder>…</system_reminder>` wrapper if present, and only accepts
   * the result when it's a non-empty object/array — a plain prose string (which
   * `yaml.parse` happily returns verbatim) is NOT structured data and must fall
   * through so the raw string is preserved.
   */
  _parseEmbeddedYaml(str) {
    if (typeof str !== 'string' || !str.trim()) return null;
    const body = str.replace(/^\s*<system_reminder>[\s\S]*?<\/system_reminder>\s*/i, '').trim();
    if (!body) return null;
    try {
      const parsed = yaml.parse(body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* not YAML → keep the raw string */ }
    return null;
  }

  _parseEmbeddedJson(str) {
    const start = str.search(/[{[]/);
    if (start < 0) return null;
    const candidate = str.slice(start).trim();
    try { return JSON.parse(candidate); } catch { /* try a greedy balanced slice */ }
    const m = candidate.match(/[{[][\s\S]*[}\]]/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
    return null;
  }

  async _fallback(method, callArgs, why = '') {
    if (this.fallback && typeof this.fallback[method] === 'function') {
      return this.fallback[method](...callArgs);
    }
    throw new MediaRouteUnavailable(
      `MCP media provider "${this.server}" does not support ${method}` +
      (why ? ` (${why})` : '') + ' and no backend fallback is available' +
      (process.env.KOI_AUTH_TOKEN ? '.' : ' — sign in to Koi to use the backend.'),
    );
  }

  // ── Self-adaptation: reconcile against the live tools/list + inputSchema ─────

  _clientTools() {
    const client = mcpRegistry.get(this.server);
    return (client && Array.isArray(client.tools)) ? client.tools : [];
  }

  /**
   * Resolve a profile-declared tool name against the server's LIVE tool list.
   * Exact match wins; else a normalized (case/underscore-insensitive) or
   * substring match. Returns null when nothing matches (→ caller falls back),
   * unless `soft` is set, which returns the requested name when the list is
   * unknown (not yet connected) so we still attempt the call.
   */
  _resolveToolName(wanted, soft = false) {
    if (!wanted) return soft ? null : wanted;
    const names = this._clientTools().map(t => t.name).filter(Boolean);
    if (!names.length) return wanted; // tools not loaded → trust the profile
    if (names.includes(wanted)) return wanted;
    const norm = (s) => s.toLowerCase().replace(/[_\-\s]/g, '');
    const w = norm(wanted);
    const hit = names.find(n => norm(n) === w)
      || names.find(n => norm(n).includes(w) || w.includes(norm(n)));
    if (hit) return hit;
    if (soft) return null;
    throw new MediaRouteUnavailable(
      `MCP "${this.server}": tool "${wanted}" not found (server may have renamed it). Falling back.`,
    );
  }

  _schemaProps(toolName) {
    const t = this._clientTools().find(x => x.name === toolName);
    const schema = t && t.inputSchema;
    return (schema && schema.properties && typeof schema.properties === 'object') ? schema.properties : null;
  }

  /**
   * Resolve a logical parameter to the tool's ACTUAL param name using its live
   * inputSchema. The preferred (profile) name wins if present; else the first
   * candidate present; else a fuzzy contains-match. When the schema is unknown
   * we trust the preferred/first candidate. With `optional`, returns null if the
   * schema is known and none match (so we don't send a param the tool rejects).
   */
  _param(toolName, candidates, preferred, optional = false) {
    const props = this._schemaProps(toolName);
    if (!props) return preferred || candidates[0];
    if (preferred && props[preferred]) return preferred;
    for (const c of candidates) if (props[c]) return c;
    const keys = Object.keys(props);
    for (const c of candidates) {
      const cl = c.toLowerCase();
      const hit = keys.find(k => k.toLowerCase().includes(cl) || cl.includes(k.toLowerCase()));
      if (hit) return hit;
    }
    return optional ? null : (preferred || candidates[0]);
  }

  _idArg(toolName, id, a) {
    // Poll tools sometimes take an ARRAY of ids; detect from the schema.
    const props = this._schemaProps(toolName);
    const key = this._param(toolName, ['identifiers', 'creationIdentifier', 'identifier', 'id'], a.statusIdParam || a.pollIdParam);
    const prop = props && props[key];
    if (prop && prop.type === 'array') return [id];
    return id;
  }

  // ── Defensive parsing helpers (response shapes vary by MCP) ─────────────────

  _toBuffer(ref) {
    let mimeType = 'image/png';
    let buffer;
    if (ref && typeof ref === 'object' && ref.data != null) {
      mimeType = ref.mimeType || mimeType;
      buffer = Buffer.isBuffer(ref.data) ? ref.data : Buffer.from(String(ref.data), 'base64');
    } else if (Buffer.isBuffer(ref)) {
      buffer = ref;
    } else if (typeof ref === 'string' && ref.startsWith('data:')) {
      const m = ref.match(/^data:([^;]+);base64,(.*)$/);
      if (m) { mimeType = m[1]; buffer = Buffer.from(m[2], 'base64'); }
    } else if (typeof ref === 'string') {
      buffer = Buffer.from(ref, 'base64');
    }
    if (!buffer) throw new Error(`MCP ${this.server}: unsupported reference shape for upload`);
    return { buffer, mimeType };
  }

  _extractIds(res) {
    const ids = [];
    // Any key that looks like an identifier holder (singular or plural).
    const ID_KEY = /(^id$|identifier|creationid)/i;
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      for (const [k, val] of Object.entries(v)) {
        if (ID_KEY.test(k)) {
          if (typeof val === 'string' && val) ids.push(val);
          else if (Array.isArray(val)) {
            for (const el of val) {
              if (typeof el === 'string' && el) ids.push(el);
              else if (el && typeof el === 'object' && typeof el.identifier === 'string') ids.push(el.identifier);
            }
          }
        }
      }
      for (const val of Object.values(v)) if (val && typeof val === 'object') visit(val);
    };
    visit(res);
    return [...new Set(ids)];
  }

  _extractAssets(res) {
    const assets = [];
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (typeof v.url === 'string' && /^https?:\/\//i.test(v.url)) assets.push({ url: v.url });
      else if (typeof v.data === 'string' && v.data.length > 256) assets.push({ data: v.data, mimeType: v.mimeType || 'image/png' });
      for (const val of Object.values(v)) if (val && typeof val === 'object') visit(val);
    };
    visit(res);
    return assets;
  }

  /**
   * Best-effort asset extraction from a fetch/creations_get response, tried in
   * order of confidence: mapped urlPath / known url-ish keys → objects carrying
   * `{ url }` or base64 `{ data }` → ANY bare http(s) URL string anywhere. The
   * last tier matters because Freepik/Magnific return finished assets as
   * `generated: ["https://…"]` — an array of bare strings under a non-`url` key
   * that the keyed lookups (`_resolveUrl`/`_extractAssets`) silently miss.
   */
  _extractAnyAssets(res) {
    const mapped = this._resolveUrl(res);
    if (mapped) return [{ url: mapped }];
    const structured = this._extractAssets(res);
    if (structured.length) return structured;
    return this._deepFindUrlStrings(res).map(url => ({ url }));
  }

  /** Collect every distinct http(s) URL string anywhere in the response. */
  _deepFindUrlStrings(res) {
    const urls = [];
    const seen = new Set();
    const visit = (v) => {
      if (typeof v === 'string') {
        const s = v.trim();
        if (/^https?:\/\/\S+$/i.test(s) && !seen.has(s)) { seen.add(s); urls.push(s); }
        return;
      }
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (v && typeof v === 'object') for (const val of Object.values(v)) visit(val);
    };
    visit(res);
    return urls;
  }

  _looksFailed(res) {
    const s = this._deepFindString(res, ['status', 'state']);
    return typeof s === 'string' && /fail|error|cancel/i.test(s);
  }

  _deepFindString(res, keys) {
    let found = null;
    const set = new Set(keys);
    const visit = (v) => {
      if (found || !v || typeof v !== 'object') return;
      for (const [k, val] of Object.entries(v)) {
        if (found) return;
        if (set.has(k) && typeof val === 'string' && val) { found = val; return; }
        if (val && typeof val === 'object') visit(val);
      }
    };
    visit(res);
    return found;
  }

  _deepHasKey(res, key) {
    let has = false;
    const visit = (v) => {
      if (has || !v || typeof v !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(v, key) && v[key] != null) { has = true; return; }
      for (const val of Object.values(v)) if (val && typeof val === 'object') visit(val);
    };
    visit(res);
    return has;
  }
}
