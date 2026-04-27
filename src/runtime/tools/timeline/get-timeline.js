/**
 * Read the full state of a timeline by id.
 *
 * Returned shape mirrors the on-disk JSON exactly — agents can
 * inspect/transform it and pass it back to update_timeline for an
 * atomic full-state replacement.
 */

import { getTimeline } from '../../state/timelines.js';

export default {
  type: 'get_timeline',
  intent: 'get_timeline',
  description:
    'Read the full JSON state of a timeline by id. Returns: { success, timeline } with timeline = { id, name, version, settings, clips, … } or null if missing.',
  thinkingHint: 'Reading timeline',
  permission: 'read',

  schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Timeline id (e.g. "tl-1730000000-abc")' } },
    required: ['id'],
  },

  async execute(params) {
    try {
      const tl = getTimeline(params.id);
      if (!tl) return { success: false, error: `Timeline ${params.id} not found` };
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
