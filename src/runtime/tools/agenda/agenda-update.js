/**
 * Agenda Update Action — Modify an existing agenda entry.
 *
 * Allows updating title, description, scheduled time, recurrence, or status.
 */

import { agendaManager } from '../../state/agenda-manager.js';
import { isExitOnComplete } from '../../util/interactivity.js';

export default {
  type: 'agenda_update',
  intent: 'agenda_update',
  description: 'Update an existing agenda entry. Fields: "id" (required), "title", "scheduledAt" (ISO 8601), "description", "recurrence" (once|daily|weekly|monthly), "status" (pending|triggered|completed|cancelled), "summary", "preview". IMPORTANT: when you finish a scheduled task and set status to "completed", also pass a concise "summary" (1-3 sentences) of what you accomplished — shown to the user in the calendar. For PUBLISHING tasks (social posts), also pass "preview" = an array of posts, each { "networks": ["Facebook","X",…], "text": "the post caption", "media": ["/abs/path/to/image.png", …] } so the user can preview exactly what will be / was posted. → Returns: { id, title, scheduledAt, status }',
  thinkingHint: 'Updating agenda entry',
  permission: 'agenda',
  // Hidden + blocked in headless exit mode (`--exit`). A fired scheduled task
  // has NO agenda awareness: it just runs its injected prompt and exits. The
  // task's lifecycle (running on start, completed/failed on exit) is owned by
  // the agenda daemon, not self-reported by the agent. See agenda-add.js.
  // A live Telegram chat (KOI_TG_CHAT=1) is exempt: the user is present.
  hidden: () => isExitOnComplete() && process.env.KOI_TG_CHAT !== '1',

  schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The ID of the agenda entry to update',
      },
      title: {
        type: 'string',
        description: 'New title for the entry',
      },
      scheduledAt: {
        type: 'string',
        description: 'New scheduled date/time in ISO 8601 format',
      },
      description: {
        type: 'string',
        description: 'New description for the entry',
      },
      recurrence: {
        type: 'string',
        enum: ['once', 'daily', 'weekly', 'monthly'],
        description: 'New recurrence pattern',
      },
      status: {
        type: 'string',
        enum: ['pending', 'triggered', 'completed', 'cancelled'],
        description: 'New status for the entry',
      },
      summary: {
        type: 'string',
        description: 'Concise summary (1-3 sentences) of what was accomplished. Set this when marking a scheduled task completed — shown to the user in the calendar.',
      },
      preview: {
        type: 'array',
        description: 'For publishing tasks: the post(s) that will be / were published, so the user can preview them. Each item: { networks: ["Facebook","X",…], text: "the caption", media: ["/abs/path/to/file.png", …] }.',
        items: {
          type: 'object',
          properties: {
            networks: { type: 'array', items: { type: 'string' } },
            text: { type: 'string' },
            media: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to the generated media files' },
          },
        },
      },
    },
    required: ['id'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'agenda_update',
      id: '2',
      scheduledAt: '2025-03-23T10:00:00',
    },
    {
      actionType: 'direct',
      intent: 'agenda_update',
      id: '1',
      status: 'completed',
    },
  ],

  async execute(action) {
    if (isExitOnComplete() && process.env.KOI_TG_CHAT !== '1') {
      return {
        success: false,
        error: 'agenda_update is not available in headless exit mode (--exit). A scheduled run has no agenda awareness; its status is managed by the agenda daemon.',
      };
    }

    const { id, title, scheduledAt, description, recurrence, status, summary, preview } = action;

    if (!id) {
      return { success: false, error: 'agenda_update: "id" is required' };
    }

    try {
      const updates = {};
      if (title !== undefined) updates.title = title;
      if (scheduledAt !== undefined) updates.scheduledAt = scheduledAt;
      if (description !== undefined) updates.description = description;
      if (recurrence !== undefined) updates.recurrence = recurrence;
      if (status !== undefined) updates.status = status;
      if (summary !== undefined) updates.summary = summary;
      if (preview !== undefined) updates.preview = preview;

      const entry = agendaManager.update(id, updates);
      return {
        success: true,
        id: entry.id,
        title: entry.title,
        scheduledAt: entry.scheduledAt,
        recurrence: entry.recurrence,
        status: entry.status,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
