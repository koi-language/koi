/**
 * Agenda Add Action — Schedule a new entry in the agent's agenda.
 *
 * Agents use this to schedule reminders, tasks, or events at specific
 * dates/times. Supports one-time, simple recurrence, and cron expressions.
 */

import { agendaManager } from '../../state/agenda-manager.js';
import { isExitOnComplete } from '../../util/interactivity.js';

export default {
  type: 'agenda_add',
  intent: 'agenda_add',
  description: 'Schedule a task to run LATER — record it and STOP (do NOT do the work now; an autonomous session runs it when it fires). Fields: "title", "scheduledAt" (ISO 8601 +TZ, e.g. "2026-03-22T14:30:00+01:00"), "description" (the full self-contained instruction the future session runs), "recurrence" (once|daily|weekly|monthly|cron, default once). NOTE: a task that is ITSELF a fired scheduled run cannot use this — if such a task fails, do NOT schedule a retry; instead mark it completed via agenda_update with a "summary" of what failed. → Returns: { id, title, scheduledAt, recurrence, status }',
  thinkingHint: 'Scheduling agenda entry',
  permission: 'agenda',
  // Hidden + blocked in headless exit mode (`--exit`): an unattended one-shot
  // run must not touch the agenda. agenda_update stays available so a fired task
  // can still mark itself completed / report its summary.
  // EXCEPTION: a Telegram chat (KOI_TG_CHAT=1) is a live conversation with the
  // user present — not a one-shot task — so it CAN schedule. The KOI_AGENDA_FIRED
  // backstop below still blocks a fired task from self-rescheduling.
  hidden: () => isExitOnComplete() && process.env.KOI_TG_CHAT !== '1',

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
        description: 'The full self-contained instruction the firing session runs. It has no memory of this chat and cannot ask the user, so include everything it needs: steps, commands, URLs, paths, IDs, success criteria. Only ask the user upfront for what the future session couldn\'t get itself (credentials, an id, a choice). COMMUNICATION: if the task must message the user or wait for their reply (Telegram, etc.), instruct it to use the communication tools (telegram_send to message, telegram_ask to ask-and-wait) — these are already configured. NEVER write a bot token, curl/HTTP call, script, or step-by-step API recipe into the instruction; just say e.g. "Use telegram_ask to ask the user … and telegram_send to reply with …".',
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
    {
      // Telegram task: communicate ONLY through the tools — no token, no script.
      actionType: 'direct',
      intent: 'agenda_add',
      title: 'Ask the user for a colour over Telegram',
      scheduledAt: '2026-03-23T15:40:00+01:00',
      description: 'Use telegram_ask to ask the user "¿Qué color quieres que traduzca al inglés?" and wait for their reply. Then translate the colour they give to English and use telegram_send to reply with the translation.',
      recurrence: 'once',
    },
  ],

  async execute(action, agent) {
    const { title, scheduledAt, description, recurrence } = action;

    // Headless exit mode (`--exit`): the agenda tools are hidden and disabled.
    // Guard the execute path too, in case the tool is invoked directly. A live
    // Telegram chat (KOI_TG_CHAT=1) is exempt — the user is present and can ask
    // to schedule things; only true one-shot/unattended runs are blocked.
    if (isExitOnComplete() && process.env.KOI_TG_CHAT !== '1') {
      return {
        success: false,
        error: 'agenda_add is not available in headless exit mode (--exit). Agenda scheduling is disabled in unattended one-shot runs.',
      };
    }

    // A fired agenda task may NOT schedule new agenda entries. This is the hard
    // backstop against runaway self-rescheduling: a task that fails its work
    // must NOT spawn a "retry" task (which would fail and spawn another …). If a
    // fired task failed, it should mark itself completed via agenda_update with
    // a summary explaining the failure — not create more tasks.
    if (process.env.KOI_AGENDA_FIRED === '1') {
      return {
        success: false,
        error: 'A fired scheduled task cannot create new agenda entries. Do NOT schedule a retry. If the work failed, call agenda_update to mark THIS task completed with a "summary" explaining what failed.',
      };
    }

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
