/**
 * Deactivate Workflow Action — Clear the active workflow marker on the agent.
 *
 * Workflows do not inject content into the prompt (unlike skills), so
 * deactivation just clears the bookkeeping flag used for telemetry / GUI.
 */

import { channel } from '../../io/channel.js';

export default {
  type: 'deactivate_workflow',
  intent: 'deactivate_workflow',
  description: 'Deactivate the currently active workflow (clears state.activeWorkflow). → Returns: { deactivated, name }',
  thinkingHint: 'Deactivating workflow',
  permission: null,
  hidden: true,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Optional. Only deactivate if this matches the active workflow.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'deactivate_workflow' },
  ],

  async execute(action, agent) {
    const active = agent.state?.activeWorkflow || null;
    if (!active) {
      return { deactivated: false, name: null };
    }
    if (action.name && action.name !== active) {
      return { deactivated: false, name: active, error: `Active workflow is "${active}", not "${action.name}"` };
    }

    await agent.callAction('update_state', { updates: { activeWorkflow: null } });
    channel.log('workflow', `Workflow deactivated: ${active}`);
    channel.workflowDeactivated({ name: active });
    return { deactivated: true, name: active };
  },
};
