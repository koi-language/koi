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

  async execute(action) {
    // NOTE: auto-skill-activation does NOT fire here on purpose. When
    // System enqueues a task it usually delegates it to a specialist,
    // so activating skills on System at creation time would pollute
    // System's system prompt with domain markdown it won't even use
    // (e.g. mobile-development / docx / …) while the real executor
    // runs in its own context. The delegate's own `isDelegate`
    // auto-activate hook in agent.js handles that case. When System
    // executes directly instead, it claims the task via `task_update
    // status=in_progress` — that's where skills activate, scoped to
    // whichever agent actually takes ownership. See task-update.js.
    const task = taskManager.create({
      subject: action.subject,
      description: action.description,
      activeForm: action.activeForm || null,
    });

    return { id: task.id, subject: task.subject, status: task.status };
  },
};
