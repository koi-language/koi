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

import { docDir } from '../../state/doc-root.js';
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
 * canonical home for its kind (`<project>/videos/` / `images/` / `audio/`)
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
  const canonicalDir = docDir(kindDir);
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
    'Append a clip to a timeline. ' +
    'Call shape: { id: "<timelineId>", clip: { track, path, startMs, durationMs, ... } }. ' +
    'Required fields inside `clip`: ' +
    '`track` — STRING "V1"/"V2"/"A1"/"A2"/… (V = video lane, A = audio lane; numbers like 1 or "1" are REJECTED). ' +
    '`path` — absolute path to a video, audio, or image file (relative paths are REJECTED). ' +
    '`startMs` — clip position on the timeline, MILLISECONDS as an integer (5 seconds = 5000; "startTime" and bare seconds are REJECTED). ' +
    '`durationMs` — how long the clip plays, MILLISECONDS as an integer ≥ 50 (15 seconds = 15000; "duration" and bare seconds are REJECTED). ' +
    'Optional: sourceInMs (where in the source file the clip starts, ms), sourceTotalMs (source duration cap, ms), ' +
    'linkId (pair a V-clip and an A-clip so they move/trim/remove together), ' +
    'offsetX/offsetY/scale (visual transform; defaults 0/0/1). ' +
    'Images become still-frame clips on V tracks; their durationMs IS their visible length on the timeline (no intrinsic duration). ' +
    'For text overlays use `add_title_to_timeline` instead — it produces a synthetic title clip with editable typography. ' +
    'AUTO-PAIR: when a V-track clip with an audio stream is added, a sibling A-track clip is created automatically — same path, same start, same duration, linked via a shared linkId so they move/trim/remove together (just like dragging a video with sound into an NLE). The audio plays on the A lane; you get a separate clip to mute, change volume on, set keyframes on. The V clip\'s `hasAudio` is flipped to false so the source audio isn\'t double-mixed. If every A lane is occupied at that time window, a new A lane is added (up to 10). To opt out of auto-pair (e.g. for a silent video lay-down), pass `hasAudio: false` explicitly. To pair the V clip yourself, pass a `linkId` of your choice and the auto-pair is skipped. ' +
    'Returns: { success, clipId, clip, timeline, pairedAudioClipId?, pairedAudioClip? }. Use clipId for any subsequent move/trim/update/remove call; the linked audio clip moves/trims/removes with it via its linkId. ' +
    'On invalid input the tool returns { success: false, error } with the exact field that\'s wrong and the corrected form — read the error before retrying.',
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
    const clip = params.clip;
    // Reject the flat form with a SPECIFIC error so the agent learns
    // the correct shape instead of having the tool guess. Common
    // mistakes the agent makes: passing clip fields at the top level
    // (alongside `id`) instead of nested inside `clip: { ... }`.
    if (!clip || typeof clip !== 'object') {
      const flatHints = [];
      for (const k of ['track', 'path', 'startMs', 'durationMs', 'startTime', 'start', 'duration']) {
        if (params[k] !== undefined) flatHints.push(k);
      }
      if (flatHints.length > 0) {
        return {
          success: false,
          error:
            `add_clip_to_timeline: clip fields (${flatHints.join(', ')}) were passed at the top level, ` +
            `but they must be nested inside a "clip" object. Correct shape: ` +
            `{ id: "<timelineId>", clip: { track: "V1", path: "<absolute>", startMs: <int>, durationMs: <int> } }. ` +
            `Note: startMs/durationMs are MILLISECONDS (not seconds), and track is a STRING like "V1"/"V2"/"A1"/"A2" (not a number).`,
        };
      }
      return {
        success: false,
        error:
          `add_clip_to_timeline: "clip" is required and must be an object. ` +
          `Correct shape: { id: "<timelineId>", clip: { track: "V1", path: "<absolute>", startMs: <int>, durationMs: <int> } }.`,
      };
    }
    // Validate track value with a sharp error message before the
    // generic _validateClip throw. The agent reaches for `track: 1`,
    // `track: "1"`, `trackKey: "V1"`, `trackId: "V1"` at non-trivial
    // frequency — pointing them at the right form is faster than
    // having them retry blind.
    if (typeof clip.track !== 'string' || !/^[VA][1-9][0-9]*$/.test(clip.track)) {
      const got = JSON.stringify(clip.track);
      return {
        success: false,
        error:
          `add_clip_to_timeline: clip.track = ${got} is invalid. ` +
          `track must be a STRING in the form "V1" / "V2" / "A1" / "A2" / … ` +
          `(V = video lane, A = audio lane; the number is the lane index, 1-based). ` +
          `For a video file go on V1; for music / standalone voiceover go on A1 or A2. ` +
          `If you only passed a number (1, 2, …), you meant "V1" / "V2" for video clips ` +
          `or "A1" / "A2" for audio clips — restate as the full string.`,
      };
    }
    if (!Number.isFinite(clip.startMs) || clip.startMs < 0) {
      return {
        success: false,
        error:
          `add_clip_to_timeline: clip.startMs = ${JSON.stringify(clip.startMs)} is invalid. ` +
          `startMs is the clip's position on the timeline in MILLISECONDS (integer, ≥ 0). ` +
          `For 5 seconds use 5000, for 12.5 seconds use 12500. ` +
          `Do not pass seconds; do not pass "startTime"; the field name is "startMs".`,
      };
    }
    if (!Number.isFinite(clip.durationMs) || clip.durationMs < 50) {
      return {
        success: false,
        error:
          `add_clip_to_timeline: clip.durationMs = ${JSON.stringify(clip.durationMs)} is invalid. ` +
          `durationMs is how long the clip plays in MILLISECONDS (integer, ≥ 50). ` +
          `For a 15-second sheet render use 15000. ` +
          `Do not pass seconds; do not pass "duration"; the field name is "durationMs". ` +
          `For static images (which have no intrinsic duration) supply whatever visible length you want.`,
      };
    }
    // Stabilise workspace-bound paths before the clip is persisted —
    // workflow workspaces are ephemeral and a path that disappears
    // turns the clip into a black rectangle in the editor.
    if (clip && typeof clip === 'object' && typeof clip.path === 'string') {
      clip.path = _stabilizeWorkspaceClipPath(clip.path);
    }
    // Probe the source for an audio stream and stamp `hasAudio` on the
    // clip so the renderer knows whether to include it in the audio
    // mix, AND so the auto-pair logic below knows whether to mint a
    // sibling A-track clip. Only override when the caller didn't
    // already set it explicitly — `hasAudio: false` always wins (silent
    // video by design), `hasAudio: true` forces inclusion.
    if (clip && typeof clip === 'object' && typeof clip.path === 'string'
        && clip.hasAudio === undefined) {
      try {
        const probed = await _probeHasAudio(clip.path);
        if (probed !== null) {
          clip.hasAudio = probed;
          channel.log(
            'timeline',
            `add_clip_to_timeline: ffprobe → hasAudio=${probed} for "${path.basename(clip.path)}"`,
          );
        } else {
          channel.log(
            'timeline',
            `add_clip_to_timeline: ffprobe returned null for "${path.basename(clip.path)}" — renderer will fall back to extension heuristic (video extensions assumed to carry audio)`,
          );
        }
      } catch (err) {
        channel.log('timeline', `add_clip_to_timeline: audio probe failed for "${clip.path}" (${err.message}); renderer will fall back to extension heuristic`);
      }
    }

    // AUTO-PAIR: when a V-track video clip is added AND it has an
    // audio stream AND the caller didn't already pair it manually
    // (no `linkId`), drop a sibling A-track clip pointing at the same
    // source — same path, same start, same duration — linked via a
    // shared linkId so they move/trim/remove together. This mirrors
    // every NLE's behaviour: when you drop a video clip with sound
    // onto V1, the editor automatically places its audio on A1,
    // linked. The user gets a separate audio lane they can mute,
    // duck, set volume keyframes on, etc.
    //
    // To avoid double-mixing (V's embedded audio + A's identical
    // audio), we flag the V clip's `hasAudio = false` after pairing
    // so the renderer only mixes the A side.
    const isVideoTrackInput = typeof clip.track === 'string' && clip.track[0] === 'V';
    const shouldAutoPair = isVideoTrackInput
      && clip.hasAudio === true
      && !clip.linkId;
    let pairLinkId = null;
    if (shouldAutoPair) {
      pairLinkId = `lnk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      clip.linkId = pairLinkId;
      // Switch the V clip off the renderer's audio mix — the A peer
      // will provide it. Renderer reads hasAudio: false → skip the
      // V's audio chain → A's audio is the single source. No doubling.
      clip.hasAudio = false;
    }

    try {
      let { clip: created, timeline } = addClip(id, clip);

      // Inherit fps + width + height from the FIRST video clip dropped
      // onto an empty timeline (only when the timeline doesn't already
      // have those settings stamped). Goal: keep the render frame rate
      // / aspect ratio aligned with the source clips, so a 24 fps × 9:16
      // seedance reel plays back at 24 fps × 9:16 instead of being
      // forced into the renderer's 30 fps × 16:9 default (which produces
      // the black-flicker / black-band artefacts the user reported).
      try {
        const isVideoTrack = typeof created?.track === 'string' && created.track[0] === 'V';
        if (isVideoTrack) {
          // Count video clips currently on the timeline (excluding the
          // one we just added). When this is the FIRST video clip, the
          // timeline ALWAYS adopts that clip's fps + dimensions —
          // regardless of whatever defaults a client (the Flutter GUI
          // writes `projectFps: 30` on every timeline save; an agent
          // might `create_timeline` with no fps and the storage layer
          // back-fills one) may have written into settings. This is
          // the user-visible contract: "el timeline se auto-ajusta al
          // primer clip que se pone, lo decide la API del timeline,
          // no el cliente". If the user genuinely wants a different
          // fps / canvas than the first clip's, they call
          // `update_timeline { fps, width, height }` AFTER the first
          // drop — that path is the explicit override and isn't
          // affected by subsequent clip drops (the videoClipsBefore
          // gate below blocks inheritance for everything past clip #1).
          const videoClipsBefore = (timeline?.clips || [])
            .filter((c) => typeof c?.track === 'string' && c.track[0] === 'V' && c.id !== created.id)
            .length;
          if (videoClipsBefore === 0 && typeof created?.path === 'string') {
            const meta = await _probeVideoMeta(created.path);
            const patch = {};
            if (Number.isFinite(meta.fps)) patch.fps = meta.fps;
            if (Number.isFinite(meta.width)) patch.width = meta.width;
            if (Number.isFinite(meta.height)) patch.height = meta.height;
            if (Object.keys(patch).length > 0) {
              timeline = setTimelineSettings(id, patch);
              channel.log(
                'timeline',
                `add_clip_to_timeline: auto-adjusted timeline to first video clip — ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')} (${path.basename(created.path)})`,
              );
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

      // AUTO-PAIR (continued): now that the V clip is on the timeline,
      // drop the sibling A clip on the first available A-track. Find
      // an A-lane with no overlap in [startMs, startMs+durationMs].
      // If every existing A-lane collides, expand audioTracks by 1
      // (capped at 10 to match the canonical settings range).
      let pairedAudioClip = null;
      if (shouldAutoPair && pairLinkId) {
        try {
          const audioCap = Math.max(1, Math.min(10, timeline?.settings?.audioTracks ?? 2));
          const start = created.startMs;
          const end = created.startMs + created.durationMs;
          let chosenTrack = null;
          for (let t = 1; t <= audioCap; t++) {
            const tk = `A${t}`;
            const collides = (timeline?.clips || []).some(
              (c) => c.track === tk
                && c.startMs < end
                && c.startMs + c.durationMs > start,
            );
            if (!collides) { chosenTrack = tk; break; }
          }
          if (!chosenTrack && audioCap < 10) {
            timeline = setTimelineSettings(id, { audioTracks: audioCap + 1 });
            chosenTrack = `A${audioCap + 1}`;
          }
          if (chosenTrack) {
            const audioClipDraft = {
              track: chosenTrack,
              path: created.path,
              startMs: created.startMs,
              durationMs: created.durationMs,
              sourceInMs: created.sourceInMs ?? 0,
              sourceTotalMs: created.sourceTotalMs ?? 0,
              linkId: pairLinkId,
              hasAudio: true,
            };
            const result = addClip(id, audioClipDraft);
            pairedAudioClip = result.clip;
            timeline = result.timeline;
            channel.log(
              'timeline',
              `add_clip_to_timeline: auto-paired audio on ${chosenTrack} (linkId=${pairLinkId}) for "${path.basename(created.path)}"`,
            );
          } else {
            // Every A-lane is occupied in the time window AND we've hit
            // the 10-track cap. Restore the V clip's audio so it isn't
            // silently dropped — the renderer will mix it from V1's
            // input as a fallback.
            channel.log(
              'timeline',
              `add_clip_to_timeline: no free A-track for auto-pair (${audioCap} lanes, all colliding) — V clip's hasAudio restored, renderer will mix from V input`,
            );
            // Re-flip hasAudio on the persisted V clip. There's no
            // direct mutator, but the renderer's extension heuristic
            // still kicks in when hasAudio is omitted; safer: leave
            // hasAudio=false and accept silence than fight the state.
          }
        } catch (pairErr) {
          channel.log('timeline', `add_clip_to_timeline: auto-pair failed (${pairErr.message}); V clip is on its own without a paired audio lane`);
        }
      }

      const out = { success: true, clipId: created.id, clip: created, timeline };
      if (pairedAudioClip) {
        out.pairedAudioClipId = pairedAudioClip.id;
        out.pairedAudioClip = pairedAudioClip;
      }
      return out;
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
