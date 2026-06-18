/**
 * List Skills Action — Discover and list available Agent Skills.
 *
 * Scans predefined directories for SKILL.md files, parses YAML frontmatter,
 * and returns a catalog of available skills with name, description, and location.
 *
 * Discovery paths:
 *   - Global:      ~/.koi/skills/
 *   - Project:     <projectRoot>/.koi/skills/         (overrides global)
 *   - Admin:       <pluginsRepo>/plugins/<plugin>/skills/  (overrides project)
 *
 * Admin scope only applies when running with a checkout of the
 * `koi-language/plugins` marketplace repo next to the koi-cli source
 * (or when `KOI_PLUGINS_REPO_PATH` is set). For end-user installs the
 * admin tier is silently empty.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import { listAdminPluginDirs } from '../../plugins/admin-root.js';

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts name and description from the --- delimited YAML block.
 *
 * Uses the `yaml` package so folded scalars (`description: >\n  …`) and
 * literal block scalars (`description: |\n  …`) parse correctly. The
 * previous hand-rolled line-by-line parser only saw the first line of
 * a folded value and ended up returning the literal `>` as the
 * description (the reported bug — visible in the agent's catalog as
 * `### visual-panels\n>` instead of the actual paragraph).
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  let parsed;
  try {
    parsed = yaml.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const result = {};
  for (const key of ['name', 'description', 'compatibility', 'license']) {
    const v = parsed[key];
    if (typeof v === 'string') {
      // Folded scalars (`>`) keep a trailing newline; whitespace-trim for
      // a clean single-line description.
      result[key] = v.trim();
    }
  }

  return (result.name && result.description) ? result : null;
}

/**
 * Read a single skill directory (one that contains SKILL.md) into a skill
 * object. Returns null when the dir has no valid SKILL.md / frontmatter.
 */
function readSkillDir(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return null;

  let content;
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    return null;
  }
  const meta = parseFrontmatter(content);
  if (!meta) return null;

  // List bundled resources (references/, scripts/, assets/)
  const resources = [];
  for (const subdir of ['references', 'scripts', 'assets']) {
    const subdirPath = path.join(skillDir, subdir);
    if (fs.existsSync(subdirPath)) {
      try {
        for (const f of fs.readdirSync(subdirPath)) {
          resources.push(`${subdir}/${f}`);
        }
      } catch { /* skip unreadable dirs */ }
    }
  }

  return {
    name: meta.name,
    description: meta.description,
    location: skillMdPath,
    directory: skillDir,
    ...(meta.compatibility && { compatibility: meta.compatibility }),
    ...(resources.length > 0 && { resources }),
  };
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 */
function scanSkillsDirectory(dirPath) {
  const skills = [];
  if (!fs.existsSync(dirPath)) return skills;

  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const skill = readSkillDir(path.join(dirPath, entry.name));
      if (skill) skills.push(skill);
    }
  } catch { /* skip unreadable dirs */ }

  return skills;
}

/**
 * Resolve a skill reference (as typed by an agent) against a list of
 * discovered skills. A reference may be the canonical id (`plugin:name`
 * for plugin skills, bare `name` for standalone ones) or just the bare
 * name when that is unambiguous.
 *
 * Returns `{ skill }` on a unique hit, `{ error }` when the bare name is
 * ambiguous across plugins, or `{ skill: null }` when nothing matches.
 */
export function resolveSkillRef(query, skills) {
  if (!query || !Array.isArray(skills)) return { skill: null };

  // 1. Exact canonical id (covers both `plugin:name` and bare standalone).
  const byId = skills.filter(s => s.id === query);
  if (byId.length === 1) return { skill: byId[0] };

  // 2. Bare-name match — unique wins, multiple is ambiguous.
  const byName = skills.filter(s => s.name === query);
  if (byName.length === 1) return { skill: byName[0] };
  if (byName.length > 1) {
    return {
      skill: null,
      error: `Skill "${query}" is ambiguous — it ships in multiple plugins. `
        + `Use the qualified name: ${byName.map(s => s.id).join(', ')}`,
    };
  }

  return { skill: null };
}

export default {
  type: 'list_skills',
  intent: 'list_skills',
  description: 'Discover available Agent Skills by scanning skill directories. → Returns: { skills: [{ name, description, location, resources }], catalog }',
  thinkingHint: 'Examining available skills',
  permission: null,
  hidden: true,

  schema: {
    type: 'object',
    properties: {},
  },

  examples: [
    { actionType: 'direct', intent: 'list_skills' },
  ],

  async execute(action, agent) {
    // Keyed by CANONICAL id, not bare name. Standalone skills use their
    // bare name as id; plugin skills use `<pluginId>:<name>` so two
    // plugins shipping a same-named skill never collide (the old bug:
    // both landed on the same Map key / the same `~/.koi/skills/<name>`
    // folder and silently clobbered each other).
    const allSkills = new Map();

    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

    // 1. Standalone global skills: ~/.koi/skills/<name>  (id = bare name)
    const globalDir = path.join(os.homedir(), '.koi', 'skills');
    const globalSkills = scanSkillsDirectory(globalDir);
    for (const skill of globalSkills) {
      allSkills.set(skill.name, { ...skill, id: skill.name, plugin: null, scope: 'global' });
    }

    // 2. Standalone project skills: <projectRoot>/.koi/skills/<name>
    //    (overrides a same-named global standalone skill)
    const projectDir = path.join(projectRoot, '.koi', 'skills');
    const projectSkills = scanSkillsDirectory(projectDir);
    for (const skill of projectSkills) {
      allSkills.set(skill.name, { ...skill, id: skill.name, plugin: null, scope: 'project' });
    }

    // 3. Plugin skills — discovered IN PLACE from each active plugin's
    //    own `skills/` dir (installed cache, project plugins, and the
    //    admin/dev marketplace checkout all flow through the plugin
    //    registry). NEVER flattened into the shared skills dir, and
    //    namespaced as `<pluginId>:<name>` so collisions are impossible.
    let pluginSkillCount = 0;
    try {
      const { pluginManager } = await import('../../plugins/plugin-manager.js');
      pluginManager.load(projectRoot); // idempotent — no-op once loaded
      for (const ps of pluginManager.getActiveSkills()) {
        // ps: { name, path, dir, pluginId }
        const skill = readSkillDir(ps.dir);
        if (!skill) continue;
        const id = `${ps.pluginId}:${skill.name}`;
        allSkills.set(id, { ...skill, id, plugin: ps.pluginId, scope: 'plugin' });
        pluginSkillCount++;
      }
    } catch { /* plugin manager unavailable — standalone skills only */ }

    // 4. Admin/dev marketplace checkout (koi-language/plugins next to the
    //    koi-cli source). Scanned explicitly — and LAST — so in-development
    //    plugin skills always show and override a same-id installed plugin,
    //    even when they aren't marked "active" in the saved plugin config.
    //    The qualified `<pluginId>:<name>` id means anything already added
    //    via getActiveSkills() above simply dedupes on the same Map key.
    for (const p of listAdminPluginDirs()) {
      for (const skill of scanSkillsDirectory(path.join(p.dir, 'skills'))) {
        const id = `${p.id}:${skill.name}`;
        allSkills.set(id, { ...skill, id, plugin: p.id, scope: 'admin' });
        pluginSkillCount++;
      }
    }

    // Defensive dedup against the old flatten bug. Older builds copied each
    // plugin's skills into the shared `.koi/skills/<name>` dir as bare-name
    // standalone folders. Now that plugin skills are discovered in place and
    // namespaced `<pluginId>:<name>`, those leftover flat copies double-list —
    // e.g. `ab-testing` (stale standalone) next to `marketing-skills:ab-testing`
    // (the canonical namespaced one). Drop a standalone skill whenever a
    // plugin/admin skill ships the same bare name. Self-healing: works even
    // when the install manifest that the plugin-manager migration relies on is
    // missing, so old checkouts stop showing every skill twice.
    const _pluginBareNames = new Set();
    for (const s of allSkills.values()) {
      if (s.scope === 'plugin' || s.scope === 'admin') _pluginBareNames.add(s.name);
    }
    const _shadowed = [];
    for (const [key, s] of allSkills) {
      if ((s.scope === 'global' || s.scope === 'project') && _pluginBareNames.has(s.name)) {
        allSkills.delete(key);
        _shadowed.push(s.location);
      }
    }
    if (_shadowed.length > 0) {
      const { channel: ch } = await import('../../io/channel.js');
      ch.log('skills', `list_skills: hid ${_shadowed.length} stale flattened standalone skill(s) shadowed by namespaced plugin skills (delete these dirs to silence): ${_shadowed.join(', ')}`);
    }

    if (allSkills.size === 0) {
      const { channel: ch } = await import('../../io/channel.js');
      ch.log('skills', `list_skills: no skills found. Searched: global=${globalDir} (${globalSkills.length}), project=${projectDir} (${projectSkills.length}), plugins=${pluginSkillCount}, KOI_PROJECT_ROOT=${projectRoot}`);
    }

    const skills = Array.from(allSkills.values());

    // Public output: the agent sees the CANONICAL id as the skill name so
    // it learns to call plugin skills as `plugin:name`. Standalone skills
    // keep their bare name unchanged.
    const publicSkills = skills.map(({ id, description }) => ({ name: id, description }));

    let catalog = '';
    if (skills.length > 0) {
      const entries = skills.map(s => `  <skill name="${s.id}">${s.description}</skill>`);
      catalog = '<available_skills>\n' + entries.join('\n') + '\n</available_skills>';
    }

    // _fullSkills includes id/location/directory for internal use by activate_skill
    return { skills: publicSkills, _fullSkills: skills, catalog };
  },
};
