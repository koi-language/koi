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
  'name', 'aspect', 'synopsis', 'characters', 'lighting', 'stylePrompt',
  'continuity', 'references', 'seed',
]);
const SCENE_FIELDS = new Set([
  'title', 'location', 'notes', 'synopsis', 'references',
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
    'Root set fields: name, aspect, synopsis, characters, lighting, stylePrompt, continuity (array of strings), references, seed. ' +
    'Scene set fields: title, location, notes, synopsis, references. ' +
    'Shot set fields: duration, shot (free text), camera (free text: movement + lens/focal + speed + focus; was `movement`), composition (free text), lighting (free text, per-shot), action, dialogue, sfx, music, continuity ({characters,objects,place}), noCutBefore, references. ' +
    'Set a field to null to remove it. ' +
    'NOT for structure: adding/removing/reordering scenes or shots, renumbering, or changing ids — use save_storyboard (full document) for those. ' +
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
        description: 'Scene-level patches: [{ id, set: { title?, location?, notes?, synopsis?, references? } }].',
        items: { type: 'object' },
      },
      shots: {
        type: 'array',
        description: 'Shot-level patches: [{ id, set: { duration?, shot?, camera?, composition?, lighting?, action?, dialogue?, sfx?, music?, continuity?, noCutBefore?, references? } }].',
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
    if (!hasRoot && !scenePatches.length && !shotPatches.length) {
      return _err('Empty patch: provide `set`, `scenes` or `shots` with the fields to change.');
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
    if (drift?.root?.length) {
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
      affectedPanels,
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
