/**
 * Post-write guard for storyboards edited AS TEXT.
 *
 * A storyboard is a JSON file, and a JSON file is a file: `edit_file` /
 * `write_file` are legitimate ways to change one, and for some edits they are
 * the BEST way (a rename across 16 shots is one replace instead of 16 patches).
 * What the structured tools bought us was never the editing — it was the
 * guarantees: the document stays parseable, its invariants hold (sequential
 * `number` across scenes, the shared number of a `noCutBefore` continuation,
 * unique ids), and the MediaLibrary index stays in sync.
 *
 * So instead of forbidding text edits, we keep the guarantees and let the edit
 * happen: this runs right AFTER the bytes land. If the result no longer parses
 * or breaks an invariant, the previous content is RESTORED and the caller gets
 * the reason — the file is never left in a state the visor cannot render.
 *
 * Not a validator the agent has to remember to call: it hooks into the write
 * path, so it holds for every route into the file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** True when [p] is a storyboard document under ~/.koi/storyboards/. */
export function isStoryboardPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (!/\.json$/i.test(p)) return false;
  const home = process.env.HOME || os.homedir();
  const dir = path.resolve(home, '.koi', 'storyboards');
  return path.resolve(p).startsWith(dir + path.sep);
}

/**
 * Validate a storyboard file after it was written as text; restore
 * [previousContent] when the new content is unusable.
 *
 * @param {string} resolvedPath   absolute path just written
 * @param {string|null} previousContent  bytes before the write (null = new file)
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function validateStoryboardWrite(resolvedPath, previousContent) {
  let text;
  try {
    text = fs.readFileSync(resolvedPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `could not re-read ${resolvedPath}: ${e.message}` };
  }

  const _restore = () => {
    try {
      if (previousContent == null) fs.unlinkSync(resolvedPath);
      else fs.writeFileSync(resolvedPath, previousContent, 'utf8');
      return true;
    } catch { return false; }
  };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const restored = _restore();
    return {
      ok: false,
      error:
        `the edit left the storyboard unparseable: ${e.message}. `
        + (restored
          ? 'The previous content was RESTORED — the file on disk is intact. '
          : '⚠️ The previous content could NOT be restored. ')
        + 'Re-read the file and redo the edit; the most common cause is an unbalanced quote or a trailing comma.',
    };
  }

  let invariantError = null;
  try {
    const { _validate } = await import('./save-storyboard.js');
    invariantError = _validate(doc);
  } catch {
    // Validator unavailable → a parseable document is as much as we can
    // promise. Better than refusing a legitimate edit.
    invariantError = null;
  }
  if (invariantError) {
    const restored = _restore();
    return {
      ok: false,
      error:
        `the edit breaks the storyboard's rules: ${invariantError} `
        + (restored
          ? 'The previous content was RESTORED — the file on disk is intact.'
          : '⚠️ The previous content could NOT be restored.'),
    };
  }

  // Keep the creations index pointing at the edited document. Failing here is
  // not worth reverting a valid edit — the file is the source of truth.
  try {
    const { saveStoryboardEntry } = await import('../../state/media-library.js');
    await saveStoryboardEntry(resolvedPath, doc, null, {});
  } catch { /* index is best-effort */ }

  return { ok: true };
}
