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
 *       "locked":        bool?   // set by the user in the GUI: no engine write
 *                                // may change or remove this clip (see _write)
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

import { docDir } from './doc-root.js';
const SCHEMA_VERSION = 2;

// ── Filesystem helpers ───────────────────────────────────────────────

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

/// The project's timelines dir (see state/doc-root.js), like every other
/// document kind.
function _dir() {
  return docDir('timelines');
}

/// Legacy directory: previous engine versions wrote `<project>/.koi/
/// timelines/`. Reads still fall back here so old project-scoped files
/// remain reachable. Writes default to [_dir()] so new content lands
/// in the unified location.
function _legacyProjectDir() {
  return path.join(_projectRoot(), '.koi', 'timelines');
}

function _ensureDir() {
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

// Nested-timeline clips reference another timeline by id. Path shape:
// `timeline:tl-<...>` (the child's id). The actual sub-timeline lives on
// disk as its own JSON; this clip is just a pointer. Resolution:
//   - GUI editor: double-click → tabs.openFile(path) → routed to the
//     timeline editor for the child id.
//   - Native playback: a pre-flatten pass (Dart side) inlines the child
//     clips into the parent composition before handing JSON to Swift.
// The clip carries an optional `timelineRef` sidecar `{ id, name }` so
// the editor can render the child's display name without re-reading the
// child JSON on every paint. The id inside `timelineRef` must match the
// id encoded in the path — `_validateClip` enforces this.
const _TIMELINE_PATH_RE = /^timeline:[A-Za-z0-9_-]{3,128}$/;
function _isTimelinePath(p) { return typeof p === 'string' && _TIMELINE_PATH_RE.test(p); }
function _timelineIdFromPath(p) { return _isTimelinePath(p) ? p.slice('timeline:'.length) : null; }

function _validateTimelineRef(ref, expectedId) {
  if (ref == null) return null;
  if (typeof ref !== 'object') throw new Error('clip.timelineRef must be an object');
  if (typeof ref.id !== 'string' || ref.id !== expectedId) {
    throw new Error(`clip.timelineRef.id (${ref.id}) must match the path id (${expectedId})`);
  }
  const out = { id: ref.id };
  if (typeof ref.name === 'string') out.name = ref.name;
  return out;
}

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
function _validateVolumePoints(pts, clipDurationMs, { lenient = false } = {}) {
  if (pts == null) return null;
  if (!Array.isArray(pts)) throw new Error('clip.volumePoints must be an array');
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || typeof p !== 'object') {
      if (lenient) continue;
      throw new Error(`clip.volumePoints[${i}] must be an object`);
    }
    const t = Number(p.t);
    const v = Number(p.v);
    if (!Number.isFinite(t) || t < 0 || t > clipDurationMs) {
      if (lenient && Number.isFinite(t)) {
        // Out-of-range survivor of an old split/trim that didn't
        // re-time the curve. Keep the envelope instead of failing the
        // whole save: clamp into range (hold-ends semantics make the
        // clamped point equivalent inside the clip).
        out.push({ t: Math.round(Math.min(Math.max(t, 0), clipDurationMs)), v: Math.min(Math.max(v, 0), 2) });
        continue;
      }
      if (lenient) continue;
      throw new Error(
        `clip.volumePoints[${i}].t must be in [0, ${clipDurationMs}] (got ${p.t})`,
      );
    }
    if (!Number.isFinite(v) || v < 0 || v > 2) {
      if (lenient) {
        if (Number.isFinite(v)) out.push({ t: Math.round(t), v: Math.min(Math.max(v, 0), 2) });
        continue;
      }
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
  // Nested-timeline clips (path === 'timeline:<id>') live on V-tracks. A
  // sub-timeline carries its own A-tracks internally and is expanded at
  // playback time, so an A-track placement would be a category error.
  if (_isTimelinePath(p) && !_isVideoTrack(track)) {
    throw new Error(`Nested-timeline clip ${p} must live on a video track, not ${track}`);
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
  // Nested-timeline sidecar. The child id encoded in the path is the
  // source of truth; `timelineRef` is just a cache of display fields so
  // the editor can render the clip without re-reading the child JSON.
  if (_isTimelinePath(p)) {
    const childId = _timelineIdFromPath(p);
    const refIn = c.timelineRef ?? { id: childId };
    const ref = _validateTimelineRef(refIn, childId);
    if (ref) out.timelineRef = ref;
  }
  // Audio-clip volume automation curve. Same round-trip discipline as
  // titleProps — without explicit pass-through, any unrelated mutator
  // would strip the agent's keyframes on the next save. Lenient here:
  // this is the round-trip of ALREADY-STORED state, and legacy files
  // hold points an old split/trim left beyond the clip edge — a throw
  // would fail the WHOLE save for a curve detail. (set_clip_volume,
  // the write path for NEW curves, stays strict.)
  if (_isAudioTrack(track)) {
    const vps = _validateVolumePoints(c.volumePoints, dur, { lenient: true });
    if (vps && vps.length > 0) out.volumePoints = vps;
  }
  // Pass-through for GUI-only fields. The engine doesn't need to
  // understand these but it MUST NOT strip them on every save —
  // they belong to the GUI's per-clip state (color grading,
  // transform-enable toggle, source dimensions, AI placeholder
  // metadata). Without this block the user-reported "AI Video
  // clip loses its AI state after generation" bug fires every time
  // any tool touches the timeline (assign_generated_media_to_clip
  // is the canonical trigger): _validateClip would drop `aiState`
  // / `aiStartFrameClipId` / etc. on the way back out, and the
  // GUI's reload sees a clip with no AI metadata.
  //
  // Listed explicitly (rather than a wildcard spread) so a typo
  // or stale key from an old project file doesn't accidentally
  // sneak through and pollute the canonical schema.
  const _passthrough = [
    'locked',
    'aiState',
    'aiStartFrameClipId',
    'aiEndFrameClipId',
    'aiStartFrameMode',
    'rotation',
    'transformEnabled',
    'hue',
    'saturation',
    'brightness',
    'contrast',
    'cornerRadiusPx',
    'shadowBlurPx',
    'shadowColorArgb',
    'sourceWidthPx',
    'sourceHeightPx',
    // AI placeholder canvas aspect — drives the rendered crop
    // rectangle on the timeline player. Stripping these resets
    // the AI clip's canvas after generation lands (user-visible
    // bug: clip jumps from 1:1 back to 2:3 once the rendered
    // file replaces the placeholder, and the fragment no longer
    // fits its intended slot).
    'aspectW',
    'aspectH',
    // Free-transform: position offset, scale, and feather. These
    // are GUI-side per-clip overrides; the engine doesn't consume
    // them but must round-trip them so the clip's framing is
    // preserved across any tool that re-serialises the timeline.
    'offsetX',
    'offsetY',
    'scale',
    'featherPx',
    'featherSides',
    // Per-clip volume automation curve (audio clips). Same rule:
    // engine doesn't read it, must not drop it.
    'volumePoints',
    // Cached "does the source file have an audio stream?" stamped by
    // add_clip_to_timeline via ffprobe. The renderer skips the audio
    // chain for clips with hasAudio:false (silent video, image,
    // synthetic sentinel) so the filter graph doesn't reference a
    // non-existent `[i:a]` stream and break the whole mix.
    'hasAudio',
    // Detected shot cuts (planos / "tomas") inside the clip's source, in
    // SOURCE-time ms. The GUI computes these; the engine doesn't consume them
    // but MUST round-trip them so they survive to disk — the MCP `extract_take`
    // reads them to know each take's [from,to] range and cut it. Also
    // `shotCutVersion` (settings) drives the GUI's re-detect-if-stale check.
    'shotCuts',
    // 3D previz link { sceneId, shotId, poster? }: while the clip shows the
    // previz its `path` is `scene3d:<scene>/<shot>` (played live by Blender,
    // baked only on export), so the link must survive every save.
    'scene3d',
  ];
  for (const key of _passthrough) {
    if (c[key] !== undefined && c[key] !== null) {
      out[key] = c[key];
    }
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
  // Preserve pass-through settings the GUI writes (projectWidth/projectHeight/
  // projectFps, trackHeight, audioTrackHeight, activeVideoTrack/AudioTrack,
  // vaSplitRatio, …) — the runtime doesn't consume them but MUST round-trip them
  // so an `update_timeline` from the agent doesn't nuke the GUI's canvas/view
  // state. Only the fields below get re-validated / clamped.
  const out = { ...s, videoTracks, audioTracks, pixelsPerSecond, previewSplit, playheadMs };
  if (markInMs != null) out.markInMs = markInMs; else delete out.markInMs;
  if (markOutMs != null) out.markOutMs = markOutMs; else delete out.markOutMs;
  // Render settings inherited from the first video clip dropped onto
  // the timeline by `add_clip_to_timeline`. The renderer reads these
  // before falling back to the hard 30 fps / 1920×1080 defaults — so
  // when the source clips are 24 fps × 1080×1920 (vertical reel) the
  // rendered output matches and there are no black flickers / black
  // bands at clip seams. All three fields are optional; missing
  // values keep the legacy defaults at render time.
  if (Number.isFinite(s.fps) && s.fps > 0) out.fps = Math.round(s.fps * 1000) / 1000;
  if (Number.isFinite(s.width) && s.width > 0) out.width = Math.round(s.width);
  if (Number.isFinite(s.height) && s.height > 0) out.height = Math.round(s.height);
  return out;
}

function _normalise(state) {
  const settings = _normaliseSettings(state.settings);
  const clips = Array.isArray(state.clips)
    ? state.clips.map((c) => _validateClip(c, settings))
    : [];
  // AUTO-ASSIGN the canvas from the FIRST video clip's source dimensions, on
  // EVERY save — so a timeline always matches its footage (never a 1080×1920
  // reel squished into a 960×960 square). The agent building the JSON via
  // update_timeline can't get the aspect ratio wrong: the tool sets it. Writes
  // BOTH conventions — GUI (projectWidth/projectHeight) and renderer
  // (width/height) — so the visor and the render agree. A user who truly wants a
  // different render shape reframes clips (aspect belongs at generation time,
  // per the skill), not by fighting the canvas.
  const firstVid = clips.find((c) =>
    _isVideoTrack(c.track)
    && typeof c.path === 'string'
    && !/^(title:|timeline:|ai-|placeholder)/.test(c.path)
    && Number.isFinite(c.sourceWidthPx) && c.sourceWidthPx > 0
    && Number.isFinite(c.sourceHeightPx) && c.sourceHeightPx > 0);
  if (firstVid) {
    const w = Math.round(firstVid.sourceWidthPx);
    const h = Math.round(firstVid.sourceHeightPx);
    settings.projectWidth = w;
    settings.projectHeight = h;
    settings.width = w;
    settings.height = h;
  }
  const out = {
    id: state.id,
    name: typeof state.name === 'string' && state.name.trim() ? state.name.trim() : 'Timeline',
    version: SCHEMA_VERSION,
    createdAt: state.createdAt || _now(),
    updatedAt: _now(),
    settings,
    clips,
  };
  // Preserve the story link ACROSS every save: a story can own many timelines,
  // so the association lives on the timeline (timeline → storyboardId), not on
  // the storyboard. Without carrying it here every update_timeline would strip
  // it (same latent bug that drops `summary`), orphaning the timeline from its
  // story. Same for the agent-supplied summary — round-trip it too.
  if (typeof state.storyboardId === 'string' && state.storyboardId.trim()) {
    out.storyboardId = state.storyboardId.trim();
  }
  if (typeof state.summary === 'string' && state.summary.trim()) {
    out.summary = state.summary.trim();
  }
  // 'storyboard' = the story's own montage: every 3D shot of the
  // storyboard in script order, kept in sync both ways by scene3d.
  if (state.role === 'storyboard') out.role = 'storyboard';
  return out;
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

/// What a locked clip must keep. `shotCuts` is cached analysis and `scene3d`
/// only links the clip to its 3D shot: neither changes what the clip shows.
function _lockSignature({ shotCuts: _s, scene3d: _d, ...rest }) {
  return JSON.stringify(rest);
}

/// The single guard behind every engine write: the user's locked clips stay
/// exactly as they are. Unlocking happens only in the GUI, which saves its file
/// directly.
function _assertLockedClipsIntact(state) {
  let prev;
  try {
    const raw = _read(state.id);
    if (!raw) return;
    prev = _normalise(raw);
  } catch {
    return;
  }
  const next = new Map((state.clips || []).map((c) => [c.id, c]));
  const broken = prev.clips
    .filter((c) => c.locked === true)
    .filter((c) => !next.has(c.id) || _lockSignature(next.get(c.id)) !== _lockSignature(c))
    .map((c) => c.id);
  if (broken.length) {
    throw new Error(
      `Clips locked by the user cannot be changed or removed: ${broken.join(', ')}. `
      + 'Leave them as they are, or ask the user to unlock them on the timeline.',
    );
  }
}

/// Every clip the user locked, across the project's timelines.
export function lockedClips() {
  const dir = _dir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const tl = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const clip of tl.clips || []) {
        if (clip?.locked === true) out.push({ timelineId: f.slice(0, -5), clip });
      }
    } catch { /* unreadable timeline: nothing to protect */ }
  }
  return out;
}

function _write(state) {
  _assertLockedClipsIntact(state);
  _ensureDir();
  // Preserve the file's existing location: if a row already lives in
  // the legacy project dir, keep writing there (avoids duplicating
  // the file in the home dir on every save). New timelines default to
  // the canonical home dir.
  const existing = _findExistingFile(state.id);
  const fp = existing ?? _filePath(state.id);
  // Rolling one-deep backup: keep the previous version next to the file so a
  // destructive replace (agent bug, malformed bulk update) is always
  // recoverable by copying the .bak back — learned the hard way when an
  // empty-state update_timeline wiped a 13-clip timeline with no way back.
  try {
    if (fs.existsSync(fp)) fs.copyFileSync(fp, `${fp}.bak`);
  } catch { /* backup is best-effort — never block the write */ }
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
    //
    // `state.summary` is the agent-supplied "what is this timeline
    // for". When present, it flows down to the per-session creations
    // ledger via saveTimelineEntry → save({summary}). Only the FIRST
    // save of a new file path actually appends to the ledger (see
    // `wasReplacement` in media-library.js) — subsequent edits keep
    // refreshing the row but never duplicate the ledger entry.
    await saveTimelineEntry(filePath, state, null, {
      summary: typeof state?.summary === 'string' ? state.summary : undefined,
    });
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
export function createTimeline({ name, settings, clips, state, summary, storyboardId, role } = {}) {
  const id = _newId();
  let toWrite;
  if (state && typeof state === 'object') {
    toWrite = _normalise({ ...state, id, name: name || state.name, storyboardId: storyboardId || state.storyboardId });
    toWrite.createdAt = _now();
  } else {
    toWrite = _normalise({
      id,
      name: name || 'Timeline',
      settings,
      clips: clips || [],
      storyboardId,
      role,
    });
  }
  // Stamp the agent-supplied "what is this timeline for" onto the
  // state so `_mirrorToMediaLibrary` can forward it to the per-
  // session creations ledger. Persisted alongside the rest of the
  // state — a later `inspect_creation` surfaces it.
  if (typeof summary === 'string' && summary.trim()) {
    toWrite.summary = summary.trim();
  }
  _write(toWrite);
  return toWrite;
}

/** List every timeline known to the media-library DB. No disk scan —
 *  the DB is the authoritative index (every save mirrors a row via
 *  `_mirrorToMediaLibrary`), so listing is a single SQL query against
 *  `mediaType='timeline'`. The row metadata already carries the
 *  summary fields, so we don't read the underlying JSON files. */
export async function listTimelines() {
  const { MediaLibrary } = await import('./media-library.js');
  const items = await MediaLibrary.global().list({ mediaType: 'timeline', limit: 10000 });
  const entries = [];
  const seenIds = new Set();
  for (const it of items) {
    const meta = it.metadata || {};
    const id = meta.timelineId;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    entries.push({
      id,
      name: meta.name || 'Timeline',
      clipCount: meta.clipCount ?? 0,
      videoTracks: meta.videoTracks ?? 0,
      audioTracks: meta.audioTracks ?? 0,
      updatedAt: meta.updatedAt || it.createdAt || null,
    });
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
/**
 * Merge a partial settings object into the timeline's settings without
 * touching clips or other top-level state. Use for narrow updates like
 * "stamp fps/width/height from the first dropped video clip" — going
 * through the full updateTimeline shape would force the caller to
 * resend every clip and risk overwriting concurrent edits.
 *
 * Returns the persisted timeline. Throws if the id isn't found.
 */
export function setTimelineSettings(id, patch = {}) {
  const tl = _read(id);
  if (!tl) throw new Error(`Timeline ${id} not found`);
  const merged = _normalise({
    ...tl,
    settings: { ...(tl.settings || {}), ...patch },
  });
  _write(merged);
  return merged;
}

export function updateTimeline(id, state) {
  if (!_read(id)) throw new Error(`Timeline ${id} not found`);
  // Cycle guard for bulk-replace: walk every nested reference in the
  // incoming clips and reject if any path leads back to this timeline.
  if (Array.isArray(state?.clips)) {
    for (const c of state.clips) {
      const childId = _timelineIdFromPath(c?.path);
      if (childId) _assertNoTimelineCycle(id, childId);
    }
  }
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

/// Walk every nested-timeline reference reachable from [startId] and
/// throw if [ancestorId] appears anywhere in the closure. Cheap (one
/// _read per visited timeline, dedup'd by [visited]); guards against
/// cycles like A→B→A or A→B→C→A. Missing children are tolerated so a
/// stale ref doesn't poison the check.
function _assertNoTimelineCycle(ancestorId, startId, visited = new Set()) {
  if (!startId || visited.has(startId)) return;
  visited.add(startId);
  if (startId === ancestorId) {
    throw new Error(
      `Cycle detected: timeline ${ancestorId} cannot contain itself ` +
      `(transitively via ${[...visited].join(' → ')})`,
    );
  }
  const child = _read(startId);
  if (!child) return; // missing child — nothing further to follow
  for (const c of child.clips || []) {
    const nestedId = _timelineIdFromPath(c.path);
    if (!nestedId) continue;
    _assertNoTimelineCycle(ancestorId, nestedId, visited);
  }
}

/**
 * Append a clip. Returns { clip, timeline } so the caller has the
 * minted id without re-scanning the timeline. `clip.linkId` is optional
 * — set it (and the same value on a sibling clip) to pair V/A peers
 * so that move/trim/remove cascade across the pair.
 */
export function addClip(id, clip) {
  // Nested-timeline cycle guard: refuse the add BEFORE the write so a
  // bad drop leaves the parent intact. Cheap when there's no nesting
  // (single _read on the would-be child).
  const childId = _timelineIdFromPath(clip?.path);
  if (childId) _assertNoTimelineCycle(id, childId);
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
  // Cycle guard before the write: if the path is being changed to a
  // `timeline:<id>` reference, walk the closure first. Cheap no-op when
  // the path isn't being touched or isn't a timeline path.
  if (changes && typeof changes === 'object' && 'path' in changes) {
    const childId = _timelineIdFromPath(changes.path);
    if (childId) _assertNoTimelineCycle(id, childId);
  }
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
      if (changes.path !== c.path) {
        const ai = c.aiState && typeof c.aiState === 'object' ? c.aiState : null;
        // AI-version toggle awareness. Reported bug: original → AI → original
        // via chat lost the take's time mark and left the probe data of the
        // OTHER file on the clip (sourceInMs 5166 into a 3090 ms render), so
        // the GUI read the clip as trimmed past its source and painted the
        // striped "AI Extend" placeholder.
        //
        // 1) Leaving the ORIGINAL: capture where in the source the take is
        //    cut, so flipping back can restore it. Never lose the mark.
        if (ai && c.path === ai.placeholderPath) {
          ai.placeholderSourceInMs = Number.isFinite(c.sourceInMs) ? c.sourceInMs : 0;
        }
        c.path = changes.path;
        // 2) Entering a known version: restore its source window. A rendered
        //    file is standalone and starts at 0; the original resumes at the
        //    saved mark. Any other replacement keeps sourceInMs (the caller
        //    may be swapping in an equivalent-length variant) and fixes it
        //    with trim_clip if needed.
        if (ai && changes.path === ai.placeholderPath) {
          c.sourceInMs = Number.isFinite(ai.placeholderSourceInMs) ? ai.placeholderSourceInMs : 0;
        } else if (ai && changes.path === ai.lastRenderedPath) {
          c.sourceInMs = 0;
        }
        // 3) Probe data (total duration + pixel dims) belongs to the file
        //    that just left `path`: zero it so the GUI re-probes the new one
        //    instead of judging the clip against the wrong source length.
        c.sourceTotalMs = 0;
        c.sourceWidthPx = 0;
        c.sourceHeightPx = 0;
      }
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

/**
 * Land a freshly-generated media file on an AI-placeholder clip in a single
 * write. Updates `path` AND `aiState.lastRenderedPath` (and `lastChatId`
 * when provided) atomically so the on-disk JSON ALWAYS reflects "this clip
 * has a rendered version available". Used by `assign_generated_media_to_clip`
 * — keeps the GUI's AI ↔ Rendered toggle working across the inevitable
 * file-watcher reload that follows the engine's write (without this, the
 * GUI would set `lastRenderedPath` in memory only and lose it on reload).
 *
 * If `aiState` is missing on the clip (rare — the GUI mints it before
 * dispatch) we mint one with `placeholderPath = clip.path` BEFORE the swap,
 * so the toggle still has a placeholder to flip back to.
 */
export function assignGeneratedMedia(id, clipId, { mediaPath, chatId, sourceInMs = 0, hasAudio } = {}) {
  if (!mediaPath || typeof mediaPath !== 'string') {
    throw new Error('assignGeneratedMedia.mediaPath must be a non-empty string');
  }
  return _withTimeline(id, (state) => {
    const i = _findClipIndexById(state, clipId);
    if (i < 0) throw new Error(`Clip not found: ${clipId}`);
    const c = state.clips[i];
    const prevPath = c.path;
    if (!c.aiState || typeof c.aiState !== 'object') {
      c.aiState = { placeholderPath: prevPath };
    }
    // Capture the take's time mark while the clip still shows the ORIGINAL:
    // the swap below zeroes sourceInMs (renders start at 0), and without the
    // mark a later "show me the original again" lands at the wrong second.
    if (c.path === c.aiState.placeholderPath) {
      c.aiState.placeholderSourceInMs = Number.isFinite(c.sourceInMs) ? c.sourceInMs : 0;
      // A live 3D placeholder has no file to re-probe: keep its scene length
      // so "back to 3D" can still trim / slip over the whole scene clock.
      if (c.scene3d && Number.isFinite(c.sourceTotalMs) && c.sourceTotalMs > 0) {
        c.aiState.placeholderSourceTotalMs = c.sourceTotalMs;
      }
    }
    c.aiState.lastRenderedPath = mediaPath;
    if (typeof chatId === 'string' && chatId) {
      c.aiState.lastChatId = chatId;
    }
    c.path = mediaPath;
    // ⚠️ RESET THE SOURCE WINDOW — the generated file is a STANDALONE render
    // that starts at 0, so any offset/dimensions inherited from the previous
    // source are now meaningless and actively harmful.
    //
    // Reported bug ("al darle a play se queda congelada la imagen al llegar al
    // nuevo clip", 100% reproducible): a clip trimmed out of a longer source
    // (e.g. sourceInMs 3250 + durationMs 3892 = the tail of a 7142 ms take) got
    // its `path` swapped to the freshly rendered edit — a 3752 ms file that
    // starts at 0 — while `sourceInMs` stayed 3250. The player then seeked
    // 3250 ms into a 3752 ms file, leaving ~500 ms of real content for a
    // 3892 ms clip, and froze on the last frame for the remaining ~3.4 s.
    //
    // The GUI's own handler (`_onAiGenerationResult` in video_timeline_tab.dart)
    // already did exactly this; the engine-side path (agent → this tool) did
    // not, which is why it only happened when the EDIT was driven from chat.
    // Zeroing the dims/total forces the GUI's `_probeMedia` to re-read the real
    // values from the new file instead of trusting the old source's.
    //
    // Exception: ONE take generated for several consecutive 3D clips — each
    // clip windows its own stretch of it, starting at `sourceInMs`.
    const inMs = Number.isFinite(sourceInMs) && sourceInMs > 0 ? Math.round(sourceInMs) : 0;
    c.sourceInMs = inMs;
    if (inMs) c.aiState.lastRenderedSourceInMs = inMs; else delete c.aiState.lastRenderedSourceInMs;
    c.sourceTotalMs = 0;
    c.sourceWidthPx = 0;
    c.sourceHeightPx = 0;
    // A 3D clip is silent; its generated take may carry sound.
    if (typeof hasAudio === 'boolean') c.hasAudio = hasAudio;
    // ...and that sound goes in WITH the picture, as a linked clip on the
    // matching audio track (how an imported video carries its sound). The
    // GUI used to add it only after probing the file itself: the take showed
    // up silent for a while.
    if (c.scene3d && hasAudio === true) _linkTakeAudio(state, c, mediaPath, inMs);
    return state;
  });
}

function _linkTakeAudio(state, c, mediaPath, inMs) {
  const isA = (t) => typeof t === 'string' && /^A\d+$/.test(t);
  const peers = c.linkId ? state.clips.filter((x) => x !== c && x.linkId === c.linkId && isA(x.track)) : [];
  const same = peers.find((x) => x.path === mediaPath);
  if (same) {
    Object.assign(same, { startMs: c.startMs, durationMs: c.durationMs, sourceInMs: inMs });
    return;
  }
  const stale = new Set(peers);
  const s0 = c.startMs, e0 = c.startMs + c.durationMs;
  const nA = Math.max(1, Number(state.settings?.audioTracks) || 2);
  const vIdx = Number(String(c.track || 'V1').slice(1)) || 1;
  const order = [vIdx <= nA ? `A${vIdx}` : null, ...Array.from({ length: nA }, (_, i) => `A${i + 1}`)]
    .filter((t, i, arr) => t && arr.indexOf(t) === i);
  const free = (t) => !state.clips.some((x) => !stale.has(x) && x.track === t
    && x.startMs < e0 && x.startMs + x.durationMs > s0);
  const track = order.find(free);
  if (!track) return; // every audio track is taken there
  state.clips = state.clips.filter((x) => !stale.has(x));
  if (!c.linkId) c.linkId = `L${randomBytes(3).toString('hex')}`;
  state.clips.push({
    id: _newClipId(), track, path: mediaPath, startMs: c.startMs, durationMs: c.durationMs,
    sourceInMs: inMs, sourceTotalMs: 0, linkId: c.linkId, hasAudio: true,
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
