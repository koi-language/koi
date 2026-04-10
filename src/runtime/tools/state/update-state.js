/**
 * Update State Action - Update agent internal state.
 *
 * NOTE: `statusPhase` is reserved — phase transitions MUST come from
 * reactions declared in the .koi agent (see agent.reactions). The agent
 * cannot change its own phase via update_state; it's a read-only field
 * from its point of view.
 */

export default {
  type: 'update_state',
  intent: 'update_state',
  description: 'Update agent internal state (for agent memory/context). NOTE: "statusPhase" is read-only — phase transitions are driven by the agent\'s reactions block, not by the LLM.',
  thinkingHint: 'Updating state',
  permission: 'execute',

  schema: {
    type: 'object',
    properties: {
      updates: {
        type: 'object',
        description: 'Key-value pairs to update in agent state (cannot include statusPhase)'
      }
    },
    required: ['updates']
  },

  examples: [
    { type: 'update_state', updates: { counter: 5, lastUser: 'Alice' } }
  ],

  // Executor function
  async execute(action, agent) {
    const updates = action.updates || action.state || {};

    // `statusPhase` is ALWAYS read-only from the LLM's point of view.
    // Phase transitions are driven exclusively by the reactions block
    // in the agent's .koi declaration. Silently strip it from updates.
    if ('statusPhase' in updates) {
      const { channel } = await import('../../io/channel.js');
      channel.log('state', `${agent.name}: Ignored statusPhase change from update_state (phase is managed by reactions).`);
      delete updates.statusPhase;
    }

    Object.keys(updates).forEach(key => {
      agent.state[key] = updates[key];
    });

    // Filter internal fields (prefixed with _) from the result shown to the LLM.
    const visibleState = {};
    for (const [k, v] of Object.entries(agent.state)) {
      if (!k.startsWith('_')) visibleState[k] = v;
    }
    return { state_updated: true, state: visibleState };
  }
};
