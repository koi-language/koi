/**
 * read_memory — fetch the full content of a single memory note.
 *
 * Default retrieval (`recall_memory` / `explore_memory`) returns the title +
 * score + a short description preview. That's enough to decide whether a
 * note is relevant. When you need the actual content — the body of the
 * note, including the `## Transcript` of an episode for example — call
 * `read_memory({ title })`.
 *
 * Pattern:
 *   1. recall_memory({ query }) → ranked list with title + description
 *   2. (agent decides one looks relevant)
 *   3. read_memory({ title }) → full body for that note
 *
 * Use specifically for:
 *   - Episode notes (`type: episode`) whose description is a summary —
 *     the body holds the full raw transcript of past turns.
 *   - Decisions / learnings whose 200-char description doesn't show the
 *     rationale; the body has the long-form details.
 *
 * Don't use:
 *   - To re-fetch a note you already opened this turn — the content is
 *     in the conversation now.
 *   - Without first knowing the title (call recall_memory or
 *     memory_status to discover what exists).
 */

import * as memory from '../../memory/index.js';

export default {
  type: 'read_memory',
  intent: 'read_memory',
  description:
    'Open a single memory note by title and return its full body + ' +
    'frontmatter. Use after recall_memory / explore_memory when the ' +
    'description preview is not enough — most commonly for `episode` ' +
    'notes whose body holds the raw transcript of past conversation ' +
    'turns. Returns `{ frontmatter, body }`.',
  thinkingHint: 'Reading memory note',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'The note title (slug) returned by recall_memory or ' +
          'explore_memory. E.g. "episode-fix-login-401-error".',
      },
    },
    required: ['title'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'read_memory',
      title: 'episode-fix-login-401-error',
    },
  ],

  async execute(action, agent) {
    const { title } = action;
    if (!title || typeof title !== 'string') {
      return { success: false, error: 'read_memory: title (string) is required' };
    }

    try {
      await memory.ensureInit(agent);
    } catch {
      return { success: true, found: false, message: 'Memory unavailable.' };
    }

    try {
      const note = await memory.read({ title });
      if (!note) {
        return { success: true, found: false, message: `No note titled "${title}".` };
      }
      return {
        success: true,
        found: true,
        title: note.title,
        type: note.frontmatter?.type ?? null,
        description: note.frontmatter?.description ?? '',
        project: note.frontmatter?.project ?? [],
        status: note.frontmatter?.status ?? null,
        created: note.frontmatter?.created ?? null,
        body: note.body,
      };
    } catch (err) {
      return { success: false, error: `read_memory failed: ${err.message}` };
    }
  },
};
