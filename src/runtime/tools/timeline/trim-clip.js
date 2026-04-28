/**
 * Trim a clip's left or right edge.
 *
 * Two modes:
 *   - Relative drag: { edge: -1 | 1, deltaMs }
 *       edge=-1 → left  (in-point):  startMs += d, sourceInMs += d, durationMs -= d
 *       edge=+1 → right (out-point): durationMs += d
 *   - Absolute set: { sourceInMs?, durationMs? }
 *
 * Linked V/A peers trim together so audio stays sample-aligned.
 */

import { trimClip } from '../../state/timelines.js';

export default {
  type: 'trim_clip',
  intent: 'trim_clip',
  description:
    'Trim a clip in a timeline. Identify it by its stable clipId. ' +
    'Change shape — either { edge: -1|1, deltaMs } for an NLE-style edge drag, or { sourceInMs?, durationMs? } to set absolute values. ' +
    'Linked peers trim together. Returns: { success, timeline }.',
  thinkingHint: 'Trimming clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
      change: {
        type: 'object',
        description: '{ edge: -1|1, deltaMs } OR { sourceInMs?, durationMs? }',
      },
    },
    required: ['id', 'clipId', 'change'],
  },

  async execute(params) {
    try {
      const tl = trimClip(params.id, params.clipId, params.change);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
