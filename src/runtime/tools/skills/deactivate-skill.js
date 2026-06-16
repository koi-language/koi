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

    // Active entries are canonical ids (`plugin:name` or bare `name`). Accept
    // either the full id or the bare name (the part after the colon) as the
    // reference, as long as it resolves uniquely among the active skills.
    const bareOf = (id) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
    const matches = currentSkills.filter(s => s === skillName || bareOf(s) === skillName);
    if (matches.length === 0) {
      return { deactivated: false, error: `Skill "${skillName}" is not currently active. Active: ${currentSkills.join(', ') || 'none'}` };
    }
    if (matches.length > 1) {
      return { deactivated: false, error: `"${skillName}" is ambiguous among active skills. Use the qualified name: ${matches.join(', ')}` };
    }
    const skillId = matches[0];

    const newSkills = currentSkills.filter(s => s !== skillId);

    // Also drop the skill's markdown content from `_skillContents` — that
    // map is what llm-provider injects into the system prompt. Without
    // this the instructions for a "deactivated" skill keep leaking into
    // every future turn and the prompt grows unbounded across long
    // sessions.
    const currentContents = { ...(agent.state?._skillContents || {}) };
    if (currentContents[skillId]) {
      delete currentContents[skillId];
    }

    // Update agent state via agent.callAction (avoids circular import)
    await agent.callAction('update_state', { updates: { skills: newSkills, _skillContents: currentContents } });

    // Log only — do NOT `print` to the chat. Skill (de)activation is
    // internal bookkeeping the user didn't ask to see; activation
    // already uses `channel.log` for the same reason. The structured
    // `skillDeactivated` event still fires so the GUI can update its
    // skills state without a chat line.
    channel.log('skill', `Skill deactivated: ${skillId}`);
    channel.skillDeactivated?.({ agent: agent.name, instanceId: agent.state?._uiInstanceId, skill: skillId });

    return {
      deactivated: true,
      name: skillId,
      activeSkills: newSkills,
    };
  },
};
