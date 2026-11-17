/**
 * save_location — write a reusable "location" / set entity to
 * `<project>/locations/<id>.json` with structured args.
 *
 * A location is the SET/PLATÓ analog of a character: a persisted, reusable
 * place (a dining room, a warehouse, a beach…) the user references across
 * storyboards and video prompts. A scene = its characters + its location, and
 * both are first-class reusable identity anchors — a character has a turnaround
 * SHEET, a location has an establishing PLATE (a clean wide of the empty place,
 * built by generate_location_plate) that locks the world's look/palette/light
 * across every clip.
 *
 * Behaviour mirrors save_character: new vs update decided from real content,
 * createdAt preserved, @handle registration on photos[0], MediaLibrary index.
 *
 * Photos are POINTERS — absolute file paths only; the bytes are never copied.
 * Permission / UX: app-managed artefact — pair with `show_result` to open it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { channel } from '../../io/channel.js';
import { saveLocationEntry } from '../../state/media-library.js';
import { slugifyLocationId, locationViews } from '../../state/location-registry.js';

import { docDir } from '../../state/doc-root.js';
import { parseDocJson, stringifyDocJson } from '../../state/project-paths.js';
const _KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

function _err(msg) { return { success: false, error: `save_location: ${msg}` }; }

/** The order to build the set's 3D model, or null. A set with images and no model gets its
 *  3D model BY DEFAULT, never waiting for the user to press "Generate 3D" (it is free local
 *  work, and every previz in this place takes its model from the card). */
export function setModel3dNext(loc) {
  if (!loc || loc.model) return null;
  const views = (Array.isArray(loc.views) ? loc.views : []).filter((v) => v && v.path).map((v) => v.path);
  const photos = (Array.isArray(loc.photos) ? loc.photos : []).filter((p) => typeof p === 'string');
  if (!views.length && !photos.length) return null;
  return `This location has no 3D set yet. Build it NOW, by default, without asking the user ` +
    `(it is free local work): spawn the \`model-builder\` agent (or follow the \`3d-modeler\` skill) ` +
    `to model it with build_model3d, locationId "${loc.id}", kind "set", using as references its ` +
    `views${photos.length ? ' and its photos' : ''}: ${[...views, ...photos].join(', ')}. ` +
    `Run it in parallel with whatever else you are doing; the model attaches itself to the card.`;
}

function _isStr(v) { return typeof v === 'string'; }
function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _validate(loc) {
  if (!_isObj(loc)) return 'location must be an object with at least { name }.';

  if (!_isStr(loc.name) || !loc.name.trim()) {
    return '"name" must be a non-empty string.';
  }
  if (loc.id !== undefined && (!_isStr(loc.id) || !_KEBAB_RE.test(loc.id))) {
    return `"id" (when provided) must be a kebab-case string (lowercase letters/digits/hyphens). Got ${JSON.stringify(loc.id)}.`;
  }
  for (const k of ['handle', 'description', 'locationType', 'timeOfDay', 'palette', 'lighting', 'plate', 'plateRear', 'plateLeft', 'plateRight']) {
    if (loc[k] !== undefined && loc[k] !== null && !_isStr(loc[k])) {
      return `"${k}" (when provided) must be a string. Got ${typeof loc[k]}.`;
    }
  }
  if (_isStr(loc.handle) && loc.handle.trim() && loc.handle.trim().startsWith('@')) {
    return '"handle" must be the BARE mention WITHOUT the leading "@" (e.g. "casa", not "@casa").';
  }
  if (loc.tags !== undefined && loc.tags !== null) {
    if (!Array.isArray(loc.tags) || loc.tags.some((t) => !_isStr(t))) {
      return '"tags" (when provided) must be an array of strings.';
    }
  }
  if (loc.photos !== undefined) {
    if (!Array.isArray(loc.photos) || loc.photos.some((p) => !_isStr(p))) {
      return '"photos" (when provided) must be an array of absolute file paths (strings). photos[0] is the hero image.';
    }
  }
  if (loc.details !== undefined && loc.details !== null) {
    if (!Array.isArray(loc.details) || loc.details.some((p) => !_isStr(p))) {
      return '"details" (when provided) must be an array of absolute file paths (strings) — close-ups / detail shots of the place.';
    }
  }
  if (loc.views !== undefined && loc.views !== null) {
    if (!Array.isArray(loc.views) || loc.views.some((v) => !_isObj(v) ||
        ['id', 'label', 'path'].some((k) => v[k] !== undefined && v[k] !== null && !_isStr(v[k])))) {
      return '"views" (when provided) must be an array of { id?, label?, path? } objects with string values.';
    }
    const hero = _normViews(loc.views).find((v) => v.path)?.path ?? null;
    if (_isStr(loc.plate) && loc.plate.trim() && loc.plate.trim() !== hero) {
      return '"plate" is derived from "views" (the first view with an image). Change the path inside "views" and omit "plate".';
    }
  }
  if (loc.plateCells !== undefined && loc.plateCells !== null) {
    if (!Array.isArray(loc.plateCells) ||
        loc.plateCells.some((c) => !c || typeof c !== 'object' ||
          !['x', 'y', 'w', 'h'].every((k) => typeof c[k] === 'number'))) {
      return '"plateCells" (when provided) must be an array of { x, y, w, h } numbers (normalized 0..1 cell rects of the views sheet).';
    }
  }
  return null;
}

function _normPhotos(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const p of v) {
    if (!_isStr(p)) continue;
    const s = p.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _normViews(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  v.forEach((view, i) => {
    if (!_isObj(view)) return;
    let id = _isStr(view.id) ? view.id.trim() : '';
    if (!id || seen.has(id)) id = `v-${Date.now()}-${i}`;
    seen.add(id);
    out.push({
      id,
      label: _isStr(view.label) ? view.label.trim() : '',
      path: (_isStr(view.path) && view.path.trim()) ? view.path.trim() : null,
    });
  });
  return out;
}

function _normTags(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const t of v) {
    if (!_isStr(t)) continue;
    const s = t.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _normHandle(v) {
  if (!_isStr(v)) return null;
  let h = v.trim();
  if (h.startsWith('@')) h = h.slice(1);
  h = h.trim();
  return h.length > 0 ? h : null;
}

function _normalize(loc, existing) {
  const now = new Date().toISOString();
  const createdAt =
    (existing && _isStr(existing.createdAt) && existing.createdAt) ||
    (_isStr(loc.createdAt) && loc.createdAt) ||
    now;
  const views = _normViews(locationViews(loc));
  return {
    id: loc.id,
    name: loc.name.trim(),
    handle: _normHandle(loc.handle),
    description: _isStr(loc.description) ? loc.description : '',
    // Structured attributes surfaced as controls in the visor (all optional).
    locationType: (_isStr(loc.locationType) && loc.locationType.trim()) ? loc.locationType.trim() : null,
    timeOfDay: (_isStr(loc.timeOfDay) && loc.timeOfDay.trim()) ? loc.timeOfDay.trim() : null,
    palette: (_isStr(loc.palette) && loc.palette.trim()) ? loc.palette.trim() : null,
    lighting: (_isStr(loc.lighting) && loc.lighting.trim()) ? loc.lighting.trim() : null,
    tags: _normTags(loc.tags),
    photos: _normPhotos(loc.photos),
    // The establishing views of the empty location that lock the world's look
    // across every clip: a free list, labelled by the user. A view without a
    // path is an empty slot waiting to be generated or assigned. `plate` is
    // derived (the first view with an image) so hero readers need not know.
    views,
    plate: views.find((v) => v.path)?.path ?? null,
    // DETAIL shots: close-ups of the place (a sign, a scale, a corner) the user
    // uploaded or assigned. Pointers only, like `photos`. Distinct from
    // `photos`, which are the INPUT reference photos that DEFINE the location.
    details: _normPhotos(loc.details),
    // Legacy: single-sheet cell rects / floor-plan layout (no longer produced;
    // preserved so old docs round-trip without dropping the fields).
    plateCells: Array.isArray(loc.plateCells) ? loc.plateCells : null,
    layout: (loc.layout && typeof loc.layout === 'object' && !Array.isArray(loc.layout)) ? loc.layout : null,
    // The set's 3D model (a build_model3d id): every previz scene in this
    // place uses it.
    // Omitted = keep the card's (a GUI edit must not drop the agent's model);
    // null clears it.
    model: loc.model === undefined
      ? (existing?.model ?? null)
      : ((_isStr(loc.model) && loc.model.trim()) ? loc.model.trim() : null),
    createdAt,
    updatedAt: now,
  };
}

export default {
  type: 'save_location',
  intent: 'save_location',
  description:
    'REQUIRED FIRST: activate the `locations` skill before creating or editing a location — it is the full contract (the location JSON schema and every field, and the establishing-plate flow). ' +
    'Write a reusable LOCATION / set entity to <project>/locations/<id>.json with STRUCTURED args (the location as an OBJECT, not a JSON string). ' +
    'A location is a persisted, reusable place (a dining room, a warehouse, a beach…) the user references across storyboards and video prompts. A scene = its characters + its location; both are first-class reusable identity anchors (a character has a turnaround sheet; a location has an establishing PLATE). ' +
    'Use for BOTH creating new locations and updating existing ones — same call shape; the tool detects which and preserves createdAt across edits. ' +
    'Call shape: { location: { id?, name, handle?, description?, locationType?, timeOfDay?, palette?, lighting?, tags?, photos?, views?, model? } }. ' +
    'location.locationType is a short canonical string ("interior" / "exterior" / "mixed"); location.timeOfDay (e.g. "night", "golden hour"), location.palette (color/mood note) and location.lighting (the set\'s default light) are optional strings; location.tags an optional string array. ' +
    'Required: location.name (non-empty). location.id is OPTIONAL — a kebab-case slug that MUST match the on-disk filename; when omitted it is derived from the name. ' +
    'location.handle is the BARE @mention WITHOUT the leading "@" (e.g. "comedor") — when set together with at least one photo, the first photo is registered under `@handle` so `@handle` resolves in prompts. ' +
    'location.description is what the place looks like. location.photos is an OPTIONAL array of ABSOLUTE file paths — POINTERS only, bytes never copied; photos[0] is the hero image. ' +
    'location.views is the list of establishing views, [{ id, label, path }]: labels are free text owned by the user, and there are no fixed angles. They are usually added by generate_location_plate, not by hand. location.plate is READ-ONLY, derived from the first view with an image. ' +
    'location.model is the set\'s 3D model (a build_model3d id, normally attached by build_model3d with locationId): every 3D previz scene in this place uses it. ' +
    'location.details is an OPTIONAL array of ABSOLUTE paths to close-up / detail shots of the place (pointers only) — distinct from location.photos, which are the INPUT reference photos that DEFINE the location. ' +
    'Auto-set by the tool: updatedAt=now (UTC ISO), createdAt preserved, id slugged from name when omitted. ' +
    'Returns: { success:true, filePath, location:<normalized> } on success, or { success:false, error } with the exact invalid field on failure.',
  instructions:
    'save_location REPLACES write_file for <project>/locations/*.json — never hand-serialize the JSON. ' +
    'Update flow: read the existing JSON, mutate the parsed object, then save_location with the whole mutated object (include its id). ' +
    'After a CREATE, call show_result with resourceType "file" and the returned filePath so the GUI opens the location tab.',
  thinkingHint: (action) => `Saving location ${action?.location?.id || action?.location?.name || ''}`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      location: {
        type: 'object',
        description: 'Full location object: { id?, name, handle?, description?, locationType?, timeOfDay?, palette?, lighting?, tags?, photos?, views? }. See description for required fields.',
      },
      summary: { type: 'string', description: 'OPTIONAL. One-line "what is this location" — pinned to this session\'s creations ledger. Only attached on the FIRST save of a given location id. When omitted, the ledger falls back to the location\'s description.' },
    },
    required: ['location'],
  },

  async execute(action, agent) {
    const loc = action?.location;
    if (!_isObj(loc)) {
      return _err('"location" is required and must be an object. ' +
        'Call shape: { intent: "save_location", location: { name, description?, photos?, ... } }.');
    }

    if (loc.id === undefined || loc.id === null || (_isStr(loc.id) && !loc.id.trim())) {
      const slug = slugifyLocationId(loc.name);
      if (!slug) {
        return _err('could not derive an "id" from "name" — pass an explicit kebab-case "id".');
      }
      loc.id = slug;
    }

    const validationError = _validate(loc);
    if (validationError) return _err(validationError);

    const home = process.env.HOME || os.homedir();
    const dir = path.join(docDir('locations'));
    let filePath = path.join(dir, `${loc.id}.json`);

    let existing = null;
    let existed = false;
    try {
      if (fs.existsSync(filePath)) {
        existed = true;
        const raw = fs.readFileSync(filePath, 'utf8');
        try { existing = parseDocJson(raw, filePath); } catch { /* corrupted prior file — overwrite */ }
      }
    } catch { /* ignore */ }

    const isUpdateIntent = _isStr(loc.createdAt) && !!loc.createdAt.trim();
    const _sameLocation = existing != null && (
      isUpdateIntent ||
      (_isStr(existing.name) && _isStr(loc.name) && existing.name === loc.name)
    );
    let collisionRenamedFrom = null;
    if (existed && !_sameLocation) {
      const baseId = loc.id;
      let n = 2;
      let candidateId = `${baseId}-${n}`;
      while (fs.existsSync(path.join(dir, `${candidateId}.json`)) && n < 1000) {
        n += 1;
        candidateId = `${baseId}-${n}`;
      }
      collisionRenamedFrom = baseId;
      loc.id = candidateId;
      filePath = path.join(dir, `${loc.id}.json`);
      existing = null;
      existed = false;
    }

    const normalized = _normalize(loc, existing);
    const serialized = stringifyDocJson(normalized, filePath) + '\n';

    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return _err(`failed to write ${filePath}: ${err.message}`);
    }

    let saved = null;
    try {
      saved = await saveLocationEntry(filePath, normalized, agent?.llmProvider, {
        summary: typeof action.summary === 'string' ? action.summary : undefined,
      });
    } catch (err) {
      channel.log('save_location',
        `MediaLibrary index failed for ${filePath} (${err.message}); file still written.`);
    }

    if (normalized.handle && normalized.photos.length > 0) {
      try {
        const { MediaLibrary } = await import('../../state/media-library.js');
        const lib = MediaLibrary.global();
        const heroPath = normalized.photos[0];
        const row = await lib.getByPath(heroPath);
        if (row?.id) {
          await lib.setMention(row.id, normalized.handle);
        }
      } catch { /* best-effort */ }
    }

    channel.log('save_location',
      `${existed ? 'updated' : 'created'} ${filePath} ` +
      `(${normalized.photos.length} photo${normalized.photos.length === 1 ? '' : 's'}` +
      `${normalized.handle ? `, @${normalized.handle}` : ''}` +
      `${normalized.plate ? ', plate' : ''})` +
      `${collisionRenamedFrom ? ` [id "${collisionRenamedFrom}" was taken → saved as "${normalized.id}"]` : ''}.`);

    // The 3D previz of every storyboard using this place must follow its
    // new plate / photos.
    let previz3d = [];
    try {
      const { previzForLocation } = await import('../scene3d/_previz-sync.js');
      previz3d = previzForLocation(normalized.id);
    } catch { /* advisory */ }
    // Its 3D model is the one every previz scene uses: a new / changed
    // model reaches them now.
    try {
      const { syncCardModels } = await import('../scene3d/_card-models.js');
      syncCardModels();
    } catch { /* best effort */ }
    return {
      ...(previz3d.length ? { previz3d } : {}),
      success: true,
      filePath,
      location: normalized,
      ...(setModel3dNext(normalized) ? { next: setModel3dNext(normalized) } : {}),
      created: !existed,
      ...(collisionRenamedFrom
        ? { renamedFrom: collisionRenamedFrom,
            note: `The id "${collisionRenamedFrom}" already existed, so this NEW location was saved as "${normalized.id}" to avoid overwriting the existing one. Use this id from now on.` }
        : {}),
    };
  },
};
