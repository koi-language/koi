/**
 * get_mcp_tool_info — Returns the full description and parameter schema of
 * a specific MCP tool. Use this before calling a tool when you are unsure
 * about the required parameters or their types.
 */
export default {
  type: 'get_mcp_tool_info',
  intent: 'get_mcp_tool_info',
  description: 'Get the full description and parameter schema of an MCP tool. Use when unsure how to call a tool.',
  thinkingHint: 'Looking up tool info',
  permission: 'call_mcp',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      mcp:  { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name to look up' },
    },
    required: ['mcp', 'tool'],
  },

  async execute(action) {
    const { mcp, tool } = action;

    if (!mcp)  throw new Error('get_mcp_tool_info: "mcp" field is required');
    if (!tool) throw new Error('get_mcp_tool_info: "tool" field is required');

    const mcpRegistry = globalThis.mcpRegistry;
    if (!mcpRegistry) {
      throw new Error('get_mcp_tool_info: MCP registry not available');
    }

    const client = mcpRegistry.get(mcp);
    if (!client) {
      throw new Error(`get_mcp_tool_info: MCP server "${mcp}" is not registered`);
    }

    const toolDef = (client.tools ?? []).find(t => t.name === tool);
    if (!toolDef) {
      const available = (client.tools ?? []).map(t => t.name).join(', ');
      throw new Error(`get_mcp_tool_info: Tool "${tool}" not found in "${mcp}". Available: ${available}`);
    }

    // Build a structured description the LLM can read
    const schema     = toolDef.inputSchema ?? {};
    const required   = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};

    const params = Object.entries(properties).map(([name, def]) => ({
      name,
      required: required.has(name),
      type: def.type ?? 'any',
      description: def.description ?? '',
      enum: def.enum ?? undefined,
    }));

    return {
      mcp,
      tool: toolDef.name,
      fullName: `mcp__${mcp}__${toolDef.name}`,
      description: toolDef.description ?? '',
      annotations: toolDef.annotations ?? {},
      parameters: params,
      requiredParameters: params.filter(p => p.required).map(p => p.name),
      optionalParameters: params.filter(p => !p.required).map(p => p.name),
    };
  },
};
