/**
 * Guard: prevent any code from creating the .koi directory prematurely.
 *
 * The .koi directory should ONLY be created by the project onboarding flow
 * in koi-cli.js after the user confirms the project. This module monkey-patches
 * fs.mkdirSync so that any attempt to create a path containing /.koi/ is silently
 * skipped if the .koi directory doesn't already exist.
 *
 * Import this module ONCE at startup (e.g. in ink-bootstrap.js).
 */

import fs from 'fs';
import path from 'path';

const _originalMkdirSync = fs.mkdirSync;

fs.mkdirSync = function guardedMkdirSync(dirPath, options) {
  if (typeof dirPath === 'string' && options?.recursive) {
    // Check if this path goes through a .koi directory
    const normalized = path.normalize(dirPath);
    const koiIdx = normalized.indexOf(`${path.sep}.koi${path.sep}`);
    if (koiIdx !== -1) {
      // Extract the .koi parent: everything up to and including .koi
      const koiDir = normalized.substring(0, koiIdx + path.sep.length + 4);
      if (!fs.existsSync(koiDir)) {
        // .koi doesn't exist yet — skip silently (onboarding hasn't run)
        return undefined;
      }
    }
  }
  return _originalMkdirSync.call(fs, dirPath, options);
};

export const koiDirGuardInstalled = true;
