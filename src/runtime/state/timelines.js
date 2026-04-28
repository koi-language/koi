/**
 * Per-project video timeline storage.
 *
 * One JSON file per timeline lives in `<projectRoot>/.koi/timelines/<id>.json`,
 * checked into the project alongside source so an edit survives session
 * teardown and is reproducible from a clean checkout.
 *
 * Schema (versioned via `version`, currently 2):
 *
 * {
 *   "id":          string  // immutable, e.g. "tl-1730000000-abc"
 *   "name":        string  // user-visible, defaults to "Timeline N"
 *   "version":     2
 *   "createdAt":   ISO-8601 timestamp
 *   "updatedAt":   ISO-8601 timestamp (touched on every mutation)
 *
 *   "settings": {
 *     "videoTracks":      int  // count of V tracks (V1..Vn)
 *     "audioTracks":      int  // count of A tracks (A1..An)
 *     "pixelsPerSecond":  number
 *     "previewSplit":     number 0..1   // viewer / timeline split fraction
 *     "playheadMs":       int
 *   }
 *
 *   "clips": [
 *     {
 *       "id":            string  // stable random id, e.g. "clip-a3f9c2"
 *       "track":         string  // "V1" | "V2" | "A1" | "A2" | …
 *       "path":          string  // ABSOLUTE path to source media
 *       "startMs":       int     // position on the timeline
 *       "durationMs":    int     // visible portion (out − in inside source)
 *       "sourceInMs":    int     // offset INTO the source (trim-in)
 *       "sourceTotalMs": int     // source media's true duration; 0 = unknown
 *       "linkId":        string? // shared id pinning V/A peers together
 *       "offsetX":       number? // visual transform — pan X (default 0)
 *       "offsetY":       number? // visual transform — pan Y (default 0)
 *       "scale":         number? // visual transform — uniform scale (default 1)
 *
 *       // Optional transitions. transitionIn fires at startMs; transitionOut
 *       // fires at startMs+durationMs. When a same-track neighbour exists at
 *       // the join, transitionIn defines the cross-effect between the two
 *       // clips (renderer overlaps `durationMs` of source on each side); with
 *       // no neighbour it fades from black/silence. transitionOut is honoured
 *       // only when there is no following clip on the same track (end-of-
 *       // timeline fade-out) — otherwise the next clip's transitionIn wins.
 *       // alignment ∈ {"center" (default) | "start-on-cut" | "end-on-cut"}
 *       // — matches DaVinci Resolve's three placement modes.
 *       "transitionIn":  { type: string, durationMs: int, alignment?: string, params?: object }?
 *       "transitionOut": { type: string, durationMs: int, alignment?: string, params?: object }?
 *     }
 *   ]
 * }
 *
 * `tracks` are NOT a top-level array — they are implicit from the
 * settings counts plus the per-clip `track` field. This keeps the
 * format flat and makes it trivial to merge / diff / regenerate a
 * whole timeline from an LLM tool.
 *
 * Clip identity: every clip carries a stable `id` independent of its
 * position. All single-clip mutators (move/trim/remove/update) take a
 * `clipId` and never (track, startMs) — moving a clip can't invalidate
 * a future tool call mid-edit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 2;

// ── Filesystem helpers ───────────────────────────────────────────────

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

function _dir() {
  return path.join(_projectRoot(), '.koi', 'timelines');
}

function _ensureDir() {
  const koiDir = path.join(_projectRoot(), '.koi');
  if (!fs.existsSync(koiDir)) {
    fs.mkdirSync(koiDir, { recursive: true });
  }
  const dir = _dir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _filePath(id) {
  // Refuse path-traversal IDs. Real ids only contain alnum + dashes.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(id)) {
    throw new Error(`Invalid timeline id: ${JSON.stringify(id)}`);
  }
  return path.join(_dir(), `${id}.json`);
}

function _newId() {
  return `tl-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// Pure-random clip id — no timestamp on purpose. A clip's id is its
// identity; moving/trimming it must not change it, so anything that
// would imply an order or creation moment would be misleading.
function _newClipId() {
  return `clip-${randomBytes(4).toString('hex')}`;
}

const _CLIP_ID_RE = /^clip-[A-Za-z0-9]{4,32}$/;

function _now() {
  return new Date().toISOString();
}

// ── Validation / normalisation ───────────────────────────────────────

function _isVideoTrack(key) { return /^V\d+$/.test(key); }
function _isAudioTrack(key) { return /^A\d+$/.test(key); }
function _trackIdx(key) { return parseInt(key.substring(1), 10); }

// Allowed transition types. Map 1:1 to FFmpeg `xfade` transitions at render time.
// Extending this list = add the string here and a mapping in the renderer.
const TRANSITION_TYPES = new Set([
  'crossfade', 'fade-black', 'fade-white', 'dissolve',
  'slide-left', 'slide-right', 'slide-up', 'slide-down',
  'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
  'circle-open', 'circle-close',
  'pixelize', 'zoom-in', 'radial',
]);

// Where the transition window sits relative to its anchor edit point.
// Matches DaVinci Resolve's three placement modes.
const TRANSITION_ALIGNMENTS = new Set(['center', 'start-on-cut', 'end-on-cut']);

function _validateTransition(t, side, clipDurationMs) {
  if (t === null || t === undefined) return null;
  if (typeof t !== 'object') throw new Error(`clip.${side} must be an object`);
  if (typeof t.type !== 'string' || !TRANSITION_TYPES.has(t.type)) {
    throw new Error(
      `clip.${side}.type invalid: ${JSON.stringify(t.type)} ` +
      `(allowed: ${[...TRANSITION_TYPES].join(', ')})`,
    );
  }
  if (!Number.isFinite(t.durationMs) || t.durationMs < 50) {
    throw new Error(`clip.${side}.durationMs must be ≥ 50ms`);
  }
  const dur = Math.round(t.durationMs);
  // Bound by the clip itself so a transition can't eat more than half its host.
  const maxOnClip = Math.floor(clipDurationMs / 2);
  if (dur > maxOnClip) {
    throw new Error(
      `clip.${side}.durationMs (${dur}) exceeds half of clip.durationMs (${clipDurationMs}); ` +
      `max ${maxOnClip}ms`,
    );
  }
  const alignment = t.alignment ?? 'center';
  if (!TRANSITION_ALIGNMENTS.has(alignment)) {
    throw new Error(
      `clip.${side}.alignment invalid: ${JSON.stringify(alignment)} ` +
      `(allowed: ${[...TRANSITION_ALIGNMENTS].join(', ')})`,
    );
  }
  const out = { type: t.type, durationMs: dur, alignment };
  if (t.params && typeof t.params === 'object') out.params = t.params;
  return out;
}

function _validateClip(c, settings) {
  if (!c || typeof c !== 'object') throw new Error('clip must be an object');
  const { track, path: p, startMs, durationMs } = c;
  if (typeof track !== 'string' || !(_isVideoTrack(track) || _isAudioTrack(track))) {
    throw new Error(`clip.track invalid: ${JSON.stringify(track)} (expected V<n> or A<n>)`);
  }
  const idx = _trackIdx(track);
  const cap = _isVideoTrack(track) ? settings.videoTracks : settings.audioTracks;
  if (idx < 1 || idx > cap) {
    throw new Error(`clip.track ${track} exceeds available tracks (${cap})`);
  }
  if (typeof p !== 'string' || !p) throw new Error('clip.path must be a non-empty string');
  if (!Number.isFinite(startMs) || startMs < 0) throw new Error('clip.startMs must be ≥ 0');
  if (!Number.isFinite(durationMs) || durationMs < 50) throw new Error('clip.durationMs must be ≥ 50ms');
  const dur = Math.round(durationMs);
  // Preserve incoming id when valid; mint a fresh one for new or
  // legacy (v1) clips that never had one. Never regenerate a valid id.
  const clipId = (typeof c.id === 'string' && _CLIP_ID_RE.test(c.id)) ? c.id : _newClipId();
  const out = {
    id: clipId,
    track,
    path: p,
    startMs: Math.round(startMs),
    durationMs: dur,
    sourceInMs: Math.round(c.sourceInMs ?? 0),
    sourceTotalMs: Math.round(c.sourceTotalMs ?? 0),
    linkId: c.linkId ?? null,
  };
  // Visual transform — only persisted when non-default to keep JSON clean.
  if (Number.isFinite(c.offsetX) && c.offsetX !== 0) out.offsetX = c.offsetX;
  if (Number.isFinite(c.offsetY) && c.offsetY !== 0) out.offsetY = c.offsetY;
  if (Number.isFinite(c.scale) && c.scale !== 1) out.scale = c.scale;
  const tIn = _validateTransition(c.transitionIn, 'transitionIn', dur);
  const tOut = _validateTransition(c.transitionOut, 'transitionOut', dur);
  if (tIn) out.transitionIn = tIn;
  if (tOut) out.transitionOut = tOut;
  return out;
}

function _normaliseSettings(s = {}) {
  const videoTracks = Math.max(1, Math.min(10, parseInt(s.videoTracks ?? 2, 10)));
  const audioTracks = Math.max(1, Math.min(10, parseInt(s.audioTracks ?? 2, 10)));
  const pixelsPerSecond = Number.isFinite(s.pixelsPerSecond)
    ? Math.max(10, Math.min(400, s.pixelsPerSecond))
    : 60;
  const previewSplit = Number.isFinite(s.previewSplit)
    ? Math.max(0.1, Math.min(0.9, s.previewSplit))
    : 0.5;
  const playheadMs = Math.max(0, parseInt(s.playheadMs ?? 0, 10));
  return { videoTracks, audioTracks, pixelsPerSecond, previewSplit, playheadMs };
}

function _normalise(state) {
  const settings = _normaliseSettings(state.settings);
  const clips = Array.isArray(state.clips)
    ? state.clips.map((c) => _validateClip(c, settings))
    : [];
  return {
    id: state.id,
    name: typeof state.name === 'string' && state.name.trim() ? state.name.trim() : 'Timeline',
    version: SCHEMA_VERSION,
    createdAt: state.createdAt || _now(),
    updatedAt: _now(),
    settings,
    clips,
  };
}

// ── IO ───────────────────────────────────────────────────────────────

function _read(id) {
  const fp = _filePath(id);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse timeline ${id}: ${e.message}`);
  }
}

function _write(state) {
  _ensureDir();
  const fp = _filePath(state.id);
  // Atomic replace: write to .tmp then rename so a crashed write
  // never leaves a half-flushed JSON file behind.
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, fp);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Create a new timeline. Either fully empty or pre-populated from a
 * `state` argument that follows the JSON schema documented at the top
 * of this file (id and timestamps are filled in for you).
 */
export function createTimeline({ name, settings, clips, state } = {}) {
  const id = _newId();
  let toWrite;
  if (state && typeof state === 'object') {
    toWrite = _normalise({ ...state, id, name: name || state.name });
    toWrite.createdAt = _now();
  } else {
    toWrite = _normalise({
      id,
      name: name || 'Timeline',
      settings,
      clips: clips || [],
    });
  }
  _write(toWrite);
  return toWrite;
}

/** List every timeline file in the project, lightest-touch (no parse cost). */
export function listTimelines() {
  const dir = _dir();
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    try {
      const data = _read(id);
      if (!data) continue;
      entries.push({
        id: data.id,
        name: data.name,
        clipCount: Array.isArray(data.clips) ? data.clips.length : 0,
        videoTracks: data.settings?.videoTracks ?? 0,
        audioTracks: data.settings?.audioTracks ?? 0,
        updatedAt: data.updatedAt,
      });
    } catch { /* skip corrupt */ }
  }
  // Most-recently-edited first.
  entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return entries;
}

/** Read a timeline by ID. Returns the parsed JSON (or null if missing). */
export function getTimeline(id) {
  return _read(id);
}

/**
 * Replace the entire timeline state in one shot. The agent uses this
 * for "set everything at once" — easiest path when generating a new
 * edit from scratch via an LLM template.
 */
export function updateTimeline(id, state) {
  if (!_read(id)) throw new Error(`Timeline ${id} not found`);
  const merged = _normalise({ ...state, id, createdAt: state.createdAt });
  _write(merged);
  return merged;
}

/** Delete a timeline file. Returns true if removed, false if it wasn't there. */
export function deleteTimeline(id) {
  const fp = _filePath(id);
  if (!fs.existsSync(fp)) return false;
  fs.unlinkSync(fp);
  return true;
}

// ── Mutators (single-clip operations) ────────────────────────────────

function _withTimeline(id, mutator) {
  const state = _read(id);
  if (!state) throw new Error(`Timeline ${id} not found`);
  const next = mutator(state) ?? state;
  const normalised = _normalise(next);
  _write(normalised);
  return normalised;
}

/**
 * Append a clip. Returns { clip, timeline } so the caller has the
 * minted id without re-scanning the timeline. `clip.linkId` is optional
 * — set it (and the same value on a sibling clip) to pair V/A peers
 * so that move/trim/remove cascade across the pair.
 */
export function addClip(id, clip) {
  let added;
  const tl = _withTimeline(id, (state) => {
    const validated = _validateClip(clip, state.settings);
    state.clips.push(validated);
    added = validated;
    return state;
  });
  // Re-resolve from the persisted state — _normalise may have re-minted
  // ids on legacy clips around it, but the appended one keeps its id.
  const stored = tl.clips.find((c) => c.id === added.id) || added;
  return { clip: stored, timeline: tl };
}

/** Locate a clip by its stable id. Returns -1 if missing. */
function _findClipIndexById(state, clipId) {
  if (typeof clipId !== 'string' || !clipId) return -1;
  return state.clips.findIndex((c) => c.id === clipId);
}

/** Remove a clip by id. Linked V/A peers vanish too. */
export function removeClip(id, clipId) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    const target = state.clips[i];
    if (target.linkId) {
      state.clips = state.clips.filter((c) => c.linkId !== target.linkId);
    } else {
      state.clips.splice(i, 1);
    }
    return state;
  });
}

/**
 * Move a clip in time and/or change its track. `target` accepts:
 *   - { startMs }            — same track, new start position
 *   - { track }              — same start, new track (same V/A type only)
 *   - { startMs, track }     — both
 * Linked V/A peers shift by the same deltaMs so audio stays sample-aligned.
 */
export function moveClip(id, clipId, target) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    const src = state.clips[i];
    const newStart = Number.isFinite(target?.startMs) ? Math.max(0, Math.round(target.startMs)) : src.startMs;
    const newTrack = typeof target?.track === 'string' ? target.track : src.track;
    if ((newTrack[0] === 'V') !== (src.track[0] === 'V')) {
      throw new Error('Cannot move a clip between video and audio tracks');
    }
    const delta = newStart - src.startMs;
    const peers = src.linkId
      ? state.clips.filter((c) => c.linkId === src.linkId)
      : [src];
    // Clamp delta so no peer goes below 0.
    let d = delta;
    for (const p of peers) {
      if (p.startMs + d < 0) d = -p.startMs;
    }
    for (const p of peers) p.startMs += d;
    src.track = newTrack; // only the targeted clip switches lane
    return state;
  });
}

/**
 * Trim a clip's left or right edge. Two call shapes:
 *   - { edge: -1 | 1, deltaMs }     — relative trim (NLE-style drag)
 *   - { sourceInMs?, durationMs? }  — set absolute values
 * Linked V/A peers trim together so audio stays sample-aligned.
 */
export function trimClip(id, clipId, change) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    const src = state.clips[i];
    const peers = src.linkId
      ? state.clips.filter((c) => c.linkId === src.linkId)
      : [src];
    if (change && (change.edge === -1 || change.edge === 1)) {
      let d = Math.round(change.deltaMs ?? 0);
      if (d === 0) return state;
      if (change.edge === -1) {
        for (const p of peers) {
          d = Math.max(d, -p.sourceInMs);
          d = Math.max(d, -p.startMs);
          d = Math.min(d, p.durationMs - 50);
        }
        for (const p of peers) {
          p.sourceInMs += d;
          p.startMs += d;
          p.durationMs -= d;
        }
      } else {
        for (const p of peers) {
          d = Math.max(d, 50 - p.durationMs);
          if (p.sourceTotalMs > 0) {
            d = Math.min(d, p.sourceTotalMs - p.sourceInMs - p.durationMs);
          }
        }
        for (const p of peers) p.durationMs += d;
      }
    } else if (change && (Number.isFinite(change.sourceInMs) || Number.isFinite(change.durationMs))) {
      // Absolute set — apply to the targeted clip AND peers.
      const newIn = Number.isFinite(change.sourceInMs)
        ? Math.max(0, Math.round(change.sourceInMs))
        : src.sourceInMs;
      const newDur = Number.isFinite(change.durationMs)
        ? Math.max(50, Math.round(change.durationMs))
        : src.durationMs;
      for (const p of peers) {
        p.sourceInMs = newIn;
        p.durationMs = newDur;
      }
    } else {
      throw new Error('trimClip change must specify {edge, deltaMs} or {sourceInMs?, durationMs?}');
    }
    return state;
  });
}

/**
 * Set or clear a clip's transitions. `change` shape:
 *   { in?:  {type, durationMs, params?} | null,
 *     out?: {type, durationMs, params?} | null }
 * - `null` clears that side; an undefined key leaves it untouched.
 * Validation (type enum, ≥ 50ms, ≤ clip.durationMs/2) happens in
 * _validateClip during normalisation.
 */
export function setClipTransition(id, clipId, change) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    if (!change || typeof change !== 'object') {
      throw new Error('setClipTransition change must be an object with in?/out?');
    }
    const c = state.clips[i];
    if ('in' in change) {
      if (change.in === null) delete c.transitionIn;
      else c.transitionIn = change.in;
    }
    if ('out' in change) {
      if (change.out === null) delete c.transitionOut;
      else c.transitionOut = change.out;
    }
    return state;
  });
}

/**
 * General-purpose single-clip patch. `changes` can include any of:
 *   - path     (string)         — replace source media file
 *   - offsetX  (number)         — visual transform pan X
 *   - offsetY  (number)         — visual transform pan Y
 *   - scale    (number)         — visual transform uniform scale
 *   - linkId   (string | null)  — pair with a sibling clip (null clears)
 *
 * Position/duration changes go through moveClip / trimClip; transitions
 * through setClipTransition. Anything else throws so the agent gets a
 * clear error rather than a silently-ignored field.
 */
export function updateClip(id, clipId, changes) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    if (!changes || typeof changes !== 'object') {
      throw new Error('updateClip changes must be an object');
    }
    const allowed = new Set(['path', 'offsetX', 'offsetY', 'scale', 'linkId']);
    for (const key of Object.keys(changes)) {
      if (!allowed.has(key)) {
        throw new Error(
          `updateClip: field '${key}' not patchable here. ` +
          `Use moveClip (startMs/track), trimClip (sourceInMs/durationMs), ` +
          `or setClipTransition (transitionIn/transitionOut).`,
        );
      }
    }
    const c = state.clips[i];
    if ('path' in changes) {
      if (typeof changes.path !== 'string' || !changes.path) {
        throw new Error('updateClip.path must be a non-empty string');
      }
      c.path = changes.path;
    }
    if ('offsetX' in changes) {
      if (!Number.isFinite(changes.offsetX)) throw new Error('updateClip.offsetX must be a number');
      c.offsetX = changes.offsetX;
    }
    if ('offsetY' in changes) {
      if (!Number.isFinite(changes.offsetY)) throw new Error('updateClip.offsetY must be a number');
      c.offsetY = changes.offsetY;
    }
    if ('scale' in changes) {
      if (!Number.isFinite(changes.scale) || changes.scale <= 0) {
        throw new Error('updateClip.scale must be a positive number');
      }
      c.scale = changes.scale;
    }
    if ('linkId' in changes) {
      if (changes.linkId !== null && (typeof changes.linkId !== 'string' || !changes.linkId)) {
        throw new Error('updateClip.linkId must be a non-empty string or null');
      }
      c.linkId = changes.linkId;
    }
    return state;
  });
}

// ── Track add / remove ───────────────────────────────────────────────

/** Append a new V or A track. Returns the new track key (e.g. "V3"). */
export function addTrack(id, type) {
  if (type !== 'video' && type !== 'audio') {
    throw new Error('type must be "video" or "audio"');
  }
  let newKey;
  _withTimeline(id, (state) => {
    if (type === 'video') {
      if (state.settings.videoTracks >= 10) throw new Error('Max 10 video tracks');
      state.settings.videoTracks += 1;
      newKey = `V${state.settings.videoTracks}`;
    } else {
      if (state.settings.audioTracks >= 10) throw new Error('Max 10 audio tracks');
      state.settings.audioTracks += 1;
      newKey = `A${state.settings.audioTracks}`;
    }
    return state;
  });
  return newKey;
}

/**
 * Remove a track and any clips on it (plus linked peers on other
 * tracks, since dropping a video would orphan its audio peer).
 * Higher-numbered tracks of the same type are renumbered down so we
 * never end up with gaps in V1/V2/V3.
 */
export function removeTrack(id, trackKey) {
  return _withTimeline(id, (state) => {
    if (!_isVideoTrack(trackKey) && !_isAudioTrack(trackKey)) {
      throw new Error(`Invalid track key: ${trackKey}`);
    }
    const isVideo = _isVideoTrack(trackKey);
    const cap = isVideo ? state.settings.videoTracks : state.settings.audioTracks;
    if (cap <= 1) {
      // Always keep at least one V and one A. Just clear clips.
      state.clips = state.clips.filter((c) => c.track !== trackKey);
      return state;
    }
    const idx = _trackIdx(trackKey);
    // Drop linked peers of the clips we're about to delete.
    const linkIds = new Set(
      state.clips.filter((c) => c.track === trackKey && c.linkId).map((c) => c.linkId),
    );
    state.clips = state.clips.filter((c) => c.track !== trackKey && !linkIds.has(c.linkId));
    // Renumber higher tracks of the same type down by 1.
    const prefix = isVideo ? 'V' : 'A';
    for (const c of state.clips) {
      if (!c.track.startsWith(prefix)) continue;
      const ci = _trackIdx(c.track);
      if (ci > idx) c.track = `${prefix}${ci - 1}`;
    }
    if (isVideo) state.settings.videoTracks -= 1;
    else state.settings.audioTracks -= 1;
    return state;
  });
}
