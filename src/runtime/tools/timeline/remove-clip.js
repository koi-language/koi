/**
 * Remove a clip (and its linked V/A peers) from a timeline.
 */

import { removeClip } from '../../state/timelines.js';

export default {
  type: 'remove_clip',
  intent: 'remove_clip',
  description:
    'Remove a clip from a timeline. Identify it by its stable clipId. ' +
    'If the clip is linked to a sibling (linkId), every clip sharing that linkId is removed too (V+A pair stays consistent). ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Removing clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
    },
    required: ['id', 'clipId'],
  },

  async execute(params) {
    try {
      const tl = removeClip(params.id, params.clipId);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
