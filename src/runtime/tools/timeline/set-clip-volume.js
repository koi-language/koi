/**
 * Set or clear an audio clip's volume automation curve.
 *
 * Two ways to drive it:
 *
 *   1. Replace the keyframes outright with `change.points`:
 *        [{ t: 0, v: 1.0 }, { t: 4500, v: 0.5 }, { t: 5000, v: 0.0 }]
 *      Linear interpolation runs between consecutive points; before the
 *      first / after the last keyframe the level is held flat. Pass
 *      `points: null` to clear the curve and restore unity gain.
 *
 *   2. Uniform gain shortcut with `change.gain` (linear, 0..2):
 *        gain: 0.5  → -6 dB across the whole clip
 *        gain: 1.0  → unity (clears the curve)
 *        gain: 2.0  → +6 dB across the whole clip
 *      Writes two anchor points (start + end) at that value.
 *
 * `t` is clip-local milliseconds (0 = the clip's left edge on the
 * timeline). `v` is linear gain — `dB = 20 * log10(v)`. The macOS
 * native player reads this same JSON and feeds it through
 * `AVMutableAudioMixInputParameters.setVolumeRamp` per consecutive
 * pair, so the perceptual curve matches what the GUI shows.
 *
 * Only audio tracks (A1, A2, …) accept volume automation. Calling
 * this on a video clip throws.
 */

import { setClipVolume } from '../../state/timelines.js';

export default {
  type: 'set_clip_volume',
  intent: 'set_clip_volume',
  description:
    'Set, replace, or clear the volume automation curve on an audio clip. ' +
    'Identify the clip by its stable clipId. Provide EITHER ' +
    '`change.points` (array of `{t, v}` keyframes — clip-local ms × linear ' +
    'gain in [0,2]; `null` clears the curve) OR `change.gain` (uniform ' +
    'linear gain across the whole clip; 1.0 = unity, 0.5 = -6 dB, 2.0 = +6 dB). ' +
    'Linear interpolation runs between consecutive points. Audio tracks only. ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Adjusting clip volume',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
      change: {
        type: 'object',
        description:
          'Either { points: [{t, v}] | null } to replace/clear the curve, ' +
          'or { gain: number } for a uniform clip-wide gain.',
        properties: {
          points: {
            type: ['array', 'null'],
            description:
              'Keyframes as `{t, v}` (clip-local ms × linear gain in [0,2]). ' +
              'Null clears the curve.',
            items: {
              type: 'object',
              properties: {
                t: { type: 'number', description: 'Clip-local milliseconds, ≥ 0 and ≤ clip.durationMs' },
                v: { type: 'number', description: 'Linear gain in [0, 2]; 1.0 = unity, 0.5 = -6 dB, 2.0 = +6 dB' },
              },
              required: ['t', 'v'],
            },
          },
          gain: {
            type: 'number',
            description: 'Uniform clip-wide linear gain in [0, 2]. 1.0 clears the curve.',
          },
        },
      },
    },
    required: ['id', 'clipId', 'change'],
  },

  async execute(params) {
    try {
      const tl = setClipVolume(params.id, params.clipId, params.change);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
