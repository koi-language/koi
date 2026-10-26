/**
 * scene3d_bake — internal (GUI export): turn ONE window of a live 3D shot
 * into an mp4, or one instant into a PNG (frame export). Timeline clips of 3D shots have no file (Blender plays them
 * live); exporting is the only moment one is needed.
 */

import { bakeWindow, bakeStill, cleanId } from './_store.js';

export default {
  type: 'scene3d_bake',
  intent: 'scene3d_bake',
  description: 'Internal (GUI export): bake a window [fromMs, toMs) of a 3D previz shot to an mp4, or with `still` ONE PNG at `fromMs` → { path }.',
  thinkingHint: 'Baking 3D shot',
  permission: 'read',
  hidden: true,

  schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string' },
      shotId: { type: 'string' },
      fromMs: { type: 'number' },
      toMs: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
      still: { type: 'boolean' },
    },
    required: ['sceneId', 'shotId', 'fromMs'],
  },

  async execute(params) {
    try {
      const from = Math.max(0, Math.round(Number(params.fromMs) || 0));
      const size = { width: Number(params.width) || 0, height: Number(params.height) || 0 };
      if (params.still === true) {
        return { success: true, path: await bakeStill(cleanId(params.sceneId), String(params.shotId), from, size) };
      }
      const to = Math.max(from + 50, Math.round(Number(params.toMs) || 0));
      const out = await bakeWindow(cleanId(params.sceneId), String(params.shotId), from, to, size);
      return { success: true, path: out };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
