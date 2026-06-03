/**
 * Recall Creations Action — list the creations PRODUCED IN THE CURRENT
 * SESSION so the agent can resolve them by id without searching the
 * filesystem.
 *
 * Why this exists:
 *   The user reported the agent forgetting what it just made and
 *   resorting to `find . -name "*tl-…*"` to locate a freshly-rendered
 *   timeline — which often surfaces files from OTHER sessions and
 *   produces wrong assumptions. Every creation tool now appends to a
 *   per-session ledger at `.koi/sessions/<id>/creations.jsonl` (via
 *   `MediaLibrary.save()` → `recordCreation()`). This action exposes
 *   that ledger to the agent. Output is reverse-chronological (most
 *   recent first) so "what did we just make?" is the cheapest lookup.
 *
 * NOT a filesystem walk. NOT a global MediaLibrary search. ONLY entries
 * the AGENT created in the current session, with the "summary" line it
 * supplied (or the auto-derived fallback) and the canonical media id
 * a follow-up `inspect_creation` can resolve to a file path + metadata.
 */

import { readCreations } from '../../state/creations-ledger.js';

const _VALID_KINDS = new Set([
  'image', 'video', 'audio', 'timeline', 'storyboard', 'voice', 'document',
]);

function _err(msg) { return { success: false, error: `recall_creations: ${msg}` }; }

export default {
  type: 'recall_creations',
  intent: 'recall_creations',
  description:
    'List the creations (images, videos, audio, timelines, storyboards, voices) PRODUCED IN THE CURRENT SESSION. ' +
    'Use this INSTEAD of `find` / `ls` / `read_dir` when you need to remember "what did I just make?" — the ledger has the canonical id, kind, file path, and the one-line summary you (or the previous tool) attached at create time. ' +
    'Reverse-chronological output (newest first). Filterable by `kind` and capped by `limit`.\n\n' +
    'Workflow: call `recall_creations` first, pick the id of the artefact you need, then either pass it to `inspect_creation` for full metadata + absolute path, or feed it directly to a downstream tool (show_result, assign to a clip, etc.).\n\n' +
    '**Wrong use — NEVER do these:**\n' +
    '  • To resolve a demonstrative ("este", "esto", "this", "este storyboard") when the `# WORKING AREA` block in your system prompt names an active document — the active doc IS what the user is pointing at, use its path directly.\n' +
    '  • As a precursor to a filesystem search: if `recall_creations` returns `count: 0` you must NOT then run `ls`, `find`, `read_dir`, `shell` globbing or any other disk lookup to "find" the artefact yourself. Disk fallback is forbidden for resolving user references. Ask the user instead.\n' +
    '  • To look for creations from PRIOR sessions — the ledger only covers the current session by design. For cross-session lookup use `recall_memory` / `inspect_creation` with a known id, never disk search.\n\n' +
    'Returns: { success, creations: [{ id, kind, summary, filePath, ts }, …], count }. ' +
    'When `count` is 0: the ledger has no matching entry; either the artefact is in the active doc / working area already, or the user is referring to something you don\'t have — ASK, do not search disk.',
  thinkingHint: (action) =>
    `Recalling${action?.kind ? ' ' + action.kind : ''} creations`,
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['image', 'video', 'audio', 'timeline', 'storyboard', 'voice', 'document'],
        description:
          'OPTIONAL. Filter by media kind. Mirrors `media_type` in MediaLibrary. Omit to get every kind.',
      },
      limit: {
        type: 'number',
        description:
          'OPTIONAL. Max entries to return after the reverse-chronological sort. Default unlimited.',
      },
      since: {
        type: 'number',
        description:
          'OPTIONAL. Epoch milliseconds — only return entries with ts >= since. Use when you want "what changed in the last N minutes" (compute the epoch yourself).',
      },
      storyboard: {
        type: 'string',
        description:
          'OPTIONAL but STRONGLY RECOMMENDED when working on a specific storyboard/video. The storyboard id (e.g. "star-wars-laser-comedy" — the `id` field of the storyboard JSON, == the source filename without `.json`). Scopes the recall to creations made FOR THAT storyboard only. A single session often produces several DIFFERENT videos; without this filter the list mixes them and you may grab another video\'s sheet as a reference. When generating a multi-part sheet, ALWAYS pass the storyboard id you are working on.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'recall_creations' },
    { actionType: 'direct', intent: 'recall_creations', kind: 'timeline' },
    { actionType: 'direct', intent: 'recall_creations', kind: 'image', storyboard: 'star-wars-laser-comedy' },
  ],

  async execute(action) {
    const kind = typeof action?.kind === 'string' ? action.kind.trim() : '';
    if (kind && !_VALID_KINDS.has(kind)) {
      return _err(
        `invalid kind "${kind}". Allowed: ${[..._VALID_KINDS].join(', ')}.`,
      );
    }
    const limit = (typeof action?.limit === 'number' && action.limit > 0)
      ? Math.floor(action.limit) : undefined;
    const since = (typeof action?.since === 'number' && action.since > 0)
      ? Math.floor(action.since) : undefined;
    const storyboard = (typeof action?.storyboard === 'string' && action.storyboard.trim())
      ? action.storyboard.trim() : undefined;

    let creations;
    try {
      creations = await readCreations({ kind: kind || undefined, limit, since, storyboard });
    } catch (err) {
      return _err(`failed to read ledger: ${err.message}`);
    }
    return { success: true, count: creations.length, creations, ...(storyboard ? { storyboard } : {}) };
  },
};
