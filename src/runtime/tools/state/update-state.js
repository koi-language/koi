/**
 * Update State Action - Update agent internal state
 */

export default {
  type: 'update_state',          // Mantener temporalmente
  intent: 'update_state',        // NUEVO: identificador semántico
  description: 'Update agent internal state (for agent memory/context)',
  thinkingHint: 'Updating state',
  permission: 'execute', // Requires execute permission

  schema: {
    type: 'object',
    properties: {
      updates: {
        type: 'object',
        description: 'Key-value pairs to update in agent state'
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
    const oldPhase = agent.state?.statusPhase;

    Object.keys(updates).forEach(key => {
      agent.state[key] = updates[key];
    });

    // Log phase transitions, validate against declared phases, and apply phase profile
    if (updates.statusPhase && updates.statusPhase !== oldPhase) {
      const { channel } = await import('../../io/channel.js'); const cliLogger = channel;
      const declaredPhases = agent.phases;

      // Validate: if agent declared phases, only allow those
      if (declaredPhases?._validPhases?.length > 0) {
        if (!declaredPhases._validPhases.includes(updates.statusPhase)) {
          return {
            success: false,
            error: `Invalid phase "${updates.statusPhase}". Valid phases: ${declaredPhases._validPhases.join(', ')}`,
          };
        }
      }

      cliLogger.log('state', `[phase] ${agent.name}: ${oldPhase || '(none)'} → ${updates.statusPhase}`);

      // Apply phase profile to the session for model selection
      const phaseProfile = declaredPhases?.[updates.statusPhase];
      if (phaseProfile) {
        const session = agent._activeSession;
        if (session) {
          session._phaseProfile = phaseProfile;
          cliLogger.log('state', `[phase] Profile: ${JSON.stringify(phaseProfile)}`);
        }
      }

      // Phase change = agent now has more context → reclassify to pick the right model.
      const session = agent._activeSession;
      if (session) session._needsReclassify = true;
    }

    // Filter internal fields (prefixed with _) from the result shown to the LLM.
    // Internal fields like _skillContents are used by the runtime but shouldn't bloat the user prompt.
    const visibleState = {};
    for (const [k, v] of Object.entries(agent.state)) {
      if (!k.startsWith('_')) visibleState[k] = v;
    }
    return { state_updated: true, state: visibleState };
  }
};
