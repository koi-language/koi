/**
 * Session History Action - Browse the history of changes made in this session.
 *
 * Shows an interactive list of changesets with descriptions and timestamps.
 * The user can select one to see its diff or restore to that point.
 */

import { sessionTracker } from '../session-tracker.js';
import { cliSelect } from '../cli-select.js';
import { renderFullDiff } from '../diff-render.js';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'session_history',
  intent: 'session_history',
  description: 'Show the history of all changesets in this session as an interactive list. Each entry has a description and timestamp. The user can select one to see its diff or restore to that point. No arguments needed.',
  thinkingHint: 'Loading history',
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

    const history = sessionTracker.getHistory();
    if (history.length === 0) {
      cliLogger.clearProgress();
      cliLogger.print('\x1b[2mNo tracked changes in this session yet.\x1b[0m');
      return { success: true, summary: 'No changes in this session yet.' };
    }

    // Find current HEAD to mark the active changeset
    const head = sessionTracker.getHead();

    // Show interactive list
    cliLogger.clearProgress();

    const options = history.map((entry, i) => {
      const date = new Date(entry.date);
      const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      const isCurrent = head && entry.hash === head;
      return {
        title: isCurrent ? `${entry.summary} ✓` : entry.summary,
        value: entry.hash,
        description: time
      };
    });

    // Add exit option
    options.push({ title: 'Salir', value: 'cancel' });

    const selectedHash = await cliSelect('Session history — select a changeset:', options);

    if (!selectedHash || selectedHash === 'cancel') {
      return { success: true, summary: 'History browsing cancelled.' };
    }

    // Show the diff for the selected changeset
    const diff = sessionTracker.getCommitDiff(selectedHash);
    if (diff && !diff.startsWith('(')) {
      const colored = renderFullDiff(diff);
      if (colored) {
        cliLogger.print(`\n${colored}\n`);
      }
    }

    // Ask what to do with this changeset
    const actionChoice = await cliSelect('What do you want to do?', [
      { title: 'Restaurar a este punto', value: 'restore' },
      { title: 'Salir', value: 'back' }
    ]);

    if (actionChoice === 'restore') {
      const result = sessionTracker.checkoutCommit(selectedHash);
      if (result.success) {
        cliLogger.print(`\x1b[32mRestored to: ${result.summary}\x1b[0m`);
      }
      return result;
    }

    return { success: true, summary: 'Browsed history without changes.' };
  }
};
