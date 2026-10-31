/**
 * Location Registry — persist reusable "location" / set entities so the GUI
 * drawer can list them and prompts can reference them by @handle. This is the
 * SET/PLATÓ analog of the character registry: a scene = its characters + its
 * location, and both are first-class reusable assets with their own identity
 * anchor (a character has a turnaround SHEET; a location has an establishing
 * PLATE).
 *
 * Storage: ONE JSON file per location at `<project>/locations/<id>.json`
 * (same model as characters / storyboards / timelines). Each file is shaped:
 *
 *   {
 *     id:           string,           // kebab-case slug == filename (no .json)
 *     name:         string,           // required, non-empty display name
 *     handle:       string|null,      // bare @mention WITHOUT the leading @
 *     description:  string,           // optional, what the place looks like
 *     locationType: string,           // 'interior' | 'exterior' | 'mixed'
 *     timeOfDay:    string,           // optional, e.g. 'night', 'golden hour'
 *     palette:      string,           // optional color/mood note
 *     lighting:     string,           // optional default lighting of the set
 *     tags:         string[],         // optional free tags
 *     photos:       string[],         // absolute file paths (POINTERS, never copied)
 *     views:        [{ id, label, path }], // establishing views, free user labels
 *     plate:        string|null,      // DERIVED: first view with an image (the hero)
 *     createdAt:    ISO string,
 *     updatedAt:    ISO string,
 *   }
 *
 * Cross-project: locations live under $HOME so they survive moving between
 * projects. `photos[0]` (or the `plate`) is the hero image the GUI drawer
 * shows. We store absolute path pointers only — the bytes are never copied.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { docDir } from './doc-root.js';
/** Absolute path to the locations directory (`<project>/locations`). */
export function locationsDir() {
  return path.join(docDir('locations'));
}

/** Absolute path to a single location's JSON file. */
export function locationPathFor(id) {
  return path.join(locationsDir(), `${id}.json`);
}

function _ensureDir() {
  const dir = locationsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A location's establishing views. Docs older than `views` kept fixed
 *  plate / plateRear / plateLeft / plateRight fields: those become views.
 *  Mirrors `LocationLibrary.viewsOf` in the GUI. */
export function locationViews(loc) {
  if (Array.isArray(loc?.views)) return loc.views;
  const legacy = [['front', 'plate', ''], ['rear', 'plateRear', 'Rear'], ['left', 'plateLeft', 'Left'], ['right', 'plateRight', 'Right']];
  return legacy
    .filter(([, field]) => typeof loc?.[field] === 'string' && loc[field].trim())
    .map(([id, field, label]) => ({ id, label, path: loc[field].trim() }));
}

/** List every location entry, best-effort. Returns [] when the directory
 *  doesn't exist or a file is malformed (best-effort registry — we never fail
 *  a tool call because a file can't be parsed). */
export function listLocations() {
  try {
    const dir = locationsDir();
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

/** Read a single location by id. Returns null when missing / malformed. */
export function readLocation(id) {
  try {
    const file = locationPathFor(id);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.id === 'string') return raw;
    return null;
  } catch {
    return null;
  }
}

/** Write (or replace) a location entry as its own `<id>.json` file. Atomic
 *  write via tmp+rename so a crash mid-write doesn't corrupt the file.
 *  Returns the entry. */
export function saveLocation(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
    throw new Error('saveLocation: entry must be an object with a string id');
  }
  _ensureDir();
  const file = locationPathFor(entry.id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return entry;
}

/** Remove a location's JSON file by id. Best-effort removal of the matching
 *  media-library row too. Returns true when the file existed. */
export function deleteLocation(id) {
  const file = locationPathFor(id);
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
 *  character/storyboard registries). */
export function slugifyLocationId(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
