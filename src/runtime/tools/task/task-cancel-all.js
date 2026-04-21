/**
 * Task Cancel All Action — Abort the current plan by marking every
 * pending/in_progress task as deleted in a single action.
 *
 * Purpose: give the System agent a one-shot escape hatch when the user
 * declines the plan mid-run. Without this, cancelling requires calling
 * task_update once per task — and worse, if any task stays pending the
 * runtime's auto-recovery block (agent.js) forces another LLM turn with
 * "Plan incomplete — N task(s) still pending. Resuming automatically…".
 * After task_cancel_all, the unfinished list is empty so auto-recovery
 * is skipped and the phase can close cleanly in the same turn.
 */

import { taskManager } from '../../state/task-manager.js';

export default {
  type: 'task_cancel_all',
  intent: 'task_cancel_all',
  description: 'Mark every pending/in_progress task as deleted — use this when the user declines or aborts the plan. Returns: { cancelled: N }',
  thinkingHint: 'Cancelling plan',
  permission: 'write_tasks',

  schema: {
    type: 'object',
    properties: {},
  },

  examples: [
    { actionType: 'direct', intent: 'task_cancel_all' },
  ],

  async execute() {
    const pending = taskManager.list().filter(
      (t) => t.status === 'pending' || t.status === 'in_progress'
    );
    for (const t of pending) {
      try {
        taskManager.update(t.id, { status: 'deleted' });
      } catch { /* swallow — best-effort cancel */ }
    }
    return { cancelled: pending.length };
  },
};
