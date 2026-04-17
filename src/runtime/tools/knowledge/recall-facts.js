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

import { sessionKnowledge, planKnowledge } from '../../state/session-knowledge.js';

export default {
  type: 'recall_facts',
  intent: 'recall_facts',
  description: 'Retrieve shared knowledge discovered by other agents. Returns BOTH session-level facts (durable project knowledge) AND plan-level facts (transient implementation details shared between tasks of the current plan). Use at task start to avoid rediscovering what others already know. Fields: "category" (optional filter).',
  thinkingHint: 'Recalling knowledge',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['tech_stack', 'path', 'config', 'credential', 'status', 'dependency'],
        description: 'Optional: filter facts by category. Omit to get all facts.',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'recall_facts' },
    { actionType: 'direct', intent: 'recall_facts', category: 'path' },
  ],

  async execute(action) {
    const { category } = action;
    const sections = [];

    // Session knowledge (durable)
    const sessionFacts = category
      ? sessionKnowledge.recall(category)
      : sessionKnowledge.recall();
    if (sessionFacts.length > 0) {
      const lines = sessionFacts.map(f =>
        `- [${f.category}] **${f.key}**: ${f.value}  _(by ${f.agentName})_`
      );
      sections.push(`## Session knowledge\n_Durable project facts._\n\n${lines.join('\n')}`);
    }

    // Plan knowledge (transient, cleared when plan completes)
    const planFacts = category
      ? planKnowledge.recall(category)
      : planKnowledge.recall();
    if (planFacts.length > 0) {
      const lines = planFacts.map(f =>
        `- [${f.category}] **${f.key}**: ${f.value}  _(by ${f.agentName})_`
      );
      sections.push(`## Plan knowledge\n_Implementation details from sibling tasks — use them._\n\n${lines.join('\n')}`);
    }

    if (sections.length === 0) {
      return { success: true, knowledge: 'No shared knowledge stored yet.' };
    }

    return {
      success: true,
      knowledge: sections.join('\n\n'),
      count: sessionFacts.length + planFacts.length,
    };
  },
};
