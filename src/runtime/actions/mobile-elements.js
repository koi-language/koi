/**
 * Mobile Elements Action — lightweight alternative to mobile_observe.
 *
 * Returns only the accessibility tree (UI elements) without taking a screenshot.
 * ~10x faster than mobile_observe since it skips screenshot + resize + grid + JPEG.
 * Use this for predictable navigation where you already know what to tap/type.
 */

import { getPlatform, setPlatform, getCachedElements } from '../mobile/platform.js';
import { formatElementsSummary } from '../mobile/element-matching.js';

export default {
  type: 'mobile_elements',
  intent: 'mobile_elements',
  description:
    'List all interactive UI elements on the mobile screen WITHOUT taking a screenshot. ' +
    'Much faster than mobile_observe (~100ms vs ~2s). ' +
    'Use this when you already know the screen layout and just need element labels for mobile_tap. ' +
    'Use mobile_observe instead when you need to SEE the screen (first time, after navigation, unknown UI). ' +
    'Fields: "platform" (optional: "ios" or "android" — auto-detects if omitted). ' +
    'Returns: text list of all screen elements with their labels and positions.',
  thinkingHint: () => 'Scanning elements',
  permission: 'use_mobile',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['ios', 'android'],
        description: 'Force a specific platform. Auto-detected if omitted.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'mobile_elements' },
  ],

  async execute(action) {
    if (action.platform) setPlatform(action.platform);

    const driver = await getPlatform();

    // Fetch accessibility tree (uses TTL cache if fresh)
    const elements = await getCachedElements(driver);

    const elementsSummary = formatElementsSummary(elements);

    return {
      platform: driver.type,
      elementCount: elements.length,
      content: [
        { type: 'text', text: elementsSummary || 'No elements detected.' },
      ],
    };
  },
};
