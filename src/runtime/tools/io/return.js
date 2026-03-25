/**
 * Return Action - Return final result
 */

export default {
  type: 'return',          // Mantener temporalmente
  intent: 'return',        // NUEVO: identificador semántico
  description: 'Return final result from action sequence. CRITICAL: Return RAW data structures (objects, arrays) NOT formatted strings or markdown tables. If playbook says "Return: { count, users: [array] }", return actual JSON array not a formatted table string.',
  thinkingHint: 'Finishing',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        description: 'Data to return as final result'
      }
    },
    required: ['data']
  },

  examples: [
    { type: 'return', data: { success: true, message: 'Completed' } },
    { type: 'return', data: { user: 'Alice', success: true } }
  ],

  // Executor function
  async execute(action, agent) {
    return action.data || action.result || {};
  }
};
