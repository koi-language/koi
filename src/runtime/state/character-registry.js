/**
 * Character Registry — persist reusable "character" entities so the GUI
 * drawer can list them and prompts can reference them by @handle.
 *
 * Storage: ONE JSON file per character at `<project>/characters/<id>.json`
 * (same model as storyboards / timelines — NOT a single array file like
 * voices). Each file is shaped like:
 *
 *   {
 *     id:          string,            // kebab-case slug == filename (no .json)
 *     name:        string,            // required, non-empty display name
 *     handle:      string|null,       // bare @mention WITHOUT the leading @
 *     description: string,            // optional, may be ''
 *     backstory:   string,            // optional history, may be ''
 *     photos:      string[],          // absolute file paths (POINTERS, never copied)
 *     voiceId:     string|null,       // a voice-registry id ('voice-...') or a name
 *     createdAt:   ISO string,
 *     updatedAt:   ISO string,
 *   }
 *
 * Cross-project: characters live under $HOME so they survive moving
 * between projects. `photos[0]` is the hero image the GUI drawer shows.
 * We store absolute path pointers only — the bytes are never copied.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { docDir } from './doc-root.js';
/** Absolute path to the characters directory (`<project>/characters`). */
export function charactersDir() {
  return path.join(docDir('characters'));
}

/** Absolute path to a single character's JSON file. */
export function characterPathFor(id) {
  return path.join(charactersDir(), `${id}.json`);
}

function _ensureDir() {
  const dir = charactersDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** List every character entry, best-effort. Returns [] when the
 *  directory doesn't exist or a file is malformed (the registry is
 *  treated as best-effort — we never fail a tool call because a file
 *  can't be parsed). */
export function listCharacters() {
  try {
    const dir = charactersDir();
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

/** Read a single character by id. Returns null when missing / malformed. */
export function readCharacter(id) {
  try {
    const file = characterPathFor(id);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.id === 'string') return raw;
    return null;
  } catch {
    return null;
  }
}

/** Write (or replace) a character entry as its own `<id>.json` file.
 *  Atomic write via tmp+rename so a crash mid-write doesn't corrupt the
 *  file. Returns the entry. */
export function saveCharacter(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
    throw new Error('saveCharacter: entry must be an object with a string id');
  }
  _ensureDir();
  const file = characterPathFor(entry.id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return entry;
}

/** Remove a character's JSON file by id. Best-effort removal of the
 *  matching media-library row too. Returns true when the file existed. */
export function deleteCharacter(id) {
  const file = characterPathFor(id);
  if (!fs.existsSync(file)) return false;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  // Best-effort removal of the matching media-library row.
  (async () => {
    try {
      const { MediaLibrary } = await import('./media-library.js');
      await MediaLibrary.global().removeByPath(file);
    } catch { /* best-effort */ }
  })();
  return true;
}

/** Slugify an arbitrary string into a kebab-case id (matches the
 *  save-storyboard convention: lowercase, alnum runs collapsed to a
 *  single hyphen, trimmed of leading/trailing hyphens). */
export function slugifyCharacterId(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
