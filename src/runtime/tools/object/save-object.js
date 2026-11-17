/**
 * save_object: write a reusable story "object" / prop entity to
 * `<project>/objects/<id>.json` with structured args.
 *
 * An object is the PROP analog of a location: a persisted, reusable thing (a
 * motorbike, a freight train, a laptop…) the user references across
 * storyboards and video prompts. A scene = its characters + its location +
 * its objects; each is a first-class reusable identity anchor. An object's
 * anchor is its SHEET (one image: a three-quarter hero view on the left half,
 * a front elevation and a side profile on the right quarters), built by
 * generate_object_sheet and cropped into its views, that locks its look
 * across every clip. Extra views come from generate_object_view on demand.
 *
 * Behaviour mirrors save_location: new vs update decided from real content,
 * createdAt preserved, @handle registration on photos[0], MediaLibrary index.
 *
 * Photos are POINTERS: absolute file paths only; the bytes are never copied.
 * Permission / UX: app-managed artefact: pair with `show_result` to open it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { channel } from '../../io/channel.js';
import { saveObjectEntry } from '../../state/media-library.js';
import { slugifyObjectId } from '../../state/object-registry.js';

import { docDir } from '../../state/doc-root.js';
import { parseDocJson, stringifyDocJson } from '../../state/project-paths.js';
// Every object card gets its 3D model by default. When a card has its
// reference images (sheet views or photos) and no model yet, the tool result
// tells the agent to build it now, without asking (local work, free).
export function model3dNext(obj) {
  if (!obj || obj.model) return null;
  const views = (Array.isArray(obj.views) ? obj.views : []).filter((v) => v && v.path).map((v) => v.path);
  const photos = (Array.isArray(obj.photos) ? obj.photos : []).filter((p) => typeof p === 'string');
  if (!views.length && !photos.length) return null;
  return `This object has no 3D model yet. Build it NOW, by default, without asking the user ` +
    `(it is free local work): spawn the \`model-builder\` agent (or follow the \`3d-modeler\` skill) ` +
    `to model it with build_model3d, objectId "${obj.id}", kind "object", using as references its ` +
    `sheet views${photos.length ? ' and its photos' : ''}: ${[...views, ...photos].join(', ')}` +
    `${obj.size ? `; real size: ${typeof obj.size === 'string' ? obj.size : JSON.stringify(obj.size)}` : ''}. ` +
    `Run it in parallel with whatever else you are doing; the model attaches itself to the card.`;
}

const _KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;
// Detail ids: kebab-case or camelCase (letters, digits, hyphens).
const _DETAIL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function _err(msg) { return { success: false, error: `save_object: ${msg}` }; }

function _isStr(v) { return typeof v === 'string'; }
function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _validate(obj) {
  if (!_isObj(obj)) return 'object must be an object with at least { name }.';

  if (!_isStr(obj.name) || !obj.name.trim()) {
    return '"name" must be a non-empty string.';
  }
  if (obj.id !== undefined && (!_isStr(obj.id) || !_KEBAB_RE.test(obj.id))) {
    return `"id" (when provided) must be a kebab-case string (lowercase letters/digits/hyphens). Got ${JSON.stringify(obj.id)}.`;
  }
  for (const k of ['handle', 'description', 'category', 'image', 'model', 'sheet']) {
    if (obj[k] !== undefined && obj[k] !== null && !_isStr(obj[k])) {
      return `"${k}" (when provided) must be a string. Got ${typeof obj[k]}.`;
    }
  }
  if (_isStr(obj.handle) && obj.handle.trim() && obj.handle.trim().startsWith('@')) {
    return '"handle" must be the BARE mention WITHOUT the leading "@" (e.g. "moto", not "@moto").';
  }
  if (obj.tags !== undefined && obj.tags !== null) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => !_isStr(t))) {
      return '"tags" (when provided) must be an array of strings.';
    }
  }
  if (obj.photos !== undefined && obj.photos !== null) {
    if (!Array.isArray(obj.photos) || obj.photos.some((p) => !_isStr(p))) {
      return '"photos" (when provided) must be an array of absolute file paths (strings). photos[0] is the hero image.';
    }
  }
  if (obj.views !== undefined && obj.views !== null) {
    if (!Array.isArray(obj.views) || obj.views.some((v) => !_isObj(v) ||
        ['id', 'label', 'path'].some((k) => v[k] !== undefined && v[k] !== null && !_isStr(v[k])))) {
      return '"views" (when provided) must be an array of { id?, label?, path? } objects with string values.';
    }
  }
  if (obj.details !== undefined && obj.details !== null) {
    const detailErr = _validateDetails(obj.details);
    if (detailErr) return detailErr;
  }
  if (obj.sheetCells !== undefined && obj.sheetCells !== null) {
    if (!Array.isArray(obj.sheetCells) || obj.sheetCells.some((c) => !_isObj(c) ||
        ['x', 'y', 'w', 'h'].some((k) => !Number.isFinite(Number(c[k]))))) {
      return '"sheetCells" (when provided) must be an array of { x, y, w, h } normalized rects (threeQuarter, front, side).';
    }
  }
  const hero = _deriveImage(_normViews(obj.views), _normPhotos(obj.photos));
  if (_isStr(obj.image) && obj.image.trim() && obj.image.trim() !== hero) {
    return '"image" is derived (the first view with an image, else photos[0]). Change "views" / "photos" and omit "image".';
  }
  return null;
}

// details: [{ id?, label?, path? }]: ids unique kebab/camel strings (a
// missing one is assigned), label a string, path an absolute path or null
// (an empty slot waiting to be generated).
function _validateDetails(details) {
  const shape = '"details" (when provided) must be an array of { id, label, path } objects: id a unique kebab/camel string, label a string, path an absolute file path or null (empty slot).';
  if (!Array.isArray(details)) return shape;
  const seen = new Set();
  for (let i = 0; i < details.length; i++) {
    const d = details[i];
    if (!_isObj(d)) return `${shape} details[${i}] is not an object.`;
    if (d.id !== undefined && d.id !== null) {
      if (!_isStr(d.id) || !_DETAIL_ID_RE.test(d.id.trim())) {
        return `${shape} details[${i}].id ${JSON.stringify(d.id)} is not a kebab/camel string.`;
      }
      if (seen.has(d.id.trim())) return `${shape} details[${i}].id "${d.id.trim()}" is duplicated.`;
      seen.add(d.id.trim());
    }
    if (d.label !== undefined && d.label !== null && !_isStr(d.label)) {
      return `${shape} details[${i}].label must be a string.`;
    }
    if (d.path !== undefined && d.path !== null) {
      if (!_isStr(d.path)) return `${shape} details[${i}].path must be a string or null.`;
      if (d.path.trim() && !path.isAbsolute(d.path.trim())) {
        return `${shape} details[${i}].path ${JSON.stringify(d.path)} is not absolute.`;
      }
    }
  }
  return null;
}

function _normDetails(v) {
  if (!Array.isArray(v)) return [];
  const taken = new Set(v.map((d) => (_isObj(d) && _isStr(d.id) ? d.id.trim() : '')).filter(Boolean));
  const out = [];
  v.forEach((d, i) => {
    if (!_isObj(d)) return;
    let id = _isStr(d.id) ? d.id.trim() : '';
    if (!id) {
      id = `d-${Date.now()}-${i}`;
      while (taken.has(id)) id = `${id}-x`;
      taken.add(id);
    }
    out.push({
      id,
      label: _isStr(d.label) ? d.label.trim() : '',
      path: (_isStr(d.path) && d.path.trim()) ? d.path.trim() : null,
    });
  });
  return out;
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

function _deriveImage(views, photos) {
  return views.find((v) => v.path)?.path ?? photos[0] ?? null;
}

// Sheet cell geometry: normalized { x, y, w, h } rects (0..1 of the sheet) in
// the order threeQuarter, front, side. Kept only when well-formed.
function _normSheetCells(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const c of v) {
    if (!_isObj(c)) continue;
    const x = Number(c.x); const y = Number(c.y);
    const w = Number(c.w); const h = Number(c.h);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    out.push({ x, y, w, h });
  }
  return out.length ? out : null;
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

function _normalize(obj, existing) {
  const now = new Date().toISOString();
  const createdAt =
    (existing && _isStr(existing.createdAt) && existing.createdAt) ||
    (_isStr(obj.createdAt) && obj.createdAt) ||
    now;
  const views = _normViews(obj.views);
  const photos = _normPhotos(obj.photos);
  return {
    id: obj.id,
    name: obj.name.trim(),
    handle: _normHandle(obj.handle),
    description: _isStr(obj.description) ? obj.description : '',
    category: (_isStr(obj.category) && obj.category.trim()) ? obj.category.trim() : null,
    tags: _normTags(obj.tags),
    // INPUT reference photos that DEFINE the object (pointers only).
    photos,
    // The views of the object alone on a neutral background that lock its
    // look across every clip: a free list labelled by the user. A view
    // without a path is an empty slot waiting to be generated or assigned.
    views,
    // Story-critical DETAILS (close-ups of a part, or INTERIOR views labelled
    // "Interior: ..."), made by generate_object_detail with the sheet as
    // reference. A detail without a path is an empty slot to generate.
    details: _normDetails(obj.details),
    // Derived hero: the first view with an image, else photos[0].
    image: _deriveImage(views, photos),
    // The generated object SHEET (three panels: threeQuarter | front / side)
    // and its detected cells, in that order. Its crops are the first views.
    sheet: (_isStr(obj.sheet) && obj.sheet.trim()) ? obj.sheet.trim() : null,
    sheetCells: _normSheetCells(obj.sheetCells),
    // The object's 3D model (a build_model3d id), reused by the previz.
    // Omitted = keep the card's (a GUI edit must not drop the agent's model);
    // null clears it.
    model: obj.model === undefined
      ? (existing?.model ?? null)
      : ((_isStr(obj.model) && obj.model.trim()) ? obj.model.trim() : null),
    createdAt,
    updatedAt: now,
  };
}

export default {
  type: 'save_object',
  intent: 'save_object',
  description:
    'REQUIRED FIRST: activate the `objects` skill before creating or editing an object: it is the full contract (the object JSON schema and every field, and the views flow). ' +
    'Write a reusable story OBJECT / prop entity (a motorbike, a freight train, a laptop) to <project>/objects/<id>.json with STRUCTURED args (the object as an OBJECT, not a JSON string). ' +
    'A scene = its characters + its location + its objects; each is a first-class reusable identity anchor (a character has a turnaround sheet, a location an establishing plate, an object its SHEET: one image with a three-quarter hero view on the left half and a front elevation + side profile on the right quarters, cropped into its views). ' +
    'Use for BOTH creating new objects and updating existing ones: same call shape; the tool detects which and preserves createdAt across edits. ' +
    'Call shape: { object: { id?, name, handle?, description?, category?, tags?, photos?, views?, details?, sheet?, sheetCells?, model? } }. ' +
    'Required: object.name (non-empty). object.id is OPTIONAL: a kebab-case slug that MUST match the on-disk filename; when omitted it is derived from the name. ' +
    'object.handle is the BARE @mention WITHOUT the leading "@": when set together with at least one photo, the first photo is registered under `@handle`. ' +
    'object.description is a strong visual description of the object (shape, materials, colours, markings, condition). object.category is free text (e.g. "vehicle", "prop"); object.tags an optional string array. ' +
    'object.photos is an OPTIONAL array of ABSOLUTE file paths: the INPUT reference photos that DEFINE the object (pointers only, bytes never copied); photos[0] is the hero. ' +
    'object.views is the list of views, [{ id, label, path }]: labels are free text owned by the user, a view with path null is an empty slot. They are usually filled by generate_object_sheet (views threeQuarter, front, side = the sheet crops, placed first) and, for extra views on demand, generate_object_view, not by hand. ' +
    'object.details is the list of story-critical DETAILS, [{ id, label, path }]: close-ups of a specific part of the object (label = what it shows, e.g. "number 4417 painted on the boxcar door", "dented fuel tank, left side") or INTERIOR views (label starting with "Interior:", e.g. "Interior: cabin toward the windshield"); ids are unique kebab/camel strings, path is an absolute path or null (an empty slot waiting to be generated). They are filled by generate_object_detail (by detailId for an existing slot), not by hand. ' +
    'object.sheet is the absolute path of the generated object SHEET and object.sheetCells its detected normalized cell rects [{x,y,w,h}] in the order threeQuarter, front, side: both set by generate_object_sheet, not by hand. ' +
    'object.image is READ-ONLY, derived: the first view with an image, else photos[0]. object.model is an optional build_model3d model id (the object\'s 3D model) so the previz reuses it. ' +
    'Auto-set by the tool: updatedAt=now (UTC ISO), createdAt preserved, id slugged from name when omitted. ' +
    'Returns: { success:true, filePath, object:<normalized> } on success, or { success:false, error } with the exact invalid field on failure.',
  instructions:
    'save_object REPLACES write_file for <project>/objects/*.json: never hand-serialize the JSON. ' +
    'Update flow: read the existing JSON, mutate the parsed object, then save_object with the whole mutated object (include its id). ' +
    'After a CREATE, generate the object SHEET with ONE generate_object_sheet call (objectId set; it fills sheet, sheetCells and the threeQuarter / front / side views), READ the sheet to check its three panels, then generate the story-critical details with generate_object_detail (one per detail, see the `objects` skill), then call show_result with resourceType "file" and the returned filePath so the GUI opens the object tab.',
  thinkingHint: (action) => `Saving object ${action?.object?.id || action?.object?.name || ''}`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      object: {
        type: 'object',
        description: 'Full object: { id?, name, handle?, description?, category?, tags?, photos?, views?, details?, sheet?, sheetCells?, model? }. See description for required fields.',
      },
      summary: { type: 'string', description: 'OPTIONAL. One-line "what is this object": pinned to this session\'s creations ledger. Only attached on the FIRST save of a given object id. When omitted, the ledger falls back to the object\'s description.' },
    },
    required: ['object'],
  },

  async execute(action, agent) {
    const obj = action?.object;
    if (!_isObj(obj)) {
      return _err('"object" is required and must be an object. ' +
        'Call shape: { intent: "save_object", object: { name, description?, photos?, ... } }.');
    }

    if (obj.id === undefined || obj.id === null || (_isStr(obj.id) && !obj.id.trim())) {
      const slug = slugifyObjectId(obj.name);
      if (!slug) {
        return _err('could not derive an "id" from "name": pass an explicit kebab-case "id".');
      }
      obj.id = slug;
    }

    const validationError = _validate(obj);
    if (validationError) return _err(validationError);

    const home = process.env.HOME || os.homedir();
    const dir = path.join(docDir('objects'));
    let filePath = path.join(dir, `${obj.id}.json`);

    let existing = null;
    let existed = false;
    try {
      if (fs.existsSync(filePath)) {
        existed = true;
        const raw = fs.readFileSync(filePath, 'utf8');
        try { existing = parseDocJson(raw, filePath); } catch { /* corrupted prior file: overwrite */ }
      }
    } catch { /* ignore */ }

    const isUpdateIntent = _isStr(obj.createdAt) && !!obj.createdAt.trim();
    const _sameObject = existing != null && (
      isUpdateIntent ||
      (_isStr(existing.name) && _isStr(obj.name) && existing.name === obj.name)
    );
    let collisionRenamedFrom = null;
    if (existed && !_sameObject) {
      const baseId = obj.id;
      let n = 2;
      let candidateId = `${baseId}-${n}`;
      while (fs.existsSync(path.join(dir, `${candidateId}.json`)) && n < 1000) {
        n += 1;
        candidateId = `${baseId}-${n}`;
      }
      collisionRenamedFrom = baseId;
      obj.id = candidateId;
      filePath = path.join(dir, `${obj.id}.json`);
      existing = null;
      existed = false;
    }

    const normalized = _normalize(obj, existing);
    const serialized = stringifyDocJson(normalized, filePath) + '\n';

    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return _err(`failed to write ${filePath}: ${err.message}`);
    }

    try {
      await saveObjectEntry(filePath, normalized, agent?.llmProvider, {
        summary: typeof action.summary === 'string' ? action.summary : undefined,
      });
    } catch (err) {
      channel.log('save_object',
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

    channel.log('save_object',
      `${existed ? 'updated' : 'created'} ${filePath} ` +
      `(${normalized.photos.length} photo${normalized.photos.length === 1 ? '' : 's'}` +
      `, ${normalized.views.filter((v) => v.path).length} view(s)` +
      `, ${normalized.details.filter((d) => d.path).length}/${normalized.details.length} detail(s)` +
      `${normalized.handle ? `, @${normalized.handle}` : ''}` +
      `${normalized.model ? `, model ${normalized.model}` : ''})` +
      `${collisionRenamedFrom ? ` [id "${collisionRenamedFrom}" was taken → saved as "${normalized.id}"]` : ''}.`);

    // The 3D previz of every storyboard showing this object must follow its
    // new views / model.
    let previz3d = [];
    try {
      const { previzForObject } = await import('../scene3d/_previz-sync.js');
      previz3d = previzForObject(normalized.id);
    } catch { /* advisory */ }
    // Its 3D model is the one every previz scene uses: a new / changed
    // model reaches them now.
    try {
      const { syncCardModels } = await import('../scene3d/_card-models.js');
      syncCardModels();
    } catch { /* best effort */ }
    const next = model3dNext(normalized);
    return {
      ...(previz3d.length ? { previz3d } : {}),
      success: true,
      filePath,
      object: normalized,
      ...(next ? { next } : {}),
      created: !existed,
      ...(collisionRenamedFrom
        ? { renamedFrom: collisionRenamedFrom,
            note: `The id "${collisionRenamedFrom}" already existed, so this NEW object was saved as "${normalized.id}" to avoid overwriting the existing one. Use this id from now on.` }
        : {}),
    };
  },
};
