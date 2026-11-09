/**
 * build_model3d — model one object or one set in Blender from a script the
 * agent writes, export it as .glb for the previz, and hand back the review
 * (turnaround + the model seen from each reference photo's camera next to
 * and over the photo) so the agent can correct it until it matches.
 */

import fs from 'fs';
import path from 'path';
import { runBuilder, modelerScriptPath } from './_blender.js';
import { readModel, writeModel, modelDir, newModelId, cleanModelId } from './_models.js';
import { channel } from '../../io/channel.js';
import { stringifyDocJson } from '../../state/project-paths.js';

/** Makes [model] THE model of its location / object card, then brings every
 *  previz scene up to date with the cards. */
async function attachToCards(model) {
  const out = [];
  try {
    if (model.kind === 'set' && model.locationId) {
      const { readLocation, saveLocation } = await import('../../state/location-registry.js');
      const loc = readLocation(model.locationId);
      if (loc) {
        if (loc.model !== model.id) saveLocation({ ...loc, model: model.id, updatedAt: new Date().toISOString() });
        out.push(`location ${loc.id}`);
      }
    }
    if (model.kind !== 'set' && model.objectId) {
      const { readObject, saveObject } = await import('../../state/object-registry.js');
      const obj = readObject(model.objectId);
      if (obj) {
        if (obj.model !== model.id) saveObject({ ...obj, model: model.id, updatedAt: new Date().toISOString() });
        out.push(`object ${obj.id}`);
      }
    }
    const { syncCardModels } = await import('./_card-models.js');
    syncCardModels();
  } catch { /* best effort: the model itself is saved */ }
  return out;
}

export default {
  type: 'build_model3d',
  intent: 'build_model3d',
  description:
    'Model ONE object (a car, a machine, a piece of furniture…) or ONE set (a street, a room, a circuit) in Blender for ' +
    'the 3D previz, from a Blender Python script YOU write (activate the `3d-modeler` skill first: conventions, helpers, ' +
    'craft and the review loop). Pass the script as `scriptFile` (a .py you wrote; edit it and call again to iterate) or ' +
    'inline `script`. `references`: the photos the model must match, each with the camera you estimate it was taken from ' +
    '({ image, camera:{ position:[x,y,z], target:[x,y,z], lens:mm } } in the model\'s frame) — the review renders the model ' +
    'from that camera next to the photo and blended over it. Re-call with the same `id` to rebuild. Returns { model:{ id, ' +
    'path, dims, triangles }, review } with the review images attached. Use it in a scene with prop `model: <id>` or ' +
    'set `model: <id>`.',
  thinkingHint: 'Modeling in 3D',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Existing model id to rebuild (omit to create).' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['object', 'set'] },
      description: { type: 'string', description: 'What it is (one line).' },
      scriptFile: { type: 'string', description: 'Absolute path of the Blender Python modeling script.' },
      script: { type: 'string', description: 'The script inline (instead of scriptFile).' },
      references: {
        type: 'array',
        items: { type: 'object' },
        description: '[{ image: <abs path>, camera: { position, target, lens, roll? } }]',
      },
      locationId: { type: 'string', description: 'Saved location this set is (kind "set"): the model becomes THE 3D set of that location card, and every previz scene in that place uses it.' },
      objectId: { type: 'string', description: 'Saved object card this object is (kind "object"): the model becomes THE 3D model of that card, and every previz prop that is this object uses it.' },
      characterId: { type: 'string', description: 'Saved character this belongs to, if any.' },
    },
  },

  async execute(params = {}) {
    const existing = params.id ? readModel(cleanModelId(params.id)) : null;
    if (params.id && !existing) return { success: false, error: `build_model3d: no model "${params.id}".` };
    let src = typeof params.script === 'string' && params.script.trim() ? params.script : null;
    if (!src && params.scriptFile) {
      try { src = fs.readFileSync(params.scriptFile, 'utf8'); } catch (e) {
        return { success: false, error: `build_model3d: cannot read scriptFile: ${e.message}` };
      }
    }
    if (!src && existing) {
      try { src = fs.readFileSync(path.join(modelDir(existing.id), 'build.py'), 'utf8'); } catch { /* none */ }
    }
    if (!src) return { success: false, error: 'build_model3d: pass `scriptFile` or `script`.' };

    const refs = Array.isArray(params.references) ? params.references : existing?.references || [];
    const missing = refs.filter((r) => !r?.image || !fs.existsSync(r.image)).map((r) => r?.image);
    if (missing.length) return { success: false, error: `build_model3d: reference images not found: ${missing.join(', ')}` };

    const id = existing?.id || newModelId(params.name);
    const dir = modelDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const rev = (existing?.rev || 0) + 1;
    const stage = path.join(dir, `rev-${rev}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const script = path.join(stage, 'build.py');
    fs.writeFileSync(script, src, 'utf8');
    const refsFile = path.join(stage, 'refs.json');
    fs.writeFileSync(refsFile, JSON.stringify(refs), 'utf8');
    const kind = params.kind === 'set' || (!params.kind && existing?.kind === 'set') ? 'set' : 'object';

    try {
      await runBuilder(['--script', script, '--out', stage, '--kind', kind, '--refs', refsFile], {
        script: modelerScriptPath(),
        timeoutMs: 10 * 60 * 1000,
        onProgress: (_p, label) => label && channel.log('model3d', label),
      });
    } catch (e) {
      // The previous good build stays the model; this rev is discarded.
      fs.rmSync(stage, { recursive: true, force: true });
      return { success: false, error: `build_model3d: ${e.message}`, hint: 'Fix the script (the traceback points at its lines) and call again.' };
    }

    let stats = {};
    try { stats = JSON.parse(fs.readFileSync(path.join(stage, 'stats.json'), 'utf8')); } catch { /* */ }
    for (const f of ['model.glb', 'build.py', 'refs.json']) {
      // Blender read the stage's refs.json (absolute paths); the model's own
      // copy is a project document: paths stored project-relative.
      if (f === 'refs.json') fs.writeFileSync(path.join(dir, `${f}.tmp`), stringifyDocJson(refs, path.join(dir, f), 0), 'utf8');
      else fs.copyFileSync(path.join(stage, f), path.join(dir, `${f}.tmp`));
      fs.renameSync(path.join(dir, `${f}.tmp`), path.join(dir, f));
    }
    for (const d of fs.readdirSync(dir)) {
      const m = /^rev-(\d+)$/.exec(d);
      if (m && Number(m[1]) < rev - 1) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    }

    const now = new Date().toISOString();
    const model = {
      ...(existing || {}),
      id,
      name: params.name || existing?.name || id,
      kind,
      description: params.description ?? existing?.description,
      locationId: params.locationId ?? existing?.locationId,
      objectId: params.objectId ?? existing?.objectId,
      characterId: params.characterId ?? existing?.characterId,
      dims: stats.dims,
      triangles: stats.triangles,
      materials: stats.materials,
      references: refs,
      rev,
      // The 2×2 review views of this build: the cards' 3D preview.
      turnaround: stats.review?.turnaround || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    writeModel(model);
    // THE model of its card(s), and every scene follows the card.
    const attached = await attachToCards(model);


    const review = stats.review || {};
    const images = [review.turnaround, ...(review.references || []).map((r) => r.compare)].filter(Boolean);
    return {
      success: true,
      model: {
        id, name: model.name, kind, path: path.join(dir, 'model.glb'), script: path.join(dir, 'build.py'),
        dims: stats.dims, triangles: stats.triangles, objects: stats.objects, materials: stats.materials,
        recentredBy: stats.recentredBy, rev,
      },
      ...(attached.length ? { attachedTo: attached } : {}),
      review: {
        turnaround: review.turnaround,
        references: (review.references || []).map((r) => ({ index: r.index, photo: r.image, compare: r.compare })),
      },
      _reviewImages: images,
      reviewNote: 'LOOK at every attached image. Turnaround: front / side / back / three-quarter (sets: three corners + top). '
        + 'Each reference image is [photo | model from the photo camera | both blended]: in the blend the model must sit ON '
        + 'the photo, outline over outline. Check proportions first (overall length : width : height, where each part '
        + 'starts and ends, sizes of parts relative to each other), then that every object reads as what it is, then '
        + 'colours. If the blend is off everywhere the same way, fix the reference camera; if one part is off, fix the '
        + 'model. Edit the script and call build_model3d again with this id until it matches.',
    };
  },
};
