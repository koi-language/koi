/**
 * phase_done — Signal that the agent has finished the work of the current phase.
 *
 * The agent does not decide which phase comes next. Invoking `phase_done`
 * fires a `phase.done` event that the agent's `reactions { }` block maps to
 * the next phase. If no matching reaction exists, the call returns
 * `success: false` with an actionable hint: previously it was a silent
 * no-op (success: true) which the LLM would interpret as "all good, keep
 * going", and the agent then looped — System's `routing` phase has no
 * `routing.done` transition (it terminates with `prompt_user`), so any
 * phase_done from there was the start of a spin until max_tokens.
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
  // Any agent may end its phase and keep its state; neither needs `execute`, the SHELL permission (23/11/2026).
  permission: null,

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
      // No reaction wired for this phase → phase_done is a no-op here.
      // Previously we returned `success: true` with a soft message, but
      // the agent loop reads that as "the action did its job, keep going"
      // and appends a "Continue." prompt; the LLM then has no clear next
      // step and tends to spam phase_done (or fall back to repeated
      // prompt_user emissions, blowing past max_tokens). Reporting
      // failure with an actionable hint pushes the model toward the
      // correct alternative (prompt_user to suspend, or a real next
      // action) and breaks the loop at the source.
      return {
        success: false,
        error:
          `phase_done is a no-op in phase "${currentPhase}": the agent's ` +
          `reactions block does not declare a transition for ` +
          `phase("${currentPhase}").done, so this call would not advance ` +
          `state. Choose a concrete next action instead — typically ` +
          `\`prompt_user\` to suspend and wait for the user, or another ` +
          `action that progresses the current task. Do not retry ` +
          `\`phase_done\` from this phase.`,
      };
    }
    return {
      success: true,
      message: `Phase transition: ${currentPhase} → ${newPhase}`,
      phase: newPhase,
    };
  },
};
