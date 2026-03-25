/**
 * Browser Click Action — click by visible text, CSS selector, or coordinates.
 *
 * Priority: text (BEST) → selector (GOOD) → x,y coordinates (LAST RESORT).
 */

import { getPage } from '../../navigation/browser/platform.js';

export default {
  type: 'browser_click',
  intent: 'browser_click',
  description:
    'Click an element in the browser. Three ways to target (in order of preference): ' +
    '1. "text" — visible text or aria-label of element (BEST, use when visible in elements list). ' +
    '2. "selector" — CSS selector (GOOD, for precise targeting). ' +
    '3. "x","y" — viewport pixel coordinates (LAST RESORT). ' +
    'Optional "button": "left" (default), "right", "middle". ' +
    'Optional "clickCount": 1 (default) or 2 (double-click).',
  thinkingHint: (action) =>
    `Clicking "${action.text || action.selector || `(${action.x}, ${action.y})`}"`,
  permission: 'use_browser',

  schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Visible text or aria-label of element (BEST — matches elements list labels).',
      },
      selector: {
        type: 'string',
        description: 'CSS selector of element to click (GOOD).',
      },
      x: { type: 'number', description: 'Viewport X pixel coordinate (LAST RESORT).' },
      y: { type: 'number', description: 'Viewport Y pixel coordinate (LAST RESORT).' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button (default: "left").',
      },
      clickCount: {
        type: 'number',
        description: '1 = single click (default), 2 = double-click.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'browser_click', text: 'Sign In' },
    { actionType: 'direct', intent: 'browser_click', text: 'Search' },
    { actionType: 'direct', intent: 'browser_click', selector: '#submit-button' },
    { actionType: 'direct', intent: 'browser_click', selector: 'nav a[href="/pricing"]' },
    { actionType: 'direct', intent: 'browser_click', x: 640, y: 400 },
  ],

  async execute(action) {
    if (!action.text && !action.selector && (action.x == null || action.y == null)) {
      throw new Error('browser_click: provide "text", "selector", or both "x" and "y".');
    }

    const page = await getPage();
    const opts = {
      button: action.button || 'left',
      clickCount: action.clickCount || 1,
    };

    // Capture URL BEFORE the click — must be outside waitAfterClick so we
    // don't miss navigations that start during the click itself.
    const urlBefore = page.url();

    // Helper: wait for navigation or AJAX to settle after a click.
    async function waitAfterClick() {
      try {
        // Wait for the URL to change from what it was before the click.
        await page.waitForURL(url => url.toString() !== urlBefore, { timeout: 4000 });
        // Use 'load' to handle redirect chains (e.g. consent.google.com → google.com).
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      } catch {
        // URL didn't change — AJAX/DOM update (e.g. cookie consent modal close).
        // networkidle waits for in-flight XHRs to finish, then add a small buffer
        // for any CSS transitions or post-AJAX DOM mutations to settle.
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
    }

    // ── Option 1: visible text ───────────────────────────────────────────────
    if (action.text) {
      // Try strategies in order: getByRole(button) → getByText → getByLabel → getByRole(link) → getByPlaceholder
      // getByRole('button') is first — most precise for consent dialogs and form buttons.
      const strategies = [
        () => page.getByRole('button', { name: action.text, exact: false }).first().click({ ...opts, timeout: 5000 }),
        () => page.getByText(action.text, { exact: false }).first().click({ ...opts, timeout: 5000 }),
        () => page.getByLabel(action.text, { exact: false }).first().click({ ...opts, timeout: 5000 }),
        () => page.getByRole('link', { name: action.text, exact: false }).first().click({ ...opts, timeout: 5000 }),
        () => page.getByPlaceholder(action.text, { exact: false }).first().click({ ...opts, timeout: 5000 }),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          await waitAfterClick();
          return { success: true, clicked: action.text, url: page.url() };
        } catch { /* try next */ }
      }
      return {
        success: false,
        error: `Could not find element with text/label "${action.text}". ` +
          'Try browser_observe to get updated element list, or use "selector" instead.',
      };
    }

    // ── Option 2: CSS selector ───────────────────────────────────────────────
    if (action.selector) {
      try {
        await page.click(action.selector, { ...opts, timeout: 8000 });
        await waitAfterClick();
        return { success: true, clicked: action.selector, url: page.url() };
      } catch (e) {
        return { success: false, error: `Could not click "${action.selector}": ${e.message}` };
      }
    }

    // ── Option 3: raw coordinates ────────────────────────────────────────────
    await page.mouse.click(action.x, action.y, opts);
    await waitAfterClick();
    return { success: true, clicked: `(${action.x}, ${action.y})`, url: page.url() };
  },
};
