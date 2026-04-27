/**
 * Append a new V or A track to a timeline.
 *
 * Returns the auto-generated track key (e.g. "V3" if there were two
 * video tracks already). Capped at 10 tracks per type.
 */

import { addTrack } from '../../state/timelines.js';

export default {
  type: 'add_track',
  intent: 'add_track',
  description:
    'Add a video or audio track to a timeline. type must be "video" or "audio". ' +
    'Returns: { success, trackKey } (e.g. "V3", "A2").',
  thinkingHint: 'Adding track',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      type: { type: 'string', enum: ['video', 'audio'], description: 'Track type' },
    },
    required: ['id', 'type'],
  },

  async execute(params) {
    try {
      const trackKey = addTrack(params.id, params.type);
      return { success: true, trackKey };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
