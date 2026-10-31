/**
 * Creation-directory guard.
 *
 * Braxil persists user creations under per-kind subdirectories of a `.koi`
 * root (home OR project): `.koi/timelines`, `.koi/storyboards`, `.koi/images`,
 * `.koi/videos`, `.koi/renders`. Those dirs are SHARED across every session
 * and project, so browsing/searching them to "find the timeline" / "confirm
 * the path" / "grab the latest video" reliably returns the WRONG file — the
 * recurring "agent showed me yesterday's audio / another project's clip" bug.
 *
 * Contract (the user's explicit instruction): the generic filesystem tools
 * (`shell`, `search`, `grep`, and `read_file` used to LIST a directory) may
 * NOT operate inside these dirs. Lookups go exclusively through the DB-backed
 * recall tools — `recall_media`, `recall_creations` → `inspect_creation`,
 * `recall_image` — which return the exact, correct path.
 *
 * What stays allowed: reading a SPECIFIC file by the path a recall tool just
 * handed back (`read_file('/…/.koi/videos/xxx.mp4')`). Only listing /
 * searching / shelling the dirs is blocked. The dedicated creation tools
 * (`create_timeline`, `render_timeline`, `generate_image`, …) write through
 * the runtime, not through these guarded tools, so they're unaffected.
 */

import path from 'path';
import os from 'os';

// The exact set the user signed off on. Intentionally NOT including infra dirs
// (sessions, memory, cache, plugins) nor audio/voices — only the five creation
// media dirs, to avoid blocking any legitimate non-lookup flow.
export const CREATION_DIR_NAMES = [
  'timelines',
  'storyboards',
  'images',
  'videos',
  'renders',
];

// Matches `…/.koi/<creationDir>` optionally followed by `/<deeper>`. Anchored
// on the `.koi` segment so it fires for both `<project>/images/x.png` and
// `<proj>/.koi/timelines/y.json`, but never for an unrelated `images/` dir.
// …and the same folders at the top of a `.braxil` project package.
const _pathRe = new RegExp(`(?:^|/)(?:\\.koi|[^/]+\\.braxil)/(${CREATION_DIR_NAMES.join('|')})(?:/|$)`);

// Looser scan for a raw shell command string, which can't be path.resolve()'d:
// match the `.koi/<creationDir>` token anywhere in the text (covers
// `<project>/images`, `$HOME/.koi/videos`, `./.koi/timelines`, absolute forms).
const _cmdRe = new RegExp(`(?:\\.koi|\\.braxil)/(${CREATION_DIR_NAMES.join('|')})(?:/|\\b)`);

function _normalize(p) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.trim();
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  try { s = path.resolve(s); } catch { /* keep raw on resolve failure */ }
  return s.replace(/\\/g, '/');
}

/**
 * If `p` points INTO a guarded creation dir, return that dir's name
 * (e.g. "timelines"); otherwise null.
 */
export function creationDirHit(p) {
  const m = _normalize(p).match(_pathRe);
  return m ? m[1] : null;
}

/**
 * Raw-string variant for the shell tool. Returns the offending creation-dir
 * name found anywhere in `command`, or null.
 */
export function commandCreationDirHit(command) {
  if (typeof command !== 'string') return null;
  const m = command.replace(/\\/g, '/').match(_cmdRe);
  return m ? m[1] : null;
}

/**
 * The single, shared redirect message every guarded tool surfaces, so the
 * agent always gets the same "use the DB tools" guidance.
 */
export function creationDirBlockedMessage(toolName, hitDir, target) {
  return (
    `Blocked: \`${toolName}\` may not browse or search the creations directory ` +
    `".koi/${hitDir}"${target ? ` (from "${target}")` : ''}. These dirs are shared by ` +
    `EVERY session and project, so searching them returns the wrong creation. ` +
    `Resolve creations through the database instead: ` +
    `\`recall_media\` (to resolve "the video" / "the image" / a file the user referred to), ` +
    `\`recall_creations({ kind })\` → \`inspect_creation\` (something you made this session), ` +
    `or \`recall_image\` (pull an image back into vision). They return the exact path; ` +
    `reading THAT specific path with \`read_file\` is fine — listing/searching the dir is not.`
  );
}

/** Structured error result for the object-returning tools (search/grep/read_file). */
export function creationDirBlockedError(toolName, hitDir, target) {
  return {
    success: false,
    error: creationDirBlockedMessage(toolName, hitDir, target),
    blockedByCreationGuard: true,
  };
}
