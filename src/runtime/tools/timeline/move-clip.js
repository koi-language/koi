/**
 * Move an existing clip on the timeline.
 *
 * Identify the clip with its stable `clipId` (returned from
 * add_clip_to_timeline or read from get_timeline). Supply a new
 * `target` ({ startMs?, track? }).
 *
 * Linked V/A peers shift by the same delta in time, but only the
 * targeted clip changes track (matches DaVinci's default behaviour).
 */

import { moveClip } from '../../state/timelines.js';

export default {
  type: 'move_clip',
  intent: 'move_clip',
  description:
    'Move a clip in the timeline. Identify it by its stable clipId. ' +
    'Target: { startMs?, track? } — startMs is the new timeline position; track must be the same V/A type. ' +
    'Linked peers shift by the same time delta. Returns: { success, timeline }.',
  thinkingHint: 'Moving clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
      target: {
        type: 'object',
        description: 'New position/track: { startMs?, track? }',
      },
    },
    required: ['id', 'clipId', 'target'],
  },

  async execute(params) {
    try {
      const tl = moveClip(params.id, params.clipId, params.target);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
