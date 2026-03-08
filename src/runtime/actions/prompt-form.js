/**
 * Prompt Form Action - Multi-step form wizard for collecting multiple fields.
 *
 * Renders a wizard with:
 *   - A top navigation bar showing all field names + current position
 *   - One question per screen (text input or select menu)
 *   - A final review/submit screen
 *
 * Use this instead of calling prompt_user multiple times.
 * Returns: { answers: { [fieldLabel]: string } }
 */

import { cliLogger } from '../cli-logger.js';
import { cliForm } from '../cli-form.js';

export default {
  type: 'prompt_form',
  intent: 'prompt_form',
  description: 'Multi-step form wizard for collecting multiple pieces of information. Shows one question at a time with a nav bar at the top, then a review/submit step. Use instead of multiple prompt_user calls. Returns: { answers: { [fieldLabel]: string } }',
  thinkingHint: 'Waiting for your input',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional form title shown in the scroll area before the form opens'
      },
      fields: {
        type: 'array',
        description: 'Ordered list of fields to collect.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Short name shown in the top nav bar (e.g. "Gateway ID"). Keep it concise — max ~12 chars.'
            },
            question: {
              type: 'string',
              description: 'The full question text shown to the user (e.g. "What is your Coinflow Gateway ID?"). Defaults to label if not provided.'
            },
            hint: {
              type: 'string',
              description: 'Optional hint line shown below the question (e.g. "Found in dashboard → Settings → API")'
            },
            options: {
              type: 'array',
              description: 'If provided, shows a select menu instead of free text. The user picks one with ↑↓ + Enter.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Option label (bold in the list)' },
                  description: { type: 'string', description: 'Optional description shown below the title in dim text' },
                  value: { type: 'string', description: 'The value returned when this option is selected. Defaults to title if not set.' },
                  recommended: { type: 'boolean', description: 'Show "(Recommended)" after the title' }
                },
                required: ['title']
              }
            },
            allowFreeText: {
              type: 'boolean',
              description: 'When options are provided, also append a "Type something." free-text entry at the bottom. Default: false.'
            }
          },
          required: ['label']
        }
      }
    },
    required: ['fields']
  },

  examples: [
    {
      intent: 'prompt_form',
      title: 'A few details before I can plan the Coinflow integration:',
      fields: [
        {
          label: 'Integration',
          question: 'How should Coinflow be integrated?',
          hint: 'React SDK requires a React app; Hosted Link needs no JS',
          options: [
            { title: 'React SDK', description: 'Full checkout component — use when the app is React', recommended: true },
            { title: 'Hosted Checkout Link', description: 'Redirect to Coinflow-hosted page — works in any framework' },
            { title: 'Direct API', description: 'Custom low-level integration' }
          ],
          allowFreeText: false
        },
        {
          label: 'Environment',
          question: 'Which Coinflow environment should be used?',
          options: [
            { title: 'sandbox', description: 'Testing environment, no real money' },
            { title: 'production', description: 'Live environment' }
          ]
        },
        {
          label: 'Merchant ID',
          question: 'What is your Coinflow merchant ID?',
          hint: 'Found in Coinflow dashboard → Settings → API'
        }
      ]
    }
  ],

  async execute(action, agent) {
    const title = action.title || action.data?.title || '';
    const fields = action.fields || action.data?.fields || [];

    if (!Array.isArray(fields) || fields.length === 0) {
      return { error: 'prompt_form requires a non-empty "fields" array.' };
    }

    cliLogger.clearProgress();

    // Print title to scroll area if provided (shown above the form overlay)
    if (title) {
      cliLogger.print(title);
    }

    const answers = await cliForm(title, fields);

    if (!answers) {
      return { answers: null, cancelled: true };
    }

    return { answers };
  }
};
