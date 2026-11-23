/**
 * classify: ask typed questions about a piece of content and get each answer with its probability, from a
 * decision model (a classifier) through the Koi API, in a fraction of a second and for a fraction of a cent.
 *
 * Basic tool: every agent has it, whatever its role grants (`permission: null`), because deciding, labelling and
 * scoring is part of almost any job and it is far cheaper and faster here than reasoning it out with the model.
 */
import { decide } from '../../llm/decisions.js';

export default {
  type: 'classify',
  intent: 'classify',
  description:
    'Ask typed questions about a piece of content and get each answer with its probability, from a fast, very cheap ' +
    'classifier. Use it whenever the job is to DECIDE, LABEL or SCORE something (route a ticket, tag a document, ' +
    'rate urgency, check a yes/no condition), instead of reasoning it out yourself. Put ALL the questions about the ' +
    'same content in ONE call. Types: "choice" picks one label of a closed list of mutually exclusive labels ' +
    '(criteria: {label: meaning}); "score" picks a level on an ordered scale (criteria: [lowest, ..., highest]); ' +
    '"noul" judges a yes/no statement and returns its probability (independent or multi-label tags: one noul each). ' +
    'Look at the probabilities: a low one means the content is unclear, so check it before acting on it.',
  thinkingHint: 'Classifying',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      state: {
        description: 'The content to judge: a text, or an object with named fields (e.g. {"ticket": "...", "customer": "..."})',
      },
      questions: {
        type: 'object',
        description:
          'One entry per question, keyed by a name of your choice: {"type": "choice"|"score"|"noul", "instructions": ' +
          '"the question", "criteria": {label: meaning} for choice, [levels...] for score, optional {true, false} for noul}',
      },
      model: { type: 'string', description: 'A specific decision model (optional; by default the cheapest active one)' },
    },
    required: ['state', 'questions'],
  },

  examples: [
    {
      intent: 'classify',
      state: { ticket: 'My checkout page shows a blank screen after I click Pay.' },
      questions: {
        team: { type: 'choice', instructions: 'Which team should own this ticket?', criteria: { payments: 'Checkout and billing', account: 'Login and permissions', frontend: 'Layout and rendering' } },
        urgency: { type: 'score', instructions: 'How urgent is it?', criteria: ['Can wait', 'This week', 'Blocking sales now'] },
        is_bug: { type: 'noul', instructions: 'Does it describe broken behaviour of the product?' },
      },
    },
  ],

  async execute(action, agent) {
    const state = action.state ?? action.data?.state;
    const questions = action.questions ?? action.data?.questions;
    const model = action.model ?? action.data?.model ?? null;
    const classifier = agent?.llmProvider?._getClassifier?.();
    const llm = classifier
      ? (prompt) => classifier.runCheapJsonCompletion(prompt, { timeoutMs: 30000, maxTokens: 1200, label: 'classify-fallback' })
      : null;
    try {
      const result = await decide({ state, questions, model, llm });
      if (!result) {
        return { success: false, error: 'No classifier could answer (no decision model reachable and no fallback model).' };
      }
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
