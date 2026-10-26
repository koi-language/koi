/**
 * update_scene3d — patch a 3D previz scene and re-render only what changed.
 *
 * Shot hashes decide what re-renders: moving a prop or a character
 * re-renders every shot (they all see the set), re-framing one camera
 * re-renders that shot, trimming a static shot only re-cuts its card.
 */

import { normalizeScene, readScene, writeScene, renderScene, summarize, buildReview, cleanId } from './_store.js';
import { SCENE3D_SHAPE } from './_schema-doc.js';
import { stampSources, refreshPrevizFlags, previzDirective } from './_previz-sync.js';
import { channel } from '../../io/channel.js';

const _isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const ROOT = ['name', 'aspect', 'fps', 'style', 'characterStyle', 'storyboard', 'set', 'lighting', 'characters', 'actions', 'resolution'];

function _mergeById(list, patches, what) {
  const byId = new Map(list.map((x) => [x.id, x]));
  for (const p of patches) {
    if (!_isObj(p) || typeof p.id !== 'string') throw new Error(`each ${what} patch must be { id, set:{…} }`);
    const cur = byId.get(p.id);
    if (!cur) throw new Error(`no ${what} "${p.id}" (have: ${[...byId.keys()].join(', ')})`);
    const set = _isObj(p.set) ? p.set : Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'id'));
    for (const [k, v] of Object.entries(set)) {
      if (v === null) delete cur[k];
      // camera is merged one level deep so "lens: 50" keeps the subject.
      else if (k === 'camera' && _isObj(v) && _isObj(cur.camera)) cur.camera = { ...cur.camera, ...v };
      else cur[k] = v;
    }
  }
}

export default {
  type: 'update_scene3d',
  intent: 'update_scene3d',
  description:
    'Patch an existing 3D previz scene (from save_scene3d) and re-render only the affected shot previews. ' +
    '`set` replaces root fields (name, aspect, style, storyboard, set, lighting, characters, actions). ' +
    '`shots:[{ id, set:{…} }]` patches shots (camera is merged one level deep; null deletes a key), ' +
    '`characters:[{ id, set }]` / `props:[{ id, set }]` patch one character / prop, ' +
    '`addShots:[shot]`, `removeShots:["id"]`, `addActions:[action]`, `removeActions:[index]`, ' +
    '`confirmShots:["id"]` (storyboard change reviewed, blocking still right → mark up to date). ' +
    'Use it for every "más cerrado", "cámara más baja", "que entre por la derecha"-style tweak. ' +
    SCENE3D_SHAPE,
  thinkingHint: 'Updating 3D scene',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Scene id (s3d-…)' },
      set: { type: 'object', description: 'Root fields to replace' },
      shots: { type: 'array', items: { type: 'object' }, description: '[{ id, set:{…} }]' },
      characters: { type: 'array', items: { type: 'object' }, description: '[{ id, set:{…} }]' },
      props: { type: 'array', items: { type: 'object' }, description: '[{ id, set:{…} }]' },
      addShots: { type: 'array', items: { type: 'object' } },
      removeShots: { type: 'array', items: { type: 'string' } },
      addActions: { type: 'array', items: { type: 'object' } },
      removeActions: { type: 'array', items: { type: 'number' } },
      confirmShots: { type: 'array', items: { type: 'string' }, description: 'Shot ids whose storyboard change does NOT affect the blocking (e.g. only dialogue wording) — marks them up to date without changes.' },
      render: { type: 'boolean', description: 'Re-render now (default true)' },
    },
    required: ['id'],
  },

  async execute(params) {
    const id = cleanId(params?.id);
    const existing = id ? readScene(id) : null;
    if (!existing) return { success: false, error: `update_scene3d: no scene "${params?.id}". Use get_scene3d to list scenes.` };
    const next = JSON.parse(JSON.stringify(existing));
    try {
      if (_isObj(params.set)) {
        for (const [k, v] of Object.entries(params.set)) {
          if (!ROOT.includes(k)) throw new Error(`unknown root field "${k}" (allowed: ${ROOT.join(', ')})`);
          if (v === null) delete next[k]; else next[k] = v;
        }
      }
      if (Array.isArray(params.characters)) _mergeById(next.characters || [], params.characters, 'character');
      if (Array.isArray(params.props)) {
        next.set = next.set || {};
        next.set.props = next.set.props || [];
        _mergeById(next.set.props, params.props, 'prop');
      }
      if (Array.isArray(params.removeShots)) {
        next.shots = (next.shots || []).filter((s) => !params.removeShots.includes(s.id));
      }
      if (Array.isArray(params.shots)) _mergeById(next.shots || [], params.shots, 'shot');
      if (Array.isArray(params.addShots)) next.shots = [...(next.shots || []), ...params.addShots];
      if (Array.isArray(params.removeActions)) {
        const drop = new Set(params.removeActions.map(Number));
        next.actions = (next.actions || []).filter((_, i) => !drop.has(i));
      }
      if (Array.isArray(params.addActions)) next.actions = [...(next.actions || []), ...params.addActions];
    } catch (e) {
      return { success: false, error: `update_scene3d: ${e.message}` };
    }
    let scene;
    try {
      scene = normalizeScene(next, existing);
    } catch (e) {
      return { success: false, error: `update_scene3d: ${e.message}` };
    }
    // Which shots this edit re-blocked: a world change (set, cast, blocking)
    // re-examines every shot; otherwise only the patched / added / confirmed ones.
    const world = _isObj(params.set) || Array.isArray(params.characters) || Array.isArray(params.props)
      || Array.isArray(params.addActions) || Array.isArray(params.removeActions);
    const touched = world ? null : new Set([
      ...(params.shots || []).map((p) => p?.id),
      ...(params.addShots || []).map((p) => p?.id),
      ...(Array.isArray(params.confirmShots) ? params.confirmShots : []),
    ].filter(Boolean));
    stampSources(scene, touched);
    writeScene(scene);
    let r = { rendered: [], reused: [], failed: [] };
    if (params.render !== false) {
      try {
        r = await renderScene(scene, { onProgress: (_p, label) => label && channel.log('scene3d', label) });
      } catch (e) {
        return { success: false, error: `update_scene3d: saved but render failed: ${e.message}`, scene: summarize(scene) };
      }
    }
    const pv = scene.storyboard?.id ? previzDirective(refreshPrevizFlags(scene.storyboard.id)) : null;
    return {
      success: r.failed.length === 0,
      scene: summarize(scene),
      rendered: r.rendered,
      ...(r.failed.length ? { failed: r.failed } : {}),
      ...(pv ? { previz3d: pv } : {}),
      ...(r.rendered.length ? buildReview(scene, r.rendered) : {}),
    };
  },
};
