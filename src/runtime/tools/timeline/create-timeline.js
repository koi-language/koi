/**
 * Create a new project timeline.
 *
 * Stored at <projectRoot>/.koi/timelines/<id>.json. Returns the full
 * state (including the generated id) so the caller can immediately
 * reference it from other timeline_* tools without an extra list call.
 *
 * Three calling shapes:
 *   1. Empty timeline with defaults:
 *        { intent: "create_timeline" }
 *   2. Empty with a name:
 *        { intent: "create_timeline", name: "Trailer cut" }
 *   3. Pre-populated from a full state JSON (the "set everything at
 *      once" pattern — handy when an LLM wants to render an entire
 *      edit from a script in one tool call):
 *        { intent: "create_timeline", name: "Trailer", state: { settings: {...}, clips: [...] } }
 */

import { createTimeline } from '../../state/timelines.js';

export default {
  type: 'create_timeline',
  intent: 'create_timeline',
  description:
    'Create a new project timeline. Stored persistently in .koi/timelines/<id>.json. ' +
    'Optional "name", optional "settings" ({videoTracks, audioTracks, pixelsPerSecond}), ' +
    'optional "clips" array of {track, path, startMs, durationMs, sourceInMs?, sourceTotalMs?, linkId?}, ' +
    'or pass a complete "state" object to seed the whole edit at once. ' +
    'Returns: { success, id, timeline }.',
  thinkingHint: 'Creating timeline',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable name (defaults to "Timeline")' },
      settings: {
        type: 'object',
        description: 'Initial settings: videoTracks, audioTracks, pixelsPerSecond, previewSplit, playheadMs',
      },
      clips: {
        type: 'array',
        description:
          'Initial clips. Each clip: { track ("V1"/"V2"/"A1"/…), path (absolute), startMs, durationMs, sourceInMs?, sourceTotalMs?, linkId? }',
      },
      state: {
        type: 'object',
        description: 'Alternative to settings+clips: a full timeline state object to seed from.',
      },
    },
  },

  async execute(params = {}) {
    try {
      const tl = createTimeline({
        name: params.name,
        settings: params.settings,
        clips: params.clips,
        state: params.state,
      });
      return { success: true, id: tl.id, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
