/**
 * update_storyboard — PATCH an existing storyboard in place.
 *
 * The source-code-edit model applied to storyboards: instead of
 * round-tripping the FULL document through the LLM (slow — thousands
 * of output tokens — and drift-prone: re-worded fields the agent never
 * meant to touch re-render their panels), the agent sends ONLY the
 * fields it wants to change, addressed by scene/shot id. Everything
 * else is preserved on disk byte-for-byte, so the visor re-renders
 * ONLY the panels an edit actually affects.
 *
 * Scope: CONTENT edits (field values). Structural changes — adding,
 * removing or reordering scenes/shots, renumbering, id changes — stay
 * on save_storyboard, which validates the whole document shape.
 *
 * The result reports `affectedPanels`: the shot ids whose sketch WILL
 * re-render because of this patch (a root-field change = every panel;
 * an `action` change also re-renders the FOLLOWING shots of the same
 * scene, whose continuity context quotes the preceding actions).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { channel } from '../../io/channel.js';
import { saveStoryboardEntry } from '../../state/media-library.js';
import { _validate, _normalize, _editorialDiff, _isStr, _isObj } from './save-storyboard.js';

function _err(error) { return { success: false, error }; }

// Field whitelists — what a patch may touch at each level. Anything
// else in a `set` is rejected by name so the agent learns the boundary
// instead of silently losing the edit.
const ROOT_FIELDS = new Set([
  'name', 'aspect', 'synopsis', 'characters', 'locations', 'lighting', 'stylePrompt',
  'continuity', 'references', 'seed',
]);
const SCENE_FIELDS = new Set([
  'title', 'location', 'locationIds', 'locationId', 'notes', 'synopsis', 'references',
]);
const SHOT_FIELDS = new Set([
  // v7: `camera` (was `movement`), + `composition` + per-shot `lighting`.
  // `movement` kept as an accepted legacy alias (read as `camera` downstream).
  'duration', 'shot', 'camera', 'composition', 'lighting', 'movement',
  'action', 'dialogue', 'sfx', 'music',
  'continuity', 'state', 'noCutBefore', 'references',
]);

function _applySet(target, set, allowed, tag) {
  for (const [k, v] of Object.entries(set)) {
    if (!allowed.has(k)) {
      return `${tag}.set.${k} is not a patchable field (allowed: ${[...allowed].join(', ')}). ` +
        'Structural changes (add/remove/reorder scenes or shots, ids, numbers) go through save_storyboard.';
    }
    if (v === null) {
      delete target[k];
    } else {
      target[k] = v;
    }
  }
  return null;
}

export default {
  type: 'update_storyboard',
  intent: 'update_storyboard',
  description:
    'PATCH an existing storyboard — the diff-style edit tool. Send ONLY the fields you are changing, addressed by id; ' +
    'every other byte of the document is preserved verbatim on disk, so ONLY the panels your edit actually touches re-render their sketch. ' +
    'ALWAYS prefer this over save_storyboard for content edits: it is faster (no full-document round-trip) and cannot accidentally re-word untouched fields. ' +
    'Call shape: { id, set?: {…root fields…}, scenes?: [{ id, set: {…} }], shots?: [{ id, set: {…} }] }. ' +
    'Root set fields: name, aspect, synopsis, characters (recurring-cast roster array), locations (reusable-SET roster: array of { name, description?, locationId? }), lighting, stylePrompt, continuity (array of strings), references, seed. ' +
    'Scene set fields: title, location (free-text place), locationIds (array of saved location-card ids — a scene can span several sets), notes, synopsis, references. ' +
    'Shot set fields: duration, shot (free text), camera (free text: movement + lens/focal + speed + focus; was `movement`), composition (free text), lighting (free text, per-shot), action, dialogue, sfx, music, continuity ({characters,objects,place}), noCutBefore, references. ' +
    'Set a field to null to remove it. ' +
    'STRUCTURE TOO: `addShots` / `removeShots` / `moveShots` insert, delete and reorder shots by id — renumbering across the whole document is done FOR you. '
    + 'So a normal script iteration (reword a line, add a shot, drop one, move one) NEVER needs the full document. '
    + 'save_storyboard (full document) is only for CREATING a storyboard, or for scene-level restructuring (adding/removing/reordering whole SCENES) and id changes. ' +
    'Returns { success, path, id, editorialChanges, affectedPanels } where affectedPanels lists the shot ids whose sketch will re-render ' +
    '("ALL" when a root field changed — root fields feed every panel\'s prompt). ' +
    'Render-cost awareness: a root-field or scene-field edit re-renders many panels; an `action` edit also re-renders the FOLLOWING shots ' +
    'of its scene (their continuity context quotes preceding actions). Prefer the narrowest field that expresses the change.',
  instructions:
    'Edit flow: get_storyboard (or use what you already know) → update_storyboard with just the deltas. ' +
    'Example — change one shot\'s action and the global lighting: ' +
    '{ id: "my-board", set: { lighting: "…" }, shots: [{ id: "sh7", set: { action: "…" } }] }. ' +
    'Do NOT re-send unchanged fields "for safety": every field you send that differs from disk counts as an edit and re-renders panels. ' +
    'Check `affectedPanels` in the result and tell the user which panels will redraw.',
  thinkingHint: (action) => `Updating storyboard ${action?.id || ''}`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Storyboard id (filename under ~/.koi/storyboards/ without .json).' },
      set: { type: 'object', description: 'Root-level field changes (only the fields being changed).' },
      scenes: {
        type: 'array',
        description: 'Scene-level patches: [{ id, set: { title?, location?, locationId?, notes?, synopsis?, references? } }].',
        items: { type: 'object' },
      },
      shots: {
        type: 'array',
        description: 'Shot-level patches: [{ id, set: { duration?, shot?, camera?, composition?, lighting?, action?, dialogue?, sfx?, music?, continuity?, noCutBefore?, references? } }].',
        items: { type: 'object' },
      },
      addShots: {
        type: 'array',
        description: 'INSERT shots: [{ shot: {…full shot fields…}, afterShotId?: "sh3" | sceneId?: "sc1", index?: n }]. Say WHERE with `afterShotId` (right after that shot) or `sceneId` (+ optional `index`, default = end of scene). `shot.id` is minted when omitted, and every `number` in the document is renumbered for you.',
        items: { type: 'object' },
      },
      removeShots: {
        type: 'array',
        description: 'DELETE shots by id: ["sh4", "sh5"]. Renumbering is automatic. Refuses to empty a scene.',
        items: { type: 'string' },
      },
      moveShots: {
        type: 'array',
        description: 'REORDER / re-home shots: [{ id: "sh7", afterShotId?: "sh2" | sceneId?: "sc2", index?: n }]. Renumbering is automatic.',
        items: { type: 'object' },
      },
      summary: { type: 'string', description: 'One-line ledger blurb (optional).' },
    },
    required: ['id'],
  },

  async execute(action) {
    const id = _isStr(action?.id) ? path.basename(action.id.trim()).replace(/\.json$/i, '') : '';
    if (!id) return _err('"id" is required — the storyboard to patch. Use list_storyboards to discover ids.');

    const home = process.env.HOME || os.homedir();
    const filePath = path.join(home, '.koi', 'storyboards', `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return _err(`No storyboard at ${filePath}. update_storyboard only PATCHES existing storyboards — to create one, use save_storyboard.`);
    }
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return _err(`Could not parse ${filePath}: ${e.message}. Fix or re-create it with save_storyboard.`);
    }

    const hasRoot = _isObj(action.set) && Object.keys(action.set).length > 0;
    const scenePatches = Array.isArray(action.scenes) ? action.scenes : [];
    const shotPatches = Array.isArray(action.shots) ? action.shots : [];
    // STRUCTURAL ops — the reason this tool used to lose to save_storyboard.
    // "Add a shot here", "drop shot 3", "move this one earlier" are the most
    // common script edits there are, and without them the agent had to re-send
    // the WHOLE document (measured: 26k-37k chars vs ~1k for a patch), which
    // is what made editing a script feel so slow.
    const addShots = Array.isArray(action.addShots) ? action.addShots : [];
    const removeShots = Array.isArray(action.removeShots) ? action.removeShots : [];
    const moveShots = Array.isArray(action.moveShots) ? action.moveShots : [];
    const hasStructural =
      addShots.length || removeShots.length || moveShots.length;
    if (!hasRoot && !scenePatches.length && !shotPatches.length && !hasStructural) {
      return _err('Empty patch: provide `set`, `scenes`, `shots`, `addShots`, `removeShots` or `moveShots`.');
    }

    // Deep-copy so a failed validation leaves the on-disk doc untouched.
    const patched = JSON.parse(JSON.stringify(existing));

    if (hasRoot) {
      const e = _applySet(patched, action.set, ROOT_FIELDS, 'storyboard');
      if (e) return _err(e);
    }

    const sceneById = new Map();
    const shotById = new Map();
    if (Array.isArray(patched.scenes)) {
      for (const sc of patched.scenes) {
        if (_isObj(sc) && _isStr(sc.id)) sceneById.set(sc.id, sc);
        for (const sh of (Array.isArray(sc?.shots) ? sc.shots : [])) {
          if (_isObj(sh) && _isStr(sh.id)) shotById.set(sh.id, sh);
        }
      }
    }

    for (const p of scenePatches) {
      if (!_isObj(p) || !_isStr(p.id) || !_isObj(p.set)) {
        return _err('Each scenes[] entry must be { id, set: {…} }.');
      }
      const sc = sceneById.get(p.id);
      if (!sc) return _err(`No scene with id "${p.id}" (have: ${[...sceneById.keys()].join(', ')}).`);
      const e = _applySet(sc, p.set, SCENE_FIELDS, `scene ${p.id}`);
      if (e) return _err(e);
    }

    for (const p of shotPatches) {
      if (!_isObj(p) || !_isStr(p.id) || !_isObj(p.set)) {
        return _err('Each shots[] entry must be { id, set: {…} }.');
      }
      const sh = shotById.get(p.id);
      if (!sh) return _err(`No shot with id "${p.id}" (have: ${[...shotById.keys()].join(', ')}).`);
      const e = _applySet(sh, p.set, SHOT_FIELDS, `shot ${p.id}`);
      if (e) return _err(e);
    }

    // ── STRUCTURAL OPS, applied after the field patches ───────────────
    // Order matters: remove → move → add, so an add positioned "after X"
    // still resolves when X is being moved in the same call, and a removed
    // shot can't be an anchor.
    const _sceneOf = (doc, shotId) =>
      (Array.isArray(doc.scenes) ? doc.scenes : []).find((sc) =>
        (Array.isArray(sc?.shots) ? sc.shots : []).some((sh) => sh?.id === shotId));

    for (const rid of removeShots) {
      if (!_isStr(rid)) return _err('removeShots[] entries must be shot ids (strings).');
      const sc = _sceneOf(patched, rid);
      if (!sc) return _err(`removeShots: no shot with id "${rid}".`);
      sc.shots = sc.shots.filter((sh) => sh?.id !== rid);
      if (sc.shots.length === 0) {
        return _err(
          `removeShots: "${rid}" is the last shot of scene "${sc.id}" — removing it would leave an empty scene. `
          + 'Remove the whole scene with save_storyboard, or add a replacement shot in the same call.');
      }
    }

    for (const mv of moveShots) {
      if (!_isObj(mv) || !_isStr(mv.id)) {
        return _err('moveShots[] entries must be { id, afterShotId? , sceneId?, index? }.');
      }
      const from = _sceneOf(patched, mv.id);
      if (!from) return _err(`moveShots: no shot with id "${mv.id}".`);
      const shot = from.shots.find((sh) => sh?.id === mv.id);
      from.shots = from.shots.filter((sh) => sh?.id !== mv.id);
      let target = from;
      let at = from.shots.length;
      if (_isStr(mv.afterShotId)) {
        target = _sceneOf(patched, mv.afterShotId);
        if (!target) return _err(`moveShots: anchor shot "${mv.afterShotId}" not found.`);
        at = target.shots.findIndex((sh) => sh?.id === mv.afterShotId) + 1;
      } else if (_isStr(mv.sceneId)) {
        target = (patched.scenes || []).find((sc) => sc?.id === mv.sceneId);
        if (!target) return _err(`moveShots: scene "${mv.sceneId}" not found.`);
        at = Number.isInteger(mv.index) ? Math.max(0, Math.min(mv.index, target.shots.length)) : target.shots.length;
      } else if (Number.isInteger(mv.index)) {
        at = Math.max(0, Math.min(mv.index, from.shots.length));
      }
      target.shots.splice(at, 0, shot);
      if (from.shots.length === 0) {
        return _err(`moveShots: moving "${mv.id}" would leave scene "${from.id}" empty.`);
      }
    }

    const _mintedShotIds = [];
    for (const add of addShots) {
      if (!_isObj(add) || !_isObj(add.shot)) {
        return _err('addShots[] entries must be { shot: {…}, afterShotId? | sceneId? , index? }.');
      }
      const shot = { ...add.shot };
      if (!_isStr(shot.id) || !shot.id.trim()) {
        // Mint a non-colliding id so the caller never has to know what is taken.
        const taken = new Set();
        for (const sc of (patched.scenes || [])) {
          for (const sh of (Array.isArray(sc?.shots) ? sc.shots : [])) taken.add(sh?.id);
        }
        let n = taken.size + 1;
        while (taken.has(`sh${n}`)) n += 1;
        shot.id = `sh${n}`;
      }
      let target = null;
      let at = 0;
      if (_isStr(add.afterShotId)) {
        target = _sceneOf(patched, add.afterShotId);
        if (!target) return _err(`addShots: anchor shot "${add.afterShotId}" not found.`);
        at = target.shots.findIndex((sh) => sh?.id === add.afterShotId) + 1;
      } else if (_isStr(add.sceneId)) {
        target = (patched.scenes || []).find((sc) => sc?.id === add.sceneId);
        if (!target) return _err(`addShots: scene "${add.sceneId}" not found.`);
        at = Number.isInteger(add.index) ? Math.max(0, Math.min(add.index, target.shots.length)) : target.shots.length;
      } else {
        return _err('addShots: say WHERE — pass `afterShotId` (insert right after that shot) or `sceneId` (+ optional `index`).');
      }
      target.shots.splice(at, 0, shot);
      _mintedShotIds.push(shot.id);
    }

    // RENUMBER every shot across the whole document. `number` must run
    // sequentially from 1, and a `noCutBefore` shot SHARES the number of the
    // shot it continues — the same rule save_storyboard validates. Doing it
    // here is why the caller never has to send the renumbering itself.
    if (hasStructural) {
      let n = 0;
      let first = true;
      for (const sc of (Array.isArray(patched.scenes) ? patched.scenes : [])) {
        for (const sh of (Array.isArray(sc?.shots) ? sc.shots : [])) {
          if (!_isObj(sh)) continue;
          const cont = sh.noCutBefore === true && !first;
          // The first shot of the document can never continue a previous one.
          if (first && sh.noCutBefore === true) sh.noCutBefore = false;
          sh.number = cont ? n : ++n;
          first = false;
        }
      }
    }

    const validationError = _validate(patched);
    if (validationError) {
      return _err(`Patch would make the storyboard invalid: ${validationError} Nothing was written.`);
    }

    const normalized = _normalize(patched, existing);
    const serialized = JSON.stringify(normalized, null, 2) + '\n';
    try {
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return _err(`failed to write ${filePath}: ${err.message}`);
    }

    try {
      await saveStoryboardEntry(filePath, normalized, null, {
        summary: typeof action.summary === 'string' ? action.summary : undefined,
      });
    } catch (err) {
      channel.log('update_storyboard',
        `MediaLibrary index failed for ${filePath} (${err.message}); file still written.`);
    }

    // Affected-panel report — which sketches WILL re-render because of
    // this patch. Root fields feed every panel's prompt; scene fields
    // feed the scene's panels; an action edit also invalidates the
    // FOLLOWING shots of its scene (their continuity context quotes up
    // to the last 6 preceding actions).
    const drift = _editorialDiff(existing, normalized);
    let affectedPanels = [];
    // A REMOVE or a MOVE shifts every following panel's continuity context
    // (each prompt quotes the preceding actions), so the honest answer there
    // is "all of them". A pure INSERT only adds its own new panel — the
    // field-diff below can't see it, since it matches shots by id.
    const _structuralAll = removeShots.length > 0 || moveShots.length > 0;
    // Ids as actually inserted (the tool mints one when the caller omits it),
    // not as the caller wrote them.
    const _addedIds = _mintedShotIds;
    if (drift?.root?.length || _structuralAll) {
      affectedPanels = 'ALL';
    } else if (drift) {
      const affected = new Set();
      const changedByShot = new Map(
        (drift.shots || []).map((s) => {
          const m = /^([^(]+)\(([^)]*)\)$/.exec(s);
          return m ? [m[1], m[2].split(',')] : [s, []];
        }),
      );
      // Only these fields feed the sketch prompt — dialogue/sfx/music/
      // duration change the document but never the drawing, so they
      // don't count as re-renders.
      const rerenders = (f) =>
        ['shot', 'camera', 'movement', 'composition', 'lighting', 'action', 'continuity', 'state'].includes(f) ||
        f.startsWith('scene.');
      for (const sc of normalized.scenes) {
        const shots = sc.shots;
        for (let i = 0; i < shots.length; i++) {
          const fields = (changedByShot.get(shots[i].id) || []).filter(rerenders);
          if (!fields.length) continue;
          affected.add(shots[i].id);
          if (fields.includes('action')) {
            for (let j = i + 1; j < Math.min(shots.length, i + 7); j++) {
              affected.add(shots[j].id);
            }
          }
        }
      }
      affectedPanels = [...affected];
    }

    channel.log('update_storyboard',
      `patched ${filePath} (${drift ? `root[${(drift.root || []).join(',')}] shots[${(drift.shots || []).join(' ')}]` : 'no editorial change'}).`);

    return {
      success: true,
      path: filePath,
      id: normalized.id,
      ...(drift ? { editorialChanges: drift } : {}),
      // Newly inserted panels always render — fold them in (they cannot show
      // up in a field diff, which matches shots by id).
      affectedPanels: affectedPanels === 'ALL'
        ? 'ALL'
        : [...new Set([...(affectedPanels || []), ..._addedIds])],
      ...(_addedIds.length ? { addedShots: _addedIds } : {}),
      ...(removeShots.length ? { removedShots: [...removeShots] } : {}),
      note: affectedPanels === 'ALL'
        ? 'A root field changed — EVERY panel\'s sketch will re-render. If that was not intended, re-patch restoring the field verbatim.'
        : affectedPanels.length
          ? `These panels will re-render their sketch: ${affectedPanels.join(', ')}. Everything else is untouched.`
          : drift
            ? 'Fields changed, but none of them feed the sketches — no panel re-renders.'
            : 'No field changed — no panel re-renders.',
    };
  },
};
