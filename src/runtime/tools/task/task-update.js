/**
 * Task Update Action — Update task status, ownership, or dependency links.
 */

import { taskManager } from '../../state/task-manager.js';

export default {
  type: 'task_update',
  intent: 'task_update',
  description: 'Update task status, ownership, or dependency links → Returns: updated task object',
  thinkingHint: 'Updating task',
  permission: 'write_tasks',

  schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New status for the task',
      },
      owner: {
        type: 'string',
        description: 'Agent or person responsible for this task',
      },
      subject: {
        type: 'string',
        description: 'Updated task title',
      },
      description: {
        type: 'string',
        description: 'Updated task description',
      },
      activeForm: {
        type: 'string',
        description: 'Updated present-continuous label shown while in_progress',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task can start',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that depend on this task completing first',
      },
    },
    required: ['taskId'],
  },

  examples: [
    { actionType: 'direct', intent: 'task_update', taskId: '2', status: 'in_progress' },
    { actionType: 'direct', intent: 'task_update', taskId: '2', status: 'completed' },
    { actionType: 'direct', intent: 'task_update', taskId: '4', addBlockedBy: ['2', '3'] },
  ],

  async execute(action) {
    const { taskId, ...updates } = action;
    // Strip non-update fields
    delete updates.actionType;
    delete updates.intent;
    delete updates.id;

    try {
      const task = taskManager.update(taskId, updates);
      return task;
    } catch (err) {
      return { error: err.message };
    }
  },
};
