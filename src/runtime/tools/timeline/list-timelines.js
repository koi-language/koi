/**
 * List every timeline saved in the project.
 *
 * Useful as a discovery step before referencing one by id. Each entry
 * is lightweight (no clips, just summary stats) so the agent can pick
 * the right one without paying the cost of reading every full file.
 */

import { listTimelines } from '../../state/timelines.js';

export default {
  type: 'list_timelines',
  intent: 'list_timelines',
  description:
    'List all timelines saved in this project. Returns: { success, timelines: [{id, name, clipCount, videoTracks, audioTracks, updatedAt}] } sorted most-recently-edited first.',
  thinkingHint: 'Listing timelines',
  permission: 'read',

  schema: { type: 'object', properties: {} },

  async execute() {
    try {
      return { success: true, timelines: listTimelines() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
