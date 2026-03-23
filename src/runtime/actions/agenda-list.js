/**
 * Agenda List Action — Query and display scheduled agenda entries.
 *
 * Lists agenda entries with optional filters by date range, status, or agent.
 */

import { agendaManager } from '../agenda-manager.js';

export default {
  type: 'agenda_list',
  intent: 'agenda_list',
  description: 'List scheduled agenda entries with optional filters. Fields (all optional): "from" (ISO date, entries from this date), "to" (ISO date, entries until this date), "status" (pending|triggered|completed|cancelled), "agentName" (filter by creator). → Returns: { entries, count }',
  thinkingHint: 'Loading agenda',
  permission: 'agenda',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description: 'Only entries scheduled at or after this ISO 8601 date',
      },
      to: {
        type: 'string',
        description: 'Only entries scheduled at or before this ISO 8601 date',
      },
      status: {
        type: 'string',
        enum: ['pending', 'triggered', 'completed', 'cancelled'],
        description: 'Filter by entry status',
      },
      agentName: {
        type: 'string',
        description: 'Filter by the agent that created the entry',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'agenda_list' },
    { actionType: 'direct', intent: 'agenda_list', status: 'pending' },
    { actionType: 'direct', intent: 'agenda_list', from: '2025-03-22T00:00:00', to: '2025-03-23T00:00:00' },
  ],

  async execute(action) {
    const { from, to, status, agentName } = action;

    try {
      const entries = agendaManager.list({ from, to, status, agentName });

      return {
        entries,
        count: entries.length,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
