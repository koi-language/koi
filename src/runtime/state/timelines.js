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
 *     "markInMs":         int?  // export-range start mark (null = unset)
 *     "markOutMs":        int?  // export-range end mark (null = unset)
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
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 2;

// ── Filesystem helpers ───────────────────────────────────────────────

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

/// Canonical, user-global timelines dir. Matches the GUI's
/// `TimelineLibrary._dir` and the rest of the user-content storage
/// convention (`~/.koi/voices/`, `~/.koi/images/`). Timelines belong
/// to the user, not to a specific project — moving across projects
/// shouldn't lose them.
function _dir() {
  return path.join(os.homedir(), '.koi', 'timelines');
}

/// Legacy directory: previous engine versions wrote `<project>/.koi/
/// timelines/`. Reads still fall back here so old project-scoped files
/// remain reachable. Writes default to [_dir()] so new content lands
/// in the unified location.
function _legacyProjectDir() {
  return path.join(_projectRoot(), '.koi', 'timelines');
}

function _ensureDir() {
  const koiDir = path.join(os.homedir(), '.koi');
  if (!fs.existsSync(koiDir)) {
    fs.mkdirSync(koiDir, { recursive: true });
  }
  const dir = _dir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/// Resolve a timeline id to the file path it currently lives at.
/// Tries the home dir first, then the legacy project dir. Returns
/// the home path even when the file doesn't exist anywhere — callers
/// that need an existence check should use [_findExistingFile].
function _filePath(id) {
  // Refuse path-traversal IDs. Real ids only contain alnum + dashes.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(id)) {
    throw new Error(`Invalid timeline id: ${JSON.stringify(id)}`);
  }
  return path.join(_dir(), `${id}.json`);
}

/// Locate the on-disk file for [id], probing both the canonical home
/// dir and the legacy project dir. Returns null if neither has it.
function _findExistingFile(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(id)) {
    return null;
  }
  const homeFp = path.join(_dir(), `${id}.json`);
  if (fs.existsSync(homeFp)) return homeFp;
  const legacyFp = path.join(_legacyProjectDir(), `${id}.json`);
  if (fs.existsSync(legacyFp)) return legacyFp;
  return null;
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

// Title clips have no real file behind them: their `path` is a synthetic
// `title:<id>` sentinel and the actual text/typography live in a sibling
// `titleProps` object. The GUI (video_timeline_tab.dart) reads/writes the
// same JSON, so the validator must round-trip these props verbatim — anything
// else would silently strip the user's title styling on the next mutation.
const _TITLE_PATH_RE = /^title:[A-Za-z0-9_-]{1,128}$/;
function _isTitlePath(p) { return typeof p === 'string' && _TITLE_PATH_RE.test(p); }
function _newTitlePath() { return `title:${randomBytes(4).toString('hex')}`; }

// Validate / normalise the props sidecar attached to a title clip. We
// preserve every field the GUI knows (see TitleProps in
// video_timeline_tab.dart) but only `text` is required; missing fields
// fall back to the GUI's TitleProps defaults at render time.
function _validateTitleProps(props) {
  if (props == null) return null;
  if (typeof props !== 'object') throw new Error('clip.titleProps must be an object');
  if (typeof props.text !== 'string') throw new Error('clip.titleProps.text must be a string');
  const out = { text: props.text };
  // Pass-through optional typography fields. We only check shape — the GUI
  // clamps the actual values.
  if (typeof props.fontFamily === 'string') out.fontFamily = props.fontFamily;
  if (Number.isFinite(props.fontSize)) out.fontSize = props.fontSize;
  if (Number.isFinite(props.colorArgb)) out.colorArgb = props.colorArgb | 0;
  if (Number.isFinite(props.fontWeight)) out.fontWeight = props.fontWeight | 0;
  if (Number.isFinite(props.align)) out.align = props.align | 0;
  if (typeof props.italic === 'boolean') out.italic = props.italic;
  if (Number.isFinite(props.outlineWidth)) out.outlineWidth = props.outlineWidth;
  if (Number.isFinite(props.outlineColorArgb)) out.outlineColorArgb = props.outlineColorArgb | 0;
  if (Number.isFinite(props.shadowBlur)) out.shadowBlur = props.shadowBlur;
  if (Number.isFinite(props.shadowColorArgb)) out.shadowColorArgb = props.shadowColorArgb | 0;
  return out;
}

// Volume automation curve attached to an audio clip. Each entry is
// `{ t: clipLocalMs, v: linearGain }`. v=1.0 is unity, 0.0 silent,
// values >1 boost (capped at 2.0 = +6 dB). The GUI (video_timeline_tab.dart)
// and the macOS native player (BraxilTimelinePlayer.swift) read the
// same JSON shape, so this validator only checks types — does NOT
// resort, since the GUI/player handle ordering.
function _validateVolumePoints(pts, clipDurationMs) {
  if (pts == null) return null;
  if (!Array.isArray(pts)) throw new Error('clip.volumePoints must be an array');
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || typeof p !== 'object') {
      throw new Error(`clip.volumePoints[${i}] must be an object`);
    }
    const t = Number(p.t);
    const v = Number(p.v);
    if (!Number.isFinite(t) || t < 0 || t > clipDurationMs) {
      throw new Error(
        `clip.volumePoints[${i}].t must be in [0, ${clipDurationMs}] (got ${p.t})`,
      );
    }
    if (!Number.isFinite(v) || v < 0 || v > 2) {
      throw new Error(
        `clip.volumePoints[${i}].v must be in [0, 2] linear gain (got ${p.v})`,
      );
    }
    out.push({ t: Math.round(t), v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

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
  // Title clips (path === 'title:<id>') only make sense on video tracks —
  // they're a visual overlay, not audio. Reject early so the agent gets a
  // clear error instead of an "invisible" clip on an A track.
  if (_isTitlePath(p) && !_isVideoTrack(track)) {
    throw new Error(`Title clip ${p} must live on a video track, not ${track}`);
  }
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
  // Round-trip the title sidecar so a re-validation pass (any mutator
  // re-normalises every clip) doesn't silently drop the typography
  // payload set by add_title / update_title / the GUI editor.
  if (_isTitlePath(p)) {
    const tp = _validateTitleProps(c.titleProps);
    if (tp) out.titleProps = tp;
  }
  // Audio-clip volume automation curve. Same round-trip discipline as
  // titleProps — without explicit pass-through, any unrelated mutator
  // would strip the agent's keyframes on the next save.
  if (_isAudioTrack(track)) {
    const vps = _validateVolumePoints(c.volumePoints, dur);
    if (vps && vps.length > 0) out.volumePoints = vps;
  }
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
  // I/O marks for fragment / frame export and "work on a part" actions.
  // Stored as integer milliseconds, or omitted when unset. We don't
  // enforce in < out here because the GUI can momentarily place either
  // mark first; drop a clearly-invalid pair (out <= in) defensively
  // since downstream consumers (export dialog, render-timeline rangeMs)
  // assume a valid range when both are set.
  const markInRaw = s.markInMs;
  const markOutRaw = s.markOutMs;
  let markInMs = Number.isFinite(markInRaw) && markInRaw >= 0
    ? Math.max(0, parseInt(markInRaw, 10))
    : null;
  let markOutMs = Number.isFinite(markOutRaw) && markOutRaw >= 0
    ? Math.max(0, parseInt(markOutRaw, 10))
    : null;
  if (markInMs != null && markOutMs != null && markOutMs <= markInMs) {
    markOutMs = null;
  }
  const out = { videoTracks, audioTracks, pixelsPerSecond, previewSplit, playheadMs };
  if (markInMs != null) out.markInMs = markInMs;
  if (markOutMs != null) out.markOutMs = markOutMs;
  return out;
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
  // Probe both home and legacy project dirs so a timeline created by
  // either the GUI (home) or an older engine (project) is reachable.
  const fp = _findExistingFile(id);
  if (fp == null) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse timeline ${id}: ${e.message}`);
  }
}

function _write(state) {
  _ensureDir();
  // Preserve the file's existing location: if a row already lives in
  // the legacy project dir, keep writing there (avoids duplicating
  // the file in the home dir on every save). New timelines default to
  // the canonical home dir.
  const existing = _findExistingFile(state.id);
  const fp = existing ?? _filePath(state.id);
  // Atomic replace: write to .tmp then rename so a crashed write
  // never leaves a half-flushed JSON file behind.
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, fp);
  // Mirror the timeline into the media-library. The library is the
  // single source of truth for the GUI's drawer / creations strip,
  // so a timeline that doesn't exist there is effectively invisible.
  // Fire-and-forget — a failure here MUST NOT block the disk write
  // (the JSON IS the canonical record; the row is the index).
  _mirrorToMediaLibrary(fp, state).catch(() => { /* best-effort */ });
}

/** Best-effort upsert of the timeline row in the media library.
 *  Resolves after the DB write returns; callers don't await. */
async function _mirrorToMediaLibrary(filePath, state) {
  try {
    const { saveTimelineEntry } = await import('./media-library.js');
    // No llmProvider here — the registry layer doesn't have one and
    // we don't want to make every save block on a network round-trip.
    // The migration / a later embed-on-idle pass can fill in vectors
    // for rows that landed without one.
    await saveTimelineEntry(filePath, state, null);
  } catch (e) {
    process.stderr.write(`[timelines] mirror to media-library failed: ${e.message}\n`);
  }
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

/** List every timeline file across both the canonical home dir and the
 *  legacy project dir. Dedupes by id (home wins on collision — newer
 *  state lives there post-refactor). */
export function listTimelines() {
  const seenIds = new Set();
  const entries = [];
  for (const dir of [_dir(), _legacyProjectDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
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

/**
 * Set or clear the timeline's I/O marks (used for fragment / frame
 * export and "open marked range as timeline"). Pass a non-negative
 * integer to set the mark or null to clear it; `undefined` leaves the
 * existing value untouched. Throws if the requested in/out pair would
 * be inverted (out <= in).
 */
export function setTimelineMarks(id, { markInMs, markOutMs } = {}) {
  const state = _read(id);
  if (!state) throw new Error(`Timeline ${id} not found`);
  const settings = { ...(state.settings || {}) };
  if (markInMs !== undefined) {
    if (markInMs === null) {
      delete settings.markInMs;
    } else {
      const v = parseInt(markInMs, 10);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error('markInMs must be a non-negative integer or null');
      }
      settings.markInMs = v;
    }
  }
  if (markOutMs !== undefined) {
    if (markOutMs === null) {
      delete settings.markOutMs;
    } else {
      const v = parseInt(markOutMs, 10);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error('markOutMs must be a non-negative integer or null');
      }
      settings.markOutMs = v;
    }
  }
  if (
    settings.markInMs != null &&
    settings.markOutMs != null &&
    settings.markOutMs <= settings.markInMs
  ) {
    throw new Error(
      `markOutMs (${settings.markOutMs}) must be greater than markInMs (${settings.markInMs})`,
    );
  }
  const merged = _normalise({ ...state, settings });
  _write(merged);
  return merged;
}

/** Delete a timeline file. Returns true if removed, false if it wasn't there. */
export function deleteTimeline(id) {
  // Look up where the file actually lives (home or legacy project).
  // _filePath alone would only point at the home dir.
  const fp = _findExistingFile(id);
  if (fp == null) return false;
  fs.unlinkSync(fp);
  // Best-effort removal of the matching media-library row. Same
  // fire-and-forget pattern as `_write` — the JSON unlink is the
  // canonical action; the row is just the index.
  (async () => {
    try {
      const { MediaLibrary } = await import('./media-library.js');
      await MediaLibrary.global().removeByPath(fp);
    } catch { /* best-effort */ }
  })();
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
 * Set / replace / clear an audio clip's volume automation curve.
 *
 * `change.points`:
 *   - `Array<{t, v}>` — replace the entire curve with these keyframes
 *      (sorted internally; clamped to [0, clip.durationMs] × [0, 2]).
 *   - `null`          — clear the curve, restoring unity gain.
 *
 * Single-keyframe shortcut: `change.gain` (number, 0..2) sets a uniform
 * clip-wide gain by writing two anchor points (start + end) at that
 * value, which is the cheapest way to "turn this clip down 3 dB".
 *
 * Only valid on audio tracks (A1, A2, …). Throws on V tracks so the
 * agent gets a clear error instead of a silently-ignored mutation.
 */
export function setClipVolume(id, clipId, change) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    if (!change || typeof change !== 'object') {
      throw new Error('setClipVolume change must be an object with points or gain');
    }
    const c = state.clips[i];
    if (!_isAudioTrack(c.track)) {
      throw new Error(
        `setClipVolume: clip ${clipId} is on ${c.track} (video). ` +
        'Volume automation only applies to audio clips (A<n>).',
      );
    }
    if ('points' in change) {
      if (change.points === null) {
        delete c.volumePoints;
      } else {
        const vps = _validateVolumePoints(change.points, c.durationMs);
        if (vps && vps.length > 0) c.volumePoints = vps;
        else delete c.volumePoints;
      }
    } else if ('gain' in change) {
      const g = Number(change.gain);
      if (!Number.isFinite(g) || g < 0 || g > 2) {
        throw new Error(
          `setClipVolume.gain must be in [0, 2] linear gain (got ${change.gain})`,
        );
      }
      // Unity → drop the field entirely so clean clips stay clean in the JSON.
      if (g === 1) delete c.volumePoints;
      else c.volumePoints = [{ t: 0, v: g }, { t: c.durationMs, v: g }];
    } else {
      throw new Error(
        'setClipVolume change must include either `points` (array | null) or `gain` (number)',
      );
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
          `setClipVolume (volumePoints), ` +
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

// ── Title clips (synthetic V-track overlays) ─────────────────────────

/**
 * Append a title (text overlay) clip to a video track. Title clips are
 * synthetic — there's no source media file behind them; the renderer and
 * GUI read `titleProps` to draw the text. Apart from `path` and
 * `titleProps`, they otherwise behave exactly like a normal clip
 * (track / startMs / durationMs / linkId / transforms / transitions).
 *
 * `titleProps` is required and must include at least `text`. The agent
 * may pass any subset of the GUI's TitleProps fields (fontSize / colorArgb /
 * fontWeight / italic / align / outlineWidth / outlineColorArgb /
 * shadowBlur / shadowColorArgb / fontFamily); missing fields fall back to
 * the GUI defaults (Inter, 96pt, white, bold, centred, soft drop shadow).
 *
 * Returns { clip, timeline } the same way addClip does.
 */
export function addTitle(id, { track = 'V1', startMs, durationMs = 3000, titleProps, linkId, offsetX, offsetY, scale } = {}) {
  if (!titleProps || typeof titleProps !== 'object') {
    throw new Error('addTitle: titleProps is required and must be an object');
  }
  if (typeof titleProps.text !== 'string' || !titleProps.text) {
    throw new Error('addTitle: titleProps.text is required');
  }
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new Error('addTitle: startMs must be ≥ 0');
  }
  if (!_isVideoTrack(track)) {
    throw new Error(`addTitle: track must be a V-track (got ${track})`);
  }
  const clip = {
    track,
    path: _newTitlePath(),
    startMs: Math.round(startMs),
    durationMs: Math.round(durationMs),
    titleProps,
  };
  if (linkId) clip.linkId = linkId;
  if (Number.isFinite(offsetX)) clip.offsetX = offsetX;
  if (Number.isFinite(offsetY)) clip.offsetY = offsetY;
  if (Number.isFinite(scale)) clip.scale = scale;
  return addClip(id, clip);
}

/**
 * Patch an existing title clip's `titleProps`. Only the fields you pass
 * are overwritten — everything else (and the clip's position/transform/
 * link) is left untouched. Pass null to clear an optional field back to
 * its TitleProps default.
 */
export function updateTitle(id, clipId, propsPatch) {
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    const c = state.clips[i];
    if (!_isTitlePath(c.path)) {
      throw new Error(`Clip ${clipId} is not a title clip (path=${c.path})`);
    }
    if (!propsPatch || typeof propsPatch !== 'object') {
      throw new Error('updateTitle: propsPatch must be an object');
    }
    const merged = { ...(c.titleProps || {}) };
    for (const [k, v] of Object.entries(propsPatch)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    if (typeof merged.text !== 'string' || !merged.text) {
      throw new Error('updateTitle: resulting titleProps.text would be empty');
    }
    c.titleProps = merged; // _validateClip on the way out scrubs unknown fields
    return state;
  });
}

/**
 * Bulk-append a series of subtitle/caption clips in a single mutation.
 * Each segment becomes its own title clip on `track` with a shared
 * `titleProps` baseline (font/colour/outline/etc.) plus its own
 * `startMs` / `durationMs` and per-segment `text`. We only do one
 * timeline read+write for the whole batch, so a 200-line transcript
 * costs the same disk IO as a single addClip.
 *
 * `segments` is an array of `{ startMs, durationMs?, endMs?, text }`.
 * Either `durationMs` or `endMs` must be present per segment.
 *
 * `propsBaseline` is a fully-resolved TitleProps object (typically built
 * via `titleOptionsToProps` from the agent's flat options). The caller
 * is responsible for choosing subtitle-appropriate defaults (smaller
 * fontSize, white-on-black outline, bottom offsetY) — this function is
 * format-agnostic on purpose so it can also seed karaoke-style or
 * commentary captions.
 *
 * Returns { clips, timeline } so the caller can echo back per-segment
 * clipIds for follow-up edits.
 */
export function addSubtitles(id, { track = 'V2', segments, propsBaseline, offsetY } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('addSubtitles: segments must be a non-empty array');
  }
  if (!propsBaseline || typeof propsBaseline !== 'object' || typeof propsBaseline.text !== 'string') {
    // text on the baseline is overwritten per segment but the validator
    // still demands a string, so seed it with an empty placeholder when
    // the caller didn't provide one.
    propsBaseline = { ...(propsBaseline || {}), text: '' };
  }
  if (!_isVideoTrack(track)) {
    throw new Error(`addSubtitles: track must be a V-track (got ${track})`);
  }
  // Pre-validate every segment up-front so a bad row at index 17 doesn't
  // leave 16 half-written subtitles on disk.
  const prepared = segments.map((seg, idx) => {
    if (!seg || typeof seg !== 'object') throw new Error(`addSubtitles: segment[${idx}] must be an object`);
    if (typeof seg.text !== 'string' || !seg.text) {
      throw new Error(`addSubtitles: segment[${idx}].text is required`);
    }
    if (!Number.isFinite(seg.startMs) || seg.startMs < 0) {
      throw new Error(`addSubtitles: segment[${idx}].startMs must be ≥ 0`);
    }
    let dur;
    if (Number.isFinite(seg.durationMs)) {
      dur = seg.durationMs;
    } else if (Number.isFinite(seg.endMs)) {
      dur = seg.endMs - seg.startMs;
    } else {
      throw new Error(`addSubtitles: segment[${idx}] needs durationMs or endMs`);
    }
    if (dur < 50) throw new Error(`addSubtitles: segment[${idx}] duration < 50ms`);
    return {
      track,
      path: _newTitlePath(),
      startMs: Math.round(seg.startMs),
      durationMs: Math.round(dur),
      titleProps: { ...propsBaseline, text: seg.text },
      ...(Number.isFinite(offsetY) && offsetY !== 0 ? { offsetY } : {}),
    };
  });
  const created = [];
  const tl = _withTimeline(id, (state) => {
    for (const c of prepared) {
      const validated = _validateClip(c, state.settings);
      state.clips.push(validated);
      created.push(validated);
    }
    return state;
  });
  // Re-resolve from persisted state so the caller sees the canonical clip
  // objects (with stable ids, sorted etc.) — same pattern as addClip.
  const ids = new Set(created.map((c) => c.id));
  const stored = tl.clips.filter((c) => ids.has(c.id));
  return { clips: stored, timeline: tl };
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
