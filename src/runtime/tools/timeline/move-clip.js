/**
 * Move an existing clip on the timeline.
 *
 * Identify the clip with `match` ({track, startMs} or {track, index}
 * or {linkId}), and supply a new `target` ({startMs?, track?}).
 *
 * Linked V/A peers shift by the same delta in time, but only the
 * targeted clip changes track (matches DaVinci's default behaviour).
 */

import { moveClip } from '../../state/timelines.js';

export default {
  type: 'move_clip',
  intent: 'move_clip',
  description:
    'Move a clip in the timeline. Identify it via match: { track, startMs } | { track, index } | { linkId }. ' +
    'Target: { startMs?, track? } — startMs is the new timeline position; track must be the same V/A type. ' +
    'Linked peers (same linkId) shift by the same time delta. Returns: { success, timeline }.',
  thinkingHint: 'Moving clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      match: {
        type: 'object',
        description: 'Clip locator: { track, startMs } or { track, index } (0-based within that track) or { linkId }',
      },
      target: {
        type: 'object',
        description: 'New position/track: { startMs?, track? }',
      },
    },
    required: ['id', 'match', 'target'],
  },

  async execute(params) {
    try {
      const tl = moveClip(params.id, params.match, params.target);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
