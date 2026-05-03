/**
 * Append a single clip to an existing timeline.
 *
 * Convenience over update_timeline when the agent only wants to drop
 * one clip in (e.g. "place this generated video at second 12 on V1").
 * Returns the freshly-minted clipId so the agent can immediately
 * move/trim/update/remove that exact clip without a re-read.
 */

import { addClip } from '../../state/timelines.js';
import { resolveTimelineId } from './_resolve-timeline-id.js';

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
    try {
      const { clip: created, timeline } = addClip(id, clip);
      return { success: true, clipId: created.id, clip: created, timeline };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
