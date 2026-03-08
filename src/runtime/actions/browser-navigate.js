/**
 * Browser Navigate Action — navigate to a URL, go back/forward, or reload.
 */

import { getPage, navigate } from '../browser/platform.js';

export default {
  type: 'browser_navigate',
  intent: 'browser_navigate',
  description:
    'Navigate the browser to a URL, or go back / forward / reload. ' +
    'Fields: "url" (full URL to open), or "action" ("back" | "forward" | "reload"). ' +
    'Exactly one of "url" or "action" is required.',
  thinkingHint: (action) =>
    action.url ? `Opening ${action.url}` : (action.action || 'Navigating'),
  permission: 'use_browser',

  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to navigate to (e.g. "https://example.com").',
      },
      action: {
        type: 'string',
        enum: ['back', 'forward', 'reload'],
        description: 'Navigation action instead of URL.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'browser_navigate', url: 'https://google.com' },
    { actionType: 'direct', intent: 'browser_navigate', url: 'https://github.com' },
    { actionType: 'direct', intent: 'browser_navigate', action: 'back' },
    { actionType: 'direct', intent: 'browser_navigate', action: 'reload' },
  ],

  async execute(action) {
    if (!action.url && !action.action) {
      throw new Error('browser_navigate: provide "url" or "action" (back/forward/reload).');
    }

    if (action.url) {
      const page = await navigate(action.url);
      return { success: true, url: page.url(), title: await page.title() };
    }

    const page = await getPage();
    const nav = {
      back:    () => page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      forward: () => page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      reload:  () => page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }),
    }[action.action];

    if (!nav) throw new Error(`browser_navigate: unknown action "${action.action}".`);
    await nav();
    return { success: true, url: page.url(), title: await page.title() };
  },
};
