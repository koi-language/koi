/**
 * Recall Image Action — fetch a previously captured / generated image
 * by ID, by `@mention` handle, or by free-text search, and re-inject
 * it into the LLM context via the standard image-attachment pipeline.
 *
 * Lookup priority (first hit wins):
 *   1. Session screenshots         — captured by the `screenshot` action
 *                                    in the current session.
 *   2. Project gallery `@mention`  — `@pipo`, `@madriguera`, etc.
 *                                    (the same handles the chat input
 *                                    autocompletes against).
 *   3. Project gallery search      — substring match on filename /
 *                                    description / mention.
 *   4. Project gallery most recent — fallback when no params given.
 *
 * Pre-fix this only knew about (1) and silently returned "No screenshots
 * have been captured in this session." for everything else, which made
 * the agent waste turns falling back to `ls + image_info + read_file`
 * to do what should be a one-shot lookup.
 */

import fs from 'node:fs';
import { sessionTracker } from '../../state/session-tracker.js';
import { channel } from '../../io/channel.js';

const _IMAGE_MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic',
};

function _mimeFromPath(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return _IMAGE_MIMES[ext] || 'image/png';
}

export default {
  type: 'recall_image',
  intent: 'recall_image',
  description:
    'Fetch a previously captured screenshot OR a previously generated/imported image '
    + 'from the project gallery, and re-inject it into your context as a vision attachment. '
    + 'Search order: session screenshots → gallery by @mention → gallery substring search '
    + '→ most recent gallery item. '
    + '\n\nFields:'
    + '\n  • "mention" (optional): a gallery handle like "@pipo" or "pipo". This is the '
    + 'preferred lookup for project images the user has tagged — they map to a single '
    + 'specific asset (newest if multiple share the handle).'
    + '\n  • "id" (optional): exact image ID for a session screenshot.'
    + '\n  • "search" (optional, alias "q"): substring matched against id / description / '
    + 'filename / source. Use when you remember a topic but not a handle.'
    + '\n  • No fields: returns the most recent gallery image.'
    + '\n\nReturns: { imageId, source, content: [image, text] } and the image is attached '
    + 'to your next LLM turn for visual analysis. Use this INSTEAD of `ls + image_info + '
    + 'read_file` when you need to inspect an image you already know exists.',
  thinkingHint: (action) => `Recalling image${action.mention ? ` ${action.mention}` : (action.id ? ` ${action.id}` : '')}`,
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      mention: {
        type: 'string',
        description: 'Project gallery `@mention` handle (e.g. "@pipo", "pipo"). '
          + 'Resolves through MediaLibrary.findByMention — same lookup the chat '
          + 'input bar uses for `@` autocomplete.',
      },
      id: {
        type: 'string',
        description: 'Exact session-screenshot ID (e.g. "screenshot-001").',
      },
      search: {
        type: 'string',
        description: 'Substring match against image metadata (description, source, '
          + 'id, filename). Falls through to the project gallery when the session '
          + 'screenshot store is empty.',
      },
      q: {
        type: 'string',
        description: 'Alias for "search" — accepted because it is the most common '
          + 'parameter name LLMs reach for.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'recall_image', mention: '@pipo' },
    { actionType: 'direct', intent: 'recall_image', search: 'burrow wide shot' },
    { actionType: 'direct', intent: 'recall_image', id: 'screenshot-001' },
    { actionType: 'direct', intent: 'recall_image' },
  ],

  async execute(action) {
    // Normalise input. Accept both `search` and `q` as aliases. Strip
    // a leading `@` from mentions defensively — many LLM responses
    // pass it with the @ included.
    const id = action.id ? String(action.id).trim() : '';
    let mention = action.mention ? String(action.mention).trim() : '';
    if (mention.startsWith('@')) mention = mention.slice(1);
    const searchRaw = action.search || action.q || '';
    const search = searchRaw ? String(searchRaw).trim() : '';

    // ── 1. Session screenshots (legacy primary path) ─────────────────
    if (sessionTracker) {
      const index = sessionTracker.loadImageIndex();
      if (index.length > 0) {
        let entry = null;
        if (id) {
          entry = index.find((e) => e.id === id);
        } else if (search) {
          const matches = sessionTracker.searchImages(search);
          if (matches.length > 0) entry = matches[matches.length - 1];
        } else if (!mention) {
          // No params at all → most recent screenshot.
          entry = index[index.length - 1];
        }
        if (entry) {
          const result = sessionTracker.getImage(entry.id);
          if (!result) {
            return { success: false, error: `Image file for "${entry.id}" could not be read from disk.` };
          }
          const base64 = result.buffer.toString('base64');
          channel.log('recall_image', `Recalled session screenshot ${entry.id} (${entry.source})`);
          return {
            imageId: entry.id,
            source: entry.source,
            content: [
              { type: 'image', data: base64, mimeType: entry.mimeType || 'image/png' },
              { type: 'text', text: `Recalled ${entry.id} (${entry.source})${entry.description ? ': ' + entry.description : ''}` },
            ],
          };
        }
      }
    }

    // ── 2-4. Project gallery (MediaLibrary) ──────────────────────────
    let lib;
    try {
      const mod = await import('../../state/media-library.js');
      lib = mod.MediaLibrary.global();
    } catch (err) {
      return {
        success: false,
        error: `Gallery lookup unavailable (${err.message}). Session screenshot store is also empty.`,
      };
    }

    let row = null;
    if (mention) {
      // 2. By gallery @mention.
      try {
        const matches = await lib.findByMention(mention);
        if (matches.length > 0) row = matches[0]; // newest-first contract
      } catch { /* fall through */ }
      if (!row) {
        return {
          success: false,
          error: `No image with @mention "${mention}". Try: list_gallery to discover handles, or recall_image with "search" / "q".`,
        };
      }
    } else if (search) {
      // 3. By substring search on filename / description.
      try {
        const all = await lib.list({ mediaTypes: ['image'], limit: 5000 });
        const needle = search.toLowerCase();
        const matches = all.filter((it) => {
          if ((it.filename || '').toLowerCase().includes(needle)) return true;
          if ((it.description || '').toLowerCase().includes(needle)) return true;
          if ((it.mention || '').toLowerCase().includes(needle)) return true;
          return false;
        });
        if (matches.length > 0) row = matches[0]; // already newest-first
      } catch { /* fall through */ }
      if (!row) {
        return {
          success: false,
          error: `No image matched "${search}" in the project gallery.`,
        };
      }
    } else if (!id) {
      // 4. Most recent gallery image.
      try {
        const all = await lib.list({ mediaTypes: ['image'], limit: 1 });
        if (all.length > 0) row = all[0];
      } catch { /* fall through */ }
      if (!row) {
        return { success: false, error: 'No images in the project gallery yet.' };
      }
    } else {
      // id was set but didn't match a session screenshot AND no mention/search.
      return {
        success: false,
        error: `Screenshot id "${id}" not found in this session and no @mention/search provided to fall back on the project gallery.`,
      };
    }

    // Load the resolved gallery row from disk + return as a vision
    // attachment. Same content shape as the screenshot path so the
    // pendingMcpImages pipeline downstream stays uniform.
    if (!row.filePath || !fs.existsSync(row.filePath)) {
      return {
        success: false,
        error: `Gallery row resolved (id=${row.id}) but file missing on disk: ${row.filePath}`,
      };
    }
    let buffer;
    try { buffer = fs.readFileSync(row.filePath); }
    catch (err) { return { success: false, error: `Read failed: ${err.message}` }; }
    const base64 = buffer.toString('base64');
    const tag = mention ? `@${mention}` : (search ? `match:"${search}"` : 'most-recent');
    channel.log('recall_image', `Recalled gallery ${row.id} ${tag} (${row.filePath})`);
    return {
      imageId: row.id,
      source: row.filePath,
      content: [
        { type: 'image', data: base64, mimeType: row.mimeType || _mimeFromPath(row.filePath) },
        { type: 'text', text: `Recalled gallery image ${tag} → ${row.filePath}${row.description ? ': ' + row.description : ''}` },
      ],
    };
  },
};
