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
import { addClip } from '../../state/timelines.js';
import { resolveTimelineId } from './_resolve-timeline-id.js';
import { channel } from '../../io/channel.js';

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
    try {
      const { clip: created, timeline } = addClip(id, clip);
      return { success: true, clipId: created.id, clip: created, timeline };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
