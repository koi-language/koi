/**
 * Where the user's DOCUMENTS live: inside the project, never in the global
 * ~/.koi (which keeps only config, credentials, plugins, skills, agents,
 * installs).
 *
 * A project is a `.braxil` package folder (`Mi peli.braxil/`): its documents
 * sit at its top level, one folder per kind (images/, videos/, storyboards/,
 * scenes3d/, timelines/, characters/…).
 *
 * A session working in any other folder (a code repo, a plain directory)
 * keeps them under that folder's own `.koi/`, next to its sessions.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const PROJECT_EXT = '.braxil';

/** The kinds of document a project holds, one folder each. */
export const DOC_KINDS = [
  'images', 'videos', 'audio', 'storyboards', 'scenes3d', 'timelines', 'characters', 'locations',
  'objects', 'models3d', 'voices', 'panels', 'texts', 'recordings', 'media-library', 'projects',
];

/** The folder the session works in. */
export function projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

export function isProjectPackage(dir) {
  return typeof dir === 'string' && dir.replace(/[\\/]+$/, '').toLowerCase().endsWith(PROJECT_EXT);
}

/** The folder that holds every document kind for [root] (default: this session's). */
export function documentsRoot(root = projectRoot()) {
  const r = path.resolve(root);
  return isProjectPackage(r) ? r : path.join(r, '.koi');
}

/** `<documents>/<kind>`; not created. */
export function docDir(kind, root) {
  return path.join(documentsRoot(root), kind);
}

/** `<documents>/<kind>`, created when missing. */
export function ensureDocDir(kind, root) {
  const d = docDir(kind, root);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Where documents lived before projects owned them (migration only). */
export function legacyDocDir(kind) {
  return path.join(os.homedir(), '.koi', kind);
}
