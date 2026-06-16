/**
 * Install Plugin Action — fetch + activate a Koi plugin on demand.
 *
 * Lets an agent satisfy a "this activity requires plugin X" dependency by
 * installing the plugin itself instead of asking the user to do it manually.
 * Wraps `pluginManager.install()` (GitHub subpath fetch → cache → capability
 * detection → register + activate) and then best-effort hot-wires the new
 * capabilities into the RUNNING session so the agent can use them without a
 * restart:
 *   - skills   → already live (list_skills reads the same pluginManager singleton)
 *   - agents   → reloadUserAgents() so the Coordinator sees new delegate agents
 *   - mcp      → attachPluginMcps() so the plugin's MCP servers connect
 *
 * Two ways to point at a plugin (mirrors pluginManager.install):
 *   1. Single-plugin repo:   { pluginId, repo }
 *   2. Marketplace monorepo: { pluginId, marketplaceRepo, source }
 *      (e.g. koi-language/plugins with source="plugins/<name>")
 *
 * GitHub repos only (install fetches via the GitHub Trees + raw API).
 */

export default {
  type: 'install_plugin',
  intent: 'install_plugin',
  description:
    'Install and activate a Koi plugin from a GitHub repo so this session can use its skills, agents and MCP servers. '
    + 'Fields: pluginId (required, unique id), repo (single-plugin repo URL) OR marketplaceRepo+source (a monorepo URL plus the subpath to the plugin), scope ("global" | "project"), force (reinstall even if already active). '
    + '→ Returns: { success, pluginId, alreadyInstalled?, skillsCopied, agentsCopied, workflowsCopied, capabilities, scope, message }',
  instructions:
    'Use install_plugin when a skill, workflow or activity declares a plugin dependency that is not yet installed — '
    + 'install it instead of telling the user to do it by hand. Pass `repo` for a single-plugin repository, or '
    + '`marketplaceRepo` + `source` for a plugin that lives in a subdirectory of a monorepo (the koi-language/plugins '
    + 'marketplace works this way: marketplaceRepo="https://github.com/koi-language/plugins", source="plugins/<name>"). '
    + 'The call is idempotent: if the plugin is already installed and active it returns immediately without re-fetching '
    + '(pass force:true to reinstall/update). Only GitHub repos are supported. After a successful install the new skills '
    + 'are immediately discoverable via list_skills.',
  thinkingHint: 'Installing plugin',
  permission: 'write',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      pluginId: {
        type: 'string',
        description: 'Unique plugin identifier, e.g. "video-generation" or "nimble".',
      },
      repo: {
        type: 'string',
        description: 'GitHub URL of a single-plugin repo, e.g. "https://github.com/koi-language/some-plugin". Use this OR marketplaceRepo+source.',
      },
      marketplaceRepo: {
        type: 'string',
        description: 'GitHub URL of a monorepo that contains many plugins, e.g. "https://github.com/koi-language/plugins". Requires `source`.',
      },
      source: {
        type: 'string',
        description: 'Path to the plugin directory inside marketplaceRepo, e.g. "plugins/video-generation".',
      },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'Install for every project ("global", default) or only the current project ("project").',
      },
      force: {
        type: 'boolean',
        description: 'Reinstall even if the plugin is already installed and active. Default false (no-op when already present).',
      },
    },
    required: ['pluginId'],
  },

  examples: [
    { intent: 'install_plugin', pluginId: 'nimble', marketplaceRepo: 'https://github.com/koi-language/plugins', source: 'plugins/nimble' },
    { intent: 'install_plugin', pluginId: 'some-plugin', repo: 'https://github.com/koi-language/some-plugin' },
  ],

  async execute(action, agent) {
    const { pluginId, repo, marketplaceRepo, source, scope = 'global', force = false } = action || {};

    if (!pluginId) return { success: false, error: 'pluginId is required' };
    if (!repo && !marketplaceRepo) {
      return { success: false, error: 'Provide either `repo` (single-plugin repo) or `marketplaceRepo` + `source` (plugin inside a monorepo).' };
    }
    if (marketplaceRepo && !source) {
      return { success: false, error: '`source` is required with `marketplaceRepo` — the subpath to the plugin, e.g. "plugins/<name>".' };
    }

    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

    let pluginManager;
    try {
      ({ pluginManager } = await import('../../plugins/plugin-manager.js'));
    } catch (err) {
      return { success: false, error: `Plugin manager unavailable: ${err.message}` };
    }
    pluginManager.load(projectRoot); // idempotent — no-op once loaded

    // Idempotency: if already installed AND active, skip the network fetch.
    // This is the common case for "activity requires plugin X" — the agent
    // can call install_plugin freely and it only does work the first time.
    if (!force && pluginManager.get(pluginId) && pluginManager.isActive(pluginId)) {
      return {
        success: true,
        pluginId,
        alreadyInstalled: true,
        message: `Plugin "${pluginId}" is already installed and active.`,
      };
    }

    // Install (GitHub subpath fetch → cache → register → activate).
    let result;
    try {
      result = await pluginManager.install({ pluginId, repo, source, marketplaceRepo, scope, projectRoot });
    } catch (err) {
      return { success: false, error: `Installation failed: ${err.message}` };
    }
    if (!result?.success) {
      return { success: false, error: result?.error || 'Installation failed.' };
    }

    // Best-effort hot-wiring so the plugin is usable THIS session, not after a
    // restart. Each step is non-fatal: the capability still loads on next boot.
    if (result.agentsCopied > 0) {
      try {
        const { reloadUserAgents } = await import('../../agent/md-agent-loader.js');
        await reloadUserAgents();
      } catch { /* agents load on next restart */ }
    }
    let mcpAttached = 0;
    try {
      const mcpRegistry = globalThis.mcpRegistry;
      if (mcpRegistry) {
        const attached = pluginManager.attachPluginMcps(mcpRegistry); // default ${VAR} resolver
        const mine = attached.filter(a => a.pluginId === pluginId);
        mcpAttached = mine.length;
        if (mine.length > 0 && typeof mcpRegistry.connectAll === 'function') {
          mcpRegistry.connectAll().catch(() => { /* best-effort */ });
        }
      }
    } catch { /* MCP servers attach on next restart */ }

    const caps = Object.keys(result.capabilities || {});
    const parts = [];
    if (result.skillsCopied) parts.push(`${result.skillsCopied} skill(s)`);
    if (result.agentsCopied) parts.push(`${result.agentsCopied} agent(s)`);
    if (result.workflowsCopied) parts.push(`${result.workflowsCopied} workflow(s)`);
    if (mcpAttached) parts.push(`${mcpAttached} MCP server(s)`);

    return {
      success: true,
      pluginId: result.pluginId,
      alreadyInstalled: false,
      skillsCopied: result.skillsCopied,
      agentsCopied: result.agentsCopied,
      workflowsCopied: result.workflowsCopied,
      mcpAttached,
      capabilities: caps,
      scope: result.scope,
      message: `Installed plugin "${pluginId}"${parts.length ? ` (${parts.join(', ')})` : ''}.`,
    };
  },
};
