/**
 * Read the full state of a timeline by id.
 *
 * Returned shape mirrors the on-disk JSON exactly — agents can
 * inspect/transform it and pass it back to update_timeline for an
 * atomic full-state replacement.
 */

import { getTimeline } from '../../state/timelines.js';
import { resolveTimelineId } from './_resolve-timeline-id.js';

export default {
  type: 'get_timeline',
  intent: 'get_timeline',
  description:
    'Read the full JSON state of a timeline by id (defaults to the ACTIVE timeline document when omitted). Returns: { success, timeline } with timeline = { id, name, version, settings, clips, … } or null if missing. Use this (NOT read_file) to inspect or edit a timeline\'s structure — read_file renders a timeline to video for viewing.',
  thinkingHint: 'Reading timeline',
  permission: 'read',

  schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Timeline id (e.g. "tl-1730000000-abc"). Omit to use the active timeline document.' } },
  },

  async execute(params) {
    try {
      // Fall back to the ACTIVE timeline document when no id was passed —
      // the most common call is "the timeline the user is looking at", and
      // a bare "Timeline undefined not found" sent agents into a
      // list/read/shell goose chase instead of a one-call fix.
      const id = await resolveTimelineId(params);
      if (!id) {
        return {
          success: false,
          error: 'get_timeline: missing "id" and no timeline document is active. '
            + 'Pass { id: "tl-..." } — use list_timelines to find it.',
        };
      }
      const tl = getTimeline(id);
      if (!tl) {
        return {
          success: false,
          error: `Timeline "${id}" not found — use list_timelines to see the available ids.`,
        };
      }
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
