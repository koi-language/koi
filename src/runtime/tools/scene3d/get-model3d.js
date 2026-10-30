/**
 * get_model3d — one model built with build_model3d (with its script and
 * last review), or the list of them, so a model is reused across scenes
 * instead of being modeled again.
 */

import fs from 'fs';
import path from 'path';
import { readModel, listModels, modelDir, cleanModelId } from './_models.js';

export default {
  type: 'get_model3d',
  intent: 'get_model3d',
  description:
    'Read a 3D model made with build_model3d by `id` (metadata, glb path, script path, last review images), or omit ' +
    '`id` to list the models (optionally only those of a `locationId` / `characterId`). Check here BEFORE modeling ' +
    'something: a model already built is reused with prop `model: <id>` / set `model: <id>`.',
  thinkingHint: 'Looking up 3D models',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      locationId: { type: 'string' },
      characterId: { type: 'string' },
    },
  },

  async execute(params = {}) {
    const brief = (m) => ({
      id: m.id, name: m.name, kind: m.kind, description: m.description, dims: m.dims,
      locationId: m.locationId, characterId: m.characterId, updatedAt: m.updatedAt,
    });
    if (params.id) {
      const m = readModel(cleanModelId(params.id));
      if (!m) return { success: false, error: `get_model3d: no model "${params.id}".` };
      const dir = modelDir(m.id);
      const revDir = path.join(dir, `rev-${m.rev}`, 'review');
      const review = fs.existsSync(revDir)
        ? fs.readdirSync(revDir).filter((f) => f === 'turnaround.png' || /^ref-\d+\.png$/.test(f)).map((f) => path.join(revDir, f))
        : [];
      return {
        success: true,
        model: { ...m, path: path.join(dir, 'model.glb'), script: path.join(dir, 'build.py') },
        review,
      };
    }
    const all = listModels()
      .filter((m) => !params.locationId || m.locationId === params.locationId)
      .filter((m) => !params.characterId || m.characterId === params.characterId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { success: true, models: all.map(brief) };
  },
};
