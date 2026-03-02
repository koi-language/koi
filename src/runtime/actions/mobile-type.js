/**
 * Mobile Type Action — type text into the currently focused input field.
 *
 * By default clears existing text before typing. Use clear:false to append.
 * Tip: tap the input field first with mobile_tap, then type.
 */

import { getPlatform, invalidateElementsCache } from '../mobile/platform.js';

export default {
  type: 'mobile_type',
  intent: 'mobile_type',
  description:
    'Type text into the currently focused mobile input field. ' +
    'Fields: "text" (required: the text to type), "clear" (optional: true to clear existing text first, default true). ' +
    'Tip: use mobile_tap on the input field before typing to ensure it is focused.',
  thinkingHint: (action) => `Typing "${(action.text || '').substring(0, 20)}"`,
  permission: 'use_mobile',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to type' },
      clear: { type: 'boolean', description: 'Clear existing text before typing (default: true)' },
    },
    required: ['text'],
  },

  examples: [
    { actionType: 'direct', intent: 'mobile_type', text: 'user@example.com' },
    { actionType: 'direct', intent: 'mobile_type', text: 'search query', clear: false },
  ],

  async execute(action) {
    if (!action.text) throw new Error('mobile_type: "text" field is required.');

    const driver = await getPlatform();
    const clear = action.clear !== false; // default true
    invalidateElementsCache(); // UI will change after typing

    driver.typeText(action.text, { clear });
    await new Promise(r => setTimeout(r, 300)); // Let text render before next action

    return { success: true, typed: action.text, cleared: clear };
  },
};
