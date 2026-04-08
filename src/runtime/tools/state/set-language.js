/**
 * Set Language Action — Sets the communication language for all agents.
 *
 * Updates the global singleton (globalThis.__koiUserLanguage) and the
 * agent's own state so that all agents — current and future delegates —
 * use the same language for user-facing output.
 *
 * Permission: null (available to all agents, like print).
 */

export default {
  type: 'set_language',
  intent: 'set_language',
  description: 'Set the language for all user-facing communication',
  thinkingHint: 'Setting language',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: 'Language name in English (e.g. "Spanish", "English", "French", "German")'
      }
    },
    required: ['language']
  },

  examples: [
    { intent: 'set_language', language: 'Spanish' },
    { intent: 'set_language', language: 'English' },
    { intent: 'set_language', language: 'French' },
  ],

  async execute(action, agent) {
    const language = action.language;
    if (!language || typeof language !== 'string') {
      return { success: false, error: 'set_language: "language" field is required (e.g. "Spanish")' };
    }

    // Update global singleton — all agents see this immediately
    globalThis.__koiUserLanguage = language;

    // Update agent's own state — persists across iterations
    if (agent?.state) {
      agent.state.userLanguage = language;
    }

    return { success: true, language };
  }
};
