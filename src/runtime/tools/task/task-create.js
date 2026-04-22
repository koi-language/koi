/**
 * Task Create Action — Add a new task to the session task list.
 */

import { taskManager } from '../../state/task-manager.js';

export default {
  type: 'task_create',
  intent: 'task_create',
  description: 'Create a new task in the session task list → Returns: { id, subject, status }',
  thinkingHint: 'Creating task',
  permission: 'write_tasks',

  schema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Short imperative title (e.g. "Set up database schema")',
      },
      description: {
        type: 'string',
        description: 'Detailed requirements and acceptance criteria',
      },
      activeForm: {
        type: 'string',
        description: 'Present-continuous label shown while in_progress (e.g. "Setting up database")',
      },
    },
    required: ['subject', 'description'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'task_create',
      subject: 'Set up database schema',
      description: 'Create tables for users, sessions, and audit logs',
      activeForm: 'Setting up database',
    },
    {
      actionType: 'direct',
      intent: 'task_create',
      subject: 'Write unit tests',
      description: 'Add tests for auth middleware and user routes',
    },
  ],

  async execute(action, agent) {
    const task = taskManager.create({
      subject: action.subject,
      description: action.description,
      activeForm: action.activeForm || null,
    });

    // Auto-activate any skills whose description matches this task, then
    // tie the activations to the task so `task_update` can release them
    // when the task is done. Best-effort: if the classifier is slow or
    // fails the task itself is still created successfully.
    //
    // Why here (task_create) and not at delegate-handle start only: System
    // (the root coordinator) never went through the existing delegate-side
    // auto-activate (`isDelegate` gate in agent.js), so whenever System
    // executed work directly the Skills panel stayed empty. Tying it to
    // the task lifecycle makes the behaviour uniform for every agent —
    // System and delegates alike — and the deactivation on completion
    // keeps the prompt from accumulating stale skill instructions.
    if (agent && typeof agent._autoActivateSkills === 'function') {
      try {
        const before = new Set(Array.isArray(agent.state?.skills) ? agent.state.skills : []);
        await agent._autoActivateSkills({
          subject: action.subject,
          description: action.description,
        });
        const afterList = Array.isArray(agent.state?.skills) ? agent.state.skills : [];
        const added = afterList.filter(s => !before.has(s));
        if (added.length > 0) {
          taskManager.recordScopedSkills(
            task.id,
            added.map(name => ({ agentName: agent.name, skillName: name })),
          );
        }
      } catch { /* non-fatal */ }
    }

    return { id: task.id, subject: task.subject, status: task.status };
  },
};
