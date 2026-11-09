/**
 * card_preview_scene3d — the scene that shows a location / object card's 3D
 * model on its own, for the card's live 3D view (the same stage as the
 * timeline, without cameras). Kept on the card's current model.
 */

import { cardPreviewScene } from './_card-models.js';

export default {
  type: 'card_preview_scene3d',
  intent: 'card_preview_scene3d',
  description: 'Internal (GUI card 3D view): the scene id that shows a location or object card\'s 3D model. Returns { id } or { id: null } while the card has no model.',
  thinkingHint: 'Preparing 3D view',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['location', 'object'] },
      id: { type: 'string', description: 'Card id' },
    },
    required: ['kind', 'id'],
  },

  async execute(params = {}) {
    const kind = params.kind === 'location' ? 'location' : 'object';
    if (typeof params.id !== 'string' || !params.id.trim()) return { success: false, error: 'card_preview_scene3d: `id` is required.' };
    try {
      return { success: true, id: cardPreviewScene(kind, params.id.trim()) };
    } catch (e) {
      return { success: false, error: `card_preview_scene3d: ${e.message}` };
    }
  },
};
