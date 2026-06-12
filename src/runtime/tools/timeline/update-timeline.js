/**
 * Replace a timeline's state in one shot.
 *
 * The "set everything at once" path — the agent provides a full
 * (settings + clips) JSON and we atomically swap the on-disk file.
 * Used when generating a fresh edit from a script, importing from
 * another tool, or undoing many changes by reapplying a prior state.
 */

import { updateTimeline, getTimeline } from '../../state/timelines.js';
import { resolveTimelineId } from './_resolve-timeline-id.js';

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
      id: { type: 'string', description: 'Timeline id to overwrite. Omit to use the active timeline document.' },
      state: {
        type: 'object',
        description: 'Full timeline state — { name?, settings, clips }. Must validate against the schema.',
      },
      allowEmpty: {
        type: 'boolean',
        description: 'Required (true) to replace a non-empty timeline with one that has ZERO clips. Without it, an empty clips array on a populated timeline is rejected as a likely mistake.',
      },
    },
    required: ['state'],
  },

  async execute(params) {
    try {
      // Same active-document fallback as get_timeline, so the natural
      // get_timeline → transform → update_timeline loop works without the
      // model having to carry the id between calls.
      const id = await resolveTimelineId(params);
      if (!id) {
        return {
          success: false,
          error: 'update_timeline: missing "id" and no timeline document is active. '
            + 'Pass { id: "tl-..." } — use list_timelines to find it.',
        };
      }
      // This tool REPLACES the whole timeline. A missing/partial state used
      // to normalise into a blank default and silently WIPE every clip (and
      // the name) — refuse anything that isn't a full state, and refuse a
      // zero-clip replacement of a populated timeline without explicit intent.
      const state = params.state;
      if (!state || typeof state !== 'object' || !Array.isArray(state.clips)) {
        return {
          success: false,
          error: 'update_timeline: "state" must be the FULL timeline state with a "clips" ARRAY '
            + '(call get_timeline, transform the returned JSON, and send the whole thing back). '
            + 'Refusing a partial state — it would replace the entire timeline. '
            + `Got state keys: ${state && typeof state === 'object' ? JSON.stringify(Object.keys(state)) : String(state)}.`,
        };
      }
      const current = getTimeline(id);
      if (current && Array.isArray(current.clips) && current.clips.length > 0
          && state.clips.length === 0 && params.allowEmpty !== true) {
        return {
          success: false,
          error: `update_timeline: the new state has 0 clips but "${current.name}" currently has `
            + `${current.clips.length} — this would WIPE the timeline. If that is really intended, `
            + 'pass { allowEmpty: true }. To remove specific clips use remove_clip.',
        };
      }
      // Preserve identity fields the model commonly leaves out of a
      // transformed state — dropping them must not rename the timeline.
      const merged = {
        ...state,
        name: state.name ?? current?.name,
        createdAt: state.createdAt ?? current?.createdAt,
      };
      const tl = updateTimeline(id, merged);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
