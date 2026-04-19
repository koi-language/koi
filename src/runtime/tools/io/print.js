import { channel } from '../../io/channel.js';
/**
 * Print Action - Display text to console
 */

export default {
  type: 'print',          // Mantener temporalmente
  intent: 'print',        // NUEVO: identificador semántico
  description: 'Print directly to console',
  // Hide in non-interactive mode — no user reading output
  hidden: () => process.env.KOI_EXIT_ON_COMPLETE === '1',
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
  _lastPrintedMessage: null,
  _duplicateCount: 0,

  async execute(action, agent) {
    const message = action.message || action.text || action.data || '';

    // Detect duplicate consecutive prints (LLM loop). If the same message
    // is printed twice in a row, suppress the duplicate and force prompt_user
    // to break the loop.
    if (message === this._lastPrintedMessage) {
      this._duplicateCount++;
      if (this._duplicateCount >= 1) {
        channel.log('print', `Suppressed duplicate print (×${this._duplicateCount + 1}). Breaking loop.`);
        return { printed: false, suppressed: true, message: 'Duplicate print suppressed — call prompt_user to continue.' };
      }
    } else {
      this._lastPrintedMessage = message;
      this._duplicateCount = 0;
    }

    if (action._alreadyStreamed) {
      channel.printStreamingEnd();
      // When a UI provider owns streaming, the dynamic area was cleared above
      // so we must re-print the final markdown version to the permanent scroll.
      // Without a provider, streaming went straight to stdout and is already
      // permanent — printing again would duplicate the output.
      if (channel.hasStreamingProvider()) {
        channel.print(`\x1b[0m${channel.renderMarkdown(message)}`);
      }
    } else {
      channel.print(`\x1b[0m${channel.renderMarkdown(message)}`);
    }

    return { printed: true, message };
  }
};
