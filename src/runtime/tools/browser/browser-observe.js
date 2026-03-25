/**
 * Browser Observe Action — screenshot + interactive element list.
 *
 * Takes a JPEG screenshot of the current viewport and extracts all interactive
 * elements (links, buttons, inputs, selects, ARIA elements).
 * Returns both as a multimodal content block so the LLM receives the image.
 */

import { screenshot, getElements, getCurrentUrl, getTitle } from '../../navigation/browser/platform.js';
import { sessionTracker } from '../../state/session-tracker.js';

export default {
  type: 'browser_observe',
  intent: 'browser_observe',
  description:
    'Take a screenshot of the current browser page and list all interactive elements ' +
    '(links, buttons, inputs, selects). Returns the screenshot image and a numbered ' +
    'list of elements with their labels and types. ' +
    'Call this to see the current page state before clicking or typing.',
  thinkingHint: () => 'Observing browser',
  permission: 'use_browser',

  schema: { type: 'object', properties: {} },
  examples: [{ actionType: 'direct', intent: 'browser_observe' }],

  async execute(_action, agent) {
    const [imgBuffer, elements, url, title] = await Promise.all([
      screenshot(),
      getElements(),
      getCurrentUrl(),
      getTitle(),
    ]);

    // Format element list (mirrors mobile_observe's elementsSummary pattern)
    const elementLines = elements.slice(0, 80).map((el, i) => {
      const meta = [el.tag, el.role, el.type].filter(Boolean).join('/');
      const extra = el.placeholder
        ? ` [placeholder: "${el.placeholder}"]`
        : el.value
        ? ` [value: "${el.value}"]`
        : el.href
        ? ` → ${el.href.slice(0, 60)}`
        : '';
      return `${i + 1}. ${el.label} (${meta})${extra}`;
    });
    if (elements.length > 80) elementLines.push(`… and ${elements.length - 80} more`);

    const elementsSummary =
      elements.length > 0
        ? elementLines.join('\n')
        : '(no interactive elements found on this page)';

    const summary = `URL: ${url || 'unknown'}\nTitle: ${title || ''}\n\nInteractive elements (${elements.length}):\n${elementsSummary}`;

    // Persist screenshot in session (mirrors mobile_observe pattern)
    if (sessionTracker) {
      sessionTracker.storeImage(imgBuffer, {
        source: 'browser_observe',
        description: `Browser screenshot — ${url}`,
        mimeType: 'image/jpeg',
      });
    }

    const base64 = imgBuffer.toString('base64');
    return {
      url,
      title,
      elementCount: elements.length,
      elements,          // raw array (available for template JS expressions)
      elementsSummary,   // pre-formatted string (mirrors frameState.elements)
      screenshot: base64,      // top-level field for compose image_call injection
      mimeType: 'image/jpeg',  // top-level field for compose image_call injection
      content: [
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
        { type: 'text', text: summary },
      ],
    };
  },
};
