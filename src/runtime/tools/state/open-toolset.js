/**
 * Open Toolset — list the tools in a toolset group.
 *
 * The system prompt shows toolsets (groups of related tools) instead of
 * individual tools. Call this to see the compact list of tools in a
 * specific toolset before using them.
 */

export default {
  type: 'open_toolset',
  intent: 'open_toolset',
  description: 'List the tools in a toolset group. Shows name, description, and parameters for each tool.',
  thinkingHint: 'Opening toolset',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      toolset: {
        type: 'string',
        description: 'The toolset name (e.g. "file", "shell", "lsp", "web", "knowledge")',
      },
    },
    required: ['toolset'],
  },

  async execute(action, agent) {
    const { toolset } = action;
    if (!toolset) {
      return { success: false, error: 'Missing "toolset" parameter' };
    }
    // Dynamic import to avoid circular dependency (action-registry loads us)
    const { actionRegistry } = await import('../../agent/action-registry.js');
    const doc = actionRegistry.getToolsetDocumentation(toolset, agent);
    if (!doc) {
      return { success: false, error: `Unknown toolset: "${toolset}"` };
    }
    return { success: true, toolset, documentation: doc };
  },
};
