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

      // ── Auto-activate skills when the task STARTS being worked on ──
      // Anchor point: the transition pending/… → in_progress, BUT only
      // when the calling agent is ALSO the one marked as owner on the
      // task. That gate is what keeps System's prompt clean when it
      // routes work:
      //
      //   - System delegates → emits `task_update status=in_progress
      //     owner=worker` before the delegate handle starts. The
      //     calling agent is System but `task.owner` is `worker` →
      //     skip. The delegate, on entering its own handle(), runs
      //     `_autoActivateSkills` via the `isDelegate` branch in
      //     agent.js and activates skills on its own state.
      //
      //   - System executes directly → sets `owner=System` on itself
      //     (or no owner at all) → match → activate on System.
      //
      //   - Delegate re-affirms `in_progress` with its own name → match
      //     → activate on the delegate. Harmless idempotent overlap
      //     with the `isDelegate` handle-start hook (activate_skill is
      //     idempotent).
      //
      // Doing this at task_create would activate on the creator (often
      // System) even when it intends to delegate — polluting System's
      // prompt with markdown it won't use. See task-create.js.
      if (
        updates.status === 'in_progress' &&
        agent &&
        typeof agent._autoActivateSkills === 'function' &&
        (task.owner == null || task.owner === agent.name)
      ) {
        try {
          const before = new Set(Array.isArray(agent.state?.skills) ? agent.state.skills : []);
          await agent._autoActivateSkills({
            subject: task.subject,
            description: task.description,
          });
          const afterList = Array.isArray(agent.state?.skills) ? agent.state.skills : [];
          const added = afterList.filter(s => !before.has(s));
          if (added.length > 0) {
            taskManager.recordScopedSkills(
              taskId,
              added.map(name => ({ agentName: agent.name, skillName: name })),
            );
          }
        } catch { /* non-fatal */ }
      }

      // Release skills tied to this task when it terminates. Paired with
      // the activation above: whatever was activated because the task
      // started gets deactivated on completion/deletion so the prompt
      // doesn't accumulate stale skill instructions between tasks.
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
