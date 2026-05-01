/**
 * Patch a single clip's non-positional fields.
 *
 * Position/duration changes still go through move_clip / trim_clip, and
 * transitions through set_clip_transition. update_clip handles the
 * remaining mutables: source path, visual transform (offsetX, offsetY,
 * scale), and V/A pairing (linkId).
 *
 * Sending an unknown field throws a clear error rather than silently
 * dropping it, so the agent can correct course on the next call.
 */

import { updateClip } from '../../state/timelines.js';

export default {
  type: 'update_clip',
  intent: 'update_clip',
  description:
    'Patch a clip\'s non-positional fields. Identify it by its stable clipId. ' +
    'changes ∈ { path?, offsetX?, offsetY?, scale?, linkId? }. ' +
    'path replaces the source media file. offsetX/offsetY pan the clip in canvas pixels (0,0 = centred). ' +
    'scale uniformly scales the clip (1 = original). linkId pairs the clip with a sibling on another track ' +
    '(use the same value on a V- and an A-clip so move/trim/remove cascade across the pair); pass null to clear. ' +
    'For startMs/track use move_clip; for sourceInMs/durationMs use trim_clip; for transitions use set_clip_transition; for audio volume automation use set_clip_volume. ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Updating clip',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
      changes: {
        type: 'object',
        description: 'Fields to patch: { path?, offsetX?, offsetY?, scale?, linkId? }',
      },
    },
    required: ['id', 'clipId', 'changes'],
  },

  async execute(params) {
    try {
      const tl = updateClip(params.id, params.clipId, params.changes);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
