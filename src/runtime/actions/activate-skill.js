/**
 * Activate Skill Action — Load a skill's full instructions into context.
 *
 * Per agentskills.io: reads the SKILL.md body, adds the skill to state.skills,
 * and returns the content wrapped with resource metadata.
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'activate_skill',
  intent: 'activate_skill',
  description: 'Activate a skill by name. Reads its SKILL.md instructions and adds it to active skills. Fields: "name" (required). → Returns: { activated, name, content, directory, resources }',
  thinkingHint: (action) => `Activating skill: ${action.name || '...'}`,
  permission: null,
  hidden: true,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to activate (e.g. "api-development")',
      },
    },
    required: ['name'],
  },

  examples: [
    { actionType: 'direct', intent: 'activate_skill', name: 'api-development' },
  ],

  async execute(action, agent) {
    const skillName = action.name;
    if (!skillName) {
      return { activated: false, error: 'Missing required field: name' };
    }

    // Use agent.callAction to call list_skills (avoids circular import of action-registry)
    const { skills } = await agent.callAction('list_skills', {});
    if (!skills) {
      return { activated: false, error: 'Could not discover skills' };
    }

    const skill = skills.find(s => s.name === skillName);
    if (!skill) {
      const available = skills.map(s => s.name).join(', ');
      return { activated: false, error: `Skill "${skillName}" not found. Available: ${available}` };
    }

    // Read the SKILL.md content
    let content;
    try {
      const raw = fs.readFileSync(skill.location, 'utf-8');
      // Strip YAML frontmatter — the agent already knows name/description
      const fmEnd = raw.indexOf('\n---', 4);
      content = fmEnd !== -1 ? raw.substring(fmEnd + 4).trim() : raw;
    } catch (err) {
      return { activated: false, error: `Failed to read ${skill.location}: ${err.message}` };
    }

    // Add to agent state.skills (dedup)
    const currentSkills = Array.isArray(agent.state?.skills) ? [...agent.state.skills] : [];
    if (!currentSkills.includes(skillName)) {
      currentSkills.push(skillName);
    }

    // Update agent state
    await agent.callAction('update_state', { updates: { skills: currentSkills } });

    // List resources in the skill directory
    const resources = [];
    const skillDir = skill.directory || path.dirname(skill.location);
    for (const subdir of ['references', 'scripts', 'assets']) {
      const subdirPath = path.join(skillDir, subdir);
      if (fs.existsSync(subdirPath)) {
        try {
          for (const f of fs.readdirSync(subdirPath)) {
            resources.push(`${skillDir}/${subdir}/${f}`);
          }
        } catch { /* skip */ }
      }
    }

    cliLogger.print(`\x1b[32m✓\x1b[0m \x1b[2mSkill activated: \x1b[1m${skillName}\x1b[0m`);

    return {
      activated: true,
      name: skillName,
      content,
      directory: skillDir,
      ...(resources.length > 0 && { resources }),
    };
  },
};
