/**
 * Edit the text or styling of an existing title clip.
 *
 * Only fields the agent passes are overwritten — the clip's track /
 * startMs / durationMs / linkId / transforms / transitions are left
 * untouched. To reposition or resize a title use the standard
 * move_clip / trim_clip / update_clip tools the same way you would for
 * any other clip.
 */

import { updateTitle } from '../../state/timelines.js';
import { titleOptionsToProps } from './_title-props.js';

export default {
  type: 'update_title',
  intent: 'update_title',
  description:
    'Patch a title clip\'s text and/or styling. Pass clipId of an existing title (path starts with "title:") plus any subset of: ' +
    'text, fontSize, color, bold, italic, align, outline, outlineWidth, outlineColor, shadow, shadowBlur, shadowColor. ' +
    'Position and duration changes go through move_clip / trim_clip — this tool only edits typography. ' +
    'Returns: { success, timeline }.',
  thinkingHint: 'Updating title',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id:     { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Title clip id (clip-XXXXXX). The clip\'s path must start with "title:".' },
      text:         { type: 'string', description: 'New title text' },
      fontSize:     { type: 'number', description: 'Logical pixels at the project canvas\'s native size' },
      color:        { type: 'string', description: 'Text colour as #RRGGBB or #AARRGGBB hex' },
      bold:         { type: 'boolean', description: 'Bold weight (true → 700, false → 400)' },
      italic:       { type: 'boolean', description: 'Italic' },
      align:        { type: 'string', description: 'left | center | right' },
      outline:      { type: 'boolean', description: 'Toggle outline. false also clears outlineWidth.' },
      outlineWidth: { type: 'number', description: 'Outline thickness in logical px' },
      outlineColor: { type: 'string', description: 'Outline colour as hex' },
      shadow:       { type: 'boolean', description: 'Toggle drop shadow. false also clears shadowBlur.' },
      shadowBlur:   { type: 'number', description: 'Shadow blur radius in logical px' },
      shadowColor:  { type: 'string', description: 'Shadow colour as hex' },
    },
    required: ['id', 'clipId'],
  },

  async execute(params = {}) {
    try {
      // Only forward the typography keys the agent actually passed — null
      // entries clear that prop back to its TitleProps default.
      const patch = titleOptionsToProps(params, { partial: true });
      if (Object.keys(patch).length === 0) {
        return { success: false, error: 'update_title: no styling fields provided' };
      }
      const tl = updateTitle(params.id, params.clipId, patch);
      return { success: true, timeline: tl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};
