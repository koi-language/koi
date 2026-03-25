/**
 * Queue Add Action — Add a new item to the agent's internal work queue.
 *
 * The user's request becomes a Task in the queue. The agent should make the
 * description as complete as possible, asking the user for clarification if needed.
 */

import { workQueue } from '../work-queue.js';

export default {
  type: 'queue_add',
  intent: 'queue_add',
  description: 'Add a new item to the internal work queue. Every user request MUST become a queue item. Fields: "subject" (short title of the request), "description" (detailed description — as complete as possible, including user context, constraints, and any clarifications received). → Returns: { id, subject, description, status }',
  thinkingHint: 'Adding to work queue',
  permission: 'write_tasks',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Short title of the user request (e.g. "Add dark mode", "Fix login bug")',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the request. Include all known context: what the user asked, relevant constraints, tech details, file paths mentioned, etc. This can be updated later as more info is discovered.',
      },
    },
    required: ['subject'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'queue_add',
      subject: 'Add dark mode support',
      description: 'User wants to add dark mode to the application. They mentioned using CSS variables and a toggle in the header. No specific color palette mentioned yet.',
    },
    {
      actionType: 'direct',
      intent: 'queue_add',
      subject: 'Fix login timeout error',
      description: 'User reports that login fails with a timeout after 30 seconds. Happens only on staging environment.',
    },
  ],

  async execute(action, agent) {
    const { subject, description } = action;

    if (!subject) {
      return { success: false, error: 'queue_add: "subject" is required' };
    }

    try {
      const item = workQueue.add({
        subject,
        description: description || '',
        owner: agent?.name || 'unknown',
      });

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
