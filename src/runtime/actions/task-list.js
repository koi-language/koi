/**
 * Task List Action — Display all tasks with status and dependencies.
 */

import { taskManager } from '../task-manager.js';


export default {
  type: 'task_list',
  intent: 'task_list',
  description: 'List all tasks with their status and dependencies → Returns: { tasks, summary }',
  thinkingHint: 'Loading tasks',
  permission: 'read_tasks',

  schema: {
    type: 'object',
    properties: {},
  },

  examples: [
    { actionType: 'direct', intent: 'task_list' },
  ],

  async execute() {
    const tasks = taskManager.list();

    if (tasks.length === 0) {
      return { tasks: [], summary: { total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0 } };
    }

    // Build a lookup map for blocked-state computation
    const taskMap = {};
    for (const t of tasks) taskMap[t.id] = t;

    const getEffectiveStatus = (task) => {
      if (task.status !== 'pending') return task.status;
      const isBlocked = task.blockedBy.some(depId => {
        const dep = taskMap[depId];
        return !dep || dep.status !== 'completed';
      });
      return isBlocked ? 'blocked' : 'pending';
    };

    const counts = { completed: 0, in_progress: 0, pending: 0, blocked: 0 };
    for (const task of tasks) {
      const eff = getEffectiveStatus(task);
      counts[eff] = (counts[eff] || 0) + 1;
    }

    return {
      tasks,
      summary: {
        total: tasks.length,
        completed: counts.completed || 0,
        in_progress: counts.in_progress || 0,
        pending: counts.pending || 0,
        blocked: counts.blocked || 0,
      },
    };
  },
};
