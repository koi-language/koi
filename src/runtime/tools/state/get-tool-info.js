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

  async execute(action) {
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
    return { success: true, tool, documentation: doc };
  },
};
