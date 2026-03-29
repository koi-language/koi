/**
 * Queue Update Action — Update an item in the agent's work queue.
 *
 * Used to:
 * - Append user feedback to an existing queue item's description
 * - Update the description as the agent discovers new information
 * - Change status (pending → in_progress → completed)
 * - Update the subject if the scope changed
 */

import { workQueue as _globalQueue, WorkQueue } from '../../state/work-queue.js';

export default {
  type: 'queue_update',
  intent: 'queue_update',
  description: 'Update a work queue item. Fields: "id" (required), "subject" (new title), "description" (appended to existing description by default), "replaceDescription" (true to replace instead of append), "feedback" (user feedback to append as a marked section), "status" (pending|in_progress|completed|deleted). → Returns: { id, subject, description, status }',
  thinkingHint: 'Updating work queue item',
  permission: 'write_tasks',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The ID of the queue item to update',
      },
      subject: {
        type: 'string',
        description: 'New title for the item (if scope changed)',
      },
      description: {
        type: 'string',
        description: 'Additional description to append (or replace if replaceDescription=true). Use this when the agent discovers new information about the task.',
      },
      replaceDescription: {
        type: 'boolean',
        description: 'If true, replace the entire description instead of appending. Default: false.',
      },
      feedback: {
        type: 'string',
        description: 'User feedback to append as a clearly marked section. Use this when the user provides corrections or additional requirements.',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New status for the item',
      },
    },
    required: ['id'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'queue_update',
      id: '1',
      feedback: 'Actually, use OAuth instead of email/password for the login page',
    },
    {
      actionType: 'direct',
      intent: 'queue_update',
      id: '1',
      status: 'in_progress',
    },
    {
      actionType: 'direct',
      intent: 'queue_update',
      id: '2',
      description: 'Found that the timeout is caused by missing connection pool config in database.js line 45.',
    },
    {
      actionType: 'direct',
      intent: 'queue_update',
      id: '1',
      status: 'completed',
    },
  ],

  async execute(action, agent) {
    const { id, subject, description, replaceDescription, feedback, status } = action;

    if (!id) {
      return { success: false, error: 'queue_update: "id" is required' };
    }

    try {
      if (agent && !agent._workQueue) agent._workQueue = new WorkQueue(agent.name);
      const queue = agent?._workQueue || _globalQueue;
      const updates = {};
      if (subject !== undefined) updates.subject = subject;
      if (description !== undefined) {
        updates.description = description;
        if (replaceDescription) updates.replaceDescription = true;
      }
      if (feedback !== undefined) updates.feedback = feedback;
      if (status !== undefined) updates.status = status;

      const item = queue.update(id, updates);

      return {
        success: true,
        id: item.id,
        subject: item.subject,
        description: item.description,
        status: item.status,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
