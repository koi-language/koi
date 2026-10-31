/**
 * save_character — write a reusable "character" entity to
 * `<project>/characters/<id>.json` with structured args.
 *
 * A character is a persisted, reusable entity (a person, a mascot, a
 * product spokesperson…) the user can reference across storyboards,
 * image / video prompts and audio. The LLM passes the character as an
 * OBJECT (not a JSON string); this tool validates it, `JSON.stringify`
 * does the serialization, and an atomic tmp+rename write lands the file.
 *
 * Behaviour (mirrors save_storyboard):
 *   - New character: writes the file, indexes it in MediaLibrary, and —
 *     when a `handle` + at least one photo are present — registers the
 *     first photo's library row under the `@handle` so `@handle` resolves
 *     in prompts (best-effort; never fails the save).
 *   - Existing character: same call, preserves `createdAt`, bumps
 *     `updatedAt`.
 *   - Validation failures return { success: false, error } naming the
 *     exact field that's wrong, so the LLM can self-correct on the next
 *     turn instead of producing another broken file.
 *
 * Photos are POINTERS — absolute file paths only. The tool never copies
 * the image bytes (same model as media-library's `registerInPlace`).
 *
 * Permission / UX: app-managed artefact — no diff card, no permission
 * dialog. Pair with `show_result` to open the new tab.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { channel } from '../../io/channel.js';
import { saveCharacterEntry } from '../../state/media-library.js';
import { slugifyCharacterId } from '../../state/character-registry.js';

import { docDir } from '../../state/doc-root.js';
const _KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

function _err(msg) { return { success: false, error: `save_character: ${msg}` }; }

function _isStr(v) { return typeof v === 'string'; }
function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _validate(ch) {
  if (!_isObj(ch)) return 'character must be an object with at least { name }.';

  if (!_isStr(ch.name) || !ch.name.trim()) {
    return '"name" must be a non-empty string.';
  }
  // `id` is OPTIONAL — derived from the name when omitted. When supplied it
  // MUST already be a kebab-case slug that matches the on-disk filename.
  if (ch.id !== undefined && (!_isStr(ch.id) || !_KEBAB_RE.test(ch.id))) {
    return `"id" (when provided) must be a kebab-case string (lowercase letters/digits/hyphens). Got ${JSON.stringify(ch.id)}.`;
  }
  for (const k of ['handle', 'description', 'backstory', 'voiceId', 'sheet', 'ttsModel', 'sex', 'build']) {
    if (ch[k] !== undefined && ch[k] !== null && !_isStr(ch[k])) {
      return `"${k}" (when provided) must be a string. Got ${typeof ch[k]}.`;
    }
  }
  // Physical attributes exposed as controls in the visor. `age` in years,
  // `height` in cm, `weight` in kg. Optional numbers. `sex` and `build`
  // (complexion) are short canonical strings.
  for (const k of ['age', 'height', 'weight']) {
    if (ch[k] !== undefined && ch[k] !== null &&
        !(typeof ch[k] === 'number' && Number.isFinite(ch[k]))) {
      const unit = k === 'age' ? 'years' : k === 'height' ? 'centimetres' : 'kilograms';
      return `"${k}" (when provided) must be a number (${unit}).`;
    }
  }
  // `sheetCells` is the detected cell geometry of the turnaround `sheet`
  // (a black-band grid): an array of normalized { x, y, w, h } rects in
  // reading order (row-major). Optional; when present each entry is an object
  // of finite numbers in 0..1.
  if (ch.sheetCells !== undefined && ch.sheetCells !== null) {
    if (!Array.isArray(ch.sheetCells)) {
      return '"sheetCells" (when provided) must be an array of { x, y, w, h } normalized rects.';
    }
  }
  // `handle` is a BARE @mention without the leading @ (e.g. "jason").
  if (_isStr(ch.handle) && ch.handle.trim() && ch.handle.trim().startsWith('@')) {
    return '"handle" must be the BARE mention WITHOUT the leading "@" (e.g. "jason", not "@jason").';
  }
  if (ch.photos !== undefined) {
    if (!Array.isArray(ch.photos) || ch.photos.some((p) => !_isStr(p))) {
      return '"photos" (when provided) must be an array of absolute file paths (strings). photos[0] is the hero image.';
    }
  }
  return null;
}

// Photos are path POINTERS — keep only non-empty strings that look like real
// absolute paths, in order (photos[0] stays the hero image). We never copy
// bytes and never verify existence here (the file may be produced later in
// the same turn); a downstream reader resolves them.
function _normPhotos(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const p of v) {
    if (!_isStr(p)) continue;
    const s = p.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _normHandle(v) {
  if (!_isStr(v)) return null;
  let h = v.trim();
  if (h.startsWith('@')) h = h.slice(1);
  h = h.trim();
  return h.length > 0 ? h : null;
}

// Turnaround-sheet cell geometry: an array of normalized { x, y, w, h } rects
// (each in 0..1, relative to the sheet image), in reading order — row 0 is the
// full-body row, row 1 the face row. Produced by the black-band detector when
// the sheet is generated. Kept only when every entry is well-formed.
function _normSheetCells(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const c of v) {
    if (!_isObj(c)) continue;
    const x = Number(c.x); const y = Number(c.y);
    const w = Number(c.w); const h = Number(c.h);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    out.push({ x, y, w, h });
  }
  return out.length ? out : null;
}

function _normalize(ch, existing) {
  // Carry forward the original createdAt across saves so the MediaLibrary
  // "Latest" ordering stays anchored to when the character was first
  // authored, not when it was last touched.
  const now = new Date().toISOString();
  const createdAt =
    (existing && _isStr(existing.createdAt) && existing.createdAt) ||
    (_isStr(ch.createdAt) && ch.createdAt) ||
    now;
  return {
    id: ch.id,
    name: ch.name.trim(),
    handle: _normHandle(ch.handle),
    description: _isStr(ch.description) ? ch.description : '',
    backstory: _isStr(ch.backstory) ? ch.backstory : '',
    // Physical attributes (controls in the visor). sex/build are short
    // canonical strings (e.g. "female", "athletic"); age=years, height=cm,
    // weight=kg.
    sex: (_isStr(ch.sex) && ch.sex.trim()) ? ch.sex.trim() : null,
    age: (typeof ch.age === 'number' && Number.isFinite(ch.age)) ? ch.age : null,
    height: (typeof ch.height === 'number' && Number.isFinite(ch.height)) ? ch.height : null,
    weight: (typeof ch.weight === 'number' && Number.isFinite(ch.weight)) ? ch.weight : null,
    build: (_isStr(ch.build) && ch.build.trim()) ? ch.build.trim() : null,
    photos: _normPhotos(ch.photos),
    // Generated turnaround sheet (a 4-col x 2-row grid of the character) + the
    // detected cell geometry the visor crops into the rotating card view.
    sheet: (_isStr(ch.sheet) && ch.sheet.trim()) ? ch.sheet.trim() : null,
    sheetCells: _normSheetCells(ch.sheetCells),
    voiceId: (_isStr(ch.voiceId) && ch.voiceId.trim()) ? ch.voiceId.trim() : null,
    // TTS model slug to synthesize this character's voice with (provider-scoped
    // to the voice); null = let the audio pipeline pick a default.
    ttsModel: (_isStr(ch.ttsModel) && ch.ttsModel.trim()) ? ch.ttsModel.trim() : null,
    createdAt,
    updatedAt: now,
  };
}

export default {
  type: 'save_character',
  intent: 'save_character',
  description:
    'REQUIRED FIRST: activate the `characters` skill before creating or editing a character — it is the full contract (the character JSON schema and every field, the REQUIRED Seedream 5 Pro model for the turnaround sheet, and the voice-assignment flow). ' +
    'Write a reusable CHARACTER entity to <project>/characters/<id>.json with STRUCTURED args (the character as an OBJECT, not a JSON string). ' +
    'A character is a persisted, reusable identity (a person, mascot, spokesperson…) the user can reference across storyboards, image/video prompts and audio. ' +
    'Use for BOTH creating new characters and updating existing ones — same call shape; the tool detects which and preserves createdAt across edits. ' +
    'Call shape: { character: { id?, name, handle?, description?, backstory?, sex?, age?, height?, weight?, build?, photos?, voiceId?, sheet?, sheetCells?, ttsModel? } }. '
    + 'Physical attributes surfaced as controls in the visor (all OPTIONAL): character.sex (short canonical string, e.g. "female" / "male" / "nonbinary"), character.age (years, number), character.height (cm, number), character.weight (kg, number), character.build (complexion, short canonical string, e.g. "slim" / "average" / "athletic" / "muscular" / "heavy"). ' +
    'Required: character.name (non-empty). ' +
    'character.id is OPTIONAL — a kebab-case slug that MUST match the on-disk filename; when omitted it is derived from the name. ' +
    'character.handle is the BARE @mention WITHOUT the leading "@" (e.g. "jason") — when set together with at least one photo, the first photo is registered under `@handle` so `@handle` resolves in prompts. ' +
    'character.description and character.backstory are optional strings (backstory = the character\'s history). ' +
    'character.photos is an OPTIONAL array of ABSOLUTE file paths — POINTERS only, the bytes are never copied; photos[0] is the hero image the drawer shows. ' +
    'character.voiceId is an OPTIONAL string: a voice-registry id ("voice-...") or a voice display name. character.ttsModel is an OPTIONAL TTS model slug to speak this character with (provider-scoped to the voice). ' +
    'When you CREATE a character, ASSIGN A FITTING VOICE: call list_voices (default provider ElevenLabs) and pick a preset whose gender matches the character\'s sex, then set voiceId to that preset name and ttsModel to the model slug — a character with no voice cannot speak in a video. ' +
    'character.sheet is an OPTIONAL absolute path to a generated TURNAROUND sheet (a 4-col x 2-row grid of the character) and character.sheetCells its detected normalized cell rects — usually set by the generate_character_sheet tool, not by hand. ' +
    'Auto-set by the tool: updatedAt=now (UTC ISO), createdAt preserved from the existing file or set to now, id slugged from name when omitted. ' +
    'Returns: { success:true, filePath, character:<normalized> } on success, or { success:false, error } with the exact invalid field on validation failure.',
  instructions:
    'save_character REPLACES write_file for <project>/characters/*.json — never hand-serialize the JSON (this tool sidesteps quote-escaping by accepting the object directly). ' +
    'Update flow: read the existing JSON, mutate the parsed object in memory, then save_character with the whole mutated object (include its id so the same file is updated). ' +
    'After a CREATE, call show_result with resourceType "file" and the returned filePath so the GUI opens the character tab.',
  thinkingHint: (action) => `Saving character ${action?.character?.id || action?.character?.name || ''}`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      character: {
        type: 'object',
        description: 'Full character object: { id?, name, handle?, description?, backstory?, photos?, voiceId? }. See description for required fields.',
      },
      summary: { type: 'string', description: 'OPTIONAL. One-line "who is this character" — pinned to this session\'s creations ledger so you can later list / recall it via `recall_creations`. Only attached on the FIRST save of a given character id. When omitted, the ledger falls back to the character\'s description.' },
    },
    required: ['character'],
  },

  async execute(action, agent) {
    const ch = action?.character;
    if (!_isObj(ch)) {
      return _err('"character" is required and must be an object. ' +
        'Call shape: { intent: "save_character", character: { name, handle?, photos?, ... } }.');
    }

    // Derive a kebab-case id from the name when the agent omitted it.
    if (ch.id === undefined || ch.id === null || (_isStr(ch.id) && !ch.id.trim())) {
      const slug = slugifyCharacterId(ch.name);
      if (!slug) {
        return _err('could not derive an "id" from "name" — pass an explicit kebab-case "id".');
      }
      ch.id = slug;
    }

    const validationError = _validate(ch);
    if (validationError) return _err(validationError);

    const home = process.env.HOME || os.homedir();
    const dir = path.join(docDir('characters'));
    let filePath = path.join(dir, `${ch.id}.json`);

    // Read the file currently at this id FIRST, so create-vs-update is decided
    // from real content (not just a flag), and so createdAt is preserved.
    let existing = null;
    let existed = false;
    try {
      if (fs.existsSync(filePath)) {
        existed = true;
        const raw = fs.readFileSync(filePath, 'utf8');
        try { existing = JSON.parse(raw); } catch { /* corrupted prior file — overwrite */ }
      }
    } catch { /* ignore — fall through to write */ }

    // CREATE-vs-UPDATE collision guard. The normal, wanted case is "iterate MY
    // character": the agent saves under the SAME id to UPDATE it in place. We
    // treat a save as the SAME character (→ overwrite, preserve createdAt)
    // whenever ANY of these hold: it carried `createdAt` (a read-modify-save),
    // or its name is unchanged. ONLY when a file exists at this id AND none of
    // those hold (a genuinely DIFFERENT character whose name coincidentally
    // slugged to a taken id) do we auto-uniquify, so we never silently clobber
    // an unrelated character.
    const isUpdateIntent = _isStr(ch.createdAt) && !!ch.createdAt.trim();
    const _sameCharacter = existing != null && (
      isUpdateIntent ||
      (_isStr(existing.name) && _isStr(ch.name) && existing.name === ch.name)
    );
    let collisionRenamedFrom = null;
    if (existed && !_sameCharacter) {
      const baseId = ch.id;
      let n = 2;
      let candidateId = `${baseId}-${n}`;
      while (fs.existsSync(path.join(dir, `${candidateId}.json`)) && n < 1000) {
        n += 1;
        candidateId = `${baseId}-${n}`;
      }
      collisionRenamedFrom = baseId;
      ch.id = candidateId;
      filePath = path.join(dir, `${ch.id}.json`);
      existing = null;
      existed = false;
    }

    const normalized = _normalize(ch, existing);
    const serialized = JSON.stringify(normalized, null, 2) + '\n';

    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write via a sibling tmp file + rename so the GUI's file-watcher
      // never observes a half-written / truncated JSON document.
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return _err(`failed to write ${filePath}: ${err.message}`);
    }

    // Index in MediaLibrary so the character shows in the drawer at its real
    // authored date. Best-effort: a DB hiccup must not lose the file write.
    // Capture the row id so we can attach the @mention below.
    let saved = null;
    try {
      saved = await saveCharacterEntry(filePath, normalized, agent?.llmProvider, {
        summary: typeof action.summary === 'string' ? action.summary : undefined,
      });
    } catch (err) {
      channel.log('save_character',
        `MediaLibrary index failed for ${filePath} (${err.message}); file still written.`);
    }

    // When a handle + at least one photo are present, register the FIRST
    // photo's media-library row under the @mention so `@handle` resolves in
    // prompts. Best-effort — never fail the save. The hero photo must already
    // be in the library as its own row (generated / read this session); we
    // resolve it by path and tag that row.
    if (normalized.handle && normalized.photos.length > 0) {
      try {
        const { MediaLibrary } = await import('../../state/media-library.js');
        const lib = MediaLibrary.global();
        const heroPath = normalized.photos[0];
        const row = await lib.getByPath(heroPath);
        if (row?.id) {
          await lib.setMention(row.id, normalized.handle);
        }
      } catch { /* best-effort — @handle registration must never block a save */ }
    }

    channel.log('save_character',
      `${existed ? 'updated' : 'created'} ${filePath} ` +
      `(${normalized.photos.length} photo${normalized.photos.length === 1 ? '' : 's'}` +
      `${normalized.handle ? `, @${normalized.handle}` : ''}` +
      `${normalized.voiceId ? ', voice' : ''})` +
      `${collisionRenamedFrom ? ` [id "${collisionRenamedFrom}" was taken → saved as "${normalized.id}" to avoid overwriting it]` : ''}.`);

    return {
      success: true,
      filePath,
      character: normalized,
      created: !existed,
      ...(collisionRenamedFrom
        ? { renamedFrom: collisionRenamedFrom,
            note: `The id "${collisionRenamedFrom}" already existed, so this NEW character was saved as "${normalized.id}" to avoid overwriting the existing one. Use this id from now on.` }
        : {}),
    };
  },
};
