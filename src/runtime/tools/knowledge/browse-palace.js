/**
 * browse_palace — navigate the conversation memory palace by topic.
 *
 * The palace stores every past user→assistant exchange VERBATIM as a
 * "drawer", clustered into topic "rooms" per project ("wing"). This tool is
 * the BROWSING surface: list the rooms of the current project, or open one
 * room and read its drawers newest-first.
 *
 * For QUERY-based recall ("what did we say about X?") use `recall_memory`
 * instead — it searches drawers semantically and federates vault notes.
 */

import * as palace from '../../state/palace.js';

export default {
  type: 'browse_palace',
  intent: 'browse_palace',
  description:
    'Browse the conversation memory palace by TOPIC. Past conversations are ' +
    'stored verbatim as drawers (one per user/assistant exchange) grouped ' +
    'into topic rooms per project. ' +
    '\n\n' +
    'Without `room`: lists the rooms of the current project with drawer ' +
    'counts — a table of contents of everything ever discussed. ' +
    'With `room` (a label from the room list): returns that room\'s drawers ' +
    'newest-first, each with a verbatim snippet and a `dialoguePath` you can ' +
    '`read_file` for the full transcript. ' +
    '\n\n' +
    'Use this to ORIENT ("what topics have we covered?") or to review one ' +
    'topic chronologically. For query-based search ("what did we decide ' +
    'about X?") use recall_memory instead.',
  thinkingHint: 'Browsing conversation palace',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      room: {
        type: 'string',
        description:
          'OPTIONAL. A room label (as returned by the no-argument call). ' +
          'When set, returns that room\'s drawers newest-first.',
      },
      allProjects: {
        type: 'boolean',
        description:
          'OPTIONAL. Default false → scoped to the current project. Set true ' +
          'to browse across all projects.',
      },
      limit: {
        type: 'number',
        description: 'Max drawers to return when `room` is set. Default 20.',
      },
      offset: {
        type: 'number',
        description: 'Pagination offset over a room\'s drawers. Default 0.',
      },
    },
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'browse_palace',
    },
    {
      actionType: 'direct',
      intent: 'browse_palace',
      room: 'Deploy pipeline failures',
      limit: 10,
    },
  ],

  async execute(action, _agent) {
    const projectRoot = action.allProjects ? null : (process.env.KOI_PROJECT_ROOT || null);

    try {
      // ── Room view: drawers of one topic, newest-first. ──
      if (action.room && String(action.room).trim()) {
        const rooms = await palace.listRooms({ projectRoot });
        const wanted = String(action.room).trim().toLowerCase();
        const match = rooms.find((r) => (r.label || '').trim().toLowerCase() === wanted);
        if (!match) {
          return {
            success: false,
            error: `browse_palace: no room labelled "${action.room}" in this project`,
            rooms: rooms.map((r) => ({ label: r.label, drawerCount: r.drawerCount })),
          };
        }
        const limit = typeof action.limit === 'number' ? action.limit : 20;
        const offset = typeof action.offset === 'number' ? action.offset : 0;
        const drawers = await palace.listDrawers({
          projectRoot,
          roomId: match.id,
          limit,
          offset,
        });
        return {
          success: true,
          room: match.label,
          drawerCount: match.drawerCount,
          drawers: drawers.map((d) => ({
            ts: d.ts || 0,
            sessionId: d.sessionId,
            snippet:
              `User: ${(d.userText || '').slice(0, 500)}` +
              (d.assistantText ? `\nAssistant: ${d.assistantText.slice(0, 700)}` : ''),
            dialoguePath: d.sessionDir ? `${d.sessionDir}/dialogue.jsonl` : '',
          })),
          note: 'Snippets are verbatim excerpts — `read_file` a `dialoguePath` for the full transcript.',
        };
      }

      // ── Index view: the project's rooms, busiest first. ──
      const rooms = await palace.listRooms({ projectRoot });
      const drawerTotal = await palace.countPalaceDrawers(projectRoot);
      const out = {
        success: true,
        drawerTotal,
        rooms: rooms.map((r) => ({
          label: r.label,
          drawerCount: r.drawerCount,
          created: r.created,
        })),
      };
      if (rooms.length === 0) {
        out.message = drawerTotal > 0
          ? 'Drawers exist but no rooms formed yet (room assignment pending).'
          : 'The palace is empty for this project — it fills as conversations happen (and via the one-shot backfill of past sessions).';
      } else {
        out.note = 'Call browse_palace again with a `room` label to read its drawers, or use recall_memory for query-based search.';
      }
      return out;
    } catch (err) {
      return { success: false, error: `browse_palace failed: ${err.message}` };
    }
  },
};
