/**
 * Session Diff Action - Show all file changes made in this session.
 *
 * Renders a colored diff to stdout (like edit-file/write-file do),
 * and returns only a summary to the LLM context.
 * The LLM can use session_file_diff to inspect a specific file's diff,
 * or session_history to browse the full changeset history.
 */

import { sessionTracker } from '../session-tracker.js';
import { renderFullDiff } from '../diff-render.js';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'session_diff',
  intent: 'session_diff',
  description: 'Show all file changes made in this session. Renders colored diff to the user and returns a summary. Use session_file_diff for one file, session_history to browse changesets. No arguments needed.',
  thinkingHint: 'Computing diff',
  permission: 'manage_session',
  hidden: false,

  schema: {
    type: 'object',
    properties: {},
    required: []
  },

  async execute(action, agent) {
    if (!sessionTracker) {
      return { success: false, error: 'No session tracker initialized' };
    }

    const files = sessionTracker.getChangedFiles();
    const diff = sessionTracker.getDiff();

    // No changes: show dim message to user (same style as /history)
    if (files.length === 0) {
      cliLogger.clearProgress();
      cliLogger.print('\x1b[2mNo file changes in this session yet.\x1b[0m');
      return {
        success: true,
        files: [],
        summary: 'No changes in this session',
        hint: 'Use session_file_diff for a specific file, session_history to browse/restore changesets.'
      };
    }

    // Show colored diff to the user on stdout
    if (files.length > 0 && diff && !diff.startsWith('(')) {
      const colored = renderFullDiff(diff);
      if (colored) {
        cliLogger.clearProgress();
        cliLogger.print(`\n${colored}\n`);
      }
    }

    // Build summary from git history (commit messages are LLM-generated)
    const history = sessionTracker.getHistory();
    const summaryLines = history.length > 0
      ? history.map(h => `- [${h.shortHash}] ${h.summary}`).join('\n')
      : files.map(f => `- ${f}: (modified)`).join('\n');

    return {
      success: true,
      files,
      summary: files.length > 0
        ? `${files.length} file(s) changed:\n${summaryLines}`
        : 'No changes in this session',
      hint: 'Use session_file_diff for a specific file, session_history to browse/restore changesets.'
    };
  }
};
