/**
 * save_storyboard — write a storyboard document to
 * `<project>/storyboards/<id>.json` with structured args.
 *
 * Replaces the previous "build the full JSON in memory + write_file"
 * flow. The LLM passes the storyboard as an OBJECT (not a JSON
 * string), this tool validates it against the v7 schema, and
 * `JSON.stringify` does the serialization — so quote-escaping is no
 * longer the LLM's responsibility. That fixes the class of bugs where
 * a `dialogue: "..."líneas"..."` value breaks the file and the GUI
 * silently shows an empty storyboard.
 *
 * Behaviour:
 *   - New storyboard: writes the file, indexes in MediaLibrary.
 *   - Existing storyboard: same call, preserves `createdAt`, bumps
 *     `updatedAt`.
 *   - Validation failures return { success: false, error } with the
 *     exact field that's wrong, so the LLM can correct on the next
 *     turn instead of producing another broken file.
 *
 * Permission / UX: no diff card, no permission dialog. Storyboards
 * are app-managed artefacts (same model as timelines): the visor IS
 * the surface, the file write is internal. Pair with `show_result`
 * to open the new tab.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { channel } from '../../io/channel.js';
import { saveStoryboardEntry } from '../../state/media-library.js';

import { docDir } from '../../state/doc-root.js';
import { parseDocJson, stringifyDocJson } from '../../state/project-paths.js';
// TWO LAYERS per shot: `script` is the screenplay the user reads and edits
// (plain prose, no numbers); `action` + the cinematography fields are the
// hidden technical layer. `scriptOf` records which `script` that layer was
// written for: every agent write that sets `script` or `action` marks the
// shot in sync, so a user edit of `script` (GUI, straight to disk) leaves
// script !== scriptOf until the agent re-derives the technical layer.
export function markScriptSynced(sh) {
  if (typeof sh?.script === 'string' && sh.script.trim()) sh.scriptOf = sh.script;
  else delete sh?.scriptOf;
}

const _VALID_ASPECTS = new Set([
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9',
]);

// `shot` is FREE TEXT — there is no preset whitelist. Cinematography (which
// framing / angle / camera / composition / light each shot gets) is authored
// by `cinematic-video-prompt-engineer`, not chosen by the user from a menu.

const _KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

function _err(msg) { return { success: false, error: `save_storyboard: ${msg}` }; }

function _isStr(v) { return typeof v === 'string'; }
function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _validate(sb) {
  if (!_isObj(sb)) return 'storyboard must be an object with at least { id, name, scenes }.';

  if (!_isStr(sb.id) || !_KEBAB_RE.test(sb.id)) {
    return `"id" must be a kebab-case string (lowercase letters/digits/hyphens). Got ${JSON.stringify(sb.id)}.`;
  }
  if (!_isStr(sb.name) || !sb.name.trim()) {
    return '"name" must be a non-empty string.';
  }
  // `aspect` is NOT a storyboard property — the storyboard is FORMAT-AGNOSTIC
  // (one storyboard → videos in many formats; aspect/format is chosen ONLY at
  // video-generation time). NEVER require it. Accept it if present (validate),
  // but a missing aspect is fine and gets a neutral default on write.
  if (sb.aspect !== undefined && (!_isStr(sb.aspect) || !_VALID_ASPECTS.has(sb.aspect))) {
    return `"aspect" is OPTIONAL (omit it — aspect belongs to the VIDEO, not the storyboard). When provided it must be one of ${[..._VALID_ASPECTS].join(', ')}. Got ${JSON.stringify(sb.aspect)}.`;
  }
  if (sb.seed !== undefined && !Number.isInteger(sb.seed)) {
    return '"seed" (when provided) must be an integer.';
  }
  // `synopsis` is MANDATORY. It is the story PREMISE injected into EVERY shot's
  // image prompt so renders never contradict the story's logic. Models routinely
  // omit it when only instructed in prose, so it is enforced here: reject the save
  // and the agent (whose flow retries on success:false) is forced to author it.
  if (!_isStr(sb.synopsis) || !sb.synopsis.trim()) {
    return '"synopsis" is REQUIRED and must be a non-empty string: the story PREMISE/logic, in the user\'s language — who wants what, what is or isn\'t reachable, and why the ending lands (1–3 sentences). It is injected into EVERY shot\'s image prompt so the renders never contradict the story (e.g. "the Pepsi button is mounted high, out of reach — that is why he stacks cans to climb"). Author it from the storyboard you just built and call save_storyboard again. The ONLY exception is a bare, unconnected shot list with no narrative — extremely rare.';
  }
  for (const k of ['lighting', 'stylePrompt']) {
    if (sb[k] !== undefined && !_isStr(sb[k])) {
      return `"${k}" (when provided) must be a string. Got ${typeof sb[k]}.`;
    }
  }
  // `characters` is the recurring-cast ROSTER. Preferred shape is a structured
  // array of { name, description?, sex?, age?, characterId? } so the visor can
  // render each cast member as its own clickable row that opens a character
  // card, and so `sex`/`age` propagate to a `save_character` card when one is
  // created from a roster member. A legacy free-text roster STRING is still
  // accepted (old storyboards) and preserved verbatim — never parsed back.
  if (sb.characters !== undefined && !_isStr(sb.characters)) {
    if (!Array.isArray(sb.characters)) {
      return '"characters" (when provided) must be EITHER a free-text roster string OR an array of { name, description?, sex?, age?, characterId? } objects.';
    }
    for (let ci = 0; ci < sb.characters.length; ci++) {
      const c = sb.characters[ci];
      if (!_isObj(c)) return `characters[${ci}] must be an object { name, description?, sex?, age?, characterId? }.`;
      if (!_isStr(c.name) || !c.name.trim()) {
        return `characters[${ci}].name must be a non-empty string — the cast label/name (e.g. "MAESTRO").`;
      }
      for (const k of ['description', 'sex', 'characterId']) {
        if (c[k] !== undefined && !_isStr(c[k])) {
          return `characters[${ci}].${k} (when provided) must be a string.`;
        }
      }
      // `age` is a number (years) so it maps straight to a character card's `age`.
      if (c.age !== undefined && !(typeof c.age === 'number' && Number.isFinite(c.age))) {
        return `characters[${ci}].age (when provided) must be a number (years).`;
      }
    }
  }
  // `locations` is the reusable-SET roster (the location analog of the
  // `characters` cast): an ARRAY of { name, description?, locationId? } — one
  // entry per recurring set/place. `locationId` links a saved location card
  // `<project>/locations/<id>.json`. A scene then points at one via `scene.locationId`.
  if (sb.locations !== undefined && !_isStr(sb.locations)) {
    if (!Array.isArray(sb.locations)) {
      return '"locations" (when provided) must be an array of { name, description?, locationId? } objects.';
    }
    for (let li = 0; li < sb.locations.length; li++) {
      const l = sb.locations[li];
      if (!_isObj(l)) return `locations[${li}] must be an object { name, description?, locationId? }.`;
      if (!_isStr(l.name) || !l.name.trim()) {
        return `locations[${li}].name must be a non-empty string — the set label/name (e.g. "COMEDOR").`;
      }
      for (const k of ['description', 'locationType', 'timeOfDay', 'palette', 'lighting', 'locationId']) {
        if (l[k] !== undefined && !_isStr(l[k])) {
          return `locations[${li}].${k} (when provided) must be a string.`;
        }
      }
    }
  }
  // `objects` is the recurring-OBJECT roster (a car, a prop): an ARRAY of
  // { name, description?, image?, objectId? }. `objectId` links a saved object
  // card `<project>/objects/<id>.json`, whose `image` then is the roster image.
  if (sb.objects !== undefined && !_isStr(sb.objects)) {
    if (!Array.isArray(sb.objects)) {
      return '"objects" (when provided) must be an array of { name, description?, image?, objectId? } objects.';
    }
    for (let oi = 0; oi < sb.objects.length; oi++) {
      const o = sb.objects[oi];
      if (!_isObj(o)) return `objects[${oi}] must be an object { name, description?, image?, objectId? }.`;
      if (!_isStr(o.name) || !o.name.trim()) {
        return `objects[${oi}].name must be a non-empty string: the object's name (e.g. "MOTO").`;
      }
      for (const k of ['description', 'image', 'objectId']) {
        if (o[k] !== undefined && o[k] !== null && !_isStr(o[k])) {
          return `objects[${oi}].${k} (when provided) must be a string.`;
        }
      }
    }
  }
  // `continuity` is the CONTINUITY LOCK: a list of absolute, story-wide
  // invariants the renders must NEVER break or "fix" — the world-rules a
  // single shot's `action` can't carry (e.g. "the button stays mounted high,
  // out of the child's reach", "the cans used as a step must stay intact, never
  // crushed"). Injected verbatim into EVERY shot's image/video prompt as
  // hard constraints. Optional (a bare shot list has none) but each entry must
  // be a non-empty string.
  if (sb.continuity !== undefined) {
    if (!Array.isArray(sb.continuity) || sb.continuity.some((s) => !_isStr(s))) {
      return '"continuity" (when provided) must be an array of strings — the CONTINUITY LOCK rules: absolute story-wide invariants every panel must obey and never contradict (e.g. "The Pepsi button stays mounted high, above the child\'s reach", "Never make the child taller or lower the button", "The cans he stacks to climb must stay intact — never crushed"). Each rule is injected verbatim into every shot\'s render prompt.';
    }
  }
  if (sb.references !== undefined) {
    if (!Array.isArray(sb.references) || sb.references.some((s) => !_isStr(s))) {
      return '"references" (when provided) must be an array of strings (each entry is an `@handle` or absolute file path).';
    }
  }

  if (!Array.isArray(sb.scenes) || sb.scenes.length === 0) {
    return '"scenes" must be a non-empty array.';
  }
  for (let si = 0; si < sb.scenes.length; si++) {
    const sc = sb.scenes[si];
    if (!_isObj(sc)) return `scenes[${si}] must be an object.`;
    if (!_isStr(sc.id) || !_KEBAB_RE.test(sc.id)) {
      return `scenes[${si}].id must be a kebab-case string. Got ${JSON.stringify(sc.id)}.`;
    }
    if (!_isStr(sc.title)) return `scenes[${si}].title must be a string.`;
    // `location` = free-text place (display); `locationIds` = links to saved
    // location cards `<project>/locations/<id>.json` — a scene can play across
    // SEVERAL sets, so this is an ARRAY. (`locationId` singular is still
    // accepted as legacy and migrated into `locationIds`.)
    for (const k of ['notes', 'location', 'synopsis', 'locationId']) {
      if (sc[k] !== undefined && !_isStr(sc[k])) {
        return `scenes[${si}].${k} (when provided) must be a string. Got ${typeof sc[k]}.`;
      }
    }
    if (sc.locationIds !== undefined) {
      if (!Array.isArray(sc.locationIds) || sc.locationIds.some((s) => !_isStr(s))) {
        return `scenes[${si}].locationIds (when provided) must be an array of saved-location-card id strings.`;
      }
    }
    if (sc.references !== undefined) {
      if (!Array.isArray(sc.references) || sc.references.some((s) => !_isStr(s))) {
        return `scenes[${si}].references (when provided) must be an array of strings.`;
      }
    }
    if (!Array.isArray(sc.shots) || sc.shots.length === 0) {
      return `scenes[${si}].shots must be a non-empty array.`;
    }
    for (let hi = 0; hi < sc.shots.length; hi++) {
      const sh = sc.shots[hi];
      const tag = `scenes[${si}].shots[${hi}]`;
      if (!_isObj(sh)) return `${tag} must be an object.`;
      if (!_isStr(sh.id) || !_KEBAB_RE.test(sh.id)) {
        return `${tag}.id must be a kebab-case string. Got ${JSON.stringify(sh.id)}.`;
      }
      if (!Number.isInteger(sh.number) || sh.number < 1) {
        return `${tag}.number must be a positive integer (1-based, sequential across scenes).`;
      }
      if (!Number.isFinite(sh.duration) || sh.duration <= 0) {
        return `${tag}.duration must be a positive number (seconds, e.g. 3.0 — not "3s").`;
      }
      if (!_isStr(sh.shot)) return `${tag}.shot must be a string (e.g. "MCU low angle").`;
      // `shot` is FREE TEXT (framing: shot-size + angle). No preset whitelist:
      // cinematography (framing/angle/camera/composition/light) is authored by
      // `cinematic-video-prompt-engineer`, never picked by the user from a menu.
      if (!_isStr(sh.action)) return `${tag}.action must be a string.`;
      // v7 per-shot cinematography (all optional free text):
      //   `camera`      — camera work: movement + lens/focal + speed + focus.
      //                   (was `movement`; `movement` still accepted as a legacy
      //                   alias and migrated to `camera` on write.)
      //   `composition` — in-frame layout: lead room, thirds, depth, screen
      //                   position, screen-direction / 180-axis / eyeline.
      //   `lighting`    — light for THIS shot (refines the storyboard-level one).
      for (const k of ['camera', 'movement', 'composition', 'lighting', 'script', 'dialogue', 'sfx', 'music', 'location', 'notes', 'state']) {
        if (sh[k] !== undefined && !_isStr(sh[k])) {
          return `${tag}.${k} (when provided) must be a string.`;
        }
      }
      // `continuity` — the structured continuity-table cell for THIS shot:
      // { characters, objects, place }. Replaces the legacy free-text `state`
      // string (still accepted above and migrated on write). Each field
      // optional+string. `place` is WHERE this exact panel physically happens.
      if (sh.continuity !== undefined) {
        if (!_isObj(sh.continuity)) {
          return `${tag}.continuity (when provided) must be an object { characters, objects, place }.`;
        }
        for (const k of ['characters', 'objects', 'place']) {
          if (sh.continuity[k] !== undefined && !_isStr(sh.continuity[k])) {
            return `${tag}.continuity.${k} (when provided) must be a string.`;
          }
        }
      }
      if (sh.references !== undefined) {
        if (!Array.isArray(sh.references) || sh.references.some((s) => !_isStr(s))) {
          return `${tag}.references (when provided) must be an array of strings (each entry is an \`@handle\` or absolute file path).`;
        }
      }
      // `noCutBefore` (optional bool) — marks this shot as a CONTINUATION of the
      // previous one (one continuous take, no cut). Continuation shots SHARE the
      // previous shot's number rather than incrementing — see the cross-shot
      // numbering check below.
      if (sh.noCutBefore !== undefined && typeof sh.noCutBefore !== 'boolean') {
        return `${tag}.noCutBefore (when provided) must be a boolean.`;
      }
    }
  }

  // Cross-shot numbering. Normally numbers are sequential across the whole
  // storyboard (1,2,3…). A shot flagged `noCutBefore:true` is a continuation
  // of the previous take, so it does NOT consume a new number — it SHARES the
  // previous shot's number. The very first shot can never be a continuation.
  let n = 0;
  let first = true;
  for (const sc of sb.scenes) {
    for (const sh of sc.shots) {
      const cont = sh.noCutBefore === true;
      if (cont && first) {
        return `the FIRST shot cannot have noCutBefore:true — there is no previous shot to continue (scenes[${sb.scenes.indexOf(sc)}].shots[${sc.shots.indexOf(sh)}]).`;
      }
      const expected = cont ? n : ++n;
      if (sh.number !== expected) {
        return `shot numbers must be sequential across ALL scenes starting at 1, ` +
          `and a noCutBefore continuation must REPEAT the previous shot's number; ` +
          `expected ${expected} but got ${sh.number} at scenes[${sb.scenes.indexOf(sc)}].shots[${sc.shots.indexOf(sh)}].`;
      }
      first = false;
    }
  }
  return null;
}

// References live at three levels (storyboard root, scene, shot) and
// must survive the round-trip. Dropping them silently is the failure
// mode that causes "I attached refs but the sheet ignored them" — the
// rendering pipeline collects refs from all three levels, so losing
// any level means losing the user's intent.
// Image extensions the downstream renderer can use as a reference. `references`
// are IMAGE identity anchors that generate_image attaches to every panel — a
// video/audio path (e.g. the source clip a storyboard was based on) does NOT
// belong here: Sharp can't decode it and the panel render crashes. Agents
// sometimes drop the source video into references anyway, so strip non-image
// file paths at the single write choke point. `@handles` and bare attachment
// ids (no extension) are kept — they resolve to images downstream.
const _IMG_REF_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.heic', '.heif', '.avif',
]);

function _refIsUsable(s) {
  const ref = s.trim();
  if (ref.startsWith('@')) return true; // gallery handle
  const dot = ref.lastIndexOf('.');
  const slash = Math.max(ref.lastIndexOf('/'), ref.lastIndexOf('\\'));
  if (dot <= slash) return true; // no extension (e.g. attachment id) → keep
  const ext = ref.slice(dot).toLowerCase();
  return _IMG_REF_EXT.has(ext);
}

function _normRefs(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s) => typeof s === 'string' && s.trim() !== '' && _refIsUsable(s));
  return out.length > 0 ? out : undefined;
}

// Normalise a free-text string list (e.g. the `continuity` LOCK rules):
// trim each entry, drop empties, return undefined when nothing's left so the
// key is omitted rather than written as an empty array.
function _normStrList(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return out.length > 0 ? out : undefined;
}

// Editorial diff vs the previous on-disk doc — exact string compares on the
// fields the visor's render hash consumes. Surfaced in the save RESULT so an
// update that meant to touch one panel but silently re-worded others
// (round-trip drift) is caught immediately: every listed field re-renders
// that panel's sketch, and a root-field change re-renders the WHOLE board.
function _editorialDiff(existing, out) {
  if (!existing) return null;
  const sameJson = (a, b) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const root = [];
  for (const k of ['synopsis', 'lighting', 'stylePrompt']) {
    if ((existing[k] || '') !== (out[k] || '')) root.push(k);
  }
  // `characters` may be a string (legacy roster) or an array (structured cast).
  // Treat undefined / '' / [] as the same "no cast" so an old board doesn't
  // whole-board re-render on its first save under the new model.
  const _emptyCast = (x) =>
    x === undefined || x === '' || (Array.isArray(x) && x.length === 0);
  if (!(_emptyCast(existing.characters) && _emptyCast(out.characters)) &&
      !sameJson(existing.characters, out.characters)) {
    root.push('characters');
  }
  // Same empty-tolerant compare for the reusable-SET roster.
  if (!(_emptyCast(existing.locations) && _emptyCast(out.locations)) &&
      !sameJson(existing.locations, out.locations)) {
    root.push('locations');
  }
  if (!(_emptyCast(existing.objects) && _emptyCast(out.objects)) &&
      !sameJson(existing.objects, out.objects)) {
    root.push('objects');
  }
  if (!sameJson(existing.continuity, out.continuity)) root.push('continuity');
  const prevShotById = new Map();
  const prevSceneByShotId = new Map();
  if (Array.isArray(existing.scenes)) {
    for (const sc of existing.scenes) {
      for (const sh of (Array.isArray(sc?.shots) ? sc.shots : [])) {
        if (sh && _isStr(sh.id)) {
          prevShotById.set(sh.id, sh);
          prevSceneByShotId.set(sh.id, sc);
        }
      }
    }
  }
  const shots = [];
  for (const sc of out.scenes) {
    for (const sh of sc.shots) {
      const prev = prevShotById.get(sh.id);
      if (!prev) { shots.push(`${sh.id}(new)`); continue; }
      const fields = [];
      for (const k of ['shot', 'camera', 'composition', 'lighting', 'action', 'dialogue', 'sfx', 'music']) {
        if ((prev[k] || '') !== (sh[k] || '')) fields.push(k);
      }
      if (!sameJson(prev.continuity, sh.continuity)) fields.push('continuity');
      // Scene-level fields also feed every member shot's render prompt.
      const prevSc = prevSceneByShotId.get(sh.id);
      if (prevSc) {
        for (const k of ['location', 'notes', 'synopsis']) {
          if ((prevSc[k] || '') !== (sc[k] || '')) fields.push(`scene.${k}`);
        }
      }
      if (fields.length) shots.push(`${sh.id}(${fields.join(',')})`);
    }
  }
  if (!root.length && !shots.length) return null;
  return { root, shots };
}

// Shared with update-storyboard.js (the patch-based edit tool): same
// validation, same normalization, same editorial diff — one formula,
// two entry points.
export { _validate, _normalize, _editorialDiff, _isStr, _isObj };

// Normalize the recurring-cast roster. Preferred shape is a structured array
// of { name, description?, sex?, age?, characterId? }; a legacy free-text string
// is kept verbatim (old storyboards — never parsed). Anything else / absent → ''
// so the on-disk shape stays stable for boards that never authored a cast.
// `sex`/`age` are carried so they can seed a character card built from a member.
function _normCharacters(v) {
  if (Array.isArray(v)) {
    const out = [];
    for (const c of v) {
      if (!_isObj(c)) continue;
      const name = _isStr(c.name) ? c.name.trim() : '';
      if (!name) continue;
      const entry = { name };
      if (_isStr(c.description) && c.description.trim()) entry.description = c.description.trim();
      if (_isStr(c.sex) && c.sex.trim()) entry.sex = c.sex.trim();
      if (typeof c.age === 'number' && Number.isFinite(c.age)) entry.age = c.age;
      if (_isStr(c.characterId) && c.characterId.trim()) entry.characterId = c.characterId.trim();
      out.push(entry);
    }
    return out;
  }
  if (_isStr(v)) return v;
  return '';
}

// Normalize the reusable-SET roster: a structured array of
// { name, description?, locationType?, timeOfDay?, palette?, lighting?, locationId? }.
// The attributes are carried (like character sex/age) so they SEED the same
// fields on a location card built from a member. Absent → [] (omitted on write).
function _normLocations(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const l of v) {
    if (!_isObj(l)) continue;
    const name = _isStr(l.name) ? l.name.trim() : '';
    if (!name) continue;
    const entry = { name };
    if (_isStr(l.description) && l.description.trim()) entry.description = l.description.trim();
    for (const k of ['locationType', 'timeOfDay', 'palette', 'lighting']) {
      if (_isStr(l[k]) && l[k].trim()) entry[k] = l[k].trim();
    }
    if (_isStr(l.locationId) && l.locationId.trim()) entry.locationId = l.locationId.trim();
    out.push(entry);
  }
  return out;
}

function _normObjects(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const o of v) {
    if (!_isObj(o)) continue;
    const name = _isStr(o.name) ? o.name.trim() : '';
    if (!name) continue;
    const entry = { name };
    if (_isStr(o.description) && o.description.trim()) entry.description = o.description.trim();
    if (_isStr(o.image) && o.image.trim()) entry.image = o.image.trim();
    if (_isStr(o.objectId) && o.objectId.trim()) entry.objectId = o.objectId.trim();
    out.push(entry);
  }
  return out;
}

function _normalize(sb, existing) {
  // Carry forward the original createdAt across saves so the
  // MediaLibrary "Latest" ordering stays anchored to when the
  // storyboard was first authored, not when it was last touched.
  const now = new Date().toISOString();
  const createdAt =
    (existing && _isStr(existing.createdAt) && existing.createdAt) ||
    (_isStr(sb.createdAt) && sb.createdAt) ||
    now;
  // Seed pins character/palette continuity across every shot's image
  // render. If the agent omits it on an update we MUST keep the
  // existing seed — randomizing here would silently rerender every
  // shot with a different cast.
  const seed = Number.isInteger(sb.seed)
    ? sb.seed
    : (existing && Number.isInteger(existing.seed))
      ? existing.seed
      : Math.floor(Math.random() * 1_000_000_000);
  const rootRefs = _normRefs(sb.references);
  const continuity = _normStrList(sb.continuity);
  // Authoritative production totals, stamped on every save so any reader
  // (esp. the keyframes skill's chunking step) consumes ONE number
  // instead of re-summing per-shot durations by hand — which the agent gets
  // wrong: a 40 s storyboard (13 + 4.5 + 22.5) was mis-read as "20 s" and
  // chunked into 2 PART sheets instead of 3. Computed here, the single write
  // choke point, so it can never drift from the actual shots.
  let _shotCount = 0;
  let _totalDuration = 0;
  for (const sc of sb.scenes) {
    for (const sh of sc.shots) {
      _shotCount += 1;
      if (Number.isFinite(sh.duration)) _totalDuration += sh.duration;
    }
  }
  // GUI-private per-shot fields (underscore-prefixed, e.g. `_regenerateNonce`,
  // which pins a shot's REGENERATED sketch in the visor's render cache) are
  // not part of the agent's call shape, so they never arrive in `sb`. Carry
  // them forward from the on-disk doc by shot id — without this, every agent
  // re-save strips them and reopening the storyboard falls back to each
  // panel's FIRST rendered sketch.
  const _existingShotById = new Map();
  if (existing && Array.isArray(existing.scenes)) {
    for (const sc of existing.scenes) {
      if (!Array.isArray(sc?.shots)) continue;
      for (const sh of sc.shots) {
        if (sh && _isStr(sh.id)) _existingShotById.set(sh.id, sh);
      }
    }
  }
  const out = {
    id: sb.id,
    name: sb.name.trim(),
    version: 1,
    createdAt,
    updatedAt: now,
    // Storyboard is format-agnostic; `aspect` is only the neutral reading
    // surface for the pencil-sketch panels (the VIDEO format is chosen later).
    // Never authored by the agent — default it silently when absent.
    aspect: _VALID_ASPECTS.has(sb.aspect) ? sb.aspect : '16:9',
    shotCount: _shotCount,
    totalDurationSeconds: Math.round(_totalDuration * 10) / 10,
    seed,
    // `synopsis` is validated as required+non-empty above, so it's always a
    // real string here. Persisted so the GUI/compositor can inject it as the
    // STORY PREMISE into every shot prompt — dropping it here was the bug that
    // made renders contradict the story even though the agent authored it.
    synopsis: sb.synopsis.trim(),
    characters: _normCharacters(sb.characters),
    lighting: _isStr(sb.lighting) ? sb.lighting : '',
    // Reusable-SET roster (the location analog of `characters`). Omitted when
    // empty so boards that never authored sets keep a stable on-disk shape.
    ...(function () {
      const locs = _normLocations(sb.locations);
      return locs.length ? { locations: locs } : {};
    })(),
    // Recurring objects (a car, a prop). Omitted when empty, like `locations`.
    ...(function () {
      const objects = _normObjects(sb.objects);
      return objects.length ? { objects } : {};
    })(),
    stylePrompt: _isStr(sb.stylePrompt) ? sb.stylePrompt : '',
    scenes: sb.scenes.map((sc) => {
      const sceneRefs = _normRefs(sc.references);
      const sceneOut = {
        id: sc.id,
        title: sc.title,
        location: _isStr(sc.location) ? sc.location : '',
        // Links to the location cards this scene plays in — a scene can span
        // SEVERAL sets, so an ARRAY. Accept a legacy singular `locationId` and
        // fold it in. Kept only when non-empty; `location` (free text) stays.
        ...(function () {
          const ids = [];
          if (Array.isArray(sc.locationIds)) {
            for (const x of sc.locationIds) if (_isStr(x) && x.trim()) ids.push(x.trim());
          }
          if (_isStr(sc.locationId) && sc.locationId.trim() && !ids.includes(sc.locationId.trim())) {
            ids.push(sc.locationId.trim());
          }
          const uniq = [...new Set(ids)];
          return uniq.length ? { locationIds: uniq } : {};
        })(),
        notes: _isStr(sc.notes) ? sc.notes : '',
        shots: sc.shots.map((sh) => {
          const shotOut = {
            id: sh.id,
            number: sh.number,
            duration: sh.duration,
            shot: sh.shot,
            // v7: `camera` (was `movement`) — accept the legacy `movement`
            // alias and migrate it to `camera` on write so old storyboards
            // round-trip without losing their camera note.
            camera: _isStr(sh.camera) ? sh.camera : (_isStr(sh.movement) ? sh.movement : ''),
            action: sh.action,
          };
          // v7 per-shot cinematography (persist only when non-empty):
          //   composition — in-frame layout + screen direction / 180 / eyeline.
          //   lighting    — light for THIS shot (refines the storyboard-level one).
          for (const k of ['composition', 'lighting', 'script', 'dialogue', 'sfx', 'music']) {
            if (_isStr(sh[k]) && sh[k].trim()) shotOut[k] = sh[k];
          }
          // `scriptOf` (see markScriptSynced): a shot whose script AND action
          // are both unchanged vs disk keeps its sync state (a restructure must
          // not hide a pending user edit); any other write is in sync.
          const _was = _existingShotById.get(sh.id);
          if (_was && _was.script === shotOut.script && _was.action === shotOut.action && _isStr(_was.scriptOf)) {
            shotOut.scriptOf = _was.scriptOf;
          } else {
            markScriptSynced(shotOut);
          }
          // Continuity-table cell: { characters, objects, place }. Structured
          // form of the old per-panel `state`. Migrate a legacy `state` string
          // into `characters` when no structured continuity was supplied, so old
          // storyboards round-trip into the new model without losing the row.
          const cont = {};
          if (_isObj(sh.continuity)) {
            if (_isStr(sh.continuity.characters) && sh.continuity.characters.trim()) {
              cont.characters = sh.continuity.characters.trim();
            }
            if (_isStr(sh.continuity.objects) && sh.continuity.objects.trim()) {
              cont.objects = sh.continuity.objects.trim();
            }
            if (_isStr(sh.continuity.place) && sh.continuity.place.trim()) {
              cont.place = sh.continuity.place.trim();
            }
          }
          if (!cont.characters && !cont.objects && !cont.place && _isStr(sh.state) && sh.state.trim()) {
            cont.characters = sh.state.trim();
          }
          if (cont.characters || cont.objects || cont.place) shotOut.continuity = cont;
          // Continuation flag — only persisted when true (a continuous take
          // with the previous shot, no cut). Omitted = normal cut.
          if (sh.noCutBefore === true) shotOut.noCutBefore = true;
          const shotRefs = _normRefs(sh.references);
          if (shotRefs) shotOut.references = shotRefs;
          // Underscore carry-forward (see _existingShotById above). Incoming
          // values first (a get→save round-trip may echo them), then disk
          // wins: the GUI is the only writer of these and disk is freshest.
          for (const k of Object.keys(sh)) {
            if (k.startsWith('_')) shotOut[k] = sh[k];
          }
          const _prev = _existingShotById.get(sh.id);
          if (_prev) {
            for (const k of Object.keys(_prev)) {
              if (k.startsWith('_')) shotOut[k] = _prev[k];
            }
          }
          return shotOut;
        }),
      };
      // SCENE-level synopsis — the per-scene premise, same role as the root
      // synopsis scoped to this scene. Was also being dropped on write.
      if (_isStr(sc.synopsis) && sc.synopsis.trim()) {
        sceneOut.synopsis = sc.synopsis.trim();
      }
      if (sceneRefs) sceneOut.references = sceneRefs;
      return sceneOut;
    }),
  };
  if (continuity) out.continuity = continuity;
  if (rootRefs) out.references = rootRefs;
  return out;
}

export default {
  type: 'save_storyboard',
  intent: 'save_storyboard',
  description:
    'Write a storyboard document to <project>/storyboards/<id>.json with STRUCTURED args (the storyboard as an OBJECT, not a JSON string). ' +
    'Use to CREATE a storyboard, or to RESTRUCTURE an existing one (add/remove/reorder scenes or shots, renumber, change ids) — same call shape; the tool detects new-vs-existing and preserves createdAt. For CONTENT edits (changing field values on existing scenes/shots or root fields) use update_storyboard instead — it patches only what changed, so it never rewrites the whole document or re-renders untouched panels. ' +
    'Call shape: { storyboard: { id, name, synopsis, continuity?, seed?, characters?, locations?, objects?, lighting?, stylePrompt?, references?, scenes: [{ id, title, location?, locationIds?, notes?, synopsis?, references?, shots: [{ id, number, duration, shot, camera, action, script, composition?, lighting?, noCutBefore?, continuity?, dialogue?, sfx?, music?, references? }] }] } }. ' +
    'Required: storyboard.id (kebab-case slug, MUST match the on-disk filename), storyboard.name, storyboard.synopsis (the story PREMISE/logic in the user\'s language, 1–3 sentences — who wants what, what is/ isn\'t reachable, why the ending lands; injected into EVERY shot image prompt so renders never contradict the story; the save is REJECTED if empty), storyboard.scenes (non-empty array). ' +
    'DO NOT author storyboard.aspect: the storyboard is FORMAT-AGNOSTIC — one storyboard becomes videos in MANY formats, and aspect/format is chosen ONLY at video-generation time. It is optional and defaults silently; never ask the user about format at storyboard time. ' +
    'storyboard.continuity is an OPTIONAL (strongly recommended for any narrative with physical/spatial logic) array of strings — the CONTINUITY LOCK: absolute, story-wide invariants every panel must obey and never contradict or "fix" (e.g. ["The Pepsi button stays mounted high, above the child\'s reach until he climbs", "Never make the child taller or lower the button", "The cans he stacks as a step stay intact — never crushed"]). Injected verbatim into EVERY shot\'s render prompt as hard constraints; this is how you stop the renderer from silently making the unreachable reachable or breaking an object that must stay whole. ' +
    'Each scene needs id (kebab-case), title, shots (non-empty). TWO LAYERS per shot: `script` is the SCREENPLAY the user reads and edits in the Script view (what happens, in screenplay prose: present tense, the beat and the emotion, NO measurements, speeds, seconds, lenses, camera talk, screen positions or physics numbers); `action` + shot/camera/composition/lighting are the TECHNICAL layer, hidden from the user, where every precise detail lives. Always write both. Each shot needs id (kebab-case), number (1-based integer, sequential across ALL scenes — EXCEPT a continuation shot, which REPEATS the previous shot\'s number; see noCutBefore), duration (number of seconds, e.g. 3.0 — not "3s"), shot (FREE TEXT: framing = shot-size + angle, e.g. "MCU low angle"), camera (FREE TEXT: camera work — movement + lens/focal + speed + focus, e.g. "Dolly in, 50mm, slow push"), action. shot.noCutBefore is an OPTIONAL boolean: when true this shot is a CONTINUATION of the previous one — one continuous take, the camera keeps moving and there is NO cut between them. A continuation shares the previous shot\'s number (do not increment) and the video pipeline renders the glued shots as a SINGLE clip; NEVER set it on the first shot. Use it to author a longer moving shot as several precise sub-takes (more descriptive than one vague panel). Legacy: shot.continuity { characters, objects, place } and shot.state are still accepted on old stories; do NOT write them on new ones: non-default state goes in action, positions come from the 3D. composition (in-frame layout: lead room, thirds, depth, screen position, screen-direction / 180-axis / eyeline) and lighting (light for THIS shot, refining the storyboard-level lighting) are OPTIONAL free-text strings — the cinematography (shot/camera/composition/lighting) is authored by cinematic-video-prompt-engineer, never picked from a menu. dialogue/sfx/music are optional strings. ' +
    'storyboard.characters is the OPTIONAL recurring-cast ROSTER. Prefer the STRUCTURED array shape: [{ name, description?, sex?, age?, characterId? }] — one entry per recurring character, name = the SHORT_UPPERCASE label reused verbatim in shot action/dialogue (e.g. "MAESTRO"), description = a one-line silhouette/wardrobe note (no faces), sex = canonical string (female|male|nonbinary|other), age = number (years), characterId = the id of a saved character document (<project>/characters/<id>.json) when this cast member is backed by one, so the visor can open its card. FILL sex + age whenever the story tells you them — they seed the same fields on a character card created from this member. The visor renders each entry as a clickable row. A legacy free-text roster string is still accepted and preserved verbatim (never parsed), but new/edited storyboards should emit the array. ' +
    'storyboard.objects is the OPTIONAL roster of recurring objects (a car, a prop): [{ name, description?, image?, objectId? }]. objectId links a saved object card (<project>/objects/<id>.json, made with save_object + generate_object_sheet; activate the `objects` skill), whose views are then the object\'s references and whose `image` is the roster image; image = absolute path of its reference image (legacy, for an object without a card). ' +
    'storyboard.locations is the OPTIONAL reusable-SET roster (the location analog of the cast): [{ name, description?, locationType?, timeOfDay?, palette?, lighting?, locationId? }] — one entry per recurring set/place, name = a SHORT label (e.g. "COMEDOR"), description = a one-line look of the set. FILL locationType (interior|exterior|mixed), timeOfDay, palette and lighting whenever the story tells you them — they SEED the same fields on a location card built from this member (just like sex/age seed a character card). locationId = the id of a saved location card (<project>/locations/<id>.json). Each scene may point at ONE OR MORE via scene.locationIds (an ARRAY — a scene can play across several sets), in addition to the free-text scene.location. (A legacy singular scene.locationId is still accepted and folded into locationIds.) A scene = its characters + its location(s); both are reusable identity anchors (a character has a turnaround sheet, a location has an establishing plate). ' +
    'references is an OPTIONAL array of strings (each entry is an `@handle` or absolute file path) that can sit at the storyboard root, on a scene, or on a single shot — the downstream visual renderer collects all three levels per panel. Preserve whatever references the agent passes (or the user added via the visor); never drop them on a round-trip read→mutate→save. ' +
    'Auto-set by the tool: version=1, updatedAt=now (UTC ISO), createdAt preserved from existing file or set to now, seed defaulted to a random integer when omitted. ' +
    'Returns: { success, path, id, created: bool } on success, or { success: false, error } with the exact invalid field on validation failure.',
  instructions:
    'save_storyboard REPLACES write_file for <project>/storyboards/*.json — never hand-serialize the JSON via write_file (quote escaping is a structural minefield; this tool sidesteps it by accepting the object directly). ' +
    'SCOPE: use save_storyboard to CREATE a storyboard or to RESTRUCTURE one (add/remove/reorder scenes or shots, renumber, change ids). For CONTENT edits — changing field values on existing scenes/shots or root fields — use update_storyboard instead: it patches only the named fields, so it is faster and cannot accidentally re-word (and thus re-render) untouched panels. ' +
    'Restructure flow: read_file the existing JSON, mutate the parsed object in memory, then save_storyboard with the whole mutated object. The tool detects the file exists and preserves createdAt. ' +
    'VERBATIM RULE (critical): on an UPDATE, every field you are NOT deliberately changing must be sent back CHARACTER-FOR-CHARACTER as read — never re-word, re-translate, abbreviate/expand, or "tidy" it (e.g. do not turn "Wide shot, eye level" into "Wide shot"). The visor re-renders a panel\'s sketch whenever ANY of its editorial fields (shot / camera / composition / lighting / action / continuity / scene fields) changes, and re-renders EVERY panel when a root field (synopsis / characters / lighting / continuity / stylePrompt) changes — so accidental re-wording of untouched fields nukes the user\'s reviewed sketches and re-renders the whole board. The save result reports exactly which fields changed vs the previous save: verify that list matches your INTENDED edit, and if it lists anything you did not mean to touch, re-save restoring those fields verbatim. ' +
    'After a CREATE, call show_result with resourceType "file" and the returned path so the GUI opens the storyboard tab. After an UPDATE, the visor picks up the change automatically — no show_result needed.',
  thinkingHint: (action) => `Saving storyboard ${action?.storyboard?.id || ''}`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      storyboard: {
        type: 'object',
        description: 'Full storyboard object (v7 schema). See description for required fields.',
      },
      allowFullRewrite: {
        type: 'boolean',
        description: 'OPTIONAL escape hatch. A CONTENT-only save (structure unchanged) is REJECTED and must be re-sent as an `update_storyboard` patch — a full document costs ~10x the payload and makes every panel a re-render candidate. Set true ONLY for a genuine mass rewrite touching most of the document.',
      },
      summary: { type: 'string', description: 'OPTIONAL. One-line "what is this storyboard for" — pinned to this session\'s creations ledger so you can later list / recall it via `recall_creations` without searching the filesystem. Examples: "Duelo bajo la Tormenta — full storyboard", "Product demo intro storyboard, vertical 9:16". Keep it short and self-evident; the agent is the one who will read it back later. Only attached on the FIRST save of a given storyboard id; subsequent edits do not overwrite it. When omitted, the ledger falls back to the storyboard\'s description.' },
    },
    required: ['storyboard'],
  },

  async execute(action, agent) {
    const sb = action?.storyboard;
    if (!_isObj(sb)) {
      return _err('"storyboard" is required and must be an object. ' +
        'Call shape: { intent: "save_storyboard", storyboard: { id, name, scenes: [...] } }.');
    }

    const validationError = _validate(sb);
    if (validationError) return _err(validationError);

    const home = process.env.HOME || os.homedir();
    const dir = path.join(docDir('storyboards'));
    let filePath = path.join(dir, `${sb.id}.json`);

    // Read the file currently at this id FIRST, so create-vs-update is decided
    // from real content (not just a flag), and so createdAt is preserved.
    const _collectIds = (doc) => {
      const ids = new Set();
      if (Array.isArray(doc?.scenes)) {
        for (const sc of doc.scenes) {
          if (_isStr(sc?.id)) ids.add('sc:' + sc.id);
          if (Array.isArray(sc?.shots)) {
            for (const sh of sc.shots) if (_isStr(sh?.id)) ids.add('sh:' + sh.id);
          }
        }
      }
      return ids;
    };
    const _sharesAnyId = (a, b) => {
      const A = _collectIds(a);
      for (const id of _collectIds(b)) if (A.has(id)) return true;
      return false;
    };

    let existing = null;
    let existed = false;
    try {
      if (fs.existsSync(filePath)) {
        existed = true;
        const raw = fs.readFileSync(filePath, 'utf8');
        try { existing = parseDocJson(raw, filePath); } catch { /* corrupted prior file — overwrite */ }
      }
    } catch { /* ignore — fall through to write */ }

    // CREATE-vs-UPDATE collision guard. The normal, wanted case is "iterate MY
    // storyboard": the agent saves under the SAME id to UPDATE it in place. We
    // treat a save as the SAME storyboard (→ overwrite, preserve createdAt)
    // whenever ANY of these hold: it carried `createdAt` (a read-modify-save),
    // it shares a scene/shot id with the on-disk doc, or its name is unchanged.
    // (The old guard keyed ONLY on createdAt, so a modify that rebuilt the
    // object without it forked into a DUPLICATE storyboard — the reported bug.)
    // ONLY when a file exists at this id AND none of those hold (a genuinely
    // DIFFERENT storyboard whose name coincidentally slugged to a taken id) do
    // we auto-uniquify, so we never silently clobber an unrelated storyboard.
    // ── CONTENT-ONLY REWRITE GUARD ────────────────────────────────────
    // A content edit must go through `update_storyboard` (a patch), not
    // through a full re-send of the document. This is not a style
    // preference: a full save re-emits the WHOLE storyboard token by token
    // — measured at 26k–37k characters on a 16-shot piece, versus 0.2k–4k
    // for the equivalent patch. That generation time IS the "cambiar el
    // guion tarda muchísimo" the user reports, and prose the model retypes
    // is prose it can silently reword.
    //
    // So: when the document already exists and this save changes NOTHING
    // STRUCTURAL (same scenes, same shots, same ids, same order), refuse
    // and hand back the exact patch to send instead. Structural edits
    // (add/remove/reorder/renumber) still belong here and pass through.
    if (existing && action?.allowFullRewrite !== true) {
      const _structure = (doc) => (Array.isArray(doc?.scenes) ? doc.scenes : [])
        .map((sc) => `${sc?.id}:${(Array.isArray(sc?.shots) ? sc.shots : [])
          .map((sh) => sh?.id).join(',')}`)
        .join('|');
      if (_structure(existing) === _structure(sb)) {
        const changed = [];
        const _diffFields = (a, b, label) => {
          const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
          for (const k of keys) {
            if (k === 'scenes' || k === 'updatedAt' || k === 'version') continue;
            const av = JSON.stringify(a?.[k] ?? null);
            const bv = JSON.stringify(b?.[k] ?? null);
            if (av !== bv) changed.push(`${label}${k}`);
          }
        };
        _diffFields(existing, sb, '');
        const _byId = (doc) => {
          const sc = new Map(); const sh = new Map();
          for (const s0 of (Array.isArray(doc?.scenes) ? doc.scenes : [])) {
            sc.set(s0?.id, s0);
            for (const s1 of (Array.isArray(s0?.shots) ? s0.shots : [])) sh.set(s1?.id, s1);
          }
          return { sc, sh };
        };
        const A = _byId(existing); const B = _byId(sb);
        for (const [id, s1] of B.sc) {
          const a1 = A.sc.get(id) || {};
          const keys = new Set([...Object.keys(a1), ...Object.keys(s1 || {})]);
          for (const k of keys) {
            if (k === 'shots') continue;
            if (JSON.stringify(a1?.[k] ?? null) !== JSON.stringify(s1?.[k] ?? null)) {
              changed.push(`scene ${id}.${k}`);
            }
          }
        }
        for (const [id, s1] of B.sh) {
          const a1 = A.sh.get(id) || {};
          const keys = new Set([...Object.keys(a1), ...Object.keys(s1 || {})]);
          for (const k of keys) {
            if (JSON.stringify(a1?.[k] ?? null) !== JSON.stringify(s1?.[k] ?? null)) {
              changed.push(`shot ${id}.${k}`);
            }
          }
        }
        if (changed.length === 0) {
          return {
            success: true,
            path: filePath,
            id: sb.id,
            unchanged: true,
            message: 'No change: the document you sent is byte-identical to the one on disk. Nothing was written and no panel re-rendered.',
          };
        }
        const list = changed.slice(0, 40).join(', ')
          + (changed.length > 40 ? `, …(+${changed.length - 40} more)` : '');
        return _err(
          'CONTENT-ONLY edit sent as a full document. Nothing was written. '
          + 'Re-send it as a PATCH with `update_storyboard` — same result, a fraction of the payload, '
          + 'and only the touched panels re-render.\n'
          + `Fields that actually changed (${changed.length}): ${list}\n`
          + 'Call shape: update_storyboard { id: "' + sb.id + '", set?: {…root fields…}, '
          + 'scenes?: [{ id, set: {…} }], shots?: [{ id, set: {…} }] } — send ONLY those fields.\n'
          + 'This guard only fires when the STRUCTURE is unchanged (same scenes, same shots, same ids, same order); '
          + 'adding, removing, reordering or renumbering still belongs to save_storyboard. '
          + 'For a genuine mass rewrite touching most of the document, pass `allowFullRewrite: true`.',
        );
      }
    }

    const isUpdateIntent = _isStr(sb.createdAt) && !!sb.createdAt.trim();
    const _sameStoryboard = existing != null && (
      isUpdateIntent ||
      (_isStr(existing.name) && _isStr(sb.name) && existing.name === sb.name) ||
      _sharesAnyId(existing, sb)
    );
    let collisionRenamedFrom = null;
    if (existed && !_sameStoryboard) {
      const baseId = sb.id;
      let n = 2;
      let candidateId = `${baseId}-${n}`;
      while (fs.existsSync(path.join(dir, `${candidateId}.json`)) && n < 1000) {
        n += 1;
        candidateId = `${baseId}-${n}`;
      }
      collisionRenamedFrom = baseId;
      sb.id = candidateId;
      filePath = path.join(dir, `${sb.id}.json`);
      existing = null;
      existed = false;
    }

    const normalized = _normalize(sb, existing);
    const serialized = stringifyDocJson(normalized, filePath) + '\n';

    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write via a sibling tmp file + rename so the GUI's
      // file-watcher (StoryboardLibrary) never observes a
      // half-written / truncated JSON document.
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return _err(`failed to write ${filePath}: ${err.message}`);
    }

    // Index in MediaLibrary so the storyboard shows in the drawer at
    // its real authored date. Best-effort: a DB hiccup must not lose
    // the file write. The optional `summary` only lands on the FIRST
    // save (subsequent edits hit the wasReplacement gate inside
    // MediaLibrary.save and skip the ledger append).
    try {
      await saveStoryboardEntry(filePath, normalized, agent?.llmProvider, {
        summary: typeof action.summary === 'string' ? action.summary : undefined,
      });
    } catch (err) {
      channel.log('save_storyboard',
        `MediaLibrary index failed for ${filePath} (${err.message}); file still written.`);
    }

    const sceneCount = normalized.scenes.length;
    let shotCount = 0;
    for (const sc of normalized.scenes) shotCount += sc.shots.length;
    channel.log('save_storyboard',
      `${existed ? 'updated' : 'created'} ${filePath} ` +
      `(${sceneCount} scene${sceneCount === 1 ? '' : 's'}, ` +
      `${shotCount} shot${shotCount === 1 ? '' : 's'})` +
      `${collisionRenamedFrom ? ` [id "${collisionRenamedFrom}" was taken → saved as "${normalized.id}" to avoid overwriting it]` : ''}.`);

    const drift = _editorialDiff(existing, normalized);
    // The 3D previz is part of the storyboard: flag stale cards and tell the
    // agent which shots still need (re)blocking. Never fails the save.
    let previz3d = null;
    try {
      const { refreshPrevizFlags, previzDirective } = await import('../scene3d/_previz-sync.js');
      previz3d = previzDirective(refreshPrevizFlags(normalized.id, { markPending: true }));
    } catch { /* previz is advisory here */ }
    return {
      ...(previz3d ? { previz3d } : {}),
      success: true,
      path: filePath,
      id: normalized.id,
      created: !existed,
      sceneCount,
      shotCount,
      ...(drift
        ? { editorialChanges: {
              ...(drift.root.length ? { root: drift.root } : {}),
              ...(drift.shots.length ? { shots: drift.shots } : {}),
              note: 'Every field listed here changed vs the previous save and WILL re-render that panel\'s sketch (root fields re-render EVERY panel). If this list contains fields you did not INTEND to edit, you re-worded them on the round-trip — re-save restoring those fields verbatim from the previous content BEFORE the visor re-renders.' } }
        : {}),
      ...(collisionRenamedFrom
        ? { renamedFrom: collisionRenamedFrom,
            note: `The id "${collisionRenamedFrom}" already existed, so this NEW storyboard was saved as "${normalized.id}" to avoid overwriting the existing one. Use this id from now on.` }
        : {}),
    };
  },
};
