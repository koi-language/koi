/**
 * Browser Type Action — type text into a focused input field.
 *
 * Click/focus the input first with browser_click, then type.
 * By default clears existing text before typing (use clear:false to append).
 */

import { getPage } from '../browser/platform.js';

export default {
  type: 'browser_type',
  intent: 'browser_type',
  description:
    'Type text into the currently focused browser input field. ' +
    'Fields: "text" (required: the text to type), ' +
    '"selector" (optional: CSS selector to click and focus before typing), ' +
    '"clear" (optional: true to clear existing text first, default true). ' +
    'Tip: use browser_click on the input field before typing to ensure it is focused.',
  thinkingHint: (action) => `Typing "${(action.text || '').substring(0, 30)}"`,
  permission: 'use_browser',

  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to type.' },
      selector: {
        type: 'string',
        description: 'CSS selector of the input to focus before typing (optional).',
      },
      clear: {
        type: 'boolean',
        description: 'Clear existing text before typing (default: true).',
      },
    },
    required: ['text'],
  },

  examples: [
    { actionType: 'direct', intent: 'browser_type', text: 'user@example.com' },
    { actionType: 'direct', intent: 'browser_type', selector: '#search', text: 'hello world' },
    { actionType: 'direct', intent: 'browser_type', text: ' more text', clear: false },
  ],

  async execute(action) {
    if (!action.text) throw new Error('browser_type: "text" field is required.');

    const page = await getPage();
    const clear = action.clear !== false; // default true

    if (action.selector) {
      // Retry up to 3 times with a short wait between attempts.
      // This handles the case where a consent modal was just dismissed and
      // the page is briefly in a transition state before the input is focusable.
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.click(action.selector, { timeout: 3000 });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await page.waitForTimeout(1000);
        }
      }
      if (lastErr) {
        return {
          success: false,
          error: `Cannot focus "${action.selector}": ${lastErr.message}. ` +
            'If a dialog or consent banner is blocking the element, dismiss it first with browser_click, then call browser_observe to verify it is gone, then retry.',
        };
      }
    }

    if (clear) {
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
    }

    await page.keyboard.type(action.text, { delay: 20 });

    return { success: true, typed: action.text, cleared: clear };
  },
};
