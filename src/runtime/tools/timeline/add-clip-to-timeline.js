/**
 * Append a single clip to an existing timeline.
 *
 * Convenience over update_timeline when the agent only wants to drop
 * one clip in (e.g. "place this generated video at second 12 on V1").
 * Returns the freshly-minted clipId so the agent can immediately
 * move/trim/update/remove that exact clip without a re-read.
 */

import { addClip } from '../../state/timelines.js';

export default {
  type: 'add_clip_to_timeline',
  intent: 'add_clip_to_timeline',
  description:
    'Append a clip to a timeline. The clip object: { track ("V1"/"V2"/"A1"/…), path (absolute), startMs, durationMs, ' +
    'sourceInMs?, sourceTotalMs?, linkId?, offsetX?, offsetY?, scale? }. ' +
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
    try {
      const { clip, timeline } = addClip(params.id, params.clip);
      return { success: true, clipId: clip.id, clip, timeline };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
