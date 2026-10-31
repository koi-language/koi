/**
 * Object Registry: persist reusable story "object" / prop entities (a
 * motorbike, a freight train, a laptop) so the GUI drawer can list them and
 * prompts can reference them by @handle. This is the PROP analog of the
 * location registry: a scene = its characters + its location + its objects,
 * and each is a first-class reusable asset with its own identity anchor (a
 * character has a turnaround SHEET, a location an establishing PLATE, an
 * object its SHEET: one image with a three-quarter hero view (left half) and
 * a front elevation + side profile (right quarters), cropped into its views).
 *
 * Storage: ONE JSON file per object at `<project>/objects/<id>.json` (same model
 * as characters / locations / storyboards). Each file is shaped:
 *
 *   {
 *     id:           string,           // kebab-case slug == filename (no .json)
 *     name:         string,           // required, non-empty display name
 *     handle:       string|null,      // bare @mention WITHOUT the leading @
 *     description:  string,           // optional, what the object looks like
 *     category:     string|null,      // optional free text, e.g. 'vehicle', 'prop'
 *     tags:         string[],         // optional free tags
 *     photos:       string[],         // absolute file paths (POINTERS, never copied)
 *     views:        [{ id, label, path }], // views of the object, free user labels
 *     details:      [{ id, label, path }], // story-critical DETAILS: close-ups of a
 *                                          // part ("number 4417 painted on the boxcar
 *                                          // door") or INTERIOR views ("Interior: cabin
 *                                          // toward the windshield"); label = what it
 *                                          // shows; path null = empty slot to generate
 *     image:        string|null,      // DERIVED: first view with a path, else photos[0]
 *     sheet:        string|null,      // abs path of the generated object SHEET
 *     sheetCells:   [{x,y,w,h}]|null, // its normalized cells: threeQuarter, front, side
 *     model:        string|null,      // optional build_model3d model id (its 3D model)
 *     createdAt:    ISO string,
 *     updatedAt:    ISO string,
 *   }
 *
 * `details` are made by generate_object_detail (always with the sheet as
 * reference). They go to VIDEO takes (objectVideoImages / objectVideoDetails)
 * but never to the 3D modeling refs (objectImages / sceneObjectRefs stay on
 * the sheet crops).
 *
 * Cross-project: objects live under $HOME so they survive moving between
 * projects. We store absolute path pointers only: the bytes are never copied.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { docDir } from './doc-root.js';
/** Absolute path to the objects directory (`<project>/objects`). */
export function objectsDir() {
  return path.join(docDir('objects'));
}

/** Absolute path to a single object's JSON file. */
export function objectPathFor(id) {
  return path.join(objectsDir(), `${id}.json`);
}

function _ensureDir() {
  const dir = objectsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** An object's views (always an array). */
export function objectViews(obj) {
  return Array.isArray(obj?.views) ? obj.views : [];
}

/** View ids of the three crops of the object SHEET, in sheetCells order. */
export const SHEET_VIEW_IDS = ['threeQuarter', 'front', 'side'];

/** An object's details (always an array). */
export function objectDetails(obj) {
  return Array.isArray(obj?.details) ? obj.details : [];
}

/** The details of an object that have an image, as { label, path }, for a
 *  VIDEO take's `objects[]` entry so the prompt can name them. */
export function objectVideoDetails(obj) {
  return objectDetails(obj)
    .filter((d) => typeof d?.path === 'string' && d.path.trim())
    .map((d) => ({ label: typeof d.label === 'string' ? d.label : '', path: d.path.trim() }));
}

/**
 * Fill or add ONE detail: with a `detailId` already on the list its path is
 * replaced (a user label is kept, `label` only fills an empty one); with an
 * unknown `detailId` a detail with that id is appended; without one a new
 * detail with a fresh unique id is appended. Returns { details, detailId }.
 */
export function mergeObjectDetail(details, { detailId, label, path: p } = {}) {
  const list = Array.isArray(details) ? details : [];
  const lbl = typeof label === 'string' ? label.trim() : '';
  let id = typeof detailId === 'string' ? detailId.trim() : '';
  if (id && list.some((d) => d?.id === id)) {
    return {
      detailId: id,
      details: list.map((d) => (d?.id === id
        ? { ...d, label: (typeof d.label === 'string' && d.label.trim()) ? d.label : lbl, path: p }
        : d)),
    };
  }
  if (!id) {
    const taken = new Set(list.map((d) => d?.id));
    let n = 0;
    do { id = `d-${Date.now()}${n ? `-${n}` : ''}`; n += 1; } while (taken.has(id));
  }
  return { detailId: id, details: [...list, { id, label: lbl, path: p }] };
}

/** The reference images of an object for a VIDEO take. With a sheet, the
 *  sheet is ONE reference slot that carries its three views, so the result is
 *  [sheet, ...details with a path, ...extra views (not the sheet crops) with a
 *  path, ...photos]; without one, [...views, ...details, ...photos]. Deduped. */
export function objectVideoImages(obj) {
  const sheet = typeof obj?.sheet === 'string' ? obj.sheet.trim() : '';
  const details = objectDetails(obj).map((d) => d?.path);
  const photos = Array.isArray(obj?.photos) ? obj.photos : [];
  const list = sheet
    ? [sheet, ...details, ...objectViews(obj).filter((v) => !SHEET_VIEW_IDS.includes(v?.id)).map((v) => v?.path), ...photos]
    : [...objectViews(obj).map((v) => v?.path), ...details, ...photos];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim() || seen.has(p.trim())) continue;
    seen.add(p.trim());
    out.push(p.trim());
  }
  return out;
}

/** Every reference image of an object, deduped: its views with a path first
 *  (the hero first), then its input photos. */
export function objectImages(obj) {
  const seen = new Set();
  const out = [];
  for (const p of [...objectViews(obj).map((v) => v?.path), ...(Array.isArray(obj?.photos) ? obj.photos : [])]) {
    if (typeof p !== 'string' || !p.trim() || seen.has(p.trim())) continue;
    seen.add(p.trim());
    out.push(p.trim());
  }
  return out;
}

/** List every object entry, best-effort. Returns [] when the directory
 *  doesn't exist or a file is malformed. */
export function listObjects() {
  try {
    const dir = objectsDir();
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (raw && typeof raw === 'object' && typeof raw.id === 'string') out.push(raw);
      } catch { /* skip malformed file */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Read a single object by id. Returns null when missing / malformed. */
export function readObject(id) {
  try {
    const file = objectPathFor(path.basename(String(id || '')));
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.id === 'string') return raw;
    return null;
  } catch {
    return null;
  }
}

/** Write (or replace) an object entry as its own `<id>.json` file. Atomic
 *  write via tmp+rename. Returns the entry. */
export function saveObject(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
    throw new Error('saveObject: entry must be an object with a string id');
  }
  _ensureDir();
  const file = objectPathFor(entry.id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return entry;
}

/** Remove an object's JSON file by id. Best-effort removal of the matching
 *  media-library row too. Returns true when the file existed. */
export function deleteObject(id) {
  const file = objectPathFor(id);
  if (!fs.existsSync(file)) return false;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  (async () => {
    try {
      const { MediaLibrary } = await import('./media-library.js');
      await MediaLibrary.global().removeByPath(file);
    } catch { /* best-effort */ }
  })();
  return true;
}

/** Slugify an arbitrary string into a kebab-case id (same convention as the
 *  character/location registries). */
export function slugifyObjectId(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
