/**
 * Remove a clip (and its linked V/A peers) from a timeline.
 */

import { removeClip } from '../../state/timelines.js';

export default {
  type: 'remove_clip',
  intent: 'remove_clip',
  description:
    'Remove a clip from a timeline. Identify with match: { track, startMs } | { track, index } | { linkId }. ' +
    'If the clip has a linkId, every clip sharing that id is removed too (V+A pair stays consistent). ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Removing clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      match: { type: 'object', description: 'Clip locator (see description)' },
    },
    required: ['id', 'match'],
  },

  async execute(params) {
    try {
      const tl = removeClip(params.id, params.match);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
