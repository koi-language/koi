/**
 * My Task Action — Retrieve the task assigned to the calling agent.
 * Returns the first in_progress task owned by this agent, or null if none.
 */

import { taskManager } from '../../state/task-manager.js';

export default {
  type: 'my_task',
  intent: 'my_task',
  description: 'Get the task assigned to this agent (by owner) → Returns: task object with id, subject, description, status or { message } if none assigned',
  thinkingHint: 'Checking assigned task',
  permission: null,
  // Only show when agent has an assigned task
  hidden: (agent) => {
    if (!agent?.name) return true;
    try {
      const task = taskManager.getTaskByOwner(agent.name);
      return !task;
    } catch { return true; }
  },

  schema: {
    type: 'object',
    properties: {},
  },

  examples: [
    { actionType: 'direct', intent: 'my_task' },
  ],

  async execute(action, agent) {
    const agentName = agent?.name;
    if (!agentName) {
      return { error: 'Cannot determine agent name' };
    }

    const allTasks = taskManager.list();
    // Find the in_progress task owned by this agent
    const myTask = allTasks.find(t => t.owner === agentName && t.status === 'in_progress')
      || allTasks.find(t => t.owner === agentName && t.status !== 'completed');

    if (!myTask) {
      return { message: `No task assigned to ${agentName}` };
    }

    return myTask;
  },
};
