/**
 * export_scene3d_viewer — the live 3D viewer's payload for a scene: the
 * Blender world as .glb (set, props, characters + their whole animation) and
 * a meta JSON (every shot's camera sampled over its window, the cast).
 * Content-hashed, so re-opening an unchanged scene is instant.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readScene, renderDir, cleanId } from './_store.js';
import { runBuilder } from './_blender.js';
import { BUILD_SCENE_PY } from './_build-scene-py.js';

export default {
  type: 'export_scene3d_viewer',
  intent: 'export_scene3d_viewer',
  description: 'Internal (GUI live 3D viewer): export a 3D previz scene as glTF + camera/cast metadata. Returns { glb, meta }.',
  thinkingHint: 'Preparing 3D viewer',
  permission: 'read',

  schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Scene id' } },
    required: ['id'],
  },

  async execute(params) {
    const scene = readScene(cleanId(params?.id));
    if (!scene) return { success: false, error: `export_scene3d_viewer: no scene "${params?.id}".` };
    const hash = crypto.createHash('sha1')
      .update(JSON.stringify([BUILD_SCENE_PY.length, crypto.createHash('sha1').update(BUILD_SCENE_PY).digest('hex'),
        { ...scene, shots: scene.shots.map(({ preview, ...rest }) => rest), updatedAt: null }]))
      .digest('hex').slice(0, 12);
    const dir = renderDir(scene.id);
    fs.mkdirSync(dir, { recursive: true });
    const glb = path.join(dir, `viewer-${hash}.glb`);
    if (!fs.existsSync(glb) || !fs.existsSync(`${glb}.json`)) {
      const snap = path.join(dir, `.snapshot-viewer-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(snap, JSON.stringify(scene), 'utf8');
      try {
        await runBuilder(['--scene', snap, '--export-glb', `${glb}.part.glb`]);
        fs.renameSync(`${glb}.part.glb.json`, `${glb}.json`);
        fs.renameSync(`${glb}.part.glb`, glb);
      } catch (e) {
        return { success: false, error: `export_scene3d_viewer: ${e.message}` };
      } finally {
        fs.rmSync(snap, { force: true });
      }
      // Keep only the latest few exports.
      const old = fs.readdirSync(dir).filter((f) => /^viewer-[0-9a-f]{12}\.glb$/.test(f) && f !== path.basename(glb))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(2);
      for (const { f } of old) {
        fs.rmSync(path.join(dir, f), { force: true });
        fs.rmSync(path.join(dir, `${f}.json`), { force: true });
      }
    }
    return { success: true, glb, meta: JSON.parse(fs.readFileSync(`${glb}.json`, 'utf8')), storyboard: scene.storyboard || null };
  },
};
