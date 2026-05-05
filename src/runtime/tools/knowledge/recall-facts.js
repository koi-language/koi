/**
 * Recall Facts Action — retrieve shared knowledge from the memory vault.
 *
 * Backed by the new memory architecture. External API preserved for backward
 * compat with existing .koi agent prompts.
 *
 * Note for future: under the new architecture this action becomes increasingly
 * redundant — the Context Compiler retrieves relevant memories proactively per
 * agent slot map. recall_facts remains as an explicit escape hatch and produces
 * a telemetry signal: high call frequency suggests the slot map needs tuning.
 */

import * as memory from '../../memory/index.js';

export default {
  type: 'recall_facts',
  intent: 'recall_facts',
  description: 'Retrieve shared knowledge discovered by other agents. Returns facts learned this session (and persisted across sessions in the project memory vault). Most contexts already include relevant memory — only call when you need to look up something specific that was not in your prompt. Fields: "category" (optional filter).',
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

  async execute(action, agent) {
    const { category } = action;

    try {
      await memory.ensureInit(agent);
    } catch (err) {
      return { success: true, knowledge: 'Memory unavailable.' };
    }

    // Single list call, then partition by `_plan` tag to separate session vs plan facts.
    const filter = { type: 'learning', status: 'active' };
    if (category) filter.project = category;
    const allFacts = await memory.list({ filter, limit: 70 });

    const planFacts = allFacts.filter((f) => (f.frontmatter.project || []).includes('_plan'));
    const sessionOnly = allFacts.filter((f) => !(f.frontmatter.project || []).includes('_plan'));

    const sections = [];
    if (sessionOnly.length > 0) {
      const lines = sessionOnly.map((f) => {
        const proj = (f.frontmatter.project || []).filter((p) => p !== '_plan').join(',');
        const desc = f.frontmatter.description || '';
        return `- [${proj || 'general'}] **${f.title}**: ${desc}`;
      });
      sections.push(`## Session knowledge\n_Durable project facts._\n\n${lines.join('\n')}`);
    }
    if (planFacts.length > 0) {
      const lines = planFacts.map((f) => {
        const desc = f.frontmatter.description || '';
        return `- **${f.title}**: ${desc}`;
      });
      sections.push(`## Plan knowledge\n_Implementation details from sibling tasks — use them._\n\n${lines.join('\n')}`);
    }

    if (sections.length === 0) {
      return { success: true, knowledge: 'No shared knowledge stored yet.' };
    }
    return {
      success: true,
      knowledge: sections.join('\n\n'),
      count: sessionOnly.length + planFacts.length,
    };
  },
};
