/**
 * scene3d_bake — internal (GUI export): turn ONE window of a live 3D shot
 * into an mp4, or one instant into a PNG (frame export). Timeline clips of 3D shots have no file (Blender plays them
 * live); exporting is the only moment one is needed.
 */

import { bakeWindow, bakeStill, cleanId } from './_store.js';
import { _join } from './prepare-scene3d-video.js';

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
      shots: { type: 'array', description: 'A continuous take: [{ id, startMs }] in order; each stretch through its own camera' },
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
      const sceneId = cleanId(params.sceneId);
      const shots = (Array.isArray(params.shots) ? params.shots : [])
        .filter((x) => x && typeof x.id === 'string')
        .map((x) => ({ id: x.id, startMs: Math.round(Number(x.startMs) || 0) }));
      const spans = [];
      for (const [j, sh] of shots.entries()) {
        const a = Math.max(from, j ? sh.startMs : from);
        const b = Math.min(to, j < shots.length - 1 ? shots[j + 1].startMs : to);
        if (b - a >= 1) spans.push([sh.id, a, b]);
      }
      if (spans.length > 1) {
        const parts = await Promise.all(spans.map(([id, a, b]) => bakeWindow(sceneId, id, a, b, size)));
        return { success: true, path: await _join(sceneId, parts) };
      }
      const out = await bakeWindow(sceneId, spans[0]?.[0] || String(params.shotId), from, to, size);
      return { success: true, path: out };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
