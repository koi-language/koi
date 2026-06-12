/**
 * call_mcp action - Call a tool on an MCP (Model Context Protocol) server.
 *
 * Used by the LLM to invoke external tools exposed via MCP stdio servers.
 */
import { getDecision, currentMap } from '../../llm/providers/mcp-media-store.js';

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

    // Media-enabled servers: their mapped GENERATION tools must go through the
    // host media pipeline (generate_image/generate_video/…), never raw — a raw
    // call produces an untracked result (nothing saved locally, no gallery/
    // drawer indexing, no progress UI) while looking like a success to the
    // agent, which then falsely reports the task as done. Data-driven from the
    // server's media map; all other tools on the server stay callable.
    try {
      if (getDecision(mcp) === 'enabled') {
        const media = currentMap(mcp, client);
        const gen = (media && media.generate) || {};
        const blocked = new Set([
          gen.image && gen.image.tool,
          gen.video && gen.video.tool,
          gen.audio && gen.audio.speech && gen.audio.speech.tool,
          gen.audio && gen.audio.music && gen.audio.music.tool,
          ...Object.values((media && media.operations) || {}).map(r => r && r.tool),
        ].filter(Boolean));
        if (blocked.has(tool)) {
          throw new Error(
            `call_mcp: "${mcp}.${tool}" is the media GENERATION route of this server and must not be called raw — `
            + `use the host action (generate_image / generate_video / generate_audio or the matching operation) so the `
            + `result is saved and tracked. If that action failed, report the failure to the user instead of working around it.`
          );
        }
      }
    } catch (guardErr) {
      // Only re-throw the guard's own rejection; a store hiccup must not
      // break unrelated call_mcp usage.
      if (String(guardErr.message || '').startsWith('call_mcp:')) throw guardErr;
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
