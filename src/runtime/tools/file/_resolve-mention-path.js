/**
 * Helper used by file tools (read_file, write_file, edit_file, …) to
 * accept `@mention` handles wherever they take a `path`. The user
 * tagged an asset as `@hero_script` once via `tag_media`; from then
 * on, every file tool should be able to follow that handle to the
 * underlying file without the agent re-deriving the path.
 *
 * Same resolution model the chat input bar's `@`-autocomplete uses:
 * most-recent row wins when several rows share the handle, so the
 * agent and user share intuition. Cross-project (the library lives at
 * `~/.koi/media-library/`) — a handle the user pinned in another
 * project resolves transparently here too.
 *
 * Returns either:
 *   - `{ ok: true, path: <abs path> }` — resolved successfully
 *   - `{ ok: true, path: <input> }`    — input was NOT a `@`-handle, returned as-is
 *   - `{ ok: false, error: <msg> }`    — handle didn't resolve (no row, library missing, …)
 *
 * Detection rule: starts with `@`, has at least one char after, and
 * contains no `/` or `\` — handles are short bare tokens, never
 * filesystem paths. A literal filename like `@hello/world.txt` (which
 * shouldn't exist on real filesystems but is conceivable) skips the
 * resolver and is treated as a path.
 */
export async function resolveMentionPath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: true, path: input };
  }
  if (!input.startsWith('@') || input.length === 1) {
    return { ok: true, path: input };
  }
  if (input.includes('/') || input.includes('\\')) {
    return { ok: true, path: input };
  }

  let lib;
  try {
    const { MediaLibrary } = await import('../../state/media-library.js');
    lib = MediaLibrary.global();
  } catch (err) {
    return { ok: false, error: `mention resolver: failed to load MediaLibrary (${err.message})` };
  }
  if (!lib) {
    return { ok: false, error: `mention resolver: MediaLibrary unavailable — cannot resolve "${input}".` };
  }

  let matches;
  try {
    matches = await lib.findByMention(input.slice(1));
  } catch (err) {
    return { ok: false, error: `mention resolver: findByMention("${input}") threw: ${err.message}` };
  }
  if (!Array.isArray(matches) || matches.length === 0 || !matches[0]?.filePath) {
    return {
      ok: false,
      error:
        `No media-library asset is tagged "${input}". Tag one with \`tag_media\` ` +
        'first, or pick a different handle from `# KNOWN MEDIA HANDLES` in your prompt.',
    };
  }
  return {
    ok: true,
    path: matches[0].filePath,
    resolved: true,
    mediaType: matches[0].mediaType,
    matchCount: matches.length,
  };
}
