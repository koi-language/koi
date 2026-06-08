/**
 * Agent-driven MCP media mapper.
 *
 * When a media-capable MCP is connected but has no current map, an LLM inspects
 * the server's live tools (name + description + inputSchema) and builds the
 * `media` mapping the facade consumes. The result is validated (every referenced
 * tool must really exist) and cached via mcp-media-store, stamped with the
 * toolset hash so it auto-regenerates when the server changes. No hardcoded
 * profiles. See docs/mcp-media-facade.md.
 *
 * Runs automatically (lazily) the first time a media generation happens after a
 * switch — see the trigger in agent/action-registry.js. One LLM call per
 * (server, toolset-version), deduped by an in-flight promise.
 */

import { mcpRegistry } from '../../mcp/mcp-registry.js';
import { toolsetHash, currentMap, writeMap, getDecision } from './mcp-media-store.js';
import { channel } from '../../io/channel.js';

// server name → in-flight mapping promise (dedup concurrent first-uses).
const _inflight = new Map();

const MAP_SPEC = `You are wiring a media MCP server into a host that has fixed media operations.
Produce a JSON object "media" that maps the host operations to THIS server's tools.

You map BOTH the REQUEST (which tool + which params to send) AND the RESPONSE
(where the result fields live), reading each tool's DESCRIPTION to learn the
response shape. Response locations are dot-paths; use "[]" to descend into an
array (e.g. "creations[].identifier" = the identifier of each item in creations).

Target shape (omit any route you can't satisfy with a real tool — do NOT invent tools):
{
  "label": "<short provider name, e.g. Magnific>",
  "generate": {
    "image": { "tool": "<text->image tool>", "promptParam": "<param>", "refsParam": "<param?>", "aspectRatioParam": "<param?>", "modelParam": "<the param that SELECTS which model/engine to use, e.g. one whose description says 'model slug from <list tool>' — like 'mode' or 'model'?>", "modelsListTool": "<the tool that ENUMERATES this route's available models, e.g. images_models_list?>", "idPath": "<path to the creation id(s) THIS tool returns, e.g. creations[].identifier>" },
    "video": { "tool": "<text->video tool>", "promptParam": "<param>", "modelParam": "<the param that SELECTS the model, e.g. 'slug'?>", "modelsListTool": "<the tool that enumerates video models, e.g. video_models_list?>", "idPath": "<path to the job/creation id it returns>" },
    "audio": {
      "speech": { "tool": "<TTS tool>", "textParam": "<param>", "idPath": "<path to the id it returns>" },
      "music":  { "tool": "<music tool>", "promptParam": "<param>", "idPath": "<path to the id it returns>" }
    }
  },
  "operations": {
    "upscale":            { "tool": "<upscaler>", "idParam": "<image-id param>", "scaleParam": "<param?>", "idPath": "<path to the id it returns>" },
    "background_removal": { "tool": "<bg remover>", "idParam": "<image-id param>", "idPath": "<path to the id it returns>" }
  },
  "cameraAngles": { "tool": "<reframe/camera tool>", "idParam": "<image-id param>", "map": { "horizontal": "<param>", "vertical": "<param>", "zoom": "<param>" }, "idPath": "<path to the id it returns>" },
  "avatar": { "tool": "<talking-head/lipsync tool>", "audioParam": "<param>", "imageParam": "<param?>", "idPath": "<path to the job id it returns>" },
  "async": {
    "poll": "<long-poll status tool?>", "pollIdParam": "<param the poll tool takes the id(s) in?>",
    "status": "<single-snapshot status tool?>", "statusIdParam": "<param the status tool takes the id in?>",
    "pendingField": "<field present in the poll/status response ONLY while still running, e.g. poll_after_seconds>",
    "statusPath": "<path to a status string in the response, e.g. creations[].status>", "doneValue": "<status value meaning finished, e.g. completed>", "failValue": "<status value meaning failed, e.g. failed>",
    "timeoutParam": "<param?>", "timeoutSeconds": 25,
    "fetch": "<tool that returns the final asset URL?>", "fetchIdParam": "<param the fetch tool takes the id in?>", "urlPath": "<path to the final full-res asset URL in the fetch response, e.g. url>"
  },
  "uploadRef": { "request": "<presigned-upload request tool?>", "requestUrlPath": "<path to the presigned PUT url in its response>", "requestPathPath": "<path to the temp path/key in its response>", "finalize": "<finalize upload tool?>", "finalizeIdPath": "<path to the creation id after finalize>", "byUrl": "<import-by-URL tool?>", "byUrlIdPath": "<path to the id after byUrl>" }
}

Rules:
- Use EXACT tool names and EXACT param names from the provided tool list.
- For the RESPONSE paths (idPath, urlPath, statusPath, pendingField, …), READ THE
  TOOL'S DESCRIPTION to find where each value lives. If a description says e.g.
  "returns creations[].identifier" or "creations_get → url (full-res)", encode
  exactly that path. Omit a path you genuinely cannot determine.
- "poll" = long-poll status tool (inline image/audio). "status" = single-snapshot
  status tool (deferred video/avatar). "fetch" = tool that yields the final URL.
- Use "pendingField" when the response signals "still running" by the PRESENCE of
  a field; use "statusPath"+"doneValue"/"failValue" when it's a status string.
- If local files must be uploaded before use, fill "uploadRef" (with its response paths).
- Do NOT create generate/operation routes FOR list/picker tools (e.g. *_show, *_list).
  BUT when a generation tool's model param is chosen from a model-list tool, record
  that list tool as the route's "modelsListTool" (and the selecting param as
  "modelParam") so the host can enumerate the provider's models. Read the model
  param's description to find which list tool it points to.
- Output ONLY the JSON object, no prose.`;

// Second-pass: bind the HOST media catalog (its slugs) to THIS provider's model
// ids, so the host picker can choose a model and route it through the MCP. The
// match is on the underlying base model identity; strictness on version/variant
// is essential (a wrong match silently generates with the wrong model). When in
// doubt we OMIT — the caller falls back to the gateway rather than guess.
const COVERAGE_SPEC = `You bind a HOST media catalog to a PROVIDER's model list.
For each HOST model (given as {slug, name}), find the PROVIDER model that is the
SAME underlying base model, and output the PROVIDER model's id (the exact value
the model param expects).

Rules:
- Match on the underlying BASE MODEL identity (e.g. "Nano Banana Pro", "GPT 2",
  "Seedream 5 Lite", "Veo 3.1", "Kling 3.0 Omni"), reading the PROVIDER list's
  slug, name, description and tags. The host slug is provider-namespaced (e.g.
  "fal-ai/nano-banana-pro/edit") — strip the vendor prefix/suffix to read the base.
- Be STRICT about version and variant: 2 vs 2.5, 4 vs 4.5 vs 5, pro vs fast vs
  lite, base vs flash, omni vs standard. A near-name with a DIFFERENT version or
  variant is NOT a match.
- If no PROVIDER model is clearly the same base model, OMIT that host slug. Do NOT
  guess or approximate — a missing entry is correct and safe; a wrong one is not.
- Use PROVIDER model ids copied VERBATIM from the list.
- Output ONLY a JSON object { "<host-slug>": "<provider-model-id>", ... }, no prose.`;

/** Build the LLM instance the same way the media tools do. */
async function _resolveLlm(agent) {
  if (!agent || !agent.llmProvider) return null;
  try {
    const { resolve: resolveModel } = await import('./factory.js');
    await agent.llmProvider._ensureClients?.();
    const { instance } = resolveModel({
      type: 'llm',
      taskType: 'code',
      difficulty: 4,
      availableProviders: agent.llmProvider._availableProviders,
      clients: agent.llmProvider._gatewayMode
        ? agent.llmProvider._gatewayClients()
        : { openai: agent.llmProvider._oa, anthropic: agent.llmProvider._ac, gemini: agent.llmProvider._gc },
    });
    return instance || null;
  } catch {
    return null;
  }
}

/** Remove any route that references a tool the server doesn't actually expose. */
function _prune(media, validNames) {
  if (!media || typeof media !== 'object') return {};
  const ok = (t) => typeof t === 'string' && validNames.has(t);
  const pruneRoute = (r) => {
    if (!r || typeof r !== 'object' || !ok(r.tool)) return null;
    // Keep the whole route (preserves modelParam etc.), but drop a modelsListTool
    // that doesn't reference a real tool so coverage generation won't try to call it.
    if (r.modelsListTool && !ok(r.modelsListTool)) {
      const { modelsListTool, ...rest } = r;
      return rest;
    }
    return r;
  };

  const out = {};
  if (typeof media.label === 'string') out.label = media.label;

  if (media.generate && typeof media.generate === 'object') {
    const g = {};
    const img = pruneRoute(media.generate.image); if (img) g.image = img;
    const vid = pruneRoute(media.generate.video); if (vid) g.video = vid;
    if (media.generate.audio && typeof media.generate.audio === 'object') {
      const a = {};
      const sp = pruneRoute(media.generate.audio.speech); if (sp) a.speech = sp;
      const mu = pruneRoute(media.generate.audio.music); if (mu) a.music = mu;
      if (Object.keys(a).length) g.audio = a;
    }
    if (Object.keys(g).length) out.generate = g;
  }

  if (media.operations && typeof media.operations === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(media.operations)) {
      const r = pruneRoute(v); if (r) o[k] = r;
    }
    if (Object.keys(o).length) out.operations = o;
  }

  const cam = pruneRoute(media.cameraAngles); if (cam) out.cameraAngles = cam;
  const av = pruneRoute(media.avatar); if (av) out.avatar = av;

  if (media.async && typeof media.async === 'object') {
    const a = { ...media.async };
    for (const key of ['poll', 'status', 'fetch']) {
      if (a[key] && !ok(a[key])) delete a[key];
    }
    out.async = a;
  }
  if (media.uploadRef && typeof media.uploadRef === 'object') {
    const u = { ...media.uploadRef };
    for (const key of ['request', 'finalize', 'byUrl']) {
      if (u[key] && !ok(u[key])) delete u[key];
    }
    out.uploadRef = u;
  }
  return out;
}

// NOTE: the mapping is ALWAYS produced by an LLM reading the server's live
// tools. Hardcoded keyword/regex matching of tool names is intentionally NOT
// used here — see docs/mcp-media-facade.md and the project memory rule
// "no-hardcoded-literal-matching". If the LLM can't be reached, we leave the
// server unmapped (falls back to the backend) rather than guess.

/**
 * Second pass: build `media.modelCoverage[kind] = { <host-slug>: <provider-model-id> }`
 * by enumerating the provider's models (via each generate route's modelsListTool)
 * and asking the LLM to bind them to the host catalog slugs. Best-effort and
 * additive — failure on any kind just leaves that kind uncovered (→ gateway).
 * Mutates `media` in place.
 */
async function _buildModelCoverage(server, client, media, llm) {
  const coverage = {};
  const validNames = new Set((client.tools || []).map(t => t.name));
  for (const kind of ['image', 'video']) {
    const route = media.generate && media.generate[kind];
    if (!route || !route.modelParam || !route.modelsListTool) continue;
    if (!validNames.has(route.modelsListTool)) continue;

    // 1) Enumerate THIS provider's models for the kind.
    let listText = '';
    try {
      const raw = await mcpRegistry.callTool(server, route.modelsListTool, {});
      listText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch (err) {
      channel.log('mcp', `[media-mapper] ${server}: ${route.modelsListTool} failed (${err.message}) — no ${kind} coverage`);
      continue;
    }
    if (!listText.trim()) continue;

    // 2) Fetch the HOST catalog rows (slug + name) for this kind.
    let rows = [];
    try {
      const { fetchMediaModelRows } = await import('./gateway.js');
      rows = await fetchMediaModelRows(kind);
    } catch { /* no catalog → skip */ }
    if (!rows.length) {
      channel.log('mcp', `[media-mapper] ${server}: no host ${kind} catalog rows — skipping coverage`);
      continue;
    }

    // 3) LLM binds host slug → provider model id (strict; omit when unsure).
    const koi = rows.map(r => ({ slug: r.slug, name: r.displayName }));
    const prompt =
      `${COVERAGE_SPEC}\n\nPROVIDER (${server}) ${kind} models:\n${listText.slice(0, 24000)}` +
      `\n\nHOST catalog (${kind}):\n${JSON.stringify(koi)}`;
    try {
      const { text } = await llm.complete(
        [{ role: 'user', content: prompt }],
        { responseFormat: 'json_object', timeoutMs: 60000 },
      );
      const stripped = (text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(stripped);
      const map = (parsed && typeof parsed.coverage === 'object' && parsed.coverage) ? parsed.coverage : parsed;
      const clean = {};
      for (const [hostSlug, provId] of Object.entries(map || {})) {
        // Guard against hallucinated ids: the provider id must literally appear
        // in the model list we just fetched.
        if (typeof hostSlug === 'string' && typeof provId === 'string'
          && provId.trim() && listText.includes(provId.trim())) {
          clean[hostSlug] = provId.trim();
        }
      }
      if (Object.keys(clean).length) coverage[kind] = clean;
      channel.log('mcp', `[media-mapper] ${server}: ${kind} coverage = ${Object.keys(clean).length}/${rows.length} host models bound`);
    } catch (err) {
      channel.log('mcp', `[media-mapper] ${server}: ${kind} coverage mapping failed (${err.message})`);
    }
  }
  if (Object.keys(coverage).length) media.modelCoverage = coverage;
}

async function _mapServer(server, client, agent) {
  const hash = toolsetHash(client);
  const tools = (client.tools || []).map(t => {
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    // Include each param's description + enum (truncated) so the LLM can spot the
    // model-selector param (e.g. `mode` → "Model slug from images_models_list")
    // and the list tool it points to. Plain names alone hid that signal.
    const params = Object.entries(props).slice(0, 24).map(([k, v]) => {
      const d = v && typeof v.description === 'string' ? v.description.slice(0, 110) : '';
      const en = v && Array.isArray(v.enum) ? ` enum:[${v.enum.slice(0, 12).join(',')}]` : '';
      return (d || en) ? `${k} — ${d}${en}` : k;
    });
    return { name: t.name, description: (t.description || '').slice(0, 240), params };
  });
  const validNames = new Set(tools.map(t => t.name));

  const llm = await _resolveLlm(agent);
  if (!llm) {
    // No LLM right now (e.g. no agent turn yet). Do NOT write a cache entry —
    // leave it unmapped so the next attempt (once an LLM is available) re-runs.
    channel.log('mcp', `[media-mapper] ${server}: no LLM available yet — will retry`);
    return null;
  }

  const prompt =
    `${MAP_SPEC}\n\nServer: ${server}\nTools (use these EXACT names and param names):\n${JSON.stringify(tools, null, 2)}`;

  let media = null;
  let rawText = '';
  try {
    const { text } = await llm.complete(
      [{ role: 'user', content: prompt }],
      { responseFormat: 'json_object', timeoutMs: 60000 },
    );
    rawText = text || '';
    const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped);
    // The model often wraps the result in a top-level { "media": {...} } (the
    // spec calls the object "media"). Unwrap it so _prune sees generate/operations.
    const mediaObj = (parsed && typeof parsed.media === 'object' && parsed.media) ? parsed.media : parsed;
    media = _prune(mediaObj, validNames);
    if (!media.label) media.label = server.charAt(0).toUpperCase() + server.slice(1);
  } catch (err) {
    channel.log('mcp', `[media-mapper] ${server}: mapping FAILED (${err.message}). Raw LLM output: ${rawText.slice(0, 600)}`);
    return null; // don't cache a failure → retry next time
  }

  const genCount = Object.keys(media.generate || {}).length;
  const opCount = Object.keys(media.operations || {}).length;
  if (genCount === 0 && opCount === 0) {
    // The LLM returned valid JSON but no usable routes — log the raw output so
    // the prompt can be tuned, and don't cache it so we retry.
    channel.log('mcp', `[media-mapper] ${server}: LLM produced NO routes. Raw output: ${rawText.slice(0, 600)}`);
    return null;
  }

  // Second pass: bind host catalog slugs → this provider's model ids (best-effort,
  // additive — never blocks the base map). Inert until the router consumes it.
  try {
    await _buildModelCoverage(server, client, media, llm);
  } catch (err) {
    channel.log('mcp', `[media-mapper] ${server}: model coverage pass failed (${err.message})`);
  }

  writeMap(server, hash, media);
  const covCount = media.modelCoverage
    ? Object.entries(media.modelCoverage).map(([k, v]) => `${k}:${Object.keys(v).length}`).join(' ')
    : 'none';
  channel.log('mcp', `[media-mapper] ${server}: mapped ${genCount} generate + ${opCount} operations | coverage ${covCount}`);
  return media;
}

/**
 * Map a single MCP server by name (used by the GUI to pre-warm on activate or
 * force a re-map). With `force`, ignores the cache and regenerates.
 * @returns {Promise<object|null>} the media map, or null if not mappable.
 */
export async function mapServerByName(server, agent, { force = false } = {}) {
  const client = mcpRegistry.get(server);
  // Ensure tools are loaded (clients set `initialized`, not `connected`).
  if (!client || !client.initialized || !(Array.isArray(client.tools) && client.tools.length)) {
    try { await mcpRegistry.connect(server); } catch { /* leave unconnected */ }
  }
  const live = mcpRegistry.get(server);
  if (!live || !Array.isArray(live.tools) || !live.tools.length) return null;
  if (!force) {
    const cached = currentMap(server, live);
    if (cached) return cached;
  }
  let p = _inflight.get(server);
  if (!p) {
    p = _mapServer(server, live, agent).finally(() => _inflight.delete(server));
    _inflight.set(server, p);
  }
  return p;
}

/**
 * Ensure every connected, media-looking MCP has a current map for `kind`.
 * Runs the LLM mapper (once per toolset version) when needed. Safe to call on
 * every media generation — it no-ops when maps are already current.
 * @returns {Promise<void>}
 */
export async function ensureMediaMapsForKind(kind, agent) {
  try {
    for (const [name, client] of mcpRegistry.entries()) {
      if (!client) continue;
      // "Ready" = tools loaded. NOT client.connected (the MCP clients only set
      // `initialized`, so `connected` is always falsy — this check used to skip
      // every server and nothing ever got mapped).
      const ready = (Array.isArray(client.tools) && client.tools.length > 0)
        || client.initialized;
      if (!ready) continue;
      if (client.media) continue; // explicit .mcp.json override → never auto-map
      if (getDecision(name) !== 'enabled') continue; // only re-map opted-in servers
      if (currentMap(name, client)) continue; // already mapped for this toolset
      let p = _inflight.get(name);
      if (!p) {
        p = _mapServer(name, client, agent).finally(() => _inflight.delete(name));
        _inflight.set(name, p);
      }
      await p;
    }
  } catch { /* mapping is best-effort — never block generation */ }
}
