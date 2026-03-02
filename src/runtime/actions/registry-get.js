/**
 * Registry Get Action - Load data from registry
 */

export default {
  type: 'registry_get',          // Mantener temporalmente
  intent: 'registry_get',        // NUEVO: identificador semántico
  description: 'Load data from the shared registry → Returns: { success, key, value, found }',
  thinkingHint: 'Retrieving data',
  permission: 'registry:read', // Requires registry:read permission (or registry)

  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Registry key to fetch (e.g., "user:123")'
      }
    },
    required: ['key']
  },

  examples: [
    { type: 'registry_get', key: 'user:123' }
  ],

  // Executor function
  async execute(action, agent) {
    const key = action.key;

    if (!key) {
      throw new Error('registry_get action requires "key" field');
    }

    const value = await globalThis.registry.get(key);
    return { success: true, key, value, found: value !== null };
  }
};
