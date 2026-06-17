/**
 * Describe Agent — read what a delegate agent does and how to call it.
 *
 * The AVAILABLE AGENTS section lists agents by NAME only (to keep the prompt
 * small). This is the analog of `get_tool_info` for delegation: call it before
 * delegating to learn an agent's purpose and its delegable intents (with the
 * params each one takes).
 */

export default {
  type: 'describe_agent',
  intent: 'describe_agent',
  description:
    'Read an agent\'s description and its delegable intents (with params), to decide whether and how to delegate. '
    + 'AVAILABLE AGENTS lists only names; call this when a name is not enough. '
    + 'Fields: "name" (required). '
    + '→ Returns: { agent, description, intents: [{ name, description, params, isAsync }] }',
  thinkingHint: 'Looking up agent info',
  permission: 'delegate',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The agent name exactly as shown in AVAILABLE AGENTS.',
      },
    },
    required: ['name'],
  },

  examples: [
    { intent: 'describe_agent', name: 'Explorer' },
  ],

  async execute(action, agent) {
    const { name } = action;
    if (!name) return { success: false, error: 'Missing required field: name' };

    const { collectPeerIntents } = await import('../../llm/system-prompt-builder.js');
    const peers = collectPeerIntents(agent);
    if (peers.length === 0) {
      return { success: false, error: 'No agents are available to delegate to.' };
    }

    const lc = String(name).toLowerCase();
    const match = peers.find(p => p.agentPureName?.toLowerCase() === lc)
      || peers.find(p => p.agentName?.toLowerCase() === lc)
      || peers.find(p => p.agentPureName?.toLowerCase().includes(lc));
    if (!match) {
      const available = peers.map(p => p.agentPureName).join(', ');
      return { success: false, error: `Unknown agent "${name}". Available: ${available}` };
    }

    return {
      success: true,
      agent: match.agentPureName,
      description: match.agentDescription || null,
      intents: (match.handlers || []).map(h => ({
        name: h.name,
        description: h.description,
        params: h.params || [],
        isAsync: !!h.isAsync,
      })),
    };
  },
};
