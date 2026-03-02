/**
 * Send Message Action - Send message to team members
 */

export default {
  type: 'send_message',          // Mantener temporalmente
  intent: 'send_message',        // NUEVO: identificador semántico
  description: 'Send message to team members (explicit team communication)',
  thinkingHint: 'Sending message',
  permission: 'delegate', // Requires delegate permission - only orchestrators can send messages

  schema: {
    type: 'object',
    properties: {
      event: {
        type: 'string',
        description: 'Event name to trigger'
      },
      role: {
        type: 'string',
        description: 'Optional role name to filter recipients'
      },
      data: {
        type: 'object',
        description: 'Data payload to send'
      }
    },
    required: ['event', 'data']
  },

  examples: [
    { type: 'send_message', event: 'processData', role: 'Worker', data: { id: 123 } }
  ],

  // Executor function
  async execute(action, agent) {
    if (process.env.KOI_DEBUG_LLM) {
      const roleFilter = action.role ? ` (role: ${action.role})` : '';
      console.error(`[Agent] 📨 ${agent.name} sending message: ${action.event}${roleFilter}`);
    }

    // Build query using peers API
    let query = agent.peers.event(action.event);

    // Add role filter if specified
    if (action.role) {
      query = query.role(action.role);
    }

    // Execute the query with any selector
    const result = await query.any().execute(action.data);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent] ✅ Message sent, result:`, result);
    }

    return result;
  }
};
