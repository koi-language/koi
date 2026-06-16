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
import { detectAdminPluginsRoot } from './admin-root.js';

const GLOBAL_CACHE = path.join(os.homedir(), '.koi', 'plugins', 'cache');
const GLOBAL_CONFIG = path.join(os.homedir(), '.koi', 'plugins', 'plugins.json');

// Scope rank — higher number wins. Admin sits above project so a
// developer hacking on `koi-language/plugins` next to their koi-cli
// checkout sees their in-progress version everywhere, no install step
// required. Project still overrides global for end-users without an
// admin checkout.
const SCOPE_RANK = { global: 1, project: 2, admin: 3 };

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

    // 3. Admin plugins — highest priority. The koi-language/plugins
    //    repo (when present next to koi-cli) is the source of truth
    //    for in-development plugins. Each subdir is a plugin and has
    //    no `plugin.json` — we synthesize one from the directory name
    //    in `_scanAdminDir`.
    const adminRoot = detectAdminPluginsRoot();
    if (adminRoot) {
      this._scanAdminDir(adminRoot);
    }

    // 4. Load enabled state from config
    this._loadConfig();

    channel.log('plugins', `Loaded ${this._plugins.size} plugin(s), ${this._activePlugins.size} active`);
  }

  /// Variant of `_scanDir` for admin plugins. The marketplace repo
  /// stores plugins as plain directories (no .koi-plugin/plugin.json),
  /// so we register each subdir with a synthesized meta whose id is
  /// the directory name. Capability detection (skills/, workflows/,
  /// agents/, mcp/, …) still works because `_detectCapabilities` walks
  /// the dir directly.
  _scanAdminDir(baseDir) {
    if (!fs.existsSync(baseDir)) return;
    for (const entry of fs.readdirSync(baseDir)) {
      if (entry.startsWith('.')) continue;
      const pluginDir = path.join(baseDir, entry);
      let stat;
      try { stat = fs.statSync(pluginDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      // Honor a real plugin.json if one is committed in the repo
      // (future-proofing — none of today's admin plugins have one).
      const meta = this._readPluginJson(pluginDir) || {
        id: entry,
        name: entry,
        version: '0.0.0-admin',
      };
      this._registerPlugin(meta, pluginDir, 'admin');
    }
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

    // Rank-aware override: higher SCOPE_RANK wins. Without this, a
    // global plugin would silently shadow an admin checkout because
    // global is scanned first and the old `scope === 'project'` check
    // didn't know about admin at all.
    const existing = this._plugins.get(id);
    const incomingRank = SCOPE_RANK[scope] ?? 0;
    const existingRank = existing ? (SCOPE_RANK[existing.scope] ?? 0) : -1;
    if (incomingRank >= existingRank) {
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

    // Workflows — three accepted layouts so plugin authors aren't
    // forced into one convention:
    //   1. `<plugin>/workflows/<name>/WORKFLOW.md` — one sub-directory
    //      per workflow. Recommended for multi-workflow plugins
    //      (matches `<plugin>/skills/<name>/SKILL.md`).
    //   2. `<plugin>/workflows/WORKFLOW.md`        — single workflow
    //      under a `workflows/` folder, used as a bag for the
    //      workflow's accompanying assets (style guides, sample
    //      images, …). The workflow gets `path.basename(plugin)` as
    //      its name. THIS is the layout the video-ad-generation
    //      plugin shipped first — without this branch the install
    //      would silently copy zero workflows and the agent had no
    //      pre-approved plan to match user intent against.
    //   3. `<plugin>/WORKFLOW.md`                   — workflow file
    //      directly at the plugin root (no wrapping `workflows/`),
    //      for one-trick plugins that don't ship side assets.
    const workflowsDir = path.join(dir, 'workflows');
    if (fs.existsSync(workflowsDir)) {
      const workflows = [];
      for (const name of fs.readdirSync(workflowsDir)) {
        const wd = path.join(workflowsDir, name);
        if (fs.statSync(wd).isDirectory() && fs.existsSync(path.join(wd, 'WORKFLOW.md'))) {
          workflows.push({ name, path: path.join(wd, 'WORKFLOW.md'), dir: wd });
        }
      }
      if (workflows.length > 0) {
        caps.workflows = workflows;
      } else if (fs.existsSync(path.join(workflowsDir, 'WORKFLOW.md'))) {
        // Layout #2 — single WORKFLOW.md sitting directly inside
        // workflows/ with the plugin's other assets.
        caps.workflows = [{
          name: path.basename(dir),
          path: path.join(workflowsDir, 'WORKFLOW.md'),
          dir: workflowsDir,
        }];
      }
    }
    if (!caps.workflows && fs.existsSync(path.join(dir, 'WORKFLOW.md'))) {
      caps.workflows = [{ name: path.basename(dir), path: path.join(dir, 'WORKFLOW.md'), dir }];
    }

    // Hooks
    const hooksFile = path.join(dir, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksFile)) {
      try {
        caps.hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      } catch {}
    }

    // MCP — Claude Code plugins ship the config as `mcp.json` at the
    // plugin root (no leading dot). Koi's original convention was
    // `.mcp.json`. Accept both forms (+ the `mcp/` subfolder variant)
    // so plugins from either ecosystem install without editing.
    // Without this, the MCP server silently never registers and the
    // plugin's agents fall back to generic tools (or hallucinate) —
    // exactly what we saw with the Nimble plugin's nimble-mcp-server.
    const _mcpCandidates = [
      path.join(dir, 'mcp', '.mcp.json'),
      path.join(dir, 'mcp', 'mcp.json'),
      path.join(dir, '.mcp.json'),
      path.join(dir, 'mcp.json'),
    ];
    for (const mcpPath of _mcpCandidates) {
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
    const cloneUrl = repo || marketplaceRepo;
    if (!cloneUrl) throw new Error('repo or marketplaceRepo required');

    // Targeted SUBPATH fetch via GitHub Trees + raw URLs. We list the
    // entire repo tree with one Trees API request (~200 KB JSON for a
    // typical catalog), filter to entries under the plugin's `source`
    // subpath, and download only those files in parallel via
    // raw.githubusercontent.com. For a single plugin install on a big
    // marketplace repo this is dramatically faster than cloning or
    // tarballing the whole repo — `koi-language/plugins` is ~400 MB
    // tarball but a single plugin is often <1 MB.
    //
    // On-disk layout: every blob is written at `tmpDir/<full-repo-
    // relative-path>`, so the existing `pluginSrcDir = path.join(
    // tmpDir, source)` resolution below keeps working unchanged.
    const ghMatch = cloneUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
    if (!ghMatch) {
      throw new Error(`Subpath install only supports GitHub repos: ${cloneUrl}`);
    }
    const ghOwner = ghMatch[1];
    const ghRepo = ghMatch[2];
    const tmpDir = path.join(os.tmpdir(), `koi-plugin-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const https = await import('https');
    const FETCH_TIMEOUT_MS = 120000;

    const httpGet = (url, asJson = false) => new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'koi-cli',
          'Accept': asJson ? 'application/vnd.github.v3+json' : '*/*',
        },
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          httpGet(res.headers.location, asJson).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (asJson) {
            try { resolve(JSON.parse(buf.toString('utf8'))); }
            catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
          } else {
            resolve(buf);
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(FETCH_TIMEOUT_MS, () => {
        req.destroy(new Error(`fetch timed out after ${FETCH_TIMEOUT_MS}ms`));
      });
    });

    let branch = 'main';
    let tree;
    try {
      tree = await httpGet(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/trees/main?recursive=1`, true);
    } catch (mainErr) {
      branch = 'master';
      try {
        tree = await httpGet(`https://api.github.com/repos/${ghOwner}/${ghRepo}/git/trees/master?recursive=1`, true);
      } catch (masterErr) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(`Tree fetch failed (main: ${mainErr.message}; master: ${masterErr.message})`);
      }
    }
    if (tree.truncated) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`Repo tree truncated (>100k entries) — targeted subpath install not supported`);
    }
    const entries = Array.isArray(tree.tree) ? tree.tree : [];
    const normSub = source ? source.replace(/^\.\//, '').replace(/\/$/, '') : '';
    const wanted = normSub
      ? entries.filter(e => e.path === normSub || e.path.startsWith(normSub + '/'))
      : entries;
    const blobs = wanted.filter(e => e.type === 'blob');
    if (blobs.length === 0) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`No files found under '${source || '/'}' in ${ghOwner}/${ghRepo}`);
    }

    const CONCURRENCY = 8;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, blobs.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= blobs.length) return;
        const blob = blobs[idx];
        const dest = path.join(tmpDir, blob.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const rawUrl = `https://raw.githubusercontent.com/${ghOwner}/${ghRepo}/${branch}/${blob.path}`;
        const buf = await httpGet(rawUrl, false);
        fs.writeFileSync(dest, buf);
      }
    });
    try {
      await Promise.all(workers);
    } catch (err) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`Blob fetch failed: ${err.message}`);
    }

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

      // Copy skills and agents into the well-known directories that the
      // runtime scans (.koi/skills, .koi/agents). Symmetric treatment —
      // both come from the same plugin payload. The resulting paths are
      // recorded in an install manifest so uninstall can remove them
      // cleanly instead of leaving orphaned files behind.
      const caps = this._detectCapabilities(baseDir);
      const installedPaths = { skills: [], agents: [], workflows: [] };
      const isProject = scope === 'project' && projectRoot;

      // Skills are NOT copied into the shared `.koi/skills` dir. They are
      // discovered IN PLACE from this plugin's own cache dir (list-skills.js
      // → pluginManager.getActiveSkills()) and namespaced `<pluginId>:<name>`.
      // Flattening them here was the collision bug: two plugins shipping a
      // skill with the same bare name landed on the same folder and clobbered
      // each other. `installedPaths.skills` stays empty — uninstall removes
      // the whole cache dir, which takes the in-place skills with it.
      let skillsCopied = caps.skills ? caps.skills.length : 0;
      // Migration: older builds DID flatten skills into `.koi/skills/<name>`.
      // Remove exactly those previously-recorded copies (read from this
      // plugin's prior manifest) so they don't double-list as bare-name
      // standalone skills next to the in-place namespaced ones. Reading the
      // old manifest — rather than guessing by name — guarantees we never
      // delete a legitimate standalone/bundled skill that merely shares a name.
      try {
        const oldManifestPath = path.join(baseDir, '.koi-plugin', 'install-manifest.json');
        if (fs.existsSync(oldManifestPath)) {
          const old = JSON.parse(fs.readFileSync(oldManifestPath, 'utf8'));
          for (const p of (old.installedPaths?.skills || [])) {
            try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
          }
        }
      } catch { /* no/ corrupt old manifest — nothing to migrate */ }

      let agentsCopied = 0;
      if (caps.agents) {
        const agentsTarget = isProject
          ? path.join(projectRoot, '.koi', 'agents')
          : path.join(os.homedir(), '.koi', 'agents');
        if (!fs.existsSync(agentsTarget)) fs.mkdirSync(agentsTarget, { recursive: true });
        for (const agent of caps.agents) {
          // md-agent-loader only scans .md; skip .koi until the runtime
          // supports compiling them on the fly.
          if (!agent.path.endsWith('.md')) continue;
          const dest = path.join(agentsTarget, path.basename(agent.path));
          // Always overwrite — see skills note above (re)install = update.
          if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
          fs.copyFileSync(agent.path, dest);
          installedPaths.agents.push(dest);
          agentsCopied++;
        }
      }

      // Workflows — copy each `workflows/<name>/` directory (containing a
      // WORKFLOW.md) into the runtime's scanned location so
      // workflows-catalog.js picks it up automatically (no restart).
      // Always overwrite — see skills note above: a (re)install MUST land
      // the freshest code so autoinstall actually updates on each boot.
      let workflowsCopied = 0;
      if (caps.workflows) {
        const workflowsTarget = isProject
          ? path.join(projectRoot, '.koi', 'workflows')
          : path.join(os.homedir(), '.koi', 'workflows');
        if (!fs.existsSync(workflowsTarget)) fs.mkdirSync(workflowsTarget, { recursive: true });
        for (const workflow of caps.workflows) {
          const dest = path.join(workflowsTarget, workflow.name);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
          this._copyRecursive(workflow.dir, dest);
          installedPaths.workflows.push(dest);
          workflowsCopied++;
        }
      }

      // Write install manifest so uninstall can reverse these copies.
      try {
        const manifestDir = path.join(baseDir, '.koi-plugin');
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(
          path.join(manifestDir, 'install-manifest.json'),
          JSON.stringify({ scope, installedPaths }, null, 2),
        );
      } catch { /* non-fatal */ }

      // Register + activate
      const meta = this._readPluginJson(baseDir) || { id: pluginId, name: pluginId };
      this._registerPlugin(meta, baseDir, scope);
      this._activePlugins.add(pluginId);
      this._saveConfig();

      const totalCaps = Object.keys(caps).length;
      channel.log(
        'plugins',
        `Installed plugin "${pluginId}" (${totalCaps} capabilities, ${skillsCopied} skills, ${agentsCopied} agents, ${workflowsCopied} workflows)`,
      );

      return {
        success: true,
        pluginId,
        installed: skillsCopied + workflowsCopied,
        skillsCopied,
        agentsCopied,
        workflowsCopied,
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
   * Uninstall a plugin — remove cache dir, reverse any installed
   * skills, agents and workflows recorded in the install manifest, and
   * deactivate. Returns { success, skillsRemoved, agentsRemoved,
   * workflowsRemoved }.
   */
  uninstall(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) {
      return {
        success: false,
        skillsRemoved: 0,
        agentsRemoved: 0,
        workflowsRemoved: 0,
      };
    }

    let skillsRemoved = 0;
    let agentsRemoved = 0;
    let workflowsRemoved = 0;

    // Read manifest before removing the cache dir.
    try {
      const manifestPath = path.join(entry.dir, '.koi-plugin', 'install-manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const paths = manifest.installedPaths || {};
        for (const p of (paths.skills || [])) {
          try {
            if (fs.existsSync(p)) {
              fs.rmSync(p, { recursive: true, force: true });
              skillsRemoved++;
            }
          } catch { /* best effort */ }
        }
        for (const p of (paths.agents || [])) {
          try {
            if (fs.existsSync(p)) {
              fs.unlinkSync(p);
              agentsRemoved++;
            }
          } catch { /* best effort */ }
        }
        for (const p of (paths.workflows || [])) {
          try {
            if (fs.existsSync(p)) {
              fs.rmSync(p, { recursive: true, force: true });
              workflowsRemoved++;
            }
          } catch { /* best effort */ }
        }
      }
    } catch { /* manifest missing or corrupt — skip reverse copies */ }

    try {
      if (fs.existsSync(entry.dir)) {
        fs.rmSync(entry.dir, { recursive: true, force: true });
      }
    } catch {}

    this._plugins.delete(pluginId);
    this._activePlugins.delete(pluginId);
    this._saveConfig();
    return { success: true, skillsRemoved, agentsRemoved, workflowsRemoved };
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

  /**
   * Register every active plugin's MCP servers into the provided
   * MCP registry as global servers. Idempotent — re-registering an
   * already-registered name is a no-op on the registry side.
   *
   * Env var substitution (`${NIMBLE_API_KEY}` → actual value) is
   * applied by default via an internal helper that covers the same
   * fields as koi-cli's `resolveMcpEnvVars` (env, headers, args, url).
   * Callers can pass an `resolveEnvVars` override if they need custom
   * behaviour (e.g. OAuth token injection for remote HTTP servers).
   *
   * @param {object} mcpRegistry - The global MCP registry instance.
   * @param {(servers: object) => object} [resolveEnvVars] - Optional.
   * @returns {Array<{ pluginId: string, serverName: string, registryKey: string }>}
   */
  attachPluginMcps(mcpRegistry, resolveEnvVars) {
    if (!mcpRegistry || typeof mcpRegistry.registerGlobal !== 'function') return [];
    const resolver = typeof resolveEnvVars === 'function' ? resolveEnvVars : _defaultResolveMcpEnvVars;
    const attached = [];
    for (const [id, entry] of this._plugins) {
      if (!this._activePlugins.has(id)) continue;
      const mcpConfig = entry.capabilities?.mcp;
      if (!mcpConfig) continue;
      const rawServers = mcpConfig.mcpServers || mcpConfig.servers || mcpConfig;
      if (typeof rawServers !== 'object') continue;
      const servers = resolver(rawServers);
      for (const [name, config] of Object.entries(servers)) {
        // Prefix with plugin id to avoid name clashes between plugins.
        const registryKey = `${id}/${name}`;
        try {
          mcpRegistry.registerGlobal(registryKey, { ...config, _pluginId: id });
          attached.push({ pluginId: id, serverName: name, registryKey });
          // Remember the concrete registry keys on the plugin entry so
          // detachPluginMcps can remove them cleanly without having to
          // re-resolve the config.
          entry._mcpRegistryKeys = entry._mcpRegistryKeys || new Set();
          entry._mcpRegistryKeys.add(registryKey);
        } catch (err) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[PluginManager] Failed to attach MCP ${registryKey}: ${err.message}`);
          }
        }
      }
    }
    return attached;
  }

  /**
   * Detach (disconnect + unregister) every MCP server contributed by a
   * specific plugin. Called from install/uninstall/deactivate flows so
   * the MCP stops running the moment the plugin is gone.
   *
   * @param {string} pluginId
   * @param {object} mcpRegistry
   * @returns {Promise<string[]>} list of registry keys removed
   */
  async detachPluginMcps(pluginId, mcpRegistry) {
    if (!mcpRegistry || typeof mcpRegistry.unregister !== 'function') return [];
    const entry = this._plugins.get(pluginId);
    const removed = [];
    // Primary path: use the explicit set we recorded during attach.
    if (entry?._mcpRegistryKeys instanceof Set) {
      for (const key of entry._mcpRegistryKeys) {
        try {
          const ok = await mcpRegistry.unregister(key);
          if (ok) removed.push(key);
        } catch { /* best-effort */ }
      }
      entry._mcpRegistryKeys.clear();
    }
    // Fallback: scan the registry for any `<pluginId>/...` name that
    // slipped through (registered before we started tracking, or from
    // a previous run). Keeps uninstall deterministic even across
    // upgrades that changed the tracking scheme.
    if (typeof mcpRegistry.entries === 'function') {
      const prefix = `${pluginId}/`;
      for (const [name] of Array.from(mcpRegistry.entries())) {
        if (!name.startsWith(prefix)) continue;
        if (removed.includes(name)) continue;
        try {
          const ok = await mcpRegistry.unregister(name);
          if (ok) removed.push(name);
        } catch { /* best-effort */ }
      }
    }
    return removed;
  }
}

/**
 * Default `${VAR}` substitution for MCP configs pulled from plugins.
 * Mirrors `koi-cli/src/cli/mcp-manager.js#resolveMcpEnvVars` so plugins
 * work identically whether the env-var-resolver lives in the CLI layer
 * (installPlugin handler passes it in) or the runtime layer (startup
 * auto-attach uses this default).
 */
function _defaultResolveMcpEnvVars(servers) {
  const substitute = (s) => typeof s === 'string'
    ? s.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
    : s;
  const resolveDict = (dict) => {
    const out = {};
    for (const [k, v] of Object.entries(dict)) out[k] = substitute(v);
    return out;
  };
  const resolved = {};
  for (const [name, server] of Object.entries(servers)) {
    const entry = { ...server };
    if (entry.env && typeof entry.env === 'object') entry.env = resolveDict(entry.env);
    if (entry.headers && typeof entry.headers === 'object') entry.headers = resolveDict(entry.headers);
    if (Array.isArray(entry.args)) entry.args = entry.args.map(substitute);
    if (typeof entry.url === 'string') entry.url = substitute(entry.url);
    resolved[name] = entry;
  }
  return resolved;
}

// Singleton
export const pluginManager = new PluginManager();
