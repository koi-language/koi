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

  async execute(action, agent) {
    const { taskId, ...updates } = action;
    // Strip non-update fields
    delete updates.actionType;
    delete updates.intent;
    delete updates.id;

    try {
      const task = taskManager.update(taskId, updates);

      // Release skills tied to this task when it terminates. Paired with
      // the activation in `task_create`: whatever was activated because
      // the task entered the queue gets deactivated now so it doesn't
      // bloat the system prompt for unrelated work. If the calling agent
      // isn't the one that activated the skill (e.g. System created the
      // task and a delegate finishes it), we try the calling agent's
      // state as a best-effort — the deactivate action itself no-ops
      // when the skill isn't active.
      if (updates.status === 'completed' || updates.status === 'deleted') {
        const scoped = taskManager.popScopedSkills(taskId);
        if (scoped.length > 0 && agent && typeof agent.callAction === 'function') {
          for (const { skillName } of scoped) {
            try {
              await agent.callAction('deactivate_skill', { name: skillName });
            } catch { /* non-fatal */ }
          }
        }
      }

      return task;
    } catch (err) {
      return { error: err.message };
    }
  },
};
