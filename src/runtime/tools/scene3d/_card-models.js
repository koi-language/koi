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
import { listScenes, readScene, writeScene, storyboardPath, scenePath } from './_store.js';
import { readModel, modelStamps } from './_models.js';
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

/** The scene that shows a card's 3D model on its own (the card's 3D view):
 *  created on first use, then kept on the card's current model. Null while
 *  the card has no model. */
export function cardPreviewScene(kind, cardId) {
  const card = kind === 'location' ? readLocation(cardId) : readObject(cardId);
  const modelId = _usable(card?.model);
  if (!modelId) return null;
  const id = `card-${kind}-${cardId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  let scene = readScene(id);
  if (!scene) {
    const model = readModel(modelId);
    const [w, d, h] = Array.isArray(model?.dims) ? model.dims : [4, 4, 2.6];
    scene = {
      id,
      name: card.name || cardId,
      cardPreview: { kind, id: cardId },
      aspect: '16:9',
      style: 'lit',
      set: kind === 'location'
        ? { type: 'room', size: [Math.max(1, w), Math.max(1, d), Math.max(2, h)], model: modelId }
        : { type: 'empty', props: [{ id: 'object', shape: 'box', position: [0, 0], model: modelId }] },
      lighting: kind === 'location' ? 'interior_warm' : 'studio',
      characters: [],
      actions: [],
      shots: [{ id: 'view', durationMs: 4000, startMs: 0, move: { type: 'static' },
        camera: { position: [Math.max(w, d) * 1.2, -Math.max(w, d) * 1.4, Math.max(h, 1) * 1.3],
          target: [0, 0, Math.max(h, 0.5) * 0.4], lens: 35 } }],
      durationMs: 4000,
    };
  }
  if (applyCardModels(scene) || !fs.existsSync(scenePath(id))) writeScene(scene);
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
