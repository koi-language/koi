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
      requiresApproval: {
        type: 'boolean',
        description: 'Set true when the user MUST explicitly approve this task before it can be completed. The agent that executes it will be BLOCKED from finishing (return) until the user gives their go-ahead. Use for irreversible / costly / published / destructive actions, or any deliverable the user must sign off on. When true, you MUST also provide approvalNote.',
      },
      approvalNote: {
        type: 'string',
        description: 'Required when requiresApproval is true. Free text telling the executor WHAT the user has to validate and HOW to ask them — the executor has no other context for the approval question. E.g. "Before publishing, show the user the final caption + image and ask them to confirm it can go live on Instagram."',
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
    // workflowRunId is an internal field set by run_workflow when it
    // instantiates a workflow's steps as tasks — NOT advertised in the
    // schema so the LLM doesn't try to pass it. Lets agent.js group
    // sibling tasks for PRIOR STEPS injection + shared workspace dir.

    // Auto-propagate user-attached media paths into the task description.
    // When the caller (e.g. Planner) was invoked with `args.userAttachments`
    // — set by the delegate dispatch path in agent.js when the user attached
    // media to the conversation — the executor of THIS new task must see
    // those paths too. The Planner's LLM frequently rewrites the description
    // in its own words and drops the paths, leaving the Worker unable to
    // pass them to `generate_image` / `generate_video` as references. This
    // runtime stamp guarantees the paths reach the executor regardless of
    // what the LLM chose to copy into the spec.
    let description = action.description || '';
    try {
      const _args = agent?._activeSession?.actionContext?.args;
      const _parentAttachments = Array.isArray(_args?.userAttachments) ? _args.userAttachments : [];
      if (_parentAttachments.length > 0 && !description.includes('## ATTACHED MEDIA')) {
        const _block = `\n\n## ATTACHED MEDIA (provided by the user — pass to media tools as referenceImages / referenceVideos when relevant)\n${_parentAttachments.map((p) => `- ${p}`).join('\n')}`;
        description = description + _block;
      }
    } catch { /* non-fatal — never block task creation on this stamp */ }

    const task = taskManager.create({
      subject: action.subject,
      description,
      activeForm: action.activeForm || null,
      workflowRunId: action.workflowRunId || undefined,
      requiresApproval: action.requiresApproval === true,
      approvalNote: action.approvalNote || '',
    });

    return {
      id: task.id,
      subject: task.subject,
      status: task.status,
      requiresApproval: task.requiresApproval,
    };
  },
};
