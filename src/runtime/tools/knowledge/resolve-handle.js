/**
 * Resolve Handle Action — given a gallery `@handle` (or several),
 * return the absolute file path on disk plus the media metadata.
 *
 * Why this tool exists:
 *   The GUI already injects an `@handle = /path/...` mapping into the
 *   user's message before it reaches the agent (see input_bar.dart's
 *   `_resolveMentions` → message-text injection). That covers the
 *   happy path — the agent sees the path inline with the question
 *   and never needs a tool call.
 *
 *   This tool is the FALLBACK for everything else:
 *     • Sub-delegated tasks where the parent passed `@handle` in
 *       free-text without the resolution map (the runtime can't
 *       walk every nested task spec automatically).
 *     • Direct CLI use (no GUI to inject anything).
 *     • Agents the user reaches via `delegate` that ended up with
 *       only a `@handle` token and no path.
 *     • Race conditions where the gallery row was created AFTER the
 *       user pressed Enter (rare but real).
 *
 * Without this fallback, the agent's only option is `recall_memory` /
 * `recall_image` / `find . -name "*handle*"` / `ls -R ~/.koi/...` —
 * each one a wasted round-trip on something that's a single index
 * lookup.
 *
 * Returns the resolved path AS A STRING, NOT as a vision attachment.
 * That's intentional: this is "tell me where X lives", not "let me
 * see X". For images you actually want to look at, keep using
 * `recall_image`.
 */

import fs from 'node:fs';
import { channel } from '../../io/channel.js';

function _normaliseHandle(h) {
  if (h == null) return '';
  let s = String(h).trim();
  if (s.startsWith('@')) s = s.slice(1);
  return s;
}

export default {
  type: 'resolve_handle',
  intent: 'resolve_handle',
  description:
    'Resolve one or more gallery `@handle` mentions to absolute file paths on disk. '
    + 'Use whenever you have a `@handle` token (e.g. "@video123", "@hero_pose") and need '
    + "to know which file it points to — BEFORE reaching for `recall_memory`, `find`, `ls`, "
    + 'or `recall_image`. This is a single indexed lookup; the alternatives are slow guesses.'
    + '\n\nFields:'
    + '\n  • "handle" (string, optional): one handle like "@video123" or "video123".'
    + '\n  • "handles" (string[], optional): batch lookup. Each entry is one handle.'
    + '\n  At least one of `handle` / `handles` must be provided.'
    + '\n\nReturns: '
    + '\n  { success: true, resolved: [{ handle, path, mediaType, mention, filename, '
    + 'description, mediaId }], missing: [<handles not found>] }'
    + '\n  Each `resolved[i].path` is the absolute file path you can pass to '
    + '`add_clip_to_timeline`, `read_file`, `generate_image` (as referenceImages), etc.'
    + ' If a handle exists in the gallery but its file is missing on disk, it goes into '
    + '`missing` with a reason — the row is still listed so you can decide whether to '
    + 'regenerate or ask the user. '
    + 'For images you also want to LOOK AT, follow up with `recall_image` using the same '
    + 'handle; this tool gives the path, that tool gives the pixels.',
  thinkingHint: (action) => {
    const list = Array.isArray(action.handles) ? action.handles : [];
    const single = action.handle ? [action.handle] : [];
    const all = [...single, ...list].slice(0, 3).map(_normaliseHandle).filter(Boolean);
    if (all.length === 0) return 'Resolving handle';
    return `Resolving @${all.join(', @')}${(list.length + single.length) > 3 ? '…' : ''}`;
  },
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'A single gallery handle, with or without the leading `@`. '
          + 'Example: "@video123" or "video123".',
      },
      handles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Batch form — array of handles to resolve in one call. '
          + 'Useful when a task spec mentions several `@xxx` references at once.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'resolve_handle', handle: '@video123' },
    { actionType: 'direct', intent: 'resolve_handle', handle: 'hero_pose' },
    { actionType: 'direct', intent: 'resolve_handle', handles: ['@intro_clip', '@outro_music'] },
  ],

  async execute(action) {
    const wanted = [];
    if (action.handle) wanted.push(_normaliseHandle(action.handle));
    if (Array.isArray(action.handles)) {
      for (const h of action.handles) {
        const norm = _normaliseHandle(h);
        if (norm && !wanted.includes(norm)) wanted.push(norm);
      }
    }
    const deduped = [];
    for (const h of wanted) {
      if (h && !deduped.includes(h)) deduped.push(h);
    }
    if (deduped.length === 0) {
      return {
        success: false,
        error: 'resolve_handle requires "handle" (string) OR "handles" (array of strings).',
      };
    }

    let lib;
    try {
      const mod = await import('../../state/media-library.js');
      lib = mod.MediaLibrary.global();
    } catch (err) {
      return {
        success: false,
        error: `Gallery lookup unavailable: ${err.message}`,
      };
    }

    const resolved = [];
    const missing = [];
    for (const handle of deduped) {
      let row = null;
      try {
        const matches = await lib.findByMention(handle);
        if (matches.length > 0) row = matches[0]; // newest-first contract
      } catch (err) {
        missing.push({ handle: `@${handle}`, reason: `lookup failed: ${err.message}` });
        continue;
      }
      if (!row) {
        missing.push({ handle: `@${handle}`, reason: 'no gallery row with that @handle' });
        continue;
      }
      if (!row.filePath) {
        missing.push({
          handle: `@${handle}`,
          mediaId: row.id,
          reason: 'gallery row has no filePath',
        });
        continue;
      }
      if (!fs.existsSync(row.filePath)) {
        missing.push({
          handle: `@${handle}`,
          mediaId: row.id,
          path: row.filePath,
          reason: 'gallery row resolved but file is missing on disk',
        });
        continue;
      }
      resolved.push({
        handle: `@${handle}`,
        path: row.filePath,
        mediaType: row.mediaType || null,
        mention: row.mention || handle,
        filename: row.filename || null,
        description: row.description || null,
        mediaId: row.id || null,
      });
    }

    channel.log(
      'resolve_handle',
      `resolved ${resolved.length}/${deduped.length} (missing: ${missing.length})`,
    );

    return {
      success: resolved.length > 0 || missing.length === 0,
      resolved,
      missing,
    };
  },
};
