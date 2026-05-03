/**
 * Set or clear the in/out marks on a timeline.
 *
 * Marks live on the timeline's settings block, are visible to the user
 * in the GUI ruler/filmstrip, and pre-fill the export dialog's
 * "Marked range" radio. They're also a convenient way for the agent to
 * point a downstream `render_timeline` call at a slice without having
 * to repeat the range coordinates — once marks are set, both the user
 * and a follow-up tool call know which slice "matters".
 *
 * Pass `null` to clear a mark, an integer (ms) to set it, or omit a
 * field entirely to leave it untouched. Setting both at once is
 * recommended; the engine rejects inverted ranges (out <= in).
 */

import { setTimelineMarks } from '../../state/timelines.js';

export default {
  type: 'set_timeline_marks',
  intent: 'set_timeline_marks',
  description:
    'Set or clear the in/out marks on a timeline. Marks define a slice the user (and follow-up render_timeline ' +
    'calls) treats as "the part that matters" — useful for previewing, exporting a fragment, or preparing a ' +
    '"work on a part" hand-off. Each field is optional: pass an integer ms to set, null to clear, or omit to ' +
    'keep. Throws when the resulting range is inverted (out <= in). Returns the normalised settings block.',
  thinkingHint: 'Setting timeline marks',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      markInMs: {
        type: ['integer', 'null'],
        description:
          'In-mark in milliseconds (>= 0). Pass null to clear; omit to leave unchanged.',
      },
      markOutMs: {
        type: ['integer', 'null'],
        description:
          'Out-mark in milliseconds (>= 0, > markInMs when both set). Pass null to clear; omit to leave unchanged.',
      },
    },
    required: ['id'],
  },

  async execute(action) {
    try {
      const tl = setTimelineMarks(action.id, {
        markInMs: action.markInMs,
        markOutMs: action.markOutMs,
      });
      return {
        success: true,
        settings: tl.settings,
        markInMs: tl.settings.markInMs ?? null,
        markOutMs: tl.settings.markOutMs ?? null,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
