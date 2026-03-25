/**
 * Mobile Key Action — send a special key press to the mobile device.
 *
 * Supported keys: back, home, enter, delete, tab.
 */

import { getPlatform, invalidateElementsCache } from '../../navigation/mobile/platform.js';

export default {
  type: 'mobile_key',
  intent: 'mobile_key',
  description:
    'Send a special key press to the mobile device. ' +
    'Fields: "key" (required: "back", "home", "enter", "delete", "tab"). ' +
    '"back" navigates back, "home" goes to home screen, "enter" submits, "delete" removes a character, "tab" moves focus.',
  thinkingHint: (action) => `Pressing ${action.key || 'key'}`,
  permission: 'use_mobile',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        enum: ['back', 'home', 'enter', 'delete', 'tab'],
        description: 'The key to press',
      },
    },
    required: ['key'],
  },

  examples: [
    { actionType: 'direct', intent: 'mobile_key', key: 'enter' },
    { actionType: 'direct', intent: 'mobile_key', key: 'back' },
    { actionType: 'direct', intent: 'mobile_key', key: 'home' },
  ],

  async execute(action) {
    if (!action.key) throw new Error('mobile_key: "key" field is required.');

    const validKeys = ['back', 'home', 'enter', 'delete', 'tab'];
    if (!validKeys.includes(action.key.toLowerCase())) {
      throw new Error(`mobile_key: unsupported key "${action.key}". Use: ${validKeys.join(', ')}`);
    }

    const driver = await getPlatform();
    invalidateElementsCache(); // UI will change after key press
    driver.sendKey(action.key);

    // Wait for key action to take effect
    const k = action.key.toLowerCase();
    if (k === 'back' || k === 'home') {
      await sleep(500); // Navigation needs more time
    } else {
      await sleep(200); // enter/delete/tab
    }

    return { success: true, key: action.key };
  },
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
