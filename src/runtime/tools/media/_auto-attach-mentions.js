// Shared helper: scan a prompt for `@handle` tokens, resolve each one
// against the cross-project MediaLibrary, and merge the resulting file
// paths into a `references` list (referenceImages or referenceVideos)
// IF they aren't already there.
//
// Why: agents very often write prompts like
//   "Burrow environment identical to @storyboard_001"
// and forget to also pass that handle in `referenceImages`. The
// generation provider then has to invent the burrow visually, breaking
// continuity. Auto-attaching closes the gap transparently — the agent
// keeps writing natural prompts and the tool wires up references.
//
// Constraints:
//   • Idempotent: a handle already present (by alias OR resolved path)
//     is never re-added, so the agent's explicit refs always win and
//     ordering is preserved.
//   • Media-type filtered: when wiring referenceImages, only handles
//     that resolve to image rows are merged; same for video. Mismatched
//     handles are silently ignored — the agent's prompt will still
//     mention them and the model can describe them in text, but we
//     don't shove a video into an image slot or vice-versa.
//   • Capacity-bounded: if the resolved provider has a maxReferenceImages
//     cap, the auto-attached set is truncated to fit AFTER the explicit
//     refs (the agent's chosen refs always win the cap budget).

import { absolutizeMediaRef } from './_absolutize-media-ref.js';

// Same regex flavour used by InputBar._expandMentionAttachments and the
// conversations source (system-prompt-builder _filterMentionResolved…).
// Matches `@<handle>` at line start or after whitespace; handle is
// alnum + underscore + hyphen. Email-like prefixes (foo@bar) are NOT
// matched because of the leading-whitespace boundary.
const MENTION_RE = /(^|\s)@([A-Za-z0-9_\-]+)/g;

/** Pull unique handles (without the leading @) from a prompt string. */
function extractMentionHandles(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const m of prompt.matchAll(MENTION_RE)) {
    const raw = m[2];
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * Resolve every `@handle` in [prompt] against the gallery and merge
 * matching rows into [refs] when they aren't already represented.
 *
 * Also reports `unknown` — handles that appear in the prompt but DON'T
 * resolve to ANY gallery row. Callers (generate_image / generate_video)
 * fail fast on those so the model doesn't hallucinate visuals for a
 * reference that doesn't exist.
 *
 * @param {Object} opts
 * @param {string}        opts.prompt        Free-text prompt to scan.
 * @param {Array<string|object>} [opts.refs] Existing reference list (modified
 *                                           in-place via return value, never
 *                                           mutated through the parameter).
 * @param {'image'|'video'} opts.mediaKind   Filter handles by mediaType.
 * @param {number} [opts.maxRefs]            Hard cap on the merged list.
 * @returns {Promise<{merged: Array, added: string[], skipped: string[], unknown: string[]}>}
 *
 * `merged`  — new reference list to use.
 * `added`   — handles appended this call (with leading `@`).
 * `skipped` — handles that resolved but were dropped (already present,
 *             wrong media kind, or over the cap).
 * `unknown` — handles in the prompt that DON'T match any gallery row
 *             (image OR video). Callers should reject the request.
 */
export async function autoAttachMentions({ prompt, refs = [], mediaKind, maxRefs = Infinity }) {
  const handles = extractMentionHandles(prompt);
  if (handles.length === 0) {
    return { merged: Array.isArray(refs) ? refs.slice() : [], added: [], skipped: [], unknown: [] };
  }

  // Build a fast lookup of what's ALREADY in refs. We compare by:
  //   • alias (if present in an aliased object)
  //   • resolved absolute path (so an explicit `["@tom", "@tom"]` collapses
  //     to one effective ref even when the same handle appears multiple
  //     times in the prompt)
  // Resolving the existing refs costs N MediaLibrary lookups, but N is
  // tiny (provider caps in the low single digits) so the overhead is
  // negligible.
  const existingAliases = new Set();
  const existingPaths = new Set();
  for (const item of (Array.isArray(refs) ? refs : [])) {
    if (item && typeof item === 'object' && typeof item.alias === 'string') {
      const a = item.alias.trim().toLowerCase();
      if (a) existingAliases.add(a);
    }
    try {
      const r = await absolutizeMediaRef(item);
      if (r?.absPath) existingPaths.add(r.absPath);
    } catch { /* skip */ }
  }

  // Lazy-load MediaLibrary so this helper stays a no-op when the
  // gallery isn't available (e.g. unit tests, headless CI without the
  // SQLite cache). The findByMention call is the same one the input
  // bar's `@`-autocomplete uses, so user / agent intuitions match.
  let lib;
  try {
    const mod = await import('../../state/media-library.js');
    lib = mod.MediaLibrary.global();
  } catch {
    return { merged: Array.isArray(refs) ? refs.slice() : [], added: [], skipped: handles.map((h) => `@${h}`), unknown: [] };
  }
  if (!lib) {
    return { merged: Array.isArray(refs) ? refs.slice() : [], added: [], skipped: handles.map((h) => `@${h}`), unknown: [] };
  }

  const merged = Array.isArray(refs) ? refs.slice() : [];
  const added = [];
  const skipped = [];
  const unknown = [];

  for (const handle of handles) {
    // FIRST check: does this handle already match an alias on an
    // already-attached ref? If yes, the agent is using @-syntax to
    // refer to one of the refs they EXPLICITLY wired up — there's
    // nothing to look up in the gallery, nothing to attach, and
    // crucially nothing to report as "unknown". Skipping silently
    // here also prevents `assignPositionalAliases` downstream from
    // failing on a handle that's already correctly mapped via the
    // agent's own `{alias, path}` entry.
    //
    // This check used to live AFTER the gallery probe — when the
    // handle didn't exist in the gallery, it was pushed to `unknown`
    // before the alias check ever ran. Result: an agent who passed
    // `referenceImages: [{alias: "local", path: "..."}]` and wrote
    // "@local" in the prompt got a hard rejection because `@local`
    // wasn't a gallery handle, even though it WAS a valid alias.
    if (existingAliases.has(handle.toLowerCase())) {
      skipped.push(`@${handle}`); // already present by alias
      continue;
    }

    let matches;
    try { matches = await lib.findByMention(handle); }
    catch { matches = []; }

    // Hallucinated handle — the agent referenced something that
    // doesn't exist in the gallery at all AND isn't an alias of an
    // attached ref. Surface it so the caller can reject the request;
    // we do NOT try to "be helpful" by dropping it silently (that's
    // how models end up generating invented references).
    if (!matches || matches.length === 0) {
      unknown.push(`@${handle}`);
      continue;
    }

    if (merged.length >= maxRefs) {
      skipped.push(`@${handle}`);
      continue;
    }
    // Pick the first row whose mediaType matches the requested kind.
    // findByMention returns newest-first, so a project that has both an
    // image AND a video tagged `@hero` will resolve to the most recent
    // matching kind — same intuition the user has when typing `@hero`
    // in the input bar.
    const row = matches.find((r) => r?.mediaType === mediaKind && r?.filePath);
    if (!row) {
      skipped.push(`@${handle}`); // wrong media kind for this slot
      continue;
    }
    if (existingPaths.has(row.filePath)) {
      skipped.push(`@${handle}`); // already present by resolved path
      continue;
    }
    // Use the {alias, path} shape so downstream prompt-aliasing
    // (generate_image's reference legend) can echo the @handle back
    // into the model's prompt without the agent having to manage it.
    merged.push({ alias: handle, path: row.filePath });
    existingAliases.add(handle.toLowerCase());
    existingPaths.add(row.filePath);
    added.push(`@${handle}`);
  }

  return { merged, added, skipped, unknown };
}

/**
 * Reconcile `unknown` handles (returned by [autoAttachMentions]) with
 * already-attached references by treating each unresolved handle as a
 * POSITIONAL ALIAS for the next ref without one. The agent often
 * writes prompts like
 *   "Edit Image 1 by removing the pedestrian, then use Image 2 as the
 *    background"
 * and intends `Image 1` / `Image 2` to refer to the references it
 * already wired up via `referenceImages` / `referenceVideos`. Those
 * handles aren't in the gallery — they're the agent's chosen names
 * for the positional slots — so this helper takes the unresolved
 * handles in prompt order and attaches them as aliases to the first
 * unaliased entries in the ref list (also in order). Downstream code
 * that builds a reference legend (system-prompt aliasing, model-
 * specific @Image1/@Video1 mapping, etc.) then sees `{alias, path}`
 * for those slots and the prompt's `Image 1` resolves correctly.
 *
 * @param {Array} refs         Ref list (mix of strings and {alias,path}).
 * @param {string[]} unknown   Handles still unresolved after auto-attach
 *                             (each prefixed with `@`).
 * @returns {{ merged: Array, assigned: Array<{handle:string,path:string}>,
 *             leftover: string[] }}
 *   `merged`   — ref list with positional aliases applied.
 *   `assigned` — handles successfully wired to a ref (with the path
 *                they ended up bound to).
 *   `leftover` — handles that couldn't be assigned (no unaliased refs
 *                left). Callers decide whether to warn or fail —
 *                typically these are hallucinated handles the agent
 *                wrote with no underlying reference attached.
 */
export function assignPositionalAliases(refs, unknown) {
  const merged = Array.isArray(refs) ? refs.slice() : [];
  const assigned = [];
  const leftover = [];
  if (!Array.isArray(unknown) || unknown.length === 0) {
    return { merged, assigned, leftover };
  }
  // Track which positions in `merged` already have an alias (set
  // either by the agent or by autoAttachMentions). We only target
  // plain-string slots — overwriting an existing alias would lose the
  // agent's deliberate naming.
  let cursor = 0;
  const findNextUnaliased = () => {
    for (; cursor < merged.length; cursor++) {
      const item = merged[cursor];
      const isPlain = typeof item === 'string';
      const isObjectWithoutAlias =
        item && typeof item === 'object' && !item.alias && typeof item.path === 'string';
      if (isPlain || isObjectWithoutAlias) return cursor;
    }
    return -1;
  };
  for (const handleWithAt of unknown) {
    const handle = typeof handleWithAt === 'string' && handleWithAt.startsWith('@')
      ? handleWithAt.slice(1)
      : String(handleWithAt || '');
    if (!handle) continue;
    const slot = findNextUnaliased();
    if (slot < 0) {
      leftover.push(`@${handle}`);
      continue;
    }
    const item = merged[slot];
    const path = typeof item === 'string' ? item : item.path;
    merged[slot] = { alias: handle, path };
    assigned.push({ handle: `@${handle}`, path });
    cursor++;
  }
  return { merged, assigned, leftover };
}

/**
 * Build a friendly error message listing the gallery handles that DO
 * exist, so the agent can fix its prompt instead of guessing again.
 * Returns null when MediaLibrary isn't reachable (caller falls back
 * to a generic message).
 */
export async function listAvailableMentions({ limit = 50 } = {}) {
  let lib;
  try {
    const mod = await import('../../state/media-library.js');
    lib = mod.MediaLibrary.global();
  } catch { return null; }
  if (!lib) return null;
  try {
    const all = await lib.list({ limit: 5000 });
    const set = new Set();
    for (const it of all) {
      const m = (it.mention || '').trim();
      if (m) set.add(`@${m}`);
    }
    const sorted = [...set].sort();
    return sorted.slice(0, limit);
  } catch { return null; }
}
