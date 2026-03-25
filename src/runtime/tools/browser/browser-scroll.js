/**
 * Browser Scroll Action — scroll the page or a specific element.
 *
 * Supports named directions (up/down/left/right) or explicit pixel deltas.
 */

import { getPage } from '../../navigation/browser/platform.js';

export default {
  type: 'browser_scroll',
  intent: 'browser_scroll',
  description:
    'Scroll the browser page or a specific element. ' +
    'Option 1: "direction" ("up", "down", "left", "right") — scroll by a screen-relative amount. ' +
    'Option 2: "x", "y" — explicit pixel delta (positive = scroll right/down, negative = scroll left/up). ' +
    'Optional "selector" — CSS selector of element to scroll (default: window). ' +
    'Optional "amount" — multiplier for direction scrolls (default: 1, use 3 for large jumps).',
  thinkingHint: (action) =>
    `Scrolling ${action.direction || `(${action.x ?? 0}, ${action.y ?? 0})`}`,
  permission: 'use_browser',

  schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction.',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount multiplier for direction (default 1). Use 3 for a big jump.',
      },
      x: { type: 'number', description: 'Horizontal pixel delta (positive = right).' },
      y: { type: 'number', description: 'Vertical pixel delta (positive = down).' },
      selector: {
        type: 'string',
        description: 'CSS selector of element to scroll (default: page/window).',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'browser_scroll', direction: 'down' },
    { actionType: 'direct', intent: 'browser_scroll', direction: 'down', amount: 3 },
    { actionType: 'direct', intent: 'browser_scroll', direction: 'up' },
    { actionType: 'direct', intent: 'browser_scroll', y: 500 },
    { actionType: 'direct', intent: 'browser_scroll', selector: '.results-list', direction: 'down' },
  ],

  async execute(action) {
    if (!action.direction && action.x == null && action.y == null) {
      throw new Error('browser_scroll: provide "direction" or "x"/"y" pixel delta.');
    }

    const page = await getPage();
    const amount = action.amount ?? 1;

    let dx = 0;
    let dy = 0;

    if (action.direction) {
      const step = 400 * amount;
      switch (action.direction) {
        case 'down':  dy =  step; break;
        case 'up':    dy = -step; break;
        case 'right': dx =  step; break;
        case 'left':  dx = -step; break;
        default:
          throw new Error(`browser_scroll: unknown direction "${action.direction}". Use: up, down, left, right.`);
      }
    } else {
      dx = action.x ?? 0;
      dy = action.y ?? 0;
    }

    if (action.selector) {
      await page.evaluate(
        ({ sel, ddx, ddy }) => {
          const el = document.querySelector(sel);
          if (el) { el.scrollBy(ddx, ddy); }
        },
        { sel: action.selector, ddx: dx, ddy: dy },
      );
    } else {
      await page.evaluate(({ ddx, ddy }) => window.scrollBy(ddx, ddy), { ddx: dx, ddy: dy });
    }

    await page.waitForTimeout(150); // let layout settle

    return { success: true, scrolled: { x: dx, y: dy }, selector: action.selector ?? 'window' };
  },
};
