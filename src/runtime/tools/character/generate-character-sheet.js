/**
 * generate_character_sheet — build a character TURNAROUND SHEET and detect its
 * crop geometry.
 *
 * Produces ONE image of the same character, 4 equal columns (Antonio, 16/11/2026):
 * the FIRST column is one tall cell, the full body from the front taking the whole
 * height so the wardrobe reads in detail; the other three columns are split in two
 * rows: top = three faces (front neutral, three-quarter smiling with the teeth,
 * profile), bottom = the full body from ONE side, from the back, and a close-up of
 * the wardrobe's key detail. Seven cells, drawn with THICK pure-black gutter bars
 * so they can be segmented deterministically; their normalized rects are returned
 * in SHEET_VIEWS order so the visor crops each view by name.
 *
 * The old sheet (a 4x2 grid of 8 cells: four bodies, then four faces) is still
 * read by the visor: a character's `sheetCells` of length 8 is that layout, of
 * length 7 this one.
 *
 * Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the character
 * (either is enough; both is best). When neither is passed but `characterId`
 * is, the description + photos are sourced from the existing character doc so
 * the agent can regenerate a sheet for a saved character in one call.
 *
 * This tool does NOT write the character file — it returns { sheet, sheetCells }
 * for the caller (the GUI, or a follow-up `save_character`) to persist.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { channel } from '../../io/channel.js';
import { readCharacter } from '../../state/character-registry.js';
import generateImage from '../media/generate-image.js';
import { buildPartialComposite } from '../media/composite-partial-edit.js';

function _err(msg) { return { success: false, error: `generate_character_sheet: ${msg}` }; }
function _isStr(v) { return typeof v === 'string'; }

// Fixed technical layout scaffold. The creative content is the caller-authored
// DESCRIPTION (and the reference photos); everything else here is a machine
// requirement: 4 equal columns with thick pure-black gutters so the cut-line
// detector can find the 7 cells. Mirrors the keyframe-sheet separator spec.
/** The seven cells of the sheet, in `sheetCells` order. */
export const SHEET_VIEWS = ['hero', 'faceFront', 'faceSmile', 'faceProfile', 'bodySide', 'bodyBack', 'detail'];

function _buildSheetPrompt(description, detail) {
  const desc = (description && description.trim())
    ? description.trim()
    : 'a character (infer a consistent, plausible appearance from the reference photos)';
  const detailCell = (detail && detail.trim())
    ? `an extreme CLOSE-UP of ${detail.trim()}, filling the cell, sharp enough to read every stitch, mark and colour`
    : 'an extreme CLOSE-UP of the single most distinctive detail of the wardrobe (an insignia, an emblem, a buckle, a print, a piece of jewellery), filling the cell, sharp enough to read every stitch, mark and colour';
  return [
    'Character reference sheet: ONE single image divided into 4 columns of EQUAL width, 7 cells in total.',
    'COLUMN 1 is ONE single TALL cell spanning the FULL HEIGHT of the image: the FULL BODY, head to toe, from the FRONT, standing in a neutral relaxed pose, as large as the cell allows, so every piece of the wardrobe, the accessories and the footwear reads in detail.',
    'COLUMNS 2, 3 and 4 are each split into TWO cells of equal height (top and bottom):',
    'TOP ROW of columns 2-4, three HEAD-AND-SHOULDERS portraits of the SAME face: (2) front, neutral expression; (3) three-quarter, SMILING broadly with the mouth open so the TEETH are clearly visible (the real upper and lower teeth of this character, the reference for every later shot where they speak or smile); (4) side profile.',
    `BOTTOM ROW of columns 2-4: (2) the FULL BODY, head to toe, in side profile (ONE side only); (3) the FULL BODY, head to toe, from the back; (4) ${detailCell}.`,
    'It is the SAME character in every cell: identical face, hairstyle, wardrobe, body proportions and colors. Only the camera angle changes between cells, plus the smile of the three-quarter portrait.',
    'Even, neutral studio lighting; plain light-grey seamless background; photorealistic unless the description says otherwise.',
    `CHARACTER: ${desc}.`,
    'GRID LAYOUT (CRITICAL, machine-read): separate every cell with SOLID PURE-BLACK (#000000) gutter bars, clearly THICK (about 1% of the image width, a bold bar, never a thin hairline), perfectly straight, continuous and uniform. The three vertical bars run the full height of the image; the one horizontal bar runs from the first vertical bar to the right edge (column 1 has NO horizontal bar, it is one tall cell). NEVER gray, never thin; no inner borders, no frames, no text, no numbers, no labels, no watermark, no drop shadows between cells.',
  ].join('\n');
}

// Fallback even split when detection doesn't read the gutters: the layout's
// nominal cells, in SHEET_VIEWS order. Crops include the gutter edges but stay usable.
function _evenSheet() {
  const q = 1 / 4;
  return [
    { x: 0, y: 0, w: q, h: 1 },
    { x: q, y: 0, w: q, h: 0.5 }, { x: 2 * q, y: 0, w: q, h: 0.5 }, { x: 3 * q, y: 0, w: q, h: 0.5 },
    { x: q, y: 0.5, w: q, h: 0.5 }, { x: 2 * q, y: 0.5, w: q, h: 0.5 }, { x: 3 * q, y: 0.5, w: q, h: 0.5 },
  ];
}

// Maximal runs along an axis where the near-black fraction stays BELOW the
// gutter threshold T (i.e. a real cell), each at least `minFrac` of the extent
// wide (rejects thin slivers). Returns [[start,end), …].
function _contentBands(prof, extent, T, minFrac) {
  const bands = [];
  let s = -1;
  for (let i = 0; i < extent; i++) {
    if (prof[i] < T) { if (s < 0) s = i; }
    else if (s >= 0) { if (i - s >= minFrac * extent) bands.push([s, i]); s = -1; }
  }
  if (s >= 0 && extent - s >= minFrac * extent) bands.push([s, extent]);
  return bands;
}

// Sweep the gutter threshold high→low and take the FIRST that yields EXACTLY
// nCells content bands. Robust to UNEQUAL spacing (a tall full-body row + a
// short portrait row) and to the sheet's pure-black top/bottom margins (which
// read as gutters and are excluded from the cells). Null when unreadable.
function _axisCells(prof, extent, nCells, minFrac) {
  for (let T = 0.9; T >= 0.4; T -= 0.02) {
    const b = _contentBands(prof, extent, T, minFrac);
    if (b.length === nCells) return b;
  }
  return null;
}

/**
 * Line-based cell detector for the sheet. It does NOT assume equal spacing: it
 * finds the actual CUT LINES from the near-black fraction of each column and row,
 * then builds the cells between them. The vertical bars run the full height, so
 * the 4 columns come from the whole image; the horizontal bar only crosses columns
 * 2-4, so the 2 rows are read on that part alone. The black margins never bleed
 * into a cell. Returns the 7 normalized { x, y, w, h } cells in SHEET_VIEWS order,
 * or null when the grid can't be read cleanly.
 */
export function detectSheetCells(gray, W, H, ch = 1) {
  if (!(W > 0) || !(H > 0)) return null;
  const DARK = 45; // pixel value <= this is the pure-black gutter/margin
  const colDark = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    const base = y * W * ch;
    for (let x = 0; x < W; x++) if (gray[base + x * ch] <= DARK) colDark[x] += 1;
  }
  for (let x = 0; x < W; x++) colDark[x] /= H;
  const cx = _axisCells(colDark, W, 4, 0.08);
  if (!cx) return null;
  const [x1, x2] = [cx[1][0], cx[3][1]]; // columns 2..4
  const rowDark = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W * ch;
    let n = 0;
    for (let x = x1; x < x2; x++) if (gray[base + x * ch] <= DARK) n++;
    rowDark[y] = n / (x2 - x1);
  }
  const ry = _axisCells(rowDark, H, 2, 0.15);
  if (!ry) return null;
  // The tall cell spans from the top of the first row to the bottom of the second.
  const rect = (x0, x1_, y0, y1) => ({ x: x0 / W, y: y0 / H, w: (x1_ - x0) / W, h: (y1 - y0) / H });
  const cells = [rect(cx[0][0], cx[0][1], ry[0][0], ry[1][1])];
  for (const [y0, y1] of ry) for (const [a, b] of cx.slice(1)) cells.push(rect(a, b, y0, y1));
  return cells;
}

async function _detectSheetCells(sharp, sheet) {
  const { data, info } = await sharp(sheet).greyscale().raw().toBuffer({ resolveWithObject: true });
  return detectSheetCells(data, info.width, info.height, info.channels);
}

// EDIT MODE (Antonio, 16/11/2026): a change to a sheet that exists (the collar, a badge, the
// red of a cuff) never re-renders the sheet. Every pass of an image model over the whole sheet
// loses detail, and passes chained on each other's output ended in faces and cloth that looked
// drawn. So the model edits the current sheet, and ONLY the areas it really changed are pasted
// onto it (buildPartialComposite, the composite_partial_edit engine); every other pixel stays.
async function _editSheet({ action, agent, characterId, change }) {
  if (!characterId) return _err('`change` edits a saved character\'s sheet: pass its characterId.');
  const existing = readCharacter(characterId);
  const sheet = _isStr(existing?.sheet) ? existing.sheet.trim() : '';
  if (!sheet || !fs.existsSync(sheet)) return _err(`character "${characterId}" has no sheet to edit: generate it first (without \`change\`).`);
  if (!Array.isArray(existing.sheetCells) || existing.sheetCells.length !== SHEET_VIEWS.length) {
    return _err(`character "${characterId}" still has the OLD sheet layout: regenerate it whole from its original photos first (without \`change\`), then edit that one.`);
  }
  const extra = (Array.isArray(action?.photos) ? action.photos : [])
    .filter((p) => _isStr(p) && p.trim() && p.trim() !== sheet).map((p) => p.trim());
  const prompt = [
    'Edit the FIRST image: the reference sheet of a character, 7 panels separated by thick pure-black bars.',
    `Change ONLY this: ${change}.`,
    'Everything else stays EXACTLY as it is: the same person, face, skin, hair, expression, pose, framing, lighting, fabric, background, panels and black bars, pixel for pixel wherever the change does not reach.',
    ...(extra.length ? ['The other images are ONLY the reference for the change: copy from them what the change asks for and nothing else.'] : []),
  ].join('\n');
  const sharp = (await import('sharp')).default;
  const m = await sharp(sheet).metadata();
  let r;
  try {
    r = await generateImage.execute({
      prompt,
      model: (_isStr(action?.model) && action.model.trim() && action.model.trim() !== 'auto') ? action.model.trim() : 'openai/gpt-image-2.6/sunburst/edit',
      // An edit keeps the sheet's resolution: the model is asked for exactly its pixels.
      aspectRatio: '16:9', resolution: '4k', targetSize: { width: m.width, height: m.height }, quality: 'high', outputFormat: 'png',
      referenceImages: [sheet, ...extra].map((p, i) => ({ alias: `ref${i + 1}`, path: p })),
      _internalDelegate: true, label: 'character_sheet_edit',
    }, agent);
  } catch (e) {
    return _err(`sheet edit error: ${e.message}`);
  }
  if (!r || r.success === false) return _err(`sheet edit failed: ${r?.error || 'unknown error'}`);
  const img = Array.isArray(r.images) ? r.images[0] : null;
  let editPath = img?.exportedTo || img?.savedTo;
  if (!editPath) return _err('the edit returned no image path.');

  const e = await sharp(editPath).metadata();
  if (m.width !== e.width || m.height !== e.height) {
    // Never rescaled to fit: an edit must come back at the sheet's own resolution.
    return _err(`the edit came back at ${e.width}x${e.height}, not at the sheet's ${m.width}x${m.height}; retry with a model that honours the exact size.`);
  }
  const outPath = editPath.replace(/\.[^.]+$/, '') + '-sheet.png';
  const checkImage = path.join(os.tmpdir(), path.basename(outPath).replace(/\.[^.]+$/, '') + '.check.jpg');
  const regions = (Array.isArray(action?.regions) ? action.regions : [])
    .map((q) => ({ x: Number(q?.x), y: Number(q?.y), w: Number(q?.w), h: Number(q?.h) }))
    .filter((q) => [q.x, q.y, q.w, q.h].every(Number.isFinite) && q.w > 0 && q.h > 0);
  const built = await buildPartialComposite({ masterPath: sheet, editPath, outPath, previewPath: checkImage, regions });
  if (built.error) return _err(`sheet edit: ${built.error}`);
  try {
    const { default: saveComposite } = await import('../media/save-composite-image.js');
    await saveComposite.execute({ path: outPath, masterImage: sheet, editImage: editPath, summary: `${existing.name}: ${change}` }, agent);
  } catch { /* registering the creation is best-effort; the file is written */ }

  const { default: saveCharacter, SHEET_TOOL } = await import('./save-character.js');
  const res = await saveCharacter.execute({ character: { ...existing, sheet: outPath, sheetCells: existing.sheetCells }, [SHEET_TOOL]: true }, agent);
  channel.log('generate_character_sheet', `edited ${characterId}: ${built.regions.length} region(s), ${(built.coverage * 100).toFixed(1)}% of the sheet repainted`);
  return {
    success: true, mode: 'edit', sheet: outPath, previousSheet: sheet, sheetCells: existing.sheetCells, views: SHEET_VIEWS,
    characterId, attached: !!(res && res.success !== false), coverage: built.coverage, regions: built.regions, checkImage,
    note: 'Look at checkImage (the repainted area tinted magenta) and at the sheet: only the asked change may be tinted. A stray area: pass `regions`; a missed one: say the change more precisely. If wrong, the previousSheet is untouched: save nothing else, edit again from it.',
  };
}

export default {
  type: 'generate_character_sheet',
  intent: 'generate_character_sheet',
  description:
    'REQUIRED FIRST: activate the `characters` skill — it documents the character JSON and the voice flow. ' +
    'Generate a character SHEET: one image of the SAME character in 4 equal columns with thick pure-black gutter bars: column 1 is one tall cell with the full body from the front (the whole height); columns 2-4 hold three faces on top (front neutral, three-quarter smiling with the teeth, profile) and, below, the full body from one side, from the back, and a close-up of the key wardrobe detail. The 7 cells are auto-detected. ' +
    'Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the character (either is enough; both is best). When only `characterId` is given, the description + photos are read from that saved character. ' +
    'Call shape: { description?, photos?: [absolute paths], characterId?, detail?, model?, aspectRatio? }. ' +
    'CHANGING an existing sheet (a collar, a badge, a colour, the face): pass characterId + `change` ("the red collar patches like the sergeant\'s, partly covered by the cape"), optional extra `photos` as the reference for the change and `regions` [{x,y,w,h}] around it: the model edits the current sheet and ONLY the changed areas are pasted onto it, the rest stays pixel for pixel. Never regenerate a whole sheet to change part of it, and never pass a character\'s own sheet as a photo of a whole regeneration. ' +
    'detail: the wardrobe detail the close-up must show (e.g. "the red collar insignia and the cuff buttons"); omitted, the model picks the most distinctive one. ' +
    'model: pass the one the characters skill names (GPT Image 2.6 Sunburst: edit WITH reference photos, text-to-image for an invented character); omitted → that same default. ' +
    'Returns: { success, sheet: <absolute path to the generated sheet>, sheetCells: [{x,y,w,h} normalized, 7 cells in the order hero, faceFront, faceSmile, faceProfile, bodySide, bodyBack, detail], views, model, attached }. ' +
    'When a characterId is passed, the sheet is AUTOMATICALLY attached to that character (sheet + sheetCells saved onto its doc) — no follow-up save_character needed. Without a characterId, attach it yourself with save_character { id, sheet, sheetCells }.',
  thinkingHint: () => 'Generating character turnaround sheet',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the character looks like (physical traits, wardrobe, age, attitude). Used verbatim as the creative content of the sheet.' },
      photos: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute file paths to one or more reference photos of the character, used to preserve identity across the 7 views.' },
      characterId: { type: 'string', description: 'OPTIONAL id of a saved character (<project>/characters/<id>.json). When description/photos are omitted they are sourced from this character.' },
      change: { type: 'string', description: 'OPTIONAL edit mode: what to change on the character\'s CURRENT sheet (needs characterId). Only the changed areas are repainted.' },
      regions: { type: 'array', items: { type: 'object' }, description: 'OPTIONAL with `change`: normalised boxes {x,y,w,h} around where the change goes; changed areas elsewhere are not pasted.' },
      detail: { type: 'string', description: 'OPTIONAL the wardrobe detail the close-up cell must show (an insignia, an emblem, a buckle, a print). Omitted: the most distinctive one.' },
      model: { type: 'string', description: 'OPTIONAL image model slug. Omit to auto-pick a reference-capable (image-editing) model.' },
      aspectRatio: { type: 'string', description: 'OPTIONAL aspect ratio for the sheet. Defaults to 16:9 (a wide sheet).' },
    },
  },

  async execute(action, agent) {
    let description = _isStr(action?.description) ? action.description.trim() : '';
    let photos = Array.isArray(action?.photos)
      ? action.photos.filter((p) => _isStr(p) && p.trim()).map((p) => p.trim())
      : [];
    const characterId = _isStr(action?.characterId) ? action.characterId.trim() : '';
    const detail = _isStr(action?.detail) ? action.detail.trim() : '';
    const change = _isStr(action?.change) ? action.change.trim() : '';
    if (change) return _editSheet({ action, agent, characterId, change });

    // A WHOLE regeneration starts from the character's originals, never from its own sheet: a
    // sheet re-rendered from a sheet loses detail every pass (Antonio, 16/11/2026).
    const ownSheet = characterId ? (readCharacter(characterId)?.sheet || '').trim() : '';
    const passed = Array.isArray(action?.photos) ? action.photos.map((p) => (_isStr(p) ? p.trim() : '')) : [];
    if (ownSheet && passed.includes(ownSheet)) {
      return _err('never regenerate a character\'s sheet from that same sheet. To change part of it pass `change` (only that area is repainted); ' +
        'to regenerate it whole, pass the character\'s ORIGINAL photos (or none: they are read from the character).');
    }

    // A WHOLE regeneration of a saved character is a generation from scratch with ALL its
    // material, never an iteration (Antonio, 16/11/2026): every photo the character was made
    // from goes in, first, plus whatever this call adds (another character's sheet as the
    // wardrobe reference), and its saved description, with this call's text added to it.
    // Its own sheet never goes in (refused above).
    if (characterId) {
      try {
        const ch = readCharacter(characterId);
        if (ch) {
          const own = Array.isArray(ch.photos) ? ch.photos.filter((p) => _isStr(p) && p.trim()).map((p) => p.trim()) : [];
          photos = [...new Set([...own, ...photos])];
          const saved = _isStr(ch.description) ? ch.description.trim() : '';
          if (saved && description && !description.includes(saved)) {
            description = `${saved}\nFOR THIS SHEET, ALSO: ${description}`;
          } else if (saved && !description) {
            description = saved;
          }
        }
      } catch { /* character may not exist yet: fall through to the guard below */ }
    }

    if (!description && photos.length === 0) {
      return _err('need at least a description or one reference photo to generate a sheet.');
    }

    // MODEL: the caller's `model` (the characters skill passes it). Otherwise
    // GPT Image 2.6 Sunburst (user choice: the best image model): the EDIT
    // variant when there are reference photos, text-to-image for an invented
    // character. No backoffice-label routing: the skill decides defaults.
    let model = (_isStr(action?.model) && action.model.trim() && action.model.trim() !== 'auto')
      ? action.model.trim()
      : null;
    if (!model) {
      model = photos.length ? 'openai/gpt-image-2.6/sunburst/edit' : 'openai/gpt-image-2.6/sunburst/text-to-image';
    }

    const aspectRatio = (_isStr(action?.aspectRatio) && action.aspectRatio.trim())
      ? action.aspectRatio.trim()
      : '16:9';

    // Delegate to generate_image. _internalDelegate bypasses the doc-guard and
    // the read-before-use guard on referenceImages (we feed the character's
    // photos programmatically).
    const genAction = {
      prompt: _buildSheetPrompt(description, detail),
      model,
      aspectRatio,
      // The turnaround sheet renders at 4K (4096), ALWAYS, never less (Antonio, 11/11/2026): each of its cells is
      // a reference cropped out of it, and at 2K a face cell is too small to hold the detail a video model copies.
      resolution: '4k',
      quality: 'high',
      outputFormat: 'png',
      _internalDelegate: true,
      label: 'character_sheet',
    };
    if (photos.length) {
      genAction.referenceImages = photos.map((p, i) => ({ alias: `ref${i + 1}`, path: p }));
    }

    let r;
    try {
      r = await generateImage.execute(genAction, agent);
    } catch (e) {
      return _err(`sheet generation error: ${e.message}`);
    }
    if (!r || r.success === false) {
      return _err(`sheet generation failed: ${r?.error || 'unknown error'}`);
    }
    const img = Array.isArray(r.images) ? r.images[0] : null;
    const sheet = img?.exportedTo || img?.savedTo;
    if (!sheet) return _err('generation returned no image path.');

    // Detect the 7 cells from the black gutter bars (the real cut lines, so unequal
    // cells and the black margins are cropped right). Falls back to the nominal layout.
    let sheetCells = null;
    try {
      const sharp = (await import('sharp')).default;
      sheetCells = await _detectSheetCells(sharp, sheet);
      if (!sheetCells) channel.log('generate_character_sheet', "the sheet's gutters could not be read: using the nominal layout.");
    } catch (e) {
      channel.log('generate_character_sheet', `cell detection failed: ${e.message}: using the nominal layout.`);
    }
    if (!sheetCells) sheetCells = _evenSheet();

    // Tag the sheet with its character in the library, so it stays recognised as one of the
    // character's OWN sheets (save_character accepts going back to it, or an edit made on it)
    // even after a newer sheet replaces it.
    if (characterId) {
      try {
        const { MediaLibrary } = await import('../../state/media-library.js');
        const lib = MediaLibrary.global();
        const row = await lib.getByPath(sheet);
        if (row?.id) await lib.setMetadata(row.id, { ...(row.metadata || {}), characterSheet: { characterId, sheetCells } });
      } catch (e) {
        channel.log('generate_character_sheet', `could not tag the sheet with ${characterId}: ${e.message}`);
      }
    }

    // ATTACH to the character when we have an id, so the sheet lands even if the
    // caller (e.g. the GUI, whose action call can time out on a multi-minute
    // render) never processes the return value. Read the current doc, merge the
    // sheet fields, and re-save through save_character (keeps validation +
    // indexing). Best-effort — a failure here still returns the sheet path.
    let attached = false;
    if (characterId) {
      try {
        const existing = readCharacter(characterId);
        if (existing && typeof existing.name === 'string') {
          const { default: saveCharacter, SHEET_TOOL } = await import('./save-character.js');
          const res = await saveCharacter.execute(
            { character: { ...existing, sheet, sheetCells }, [SHEET_TOOL]: true }, agent);
          attached = !!(res && res.success !== false);
        }
      } catch (e) {
        channel.log('generate_character_sheet', `attach to ${characterId} failed: ${e.message}`);
      }
    }

    channel.log('generate_character_sheet',
      `sheet ${sheet} (${sheetCells.length} cells, model ${r.model || model})` +
      `${characterId ? ` [attached=${attached}]` : ''}`);

    return {
      success: true,
      sheet,
      sheetCells,
      views: SHEET_VIEWS,
      model: r.model || model,
      ...(characterId ? { characterId, attached } : {}),
    };
  },
};
