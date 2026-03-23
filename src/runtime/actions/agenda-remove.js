/**
 * Agenda Remove Action — Cancel a scheduled agenda entry.
 *
 * Marks the entry as 'cancelled'. It will no longer trigger.
 */

import { agendaManager } from '../agenda-manager.js';

export default {
  type: 'agenda_remove',
  intent: 'agenda_remove',
  description: 'Cancel a scheduled agenda entry by ID. The entry is marked as cancelled and will not trigger. Fields: "id" (the entry ID to cancel). → Returns: { id, title, status }',
  thinkingHint: 'Cancelling agenda entry',
  permission: 'agenda',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The ID of the agenda entry to cancel',
      },
    },
    required: ['id'],
  },

  examples: [
    { actionType: 'direct', intent: 'agenda_remove', id: '3' },
  ],

  async execute(action) {
    const { id } = action;

    if (!id) {
      return { success: false, error: 'agenda_remove: "id" is required' };
    }

    try {
      const entry = agendaManager.remove(id);
      return {
        success: true,
        id: entry.id,
        title: entry.title,
        status: entry.status,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
