/**
 * Element Matching Utilities — find UI elements by label, type, or text.
 *
 * Ported from mobile-mcps/src/utils/element-matching.js with simplifications.
 */

/**
 * Find an element by label using a three-pass strategy:
 *   1. Exact match (case-insensitive) on label or text
 *   2. Partial match (substring) on label or text
 *   3. Label parts match (split by `:`, match second part)
 *
 * @param {Array} elements - List of normalised elements
 * @param {string} labelPattern - Label to search for
 * @returns {object|undefined}
 */
export function findElementByLabel(elements, labelPattern) {
  if (!elements || !labelPattern) return undefined;

  let pattern = labelPattern.trim();
  let nthIndex = null; // 1-based index for duplicate selection, e.g. "Website [2]" → 2

  // Parse [N] suffix for duplicate element selection
  const nthMatch = pattern.match(/^(.+?)\s*\[(\d+)\]$/);
  if (nthMatch) {
    pattern = nthMatch[1].trim();
    nthIndex = parseInt(nthMatch[2], 10);
  }

  pattern = pattern.toLowerCase();

  // Helper: collect all matches from a pass (needed for [N] selection)
  const collectMatches = (matchFn) => elements.filter(matchFn);

  // Pass 1: Exact match
  const exactMatches = collectMatches(el => {
    const label = (el.label || '').toLowerCase();
    const text = (el.text || '').toLowerCase();
    return label === pattern || text === pattern;
  });
  if (exactMatches.length > 0) {
    if (nthIndex !== null) return exactMatches[nthIndex - 1]; // 1-based
    return exactMatches[0];
  }

  // Pass 2: Partial (substring) match
  const partialMatches = collectMatches(el => {
    const label = (el.label || '').toLowerCase();
    const text = (el.text || '').toLowerCase();
    return (label && label.includes(pattern)) || (text && text.includes(pattern));
  });
  if (partialMatches.length > 0) {
    if (nthIndex !== null) return partialMatches[nthIndex - 1];
    return partialMatches[0];
  }

  // Pass 3: Label parts match (e.g. "Button: Generate" → match "generate")
  const partsMatches = collectMatches(el => {
    const label = (el.label || '');
    const segments = label.split(':');
    if (segments.length > 1) {
      return segments[1].trim().toLowerCase().includes(pattern);
    }
    return false;
  });
  if (partsMatches.length > 0) {
    if (nthIndex !== null) return partsMatches[nthIndex - 1];
    return partsMatches[0];
  }

  return undefined;
}

/**
 * Get the center point of an element.
 * @param {object} element - Element with x, y, width, height
 * @returns {{ x: number, y: number }|null}
 */
export function getElementCenter(element) {
  if (!element || element.x == null || element.y == null ||
      element.width == null || element.height == null) {
    return null;
  }
  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2),
  };
}

/**
 * Filter elements by type (substring match, case-insensitive).
 * @param {Array} elements
 * @param {string} typeFilter
 * @returns {Array}
 */
export function findElementsByType(elements, typeFilter) {
  if (!elements || !typeFilter) return [];
  const filter = typeFilter.toLowerCase();
  return elements.filter(el => (el.type || '').toLowerCase().includes(filter));
}

/**
 * Format elements into a human-readable summary for the LLM.
 * @param {Array} elements - Normalised element list
 * @param {number} [limit=30] - Max elements to include
 * @returns {string}
 */
export function formatElementsSummary(elements, limit = 30) {
  if (!elements || elements.length === 0) {
    return 'SCREEN ELEMENTS (0): No interactive elements detected.';
  }

  // Filter to elements with visible text or label
  const visible = elements.filter(el => el.label || el.text);
  const capped = visible.slice(0, limit);

  // Count duplicates (same label+type) to add [1], [2] suffixes
  const labelTypeCounts = new Map();
  for (const el of capped) {
    const name = el.label || el.text || '(unnamed)';
    const type = simplifyType(el.type || 'Unknown');
    const key = `${name}|||${type}`;
    labelTypeCounts.set(key, (labelTypeCounts.get(key) || 0) + 1);
  }

  // Track which labels+types have duplicates and assign indices
  const labelTypeIndex = new Map();
  const lines = capped.map((el, i) => {
    const name = el.label || el.text || '(unnamed)';
    const type = simplifyType(el.type || 'Unknown');
    const editable = isEditable(el.type) ? ' - editable' : '';
    const key = `${name}|||${type}`;
    const total = labelTypeCounts.get(key) || 1;

    let suffix = '';
    if (total > 1) {
      const idx = (labelTypeIndex.get(key) || 0) + 1;
      labelTypeIndex.set(key, idx);
      suffix = ` [${idx}]`;
    }

    return `${i + 1}. "${name}" (${type})${suffix}${editable}`;
  });

  const header = `SCREEN ELEMENTS (${visible.length}${visible.length > limit ? `, showing first ${limit}` : ''}):`;
  return header + '\n' + lines.join('\n');
}

/**
 * Simplify a fully-qualified type name to its short form.
 * e.g. "android.widget.Button" → "Button", "XCUIElementTypeTextField" → "TextField"
 */
function simplifyType(type) {
  // Android: take last segment after `.`
  if (type.includes('.')) return type.split('.').pop();
  // iOS: strip XCUIElementType prefix
  if (type.startsWith('XCUIElementType')) return type.replace('XCUIElementType', '');
  return type;
}

/**
 * Check if an element type is editable (text field).
 */
function isEditable(type) {
  if (!type) return false;
  const t = type.toLowerCase();
  return t.includes('textfield') || t.includes('edittext') ||
         t.includes('textarea') || t.includes('searchfield') ||
         t.includes('input');
}
