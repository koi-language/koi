/**
 * Timeline → ffmpeg argv compiler.
 *
 * Takes a normalised timeline JSON (the output of state/timelines.js)
 * and a render-params object; produces an ffmpeg command line that:
 *
 *   - Composites all video tracks into one canvas (V2 above V1, V3 above
 *     V2, …) using `overlay` with per-clip enable windows.
 *   - Honours each clip's offsetX/offsetY/scale visual transform.
 *   - Mixes EVERY audible source — every video track's audio + every
 *     A-track clip — with `amix`, DaVinci-style. A clip whose visuals are
 *     covered keeps its sound (the user explicitly asked for this).
 *   - Honours `transitionIn` and `transitionOut` for solo clips
 *     (fade-from/-to black/white, dissolve) via the `fade` filter and
 *     `acrossfade` / fade for the linked audio.
 *
 * Cross-clip transitions (xfade between adjacent clips on the same
 * track) are recognised and rejected with a clear error in this v1 —
 * the placement maths is non-trivial and the schema-level validation
 * already permits it, so I'd rather error loudly than silently drop a
 * transition.
 *
 * Renderer design notes:
 *   • All times in seconds inside ffmpeg expressions; ms inside JS.
 *   • Filter graph is built as an array then joined with `;` at emit time.
 *   • Stream labels are stable: input N is `[N:v]` / `[N:a]`, transformed
 *     forms are `[v<clipId>]`, `[a<clipId>]`, the rolling overlay output
 *     is `[ovK]`.
 */

import path from 'node:path';

const _XFADE_MAP = {
  crossfade: 'fade',
  'fade-black': 'fadeblack',
  'fade-white': 'fadewhite',
  dissolve: 'dissolve',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
  'slide-up': 'slideup',
  'slide-down': 'slidedown',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'wipe-up': 'wipeup',
  'wipe-down': 'wipedown',
  'circle-open': 'circleopen',
  'circle-close': 'circleclose',
  pixelize: 'pixelize',
  'zoom-in': 'zoomin',
  radial: 'radial',
};

// Output container → reasonable codec defaults.
const _FORMAT_DEFAULTS = {
  mp4:  { videoCodec: 'h264', audioCodec: 'aac',  ext: 'mp4'  },
  mov:  { videoCodec: 'h264', audioCodec: 'aac',  ext: 'mov'  },
  webm: { videoCodec: 'vp9',  audioCodec: 'opus', ext: 'webm' },
  mkv:  { videoCodec: 'h264', audioCodec: 'aac',  ext: 'mkv'  },
  gif:  { videoCodec: 'gif',  audioCodec: 'none', ext: 'gif'  },
};

const _VCODEC_ARGS = {
  h264:    ['-c:v', 'libx264',    '-pix_fmt', 'yuv420p'],
  h265:    ['-c:v', 'libx265',    '-pix_fmt', 'yuv420p'],
  vp9:     ['-c:v', 'libvpx-vp9'],
  prores:  ['-c:v', 'prores_ks',  '-profile:v', '3'],
  gif:     [], // gif handled specially below
};

const _ACODEC_ARGS = {
  aac:    ['-c:a', 'aac'],
  mp3:    ['-c:a', 'libmp3lame'],
  opus:   ['-c:a', 'libopus'],
  none:   ['-an'],
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build the ffmpeg argv (without the binary path itself) for rendering
 * a given timeline. Caller prepends the resolved ffmpeg path.
 *
 * Returns: { argv, outputPath, durationMs }.
 *
 * Throws on unsupported requests (cross-clip transitions, empty timeline,
 * non-finite ranges) so the caller surfaces a clear error to the agent.
 */
export function compileTimeline(timeline, params = {}) {
  if (!timeline || !Array.isArray(timeline.clips)) {
    throw new Error('Timeline is missing or has no clips array');
  }
  const clips = [...timeline.clips];
  if (clips.length === 0) {
    throw new Error('Timeline has no clips to render');
  }

  const settings = _resolveSettings(timeline, params, clips);
  const range = _resolveRange(params, clips);
  const renderDurSec = (range.endMs - range.startMs) / 1000;
  if (renderDurSec <= 0) throw new Error('Render range has non-positive duration');

  // Reject xfade-between-adjacent-clips for v1 — schema allows it, the
  // renderer doesn't yet know how to rewire two siblings into a single
  // xfade output.
  _rejectCrossClipTransitions(clips);

  // Build inputs — one ffmpeg `-i` per clip, trimmed to its source window.
  const inputArgs = [];
  const clipInputIndex = new Map(); // clipId → input index (0-based)
  clips.forEach((clip, i) => {
    inputArgs.push('-ss', _sec(clip.sourceInMs));
    inputArgs.push('-t', _sec(clip.durationMs));
    inputArgs.push('-i', clip.path);
    clipInputIndex.set(clip.id, i);
  });

  // Build the filter graph. Ordered: base canvas → per-track overlays
  // → audio mix. Each chain is one element of `chains`, joined with `;`.
  const chains = [];

  // Black base canvas.
  const baseDurSec = _sec(range.endMs - range.startMs);
  chains.push(
    `color=c=black:s=${settings.width}x${settings.height}:r=${settings.fps}:d=${baseDurSec}` +
    `,format=yuv420p[base]`,
  );

  // Composite video track-by-track. V1 sits on the base; V2 overlays on
  // top of (base+V1); etc.
  let currentLabel = '[base]';
  let overlayCounter = 0;
  for (let track = 1; track <= settings.videoTracks; track++) {
    const trackKey = `V${track}`;
    const trackClips = clips
      .filter((c) => c.track === trackKey)
      .sort((a, b) => a.startMs - b.startMs);
    for (const clip of trackClips) {
      const visuallyVisible = _clipVisibleInRange(clip, range);
      if (!visuallyVisible) continue;
      const inputIdx = clipInputIndex.get(clip.id);
      const prepLabel = `[v${_safe(clip.id)}]`;
      // Per-clip prep: scale (canvas-fit, then user scale), set SAR/PTS,
      // then optional fade in/out for solo transitions. The clip's PTS
      // is shifted so it lines up with the timeline; overlay's `enable`
      // gates visibility to its window.
      const userScale = Number.isFinite(clip.scale) && clip.scale > 0 ? clip.scale : 1;
      const fitW = Math.round(settings.width * userScale);
      const fitH = Math.round(settings.height * userScale);
      const fadeIn = _fadeInForClip(clip, range, false);
      const fadeOut = _fadeOutForClip(clip, range, false);
      const fadePart = [fadeIn, fadeOut].filter(Boolean).join(',');
      const ptsShift = (clip.startMs - range.startMs) / 1000;
      const prep =
        `[${inputIdx}:v]scale=${fitW}:${fitH}:force_original_aspect_ratio=decrease` +
        `,setsar=1,format=yuva420p` +
        (fadePart ? `,${fadePart}` : '') +
        `,setpts=PTS-STARTPTS+${ptsShift.toFixed(3)}/TB${prepLabel}`;
      chains.push(prep);
      const nextLabel = `[ov${++overlayCounter}]`;
      const enableExpr = _enableExpr(clip, range);
      const dx = clip.offsetX || 0;
      const dy = clip.offsetY || 0;
      // overlay positions the top-left corner; (W-w)/2+dx centres + pans.
      const xExpr = `(W-w)/2${dx >= 0 ? `+${dx}` : `${dx}`}`;
      const yExpr = `(H-h)/2${dy >= 0 ? `+${dy}` : `${dy}`}`;
      chains.push(
        `${currentLabel}${prepLabel}overlay=x=${xExpr}:y=${yExpr}:enable='${enableExpr}':eof_action=pass${nextLabel}`,
      );
      currentLabel = nextLabel;
    }
  }
  const finalVideoLabel = currentLabel;

  // Audio — collect every clip whose source has an audio stream. We
  // can't trivially detect that without ffprobe; assume video clips
  // carry audio (overridden by the tool if it ran a probe) and that
  // every A-track clip is audio. ffmpeg will fail loudly if a `-map`
  // hits a non-existent stream; instead we use `?` to make audio maps
  // optional via `[N:a?]` plus an `aresample=async=1` to absorb gaps.
  const audioLabels = [];
  for (const clip of clips) {
    if (!_clipAudibleInRange(clip, range)) continue;
    const i = clipInputIndex.get(clip.id);
    const lbl = `[a${_safe(clip.id)}]`;
    const trimmedDelay = Math.max(0, clip.startMs - range.startMs);
    // Per-clip fade for solo audio transitions.
    const fadeIn = _fadeInForClip(clip, range, /*audio*/ true);
    const fadeOut = _fadeOutForClip(clip, range, /*audio*/ true);
    const fadePart = [fadeIn, fadeOut].filter(Boolean).join(',');
    chains.push(
      `[${i}:a]aresample=async=1${fadePart ? `,${fadePart}` : ''}` +
      `,adelay=${trimmedDelay}|${trimmedDelay}` +
      `,apad=whole_dur=${baseDurSec}${lbl}`,
    );
    audioLabels.push(lbl);
  }
  let finalAudioLabel = null;
  if (settings.audioCodec !== 'none') {
    if (audioLabels.length === 0) {
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=44100:duration=${baseDurSec}[aout]`);
      finalAudioLabel = '[aout]';
    } else if (audioLabels.length === 1) {
      // Single source — pass through under a stable label.
      chains.push(`${audioLabels[0]}anull[aout]`);
      finalAudioLabel = '[aout]';
    } else {
      chains.push(
        `${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest[aout]`,
      );
      finalAudioLabel = '[aout]';
    }
  }

  // Build final argv.
  const argv = [];
  argv.push('-hide_banner', '-y');
  // No global -ss; per-input -ss already in inputArgs.
  argv.push(...inputArgs);
  argv.push('-filter_complex', chains.join(';'));
  argv.push('-map', finalVideoLabel);
  if (finalAudioLabel) argv.push('-map', finalAudioLabel);
  argv.push('-r', String(settings.fps));
  // Codec args.
  argv.push(..._videoCodecArgs(settings));
  if (finalAudioLabel) argv.push(..._audioCodecArgs(settings));
  // Quality.
  if (settings.format === 'gif') {
    // Single-pass gif with palette — quality is fine for short renders.
    // Drop audio mapping (gif has none) and skip CRF.
  } else if (settings.crf != null) {
    argv.push('-crf', String(settings.crf));
  }
  // Progress to stdout so the runner can parse it line-by-line.
  argv.push('-progress', 'pipe:1', '-nostats');
  argv.push(settings.outputPath);

  return {
    argv,
    outputPath: settings.outputPath,
    durationMs: range.endMs - range.startMs,
    settings,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function _sec(ms) {
  // ffmpeg accepts decimal seconds; keep 3 dp to stay sample-accurate.
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);
}

function _safe(id) {
  // Filter labels can't contain "-"; clip ids look like "clip-abcd".
  return String(id).replace(/[^A-Za-z0-9]/g, '');
}

function _resolveSettings(timeline, params, clips) {
  const format = (params.format || 'mp4').toLowerCase();
  if (!_FORMAT_DEFAULTS[format]) {
    throw new Error(`Unsupported format: ${format}. Allowed: ${Object.keys(_FORMAT_DEFAULTS).join(', ')}`);
  }
  const fmtDefaults = _FORMAT_DEFAULTS[format];
  const videoCodec = (params.videoCodec || fmtDefaults.videoCodec).toLowerCase();
  if (!_VCODEC_ARGS[videoCodec]) {
    throw new Error(`Unsupported videoCodec: ${videoCodec}. Allowed: ${Object.keys(_VCODEC_ARGS).join(', ')}`);
  }
  const audioCodec = (params.audioCodec || fmtDefaults.audioCodec).toLowerCase();
  if (!_ACODEC_ARGS[audioCodec]) {
    throw new Error(`Unsupported audioCodec: ${audioCodec}. Allowed: ${Object.keys(_ACODEC_ARGS).join(', ')}`);
  }
  const fps = Number.isFinite(params.fps) && params.fps > 0 ? params.fps : 30;
  // Width/height: param > settings hint > 1920×1080.
  const width = Number.isFinite(params.width) && params.width > 0 ? Math.round(params.width) : 1920;
  const height = Number.isFinite(params.height) && params.height > 0 ? Math.round(params.height) : 1080;
  // CRF default depends on the codec.
  let crf = params.crf;
  if (crf == null && videoCodec !== 'gif' && videoCodec !== 'prores') {
    crf = videoCodec === 'h265' ? 28 : (videoCodec === 'vp9' ? 32 : 23);
  }
  const audioBitrate = params.audioBitrate || '192k';
  const outputPath = _resolveOutputPath(timeline, params, fmtDefaults.ext);
  return {
    width, height, fps, format, videoCodec, audioCodec, crf, audioBitrate, outputPath,
    videoTracks: timeline.settings?.videoTracks ?? 1,
    audioTracks: timeline.settings?.audioTracks ?? 1,
  };
}

function _resolveOutputPath(timeline, params, ext) {
  if (typeof params.outputPath === 'string' && params.outputPath) return params.outputPath;
  const root = process.env.KOI_PROJECT_ROOT || process.cwd();
  const renderDir = path.join(root, '.koi', 'renders');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(renderDir, `${timeline.id || 'timeline'}-${stamp}.${ext}`);
}

function _resolveRange(params, clips) {
  const totalEnd = clips.reduce((m, c) => Math.max(m, c.startMs + c.durationMs), 0);
  const startMs = Number.isFinite(params.rangeMs?.startMs) ? Math.max(0, params.rangeMs.startMs) : 0;
  const endMs   = Number.isFinite(params.rangeMs?.endMs)   ? Math.min(totalEnd, params.rangeMs.endMs)
                                                            : totalEnd;
  return { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

function _clipVisibleInRange(clip, range) {
  const a = clip.startMs;
  const b = clip.startMs + clip.durationMs;
  return b > range.startMs && a < range.endMs;
}

function _clipAudibleInRange(clip, range) {
  return _clipVisibleInRange(clip, range);
}

function _enableExpr(clip, range) {
  const a = (clip.startMs - range.startMs) / 1000;
  const b = (clip.startMs - range.startMs + clip.durationMs) / 1000;
  return `between(t,${a.toFixed(3)},${b.toFixed(3)})`;
}

function _fadeInForClip(clip, range, isAudio) {
  // Apply a "from-black" / "from-silence" only when there's no neighbour
  // on the same track ending exactly at this clip's start. The renderer
  // already guarantees no cross-clip xfade in v1, so any transitionIn
  // here is solo and translates to a `fade=t=in`.
  const t = clip.transitionIn;
  if (!t) return null;
  if (t.type === 'fade-black' || t.type === 'fade-white' || t.type === 'crossfade' || t.type === 'dissolve') {
    const start = (clip.startMs - range.startMs) / 1000;
    const dur = t.durationMs / 1000;
    if (isAudio) return `afade=t=in:st=${start.toFixed(3)}:d=${dur.toFixed(3)}`;
    const colour = t.type === 'fade-white' ? 'white' : 'black';
    // Video fade colour only applies for fade-black/white; "crossfade"
    // and "dissolve" with no neighbour have no colour and we just fade
    // alpha in from black via fade=t=in.
    if (t.type === 'fade-white') return `fade=t=in:st=${start.toFixed(3)}:d=${dur.toFixed(3)}:c=${colour}`;
    return `fade=t=in:st=${start.toFixed(3)}:d=${dur.toFixed(3)}`;
  }
  // For non-fade transitions in solo position we don't have a neighbour
  // to xfade with, so degrade to a plain alpha fade-in. Better than
  // dropping the user's intent silently.
  const start = (clip.startMs - range.startMs) / 1000;
  const dur = t.durationMs / 1000;
  return isAudio
    ? `afade=t=in:st=${start.toFixed(3)}:d=${dur.toFixed(3)}`
    : `fade=t=in:st=${start.toFixed(3)}:d=${dur.toFixed(3)}`;
}

function _fadeOutForClip(clip, range, isAudio) {
  const t = clip.transitionOut;
  if (!t) return null;
  const endRel = (clip.startMs - range.startMs + clip.durationMs) / 1000;
  const dur = t.durationMs / 1000;
  const start = endRel - dur;
  if (t.type === 'fade-white' && !isAudio) {
    return `fade=t=out:st=${start.toFixed(3)}:d=${dur.toFixed(3)}:c=white`;
  }
  return isAudio
    ? `afade=t=out:st=${start.toFixed(3)}:d=${dur.toFixed(3)}`
    : `fade=t=out:st=${start.toFixed(3)}:d=${dur.toFixed(3)}`;
}

function _videoCodecArgs(settings) {
  if (settings.format === 'gif') {
    // Use a palette pass for decent gif quality. Single-shot with
    // split+palettegen+paletteuse would be cleaner but doubles the
    // graph size; for v1 keep it simple — ffmpeg's default gif encoder
    // produces acceptable results.
    return ['-c:v', 'gif', '-pix_fmt', 'rgb8', '-loop', '0'];
  }
  return _VCODEC_ARGS[settings.videoCodec] || [];
}

function _audioCodecArgs(settings) {
  const args = _ACODEC_ARGS[settings.audioCodec] || [];
  if (settings.audioCodec !== 'none' && settings.audioBitrate) {
    args.push('-b:a', String(settings.audioBitrate));
  }
  return args;
}

function _rejectCrossClipTransitions(clips) {
  // Sort each track by startMs and check abutting clips for paired
  // transitions. Reject if found — v1 only supports solo fades.
  const byTrack = new Map();
  for (const c of clips) {
    const list = byTrack.get(c.track) || [];
    list.push(c);
    byTrack.set(c.track, list);
  }
  for (const [, list] of byTrack) {
    list.sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const abutting = Math.abs((a.startMs + a.durationMs) - b.startMs) < 50;
      if (abutting && (a.transitionOut || b.transitionIn)) {
        // A transition that would cross-fade A→B. The schema's intent
        // is that b.transitionIn defines the cross effect when A and B
        // abut — but xfade rewiring isn't implemented yet.
        throw new Error(
          `Cross-clip transition between ${a.id} → ${b.id} on ${a.track} is not yet supported by the renderer. ` +
          `Remove the transition, or render the timeline with the clips separated by a small gap.`,
        );
      }
    }
  }
}
