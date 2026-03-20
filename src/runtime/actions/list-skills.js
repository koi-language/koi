/**
 * List Skills Action — Discover and list available Agent Skills (agentskills.io standard).
 *
 * Scans predefined directories for SKILL.md files, parses YAML frontmatter,
 * and returns a catalog of available skills with name, description, and location.
 *
 * Discovery paths (per agentskills.io convention):
 *   - Project-level: <projectRoot>/.agents/skills/
 *   - User-level: ~/.agents/skills/
 *   - Built-in: skills bundled with the agent (via agent.builtinSkillsDir)
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
  thinkingHint: 'Discovering skills',
  permission: null,

  schema: {
    type: 'object',
    properties: {},
  },

  examples: [
    { actionType: 'direct', intent: 'list_skills' },
  ],

  async execute(action, agent) {
    const allSkills = new Map(); // keyed by name, project-level overrides user-level

    // Determine project root
    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

    // 1. User-level skills: ~/.agents/skills/
    const userSkillsDir = path.join(os.homedir(), '.agents', 'skills');
    for (const skill of scanSkillsDirectory(userSkillsDir)) {
      allSkills.set(skill.name, { ...skill, scope: 'user' });
    }

    // 2. User-level client-specific: ~/.koi/skills/
    const koiUserSkillsDir = path.join(os.homedir(), '.koi', 'skills');
    for (const skill of scanSkillsDirectory(koiUserSkillsDir)) {
      allSkills.set(skill.name, { ...skill, scope: 'user' });
    }

    // 3. Project-level skills: <projectRoot>/.agents/skills/
    const projectSkillsDir = path.join(projectRoot, '.agents', 'skills');
    for (const skill of scanSkillsDirectory(projectSkillsDir)) {
      allSkills.set(skill.name, { ...skill, scope: 'project' }); // project overrides user
    }

    // 4. Project-level client-specific: <projectRoot>/.koi/skills/
    const koiProjectSkillsDir = path.join(projectRoot, '.koi', 'skills');
    for (const skill of scanSkillsDirectory(koiProjectSkillsDir)) {
      allSkills.set(skill.name, { ...skill, scope: 'project' });
    }

    // 5. Built-in skills (from agent config or env var)
    const builtinDir = process.env.KOI_BUILTIN_SKILLS_DIR
      || agent?.builtinSkillsDir
      || null;
    if (builtinDir) {
      for (const skill of scanSkillsDirectory(builtinDir)) {
        // Built-in skills don't override project/user skills
        if (!allSkills.has(skill.name)) {
          allSkills.set(skill.name, { ...skill, scope: 'builtin' });
        }
      }
    }

    // 6. Additional directories from action params
    if (Array.isArray(action.directories)) {
      for (const dir of action.directories) {
        const resolvedDir = path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
        for (const skill of scanSkillsDirectory(resolvedDir)) {
          if (!allSkills.has(skill.name)) {
            allSkills.set(skill.name, { ...skill, scope: 'custom' });
          }
        }
      }
    }

    const skills = Array.from(allSkills.values());

    // Build pre-formatted catalog (XML per agentskills.io convention)
    let catalog = '';
    if (skills.length > 0) {
      const entries = skills.map(s => {
        const resources = s.resources ? ` resources="${s.resources.join(', ')}"` : '';
        return `  <skill name="${s.name}" location="${s.location}"${resources}>${s.description}</skill>`;
      });
      catalog = '<available_skills>\n' + entries.join('\n') + '\n</available_skills>';
    }

    return { skills, catalog };
  },
};
