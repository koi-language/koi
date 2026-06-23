/**
 * Agenda Remove Action — Cancel a scheduled agenda entry.
 *
 * Marks the entry as 'cancelled'. It will no longer trigger.
 */

import { agendaManager } from '../../state/agenda-manager.js';
import { isExitOnComplete } from '../../util/interactivity.js';

export default {
  type: 'agenda_remove',
  intent: 'agenda_remove',
  description: 'Cancel a scheduled agenda entry by ID. The entry is marked as cancelled and will not trigger. Fields: "id" (the entry ID to cancel). → Returns: { id, title, status }',
  thinkingHint: 'Cancelling agenda entry',
  permission: 'agenda',
  // Hidden + blocked in headless exit mode (`--exit`) — see agenda-add.js.
  // A live Telegram chat (KOI_TG_CHAT=1) is exempt: the user is present.
  hidden: () => isExitOnComplete() && process.env.KOI_TG_CHAT !== '1',

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
    if (isExitOnComplete() && process.env.KOI_TG_CHAT !== '1') {
      return {
        success: false,
        error: 'agenda_remove is not available in headless exit mode (--exit). Agenda access is disabled in unattended one-shot runs.',
      };
    }

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
