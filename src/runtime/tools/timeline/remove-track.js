/**
 * Remove a track from a timeline. All clips on it (and their linked
 * V/A peers on other tracks) are deleted; higher-numbered tracks of
 * the same type renumber down to keep V1/V2/V3 dense.
 *
 * Always keeps at least one V and one A track — removing the last
 * one of either type just empties the lane instead of dropping it.
 */

import { removeTrack } from '../../state/timelines.js';

export default {
  type: 'remove_track',
  intent: 'remove_track',
  description:
    'Remove a track (and every clip on it, plus linked peers) from a timeline. trackKey: "V1", "V2", "A1", … ' +
    'The last V and last A track can\'t be deleted; the call clears their clips instead. ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Removing track',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      trackKey: { type: 'string', description: 'Track to remove (e.g. "V2")' },
    },
    required: ['id', 'trackKey'],
  },

  async execute(params) {
    try {
      const tl = removeTrack(params.id, params.trackKey);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
