/**
 * Activate Skill Action — Load a skill's full instructions into context.
 *
 * Per agentskills.io: reads the SKILL.md body, adds the skill to state.skills,
 * and returns the content wrapped with resource metadata.
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../../io/channel.js';
import { resolveSkillRef } from './list-skills.js';

export default {
  type: 'activate_skill',
  intent: 'activate_skill',
  description: 'Activate a skill by name. Reads its SKILL.md instructions and adds it to active skills (its full body is injected into your system prompt under "# Active Skill Instructions" — it is NOT returned here to avoid duplication). Fields: "name" (required). → Returns: { activated, name, directory, resources }',
  thinkingHint: (action) => `Activating skill: ${action.name || '...'}`,
  permission: null,

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
    const result = await agent.callAction('list_skills', {});
    // Use _fullSkills (includes location) for internal resolution
    const skills = result?._fullSkills || result?.skills;
    if (!skills) {
      return { activated: false, error: 'Could not discover skills' };
    }

    // Resolve by canonical id (`plugin:name`) or bare name (when unique).
    const { skill, error: resolveError } = resolveSkillRef(skillName, skills);
    if (resolveError) {
      return { activated: false, error: resolveError };
    }
    if (!skill) {
      const available = skills.map(s => s.id || s.name).join(', ');
      return { activated: false, error: `Skill "${skillName}" not found. Available: ${available}` };
    }
    // Everything downstream keys off the canonical id so two same-named
    // skills from different plugins never overwrite each other in state.
    const skillId = skill.id || skill.name;

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

    // Store the canonical skill id in agent state (for prompt display).
    // Skill CONTENT is injected by the runtime directly into the system prompt —
    // it does NOT go through state to avoid bloating the user prompt with duplicate content.
    const currentSkills = Array.isArray(agent.state?.skills) ? [...agent.state.skills] : [];
    if (!currentSkills.includes(skillId)) {
      currentSkills.push(skillId);
    }

    // Store content in state._skillContents (internal, not serialized to user prompt).
    // The runtime reads this for system prompt injection. Keyed by canonical
    // id so two same-named plugin skills don't clobber each other's content.
    const currentContents = agent.state?._skillContents || {};
    currentContents[skillId] = content;
    agent.state._skillContents = currentContents;

    // Only names go to state
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

    channel.log('skill', `Skill activated: ${skillId}`);
    // Live lifecycle event: lets the GUI footer attach this skill to the
    // agent that activated it and drop it later on deactivate. Safe no-op
    // on channels that don't implement it.
    // instanceId disambiguates parallel delegates that share `name` ("Worker"):
    // without it the footer attaches the skill to only the first matching row.
    channel.skillActivated?.({ agent: agent.name, instanceId: agent.state?._uiInstanceId, skill: skillId });

    // Record the activation so the prompt can pre-expand most-used / recent
    // skills (best-effort — never block activation on usage stats).
    try {
      const { recordSkillUse } = await import('./skill-usage-store.js');
      recordSkillUse(skillId);
    } catch { /* usage tracking is optional */ }

    // NOTE: do NOT return `content` here. The full SKILL.md body is injected
    // into the system prompt by the runtime from state._skillContents (see
    // llm-provider.js `# Active Skill Instructions`). Returning it again would
    // duplicate the entire skill in the tool result — the LLM already has it in
    // context, and the GUI would render the whole body a second time.
    return {
      activated: true,
      name: skillId,
      directory: skillDir,
      ...(resources.length > 0 && { resources }),
    };
  },
};
