/**
 * Registry Search Action - Search registry with query
 */

export default {
  type: 'registry_search',          // Mantener temporalmente
  intent: 'registry_search',        // NUEVO: identificador semántico
  description: 'Search registry with MongoDB-style query → Returns: { success, count, results: [array of {key, value} objects] }',
  thinkingHint: 'Searching registry',
  permission: 'registry:read', // Requires registry:read permission (or registry)

  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'object',
        description: 'MongoDB-style query object (e.g., { age: { $gte: 18 } })'
      }
    },
    required: ['query']
  },

  examples: [
    { type: 'registry_search', query: { age: { $gte: 18 } } },
    { type: 'registry_search', query: { status: 'active' } }
  ],

  // Executor function
  async execute(action, agent) {
    const query = action.query || {};

    const results = await globalThis.registry.search(query);
    return { success: true, count: results.length, results };
  }
};
