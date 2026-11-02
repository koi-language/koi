/**
 * get_scene3d — read one 3D previz scene (full JSON), or list them.
 */

import { readScene, listScenes, summarize, cleanId, timingReport } from './_store.js';
import { refreshPrevizFlags, previzDirective } from './_previz-sync.js';
import { withoutSimFrames } from './_ragdoll.js';
import { ensureStoryTimeline } from './_story-timeline.js';
import os from 'os';
import path from 'path';

import { docDir } from '../../state/doc-root.js';
export default {
  type: 'get_scene3d',
  intent: 'get_scene3d',
  description:
    'Read a 3D previz scene by id (returns the full scene JSON + per-shot preview paths), or omit `id` to list every scene ' +
    '(optionally filtered by `storyboardId` — then it also returns `previz3d`: what is missing / out of date vs the storyboard, ' +
    'including NEW reference images of a place the set must be rebuilt from). Read before update_scene3d when you need current positions / cameras.',
  thinkingHint: 'Reading 3D scene',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Scene id (omit to list)' },
      storyboardId: { type: 'string', description: 'List only scenes linked to this storyboard' },
      markPending: { type: 'boolean', description: 'Internal (visor): false = status check only, do not mark shots as being built.' },
      storyTimeline: { type: 'boolean', description: 'With storyboardId: also create / re-lay the storyboard\'s montage timeline (every 3D shot in script order) and return its id.' },
    },
  },

  async execute(params) {
    const id = cleanId(params?.id);
    if (!id) {
      let scenes = listScenes();
      if (params?.storyboardId) {
        scenes = scenes.filter((s) => s.storyboard?.id === params.storyboardId);
        // markPending:false = just looking (the visor deciding whether to ask);
        // the agent's own read means it is about to (re)build them.
        const pv = previzDirective(refreshPrevizFlags(params.storyboardId, { markPending: params.markPending !== false }));
        let montage = {};
        if (params.storyTimeline) {
          const { timelineId } = ensureStoryTimeline(params.storyboardId);
          if (timelineId) {
            montage = {
              storyTimelineId: timelineId,
              storyTimelinePath: path.join(docDir('timelines'), `${timelineId}.json`),
            };
          }
        }
        return { success: true, scenes, ...montage, ...(pv ? { previz3d: pv } : { previz3d: { required: false, inSync: true } }) };
      }
      return { success: true, scenes };
    }
    const scene = readScene(id);
    if (!scene) return { success: false, error: `get_scene3d: no scene "${params.id}".` };
    return { success: true, scene: withoutSimFrames(scene), summary: summarize(scene), ...timingReport(scene) };
  },
};
