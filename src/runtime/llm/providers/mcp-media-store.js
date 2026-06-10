/**
 * Persistence + helpers for AGENT-GENERATED MCP media maps.
 *
 * When the user switches to a media MCP (e.g. Magnific), an LLM inspects the
 * server's live tools and builds the `media` mapping (see mcp-media-mapper.js).
 * That map is cached here, keyed by server name and stamped with a hash of the
 * server's toolset so it auto-invalidates (and re-maps) when the MCP changes its
 * tools. No hardcoded per-provider profiles — the map is always derived from
 * what the server actually exposes. See docs/mcp-media-facade.md.
 *
 * Runtime-owned files under ~/.koi/mcp-media-maps/<server>.json — same pattern
 * as media-cost-approve.json / voice-registry (Koi owns them outright, no race
 * with koi-cli's cached config.json).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Bump when the media-map SHAPE changes (e.g. new agent-mapped response paths),
// so previously-cached maps are invalidated and re-generated with the new spec.
// v3: added per-route `modelParam`/`modelsListTool` + top-level `modelCoverage`
// (catalog-slug → external model id) for picker→MCP routing.
// v4: added per-route `inputs` (host knob → tool param + value transform), so the
// input mapping is data-driven from the map, not hand-listed in mcp-media.js.
// v5: param fields may be NESTED PATHS ("video.clips[].prompt") so structured
// tools (e.g. Magnific video_generate) map correctly; host-knob vocabulary is
// now derived from Koi's generate_* schemas and the static fallback was removed.
const MAP_VERSION = 5;

function _dir() {
  return path.join(os.homedir(), '.koi', 'mcp-media-maps');
}
function _file(server) {
  // Sanitise the server name into a safe filename.
  const safe = String(server).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(_dir(), `${safe}.json`);
}

/** djb2 string hash → short hex. Stable, no crypto import needed. */
function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * Stable fingerprint of a client's toolset (names + each tool's param keys).
 * Changes whenever the server adds/removes/renames a tool or its params, which
 * is exactly when the cached map should be regenerated.
 */
export function toolsetHash(client) {
  const tools = (client && Array.isArray(client.tools)) ? client.tools : [];
  const sig = tools
    .map(t => {
      const props = t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties).sort() : [];
      return `${t.name}(${props.join(',')})`;
    })
    .sort()
    .join('|');
  return _hash(sig);
}

/** Cheap pre-filter: does this server look like it has media-generation tools? */
export function looksMediaCapable(client) {
  return detectMediaKinds(client).length > 0;
}

/**
 * Cheap classification of which media KINDS a server appears to generate, by
 * scanning tool names/descriptions. Used to populate the opt-in dialog ("this
 * MCP can generate image / video / audio — use it instead of the backend?").
 * It's a hint for the dialog; the real wiring is the LLM mapper after opt-in.
 * @returns {Array<'image'|'video'|'audio'>}
 */
export function detectMediaKinds(client) {
  const tools = (client && Array.isArray(client.tools)) ? client.tools : [];
  if (!tools.length) return [];
  const hay = tools.map(t => `${t.name || ''} ${t.description || ''}`.toLowerCase());
  const any = (re) => hay.some(h => re.test(h));
  const GEN = /(generat|create|render|synth|text.?to|t2i|t2v|i2v|upscale|paint|diffusion)/;
  const kinds = [];
  if (any(/(image|photo|picture|upscale|background|paint|svg|t2i)/) && (any(GEN) || any(/image/))) kinds.push('image');
  if (any(/(video|clip|t2v|i2v|lipsync|talking)/)) kinds.push('video');
  if (any(/(audio|tts|speech|voice|music|sound|song|narrat)/)) kinds.push('audio');
  return kinds;
}

/**
 * Per-server media decision: 'enabled' (use this MCP for media), 'declined'
 * (asked and the user said no — don't ask again), or null (not asked yet).
 */
export function getDecision(server) {
  const data = readMap(server);
  return (data && (data.decision === 'enabled' || data.decision === 'declined')) ? data.decision : null;
}

export function setDecision(server, decision) {
  const existing = readMap(server) || {};
  return _write(server, { ...existing, decision });
}

/** Read the full sidecar record for a server → { decision?, toolsetHash?, media? } | null. */
export function readMap(server) {
  try {
    const raw = fs.readFileSync(_file(server), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch { /* missing / unreadable → null */ }
  return null;
}

/** Atomic raw write (tmp + rename). Best-effort. */
function _write(server, obj) {
  try {
    const dir = _dir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = _file(server);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Persist a generated map, preserving the existing decision. */
export function writeMap(server, hash, media) {
  const existing = readMap(server) || {};
  return _write(server, { ...existing, toolsetHash: hash, mapVersion: MAP_VERSION, media });
}

/** Return the cached media map IFF it's still valid AND actually has routes. */
export function currentMap(server, client) {
  const cached = readMap(server);
  if (!cached) return null;
  if (cached.mapVersion !== MAP_VERSION) return null; // old map shape → re-map
  if (cached.toolsetHash !== toolsetHash(client)) return null; // stale → needs re-map
  const m = cached.media;
  // A label-only map (no generate/operations) means a prior mapping produced
  // nothing usable — treat it as "no map" so the mapper re-runs and self-heals.
  if (!m || (!m.generate && !m.operations)) return null;
  return m;
}
