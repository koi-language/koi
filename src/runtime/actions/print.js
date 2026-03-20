/**
 * Print Action - Display text to console
 */

import { cliLogger } from '../cli-logger.js';
import { renderMarkdown } from '../cli-markdown.js';

export default {
  type: 'print',          // Mantener temporalmente
  intent: 'print',        // NUEVO: identificador semántico
  description: 'Print directly to console (FAST - use this for all console output!)',
  instructions: `If the task requires showing information to the user (e.g. "display", "print", "present", "show", "tell"), you MUST use print for the final content.

Internal reasoning, retrieval actions, and "return" do NOT count as user-visible output.

Do NOT place final user-facing content only inside "return" unless the task explicitly says that "return" is the user-facing channel.

If both user-visible output and workflow completion are required:
1) emit the print action first
2) then emit "return" only as completion`,
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

    if (action._alreadyStreamed) {
      cliLogger.printStreamingEnd();
      // When a UI provider owns streaming, the dynamic area was cleared above
      // so we must re-print the final markdown version to the permanent scroll.
      // Without a provider, streaming went straight to stdout and is already
      // permanent — printing again would duplicate the output.
      if (cliLogger.hasStreamingProvider()) {
        cliLogger.print(`\x1b[0m${renderMarkdown(message)}`);
      }
    } else {
      cliLogger.print(`\x1b[0m${renderMarkdown(message)}`);
    }

    return { printed: true, message };
  }
};
