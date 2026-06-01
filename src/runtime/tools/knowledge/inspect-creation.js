/**
 * Inspect Creation Action — resolve a creation id (or `@mention`
 * handle) to its full MediaLibrary row WITHOUT running any filesystem
 * search. Companion to `recall_creations`: list first to get an id,
 * then inspect to read the canonical path + metadata.
 *
 * Why a dedicated tool:
 *   The user explicitly reported that `find` / `ls` based recovery
 *   contaminates with stale files from other sessions. This tool
 *   replaces both — given the id the agent saw in `recall_creations`
 *   (or any other lookup), it returns the row exactly as MediaLibrary
 *   has it: absolute path on disk, the kind, the originating
 *   generation params, the created-at, the credits cost, etc. No
 *   guessing about which file on disk maps to which creation.
 *
 * Lookup precedence: `id` (exact) → `mention` (resolves to newest tag
 * match) → `filePath` (matches a saved row). At least one of the three
 * MUST be provided; the empty form returns an error rather than the
 * most-recent row (the agent should use `recall_creations` for that).
 */

import fs from 'node:fs';

function _err(msg) { return { success: false, error: `inspect_creation: ${msg}` }; }

export default {
  type: 'inspect_creation',
  intent: 'inspect_creation',
  description:
    'Resolve a creation id (or `@mention` handle, or absolute filePath) to its full MediaLibrary row. ' +
    'Use this INSTEAD of `find` / `ls` / `read_file` when you already know which creation you mean — typically right after `recall_creations` returned a list and you picked one. ' +
    'Pass exactly one of `id`, `mention`, or `filePath`. ' +
    'Returns the canonical absolute file path, the media kind, the saved generation params, the credits cost, the created-at timestamp, and any other metadata the row carries. Empty payload (none of id/mention/filePath set) is an error — for "what is the most recent creation?" use `recall_creations` with `limit: 1`.\n\n' +
    'Returns: { success, creation: { id, kind, filePath, filename, width, height, description, summary?, metadata, createdAt, … } }.',
  thinkingHint: (action) => {
    if (action?.id) return `Inspecting creation ${action.id}`;
    if (action?.mention) return `Inspecting @${String(action.mention).replace(/^@/, '')}`;
    if (action?.filePath) return `Inspecting ${action.filePath}`;
    return 'Inspecting creation';
  },
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Exact MediaLibrary row id (e.g. "media-1748728028000-a1b2c3d4"). The id you get from `recall_creations` or from a creation tool\'s response.',
      },
      mention: {
        type: 'string',
        description:
          '`@mention` handle (with or without the leading `@`). Resolves to the NEWEST row carrying that mention (same lookup as `recall_image` and the chat input bar autocomplete).',
      },
      filePath: {
        type: 'string',
        description:
          'Absolute filesystem path of a known-saved file. Resolves to the row whose `file_path` exactly matches. Use when you have a path in hand but no id — saves a filesystem read.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'inspect_creation', id: 'media-1748728028000-a1b2c3d4' },
    { actionType: 'direct', intent: 'inspect_creation', mention: '@hero_pose' },
    { actionType: 'direct', intent: 'inspect_creation', filePath: '/Users/me/.koi/timelines/tl-1780.json' },
  ],

  async execute(action) {
    const id = action?.id ? String(action.id).trim() : '';
    const mention = action?.mention ? String(action.mention).trim() : '';
    const filePath = action?.filePath ? String(action.filePath).trim() : '';

    if (!id && !mention && !filePath) {
      return _err(
        'pass one of `id`, `mention`, or `filePath`. For "the most recent creation" use ' +
        '`recall_creations` with `limit: 1`.',
      );
    }

    const { MediaLibrary } = await import('../../state/media-library.js');
    const lib = MediaLibrary.global();

    let row = null;
    let resolvedBy = '';
    if (id) {
      row = await lib.get(id);
      resolvedBy = 'id';
    }
    if (!row && mention) {
      const matches = await lib.findByMention(mention);
      if (matches.length > 0) {
        row = matches[0]; // newest first per findByMention contract
        resolvedBy = 'mention';
      }
    }
    if (!row && filePath) {
      row = await lib.getByPath(filePath);
      resolvedBy = 'filePath';
    }

    if (!row) {
      return _err(
        `not found by ${resolvedBy || 'any provided key'}: ` +
        [
          id && `id="${id}"`,
          mention && `mention="${mention}"`,
          filePath && `filePath="${filePath}"`,
        ].filter(Boolean).join(', ') +
        '. Did you mean a different session? `recall_creations` lists what THIS session produced.',
      );
    }

    // Surface a `fileExists` flag — a saved row can outlive the file
    // on disk if the user deletes the renders folder manually. Tells
    // the agent whether to retry / regenerate or proceed with the
    // path.
    let fileExists = false;
    if (row.filePath) {
      try { fileExists = fs.existsSync(row.filePath); } catch { /* */ }
    }

    return {
      success: true,
      resolvedBy,
      creation: { ...row, fileExists },
    };
  },
};
