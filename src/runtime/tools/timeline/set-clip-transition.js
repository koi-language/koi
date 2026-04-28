/**
 * Set or clear a clip's transitions.
 *
 * `transitionIn` fires at the clip's start; with a same-track neighbour
 * ending at that point it cross-fades between the two clips, otherwise
 * it fades from black/silence.
 *
 * `transitionOut` fires at the clip's end; honoured only when no clip
 * follows on the same track (end-of-timeline fade), otherwise the next
 * clip's `transitionIn` wins.
 *
 * V/A peers are NOT auto-synced — set each side independently to enable
 * J-cuts (audio leads) or L-cuts (audio trails).
 */

import { setClipTransition } from '../../state/timelines.js';

const TRANSITION_TYPES = [
  'crossfade', 'fade-black', 'fade-white', 'dissolve',
  'slide-left', 'slide-right', 'slide-up', 'slide-down',
  'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
  'circle-open', 'circle-close',
  'pixelize', 'zoom-in', 'radial',
];

export default {
  type: 'set_clip_transition',
  intent: 'set_clip_transition',
  description:
    'Set or clear a clip\'s transitions. Identify it by its stable clipId. ' +
    'Change shape: { in?: {type, durationMs, alignment?, params?} | null, out?: same | null } — ' +
    'null clears that side, undefined leaves it untouched. ' +
    `Allowed types: ${TRANSITION_TYPES.join(', ')}. ` +
    'alignment ∈ {center (default) | start-on-cut | end-on-cut}. ' +
    'durationMs must be ≥ 50 and ≤ clip.durationMs/2. ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Setting clip transition',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
      change: {
        type: 'object',
        description:
          '{ in?: {type, durationMs, alignment?, params?} | null, out?: same | null } — ' +
          'null clears, undefined leaves untouched',
      },
    },
    required: ['id', 'clipId', 'change'],
  },

  async execute(params) {
    try {
      const tl = setClipTransition(params.id, params.clipId, params.change);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
