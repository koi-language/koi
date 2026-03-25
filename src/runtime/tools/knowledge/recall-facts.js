/**
 * Recall Facts Action — retrieve shared session knowledge discovered by any agent.
 *
 * Use this when starting a new task to check what other agents have already
 * learned (tech stacks, file paths, config values, service URLs, etc.) so you
 * don't rediscover it yourself.
 *
 * Without a category filter it returns all facts. Filter by category to narrow
 * results when you only need a specific type (e.g. "path", "tech_stack").
 */

import { sessionKnowledge } from '../../state/session-knowledge.js';

export default {
  type: 'recall_facts',
  intent: 'recall_facts',
  description: 'Retrieve shared session knowledge discovered by other agents. Use at task start to avoid rediscovering what others already know. Fields: "category" (optional — tech_stack|path|config|credential|status|dependency|other to filter). Returns: all stored facts as a formatted list, or a message if none exist.',
  thinkingHint: 'Recalling knowledge',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['tech_stack', 'path', 'config', 'credential', 'status', 'dependency', 'other'],
        description: 'Optional: filter facts by category. Omit to get all facts.',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'recall_facts' },
    { actionType: 'direct', intent: 'recall_facts', category: 'path' },
    { actionType: 'direct', intent: 'recall_facts', category: 'tech_stack' },
  ],

  async execute(action) {
    const { category } = action;

    if (sessionKnowledge.size === 0) {
      return { success: true, knowledge: 'No shared knowledge stored yet in this session.' };
    }

    if (category) {
      const facts = sessionKnowledge.recall(category);
      if (facts.length === 0) {
        return { success: true, knowledge: `No facts stored for category "${category}" yet.` };
      }
      const lines = facts.map(f => `- [${f.category}] **${f.key}**: ${f.value}  _(learned by ${f.agentName})_`);
      return {
        success: true,
        knowledge: `## Session knowledge — ${category}\n\n${lines.join('\n')}`,
        count: facts.length,
      };
    }

    const formatted = sessionKnowledge.format();
    return {
      success: true,
      knowledge: formatted,
      count: sessionKnowledge.size,
    };
  },
};
