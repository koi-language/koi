/**
 * Browser Key Action — press a special keyboard key in the browser.
 *
 * Supported keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown,
 * ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F1–F12.
 */

import { getPage } from '../../navigation/browser/platform.js';

const KEY_MAP = {
  enter:      'Enter',
  tab:        'Tab',
  escape:     'Escape',
  esc:        'Escape',
  backspace:  'Backspace',
  delete:     'Delete',
  arrowup:    'ArrowUp',
  arrowdown:  'ArrowDown',
  arrowleft:  'ArrowLeft',
  arrowright: 'ArrowRight',
  home:       'Home',
  end:        'End',
  pageup:     'PageUp',
  pagedown:   'PageDown',
};

for (let i = 1; i <= 12; i++) KEY_MAP[`f${i}`] = `F${i}`;

export default {
  type: 'browser_key',
  intent: 'browser_key',
  description:
    'Press a special keyboard key in the browser. ' +
    'Fields: "key" (required): ' +
    '"enter" — submit form/search, ' +
    '"tab" — move focus, ' +
    '"escape" — close dialog/dropdown, ' +
    '"backspace"/"delete" — remove character, ' +
    '"arrowup"/"arrowdown"/"arrowleft"/"arrowright" — navigate, ' +
    '"home"/"end"/"pageup"/"pagedown" — scroll, ' +
    '"f1"–"f12" — function keys.',
  thinkingHint: (action) => `Pressing ${action.key || 'key'}`,
  permission: 'use_browser',

  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Key name (case-insensitive): enter, tab, escape, backspace, delete, arrowup, arrowdown, arrowleft, arrowright, home, end, pageup, pagedown, f1-f12.',
      },
    },
    required: ['key'],
  },

  examples: [
    { actionType: 'direct', intent: 'browser_key', key: 'enter' },
    { actionType: 'direct', intent: 'browser_key', key: 'escape' },
    { actionType: 'direct', intent: 'browser_key', key: 'tab' },
    { actionType: 'direct', intent: 'browser_key', key: 'arrowdown' },
  ],

  async execute(action) {
    if (!action.key) throw new Error('browser_key: "key" field is required.');

    const normalized = action.key.toLowerCase().trim();
    const playwrightKey = KEY_MAP[normalized];

    if (!playwrightKey) {
      return {
        success: false,
        error: `Unsupported key "${action.key}". Supported: ${Object.keys(KEY_MAP).join(', ')}`,
      };
    }

    const page = await getPage();
    const urlBefore = page.url();
    await page.keyboard.press(playwrightKey);

    // Wait for navigation if Enter was pressed.
    // waitForLoadState('domcontentloaded') returns immediately when the page is
    // already loaded — we must detect a URL change first, then wait for the new
    // page to finish loading.
    if (normalized === 'enter') {
      try {
        await page.waitForURL(url => url.toString() !== urlBefore, { timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      } catch {
        // URL didn't change — Enter was used for something non-navigational (e.g. closing a dialog).
        await page.waitForTimeout(300);
      }
    }

    return { success: true, key: action.key, playwrightKey, url: page.url() };
  },
};
