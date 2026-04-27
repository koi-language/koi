/**
 * Replace a timeline's state in one shot.
 *
 * The "set everything at once" path — the agent provides a full
 * (settings + clips) JSON and we atomically swap the on-disk file.
 * Used when generating a fresh edit from a script, importing from
 * another tool, or undoing many changes by reapplying a prior state.
 */

import { updateTimeline } from '../../state/timelines.js';

export default {
  type: 'update_timeline',
  intent: 'update_timeline',
  description:
    'Replace a timeline\'s entire state with the provided JSON. Atomic. ' +
    'state must include "settings" and "clips" (id is taken from the URL param, not from state). ' +
    'Returns: { success, timeline } with the normalised result.',
  thinkingHint: 'Updating timeline',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id to overwrite' },
      state: {
        type: 'object',
        description: 'Full timeline state — { name?, settings, clips }. Must validate against the schema.',
      },
    },
    required: ['id', 'state'],
  },

  async execute(params) {
    try {
      const tl = updateTimeline(params.id, params.state || {});
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
