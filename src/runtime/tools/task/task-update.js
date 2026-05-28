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
        enum: ['pending', 'in_progress', 'completed', 'cancelled', 'deleted'],
        description: 'New status for the task. `cancelled` is reserved for plans paused by the Stop button — it is RESUMABLE: transitioning a `cancelled` task back to `pending` or `in_progress` is how the agent resumes the plan. `deleted` is permanent dismissal (user declined the plan).',
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
      approved: {
        type: 'boolean',
        description: 'Record the user\'s explicit approval of a task flagged requiresApproval. Set true ONLY after the user has actually given their go-ahead (via prompt_user). Once approved, the task\'s return is no longer blocked. NEVER set this without an explicit user confirmation.',
      },
      requiresApproval: {
        type: 'boolean',
        description: 'Mark/unmark that this task needs explicit user approval before it can be completed. Usually set at creation time via task_create; update it here only to add an approval gate you missed.',
      },
      approvalNote: {
        type: 'string',
        description: 'Update the free-text note describing what the user must validate and how to ask them (paired with requiresApproval).',
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

      // ── Auto-activate skills when the task STARTS being worked on ──
      // Anchor point: the transition pending/… → in_progress, BUT only
      // when the calling agent is ALSO the one marked as owner on the
      // Pre-task skill auto-activation was removed — the agent loads
      // skills on demand from the catalog in its system prompt
      // (progressive disclosure). No classifier fires here on
      // task_update anymore.

      // Release skills tied to this task when it terminates. Paired with
      // the activation above: whatever was activated because the task
      // started gets deactivated on completion/deletion so the prompt
      // doesn't accumulate stale skill instructions between tasks.
      if (updates.status === 'completed' ||
          updates.status === 'cancelled' ||
          updates.status === 'deleted') {
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
