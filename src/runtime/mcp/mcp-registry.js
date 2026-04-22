import { MCPStdioClient } from './mcp-stdio-client.js';
import { MCPHttpClient } from './mcp-http-client.js';

/**
 * MCP Registry - Global registry of MCP client instances.
 * Similar to SkillRegistry but for MCP stdio servers.
 */
class MCPRegistry {
  constructor() {
    this.clients = new Map();
    this._globalNames = new Set();
  }

  /**
   * Register an MCP server configuration.
   * Does NOT connect immediately (lazy connection on first use).
   * @param {string} name - MCP server name (e.g., "mobileMCP")
   * @param {object} config - { type?, command?, args?, env?, url? }
   */
  register(name, config) {
    if (this.clients.has(name)) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCPRegistry] Re-registering MCP: ${name}`);
      }
    }

    let client;
    if (config.type === 'http') {
      client = new MCPHttpClient(name, config);
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCPRegistry] Registered MCP: ${name} (http ${config.url})`);
      }
    } else {
      client = new MCPStdioClient(name, config);
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCPRegistry] Registered MCP: ${name} (${config.command} ${(config.args || []).join(' ')})`);
      }
    }

    // Optional hints shown in the compact system-prompt listing. Avoids
    // re-reading .mcp.json at prompt-build time.
    client.description = typeof config.description === 'string' ? config.description : '';
    client.lazy = config.lazy === false ? false : true;

    this.clients.set(name, client);
  }

  /**
   * Register a global MCP server (from .mcp.json / KOI_GLOBAL_MCP_SERVERS).
   * Global servers bypass per-agent usesMCPNames access checks.
   * @param {string} name
   * @param {object} config
   */
  registerGlobal(name, config) {
    this.register(name, config);
    this._globalNames.add(name);
  }

  /**
   * Check if an MCP server was registered globally.
   * @param {string} name
   * @returns {boolean}
   */
  isGlobal(name) {
    return this._globalNames.has(name);
  }

  /**
   * Get a client by name.
   * @param {string} name - MCP server name
   * @returns {MCPStdioClient|undefined}
   */
  get(name) {
    return this.clients.get(name);
  }

  /**
   * Iterate all registered clients as [name, client] pairs.
   * @returns {IterableIterator<[string, MCPStdioClient|MCPHttpClient]>}
   */
  entries() {
    return this.clients.entries();
  }

  /**
   * Connect a specific MCP client (lazy initialization).
   * @param {string} name - MCP server name
   */
  async connect(name) {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`MCP '${name}' not registered`);
    }
    if (!client.initialized) {
      await client.connect();
    }
  }

  /**
   * Connect all registered MCP clients.
   */
  async connectAll() {
    const promises = [];
    for (const [name, client] of this.clients) {
      if (!client.initialized) {
        promises.push(client.connect().catch(err => {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[MCPRegistry] Failed to connect ${name}: ${err.message}`);
          }
        }));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Call a tool on a specific MCP server.
   * Connects lazily if not already connected.
   * @param {string} mcpName - MCP server name
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   * @returns {object} Tool result
   */
  async callTool(mcpName, toolName, args = {}) {
    const client = this.clients.get(mcpName);
    if (!client) {
      throw new Error(`MCP '${mcpName}' not registered`);
    }

    if (!client.initialized) {
      await client.connect();
    }

    return await client.callTool(toolName, args);
  }

  /**
   * Get compact server summaries for all registered MCPs.
   * Used by the system prompt builder in lazy mode — returns only the
   * server name, a short description and the tool count (no schemas).
   * @returns {Array<{name: string, description: string, lazy: boolean, toolCount: number, connected: boolean}>}
   */
  getServerSummaries() {
    const summaries = [];
    for (const [name, client] of this.clients) {
      summaries.push({
        name,
        description: client.description || '',
        lazy: client.lazy !== false,
        toolCount: Array.isArray(client.tools) ? client.tools.length : 0,
        connected: !!client.connected,
      });
    }
    return summaries;
  }

  /**
   * Get tool summaries for all registered MCPs.
   * Used for building system prompts.
   * @returns {Array<{name: string, tools: Array}>}
   */
  getToolSummaries() {
    const summaries = [];
    for (const [name, client] of this.clients) {
      if (client.tools.length > 0) {
        summaries.push({
          name,
          tools: client.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema
          }))
        });
      }
    }
    return summaries;
  }

  /**
   * Unregister a specific MCP server — disconnects if connected, then
   * drops it from the client map. Used by plugin uninstall/deactivate
   * so the per-plugin MCP doesn't linger in the registry after the
   * plugin files are gone.
   * @param {string} name
   */
  async unregister(name) {
    const client = this.clients.get(name);
    if (!client) return false;
    if (client.initialized) {
      try { await client.disconnect(); }
      catch (err) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[MCPRegistry] disconnect on unregister failed for ${name}: ${err.message}`);
        }
      }
    }
    this.clients.delete(name);
    this._globalNames.delete(name);
    return true;
  }

  /**
   * Disconnect all MCP clients gracefully.
   */
  async disconnectAll() {
    const promises = [];
    for (const [name, client] of this.clients) {
      if (client.initialized) {
        promises.push(client.disconnect().catch(err => {
          console.error(`[MCPRegistry] Failed to disconnect ${name}: ${err.message}`);
        }));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Check if any MCP servers are registered.
   */
  hasRegistered() {
    return this.clients.size > 0;
  }
}

// Singleton instance
export const mcpRegistry = new MCPRegistry();

// Make available globally for transpiled code
globalThis.mcpRegistry = mcpRegistry;

// Load global MCP servers from KOI_GLOBAL_MCP_SERVERS env var (set by koi-cli.js)
// AND from every active plugin's mcp.json. Store the connect promise so prompt
// builders can await it before listing tools.
mcpRegistry.globalReady = (async () => {
  if (process.env.KOI_GLOBAL_MCP_SERVERS) {
    try {
      const globalServers = JSON.parse(process.env.KOI_GLOBAL_MCP_SERVERS);
      for (const [name, config] of Object.entries(globalServers)) {
        mcpRegistry.registerGlobal(name, config);
      }
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCPRegistry] Loaded ${Object.keys(globalServers).length} global MCP server(s) from KOI_GLOBAL_MCP_SERVERS`);
      }
    } catch (err) {
      console.error(`[MCPRegistry] Failed to parse KOI_GLOBAL_MCP_SERVERS: ${err.message}`);
    }
  }
  // Auto-attach MCPs from every active plugin. Without this, plugins
  // declared mcp.json files are detected but never register — the
  // nimble-researcher agent would then fall back to generic tools or
  // hallucinate (the bug that motivated this hook).
  try {
    const { pluginManager } = await import('../plugins/plugin-manager.js');
    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    pluginManager.load(projectRoot);
    const attached = pluginManager.attachPluginMcps(mcpRegistry);
    if (attached.length > 0 && process.env.KOI_DEBUG_LLM) {
      console.error(`[MCPRegistry] Attached ${attached.length} plugin MCP(s): ${attached.map(a => a.registryKey).join(', ')}`);
    }
  } catch (err) {
    console.error(`[MCPRegistry] Plugin MCP attach failed: ${err.message}`);
  }
  // Connect eagerly so the prompt builder sees tools on first render.
  await mcpRegistry.connectAll();
})();
