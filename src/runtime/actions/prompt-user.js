/**
 * Prompt User Action - Ask user for input via command line
 *
 * Uses cliInput for text input and cliSelect for option menus.
 * These modules support injectable providers so the CLI layer
 * can override them (e.g. for Ink rendering) without this action knowing.
 */

import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { cliInput } from '../cli-input.js';
import { renderMarkdown } from '../cli-markdown.js';

export default {
  type: 'prompt_user',
  intent: 'prompt_user',
  description: 'Ask the user a question or show an inline prompt. Two modes: (1) QUESTION mode: set "question" to display text, then show input below. (2) INLINE mode: set "prompt" (without "question") to show an inline prompt where the user types on the same line — ideal for shell-like prompts, e.g. { "intent": "prompt_user", "prompt": "(~/dir) $ " }. Can include "options" array for interactive menu — an "Other..." free-text option is always appended automatically so the user can express anything not covered by the choices. Returns: { answer }',
  thinkingHint: 'Processing your answer',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user'
      },
      options: {
        type: 'array',
        description: 'Optional array of choices for interactive menu (e.g., ["Yes", "No"]). User navigates with arrows and selects with Enter.'
      },
      prompt: {
        type: 'string',
        description: 'Optional custom prompt for text input mode (defaults to "❯ " — no need to set this)'
      }
    },
    required: []
  },

  examples: [
    { intent: 'prompt_user', question: 'What is your name?' },
    { intent: 'prompt_user', question: 'Do you want to proceed?', options: ['Yes', 'No'] },
    { intent: 'prompt_user', prompt: '(~/project) $ ' }
  ],

  // Executor function - receives the action and agent context
  async execute(action, agent) {
    const question = action.question || action.data?.question || '';
    const options = action.options || action.data?.options || null;
    // Always use the default prompt — the LLM must not change the visual prompt
    const promptText = '❯ ';

    // Clear any progress indicators
    cliLogger.clearProgress();

    // If options are provided, show interactive menu
    if (options && Array.isArray(options) && options.length > 0) {
      // Require a visible question when showing a select menu — without it the
      // user sees a bare "❯ " cursor as title and has no idea what to choose.
      if (!question) {
        return {
          error: 'prompt_user with "options" requires a non-empty "question" field. Please retry with a clear question text (e.g. "Do you want to proceed?").'
        };
      }
      // Strip numbered/bulleted list lines from question — they duplicate the select menu options
      const cleanQuestion = question
        .split('\n').filter(l => !/^\s*[\d\-\*]+[\.\)]\s/.test(l)).join('\n').trim();
      const value = await cliSelect(cleanQuestion || question, options.map((opt) => ({
        title: opt,
        value: opt
      })), 0, { meta: { allowFreeText: true } });
      return { answer: value || options[0] };
    }

    // INLINE mode: no question, user types on the same line as the prompt
    if (!question) {
      const raw = await cliInput(promptText);
      const answerText = String(typeof raw === 'string' ? raw : (raw?.text ?? ''));
      const answerAtts = Array.isArray(raw?.attachments) ? raw.attachments : [];
      return answerAtts.length > 0 ? { answer: answerText, attachments: answerAtts } : { answer: answerText };
    }

    // QUESTION mode: print question to scrollback (above separator), then wait for input
    cliLogger.print(renderMarkdown(question));
    const raw = await cliInput(promptText);
    const answerText = String(typeof raw === 'string' ? raw : (raw?.text ?? ''));
    const answerAtts = Array.isArray(raw?.attachments) ? raw.attachments : [];
    return answerAtts.length > 0 ? { answer: answerText, attachments: answerAtts } : { answer: answerText };
  }
};
