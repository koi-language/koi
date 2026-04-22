import { channel } from '../../io/channel.js';
/**
 * Deactivate Skill Action — Remove a skill from the active set.
 */

export default {
  type: 'deactivate_skill',
  intent: 'deactivate_skill',
  description: 'Deactivate an active skill by name. Fields: "name" (required). → Returns: { deactivated, name, activeSkills }',
  thinkingHint: (action) => `Deactivating skill: ${action.name || '...'}`,
  permission: null,
  hidden: true,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to deactivate',
      },
    },
    required: ['name'],
  },

  examples: [
    { actionType: 'direct', intent: 'deactivate_skill', name: 'api-development' },
  ],

  async execute(action, agent) {
    const skillName = action.name;
    if (!skillName) {
      return { deactivated: false, error: 'Missing required field: name' };
    }

    const currentSkills = Array.isArray(agent.state?.skills) ? [...agent.state.skills] : [];

    if (!currentSkills.includes(skillName)) {
      return { deactivated: false, error: `Skill "${skillName}" is not currently active. Active: ${currentSkills.join(', ') || 'none'}` };
    }

    const newSkills = currentSkills.filter(s => s !== skillName);

    // Also drop the skill's markdown content from `_skillContents` — that
    // map is what llm-provider injects into the system prompt. Without
    // this the instructions for a "deactivated" skill keep leaking into
    // every future turn and the prompt grows unbounded across long
    // sessions.
    const currentContents = { ...(agent.state?._skillContents || {}) };
    if (currentContents[skillName]) {
      delete currentContents[skillName];
    }

    // Update agent state via agent.callAction (avoids circular import)
    await agent.callAction('update_state', { updates: { skills: newSkills, _skillContents: currentContents } });

    channel.print(`\x1b[33m✗\x1b[0m \x1b[2mSkill deactivated: \x1b[1m${skillName}\x1b[0m`);
    channel.skillDeactivated?.({ agent: agent.name, skill: skillName });

    return {
      deactivated: true,
      name: skillName,
      activeSkills: newSkills,
    };
  },
};
