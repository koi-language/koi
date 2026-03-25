/**
 * Agenda Update Action — Modify an existing agenda entry.
 *
 * Allows updating title, description, scheduled time, recurrence, or status.
 */

import { agendaManager } from '../../state/agenda-manager.js';

export default {
  type: 'agenda_update',
  intent: 'agenda_update',
  description: 'Update an existing agenda entry. Fields: "id" (required), "title", "scheduledAt" (ISO 8601), "description", "recurrence" (once|daily|weekly|monthly), "status" (pending|triggered|completed|cancelled). → Returns: { id, title, scheduledAt, status }',
  thinkingHint: 'Updating agenda entry',
  permission: 'agenda',
  hidden: false,

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
    const { id, title, scheduledAt, description, recurrence, status } = action;

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
