/**
 * Plugin Manager — discovery, installation, activation, and runtime
 * integration of Koi plugins.
 *
 * A plugin is a self-contained directory with:
 *   .koi-plugin/plugin.json   — metadata (id, name, version, capabilities)
 *   skills/                   — skill directories (each with SKILL.md)
 *   agents/                   — agent definition files (.md or .koi)
 *   hooks/hooks.json          — hook definitions
 *   mcp/.mcp.json             — MCP server configs
 *   lsp/.lsp.json             — LSP server configs
 *   monitors/monitors.json    — monitor definitions
 *   scripts/                  — executable scripts
 *
 * Plugins are cached in ~/.koi/plugins/cache/<id>/<version>/.
 * Project-level overrides live in <project>/.koi/plugins/<id>/.
 *
 * At startup the runtime scans the cache, reads each plugin.json, and
 * integrates the declared capabilities into the running system.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { channel } from '../io/channel.js';

const GLOBAL_CACHE = path.join(os.homedir(), '.koi', 'plugins', 'cache');
const GLOBAL_CONFIG = path.join(os.homedir(), '.koi', 'plugins', 'plugins.json');

class PluginManager {
  constructor() {
    this._plugins = new Map();       // id → PluginEntry
    this._activePlugins = new Set();  // ids of enabled plugins
    this._loaded = false;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /**
   * Scan the plugin cache and project plugins, build the registry.
   * Called once at startup.
   */
  load(projectRoot = null) {
    if (this._loaded) return;
    this._loaded = true;
    this._plugins.clear();

    // 1. Global cache
    this._scanDir(GLOBAL_CACHE, 'global');

    // 2. Project plugins (override global)
    if (projectRoot) {
      const projectPlugins = path.join(projectRoot, '.koi', 'plugins');
      this._scanDir(projectPlugins, 'project');
    }

    // 3. Load enabled state from config
    this._loadConfig();

    channel.log('plugins', `Loaded ${this._plugins.size} plugin(s), ${this._activePlugins.size} active`);
  }

  _scanDir(baseDir, scope) {
    if (!fs.existsSync(baseDir)) return;
    for (const entry of fs.readdirSync(baseDir)) {
      const pluginDir = path.join(baseDir, entry);
      if (!fs.statSync(pluginDir).isDirectory()) continue;

      // Check for versioned subdirs (cache/<id>/<version>/) or direct
      const meta = this._readPluginJson(pluginDir);
      if (meta) {
        this._registerPlugin(meta, pluginDir, scope);
        continue;
      }

      // Check versioned: each subdir is a version
      for (const ver of fs.readdirSync(pluginDir)) {
        const verDir = path.join(pluginDir, ver);
        if (!fs.statSync(verDir).isDirectory()) continue;
        const verMeta = this._readPluginJson(verDir);
        if (verMeta) {
          this._registerPlugin(verMeta, verDir, scope);
        }
      }
    }
  }

  _readPluginJson(dir) {
    // Try .koi-plugin/plugin.json first, then .claude-plugin/plugin.json
    for (const sub of ['.koi-plugin', '.claude-plugin']) {
      const fp = path.join(dir, sub, 'plugin.json');
      if (fs.existsSync(fp)) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
          data._pluginJsonPath = fp;
          return data;
        } catch { /* skip corrupt */ }
      }
    }
    // Fallback: plugin.json at root
    const rootFp = path.join(dir, 'plugin.json');
    if (fs.existsSync(rootFp)) {
      try {
        const data = JSON.parse(fs.readFileSync(rootFp, 'utf8'));
        data._pluginJsonPath = rootFp;
        return data;
      } catch {}
    }
    return null;
  }

  _registerPlugin(meta, dir, scope) {
    const id = meta.id || meta.name || path.basename(dir);
    const version = meta.version || '0.0.0';

    // Detect capabilities by scanning the directory
    const capabilities = this._detectCapabilities(dir);

    const entry = {
      id,
      name: meta.name || id,
      version,
      description: meta.description || '',
      author: meta.author || null,
      keywords: meta.keywords || [],
      category: meta.category || null,
      scope,
      dir,
      capabilities,
      meta,
    };

    // Project scope overrides global
    const existing = this._plugins.get(id);
    if (!existing || scope === 'project') {
      this._plugins.set(id, entry);
    }
  }

  _detectCapabilities(dir) {
    const caps = {};

    // Skills
    const skillsDir = path.join(dir, 'skills');
    if (fs.existsSync(skillsDir)) {
      const skills = [];
      for (const name of fs.readdirSync(skillsDir)) {
        const sd = path.join(skillsDir, name);
        if (fs.statSync(sd).isDirectory() && fs.existsSync(path.join(sd, 'SKILL.md'))) {
          skills.push({ name, path: path.join(sd, 'SKILL.md'), dir: sd });
        }
      }
      if (skills.length > 0) caps.skills = skills;
    }
    // Single skill at root
    if (!caps.skills && fs.existsSync(path.join(dir, 'SKILL.md'))) {
      caps.skills = [{ name: path.basename(dir), path: path.join(dir, 'SKILL.md'), dir }];
    }

    // Agents
    const agentsDir = path.join(dir, 'agents');
    if (fs.existsSync(agentsDir)) {
      const agents = fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md') || f.endsWith('.koi'))
        .map(f => ({ name: f.replace(/\.(md|koi)$/, ''), path: path.join(agentsDir, f) }));
      if (agents.length > 0) caps.agents = agents;
    }

    // Hooks
    const hooksFile = path.join(dir, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksFile)) {
      try {
        caps.hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      } catch {}
    }

    // MCP
    for (const mcpPath of [path.join(dir, 'mcp', '.mcp.json'), path.join(dir, '.mcp.json')]) {
      if (fs.existsSync(mcpPath)) {
        try {
          caps.mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
          break;
        } catch {}
      }
    }

    // LSP
    for (const lspPath of [path.join(dir, 'lsp', '.lsp.json'), path.join(dir, '.lsp.json')]) {
      if (fs.existsSync(lspPath)) {
        try {
          caps.lsp = JSON.parse(fs.readFileSync(lspPath, 'utf8'));
          break;
        } catch {}
      }
    }

    // Monitors
    const monitorsFile = path.join(dir, 'monitors', 'monitors.json');
    if (fs.existsSync(monitorsFile)) {
      try {
        caps.monitors = JSON.parse(fs.readFileSync(monitorsFile, 'utf8'));
      } catch {}
    }

    // Scripts
    const scriptsDir = path.join(dir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      caps.scripts = fs.readdirSync(scriptsDir)
        .filter(f => !f.startsWith('.'))
        .map(f => ({ name: f, path: path.join(scriptsDir, f) }));
    }

    return caps;
  }

  // ── Configuration ──────────────────────────────────────────────────────

  _loadConfig() {
    try {
      if (!fs.existsSync(GLOBAL_CONFIG)) {
        // First run: enable all discovered plugins by default
        this._activePlugins = new Set(this._plugins.keys());
        return;
      }
      const data = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'));
      this._activePlugins = new Set(data.active || []);
    } catch {
      this._activePlugins = new Set(this._plugins.keys());
    }
  }

  _saveConfig() {
    const configDir = path.dirname(GLOBAL_CONFIG);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify({
      active: [...this._activePlugins],
    }, null, 2));
  }

  // ── Installation ───────────────────────────────────────────────────────

  /**
   * Install a plugin from a git repo (or a subdirectory of one).
   * @param {Object} opts
   * @param {string} opts.pluginId
   * @param {string} [opts.repo]            — direct plugin repo
   * @param {string} [opts.source]          — relative path inside marketplaceRepo
   * @param {string} [opts.marketplaceRepo] — repo containing multiple plugins
   * @param {string} [opts.scope]           — 'global' (default) or 'project'
   * @param {string} [opts.projectRoot]
   * @returns {{ success: boolean, installed: number, pluginId: string }}
   */
  async install({ pluginId, repo, source, marketplaceRepo, scope = 'global', projectRoot }) {
    const { execSync } = await import('child_process');

    const cloneUrl = repo || marketplaceRepo;
    if (!cloneUrl) throw new Error('repo or marketplaceRepo required');

    // Clone
    const tmpDir = path.join(os.tmpdir(), `koi-plugin-${Date.now()}`);
    execSync(`git clone --depth 1 "${cloneUrl}" "${tmpDir}"`, { timeout: 120000, stdio: 'pipe' });

    try {
      // Resolve plugin directory
      const pluginSrcDir = source
        ? path.join(tmpDir, source.replace(/^\.\//, ''))
        : tmpDir;

      if (!fs.existsSync(pluginSrcDir)) {
        throw new Error(`Plugin source not found: ${source || '(root)'}`);
      }

      // Determine destination
      const baseDir = scope === 'project' && projectRoot
        ? path.join(projectRoot, '.koi', 'plugins', pluginId)
        : path.join(GLOBAL_CACHE, pluginId, 'latest');

      // Clean previous install
      if (fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
      fs.mkdirSync(baseDir, { recursive: true });

      // Copy everything (except .git)
      this._copyRecursive(pluginSrcDir, baseDir);

      // Ensure plugin.json exists — create a minimal one if missing
      const hasPluginJson = this._readPluginJson(baseDir) !== null;
      if (!hasPluginJson) {
        const metaDir = path.join(baseDir, '.koi-plugin');
        fs.mkdirSync(metaDir, { recursive: true });
        fs.writeFileSync(path.join(metaDir, 'plugin.json'), JSON.stringify({
          id: pluginId,
          name: pluginId,
          version: '1.0.0',
          description: 'Installed from marketplace',
        }, null, 2));
      }

      // Also copy skills to .koi/skills/ for backward compat
      const caps = this._detectCapabilities(baseDir);
      let skillsCopied = 0;
      if (caps.skills) {
        const skillsTarget = scope === 'project' && projectRoot
          ? path.join(projectRoot, '.koi', 'skills')
          : path.join(os.homedir(), '.koi', 'skills');
        if (!fs.existsSync(skillsTarget)) fs.mkdirSync(skillsTarget, { recursive: true });
        for (const skill of caps.skills) {
          const dest = path.join(skillsTarget, skill.name);
          if (!fs.existsSync(dest)) {
            this._copyRecursive(skill.dir, dest);
            skillsCopied++;
          }
        }
      }

      // Register + activate
      const meta = this._readPluginJson(baseDir) || { id: pluginId, name: pluginId };
      this._registerPlugin(meta, baseDir, scope);
      this._activePlugins.add(pluginId);
      this._saveConfig();

      const totalCaps = Object.keys(caps).length;
      channel.log('plugins', `Installed plugin "${pluginId}" (${totalCaps} capabilities, ${skillsCopied} skills copied)`);

      return {
        success: true,
        pluginId,
        installed: skillsCopied,
        capabilities: caps,
        scope,
      };
    } finally {
      // Cleanup temp
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  _copyRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const sp = path.join(src, entry.name);
      const dp = path.join(dest, entry.name);
      if (entry.isDirectory()) this._copyRecursive(sp, dp);
      else fs.copyFileSync(sp, dp);
    }
  }

  /**
   * Uninstall a plugin — remove from cache and deactivate.
   */
  uninstall(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return false;
    try {
      if (fs.existsSync(entry.dir)) {
        fs.rmSync(entry.dir, { recursive: true, force: true });
      }
    } catch {}
    this._plugins.delete(pluginId);
    this._activePlugins.delete(pluginId);
    this._saveConfig();
    return true;
  }

  // ── Activation ─────────────────────────────────────────────────────────

  activate(pluginId) {
    if (!this._plugins.has(pluginId)) return false;
    this._activePlugins.add(pluginId);
    this._saveConfig();
    return true;
  }

  deactivate(pluginId) {
    this._activePlugins.delete(pluginId);
    this._saveConfig();
    return true;
  }

  isActive(pluginId) {
    return this._activePlugins.has(pluginId);
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /**
   * List all discovered plugins with their capabilities.
   */
  list() {
    return [...this._plugins.values()].map(p => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      category: p.category,
      keywords: p.keywords,
      scope: p.scope,
      active: this._activePlugins.has(p.id),
      dir: p.dir,
      capabilities: Object.fromEntries(
        Object.entries(p.capabilities).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1])
      ),
      capabilitiesDetail: p.capabilities,
    }));
  }

  get(pluginId) {
    return this._plugins.get(pluginId) || null;
  }

  get size() {
    return this._plugins.size;
  }

  // ── Runtime integration ────────────────────────────────────────────────
  // These methods are called by the runtime at startup to merge plugin
  // capabilities into the running system.

  /**
   * Get all skill directories from active plugins.
   * Returns [{ name, path, dir, pluginId }]
   */
  getActiveSkills() {
    const skills = [];
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.skills) {
        for (const s of entry.capabilities.skills) {
          skills.push({ ...s, pluginId: id });
        }
      }
    }
    return skills;
  }

  /**
   * Get all agent definitions from active plugins.
   * Returns [{ name, path, pluginId }]
   */
  getActiveAgents() {
    const agents = [];
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.agents) {
        for (const a of entry.capabilities.agents) {
          agents.push({ ...a, pluginId: id });
        }
      }
    }
    return agents;
  }

  /**
   * Get merged hooks from all active plugins.
   * Returns the union of all hooks.json contents.
   */
  getActiveHooks() {
    const merged = [];
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.hooks) {
        const hooks = Array.isArray(entry.capabilities.hooks)
          ? entry.capabilities.hooks
          : entry.capabilities.hooks.hooks || [];
        for (const h of hooks) {
          merged.push({ ...h, _pluginId: id });
        }
      }
    }
    return merged;
  }

  /**
   * Get merged MCP server configs from all active plugins.
   * Returns { serverName: config, ... }
   */
  getActiveMcpServers() {
    const servers = {};
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.mcp) {
        const mcpConfig = entry.capabilities.mcp;
        const mcpServers = mcpConfig.mcpServers || mcpConfig.servers || mcpConfig;
        if (typeof mcpServers === 'object') {
          for (const [name, config] of Object.entries(mcpServers)) {
            servers[`${id}/${name}`] = { ...config, _pluginId: id };
          }
        }
      }
    }
    return servers;
  }

  /**
   * Get merged LSP server configs from all active plugins.
   */
  getActiveLspServers() {
    const servers = {};
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.lsp) {
        const lspConfig = entry.capabilities.lsp;
        const lspServers = lspConfig.servers || lspConfig;
        if (typeof lspServers === 'object') {
          for (const [name, config] of Object.entries(lspServers)) {
            servers[`${id}/${name}`] = { ...config, _pluginId: id };
          }
        }
      }
    }
    return servers;
  }

  /**
   * Get all monitor definitions from active plugins.
   */
  getActiveMonitors() {
    const monitors = [];
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.monitors) {
        const mons = Array.isArray(entry.capabilities.monitors)
          ? entry.capabilities.monitors
          : entry.capabilities.monitors.monitors || [];
        for (const m of mons) {
          monitors.push({ ...m, _pluginId: id });
        }
      }
    }
    return monitors;
  }

  /**
   * Get all scripts from active plugins.
   */
  getActiveScripts() {
    const scripts = [];
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      if (entry.capabilities.scripts) {
        for (const s of entry.capabilities.scripts) {
          scripts.push({ ...s, pluginId: id });
        }
      }
    }
    return scripts;
  }
}

// Singleton
export const pluginManager = new PluginManager();
