/**
 * Delete a timeline file from the project.
 */

import { deleteTimeline } from '../../state/timelines.js';

export default {
  type: 'delete_timeline',
  intent: 'delete_timeline',
  description:
    'Delete a timeline file (and all its tracks/clips). Returns: { success, removed } (removed=false if the timeline didn\'t exist).',
  thinkingHint: 'Deleting timeline',
  permission: 'write',

  schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Timeline id' } },
    required: ['id'],
  },

  async execute(params) {
    try {
      const removed = deleteTimeline(params.id);
      return { success: true, removed };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
