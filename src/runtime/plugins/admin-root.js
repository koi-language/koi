/**
 * Admin-plugins root detector.
 *
 * Locates the local checkout of the `koi-language/plugins` marketplace
 * repo when one exists next to the running koi-cli source. Used by:
 *   - PluginManager (registry scan, scope: 'admin')
 *   - list-skills.js     (admin tier of skill discovery)
 *   - workflows-catalog  (admin tier of workflow discovery)
 *   - md-agent-loader    (admin tier of agent discovery)
 *
 * Lives in its own module so the discovery consumers don't pull in the
 * whole PluginManager class (and any circular-import risk that comes
 * with it). Pure function — no state, safe to call from any tier.
 *
 * Resolution order:
 *   1. `KOI_PLUGINS_REPO_PATH` env var — explicit dev override.
 *   2. Walk up 6 levels from this file looking for a sibling `plugins/`
 *      whose `.claude-plugin/marketplace.json` confirms it's THE
 *      official plugins repo (not a random project dir named "plugins").
 *
 * Returns the path to the `plugins/plugins/` subdirectory (where each
 * subdirectory is an admin plugin), or `null` when no checkout exists —
 * end-user installs simply have no admin tier.
 */

import fs from 'fs';
import path from 'path';

export function detectAdminPluginsRoot() {
  const explicit = process.env.KOI_PLUGINS_REPO_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return path.join(explicit, 'plugins');
  }
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    let cursor = here;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(cursor, '..', 'plugins');
      const marker = path.join(candidate, '.claude-plugin', 'marketplace.json');
      if (fs.existsSync(marker)) {
        return path.join(candidate, 'plugins');
      }
      cursor = path.join(cursor, '..');
    }
  } catch { /* fall through to null */ }
  return null;
}

/// List the admin plugin directory names ( = plugin ids ) found under
/// the marketplace repo's `plugins/` subdir. Returns `[]` when no
/// admin tier is available.
export function listAdminPluginDirs() {
  const root = detectAdminPluginsRoot();
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      out.push({ id: entry.name, dir: path.join(root, entry.name) });
    }
  } catch { /* unreadable */ }
  return out;
}
