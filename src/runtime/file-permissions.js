/**
 * File permission system for all file-related actions.
 *
 * Permission model:
 *   - READ:  per DIRECTORY  — granted when the user approves a read action.
 *   - WRITE: per FILE       — "Always allow" grants this specific file only.
 *              + per DIRECTORY — "Always allow this directory" for bulk operations.
 *   - "read" does NOT grant "write".
 *   - GLOBAL singleton: all agents share one grant table per session.
 *   - In-memory only (reset between sessions).
 *
 * Write-permission granularity:
 *   Per-file grants prevent the user from accidentally auto-approving an entire
 *   directory when they approve a single file. A new file in the same directory
 *   will always show a confirmation dialog unless the directory is explicitly
 *   granted or the file itself has a prior grant.
 */

import path from 'path';

/**
 * Check if `dir` is equal to or a subdirectory of `allowedDir`.
 */
function isSubdirOf(dir, allowedDir) {
  const normalized = path.resolve(dir) + path.sep;
  const normalizedAllowed = path.resolve(allowedDir) + path.sep;
  return normalized.startsWith(normalizedAllowed) || path.resolve(dir) === path.resolve(allowedDir);
}

export class FilePermissions {
  constructor() {
    this.readDirs  = [];  // directories allowed for read/search
    this.writeDirs = [];  // directories allowed for write (broad grant)
    this.writeFiles = []; // individual files allowed for write (narrow grant)
  }

  /**
   * Grant read permission for a directory.
   * @param {string} directory
   * @param {'read'} level
   */
  allow(directory, level = 'read') {
    const resolved = path.resolve(directory);
    if (level === 'write') {
      if (!this.writeDirs.includes(resolved)) this.writeDirs.push(resolved);
    } else {
      if (!this.readDirs.includes(resolved)) this.readDirs.push(resolved);
    }
  }

  /**
   * Grant write permission for a SPECIFIC FILE only (narrow grant).
   * Used by "Always allow this file" in write_file / edit_file.
   * @param {string} filePath - absolute or relative path to the file
   */
  allowFile(filePath) {
    const resolved = path.resolve(filePath);
    if (!this.writeFiles.includes(resolved)) this.writeFiles.push(resolved);
  }

  /**
   * Check if a file/directory is allowed for a given operation level.
   * For 'write', checks per-file grants first, then per-directory grants.
   * @param {string} filePath
   * @param {'read'|'write'} level
   * @returns {{ permitted: boolean, scope: 'file'|'directory'|null }}
   */
  isAllowed(filePath, level = 'read') {
    // --yes flag: auto-accept all file permissions
    if (process.env.KOI_YES === '1') return true;

    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);

    if (level === 'write') {
      // Per-file grant (narrow — highest priority)
      if (this.writeFiles.includes(resolved)) return true;
      // Per-directory grant (broad)
      return this.writeDirs.some(allowed => isSubdirOf(dir, allowed) || isSubdirOf(resolved, allowed));
    }

    // Read: directory-level only
    return this.readDirs.some(allowed => isSubdirOf(dir, allowed) || isSubdirOf(resolved, allowed));
  }

  /**
   * Returns a human-readable label describing why a write is auto-approved,
   * or null if the file is not auto-approved.
   * @param {string} filePath
   * @returns {string|null}
   */
  autoApprovalReason(filePath) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    if (this.writeFiles.includes(resolved)) return `file grant for ${path.basename(resolved)}`;
    const matchedDir = this.writeDirs.find(d => isSubdirOf(dir, d) || isSubdirOf(resolved, d));
    if (matchedDir) return `directory grant for ${matchedDir}`;
    return null;
  }
}

/**
 * Global shared permission instance — all agents use the same set of grants.
 * Granting permission once applies to every agent in the session.
 */
const _globalFilePermissions = new FilePermissions();

export function getFilePermissions(_agent) {
  return _globalFilePermissions;
}

// ---------------------------------------------------------------------------
// Serial permission queue — ensures file write/edit dialogs appear one at a
// time, even when multiple file actions run in parallel.
//
// Without this queue, concurrent write_file actions all call cliSelect()
// simultaneously. React's selectMode state can only hold one dialog at a time,
// so later emits overwrite earlier ones — earlier dialogs never resolve and
// the parallel batch hangs forever.
// ---------------------------------------------------------------------------

let _filePermQueueTail = Promise.resolve();

/**
 * Run `fn` (an async permission dialog) serially with respect to other file
 * permission dialogs. Returns the promise returned by fn.
 *
 * Usage:
 *   const value = await runFilePermDialog(() => cliSelect(...));
 */
export function runFilePermDialog(fn) {
  // Chain fn after the current tail; errors in fn propagate to the caller
  // but never break the chain for subsequent waiters.
  const result = _filePermQueueTail.then(() => fn());
  _filePermQueueTail = result.then(() => {}, () => {});
  return result;
}
