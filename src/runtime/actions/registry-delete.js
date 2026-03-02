/**
 * Registry Delete Action - Delete data from registry
 */

export default {
  type: 'registry_delete',          // Mantener temporalmente
  intent: 'registry_delete',        // NUEVO: identificador semántico
  description: 'Delete data from the shared registry',
  thinkingHint: 'Cleaning up',
  permission: 'registry:write', // Requires registry:write permission (or registry)

  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Registry key to delete (e.g., "user:123")'
      }
    },
    required: ['key']
  },

  examples: [
    { type: 'registry_delete', key: 'user:123' }
  ],

  // Executor function
  async execute(action, agent) {
    const key = action.key;

    if (!key) {
      throw new Error('registry_delete action requires "key" field');
    }

    const deleted = await globalThis.registry.delete(key);
    return { success: true, key, deleted };
  }
};
