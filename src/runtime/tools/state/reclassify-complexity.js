/**
 * Reclassify Complexity Action — Request model reselection.
 *
 * When an agent discovers that the current task is MORE or LESS complex than
 * initially estimated, it calls this action to trigger a reclassification.
 *
 * Escalate: found a race condition, multi-file refactor, complex algorithm → need stronger model.
 * De-escalate: task turned out to be a simple config change, typo fix → cheaper model is fine.
 *
 * The next LLM call will reclassify and select the appropriate model.
 * No data is lost — the agent continues seamlessly with the new model.
 */

import { channel } from '../../io/channel.js';

export default {
  type: 'reclassify_complexity',
  intent: 'reclassify_complexity',
  description: 'Signal that the task complexity has changed from the initial estimate. Call this when you discover the task is HARDER (race conditions, multi-file refactors, complex algorithms) or SIMPLER (just a config change, typo fix, simple rename) than expected. The system will reselect the model accordingly — stronger for harder tasks, cheaper/faster for simpler ones. Fields: "reason" (brief explanation of what changed). → Returns: { reclassified: true }',
  thinkingHint: 'Reclassifying task complexity',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why the complexity estimate changed. Examples: "Found race condition — need deeper analysis", "Just a typo in a config file — much simpler than expected", "Need to refactor 8 interconnected files"',
      },
    },
    required: ['reason'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'reclassify_complexity',
      reason: 'Found a race condition between the auth middleware and session handler — need deeper analysis',
    },
    {
      actionType: 'direct',
      intent: 'reclassify_complexity',
      reason: 'This is just a single-line config change, much simpler than expected',
    },
  ],

  async execute(action) {
    const reason = action.reason || 'unspecified';
    channel.log('agent', `[reclassify] Complexity changed: ${reason}`);
    return { reclassified: true, reason };
  },
};
