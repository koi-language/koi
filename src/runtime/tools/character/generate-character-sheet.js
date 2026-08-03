/**
 * generate_character_sheet — build a character TURNAROUND SHEET and detect its
 * crop geometry.
 *
 * Produces ONE image: a strict 4-columns x 2-rows grid (8 cells) of the same
 * character — top row = 4 full-body views (front / left / right / back), bottom
 * row = 4 head-and-shoulders portraits. The grid is drawn with THICK pure-black
 * gutter bars so it can be segmented deterministically (same convention as the
 * keyframe panel sheets), instead of trusting the model to hold exact cell
 * sizes. After generating, the sheet is run through the black-band cut-line
 * detector (`contentIslands`) and the 8 normalized cell rects are returned so
 * the visor can crop the sheet into its rotating card view.
 *
 * Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the character
 * (either is enough; both is best). When neither is passed but `characterId`
 * is, the description + photos are sourced from the existing character doc so
 * the agent can regenerate a sheet for a saved character in one call.
 *
 * This tool does NOT write the character file — it returns { sheet, sheetCells }
 * for the caller (the GUI, or a follow-up `save_character`) to persist.
 */

import { channel } from '../../io/channel.js';
import { readCharacter } from '../../state/character-registry.js';
import { contentIslands } from '../panels/_grid.js';
import generateImage from '../media/generate-image.js';
import { mediaModelsByLabel } from '../../llm/providers/gateway.js';

function _err(msg) { return { success: false, error: `generate_character_sheet: ${msg}` }; }
function _isStr(v) { return typeof v === 'string'; }

// Fixed technical layout scaffold. The creative content is the caller-authored
// DESCRIPTION (and the reference photos); everything else here is a machine
// requirement — a uniform 4x2 grid with thick pure-black gutters so the cut-line
// detector can find the 8 cells. Mirrors the keyframe-sheet separator spec.
function _buildSheetPrompt(description) {
  const desc = (description && description.trim())
    ? description.trim()
    : 'a character (infer a consistent, plausible appearance from the reference photos)';
  return [
    'Character turnaround reference sheet: ONE single image, a strict grid of 4 columns by 2 rows (8 cells total).',
    'TOP ROW — four FULL-BODY views, head to toe, standing in a neutral relaxed pose: (1) front, (2) left-side profile, (3) right-side profile, (4) back.',
    'BOTTOM ROW — four HEAD-AND-SHOULDERS portrait views of the SAME face: (1) front, (2) three-quarter, (3) side profile, (4) back of head.',
    'It is the SAME character in every cell: identical face, hairstyle, wardrobe, body proportions and colors — ONLY the camera angle changes between cells.',
    'Even, neutral studio lighting; plain light-grey seamless background; photorealistic unless the description says otherwise.',
    `CHARACTER: ${desc}.`,
    'GRID LAYOUT (CRITICAL, machine-read): separate every cell with SOLID PURE-BLACK (#000000) gutter bars — clearly THICK (about 1% of the image width, a bold bar, never a thin hairline), perfectly straight, continuous and uniform. Every column the same width, every row the same height. The black bars must run fully edge to edge so the grid is cleanly croppable. NEVER gray, never thin; no inner borders, no frames, no text, no numbers, no labels, no watermark, no drop shadows between cells.',
  ].join('\n');
}

// contentIslands returns panels as pixel rects { left, top, width, height } in
// reading order (row-major). Convert to normalized { x, y, w, h } in 0..1.
function _normalizeCells(panels, W, H) {
  if (!Array.isArray(panels) || !panels.length || !(W > 0) || !(H > 0)) return null;
  const out = panels.map((p) => ({
    x: p.left / W,
    y: p.top / H,
    w: p.width / W,
    h: p.height / H,
  }));
  return out.length ? out : null;
}

// Fallback even split when detection doesn't yield a clean grid: cols x rows
// equal cells, row-major. Crops include the gutter edges but stay usable.
function _evenGrid(cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
    }
  }
  return out;
}

export default {
  type: 'generate_character_sheet',
  intent: 'generate_character_sheet',
  description:
    'REQUIRED FIRST: activate the `characters` skill — it documents the character JSON and the voice flow. ' +
    'Generate a character TURNAROUND SHEET: one image with a 4-columns x 2-rows grid (top row = 4 full-body views front/left/right/back; bottom row = 4 face portraits) of the SAME character, drawn with thick pure-black gutter bars, then auto-detect the 8 cell rectangles. ' +
    'Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the character (either is enough; both is best). When only `characterId` is given, the description + photos are read from that saved character. ' +
    'Call shape: { description?, photos?: [absolute paths], characterId?, model?, aspectRatio? }. ' +
    'model DEFAULTS to the catalog model tagged with the `characters` label (else GPT Image 2 — edit variant when photos are given). Do NOT override it unless the user asks. ' +
    'Returns: { success, sheet: <absolute path to the generated sheet>, sheetCells: [{x,y,w,h} normalized, row-major], cols: 4, rows: 2, model, attached }. ' +
    'When a characterId is passed, the sheet is AUTOMATICALLY attached to that character (sheet + sheetCells saved onto its doc) — no follow-up save_character needed. Without a characterId, attach it yourself with save_character { id, sheet, sheetCells }.',
  thinkingHint: () => 'Generating character turnaround sheet',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the character looks like (physical traits, wardrobe, age, attitude). Used verbatim as the creative content of the sheet.' },
      photos: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute file paths to one or more reference photos of the character, used to preserve identity across the 8 views.' },
      characterId: { type: 'string', description: 'OPTIONAL id of a saved character (~/.koi/characters/<id>.json). When description/photos are omitted they are sourced from this character.' },
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

    // Source description / photos from an existing character when not passed.
    if (characterId && (!description || photos.length === 0)) {
      try {
        const ch = readCharacter(characterId);
        if (ch) {
          if (!description && _isStr(ch.description)) description = ch.description.trim();
          if (photos.length === 0 && Array.isArray(ch.photos)) {
            photos = ch.photos.filter((p) => _isStr(p) && p.trim()).map((p) => p.trim());
          }
        }
      } catch { /* character may not exist yet — fall through to the guard below */ }
    }

    if (!description && photos.length === 0) {
      return _err('need at least a description or one reference photo to generate a sheet.');
    }

    // Resolve a reference-capable image model. A pinned slug wins; otherwise
    // auto-pick from the live catalog (refsCount > 0 → the image-editing bucket,
    // where reference/identity models live).
    // MODEL: the catalog model tagged with the `characters` label; else default
    // to GPT Image 2 (the EDIT variant when we have reference photos, else base
    // text-to-image). An explicit `model` overrides both. (Seedance video does
    // its OWN Seedream conversion of the sheet, so the sheet model is free to be
    // the best character/identity model — GPT Image 2.)
    let model = (_isStr(action?.model) && action.model.trim() && action.model.trim() !== 'auto')
      ? action.model.trim()
      : null;
    if (!model) {
      try {
        const rows = await mediaModelsByLabel('image', 'characters');
        if (Array.isArray(rows) && rows.length && _isStr(rows[0]?.slug)) {
          model = rows[0].slug;
        }
      } catch (e) {
        channel.log('generate_character_sheet', `label 'characters' resolve failed: ${e.message}`);
      }
    }
    if (!model) {
      model = photos.length ? 'openai/gpt-image-2/edit' : 'openai/gpt-image-2';
    }

    const aspectRatio = (_isStr(action?.aspectRatio) && action.aspectRatio.trim())
      ? action.aspectRatio.trim()
      : '16:9';

    // Delegate to generate_image. _internalDelegate bypasses the doc-guard and
    // the read-before-use guard on referenceImages (we feed the character's
    // photos programmatically).
    const genAction = {
      prompt: _buildSheetPrompt(description),
      model,
      aspectRatio,
      resolution: 'high',
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

    // Detect the 8 cells from the black gutter bars. Fall back to an even 4x2
    // split when detection doesn't yield a clean, expected grid.
    let sheetCells = null;
    try {
      const sharp = (await import('sharp')).default;
      const det = await contentIslands({ sharp, sheet });
      if (det && det.panels && det.panels.length === 8) {
        sheetCells = _normalizeCells(det.panels, det.W, det.H);
      } else {
        channel.log('generate_character_sheet',
          `cut-line detection found ${det?.panels?.length ?? 0} cells (expected 8) — using an even 4x2 split.`);
      }
    } catch (e) {
      channel.log('generate_character_sheet', `cut-line detection failed: ${e.message} — using an even 4x2 split.`);
    }
    if (!sheetCells) sheetCells = _evenGrid(4, 2);

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
          const saveCharacter = (await import('./save-character.js')).default;
          const res = await saveCharacter.execute(
            { character: { ...existing, sheet, sheetCells } }, agent);
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
      cols: 4,
      rows: 2,
      model: r.model || model,
      ...(characterId ? { characterId, attached } : {}),
    };
  },
};
