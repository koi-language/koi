// Shared helper for normalising image / video references that media
// tools (generate-image, generate-video, outpaint, upscale, background-
// removal, …) accept from the agent.
//
// The agent can hand us any of these forms:
//   • absolute path:    "/Users/me/.koi/images/foo.png"
//   • relative path:    "assets/refs/ref_image_2.png"
//   • attachment id:    "att-1"  (resolved via attachmentRegistry)
//   • aliased object:   { alias: "boat", path: "att-1" }
//
// Every downstream call (provider upload, sharp decode, library save,
// metadata persistence, GUI thumbnail) needs an ABSOLUTE filesystem
// path. Doing the resolution per-tool led to drift: generate-image
// stored relative paths in metadata, the GUI then couldn't find them,
// and the user lost the audit trail of "which references made this
// image". Centralising the logic here is the once-and-for-all fix.

import path from 'node:path';

/**
 * Normalise a single ref entry to `{ alias, absPath }`. Returns
 * `null` when the input is malformed or the attachment id can't be
 * looked up. The caller decides whether a missing path is fatal
 * (most tools throw) or skippable (e.g. silent drop on caps-mismatch).
 *
 * @param {string|{alias?:string,path?:string}} item
 * @returns {Promise<{alias:string, absPath:string}|null>}
 */
export async function absolutizeMediaRef(item) {
  let alias = '';
  let raw = '';
  if (typeof item === 'string') {
    raw = item;
  } else if (item && typeof item === 'object') {
    raw = typeof item.path === 'string' ? item.path : '';
    alias = typeof item.alias === 'string' ? item.alias.trim() : '';
  }
  if (!raw) return null;

  // Attachment IDs come from the chat input bar — the registry maps
  // them to the on-disk file the user attached. Doing the lookup here
  // means tools never have to import the registry themselves.
  if (/^att-\d+$/.test(raw)) {
    try {
      const { attachmentRegistry } = await import('../../state/attachment-registry.js');
      const entry = attachmentRegistry.get(raw);
      if (entry?.path) return { alias, absPath: path.resolve(entry.path) };
    } catch { /* registry unavailable in some contexts — fall through */ }
    return null;
  }

  // Plain path — `path.resolve` absolutises against process.cwd() for
  // relative inputs and is a no-op for already-absolute ones.
  return { alias, absPath: path.resolve(raw) };
}

/**
 * Bulk version. Filters out unresolvable entries so the caller can
 * iterate the result safely. Order is preserved.
 *
 * @param {Array<string|{alias?:string,path?:string}>} items
 * @returns {Promise<Array<{alias:string, absPath:string}>>}
 */
export async function absolutizeMediaRefs(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out = [];
  for (const item of items) {
    const r = await absolutizeMediaRef(item);
    if (r) out.push(r);
  }
  return out;
}
