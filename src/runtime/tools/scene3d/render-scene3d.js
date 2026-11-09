/**
 * render_scene3d — (re)render the stills and, on request, the videos of a
 * scene. The shots themselves PLAY LIVE in the GUI (Blender interprets them);
 * files exist only for what needs one: the card poster + review sheet, and
 * the videos that feed generation (`video` cut, `depth`, `mask` passes).
 */

import { readScene, writeScene, renderScene, summarize, buildReview, cleanId, STYLES, PASSES } from './_store.js';
import { channel } from '../../io/channel.js';
import { refreshPrevizFlags } from './_previz-sync.js';
import { withPhotoCheck } from './_photo-check.js';

export default {
  type: 'render_scene3d',
  intent: 'render_scene3d',
  description:
    'Render (or re-use cached) previews of a 3D previz scene. `shots` limits to some shot ids; `style` overrides the ' +
    'scene look for this render ("clay" fast grey, "sketch" pencil lines like the storyboard panels, "lit" EEVEE lighting); ' +
    '`passes` adds structure videos for video-to-video generation: "depth" (white = near) and "mask" (each character a flat ' +
    'colour, in characters[] order: red, green, blue, yellow, magenta, cyan). By default only the STILLS render (poster + ' +
    '3-frame review sheet) — the shots play live in the timeline, no video is needed to watch them. `video: true` also ' +
    'renders the shot window as an mp4 (`cut`). Unchanged shots are never re-rendered unless `force`. Returns per-shot ' +
    '{ poster, sheet, cut?, depth?, mask? }. TO GENERATE THE REAL SHOT from a previz: render with `video: true`, pass the ' +
    'shot\'s `cut` as generate_video `referenceVideos` (routes to video-to-video) together with the character / location ' +
    'reference images and the shot\'s cinematic prompt.',
  thinkingHint: 'Rendering 3D previz',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Scene id' },
      shots: { type: 'array', items: { type: 'string' }, description: 'Shot ids (default: all)' },
      style: { type: 'string', enum: STYLES },
      passes: { type: 'array', items: { type: 'string', enum: PASSES } },
      force: { type: 'boolean' },
      video: { type: 'boolean', description: 'Also render the shot window as an mp4 (`cut`) — only to feed generation' },
    },
    required: ['id'],
  },

  async execute(params) {
    const scene = readScene(cleanId(params?.id));
    if (!scene) return { success: false, error: `render_scene3d: no scene "${params?.id}".` };
    if (params.style && params.style !== scene.style) {
      // A style override is a scene change: persist it so the timeline
      // and storyboard links show what was just rendered.
      scene.style = params.style;
      writeScene(scene);
    }
    try {
      const r = await renderScene(scene, {
        shotIds: Array.isArray(params.shots) && params.shots.length ? params.shots : null,
        passes: params.passes,
        force: params.force === true,
        video: params.video === true,
        onProgress: (_p, label) => label && channel.log('scene3d', label),
      });
      if (scene.storyboard?.id) refreshPrevizFlags(scene.storyboard.id);
      return withPhotoCheck(scene, {
        success: r.failed.length === 0,
        scene: summarize(scene),
        rendered: r.rendered,
        reused: r.reused,
        ...buildReview(scene, Array.isArray(params.shots) && params.shots.length ? params.shots : null),
        ...(r.failed.length ? { failed: r.failed } : {}),
      });
    } catch (e) {
      return { success: false, error: `render_scene3d: ${e.message}` };
    }
  },
};
