/**
 * Deactivate Skill Action — Remove a skill from the active set.
 */

export default {
  type: 'deactivate_skill',
  intent: 'deactivate_skill',
  description: 'Deactivate an active skill by name. Fields: "name" (required). → Returns: { deactivated, name, activeSkills }',
  thinkingHint: 'Unloading skill',
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

    // Update agent state via agent.callAction (avoids circular import)
    await agent.callAction('update_state', { updates: { skills: newSkills } });

    return {
      deactivated: true,
      name: skillName,
      activeSkills: newSkills,
    };
  },
};
