/**
 * phase_done — Signal that the agent has finished the work of the current phase.
 *
 * The agent does not decide which phase comes next. Invoking `phase_done`
 * fires a `phase.done` event that the agent's `reactions { }` block maps to
 * the next phase. If no matching reaction exists, the phase does not change.
 *
 * Use this when the agent has no user-visible result to report (e.g. the
 * Developer finishes `exploring` and wants to move on to `implementing`).
 */

import { fireReaction } from '../../agent/reactions.js';

export default {
  type: 'phase_done',
  intent: 'phase_done',
  description: 'Signal that you have finished the work of your current phase. The runtime will transition to the next phase based on the agent\'s declared reactions. You do NOT pick the next phase — just announce "I am done here".',
  thinkingHint: 'Advancing phase',
  permission: 'execute',

  schema: {
    type: 'object',
    properties: {},
    required: [],
  },

  examples: [
    { type: 'phase_done' }
  ],

  async execute(action, agent) {
    const currentPhase = agent.state?.statusPhase || null;
    if (!currentPhase) {
      return { success: false, error: 'No active phase to finish.' };
    }

    // Fire phase.done event with the current phase name as arg.
    // Reactions can match with `on phase(<name>).done` (specific phase) or
    // `on phase.done` without an arg to match any phase.
    fireReaction(agent, 'phase.done', currentPhase, {
      phase: { name: currentPhase },
      state: agent.state,
    });

    const newPhase = agent.state?.statusPhase;
    if (newPhase === currentPhase) {
      return {
        success: true,
        message: `Phase "${currentPhase}" acknowledged as done, but no reaction matched — still in the same phase.`,
      };
    }
    return {
      success: true,
      message: `Phase transition: ${currentPhase} → ${newPhase}`,
      phase: newPhase,
    };
  },
};
