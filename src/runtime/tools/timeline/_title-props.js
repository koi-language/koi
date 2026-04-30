/**
 * Translate agent-friendly title options (text, hex colors, bold/italic,
 * left/center/right, outline/shadow toggles) into the raw `TitleProps`
 * shape the GUI persists (colorArgb 32-bit, fontWeight as numeric value,
 * TextAlign as enum index, outlineWidth/shadowBlur in logical px).
 *
 * Two modes:
 *   - default (full)        — used by add_title; produces a complete object
 *                              suitable for createTimeline / addClip; required
 *                              `text` enforced by the caller.
 *   - { partial: true }     — used by update_title; only includes fields the
 *                              caller actually passed, so unspecified styling
 *                              is left untouched. Returns null entries when an
 *                              agent explicitly disables outline/shadow so the
 *                              underlying merge clears the field.
 *
 * Hex parsing accepts #RRGGBB (defaults alpha to FF) and #AARRGGBB.
 * #RGB / #ARGB shorthand is NOT supported — agents already write full hex
 * and supporting both makes the regex error messages noisy.
 */

const TEXT_ALIGN_INDEX = { left: 0, right: 1, center: 2 };

function parseHexColor(hex, fieldName) {
  if (typeof hex !== 'string') throw new Error(`${fieldName} must be a hex string`);
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (!m) throw new Error(`${fieldName} must be #RRGGBB or #AARRGGBB hex (got ${hex})`);
  const raw = m[1];
  const argb = raw.length === 6 ? `FF${raw}` : raw;
  // ARGB stored as a signed 32-bit on disk (the GUI's Color value); use
  // an unsigned shift to coerce into the right bit pattern.
  return parseInt(argb, 16) | 0;
}

export function titleOptionsToProps(opts = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(opts, k);

  if (has('text')) out.text = opts.text;
  if (has('fontFamily')) out.fontFamily = opts.fontFamily;
  if (has('fontSize')) out.fontSize = opts.fontSize;
  if (has('color')) out.colorArgb = parseHexColor(opts.color, 'color');
  if (has('bold')) out.fontWeight = opts.bold ? 700 : 400;
  if (has('italic')) out.italic = !!opts.italic;
  if (has('align')) {
    const idx = TEXT_ALIGN_INDEX[String(opts.align).toLowerCase()];
    if (idx == null) throw new Error(`align must be left | center | right (got ${opts.align})`);
    out.align = idx;
  }

  // Outline: `outline` is a boolean toggle, `outlineWidth` is the explicit
  // value. Together they cover both "agent just wants an outline" and
  // "agent wants 6px stroke specifically". outlineColor only takes effect
  // when an outline actually exists.
  if (has('outline')) {
    out.outlineWidth = opts.outline ? (Number.isFinite(opts.outlineWidth) ? opts.outlineWidth : 4) : 0;
  } else if (has('outlineWidth')) {
    out.outlineWidth = opts.outlineWidth;
  }
  if (has('outlineColor')) out.outlineColorArgb = parseHexColor(opts.outlineColor, 'outlineColor');

  if (has('shadow')) {
    out.shadowBlur = opts.shadow ? (Number.isFinite(opts.shadowBlur) ? opts.shadowBlur : 6) : 0;
  } else if (has('shadowBlur')) {
    out.shadowBlur = opts.shadowBlur;
  }
  if (has('shadowColor')) out.shadowColorArgb = parseHexColor(opts.shadowColor, 'shadowColor');

  if (partial) return out;

  // Full mode (add_title): if the agent didn't override styling, fall
  // back to the same defaults as the GUI's TitleProps constructor so a
  // tool-authored title looks identical to one created interactively.
  if (out.text == null) throw new Error('text is required');
  if (out.fontFamily == null) out.fontFamily = 'Inter';
  if (out.fontSize == null) out.fontSize = 96;
  if (out.colorArgb == null) out.colorArgb = 0xFFFFFFFF | 0;
  if (out.fontWeight == null) out.fontWeight = 700;
  if (out.align == null) out.align = TEXT_ALIGN_INDEX.center;
  if (out.italic == null) out.italic = false;
  if (out.outlineWidth == null) out.outlineWidth = 0;
  if (out.outlineColorArgb == null) out.outlineColorArgb = 0xFF000000 | 0;
  if (out.shadowBlur == null) out.shadowBlur = 6;
  if (out.shadowColorArgb == null) out.shadowColorArgb = 0x99000000 | 0;
  return out;
}
