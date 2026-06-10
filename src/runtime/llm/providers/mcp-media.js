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

// Fallback host-knob → tool-param mapping, used ONLY when a server's map lacks
// `inputs` (old/partial map). The live map's per-route `inputs` (LLM-generated at
// connect) is the source of truth. Each entry: { koi, names (candidate tool
// params, resolved against the live schema), norm? (value transform) }.
// NOTE: there is intentionally NO generation-knob fallback table. Knob→param
// mapping for generate routes comes 100% from the connect-time LLM map
// (`route.inputs`), whose host-knob vocabulary is derived from Koi's OWN
// generate_* action schemas (see mcp-media-mapper.js _hostKnobs). A static
// name-guessing table here is exactly the hardcoding we're avoiding. Operations
// keep a tiny fallback below only because they have no connect-time `inputs`.
const _OP_INPUT_FALLBACK = [
  { koi: 'upscaleFactor', names: ['scale', 'upscaleFactor', 'factor'] },
  { koi: 'prompt', names: ['prompt', 'text'] },
  { koi: 'creativity', names: ['creativity'] },
  { koi: 'faceEnhancement', names: ['faceEnhancement', 'face_enhancement'] },
  { koi: 'outputFormat', names: ['outputFormat', 'output_format', 'format'] },
];

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
    // Each value is resolved to the tool's REAL param name AND coerced to the
    // shape that param's live schema declares (enum format, scalar→array,
    // id→{type,identifier}, type casts). One generic engine — no per-quirk patches.
    this._setArg(tool, args, ['prompt', 'text', 'query', 'video'], route.promptParam, prompt, { optional: false });
    if (mappedModel) this._setArg(tool, args, [route.modelParam, 'mode', 'model', 'engine', 'slug'], route.modelParam, mappedModel);

    // Forward the generation knobs the caller set. The mapping (which host knob
    // → which tool param + value transform) is 100% DATA-DRIVEN from the map's
    // `route.inputs` (LLM-generated at connect, host-knob vocabulary derived
    // from Koi's generate_* schemas). No static fallback — a knob the map
    // didn't capture is simply not sent (and the map regenerates on schema/
    // version change).
    this._applyInputs(tool, args, route.inputs, opts);

    if (Array.isArray(opts.referenceImages) && opts.referenceImages.length) {
      const ids = [];
      for (const ref of opts.referenceImages) ids.push(await this._uploadAsset(ref, opts));
      this._setArg(tool, args, ['references', 'reference_images', 'referenceImages', 'images'], route.refsParam, ids);
    }

    // startFrame / endFrame — the LITERAL first/last frame (image-to-video).
    // First-class image inputs (like referenceImages): upload the file, then
    // place the creation id at the mapped param. The param is whatever the
    // map says (`route.startFrameParam` / `endFrameParam`) — flat for a flat
    // tool, or a nested path like `video.clips[].keyframes.start` for a
    // structured one; `_setImageInput` coerces the id to the leaf schema
    // ({type,url} object, bare string, …) so it stays generic per server.
    await this._setImageInput(tool, args, route.startFrameParam, opts.startFrame, opts);
    await this._setImageInput(tool, args, route.endFrameParam, opts.endFrame, opts);

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
    const args = {};
    this._setArg(tool, args, ['creationIdentifier', 'identifier', 'id'], route.idParam, srcId, { optional: false });
    // Operation knobs (scale, creativity, …) are data-driven from `route.inputs`;
    // the code table is a fallback. `_coerceArg` turns e.g. upscaleFactor 2 → "2x"
    // when the tool's scale param is an enum like ["2x","4x"].
    this._applyInputs(tool, args, route.inputs, opts, _OP_INPUT_FALLBACK);
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
    if (audioId) this._setArg(tool, args, ['audioUrl', 'audio', 'audioIdentifier'], route.audioParam, audioId, { optional: false });
    if (imageId) this._setArg(tool, args, ['imageUrl', 'image', 'imageIdentifier'], route.imageParam, imageId);
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

    // Granular status string + ETA for the GUI progress badge/bar. Data-driven
    // from the map's async config (`statusPath` for "queued"/"processing", new
    // `etaPath` for the seconds-remaining the host uses to pace the bar — both
    // LLM-mapped at connect). Generic fallback to a deep `status`/`state` field
    // so an unmapped profile still surfaces something. Rides along on every
    // return so the poller can relay it without a second call.
    const rawStatus = (a.statusPath ? this._pathFirst(res, a.statusPath) : null)
      || this._deepFindString(res, ['status', 'state']) || null;
    let etaSeconds = null;
    if (a.etaPath) { const n = Number(this._pathFirst(res, a.etaPath)); if (Number.isFinite(n)) etaSeconds = n; }
    const meta = { rawStatus, etaSeconds };

    if (this._isFailed(res)) {
      return { id: jobId, status: 'failed', model: this.model, error: this._deepFindString(res, ['error', 'message', 'failureReason']) || 'failed', ...meta };
    }
    if (this._isPending(res)) {
      return { id: jobId, status: 'pending', model: this.model, ...meta };
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
    return { id: jobId, status: url ? 'completed' : 'pending', url, model: this.model, ...meta };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async _cameraAngle(prompt, opts) {
    const route = this.media.cameraAngles;
    const tool = this._resolveToolName(route.tool);
    const srcRef = (opts.referenceImages && opts.referenceImages[0]) || null;
    if (!srcRef) return this._fallback('generate', [prompt, opts], 'cameraAngles needs a reference image');
    const srcId = await this._uploadOne(srcRef, opts);
    const args = {};
    this._setArg(tool, args, ['creationIdentifier', 'identifier', 'id'], route.idParam, srcId, { optional: false });
    const map = route.map || {};
    for (const axis of ['horizontal', 'vertical', 'zoom']) {
      if (typeof opts.cameraAngles[axis] === 'number' && map[axis]) {
        this._setArg(tool, args, [map[axis]], map[axis], opts.cameraAngles[axis]);
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
    this._setArg(tool, args, mode === 'music' ? ['prompt', 'text'] : ['text', 'prompt'], route.textParam || route.promptParam, input, { optional: false });
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
   * Resolve a logical value to a tool's REAL param name AND coerce it to the
   * shape that param's live schema declares, then set it on `args`. This is the
   * ONE place value-shaping happens — no per-quirk helpers. Skips silently when
   * the param isn't declared (unless optional:false).
   */
  _setArg(tool, args, candidates, preferred, value, { optional = true } = {}) {
    // NESTED PATH form ("a.b[].c"): the connect-time map can point a logical
    // knob at a param buried inside a structured input (e.g. a video tool whose
    // schema is `{ video: { clips: [{ prompt, slug, duration, references:[…] }] } }`
    // → promptParam "video.clips[].prompt"). Resolve the LEAF param's schema by
    // walking the path, coerce the value to it (so refs become [{type,url}],
    // scalars wrap, enums snap — the SAME `_coerceArg` engine as flat params),
    // then write it into the nested args. Fully generic: driven by the map, no
    // per-server code. A bare name (no '.' / '[]') keeps the flat path below.
    const pathParam = [preferred, ...(candidates || [])]
      .find((c) => typeof c === 'string' && /[.[]/.test(c));
    if (pathParam) {
      const leaf = this._schemaAtPath(tool, pathParam);
      this._setPath(args, pathParam, leaf ? this._coerceArg(leaf, value) : value);
      return;
    }
    const key = this._param(tool, candidates, preferred, optional);
    if (!key) return;
    const props = this._schemaProps(tool);
    const schema = props && props[key];
    args[key] = schema ? this._coerceArg(schema, value) : value;
  }

  /**
   * Place a single image input (startFrame / endFrame) at a mapped param.
   * Uploads the file to a creation id, coerces it to the leaf param's schema
   * (a bare string, or a `{type,url}` object for a keyframe), and writes it.
   * No-op when the param isn't mapped or no image was given. Generic — works
   * for a flat string param OR a nested path; the only media-specific touch is
   * defaulting an object's required `type` to "image" when the schema declares
   * it but offers no enum to pick from (e.g. keyframes.start.{type,url}).
   */
  async _setImageInput(tool, args, param, ref, opts) {
    if (!param || !ref) return;
    const id = await this._uploadAsset(ref, opts);
    const leaf = this._schemaAtPath(tool, param);
    let val = leaf ? this._coerceArg(leaf, id) : id;
    if (val && typeof val === 'object' && !Array.isArray(val) && val.type == null
        && leaf && leaf.properties && leaf.properties.type) {
      val.type = 'image';
    }
    this._setPath(args, param, val);
  }

  /**
   * Resolve the JSON-Schema of the LEAF param named by a nested path like
   * "video.clips[].prompt": walk object properties via ".", descend into array
   * items where a token ends with "[]". Returns null when the path can't be
   * resolved against the live tool schema (caller then sets the raw value).
   */
  _schemaAtPath(tool, path) {
    let props = this._schemaProps(tool);
    if (!props) return null;
    const tokens = String(path).split('.');
    let schema = null;
    for (let i = 0; i < tokens.length; i++) {
      let name = tokens[i];
      const intoArray = name.endsWith('[]');
      if (intoArray) name = name.slice(0, -2);
      schema = props ? props[name] : null;
      if (!schema) return null;
      const isLast = i === tokens.length - 1;
      if (intoArray && !isLast) schema = schema.items || schema; // descend for deeper tokens
      props = (schema && schema.properties) ? schema.properties
        : (schema && schema.items && schema.items.properties) ? schema.items.properties
          : null;
    }
    return schema;
  }

  /**
   * Write `value` into `root` at a nested path like "video.clips[].references",
   * creating intermediate objects/arrays as needed ("[]" → a single element).
   * Mirrors _schemaAtPath's path grammar.
   */
  _setPath(root, path, value) {
    const tokens = String(path).split('.');
    let cur = root;
    for (let i = 0; i < tokens.length; i++) {
      let name = tokens[i];
      const intoArray = name.endsWith('[]');
      if (intoArray) name = name.slice(0, -2);
      const isLast = i === tokens.length - 1;
      if (isLast) {
        cur[name] = (intoArray && !Array.isArray(value)) ? [value] : value;
        return;
      }
      if (intoArray) {
        if (!Array.isArray(cur[name])) cur[name] = [];
        if (!cur[name][0] || typeof cur[name][0] !== 'object') cur[name][0] = {};
        cur = cur[name][0];
      } else {
        if (!cur[name] || typeof cur[name] !== 'object') cur[name] = {};
        cur = cur[name];
      }
    }
  }

  /**
   * Forward the caller's generation/operation knobs onto `args`, driven by the
   * map's `routeInputs` (LLM-generated: [{ koi, param, lowercase?, valueMap? }]).
   * The map says WHICH host knob → WHICH tool param + the value transform; the
   * tool's live schema still does the final name resolution + coercion. When the
   * map has no `inputs` (old/partial), fall back to `fallback` (code table) so
   * nothing silently regresses. Either way a knob the tool doesn't declare is
   * dropped by `_setArg`.
   */
  _applyInputs(tool, args, routeInputs, opts, fallback) {
    // The map's `inputs` (LLM-generated) is authoritative for the MAPPING of a
    // knob — its exact tool param + value transform. Build a lookup.
    const fromMap = new Map();
    if (Array.isArray(routeInputs)) {
      for (const e of routeInputs) {
        if (!e || typeof e.koi !== 'string' || typeof e.param !== 'string') continue;
        fromMap.set(e.koi, {
          names: [e.param],
          norm: (v) => {
            if (e.valueMap && typeof e.valueMap === 'object'
              && Object.prototype.hasOwnProperty.call(e.valueMap, v)) return e.valueMap[v];
            if (e.lowercase) return String(v).toLowerCase();
            return v;
          },
        });
      }
    }
    const set = (koi, rule) => {
      const v = opts[koi];
      if (v === undefined || v === null) return;
      this._setArg(tool, args, rule.names, undefined, rule.norm ? rule.norm(v) : v);
    };
    // Iterate the canonical knob VOCABULARY (the host's contract — what Koi can
    // send, which the MCP schema can't know) so no knob is ever forgotten, even
    // if the map's `inputs` missed one. Prefer the map's precise mapping; else
    // resolve the param by candidate names against the live schema.
    const seen = new Set();
    for (const f of (fallback || [])) {
      seen.add(f.koi);
      set(f.koi, fromMap.get(f.koi) || { names: f.names, norm: f.norm });
    }
    // Honour any provider-specific knob the map declares that isn't in the
    // canonical list (e.g. a knob unique to this MCP).
    for (const [koi, rule] of fromMap) {
      if (!seen.has(koi)) set(koi, rule);
    }
  }

  /**
   * Generic, schema-driven value coercion. Given a JSON-Schema fragment for a
   * param and a canonical value, return the value reshaped to FIT that schema —
   * so a different server expressing the same thing differently "just works",
   * with no per-tool patches:
   *   - enum            → exact member, else a formatted/closest match (2 → "2x")
   *   - array           → map members through items; wrap a scalar into [scalar]
   *   - object          → wrap a scalar (e.g. a creation id) into the declared
   *                       object, filling the id-ish field + required enum defaults
   *                       (type → "image" when allowed); pass an existing object through
   *   - number/integer/string/boolean → light type casts
   * Anything it can't infer is returned unchanged (the server then validates).
   * Structural/semantic cases beyond this belong in the LLM map (map-time, cached).
   */
  _coerceArg(schema, value) {
    if (!schema || typeof schema !== 'object' || value == null) return value;

    // Enum: exact member → as-is; else best-effort (number→"2x"/"x2"/"2",
    // case-insensitive); else closest numeric member; else unchanged.
    if (Array.isArray(schema.enum) && schema.enum.length) {
      const en = schema.enum;
      if (en.includes(value)) return value;
      const want = [value, `${value}x`, `x${value}`, String(value)];
      for (const w of want) {
        const hit = en.find((e) => String(e).toLowerCase() === String(w).toLowerCase());
        if (hit !== undefined) return hit;
      }
      const num = (s) => parseFloat(String(s).replace(/[^\d.]/g, ''));
      const v = num(value);
      if (!Number.isNaN(v)) {
        const numeric = en.filter((e) => !Number.isNaN(num(e)));
        if (numeric.length) return numeric.sort((a, b) => Math.abs(num(a) - v) - Math.abs(num(b) - v))[0];
      }
      return value;
    }

    // Array: coerce each member through the item schema; wrap a scalar.
    if (schema.type === 'array' || schema.items) {
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((v) => this._coerceArg(schema.items, v));
    }

    // Object: wrap a scalar (creation id) into the declared shape; pass objects through.
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (props && (schema.type === 'object' || schema.type === undefined)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      const primary = ['identifier', 'id', 'creationIdentifier', 'creationId', 'url', 'value'].find((f) => props[f])
        || Object.keys(props)[0];
      const out = {};
      if (primary) out[primary] = value;
      for (const r of (Array.isArray(schema.required) ? schema.required : [])) {
        if (r === primary || out[r] !== undefined) continue;
        const ps = props[r];
        if (ps && Array.isArray(ps.enum) && ps.enum.length) out[r] = ps.enum.includes('image') ? 'image' : ps.enum[0];
      }
      return out;
    }

    // Scalars: light type casts.
    if (schema.type === 'integer') { const n = parseInt(value, 10); return Number.isNaN(n) ? value : n; }
    if (schema.type === 'number') { const n = parseFloat(value); return Number.isNaN(n) ? value : n; }
    if (schema.type === 'string' && typeof value !== 'string') return String(value);
    if (schema.type === 'boolean') return value === true || value === 'true';
    return value;
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
  /**
   * Upload a local reference and return the value the CURRENT tool's reference
   * fields expect. Image tools accept the bare creation identifier; VIDEO tools
   * validate their reference / keyframe `url` fields as real URLs and reject a
   * bare id ("…url should be a valid URL"), so for video we resolve the id to
   * its asset URL via the map's fetch tool (`creations_get`). Already-URL refs
   * pass straight through.
   */
  async _uploadAsset(ref, opts = {}) {
    const id = await this._uploadOne(ref, opts);
    if (this.kind === 'video') return this._resolveAssetUrl(id);
    return id;
  }

  /** Resolve a creation identifier to its asset URL via the map's async.fetch
   *  tool (e.g. creations_get → url). Returns the input unchanged if it's
   *  already a URL or can't be resolved. */
  async _resolveAssetUrl(idOrUrl) {
    if (typeof idOrUrl === 'string' && /^https?:\/\//i.test(idOrUrl)) return idOrUrl;
    const a = this.media.async || {};
    const fetchTool = this._resolveToolName(a.fetch, true);
    if (!fetchTool) return idOrUrl;
    try {
      const idParam = this._param(fetchTool, ['creationIdentifier', 'identifier', 'id'], a.fetchIdParam);
      const res = await this._call(fetchTool, { [idParam]: idOrUrl });
      // Prefer the mapped DIRECT asset url (`async.urlPath`, the same field used
      // to download outputs) over a generic resolve — references reject `webUrl`.
      const url = (a.urlPath ? this._pathFirst(res, a.urlPath) : null) || this._resolveUrl(res);
      return url || idOrUrl;
    } catch {
      return idOrUrl;
    }
  }

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
