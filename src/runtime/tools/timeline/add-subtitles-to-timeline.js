/**
 * Bulk-add subtitle / caption clips to a timeline in one call.
 *
 * Takes a transcription-style array of `{ startMs, endMs|durationMs,
 * text }` and turns each segment into a title clip on a single V track,
 * sharing the same subtitle-appropriate styling baseline (smaller font,
 * strong outline, bottom-of-frame placement). Built specifically for
 * the "transcribe → place captions" flow so the agent doesn't end up
 * spamming `add_title_to_timeline` once per line.
 *
 * Defaults are tuned for legibility on top of arbitrary footage: white
 * 48pt bold, black 3px outline, soft drop shadow, anchored ~35% below
 * centre. The agent can override any of these globally via the same
 * flat options used by `add_title_to_timeline` (text excluded — text
 * is per segment).
 */

import { addSubtitles } from '../../state/timelines.js';
import { titleOptionsToProps } from './_title-props.js';

// Subtitle-appropriate baseline. Smaller than a title (which is 96pt),
// always outlined for legibility on busy backgrounds, and anchored
// toward the bottom of the frame via offsetY.
const SUBTITLE_DEFAULTS = {
  fontSize: 48,
  bold: true,
  align: 'center',
  outline: true,
  outlineWidth: 3,
  outlineColor: '#000000',
  shadow: true,
  shadowBlur: 4,
};

// offsetY is in fraction-of-canvas units (0 = centred, +0.5 = bottom
// edge). 0.35 puts captions roughly in the lower-third "safe area"
// most editing conventions use, leaving a small margin from the edge.
const SUBTITLE_OFFSET_Y = 0.35;

export default {
  type: 'add_subtitles_to_timeline',
  intent: 'add_subtitles_to_timeline',
  description:
    'Bulk-add subtitle/caption clips for a transcript. Pass `segments: [{ startMs, durationMs?|endMs?, text }]` and ' +
    'every segment becomes a title clip on a single V track sharing the same subtitle-styling baseline. ' +
    'Defaults: white 48pt bold, 3px black outline, soft shadow, anchored ~35% below centre — legible over arbitrary footage. ' +
    'Override any styling field globally (fontSize, color, outline, outlineColor, shadow, shadowColor, bold, italic, align, offsetY) — ' +
    'they apply to every segment in the call. ' +
    'Track defaults to "V2" so subtitles overlay whatever V1 (or below) is showing; pass a different track if your edit uses a different layout. ' +
    'Returns: { success, clipIds, count, timeline }. ' +
    'Typical flow: 1) generate_audio mode=transcribe → segments with start/end; 2) call this tool once with the whole list.',
  thinkingHint: 'Adding subtitles',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      track: { type: 'string', description: 'V-track for the captions (default "V2"). Must overlay the footage you want captioned.' },
      segments: {
        type: 'array',
        description:
          'Array of { startMs, durationMs?, endMs?, text }. One of durationMs/endMs is required per segment. ' +
          'Empty segments are rejected — drop silent ranges before calling.',
        items: {
          type: 'object',
          properties: {
            startMs:    { type: 'number' },
            durationMs: { type: 'number' },
            endMs:      { type: 'number' },
            text:       { type: 'string' },
          },
          required: ['startMs', 'text'],
        },
      },
      // Styling overrides (applied to every segment).
      fontSize:     { type: 'number',  description: 'Logical pixels (default 48). 36-56 typical for subtitles.' },
      color:        { type: 'string',  description: 'Text colour as #RRGGBB or #AARRGGBB (default #FFFFFF).' },
      bold:         { type: 'boolean', description: 'Bold weight (default true; subtitle convention).' },
      italic:       { type: 'boolean', description: 'Italic (default false).' },
      align:        { type: 'string',  description: 'left | center | right (default center).' },
      outline:      { type: 'boolean', description: 'Outline (default true; turn off only for clean studio footage).' },
      outlineWidth: { type: 'number',  description: 'Outline thickness in logical px (default 3).' },
      outlineColor: { type: 'string',  description: 'Outline colour as hex (default #000000).' },
      shadow:       { type: 'boolean', description: 'Drop shadow (default true).' },
      shadowBlur:   { type: 'number',  description: 'Shadow blur radius (default 4).' },
      shadowColor:  { type: 'string',  description: 'Shadow colour as hex.' },
      offsetY: { type: 'number', description: 'Vertical placement, fraction of canvas (0=centre, +0.5=bottom). Default 0.35.' },
    },
    required: ['id', 'segments'],
  },

  async execute(params = {}) {
    try {
      // Merge tool-level subtitle defaults with the agent's overrides.
      // titleOptionsToProps in full mode also fills in TitleProps-level
      // defaults for anything still missing (font family, weights, etc).
      const styling = { ...SUBTITLE_DEFAULTS, ...params, text: '' };
      const propsBaseline = titleOptionsToProps(styling);
      const offsetY = Number.isFinite(params.offsetY) ? params.offsetY : SUBTITLE_OFFSET_Y;

      const { clips, timeline } = addSubtitles(params.id, {
        track:    params.track ?? 'V2',
        segments: params.segments,
        propsBaseline,
        offsetY,
      });

      return {
        success: true,
        count: clips.length,
        clipIds: clips.map((c) => c.id),
        timeline,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
