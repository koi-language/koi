/**
 * Card models: a location card's `model` is THE 3D set of that place, an
 * object card's `model` is THE 3D model of that object. Every previz scene
 * takes them from the cards — the set of its storyboard scene's location, the
 * model of each prop that is a roster object (`prop.object`) — so a film is
 * always built from the cards' current models.
 *
 * `scene.modelRevs` ({ modelId: rev }) records the build of each model a scene
 * uses: a model rebuilt in place changes it, so the scene file changes, its
 * renders go stale and its live session restarts with the new model.
 */

import fs from 'fs';
import path from 'path';
import { listScenes, readScene, writeScene, storyboardPath, scenePath } from './_store.js';
import { readModel, writeModel, modelStamps } from './_models.js';
import { projectRoot } from '../../state/doc-root.js';
import { readObject } from '../../state/object-registry.js';
import { readLocation } from '../../state/location-registry.js';
import { readDocJson } from '../../state/project-paths.js';

function _storyScene(scene) {
  const ref = scene?.storyboard;
  if (!ref?.id) return { sb: null, sc: null };
  try {
    const sb = readDocJson(storyboardPath(ref.id));
    return { sb, sc: (sb.scenes || []).find((s) => s?.id === ref.sceneId) || null };
  } catch {
    return { sb: null, sc: null };
  }
}

const _usable = (id) => typeof id === 'string' && id.trim() && readModel(id.trim()) ? id.trim() : null;

/** The location cards a storyboard scene happens in (ids first, then roster names). */
function _locationIds(sb, sc) {
  const ids = [...(Array.isArray(sc?.locationIds) ? sc.locationIds : []), sc?.locationId];
  for (const l of sb?.locations || []) {
    if (l?.locationId && typeof sc?.location === 'string' && l.name
        && sc.location.toLowerCase().includes(String(l.name).toLowerCase())) ids.push(l.locationId);
  }
  return [...new Set(ids.filter((x) => typeof x === 'string' && x.trim()))];
}

function _props(scene) {
  return [...(scene?.set?.props || []), ...(scene?.props || [])].filter((p) => p && typeof p === 'object');
}

/** Puts the cards' models on [scene] (in place). True when something changed. */
export function applyCardModels(scene) {
  if (!scene || typeof scene !== 'object') return false;
  let changed = false;
  // A card's own 3D view shows that card's current model.
  const pv = scene.cardPreview;
  if (pv?.id) {
    const m = _usable((pv.kind === 'location' ? readLocation(pv.id) : readObject(pv.id))?.model);
    if (m) {
      if (pv.kind === 'location') {
        scene.set = scene.set || {};
        if (scene.set.model !== m) { scene.set.model = m; changed = true; }
      } else {
        const prop = (scene.set?.props || [])[0];
        if (prop && prop.model !== m) { prop.model = m; changed = true; }
      }
    }
  }
  if (pv?.id && _syncPhotoShots(scene)) changed = true;
  const { sb, sc } = _storyScene(scene);
  if (sb && sc) {
    for (const id of _locationIds(sb, sc)) {
      const m = _usable(readLocation(id)?.model);
      if (!m) continue;
      scene.set = scene.set || {};
      if (scene.set.model !== m) { scene.set.model = m; changed = true; }
      break;
    }
    const roster = Array.isArray(sb.objects) ? sb.objects : [];
    for (const p of _props(scene)) {
      if (typeof p.object !== 'string' || !p.object.trim()) continue;
      const entry = roster.find((o) => typeof o?.name === 'string' && o.name.toLowerCase() === p.object.toLowerCase());
      const m = entry?.objectId ? _usable(readObject(entry.objectId)?.model) : null;
      if (m && p.model !== m) { p.model = m; changed = true; }
    }
  }
  const stamps = modelStamps(scene);
  const revs = stamps ? Object.fromEntries(stamps) : undefined;
  if (JSON.stringify(revs ?? null) !== JSON.stringify(scene.modelRevs ?? null)) {
    if (revs) scene.modelRevs = revs; else delete scene.modelRevs;
    changed = true;
  }
  return changed;
}

// ── photo cameras ─────────────────────────────────────────────────────
// A card's 3D view carries one shot camera per reference photo of its model
// (`photo-<i>`, the camera the modeler estimated that photo was taken from):
// the view looks through it as through any shot camera, with its viewfinder,
// and moving it or changing its lens there corrects that photo's camera in
// the model (savePhotoCameras), which the next build reviews from.

const PHOTO_SHOT = /^photo-(\d+)$/;
const SHOT_MS = 4000;
const ASPECT_RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9, '2.39:1': 2.39 };

function _absImage(p) {
  return typeof p === 'string' && p ? (path.isAbsolute(p) ? p : path.join(projectRoot(), p)) : null;
}

/** [w, h] of a PNG / JPEG from its header, null when unreadable. */
export function imageSize(file) {
  return _imageSize(file);
}

function _imageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < n;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

/** The modeler's lens runs along the photo's long side; a shot camera's
 *  along its width. Factor from the first to the second. */
function _lensFactor(size) {
  const [w, h] = size || [16, 9];
  return w >= h ? 1 : h / w;
}

/** A shot's camera now: its first key, else its camera. */
function _shotCam(sh) {
  const k = Array.isArray(sh?.keyframes) && sh.keyframes.length ? sh.keyframes[0] : null;
  const c = sh?.camera || {};
  const lk = Array.isArray(c.lensKeys) && c.lensKeys.length ? c.lensKeys[0] : null;
  const lens = Number(k?.lens) || Number(lk?.lens ?? lk?.mm) || Number(c.lens) || 35;
  const position = k?.position || c.position;
  const target = k?.target || c.target;
  return Array.isArray(position) && Array.isArray(target) ? { position, target, lens } : null;
}

const _near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length >= 3 && b.length >= 3
  && a.slice(0, 3).every((v, i) => Math.abs(Number(v) - Number(b[i])) < 1e-3);

/** Puts the model's photo cameras on a card's scene. True when changed. */
function _syncPhotoShots(scene) {
  const model = readModel(scene.set?.model || scene.set?.props?.[0]?.model);
  const refs = (model?.references || []).map((r, i) => ({ r, i })).filter(({ r }) => r?.camera?.position && r?.camera?.target);
  let changed = false;
  const shots = Array.isArray(scene.shots) ? scene.shots : (scene.shots = []);
  const keep = new Set(refs.map(({ i }) => `photo-${i}`));
  for (let j = shots.length - 1; j >= 0; j--) {
    const m = PHOTO_SHOT.exec(shots[j]?.id || '');
    if (m && !keep.has(shots[j].id)) { shots.splice(j, 1); changed = true; }
  }
  let sized = null;
  for (const { r, i } of refs) {
    const size = _imageSize(_absImage(r.image));
    if (!sized && size) sized = size;
    const c = r.camera;
    const want = { position: c.position.slice(0, 3), target: c.target.slice(0, 3), lens: Math.round((Number(c.lens) || 35) * _lensFactor(size) * 1000) / 1000 };
    const id = `photo-${i}`;
    let sh = shots.find((x) => x?.id === id);
    if (!sh) {
      sh = { id, durationMs: SHOT_MS, move: { type: 'static' }, camera: {}, photo: r.image };
      shots.push(sh);
      changed = true;
    }
    if (sh.photo !== r.image) { sh.photo = r.image; changed = true; }
    const now = _shotCam(sh);
    if (!now || !_near(now.position, want.position) || !_near(now.target, want.target) || Math.abs(now.lens - want.lens) > 1e-3) {
      // Exactly the photo's camera: no lens kit, zoom or focus keys left over.
      sh.camera = { ...want };
      delete sh.keyframes;
      sh.move = { type: 'static' };
      changed = true;
    }
  }
  // The scene's frame takes the master photo's shape.
  if (sized) {
    const ratio = sized[0] / sized[1];
    const best = Object.entries(ASPECT_RATIOS).sort((a, b) => Math.abs(Math.log(a[1] / ratio)) - Math.abs(Math.log(b[1] / ratio)))[0][0];
    if (scene.aspect !== best) { scene.aspect = best; changed = true; }
  }
  // One after the other on the scene clock.
  let t = 0;
  for (const sh of shots) {
    const d = Number(sh.durationMs) || SHOT_MS;
    if (sh.startMs !== t) { sh.startMs = t; changed = true; }
    t += d;
  }
  if (scene.durationMs !== t) { scene.durationMs = t; changed = true; }
  return changed;
}

/**
 * The card scene's photo cameras, edited on the stage, written back as the
 * model's photo cameras ([shotIds]: only those, else every photo shot).
 */
export function savePhotoCameras(scene, shotIds = null) {
  if (!scene?.cardPreview?.id) return false;
  const model = readModel(scene.set?.model || scene.set?.props?.[0]?.model);
  if (!model || !Array.isArray(model.references)) return false;
  let changed = false;
  for (const sh of scene.shots || []) {
    const m = PHOTO_SHOT.exec(sh?.id || '');
    if (!m || (shotIds && !shotIds.has(sh.id))) continue;
    const r = model.references[Number(m[1])];
    const cam = _shotCam(sh);
    if (!r?.camera || !cam) continue;
    const lens = Math.round(cam.lens / _lensFactor(_imageSize(_absImage(r.image))) * 1000) / 1000;
    if (_near(r.camera.position, cam.position) && _near(r.camera.target, cam.target) && Math.abs((Number(r.camera.lens) || 35) - lens) < 1e-3) continue;
    r.camera = { ...r.camera, position: cam.position.slice(0, 3), target: cam.target.slice(0, 3), lens };
    changed = true;
  }
  if (changed) writeModel(model);
  return changed;
}

/** The scene that shows a card's 3D model on its own (the card's 3D view):
 *  created on first use, then kept on the card's current model. Null while
 *  the card has no model. */
export function cardPreviewScene(kind, cardId) {
  const card = kind === 'location' ? readLocation(cardId) : readObject(cardId);
  const modelId = _usable(card?.model);
  if (!modelId) return null;
  const id = `card-${kind}-${cardId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  let scene = readScene(id);
  const model = readModel(modelId);
  // An exterior (under the open sky) is shown in daylight on open ground; a
  // room as a room. An exterior shown as a warm-lit room came out dark brown,
  // nothing like its photo (19/11/2026).
  const openAir = kind === 'location' && (model?.openAir ?? (Array.isArray(model?.dims) && Math.max(model.dims[0], model.dims[1]) > 60));
  const setType = openAir ? 'exterior' : 'room';
  const light = kind === 'location' ? (openAir ? 'overcast' : 'interior_warm') : 'studio';
  let relit = false;
  if (scene && kind === 'location' && scene.set && (scene.set.type !== setType || scene.lighting !== light)) {
    scene.set = { ...scene.set, type: setType };
    scene.lighting = light;
    relit = true;
  }
  if (!scene) {
    const [w, d, h] = Array.isArray(model?.dims) ? model.dims : [4, 4, 2.6];
    scene = {
      id,
      name: card.name || cardId,
      cardPreview: { kind, id: cardId },
      aspect: '16:9',
      style: 'lit',
      set: kind === 'location'
        ? { type: setType, size: [Math.max(1, w), Math.max(1, d), Math.max(2, h)], model: modelId }
        : { type: 'empty', props: [{ id: 'object', shape: 'box', position: [0, 0], model: modelId }] },
      lighting: light,
      characters: [],
      actions: [],
      shots: [{ id: 'view', durationMs: 4000, startMs: 0, move: { type: 'static' },
        camera: { position: [Math.max(w, d) * 1.2, -Math.max(w, d) * 1.4, Math.max(h, 1) * 1.3],
          target: [0, 0, Math.max(h, 0.5) * 0.4], lens: 35 } }],
      durationMs: 4000,
    };
  }
  if (applyCardModels(scene) || relit || !fs.existsSync(scenePath(id))) writeScene(scene);
  return id;
}

/** Re-applies the cards' models to every scene; returns the ids rewritten. */
export function syncCardModels() {
  const out = [];
  for (const { id } of listScenes({ previews: true })) {
    const scene = readScene(id);
    if (scene && applyCardModels(scene)) {
      writeScene(scene);
      out.push(id);
    }
  }
  return out;
}
