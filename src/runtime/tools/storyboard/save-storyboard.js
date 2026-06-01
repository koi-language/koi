/**
 * save_storyboard — write a storyboard document to
 * `~/.koi/storyboards/<id>.json` with structured args.
 *
 * Replaces the previous "build the full JSON in memory + write_file"
 * flow. The LLM passes the storyboard as an OBJECT (not a JSON
 * string), this tool validates it against the v6 schema, and
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

const _VALID_ASPECTS = new Set([
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9',
]);

const _KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

function _err(msg) { return { success: false, error: `save_storyboard: ${msg}` }; }

function _isStr(v) { return typeof v === 'string'; }
function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _validate(sb) {
  if (!_isObj(sb)) return 'storyboard must be an object with at least { id, name, aspect, scenes }.';

  if (!_isStr(sb.id) || !_KEBAB_RE.test(sb.id)) {
    return `"id" must be a kebab-case string (lowercase letters/digits/hyphens). Got ${JSON.stringify(sb.id)}.`;
  }
  if (!_isStr(sb.name) || !sb.name.trim()) {
    return '"name" must be a non-empty string.';
  }
  if (!_isStr(sb.aspect) || !_VALID_ASPECTS.has(sb.aspect)) {
    return `"aspect" must be one of ${[..._VALID_ASPECTS].join(', ')}. Got ${JSON.stringify(sb.aspect)}.`;
  }
  if (sb.seed !== undefined && !Number.isInteger(sb.seed)) {
    return '"seed" (when provided) must be an integer.';
  }
  for (const k of ['characters', 'lighting', 'stylePrompt']) {
    if (sb[k] !== undefined && !_isStr(sb[k])) {
      return `"${k}" (when provided) must be a string. Got ${typeof sb[k]}.`;
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
      if (!_isStr(sh.movement)) return `${tag}.movement must be a string (e.g. "Static", "Dolly in").`;
      if (!_isStr(sh.action)) return `${tag}.action must be a string.`;
      for (const k of ['dialogue', 'sfx', 'music', 'location', 'notes']) {
        if (sh[k] !== undefined && !_isStr(sh[k])) {
          return `${tag}.${k} (when provided) must be a string.`;
        }
      }
      if (sh.references !== undefined) {
        if (!Array.isArray(sh.references) || sh.references.some((s) => !_isStr(s))) {
          return `${tag}.references (when provided) must be an array of strings (each entry is an \`@handle\` or absolute file path).`;
        }
      }
    }
  }

  // Cross-shot: numbers should be sequential across the whole storyboard.
  let expected = 1;
  for (const sc of sb.scenes) {
    for (const sh of sc.shots) {
      if (sh.number !== expected) {
        return `shot numbers must be sequential across ALL scenes starting at 1; ` +
          `expected ${expected} but got ${sh.number} at scenes[${sb.scenes.indexOf(sc)}].shots[${sc.shots.indexOf(sh)}].`;
      }
      expected++;
    }
  }
  return null;
}

// References live at three levels (storyboard root, scene, shot) and
// must survive the round-trip. Dropping them silently is the failure
// mode that causes "I attached refs but the sheet ignored them" — the
// rendering pipeline collects refs from all three levels, so losing
// any level means losing the user's intent.
function _normRefs(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s) => typeof s === 'string' && s.trim() !== '');
  return out.length > 0 ? out : undefined;
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
  const out = {
    id: sb.id,
    name: sb.name.trim(),
    version: 1,
    createdAt,
    updatedAt: now,
    aspect: sb.aspect,
    seed,
    characters: _isStr(sb.characters) ? sb.characters : '',
    lighting: _isStr(sb.lighting) ? sb.lighting : '',
    stylePrompt: _isStr(sb.stylePrompt) ? sb.stylePrompt : '',
    scenes: sb.scenes.map((sc) => {
      const sceneRefs = _normRefs(sc.references);
      const sceneOut = {
        id: sc.id,
        title: sc.title,
        location: _isStr(sc.location) ? sc.location : '',
        notes: _isStr(sc.notes) ? sc.notes : '',
        shots: sc.shots.map((sh) => {
          const shotOut = {
            id: sh.id,
            number: sh.number,
            duration: sh.duration,
            shot: sh.shot,
            movement: sh.movement,
            action: sh.action,
          };
          for (const k of ['dialogue', 'sfx', 'music']) {
            if (_isStr(sh[k])) shotOut[k] = sh[k];
          }
          const shotRefs = _normRefs(sh.references);
          if (shotRefs) shotOut.references = shotRefs;
          return shotOut;
        }),
      };
      if (sceneRefs) sceneOut.references = sceneRefs;
      return sceneOut;
    }),
  };
  if (rootRefs) out.references = rootRefs;
  return out;
}

export default {
  type: 'save_storyboard',
  intent: 'save_storyboard',
  description:
    'Write a storyboard document to ~/.koi/storyboards/<id>.json with STRUCTURED args (the storyboard as an OBJECT, not a JSON string). ' +
    'Use for BOTH creating new storyboards and updating existing ones — same call shape; the tool detects which one and preserves createdAt across edits. ' +
    'Call shape: { storyboard: { id, name, aspect, seed?, characters?, lighting?, stylePrompt?, references?, scenes: [{ id, title, location?, notes?, references?, shots: [{ id, number, duration, shot, movement, action, dialogue?, sfx?, music?, references? }] }] } }. ' +
    'Required: storyboard.id (kebab-case slug, MUST match the on-disk filename), storyboard.name, storyboard.aspect (one of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9), storyboard.scenes (non-empty array). ' +
    'Each scene needs id (kebab-case), title, shots (non-empty). Each shot needs id (kebab-case), number (1-based integer, MUST be sequential across ALL scenes), duration (number of seconds, e.g. 3.0 — not "3s"), shot (e.g. "MCU low angle"), movement (e.g. "Static" / "Dolly in"), action. dialogue/sfx/music are optional strings. ' +
    'references is an OPTIONAL array of strings (each entry is an `@handle` or absolute file path) that can sit at the storyboard root, on a scene, or on a single shot — the downstream visual renderer collects all three levels per panel. Preserve whatever references the agent passes (or the user added via the visor); never drop them on a round-trip read→mutate→save. ' +
    'Auto-set by the tool: version=1, updatedAt=now (UTC ISO), createdAt preserved from existing file or set to now, seed defaulted to a random integer when omitted. ' +
    'Returns: { success, path, id, created: bool } on success, or { success: false, error } with the exact invalid field on validation failure.',
  instructions:
    'save_storyboard REPLACES write_file for ~/.koi/storyboards/*.json — never hand-serialize the JSON via write_file (quote escaping is a structural minefield; this tool sidesteps it by accepting the object directly). ' +
    'Update flow: read_file the existing JSON, mutate the parsed object in memory (add/remove/reorder scenes or shots, edit any field), then save_storyboard with the whole mutated object. The tool detects the file exists and preserves createdAt. ' +
    'After a CREATE, call show_result with resourceType "file" and the returned path so the GUI opens the storyboard tab. After an UPDATE, the visor picks up the change automatically — no show_result needed.',
  thinkingHint: (action) => `Saving storyboard ${action?.storyboard?.id || ''}`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      storyboard: {
        type: 'object',
        description: 'Full storyboard object (v6 schema). See description for required fields.',
      },
      summary: { type: 'string', description: 'OPTIONAL. One-line "what is this storyboard for" — pinned to this session\'s creations ledger so you can later list / recall it via `recall_creations` without searching the filesystem. Examples: "Duelo bajo la Tormenta — full storyboard", "Product demo intro storyboard, vertical 9:16". Keep it short and self-evident; the agent is the one who will read it back later. Only attached on the FIRST save of a given storyboard id; subsequent edits do not overwrite it. When omitted, the ledger falls back to the storyboard\'s description.' },
    },
    required: ['storyboard'],
  },

  async execute(action, agent) {
    const sb = action?.storyboard;
    if (!_isObj(sb)) {
      return _err('"storyboard" is required and must be an object. ' +
        'Call shape: { intent: "save_storyboard", storyboard: { id, name, aspect, scenes: [...] } }.');
    }

    const validationError = _validate(sb);
    if (validationError) return _err(validationError);

    const home = process.env.HOME || os.homedir();
    const dir = path.join(home, '.koi', 'storyboards');
    const filePath = path.join(dir, `${sb.id}.json`);

    // Read the existing file (if any) so we can preserve createdAt
    // and so the `created` flag in the response is accurate.
    let existing = null;
    let existed = false;
    try {
      if (fs.existsSync(filePath)) {
        existed = true;
        const raw = fs.readFileSync(filePath, 'utf8');
        try { existing = JSON.parse(raw); } catch { /* corrupted prior file — overwrite */ }
      }
    } catch { /* ignore — fall through to write */ }

    const normalized = _normalize(sb, existing);
    const serialized = JSON.stringify(normalized, null, 2) + '\n';

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
      `${shotCount} shot${shotCount === 1 ? '' : 's'}).`);

    return {
      success: true,
      path: filePath,
      id: normalized.id,
      created: !existed,
      sceneCount,
      shotCount,
    };
  },
};
