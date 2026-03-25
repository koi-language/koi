/**
 * Recall Image Action - Retrieve a previously captured screenshot.
 *
 * Loads an image from the session's image store and re-injects it into
 * the LLM context via the existing _pendingMcpImages pipeline.
 *
 * Lookup modes:
 *   - By exact ID:  { "id": "screenshot-001" }
 *   - By search:    { "search": "login" }  (substring match on description/source/id)
 *   - Most recent:  {} (no params → returns the latest screenshot)
 */

import { sessionTracker } from '../../state/session-tracker.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'recall_image',
  intent: 'recall_image',
  description: 'Retrieve a previously captured screenshot and re-inject it into context. '
    + 'Fields: "id" (optional: exact image ID like "screenshot-001"), '
    + '"search" (optional: text to match in description/source/id). '
    + 'If neither is given, returns the most recent screenshot. '
    + 'Returns: { imageId, content: [image, text] }',
  thinkingHint: (action) => `Recalling image${action.id ? ` ${action.id}` : ''}`,
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Exact image ID (e.g. "screenshot-001").',
      },
      search: {
        type: 'string',
        description: 'Search text to match against description, source, or id.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'recall_image' },
    { actionType: 'direct', intent: 'recall_image', id: 'screenshot-001' },
    { actionType: 'direct', intent: 'recall_image', search: 'login screen' },
  ],

  async execute(action) {
    if (!sessionTracker) {
      return { success: false, error: 'No active session — cannot recall images.' };
    }

    const index = sessionTracker.loadImageIndex();
    if (index.length === 0) {
      return { success: false, error: 'No screenshots have been captured in this session.' };
    }

    let entry = null;

    if (action.id) {
      // Exact ID lookup
      entry = index.find(e => e.id === action.id);
      if (!entry) {
        const available = index.map(e => `  ${e.id}: ${e.description || e.source}`).join('\n');
        return {
          success: false,
          error: `Image "${action.id}" not found. Available images:\n${available}`,
        };
      }
    } else if (action.search) {
      // Substring search
      const matches = sessionTracker.searchImages(action.search);
      if (matches.length === 0) {
        const available = index.map(e => `  ${e.id}: ${e.description || e.source}`).join('\n');
        return {
          success: false,
          error: `No images matching "${action.search}". Available images:\n${available}`,
        };
      }
      // Use the most recent match
      entry = matches[matches.length - 1];
    } else {
      // Most recent
      entry = index[index.length - 1];
    }

    // Load the image from disk
    const result = sessionTracker.getImage(entry.id);
    if (!result) {
      return { success: false, error: `Image file for "${entry.id}" could not be read from disk.` };
    }

    const base64 = result.buffer.toString('base64');
    channel.log('recall_image', `Recalled ${entry.id} (${entry.source})`);

    // Return MCP content format (consumed by classifyFeedback → _pendingMcpImages pipeline)
    return {
      imageId: entry.id,
      source: entry.source,
      content: [
        { type: 'image', data: base64, mimeType: entry.mimeType || 'image/png' },
        { type: 'text', text: `Recalled ${entry.id} (${entry.source})${entry.description ? ': ' + entry.description : ''}` },
      ],
    };
  },
};
