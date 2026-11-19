/**
 * update_scene3d — patch a 3D previz scene and re-render only what changed.
 *
 * Shot hashes decide what re-renders: moving a prop or a character
 * re-renders every shot (they all see the set), re-framing one camera
 * re-renders that shot, trimming a static shot only re-cuts its card.
 */

import { lockedSceneViolation, lockedShotIds, mergeShots } from './_story-timeline.js';
import { physicsReport } from './_physics.js';
import { resolveImpacts } from './_ragdoll.js';
import { requestStrips } from './scene3d-live.js';
import { normalizeScene, readScene, writeScene, renderScene, summarize, buildReview, cleanId, timingReport } from './_store.js';
import { withPhotoCheck } from './_photo-check.js';
import { applyCardModels, savePhotoCameras } from './_card-models.js';
import { insertSceneTime } from './_clock.js';
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
    'Finishing 3D work never leads to a video: show the 3D and stop, even when existing takes are now out of date (say so in one line). ' +
    '`set` replaces root fields (name, aspect, style, storyboard, set, lighting, characters, actions). ' +
    '`shots:[{ id, set:{…} }]` patches shots (camera is merged one level deep; null deletes a key), ' +
    '`characters:[{ id, set }]` / `props:[{ id, set }]` patch one character / prop, ' +
    '`addShots:[shot]`, `removeShots:["id"]`, `addActions:[action]`, `removeActions:[index]`, ' +
    '`confirmShots:["id"]` (storyboard change reviewed, blocking still right → mark up to date). ' +
    'Action and cameras are separate. The action (`actions`) is what happens, on the scene clock; a shot is only a camera, and the stretch it watches follows from story order and durations, one after the other: its startMs is set for you. ' +
    'So changing a shot\'s durationMs, order or removing it never changes what happens: the later shots just watch later moments. Weigh what that does to their framing and adapt cameras, listed in `cameraCheck`, never the action. ' +
    '`insertTime:[{ atMs, ms }]` adds time to the action itself: use it only when what happens must really take longer; moving vehicles keep their speed, and `timeMoved` gives how far each moved: check anything that must meet it later. ' +
    '`mergeShots:["sh4","sh5"]` turns consecutive shots into ONE (the user: "fusiona estos planos"): the first keeps ' +
    'its camera over the whole window, the others disappear from the scene and the story, whose first shot absorbs ' +
    'their action / dialogue / sound (rewrite that merged wording with the cinematic skill afterwards). ' +
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
      mergeShots: { type: 'array', items: { type: 'string' }, description: 'Consecutive shot ids to merge into the first (keeps its camera); applied before the rest of the patch.' },
      insertTime: { type: 'array', items: { type: 'object' }, description: '[{ atMs, ms }]: add time to the action at a moment; moving vehicles keep their speed.' },
      render: { type: 'boolean', description: 'Re-render now (default true)' },
    },
    required: ['id'],
  },

  async execute(params) {
    const id = cleanId(params?.id);
    if (Array.isArray(params?.mergeShots) && params.mergeShots.length > 1) {
      const locked = lockedShotIds(id);
      const hit = params.mergeShots.map(String).filter((s) => locked.has(s));
      if (hit.length) {
        return { success: false, error: `update_scene3d: mergeShots: shots ${hit.join(', ')} belong to clips the user locked on the timeline.` };
      }
      try {
        mergeShots(id, params.mergeShots.map(String));
      } catch (e) {
        return { success: false, error: `update_scene3d: mergeShots: ${e.message}` };
      }
    }
    const existing = id ? readScene(id) : null;
    if (!existing) return { success: false, error: `update_scene3d: no scene "${params?.id}". Use get_scene3d to list scenes.` };
    const next = JSON.parse(JSON.stringify(existing));
    const timeMoved = {};
    const addTime = (atMs, ms) => {
      for (const [pid, d] of Object.entries(insertSceneTime(next, atMs, ms))) {
        timeMoved[pid] = d.map((v, i) => Math.round(((timeMoved[pid]?.[i] || 0) + v) * 100) / 100);
      }
    };
    try {
      if (_isObj(params.set)) {
        for (const [k, v] of Object.entries(params.set)) {
          if (!ROOT.includes(k)) throw new Error(`unknown root field "${k}" (allowed: ${ROOT.join(', ')})`);
          if (v === null) delete next[k]; else next[k] = v;
        }
      }
      // Latest moment first, so each insert's atMs still means the current clock.
      const inserts = (Array.isArray(params.insertTime) ? params.insertTime : []).map((x) => [Number(x?.atMs), Number(x?.ms)]);
      if (inserts.some(([a, m]) => !(a >= 0) || !(m > 0))) throw new Error('each insertTime needs { atMs >= 0, ms > 0 }');
      for (const [a, m] of inserts.sort((x, y) => y[0] - x[0])) addTime(a, m);
      if (Array.isArray(params.characters)) _mergeById(next.characters || [], params.characters, 'character');
      if (Array.isArray(params.props)) {
        next.set = next.set || {};
        next.set.props = next.set.props || [];
        _mergeById(next.set.props, params.props, 'prop');
      }
      if (Array.isArray(params.removeShots)) {
        next.shots = (next.shots || []).filter((s) => !params.removeShots.includes(s.id));
      }
      if (Array.isArray(params.shots)) {
        _mergeById(next.shots || [], params.shots, 'shot');
        // Re-staging a shot's camera or timing drops the window a montage
        // trim kept for it.
        for (const p of params.shots) {
          const set = _isObj(p?.set) ? p.set : (p || {});
          if (!('camWindow' in set) && ['startMs', 'durationMs', 'camera', 'move', 'keyframes'].some((k) => k in set)) {
            const sh = (next.shots || []).find((x) => x.id === p.id);
            if (sh) delete sh.camWindow;
          }
        }
      }
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
    const lockedBy = lockedSceneViolation(existing, scene);
    if (lockedBy) return { success: false, error: `update_scene3d: ${lockedBy}` };
    // Which shots this edit re-blocked: a world change (set, cast, blocking)
    // re-examines every shot; otherwise only the patched / added / confirmed ones.
    const world = _isObj(params.set) || Array.isArray(params.characters) || Array.isArray(params.props)
      || Array.isArray(params.addActions) || Array.isArray(params.removeActions);
    const touched = world ? null : new Set([
      ...(params.shots || []).map((p) => p?.id),
      ...(params.addShots || []).map((p) => p?.id),
      ...(Array.isArray(params.confirmShots) ? params.confirmShots : []),
    ].filter(Boolean));
    // Looked at: a camera the agent re-framed or confirmed leaves the list.
    if (scene.cameraCheck?.length) {
      const seen = new Set([
        ...(params.confirmShots || []),
        ...(params.shots || []).filter((p) => { const x = _isObj(p?.set) ? p.set : (p || {}); return 'camera' in x || 'keyframes' in x || 'move' in x; }).map((p) => p.id),
      ]);
      scene.cameraCheck = scene.cameraCheck.filter((x) => !seen.has(x));
      if (!scene.cameraCheck.length) delete scene.cameraCheck;
    }
    await resolveImpacts(scene, existing);
    stampSources(scene, touched);
    // A card's photo cameras moved on the stage: they are the model's.
    if (scene.cardPreview) savePhotoCameras(scene, touched ? new Set(touched) : null);
    applyCardModels(scene); // the cards' models, always
    writeScene(scene);
    // Filmstrips of the changed shots from the live session, when it already
    // shows this version (a camera edit made on the stage).
    requestStrips(scene.id, touched ? [...touched] : null);
    let r = { rendered: [], reused: [], failed: [] };
    if (params.render !== false) {
      try {
        r = await renderScene(scene, { onProgress: (_p, label) => label && channel.log('scene3d', label) });
      } catch (e) {
        return { success: false, error: `update_scene3d: saved but render failed: ${e.message}`, scene: summarize(scene) };
      }
    }
    const pv = scene.storyboard?.id ? previzDirective(refreshPrevizFlags(scene.storyboard.id)) : null;
    return withPhotoCheck(params.render === false ? null : scene, {
      success: r.failed.length === 0,
      scene: summarize(scene),
      rendered: r.rendered,
      ...(Object.keys(timeMoved).length ? { timeMoved } : {}),
      ...(r.failed.length ? { failed: r.failed } : {}),
      ...(pv ? { previz3d: pv } : {}),
      ...(r.rendered.length ? buildReview(scene, r.rendered) : {}),
      ...timingReport(scene),
      ...physicsReport(scene),
    });
  },
};
