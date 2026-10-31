/**
 * save_scene3d — create or fully replace a 3D previz scene, then render
 * every shot's preview with Blender (clay by default, ~1-3 s per shot).
 */

import { physicsReport } from './_physics.js';
import { normalizeScene, readScene, writeScene, renderScene, summarize, buildReview, cleanId } from './_store.js';
import { SCENE3D_SHAPE } from './_schema-doc.js';
import { stampSources, refreshPrevizFlags, previzDirective } from './_previz-sync.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'save_scene3d',
  intent: 'save_scene3d',
  description:
    'Create (or fully replace, when `scene.id` exists) a 3D PREVIZ scene: one shared set with characters and blocking, ' +
    'covered by N camera shots, rendered by Blender into animated previews. Every shot gets a proxy video; when the scene ' +
    'is linked to a storyboard (`storyboard:{id,sceneId}` + per-shot `storyboardShotId`) each storyboard card becomes that ' +
    'animated preview. Place it in an edit with add_scene3d_to_timeline. For small changes use update_scene3d instead. ' +
    SCENE3D_SHAPE +
    ' Returns { success, scene:{ id, path, durationMs, shots:[{ id, video, cut, poster }] }, failed? }.',
  thinkingHint: 'Building 3D scene',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      scene: { type: 'object', description: 'The full scene (see description for the shape).' },
      render: { type: 'boolean', description: 'Render previews now (default true).' },
    },
    required: ['scene'],
  },

  async execute(params) {
    const input = params?.scene;
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'save_scene3d: `scene` (object) is required.' };
    }
    let scene;
    try {
      const existing = input.id ? readScene(cleanId(input.id)) : null;
      scene = normalizeScene(input, existing);
    } catch (e) {
      return { success: false, error: `save_scene3d: ${e.message}` };
    }
    stampSources(scene);
    writeScene(scene);
    let failed = [];
    if (params.render !== false) {
      try {
        const r = await renderScene(scene, {
          onProgress: (_p, label) => label && channel.log('scene3d', label),
        });
        failed = r.failed;
      } catch (e) {
        return { success: false, error: `save_scene3d: scene saved but render failed: ${e.message}`, scene: summarize(scene) };
      }
    }
    const pv = scene.storyboard?.id ? previzDirective(refreshPrevizFlags(scene.storyboard.id)) : null;
    return {
      success: failed.length === 0,
      scene: summarize(scene),
      ...(failed.length ? { failed } : {}),
      ...(pv ? { previz3d: pv } : {}),
      ...buildReview(scene, null),
      ...physicsReport(scene),
    };
  },
};
