/**
 * Session File Diff Action - Show colored diff for a single file from this session.
 *
 * Renders colored diff to stdout (like edit-file/write-file do).
 * Supports reverse mode to show what a revert would look like.
 *
 * The LLM should use this action whenever it needs to SHOW changes to the user,
 * instead of describing them in prose.
 */

import { sessionTracker } from '../session-tracker.js';
import { renderFullDiff } from '../diff-render.js';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'session_file_diff',
  intent: 'session_file_diff',
  description: 'Show the colored diff of a file changed in this session. ALWAYS use this to show changes visually instead of describing them in text. Set "reverse": true to show what reverting would look like. The user sees the colored diff on screen. Provide: "path" (file path), optional "reverse" (boolean, default false).',
  thinkingHint: 'Computing diff',
  permission: 'manage_session',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to show diff for' },
      reverse: { type: 'boolean', description: 'If true, show reverse diff (what revert would look like). Default: false' }
    },
    required: ['path']
  },

  async execute(action, agent) {
    if (!sessionTracker) {
      return { success: false, error: 'No session tracker initialized' };
    }

    const filePath = action.path;
    if (!filePath) {
      return { success: false, error: 'session_file_diff: "path" field is required' };
    }

    const reverse = action.reverse === true;
    const diff = sessionTracker.getFileDiff(filePath, reverse);

    if (!diff || diff.startsWith('(')) {
      return { success: true, summary: `No changes found for ${filePath}` };
    }

    // Render colored diff to stdout
    const colored = renderFullDiff(diff);
    if (colored) {
      cliLogger.clearProgress();
      const label = reverse ? ' (revert preview)' : '';
      cliLogger.print(`\n${colored}\n`);
    }

    // Count changes for summary
    const added = (diff.match(/^\+[^+]/gm) || []).length;
    const removed = (diff.match(/^-[^-]/gm) || []).length;

    return {
      success: true,
      path: filePath,
      reverse,
      summary: reverse
        ? `Revert preview for ${filePath}: +${added} -${removed} lines (red = what would be removed, green = what would be restored)`
        : `${filePath}: +${added} -${removed} lines`
    };
  }
};
