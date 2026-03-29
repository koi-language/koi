import { channel } from '../../io/channel.js';
/**
 * Prompt User Action - Ask user for input via command line
 *
 * Uses channel.prompt for text input and channel.select for option menus.
 * These modules support injectable providers so the CLI layer
 * can override them (e.g. for Ink rendering) without this action knowing.
 */

export default {
  type: 'prompt_user',
  intent: 'prompt_user',
  description: 'Ask the user a question or show an inline prompt. Modes: (1) QUESTION: set "question" for text input. (2) OPTIONS: set "question" + "options" array for interactive select menu. Always add "meta": { "allowFreeText": true } so the user can type a custom answer. (3) MULTI-SELECT: same as options but add "meta": { "allowFreeText": true, "multiSelect": true } — the user toggles checkboxes with Space and confirms with Enter. Use this when the user can pick MULTIPLE items. (4) INLINE: set "prompt" for shell-like input. Returns: { answer }',
  instructions: `Use prompt_user only for information that cannot be verified from tools, commands, files, or prior action results.

Never ask the user something you can verify yourself with:
- shell
- read_file
- search
- grep
- semantic_code_search

One prompt_user = one question.
Do not ask multiple questions in a single prompt_user.

When you need to explain something and ask a follow-up:
- put the explanation in "message"
- put the single question in "question"

Do not print a question separately before prompt_user.`,
  thinkingHint: 'Processing your answer',
  // In non-interactive mode, hide when there's nothing queued to consume.
  // Visible while the initial prompt is still in the queue; hidden after it's consumed.
  hidden: () => process.env.KOI_EXIT_ON_COMPLETE === '1' && process.env._KOI_INITIAL_PROMPT_CONSUMED === '1',
  permission: 'prompt_user',

  schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Optional message to print before the question (e.g., a detailed explanation or answer). Displayed as markdown.'
      },
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
      },
      meta: {
        type: 'object',
        description: 'Options: allowFreeText (true to add "Other..." option), multiSelect (true for checkbox-style multi-selection with Space to toggle)',
        properties: {
          allowFreeText: { type: 'boolean' },
          multiSelect: { type: 'boolean' }
        }
      }
    },
    required: []
  },

  examples: [
    { intent: 'prompt_user', message: 'Here is the answer to your question:\n\n1. First point\n2. Second point', question: 'Do you need more details?' },
    { intent: 'prompt_user', question: 'What is your name?' },
    { intent: 'prompt_user', question: 'Do you want to proceed?', options: ['Yes', 'No'], meta: { allowFreeText: true } },
    { intent: 'prompt_user', question: 'Which features for the MVP?', options: ['Auth', 'Dashboard', 'API', 'Admin panel'], meta: { allowFreeText: true, multiSelect: true } },
    { intent: 'prompt_user', prompt: '(~/project) $ ' }
  ],

  // Executor function - receives the action and agent context
  async execute(action, agent) {
    const message = action.message || action.data?.message || '';
    const question = action.question || action.data?.question || '';
    const options = action.options || action.data?.options || null;
    // Always use the default prompt — the LLM must not change the visual prompt
    const promptText = '❯ ';

    // --exit mode: allow consuming the initial prompt from the queue,
    // but block any subsequent prompt_user calls (no user to answer).
    if (process.env.KOI_EXIT_ON_COMPLETE === '1') {
      if (process.env._KOI_INITIAL_PROMPT_CONSUMED === '1') {
        // Track how many times prompt_user has been blocked
        const blockedCount = Number(process.env._KOI_PROMPT_BLOCKED_COUNT || '0') + 1;
        process.env._KOI_PROMPT_BLOCKED_COUNT = String(blockedCount);
        channel.log('prompt_user', `[exit-mode] Blocked (${blockedCount}/3). agent=${agent?.name || 'unknown'} message=${(message || '').substring(0, 100)} question=${(question || '').substring(0, 100)}`);
        if (message) channel.print(channel.renderMarkdown(message));

        // After 3 blocked attempts, force exit to prevent infinite loop
        if (blockedCount >= 3) {
          channel.log('prompt_user', `[exit-mode] Too many blocked prompt_user attempts — forcing exit.`);
          process.exit(0);
        }

        return {
          answer: '[SYSTEM] Non-interactive mode — no user is present. Do NOT call prompt_user again. If your task is complete, call return with a summary. If your task is NOT complete, continue working autonomously — assume all decisions are approved and proceed without asking.',
        };
      }
      // First call — mark as consumed and let it proceed to read from the queue.
      process.env._KOI_INITIAL_PROMPT_CONSUMED = '1';
    }

    // Clear any progress indicators
    channel.clearProgress();

    // Print message before question/input if provided.
    // Deduplicate: if the message ends with the same text as the question, strip it.
    if (message) {
      let cleanMessage = message;
      if (question && cleanMessage.trimEnd().endsWith(question.trim())) {
        cleanMessage = cleanMessage.slice(0, cleanMessage.lastIndexOf(question.trim())).trimEnd();
      }
      if (cleanMessage) {
        channel.print(channel.renderMarkdown(cleanMessage));
      }
    }

    // Quota exceeded prompt — _quota_options have { key, label, action, url }
    const isQuota = action._quota_exceeded || action.data?._quota_exceeded;
    const quotaOptions = action._quota_options || action.data?._quota_options;
    if (isQuota && quotaOptions && Array.isArray(quotaOptions)) {
      const msg = action.message || action.data?.message || 'Choose an option:';
      const labels = quotaOptions.map(o => o.label);
      const selected = await channel.select(msg, labels.map((l, i) => ({ title: l, value: i })), 0);
      const chosen = quotaOptions[selected ?? 0];

      if (chosen?.action === 'open_url' && chosen.url) {
        try {
          const { exec } = await import('child_process');
          const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
          exec(`${cmd} "${chosen.url}"`);
        } catch {}
      } else if (chosen?.action === 'print') {
        channel.print(channel.renderMarkdown(chosen.text || ''));
      } else if (chosen?.action === 'exit') {
        process.exit(0);
      }
      // Return empty answer so agent goes back to prompt_user (waiting for user input)
      return { answer: '' };
    }

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
      const _multiSelect = action.meta?.multiSelect === true;
      const value = await channel.select(cleanQuestion || question, options.map((opt) => ({
        title: opt,
        value: opt
      })), 0, { meta: { allowFreeText: true, multiSelect: _multiSelect } });
      return { answer: value || options[0] };
    }

    // INLINE mode: no question, user types on the same line as the prompt
    if (!question) {
      const raw = await channel.prompt(promptText);
      const answerText = String(typeof raw === 'string' ? raw : (raw?.text ?? ''));
      const answerAtts = Array.isArray(raw?.attachments) ? raw.attachments : [];
      return answerAtts.length > 0 ? { answer: answerText, attachments: answerAtts } : { answer: answerText };
    }

    // QUESTION mode: print question to scrollback (above separator), then wait for input
    channel.print(channel.renderMarkdown(question));
    const raw = await channel.prompt(promptText);
    const answerText = String(typeof raw === 'string' ? raw : (raw?.text ?? ''));
    const answerAtts = Array.isArray(raw?.attachments) ? raw.attachments : [];
    return answerAtts.length > 0 ? { answer: answerText, attachments: answerAtts } : { answer: answerText };
  }
};
