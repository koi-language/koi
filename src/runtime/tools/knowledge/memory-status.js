/**
 * memory_status — orient on what's in the project memory vault.
 *
 * Equivalent of Ori's `health` / `status` MCP method. Cheap diagnostic that
 * returns:
 *   - total note count and inbox count
 *   - breakdown by type (decision, learning, insight, …)
 *   - breakdown by project tag
 *   - "fading" notes — lowest vitality scores (candidates for review/prune)
 *   - recent memory writes from the current session
 *
 * Use when:
 *   - Starting a new task and you want to know whether the vault has anything
 *     about the area (before deciding whether to call recall_memory or just
 *     ask the user).
 *   - The user asks "what do you know about <topic>?" — call memory_status
 *     first to see if the topic has its own project tag, then recall_memory
 *     for the actual content.
 *   - You suspect notes are getting stale and want to surface fading ones.
 *
 * Don't use when:
 *   - You just want to find a specific note — recall_memory is direct.
 *   - You already called this in the same task and the count won't have
 *     changed meaningfully.
 */

import * as memory from '../../memory/index.js';

export default {
  type: 'memory_status',
  intent: 'memory_status',
  description:
    'Return a snapshot of the project memory vault: note count, inbox count, ' +
    'breakdown by type and project, the lowest-vitality (fading) notes, and ' +
    'recent memory writes from this session. Cheap to call — no LLM, just ' +
    'filesystem + SQLite reads. Use to orient on what the vault contains ' +
    'before deciding how (or whether) to retrieve.',
  thinkingHint: 'Reading memory status',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      fading_limit: {
        type: 'number',
        description: 'How many fading notes to return. Default 5.',
      },
      recent_limit: {
        type: 'number',
        description: 'How many recent memory writes to return. Default 10.',
      },
    },
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'memory_status',
    },
    {
      actionType: 'direct',
      intent: 'memory_status',
      fading_limit: 10,
      recent_limit: 5,
    },
  ],

  async execute(action, agent) {
    try {
      await memory.ensureInit(agent);
    } catch {
      return { success: true, status: null, message: 'Memory unavailable.' };
    }

    try {
      const status = await memory.getStatus({
        fadingLimit: typeof action.fading_limit === 'number' ? action.fading_limit : 5,
        recentLimit: typeof action.recent_limit === 'number' ? action.recent_limit : 10,
      });
      return {
        success: true,
        note_count: status.noteCount,
        inbox_count: status.inboxCount,
        types: status.types,
        projects: status.projects,
        fading: status.fading,
        recent: status.recent,
        vault_root: status.vaultRoot,
        vault_source: status.vaultSource,
      };
    } catch (err) {
      return { success: false, error: `memory_status failed: ${err.message}` };
    }
  },
};
