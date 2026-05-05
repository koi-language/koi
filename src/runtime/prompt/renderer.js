/**
 * Renderer — substitutes resolved slot content into a template.
 *
 * Templates use {{slot_id}} placeholders. Conditional rendering via
 * {{#if slot_id}} ... {{/if}} blocks (truthy = non-empty content).
 *
 * Intentionally NOT full Handlebars: we don't want a dep, and the lexicon of
 * what templates need is small. If we hit limits, swap in `handlebars` later.
 */

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
const IF_BLOCK_RE = /\{\{\s*#if\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g;

/**
 * Render a template against a slots map.
 *
 * @param {string} template
 * @param {Record<string,string>} slots  Map of slot id → resolved content.
 * @returns {string}
 */
export function render(template, slots) {
  if (typeof template !== 'string') throw new Error('renderer.render: template must be string');

  // Pass 1: resolve {{#if x}}…{{/if}} blocks.
  let out = template.replace(IF_BLOCK_RE, (_match, id, body) => {
    const value = _lookup(slots, id);
    if (value && String(value).trim().length > 0) return body;
    return '';
  });

  // Pass 2: substitute {{var}}.
  out = out.replace(VAR_RE, (_match, id) => {
    const value = _lookup(slots, id);
    if (value === undefined || value === null) return '';
    return String(value);
  });

  // Cleanup: collapse 3+ blank lines that result from absent conditional blocks.
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

function _lookup(slots, dotted) {
  if (!slots) return undefined;
  if (!dotted.includes('.')) return slots[dotted];
  const parts = dotted.split('.');
  let cur = slots;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
