import { channel } from '../../io/channel.js';
/**
 * Prompt Files Action - Inline file-attachment picker.
 *
 * Sibling to prompt_form: renders inside the chat (drop zone + Browse
 * button + selected-file chips), waits for the user to attach files,
 * and returns the absolute paths. Use this whenever the agent needs
 * actual files from the user (logos, PDFs, audio samples, datasets…)
 * instead of just a textual answer.
 *
 * Returns: { paths: string[] } or { paths: null, cancelled: true }.
 */

export default {
  type: 'prompt_files',
  intent: 'prompt_files',
  description: 'Ask the user to attach one or more files. Renders an inline drop-zone + Browse button inside the chat (same family as prompt_form). Use this when you need ACTUAL files from the user — logos, PDFs, audio/video samples, datasets, etc. — not a textual answer. Returns: { paths: string[] } with absolute file paths the agent can then read / move / process. Cancelled by the user → { paths: null, cancelled: true }.',
  thinkingHint: 'Waiting for files',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional short title printed above the picker overlay.'
      },
      question: {
        type: 'string',
        description: 'What the user should attach (e.g. "Drop the brand logo here, PNG with transparent background preferred").'
      },
      hint: {
        type: 'string',
        description: 'Optional helper line shown under the question (e.g. "You can drop multiple files at once").'
      },
      multiple: {
        type: 'boolean',
        description: 'Allow multiple files. Default: true.'
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional whitelist of file extensions WITHOUT the leading dot (e.g. ["png","jpg","svg"]). When set, the native browse dialog filters by these and the drop zone rejects files outside the list.'
      }
    },
    required: []
  },

  examples: [
    {
      intent: 'prompt_files',
      question: 'Drop the brand logo files here (PNG with transparent background preferred).',
      multiple: true,
      extensions: ['png', 'jpg', 'jpeg', 'svg']
    },
    {
      intent: 'prompt_files',
      question: 'Please attach the existing pitch deck.',
      multiple: false,
      extensions: ['pdf', 'ppt', 'pptx']
    },
    {
      intent: 'prompt_files',
      title: 'Voice sample',
      question: 'Attach 30–60 seconds of clean speech to clone the voice.',
      hint: 'WAV or MP3, mono, no background music.',
      multiple: false,
      extensions: ['wav', 'mp3', 'm4a']
    }
  ],

  async execute(action, agent) {
    const title = action.title || action.data?.title || '';
    const question = action.question
      || action.data?.question
      || 'Please attach the files you want to share.';
    const hint = action.hint || action.data?.hint || '';
    // Default to multiple: most uses are "any number of refs", and a
    // single-file caller can constrain it explicitly.
    const multiple = (action.multiple ?? action.data?.multiple ?? true);
    const rawExt = action.extensions || action.data?.extensions || null;
    const extensions = Array.isArray(rawExt)
      ? rawExt.map(e => String(e).replace(/^\./, '').trim().toLowerCase()).filter(Boolean)
      : null;

    channel.clearProgress();

    // Print the title to the scroll area so it stays visible in the
    // transcript after the picker closes — same pattern as prompt_form.
    if (title) channel.print(title);

    const paths = await channel.files({ title, question, hint, multiple, extensions });

    if (paths == null) return { paths: null, cancelled: true };
    return { paths };
  }
};
