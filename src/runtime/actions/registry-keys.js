/**
 * Registry Keys Action - List keys with prefix
 */

export default {
  type: 'registry_keys',          // Mantener temporalmente
  intent: 'registry_keys',        // NUEVO: identificador semántico
  description: 'List all registry keys with optional prefix → Returns: { success, count, keys: [array of key strings] }',
  thinkingHint: 'Listing keys',
  permission: 'registry:read', // Requires registry:read permission (or registry)

  schema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Optional prefix to filter keys (e.g., "user:")'
      }
    }
  },

  examples: [
    { type: 'registry_keys', prefix: 'user:' },
    { type: 'registry_keys', prefix: '' }
  ],

  // Executor function
  async execute(action, agent) {
    const prefix = action.prefix || '';

    const keys = await globalThis.registry.keys(prefix);
    return { success: true, count: keys.length, keys };
  }
};
