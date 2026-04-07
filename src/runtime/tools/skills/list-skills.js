/**
 * List Skills Action — Discover and list available Agent Skills.
 *
 * Scans predefined directories for SKILL.md files, parses YAML frontmatter,
 * and returns a catalog of available skills with name, description, and location.
 *
 * Discovery paths:
 *   - Global: ~/.koi/skills/
 *   - Project-level: <projectRoot>/.koi/skills/  (overrides global)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts name and description from the --- delimited YAML block.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name' || key === 'description' || key === 'compatibility' || key === 'license') {
      result[key] = value;
    }
  }

  return (result.name && result.description) ? result : null;
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 */
function scanSkillsDirectory(dirPath, maxDepth = 4) {
  const skills = [];
  if (!fs.existsSync(dirPath)) return skills;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;

      const skillMdPath = path.join(dirPath, entry.name, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        try {
          const content = fs.readFileSync(skillMdPath, 'utf-8');
          const meta = parseFrontmatter(content);
          if (meta) {
            // List bundled resources (references/, scripts/, assets/)
            const skillDir = path.join(dirPath, entry.name);
            const resources = [];
            for (const subdir of ['references', 'scripts', 'assets']) {
              const subdirPath = path.join(skillDir, subdir);
              if (fs.existsSync(subdirPath)) {
                try {
                  const files = fs.readdirSync(subdirPath);
                  for (const f of files) {
                    resources.push(`${subdir}/${f}`);
                  }
                } catch { /* skip unreadable dirs */ }
              }
            }

            skills.push({
              name: meta.name,
              description: meta.description,
              location: skillMdPath,
              directory: skillDir,
              ...(meta.compatibility && { compatibility: meta.compatibility }),
              ...(resources.length > 0 && { resources }),
            });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* skip unreadable dirs */ }

  return skills;
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
    const allSkills = new Map(); // keyed by name, project-level overrides global

    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

    // 1. Global skills: ~/.koi/skills/
    const globalDir = path.join(os.homedir(), '.koi', 'skills');
    const globalSkills = scanSkillsDirectory(globalDir);
    for (const skill of globalSkills) {
      allSkills.set(skill.name, { ...skill, scope: 'global' });
    }

    // 2. Project-level skills: <projectRoot>/.koi/skills/  (overrides global)
    const projectDir = path.join(projectRoot, '.koi', 'skills');
    const projectSkills = scanSkillsDirectory(projectDir);
    for (const skill of projectSkills) {
      allSkills.set(skill.name, { ...skill, scope: 'project' });
    }

    if (allSkills.size === 0) {
      const { channel: ch } = await import('../../io/channel.js');
      ch.log('skills', `list_skills: no skills found. Searched: global=${globalDir} (${globalSkills.length}), project=${projectDir} (${projectSkills.length}), KOI_PROJECT_ROOT=${projectRoot}`);
    }

    const skills = Array.from(allSkills.values());

    // Public output: only name + description (no file paths)
    const publicSkills = skills.map(({ name, description }) => ({ name, description }));

    let catalog = '';
    if (skills.length > 0) {
      const entries = skills.map(s => `  <skill name="${s.name}">${s.description}</skill>`);
      catalog = '<available_skills>\n' + entries.join('\n') + '\n</available_skills>';
    }

    // _fullSkills includes location/directory for internal use by activate_skill
    return { skills: publicSkills, _fullSkills: skills, catalog };
  },
};
