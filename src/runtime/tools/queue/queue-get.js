/**
 * Queue Get Action — Retrieve a single work queue item by ID.
 *
 * Used by the agent to get the full description of a queue item,
 * including all accumulated feedback and discovered information.
 */

import { workQueue as _globalQueue, WorkQueue } from '../../state/work-queue.js';

export default {
  type: 'queue_get',
  intent: 'queue_get',
  description: 'Get a single work queue item by ID. Returns the full item with all accumulated description and feedback. Fields: "id" (the item ID). → Returns: { id, subject, description, status, createdAt, updatedAt }',
  thinkingHint: 'Loading queue item',
  permission: 'read_tasks',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The ID of the queue item to retrieve',
      },
    },
    required: ['id'],
  },

  examples: [
    { actionType: 'direct', intent: 'queue_get', id: '1' },
  ],

  async execute(action, agent) {
    const { id } = action;

    if (!id) {
      return { success: false, error: 'queue_get: "id" is required' };
    }

    try {
      if (agent && !agent._workQueue) agent._workQueue = new WorkQueue(agent.name);
      const queue = agent?._workQueue || _globalQueue;
      const item = queue.get(id);
      if (!item) {
        return { success: false, error: `Queue item ${id} not found` };
      }

      return {
        success: true,
        ...item,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
