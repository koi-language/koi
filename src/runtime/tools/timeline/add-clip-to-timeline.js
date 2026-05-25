/**
 * Append a single clip to an existing timeline.
 *
 * Convenience over update_timeline when the agent only wants to drop
 * one clip in (e.g. "place this generated video at second 12 on V1").
 * Returns the freshly-minted clipId so the agent can immediately
 * move/trim/update/remove that exact clip without a re-read.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { addClip, getTimeline, setTimelineSettings } from '../../state/timelines.js';
import { resolveTimelineId } from './_resolve-timeline-id.js';
import { channel } from '../../io/channel.js';

/**
 * Best-effort: does the source file have an audio stream?
 * The renderer needs this to know which clips contribute an audio chain
 * to the final mix — without it, a single image / silent video on the
 * timeline can break the filtergraph (it tries to reference an `[i:a]`
 * stream that doesn't exist) and the whole output goes silent. Probed
 * here, once, at add-time so the renderer never has to guess.
 *
 * Returns:
 *   - true  → audio stream confirmed present
 *   - false → file exists, ffprobe ran, no audio stream
 *   - null  → unknown (no ffprobe, file unreadable, sentinel path);
 *             the renderer treats null as "assume audio" for video paths
 *             and "no audio" for image paths via the extension heuristic.
 */
async function _probeHasAudio(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  if (filePath.startsWith('placeholder-') ||
      filePath.startsWith('title:') ||
      filePath.startsWith('timeline:')) return false;
  const ext = path.extname(filePath).toLowerCase();
  // Static images obviously carry no audio — skip the probe.
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'].includes(ext)) return false;
  if (!fs.existsSync(filePath)) return null;

  let bin = 'ffprobe';
  try {
    const installer = await import('../../media/ffmpeg-installer.js');
    const r = await installer.ensureFfmpeg();
    if (r?.ffprobe) bin = r.ffprobe;
  } catch { /* fall back to PATH */ }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const { stdout } = await run(
      bin,
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath],
      { timeout: 3000 },
    );
    return String(stdout).trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Best-effort: probe a video file's frame rate + pixel dimensions.
 * The renderer falls back to these when the timeline has no explicit
 * fps / width / height set — which is the right behaviour for
 * agent-built timelines: if every dropped clip is 24 fps × 1080×1920
 * (a 9:16 reel from seedance), the render should be 24 fps × 1080×1920
 * too. Hard-coding the renderer to 30 fps × 1920×1080 default produces
 * the black-flicker / black-band artefacts the user reported when a 24
 * fps source plays inside a 30 fps timeline at a different aspect ratio.
 *
 * Returns: { fps, width, height } with whichever fields parsed cleanly,
 * or {} when ffprobe is unavailable / the file isn't a video. Never
 * throws — the caller defaults to "no metadata, leave it alone".
 */
async function _probeVideoMeta(filePath) {
  if (typeof filePath !== 'string' || !filePath) return {};
  if (filePath.startsWith('placeholder-') ||
      filePath.startsWith('title:') ||
      filePath.startsWith('timeline:')) return {};
  const ext = path.extname(filePath).toLowerCase();
  // Skip non-video sources — images / audio files have no "fps for the
  // render to inherit" and we'd just waste an ffprobe call.
  const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.gif'];
  if (!videoExts.includes(ext)) return {};
  if (!fs.existsSync(filePath)) return {};

  let bin = 'ffprobe';
  try {
    const installer = await import('../../media/ffmpeg-installer.js');
    const r = await installer.ensureFfmpeg();
    if (r?.ffprobe) bin = r.ffprobe;
  } catch { /* fall back to PATH */ }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const { stdout } = await run(
      bin,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate,width,height',
        '-of', 'json',
        filePath,
      ],
      { timeout: 3000 },
    );
    const data = JSON.parse(stdout);
    const stream = data?.streams?.[0];
    if (!stream) return {};
    const out = {};
    // avg_frame_rate is a rational "num/den" string like "24/1" or "30000/1001".
    if (typeof stream.avg_frame_rate === 'string') {
      const [num, den] = stream.avg_frame_rate.split('/').map(Number);
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) {
        out.fps = Math.round((num / den) * 1000) / 1000; // keep 3 decimals for 23.976 / 29.97
      }
    }
    if (Number.isFinite(stream.width) && stream.width > 0) out.width = stream.width;
    if (Number.isFinite(stream.height) && stream.height > 0) out.height = stream.height;
    return out;
  } catch {
    return {};
  }
}

/**
 * Workflow workspaces (`<root>/.koi/workflows/<run_id>/...`) are
 * ephemeral — they get cleaned up at run-end or by manual garbage
 * collection. Once a timeline records a clip whose `path` lives there,
 * the moment the workspace disappears the clip becomes a black
 * rectangle with no playback ("de repente un clip ha desaparecido"
 * incident). This helper copies any workspace-bound clip path to the
 * canonical home for its kind (`~/.koi/videos/` / `images/` / `audio/`)
 * so the timeline always references stable storage. Returns the
 * (possibly-rewritten) path. Silently passes through:
 *   - placeholder paths (`placeholder-image:N`, `title:<uuid>`,
 *     `timeline:<id>`) — not real on-disk files;
 *   - paths already outside `.koi/workflows/`;
 *   - paths to files that don't exist (let `addClip` decide what to do);
 *   - paths where the canonical destination already exists with the
 *     same size + mtime (avoid duplicating large videos on every drop).
 */
function _stabilizeWorkspaceClipPath(clipPath) {
  if (typeof clipPath !== 'string' || !clipPath) return clipPath;
  // Skip non-file sentinels — those don't live on disk in the first
  // place; the timeline / GUI consume them as synthetic markers.
  if (clipPath.startsWith('placeholder-')) return clipPath;
  if (clipPath.startsWith('title:')) return clipPath;
  if (clipPath.startsWith('timeline:')) return clipPath;

  const resolved = path.resolve(clipPath);
  const segs = resolved.split(path.sep);
  let inWorkflowWorkspace = false;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === '.koi' && segs[i + 1] === 'workflows') {
      inWorkflowWorkspace = true;
      break;
    }
  }
  if (!inWorkflowWorkspace) return clipPath;

  if (!fs.existsSync(resolved)) {
    // The source isn't even on disk — `addClip` will register the
    // path as-is and the GUI's "video file missing" cartouche will
    // surface the problem. Nothing to copy.
    channel.log(
      'timeline',
      `add_clip_to_timeline: workspace path "${resolved}" does not exist on disk; ` +
      `passing through (the clip body will render as "file missing").`,
    );
    return clipPath;
  }

  // Pick destination by extension. Default to `videos/` because that's
  // the most common workspace artefact (generated MP4s from
  // generate_video). The classification only needs to be coarse — what
  // matters is that the destination is OUTSIDE `.koi/workflows/`.
  const ext = path.extname(resolved).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus'].includes(ext);
  const kindDir = isImage ? 'images' : isAudio ? 'audio' : 'videos';
  const canonicalDir = path.join(os.homedir(), '.koi', kindDir);
  try {
    if (!fs.existsSync(canonicalDir)) fs.mkdirSync(canonicalDir, { recursive: true });
  } catch (err) {
    channel.log(
      'timeline',
      `add_clip_to_timeline: failed to mkdir "${canonicalDir}" (${err.message}); ` +
      `leaving clip path on workspace — at risk of disappearance.`,
    );
    return clipPath;
  }
  const dest = path.join(canonicalDir, path.basename(resolved));

  // Cheap dedup: if a file with the same name already exists at the
  // canonical home AND its size + mtime match the source, the copy was
  // already done (or the workspace path is a hard/symlink mirror of
  // the same file). Just point at the canonical one.
  try {
    if (fs.existsSync(dest)) {
      const srcStat = fs.statSync(resolved);
      const dstStat = fs.statSync(dest);
      if (srcStat.size === dstStat.size
          && Math.abs(srcStat.mtimeMs - dstStat.mtimeMs) < 1000) {
        channel.log(
          'timeline',
          `add_clip_to_timeline: canonical copy "${dest}" already matches workspace ` +
          `source (size ${srcStat.size}); reusing without copy.`,
        );
        return dest;
      }
    }
  } catch { /* fall through to copy */ }

  try {
    fs.copyFileSync(resolved, dest);
    channel.log(
      'timeline',
      `add_clip_to_timeline: copied workspace artefact "${path.basename(resolved)}" ` +
      `→ "${dest}" so the timeline survives workspace cleanup.`,
    );
    return dest;
  } catch (err) {
    channel.log(
      'timeline',
      `add_clip_to_timeline: copy "${resolved}" → "${dest}" failed (${err.message}); ` +
      `leaving clip path on workspace — at risk of disappearance.`,
    );
    return clipPath;
  }
}

export default {
  type: 'add_clip_to_timeline',
  intent: 'add_clip_to_timeline',
  description:
    'Append a clip to a timeline. The clip object: { track ("V1"/"V2"/"A1"/…), path (absolute), startMs, durationMs, ' +
    'sourceInMs?, sourceTotalMs?, linkId?, offsetX?, offsetY?, scale? }. ' +
    'path can be a video, audio, OR image file (.png/.jpg/.webp/...) — images become still-frame clips on V tracks ' +
    'whose visible length is whatever you set in durationMs (images have no intrinsic duration; sourceInMs/sourceTotalMs are ignored). ' +
    'For text overlays, use add_title_to_timeline instead — it produces a synthetic title clip with editable typography. ' +
    'linkId is optional pairing — set the same linkId on a V-clip and an A-clip and they will move/trim/remove together. ' +
    'Returns: { success, clipId, clip, timeline }. Use clipId for any subsequent move/trim/update/remove call.',
  thinkingHint: 'Adding clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clip: { type: 'object', description: 'Clip to append (see description for fields)' },
    },
    required: ['id', 'clip'],
  },

  async execute(params) {
    const id = await resolveTimelineId(params);
    if (!id) {
      return {
        success: false,
        error: 'add_clip_to_timeline: pass `id` (or have a timeline as the active document).',
      };
    }
    // The agent occasionally calls this with `clip` fields flattened
    // into the top level (`{id, track, path, startMs, ...}` instead of
    // `{id, clip: {track, path, startMs, ...}}`). Accept both shapes —
    // the schema documents the nested form, but rejecting the flat
    // form sends the agent into a "clip must be an object" retry loop.
    let clip = params.clip;
    if (!clip || typeof clip !== 'object') {
      // Promote known clip fields from top-level to a synthetic object.
      const flatKeys = ['track', 'path', 'startMs', 'durationMs', 'sourceInMs',
                        'sourceTotalMs', 'linkId', 'offsetX', 'offsetY', 'scale',
                        'rotation', 'transformEnabled', 'titleProps'];
      const promoted = {};
      let any = false;
      for (const k of flatKeys) {
        if (params[k] !== undefined) { promoted[k] = params[k]; any = true; }
      }
      if (any) clip = promoted;
    }
    // Aliases: `add_track` returns `{ trackKey: "A4" }`, and the agent
    // routinely echoes that key under the same name on the next call.
    // Accept both `track` and `trackKey` (and `trackId`) as the same
    // field — rejecting causes "clip.track invalid: undefined" right
    // after a successful add_track, which is the most predictable
    // gotcha in this tool's history.
    if (clip && typeof clip === 'object' && !clip.track) {
      const alias = clip.trackKey || clip.trackId;
      if (typeof alias === 'string' && alias.length > 0) clip.track = alias;
    }
    // Stabilise workspace-bound paths before the clip is persisted —
    // workflow workspaces are ephemeral and a path that disappears
    // turns the clip into a black rectangle in the editor.
    if (clip && typeof clip === 'object' && typeof clip.path === 'string') {
      clip.path = _stabilizeWorkspaceClipPath(clip.path);
    }
    // Probe the source for an audio stream and stamp `hasAudio` on the
    // clip so the renderer knows whether to include it in the audio
    // mix. Only override when the caller didn't already set it
    // explicitly — agents that have already probed (or know the source
    // is muted on purpose) can pass `hasAudio: false` to opt out, OR
    // pass `hasAudio: true` to force the chain. Probe failures (no
    // ffprobe, weird codec) leave the field unset and the renderer's
    // extension heuristic kicks in.
    if (clip && typeof clip === 'object' && typeof clip.path === 'string'
        && clip.hasAudio === undefined) {
      try {
        const probed = await _probeHasAudio(clip.path);
        if (probed !== null) clip.hasAudio = probed;
      } catch (err) {
        channel.log('timeline', `add_clip_to_timeline: audio probe failed for "${clip.path}" (${err.message}); renderer will fall back to extension heuristic`);
      }
    }
    try {
      const { clip: created, timeline } = addClip(id, clip);

      // Inherit fps + width + height from the FIRST video clip dropped
      // onto an empty timeline (only when the timeline doesn't already
      // have those settings stamped). Goal: keep the render frame rate
      // / aspect ratio aligned with the source clips, so a 24 fps × 9:16
      // seedance reel plays back at 24 fps × 9:16 instead of being
      // forced into the renderer's 30 fps × 16:9 default (which produces
      // the black-flicker / black-band artefacts the user reported).
      try {
        const isVideoTrack = typeof created?.track === 'string' && created.track[0] === 'V';
        const settings = timeline?.settings || {};
        const fpsAlreadySet = Number.isFinite(settings.fps) && settings.fps > 0;
        const dimsAlreadySet =
          Number.isFinite(settings.width) && settings.width > 0 &&
          Number.isFinite(settings.height) && settings.height > 0;
        if (isVideoTrack && (!fpsAlreadySet || !dimsAlreadySet)) {
          // Count video clips currently on the timeline. We only inherit
          // when this is the FIRST — later clips on a populated timeline
          // shouldn't silently switch the project's framerate.
          const videoClipsBefore = (timeline?.clips || [])
            .filter((c) => typeof c?.track === 'string' && c.track[0] === 'V' && c.id !== created.id)
            .length;
          if (videoClipsBefore === 0 && typeof created?.path === 'string') {
            const meta = await _probeVideoMeta(created.path);
            const patch = {};
            if (!fpsAlreadySet && Number.isFinite(meta.fps)) patch.fps = meta.fps;
            if (!dimsAlreadySet) {
              if (Number.isFinite(meta.width)) patch.width = meta.width;
              if (Number.isFinite(meta.height)) patch.height = meta.height;
            }
            if (Object.keys(patch).length > 0) {
              const tl2 = setTimelineSettings(id, patch);
              channel.log(
                'timeline',
                `add_clip_to_timeline: inherited ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')} from first video clip (${path.basename(created.path)})`,
              );
              return { success: true, clipId: created.id, clip: created, timeline: tl2 };
            }
          }
        }
      } catch (probeErr) {
        // Non-fatal: we still added the clip, just couldn't read its
        // metadata. The renderer falls back to its 30 fps × 1920×1080
        // defaults — black flickers may reappear but the timeline is
        // otherwise functional.
        channel.log('timeline', `add_clip_to_timeline: meta inheritance skipped (${probeErr.message})`);
      }

      return { success: true, clipId: created.id, clip: created, timeline };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
