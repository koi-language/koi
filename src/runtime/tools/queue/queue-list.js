/**
 * Queue List Action — List items in the agent's internal work queue.
 *
 * Returns queue items with optional status filter. Used by the agent to
 * check its backlog and decide what to work on next.
 */

import { workQueue as _globalQueue, WorkQueue } from '../../state/work-queue.js';

export default {
  type: 'queue_list',
  intent: 'queue_list',
  description: 'List items in the internal work queue. Optional filter: "status" (pending|in_progress|completed|deleted). → Returns: { items, count, summary }',
  thinkingHint: 'Checking work queue',
  permission: 'read_tasks',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'Filter by item status. Omit to see all non-deleted items.',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'queue_list' },
    { actionType: 'direct', intent: 'queue_list', status: 'pending' },
  ],

  async execute(action, agent) {
    const { status } = action;

    try {
      if (agent && !agent._workQueue) agent._workQueue = new WorkQueue(agent.name);
      const queue = agent?._workQueue || _globalQueue;
      const items = queue.list(status ? { status } : {});
      const summary = queue.getSummary();

      return {
        items,
        count: items.length,
        summary: summary || 'Work queue is empty.',
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
