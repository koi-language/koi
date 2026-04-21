/**
 * open_mcp — list the tools exposed by an MCP server.
 *
 * The system prompt only advertises MCP server names (+ a short description)
 * to keep the context lean when many servers are connected. Call this action
 * to expand one server and see its tools. For the full parameter schema of
 * an individual tool, follow up with get_mcp_tool_info.
 */
export default {
  type: 'open_mcp',
  intent: 'open_mcp',
  description: 'List the tools exposed by an MCP server. Shows name, short description, and parameter names for each tool.',
  thinkingHint: 'Opening MCP server',
  permission: 'call_mcp',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      mcp: {
        type: 'string',
        description: 'The MCP server name (from AVAILABLE MCP SERVERS)',
      },
    },
    required: ['mcp'],
  },

  async execute(action, agent) {
    const { mcp } = action;
    if (!mcp) {
      return { success: false, error: 'Missing "mcp" parameter' };
    }

    const mcpRegistry = globalThis.mcpRegistry;
    if (!mcpRegistry) {
      return { success: false, error: 'MCP registry not available' };
    }

    const client = mcpRegistry.get(mcp);
    if (!client) {
      const available = [...mcpRegistry.entries()].map(([n]) => n).join(', ') || '(none)';
      return { success: false, error: `Unknown MCP server "${mcp}". Available: ${available}` };
    }

    // Enforce the same access rules as call_mcp: global servers are always
    // accessible, per-agent servers must be in the agent's usesMCPNames list.
    const isGlobal = mcpRegistry.isGlobal(mcp);
    if (!isGlobal && agent?.usesMCPNames?.length > 0 && !agent.usesMCPNames.includes(mcp)) {
      return { success: false, error: `Agent ${agent.name} does not have access to MCP "${mcp}"` };
    }

    // Connect lazily if the server hasn't been contacted yet.
    if (!client.initialized) {
      try {
        await client.connect();
      } catch (err) {
        return { success: false, error: `Failed to connect to MCP "${mcp}": ${err.message}` };
      }
    }

    const tools = (client.tools ?? []).map(t => {
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      const paramKeys = Object.keys(props);
      return {
        name: t.name,
        description: t.description ?? '',
        params: paramKeys.map(k => (required.has(k) ? k : `${k}?`)),
      };
    });

    return {
      success: true,
      mcp,
      toolCount: tools.length,
      tools,
      hint: 'Call get_mcp_tool_info({ mcp, tool }) for the full parameter schema of a specific tool, then call_mcp to invoke it.',
    };
  },
};
