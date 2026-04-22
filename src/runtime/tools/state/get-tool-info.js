/**
 * Get Tool Info — retrieve full documentation for a built-in action.
 *
 * The system prompt only shows compact summaries (name + short description).
 * Call this when you need the full schema, instructions, and examples for
 * a specific action before using it.
 */

export default {
  type: 'get_tool_info',
  intent: 'get_tool_info',
  description: 'Get full documentation (schema, instructions, examples) for a built-in action. Use when you need parameter details before calling an action.',
  thinkingHint: 'Looking up tool info',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: 'The intent name of the action to look up (e.g. "edit_file", "shell", "semantic_code_search")',
      },
    },
    required: ['tool'],
  },

  async execute(action, agent) {
    const { tool } = action;
    if (!tool) {
      return { success: false, error: 'Missing "tool" parameter' };
    }
    // Dynamic import to avoid circular dependency (action-registry loads us)
    const { actionRegistry } = await import('../../agent/action-registry.js');
    const doc = actionRegistry.getActionDocumentation(tool);
    if (!doc) {
      return { success: false, error: `Unknown action: "${tool}"` };
    }
    // Remember that THIS agent asked for the full schema of this tool.
    // action-registry.generateToolsetDocumentation reads this set and
    // splices the full entry into every subsequent prompt for this
    // agent — so the model doesn't forget the parameter details three
    // iterations later and re-guess them (we hit this with resolution
    // "2K" vs a fleet advertising only ["low","medium","high","ultra"]).
    // Scoped to one agent instance, so delegates don't inherit siblings'
    // expansions.
    if (agent) {
      if (!(agent._expandedTools instanceof Set)) agent._expandedTools = new Set();
      agent._expandedTools.add(tool);
    }
    return { success: true, tool, documentation: doc };
  },
};
