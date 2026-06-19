/**
 * Agenda Add Action — Schedule a new entry in the agent's agenda.
 *
 * Agents use this to schedule reminders, tasks, or events at specific
 * dates/times. Supports one-time, simple recurrence, and cron expressions.
 */

import { agendaManager } from '../../state/agenda-manager.js';

export default {
  type: 'agenda_add',
  intent: 'agenda_add',
  description: 'Schedule a task to run LATER — record it and STOP (do NOT do the work now; an autonomous session runs it when it fires). Fields: "title", "scheduledAt" (ISO 8601 +TZ, e.g. "2026-03-22T14:30:00+01:00"), "description" (the full self-contained instruction the future session runs), "recurrence" (once|daily|weekly|monthly|cron, default once). → Returns: { id, title, scheduledAt, recurrence, status }',
  thinkingHint: 'Scheduling agenda entry',
  permission: 'agenda',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short description of the agenda entry (e.g. "Deploy to staging", "Check test results")',
      },
      scheduledAt: {
        type: 'string',
        description: 'When this entry is due, in ISO 8601 format with timezone offset (e.g. "2026-03-22T14:30:00+01:00"). For recurring entries, this sets the initial time of day.',
      },
      description: {
        type: 'string',
        description: 'The full self-contained instruction the firing session runs. It has no memory of this chat and cannot ask the user, so include everything it needs: steps, commands, URLs, paths, IDs, success criteria. Only ask the user upfront for what the future session couldn\'t get itself (credentials, an id, a choice).',
      },
      recurrence: {
        type: 'string',
        description: 'Recurrence: "once" (default), "daily", "weekly", "monthly", or a cron expression (e.g. "0 9 * * MON-FRI" = weekdays at 9am, "*/30 * * * *" = every 30 min)',
      },
    },
    required: ['title', 'scheduledAt'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'agenda_add',
      title: 'Check deployment status',
      scheduledAt: '2026-03-22T15:00:00+01:00',
      description: 'Verify the staging deployment completed successfully',
      recurrence: 'once',
    },
    {
      actionType: 'direct',
      intent: 'agenda_add',
      title: 'Run daily test suite',
      scheduledAt: '2026-03-23T09:00:00+01:00',
      recurrence: 'daily',
    },
    {
      actionType: 'direct',
      intent: 'agenda_add',
      title: 'Standup reminder',
      scheduledAt: '2026-03-23T09:55:00+01:00',
      recurrence: '55 9 * * MON-FRI',
    },
  ],

  async execute(action, agent) {
    const { title, scheduledAt, description, recurrence } = action;

    if (!title || !scheduledAt) {
      return { success: false, error: 'agenda_add: "title" and "scheduledAt" are required' };
    }

    try {
      const entry = agendaManager.add({
        title,
        scheduledAt,
        description: description || '',
        recurrence: recurrence || 'once',
        agentName: agent?.name || 'unknown',
      });

      return {
        success: true,
        id: entry.id,
        title: entry.title,
        scheduledAt: entry.scheduledAt,
        cron: entry.cron || null,
        recurrence: entry.recurrence,
        status: entry.status,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
