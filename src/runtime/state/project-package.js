/**
 * Project packages (`Mi peli.braxil/`): create one, and open one wherever it
 * now is. Documents store their paths RELATIVE to the package (see
 * state/project-paths.js), so a moved / copied package needs no rewrite and
 * `project.json` no longer records where the package lives (its place is
 * wherever the file is). Packages written before that still carry an
 * absolute `path`: opening one that moved rewrites the old root to the new
 * one in every JSON document and in the drawer's index once, then drops the
 * field.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { DOC_KINDS, PROJECT_EXT, isProjectPackage, projectRoot } from './doc-root.js';

export const PROJECT_FILE = 'project.json';
export const PROJECT_FORMAT = 'braxil-project';

const _require = createRequire(import.meta.url);
function _sqlite() {
  // Same resolution as _sqlite-vector-adapter.js (packaged builds extract it).
  if (typeof process.pkg !== 'undefined' && process.env.KOI_EXTRACTED_NODE_MODULES) {
    return _require(path.join(process.env.KOI_EXTRACTED_NODE_MODULES, 'better-sqlite3'));
  }
  return _require('better-sqlite3');
}

export function readProject(pkg) {
  try { return JSON.parse(fs.readFileSync(path.join(pkg, PROJECT_FILE), 'utf8')); } catch { return null; }
}

function _writeProject(pkg, proj) {
  const fp = path.join(pkg, PROJECT_FILE);
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(proj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, fp);
}

/** A free `<parent>/<name>.braxil` path ("Name 2.braxil" when taken). */
export function freePackagePath(parentDir, name) {
  const base = String(name || 'Project').replace(/[\\/:]+/g, '-').trim() || 'Project';
  let p = path.join(parentDir, `${base}${PROJECT_EXT}`);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(parentDir, `${base} ${n}${PROJECT_EXT}`);
  return p;
}

/** Create a project package at [pkg] (a path ending in .braxil). */
export function createProject(pkg, { name } = {}) {
  if (!isProjectPackage(pkg)) pkg = `${pkg}${PROJECT_EXT}`;
  fs.mkdirSync(pkg, { recursive: true });
  for (const k of DOC_KINDS) fs.mkdirSync(path.join(pkg, k), { recursive: true });
  const now = new Date().toISOString();
  const proj = readProject(pkg) || {
    format: PROJECT_FORMAT,
    version: 1,
    id: crypto.randomUUID(),
    name: name || path.basename(pkg, PROJECT_EXT),
    createdAt: now,
  };
  delete proj.path; // the package's place is wherever it is
  proj.updatedAt = now;
  _writeProject(pkg, proj);
  return pkg;
}

function* _jsonFiles(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* _jsonFiles(p);
    else if (/\.(json|jsonl)$/i.test(e.name)) yield p;
  }
}

/**
 * Rewrite [from] → [to] (path prefixes) in every JSON document of [pkg] and
 * in its drawer index. @returns {{ files: number, rows: number }}
 */
export function relocateProject(pkg, from, to) {
  const a = from.replace(/\/+$/, '') + '/';
  const b = to.replace(/\/+$/, '') + '/';
  let files = 0;
  for (const fp of _jsonFiles(pkg)) {
    let s;
    try {
      if (fs.statSync(fp).size > 50 * 1024 * 1024) continue;
      s = fs.readFileSync(fp, 'utf8');
    } catch { continue; }
    if (!s.includes(a)) continue;
    fs.writeFileSync(fp, s.split(a).join(b), 'utf8');
    files++;
  }
  let rows = 0;
  const dbFile = path.join(pkg, 'media-library', 'vector-cache', 'index.sqlite');
  if (fs.existsSync(dbFile)) {
    const Database = _sqlite();
    const db = new Database(dbFile);
    try {
      const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (has('media')) {
        rows = db.prepare(
          'UPDATE media SET file_path = replace(file_path, ?, ?), metadata_json = replace(metadata_json, ?, ?) '
          + 'WHERE instr(file_path, ?) > 0 OR instr(metadata_json, ?) > 0',
        ).run(a, b, a, b, a, a).changes;
      }
    } finally {
      db.close();
    }
  }
  return { files, rows };
}

/**
 * The session opened [root]: when it is a package, make sure it is one
 * (project.json) and that its documents point at where it is NOW.
 */
export function openProject(root = projectRoot()) {
  if (!isProjectPackage(root)) return null;
  const pkg = path.resolve(root);
  let proj = readProject(pkg);
  if (!proj) {
    createProject(pkg);
    return readProject(pkg);
  }
  // Legacy `path` (absolute documents from before relative storage): a
  // package that moved since gets its old absolute paths rewritten once.
  if ('path' in proj) {
    if (typeof proj.path === 'string' && proj.path && proj.path !== pkg) {
      const r = relocateProject(pkg, proj.path, pkg);
      process.stderr.write(`[project] moved from ${proj.path}: rewrote ${r.files} documents, ${r.rows} drawer rows\n`);
    }
    const { path: _legacy, ...rest } = proj;
    proj = { ...rest, updatedAt: new Date().toISOString() };
    _writeProject(pkg, proj);
  }
  return proj;
}
