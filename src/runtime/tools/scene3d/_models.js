/**
 * 3D models ("models3d") modeled by the agent in Blender for the previz.
 *
 * One folder per model in <project>/models3d/<id>/:
 *   model.json   metadata (name, kind object|set, dims, links, rev)
 *   build.py     the modeling script it is built from (edited to iterate)
 *   refs.json    reference photos + the camera each was taken from
 *   model.glb    the exported model scenes import (prop.model / set.model)
 *   rev-<n>/     the review renders of build n (last two kept)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { docDir } from '../../state/doc-root.js';
import { readDocJson, stringifyDocJson } from '../../state/project-paths.js';
function _home() {
  return process.env.HOME || os.homedir();
}

export function modelsDir() {
  return path.join(docDir('models3d'));
}

export function cleanModelId(id) {
  return String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
}

export function modelDir(id) {
  return path.join(modelsDir(), cleanModelId(id));
}

export function newModelId(name) {
  const slug = String(name || 'model').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'model';
  return `${slug}-${Date.now().toString(36)}`;
}

export function readModel(id) {
  try {
    return readDocJson(path.join(modelDir(id), 'model.json'));
  } catch {
    return null;
  }
}

export function writeModel(model) {
  const file = path.join(modelDir(model.id), 'model.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, stringifyDocJson(model, file), 'utf8');
  fs.renameSync(tmp, file);
}

export function listModels() {
  let names = [];
  try { names = fs.readdirSync(modelsDir()); } catch { return []; }
  return names.map(readModel).filter((m) => m && fs.existsSync(path.join(modelDir(m.id), 'model.glb')));
}

/** What changes a render when a scene uses models: each one's build rev. */
export function modelStamps(scene) {
  const ids = new Set();
  if (scene?.set?.model) ids.add(scene.set.model);
  for (const p of [...(scene?.set?.props || []), ...(scene?.props || [])]) if (p?.model) ids.add(p.model);
  if (!ids.size) return null;
  return [...ids].sort().map((id) => [id, readModel(id)?.rev ?? null]);
}
