/**
 * Task Get Action — Retrieve full details of a task by ID.
 */

import { taskManager } from '../../state/task-manager.js';

export default {
  type: 'task_get',
  intent: 'task_get',
  description: 'Get full details of a task by ID → Returns: task object with id, subject, description, status, owner, blockedBy, createdAt, updatedAt',
  thinkingHint: 'Loading task',
  permission: 'read_tasks',

  schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to retrieve',
      },
    },
    required: ['taskId'],
  },

  examples: [
    { actionType: 'direct', intent: 'task_get', taskId: '1' },
  ],

  async execute(action) {
    const task = taskManager.get(action.taskId);
    if (!task) {
      return { error: `Task ${action.taskId} not found` };
    }
    return task;
  },
};
