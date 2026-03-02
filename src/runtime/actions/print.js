/**
 * Print Action - Display text to console
 */

import { cliLogger } from '../cli-logger.js';
import { renderMarkdown } from '../cli-markdown.js';

export default {
  type: 'print',          // Mantener temporalmente
  intent: 'print',        // NUEVO: identificador semántico
  description: 'Print directly to console (FAST - use this for all console output!)',
  thinkingHint: 'Continuing',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Text to display on console'
      }
    },
    required: ['message']
  },

  examples: [
    { type: 'print', message: '╔══════════════════════════════════════╗' },
    { type: 'print', message: '║  Processing...                       ║' },
    { type: 'print', message: '╚══════════════════════════════════════╝' },
    { type: 'print', message: '✅ Task completed successfully' },
    { type: 'print', message: 'Found 5 items' }
  ],

  // Executor function - receives the action and agent context
  async execute(action, agent) {
    const message = action.message || action.text || action.data || '';

    cliLogger.print(`\x1b[0m${renderMarkdown(message)}`);

    return { printed: true, message };
  }
};
