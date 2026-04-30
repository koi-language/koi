/**
 * Append a title (text overlay) clip to a timeline.
 *
 * Title clips have no underlying media file — they're a synthetic
 * `title:<id>` clip on a V track whose typography lives in `titleProps`.
 * The renderer and the GUI both pre-render them to a transparent PNG
 * and composite them on top of the V tracks below, so a title placed
 * on V2 will overlay whatever lives on V1 at the same time.
 *
 * Schema-wise the agent sees a flat field list (text, fontSize, color,
 * bold, italic, align, outline, shadow); we map those onto the GUI's
 * raw TitleProps shape (colorArgb / fontWeight / TextAlign index / …)
 * before persisting so a title authored from a tool round-trips
 * cleanly with one created interactively in the GUI.
 */

import { addTitle } from '../../state/timelines.js';
import { titleOptionsToProps } from './_title-props.js';

export default {
  type: 'add_title_to_timeline',
  intent: 'add_title_to_timeline',
  description:
    'Append a text overlay (title) clip to a timeline. Title clips are visual-only — they ALWAYS go on a V track ' +
    'and overlay whatever V tracks below them are showing at the same time. ' +
    'Required: id (timeline), startMs, text. Defaults: track="V1", durationMs=3000, fontSize=96, white, bold, centered, soft shadow. ' +
    'color/outlineColor/shadowColor accept hex (#RRGGBB or #AARRGGBB). align ∈ {left, center, right}. ' +
    'Use update_title to edit text or styling later, and the regular move/trim/remove tools to reposition the clip.',
  thinkingHint: 'Adding title',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id:         { type: 'string',  description: 'Timeline id' },
      track:      { type: 'string',  description: 'V-track to place the title on (default "V1"). Must be a video track.' },
      startMs:    { type: 'number',  description: 'Position on the timeline, ms' },
      durationMs: { type: 'number',  description: 'How long the title is visible, ms (default 3000)' },
      text:       { type: 'string',  description: 'The title text. Newlines (\\n) become hard line breaks.' },
      fontSize:   { type: 'number',  description: 'Logical pixels at the project canvas\'s native size (default 96)' },
      color:      { type: 'string',  description: 'Text colour as #RRGGBB or #AARRGGBB hex (default #FFFFFF)' },
      bold:       { type: 'boolean', description: 'Bold weight (default true → 700; false → 400)' },
      italic:     { type: 'boolean', description: 'Italic (default false)' },
      align:      { type: 'string',  description: 'left | center | right (default center)' },
      outline:        { type: 'boolean', description: 'Draw a contrasting outline around the text (default false)' },
      outlineWidth:   { type: 'number',  description: 'Outline thickness in logical px when outline=true (default 4)' },
      outlineColor:   { type: 'string',  description: 'Outline colour as hex (default #000000)' },
      shadow:         { type: 'boolean', description: 'Soft drop shadow (default true)' },
      shadowBlur:     { type: 'number',  description: 'Shadow blur radius in logical px (default 6 when shadow=true)' },
      shadowColor:    { type: 'string',  description: 'Shadow colour as hex (default #000000 at 60% alpha)' },
      linkId:     { type: 'string',  description: 'Optional pairing id — link a title to a V-clip to move/trim/remove together' },
      offsetX:    { type: 'number',  description: 'Horizontal pan as fraction of canvas width (0 = centered)' },
      offsetY:    { type: 'number',  description: 'Vertical pan as fraction of canvas height (0 = centered)' },
      scale:      { type: 'number',  description: 'Uniform scale (1 = identity)' },
    },
    required: ['id', 'startMs', 'text'],
  },

  async execute(params = {}) {
    try {
      const titleProps = titleOptionsToProps(params);
      const { clip, timeline } = addTitle(params.id, {
        track:      params.track ?? 'V1',
        startMs:    params.startMs,
        durationMs: params.durationMs ?? 3000,
        titleProps,
        linkId:     params.linkId,
        offsetX:    params.offsetX,
        offsetY:    params.offsetY,
        scale:      params.scale,
      });
      return { success: true, clipId: clip.id, clip, timeline };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
