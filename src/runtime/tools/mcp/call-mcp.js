/**
 * call_mcp action - Call a tool on an MCP (Model Context Protocol) server.
 *
 * Used by the LLM to invoke external tools exposed via MCP stdio servers.
 */
export default {
  type: 'call_mcp',
  intent: 'call_mcp',
  description: 'Call a tool on an MCP server. Requires: mcp (server name), tool (tool name), input (parameters object)',
  thinkingHint: 'Processing tool result',
  permission: 'call_mcp',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      mcp: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name to invoke' },
      input: { type: 'object', description: 'Tool input parameters' }
    },
    required: ['mcp', 'tool']
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'call_mcp',
      mcp: 'mobileMCP',
      tool: 'tap',
      input: { x: 100, y: 200 }
    },
    {
      actionType: 'direct',
      intent: 'call_mcp',
      mcp: 'mobileMCP',
      tool: 'screenshot',
      input: {}
    }
  ],

  async execute(action, agent) {
    const { mcp, tool, input = {} } = action;

    if (!mcp) {
      throw new Error('call_mcp: "mcp" field is required (MCP server name)');
    }
    if (!tool) {
      throw new Error('call_mcp: "tool" field is required (tool name)');
    }

    // Get the global mcpRegistry
    const mcpRegistry = globalThis.mcpRegistry;
    if (!mcpRegistry) {
      throw new Error('call_mcp: MCP registry not available. Make sure MCP servers are declared in your .koi file.');
    }

    // Verify agent has access to this MCP (global servers bypass this check)
    const isGlobal = mcpRegistry.isGlobal(mcp);
    if (!isGlobal && agent.usesMCPNames && agent.usesMCPNames.length > 0 && !agent.usesMCPNames.includes(mcp)) {
      throw new Error(`Agent ${agent.name} does not have access to MCP: ${mcp}. Available: ${agent.usesMCPNames.join(', ')}`);
    }

    // Check MCP server status — auto-reconnect if it crashed
    const client = mcpRegistry.get(mcp);
    if (!client) {
      throw new Error(`MCP server "${mcp}" is not registered. Check your .koi file.`);
    }
    if (!client.initialized) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[call_mcp] MCP "${mcp}" is down, reconnecting...`);
      }
      await client.connect();
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[call_mcp] ${mcp}.${tool}(${JSON.stringify(input).substring(0, 200)})`);
    }

    const result = await mcpRegistry.callTool(mcp, tool, input);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[call_mcp] Result: ${JSON.stringify(result).substring(0, 200)}`);
    }

    // When the MCP tool returns an error, attach recent stderr output
    // so the LLM can see actual error details (e.g. installation commands).
    // MCP servers often print detailed instructions to stderr but only return
    // a summary message in the result payload.
    if (result && result.success === false && client._stderrLines?.length > 0) {
      const stderrContext = client._stderrLines.join('\n');
      result.serverOutput = stderrContext;
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[call_mcp] Attached ${client._stderrLines.length} stderr lines to error result`);
      }
    }

    return result;
  }
};
