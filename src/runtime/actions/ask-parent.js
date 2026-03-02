/**
 * Ask Parent Action — Allow a delegate agent to ask a question to the agent that invoked it.
 *
 * When a delegate agent cannot proceed due to missing information that cannot be found
 * by reading the codebase, it can use this action to ask the calling (parent) agent.
 * The runtime intercepts the signal, calls the parent agent's LLM to answer, and
 * re-invokes the delegate with args.answer set to the answer.
 *
 * This is a generic runtime mechanism that works for any parent/child agent pair.
 */

export default {
  type: 'ask_parent',
  intent: 'ask_parent',
  description: 'Ask the calling (parent) agent a question when you cannot proceed without more information. The runtime will pause, ask the parent, and re-call you with args.answer set to the answer. Requires: question (the specific question you need answered)',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The specific question to ask the parent agent' },
    },
    required: ['question'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'ask_parent',
      question: 'Which database adapter should I use — SQLite or PostgreSQL?',
    },
  ],

  async execute(action) {
    const { question } = action;

    if (!question) {
      throw new Error('ask_parent: "question" field is required');
    }

    return { __askParent__: true, question };
  },
};
