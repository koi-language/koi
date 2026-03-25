/**
 * Session Checkout Action - Restore files to a specific point in session history.
 *
 * Takes a commit hash (from session_history) and syncs the working tree
 * to that changeset's state.
 */

import { sessionTracker } from '../../state/session-tracker.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'session_checkout',
  intent: 'session_checkout',
  description: 'Restore files to a specific point in session history. Provide "hash" (commit hash from session_history). Shows the diff of what will change, then restores. Use session_history first to browse and pick a changeset.',
  thinkingHint: 'Checking out',
  permission: 'manage_session',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      hash: { type: 'string', description: 'Commit hash to restore to (from session_history)' }
    },
    required: ['hash']
  },

  async execute(action, agent) {
    if (!sessionTracker) {
      return { success: false, error: 'No session tracker initialized' };
    }

    const hash = action.hash;
    if (!hash) {
      return { success: false, error: 'session_checkout: "hash" field is required' };
    }

    // Show what will change before restoring
    try {
      const previewDiff = sessionTracker.getCommitDiff(hash);
      if (previewDiff && !previewDiff.startsWith('(')) {
        const colored = channel.renderDiff(previewDiff);
        if (colored) {
          channel.clearProgress();
          channel.print(`\n${colored}\n`);
        }
      }
    } catch { /* preview is optional */ }

    const result = sessionTracker.checkoutCommit(hash);
    if (result.success) {
      channel.clearProgress();
      channel.print(`\x1b[32mRestored to: ${result.message}\x1b[0m`);
    }

    return result;
  }
};
