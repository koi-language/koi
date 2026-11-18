/**
 * iCloud conflict recovery for `.braxil` project packages.
 *
 * iCloud Drive syncs a package as ONE document. When the local copy and the
 * server copy diverge, it keeps one WHOLE version as the package and parks the
 * other as an "unresolved conflict version" under .DocumentRevisions-V100, so
 * a whole session of work (characters, sets, images, 3D models) silently
 * disappears from the project.
 *
 * This module finds those parked versions (NSFileVersion through JXA, no
 * native code) and merges each one back into the package:
 *   - every file missing from the package, or newer in the version, is copied
 *     in (APFS clone when possible), so nothing from either side is lost;
 *   - the drawer index (SQLite) is never file-copied (mixing a database file
 *     with another version's WAL corrupts it): rows missing from the live
 *     index are inserted through SQL; a corrupt live index is replaced by a
 *     healthy one from the version;
 *   - before touching anything, the package is cloned to
 *     ~/.koi/cache/project-backups/ (cheap on APFS);
 *   - the version is then marked resolved so iCloud stops holding it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { isProjectPackage, projectRoot } from './doc-root.js';

const execFileP = promisify(execFile);
const _require = createRequire(import.meta.url);
function _sqlite() {
  if (typeof process.pkg !== 'undefined' && process.env.KOI_EXTRACTED_NODE_MODULES) {
    return _require(path.join(process.env.KOI_EXTRACTED_NODE_MODULES, 'better-sqlite3'));
  }
  return _require('better-sqlite3');
}

const DB_DIR = path.join('media-library', 'vector-cache');
const DB_FILE = path.join(DB_DIR, 'index.sqlite');
const BACKUP_KEEP = 3;

const JXA = `
ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[1]);
  const vs = $.NSFileVersion.unresolvedConflictVersionsOfItemAtURL(url);
  if (!vs) return '[]';
  const out = [];
  for (let i = 0; i < vs.count; i++) {
    const v = vs.objectAtIndex(i);
    const p = ObjC.unwrap(v.URL.path);
    if (argv[0] === 'resolve') {
      if (argv.slice(2).indexOf(p) >= 0) v.setResolved(true);
      continue;
    }
    out.push({
      path: p,
      modified: v.modificationDate ? v.modificationDate.timeIntervalSince1970 * 1000 : 0,
      device: ObjC.unwrap(v.localizedNameOfSavingComputer) || '',
    });
  }
  return JSON.stringify(out);
}`;

async function _jxa(args) {
  const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA, ...args], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Unresolved iCloud conflict versions of [pkg] ([] off macOS / not in iCloud). */
export async function listConflictVersions(pkg) {
  if (process.platform !== 'darwin' || !isProjectPackage(pkg)) return [];
  try {
    const out = JSON.parse((await _jxa(['list', path.resolve(pkg)])) || '[]');
    return Array.isArray(out) ? out.filter((v) => v && v.path && fs.existsSync(v.path)) : [];
  } catch {
    return [];
  }
}

async function _markResolved(pkg, versionPaths) {
  if (!versionPaths.length) return;
  try { await _jxa(['resolve', path.resolve(pkg), ...versionPaths]); } catch { /* retried next pass */ }
}

function _copyFile(src, dst, st) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.rmSync(dst, { force: true }); } catch { /* replaced below */ }
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(dst, (st.mode & 0o777) | 0o600); // the version's files are read-only
  fs.utimesSync(dst, st.atime, st.mtime);
}

/** Copy every file of [src] that [dst] lacks or holds older. */
function _mergeTree(src, dst, rel, stats) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(src, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = path.join(rel, e.name);
    if (r === DB_DIR || r.startsWith(DB_DIR + path.sep)) continue;
    const s = path.join(src, r);
    const d = path.join(dst, r);
    if (e.isDirectory()) { _mergeTree(src, dst, r, stats); continue; }
    if (!e.isFile()) continue;
    let ss; let ds = null;
    try { ss = fs.statSync(s); } catch { continue; }
    try { ds = fs.statSync(d); } catch { /* missing */ }
    if (ds && ds.mtimeMs >= ss.mtimeMs) continue;
    try {
      _copyFile(s, d, ss);
      if (ds) stats.updated++; else stats.restored++;
    } catch (err) {
      stats.errors.push(`${r}: ${err.message}`);
    }
  }
}

function _dbHealthy(Database, file) {
  try {
    const db = new Database(file, { fileMustExist: true });
    try { return db.pragma('integrity_check', { simple: true }) === 'ok'; } finally { db.close(); }
  } catch {
    return false;
  }
}

/**
 * Merge the version's drawer index into the live one. The version's files are
 * read-only and may carry a WAL, so they are first copied to a temp folder
 * and checkpointed into one self-contained file.
 */
function _mergeIndex(versionPkg, pkg, stats) {
  const vdir = path.join(versionPkg, DB_DIR);
  if (!fs.existsSync(path.join(vdir, 'index.sqlite'))) return;
  const Database = _sqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'braxil-conflict-db-'));
  try {
    for (const f of fs.readdirSync(vdir)) {
      if (!f.startsWith('index.sqlite')) continue;
      fs.copyFileSync(path.join(vdir, f), path.join(tmp, f));
      fs.chmodSync(path.join(tmp, f), 0o600);
    }
    const vfile = path.join(tmp, 'index.sqlite');
    const vdb = new Database(vfile);
    try { vdb.pragma('wal_checkpoint(TRUNCATE)'); vdb.pragma('journal_mode = DELETE'); } finally { vdb.close(); }
    if (!_dbHealthy(Database, vfile)) { stats.errors.push('conflict version drawer index is damaged; skipped'); return; }

    const live = path.join(pkg, DB_FILE);
    if (!fs.existsSync(live) || !_dbHealthy(Database, live)) {
      // No usable live index: the version's healthy one takes its place.
      fs.mkdirSync(path.dirname(live), { recursive: true });
      for (const sfx of ['-wal', '-shm']) fs.rmSync(live + sfx, { force: true });
      fs.copyFileSync(vfile, live);
      stats.indexReplaced = true;
      return;
    }
    const db = new Database(live);
    try {
      db.pragma('busy_timeout = 10000');
      db.prepare('ATTACH DATABASE ? AS v').run(vfile);
      const tables = db.prepare("SELECT name FROM v.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      for (const { name } of tables) {
        const exists = db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name);
        const q = `"${name.replace(/"/g, '""')}"`;
        if (!exists) {
          const ddl = db.prepare("SELECT sql FROM v.sqlite_master WHERE type='table' AND name=?").get(name)?.sql;
          if (ddl) db.exec(ddl);
        }
        // Only rows the live index lacks: an existing row may carry newer
        // edits (favourite, description) made after the split.
        stats.indexRows += db.prepare(`INSERT OR IGNORE INTO main.${q} SELECT * FROM v.${q}`).run().changes;
      }
      db.prepare('DETACH DATABASE v').run();
    } finally {
      db.close();
    }
  } catch (err) {
    stats.errors.push(`drawer index: ${err.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Clone [pkg] to ~/.koi/cache/project-backups (APFS clone: near-free). */
async function _backup(pkg) {
  const root = path.join(os.homedir(), '.koi', 'cache', 'project-backups');
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(root, `${path.basename(pkg, path.extname(pkg))}-${stamp}${path.extname(pkg)}`);
  await execFileP('cp', ['-cR', pkg, dst], { timeout: 10 * 60_000 });
  const mine = fs.readdirSync(root)
    .filter((n) => n.startsWith(path.basename(pkg, path.extname(pkg)) + '-'))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }
  return dst;
}

let _running = false;

/**
 * Find and merge every parked iCloud conflict version of [pkg].
 * @returns {Promise<null | { versions, restored, updated, indexRows, indexReplaced, backup, errors }>}
 *   null when there was nothing to do.
 */
export async function recoverICloudConflicts(pkg) {
  if (_running) return null;
  _running = true;
  try {
    const versions = await listConflictVersions(pkg);
    if (!versions.length) return null;
    const stats = { versions: versions.length, restored: 0, updated: 0, indexRows: 0, indexReplaced: false, backup: null, errors: [] };
    stats.backup = await _backup(pkg);
    for (const v of versions) {
      _mergeTree(v.path, pkg, '', stats);
      _mergeIndex(v.path, pkg, stats);
    }
    if (!stats.errors.length) await _markResolved(pkg, versions.map((v) => v.path));
    process.stderr.write(
      `[project] iCloud conflict: merged ${stats.versions} version(s) into ${pkg}: `
      + `${stats.restored} restored, ${stats.updated} updated, ${stats.indexRows} drawer rows`
      + `${stats.indexReplaced ? ', drawer index replaced' : ''}; backup ${stats.backup}`
      + `${stats.errors.length ? `; errors: ${stats.errors.join(' | ')}` : ''}\n`,
    );
    return stats;
  } finally {
    _running = false;
  }
}

/**
 * Check the open project now and then every [intervalMs] while the engine
 * runs: iCloud can swap the package under an open project at any time. The
 * project is re-read on every pass so a switch to another one is followed.
 */
export function watchICloudConflicts({ intervalMs = 120_000, onRecovered } = {}) {
  if (process.platform !== 'darwin') return () => {};
  const tick = async () => {
    const pkg = path.resolve(projectRoot());
    if (!isProjectPackage(pkg)) return;
    try {
      const r = await recoverICloudConflicts(pkg);
      if (r && onRecovered) onRecovered(r, pkg);
    } catch (err) {
      process.stderr.write(`[project] iCloud conflict check failed: ${err.message}\n`);
    }
  };
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}
