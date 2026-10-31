/**
 * generate_object_sheet: build ONE object SHEET (the PROP analog of a
 * character turnaround sheet) and crop it into the card's three views.
 *
 * Produces ONE landscape image laid out as three panels separated by THICK
 * pure-black bands (same convention as the character / keyframe sheets, so it
 * can be segmented deterministically): the LEFT HALF, full height, is the
 * object in a three-quarter view from slightly above (the hero); the RIGHT
 * HALF is two stacked quarters, a front elevation on top and a side profile
 * below. The creative content is the AGENT's element-by-element description
 * of the object (`prompt`); this tool only wraps it with the fixed layout.
 *
 * The cells are detected with the black-band island detector
 * (`contentIslands`), ordered [threeQuarter, front, side], and each is cropped
 * to its own lossless PNG next to the sheet. With an `objectId` the sheet, its
 * cells and the three crops (as views threeQuarter / front / side, placed
 * first) are saved onto the card through save_object.
 */

import fs from 'fs';
import path from 'path';

import { channel } from '../../io/channel.js';
import { readObject, objectViews, SHEET_VIEW_IDS } from '../../state/object-registry.js';
import { contentIslands, geometryCachePath } from '../panels/_grid.js';
import generateImage from '../media/generate-image.js';
import { resolveObjectImageModel } from './generate-object-view.js';

function _err(msg) { return { success: false, error: `generate_object_sheet: ${msg}` }; }

function _isStr(v) { return typeof v === 'string'; }

const _VIEW_LABELS = {
  threeQuarter: 'Three-quarter',
  front: 'Front (elevation)',
  side: 'Side (profile)',
};

// Fixed geometry when detection does not yield the three panels: left half;
// right-top quarter; right-bottom quarter, inset a little for the bands.
const _FIXED_CELLS = [
  { x: 0.01, y: 0.015, w: 0.48, h: 0.97 },
  { x: 0.51, y: 0.015, w: 0.48, h: 0.47 },
  { x: 0.51, y: 0.515, w: 0.48, h: 0.47 },
];

// Fixed technical layout scaffold around the agent-authored OBJECT
// description. Everything here is a machine requirement (the panel layout and
// the black bands the cell detector reads), never creative content.
function _buildSheetPrompt(description) {
  return [
    'Object reference sheet: ONE single landscape image (3:2, high resolution) made of exactly THREE panels showing the SAME object.',
    'LEFT HALF of the image, full height: the object in a THREE-QUARTER view from slightly above (the hero view).',
    'RIGHT HALF of the image, split into two stacked quarters: TOP = FRONT ELEVATION (straight-on from the front, orthographic look, long lens, no perspective distortion); BOTTOM = SIDE PROFILE (exact side, orthographic look, long lens, no perspective distortion).',
    'It is the SAME object in all three panels: identical shape, proportions, materials, colours, markings and wear; the same scale feel and the same even studio light in every panel. ONLY the camera angle changes.',
    'Every panel has the same neutral light-grey seamless background; the WHOLE object fits inside each panel with a small margin, never cropped.',
    `OBJECT: ${description}`,
    'PANEL LAYOUT (CRITICAL, machine-read): separate the panels with SOLID PURE-BLACK (#000000) bands, clearly THICK (about 1% of the image width, a bold bar, never a thin hairline), perfectly straight, continuous and uniform: one vertical band down the middle of the image from top to bottom, and one horizontal band across the RIGHT half only, from the vertical band to the right edge. NEVER gray, never thin; no frames, no text, no labels, no numbers, no arrows, no dimensions, no watermark.',
  ].join('\n');
}

// Normalize referenceImages: accept a plain path array OR [{alias, path}].
function _normRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  let i = 0;
  for (const r of refs) {
    i += 1;
    if (_isStr(r) && r.trim()) out.push({ alias: `ref${i}`, path: r.trim() });
    else if (r && typeof r === 'object' && _isStr(r.path) && r.path.trim()) {
      out.push({ alias: (_isStr(r.alias) && r.alias.trim()) ? r.alias.trim() : `ref${i}`, path: r.path.trim() });
    }
  }
  return out;
}

// Pixel rects { left, top, width, height } → [threeQuarter, front, side]:
// the largest is the hero, the upper of the other two the front elevation.
function _orderCells(panels) {
  if (!Array.isArray(panels) || panels.length !== 3) return null;
  const byArea = [...panels].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const [hero, ...rest] = byArea;
  rest.sort((a, b) => a.top - b.top);
  return [hero, ...rest];
}

/**
 * Detect the three panels with contentIslands. Its horizontal cut lines must
 * cross the whole sheet, so the right-half band (which stops at the hero
 * panel) usually reads as ONE right island: in that case the right island is
 * cropped to a temporary lossless PNG and segmented on its own, then mapped
 * back. Returns three pixel rects in [threeQuarter, front, side] order, or
 * null when the sheet does not read as three panels.
 */
async function _detectCells(sharp, sheet) {
  const det = await contentIslands({ sharp, sheet });
  const panels = det?.panels || [];
  if (panels.length === 3) return { W: det.W, H: det.H, cells: _orderCells(panels) };
  if (panels.length !== 2) return null;
  const [left, right] = [...panels].sort((a, b) => a.left - b.left);
  if (right.left < left.left + left.width) return null;
  const tmp = path.join(path.dirname(sheet),
    `${path.basename(sheet).replace(/\.[a-z0-9]+$/i, '')}-right-${process.pid}-${Date.now()}.png`);
  try {
    await sharp(sheet)
      .extract({ left: right.left, top: right.top, width: right.width, height: right.height })
      .png({ compressionLevel: 9 })
      .toFile(tmp);
    const sub = await contentIslands({ sharp, sheet: tmp });
    const subPanels = sub?.panels || [];
    if (subPanels.length !== 2) return null;
    const mapped = subPanels.map((p) => ({
      left: right.left + p.left, top: right.top + p.top, width: p.width, height: p.height,
    }));
    return { W: det.W, H: det.H, cells: _orderCells([left, ...mapped]) };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    try { fs.rmSync(path.dirname(geometryCachePath(tmp)), { recursive: true, force: true }); } catch { /* */ }
  }
}

// Crop each normalized cell to its own lossless PNG next to the sheet, inset
// by a few pixels so no black band bleeds into the crop.
async function _cropCells(sharp, sheet, cells, W, H) {
  const base = path.join(path.dirname(sheet), path.basename(sheet).replace(/\.[a-z0-9]+$/i, ''));
  const pad = Math.max(2, Math.round(Math.min(W, H) * 0.004));
  const out = [];
  for (let i = 0; i < SHEET_VIEW_IDS.length; i++) {
    const c = cells[i];
    const left = Math.max(0, Math.round(c.x * W) + pad);
    const top = Math.max(0, Math.round(c.y * H) + pad);
    const width = Math.max(8, Math.min(W - left, Math.round(c.w * W) - pad * 2));
    const height = Math.max(8, Math.min(H - top, Math.round(c.h * H) - pad * 2));
    const file = `${base}-${SHEET_VIEW_IDS[i]}.png`;
    await sharp(sheet).extract({ left, top, width, height }).png({ compressionLevel: 9 }).toFile(file);
    out.push(file);
  }
  return out;
}

/**
 * The card's views after a sheet: the three crops first (threeQuarter, front,
 * side; user labels kept, defaults only on empty labels), then every other
 * view untouched, minus an empty legacy `top` slot.
 */
export function mergeSheetViews(views, crops) {
  const list = Array.isArray(views) ? views : [];
  const first = SHEET_VIEW_IDS.map((id, i) => {
    const prev = list.find((v) => v?.id === id);
    return { ...(prev || {}), id, label: (prev && _isStr(prev.label) && prev.label.trim()) ? prev.label : _VIEW_LABELS[id], path: crops[i] };
  });
  const rest = list.filter((v) => !SHEET_VIEW_IDS.includes(v?.id) &&
    !(v?.id === 'top' && !(_isStr(v.path) && v.path.trim())));
  return [...first, ...rest];
}

export const _test = { _orderCells, _detectCells, _cropCells, _FIXED_CELLS, _buildSheetPrompt };

export default {
  type: 'generate_object_sheet',
  intent: 'generate_object_sheet',
  description:
    'REQUIRED FIRST: activate the `objects` skill: it documents the sheet procedure and the object JSON. ' +
    'Generate the object SHEET of a story OBJECT / prop (a motorbike, a freight train, a laptop): ONE landscape image (3:2) with THREE panels of the SAME object on a neutral light-grey seamless background, separated by thick pure-black bands: LEFT HALF (full height) = three-quarter view from slightly above (the hero); RIGHT HALF top quarter = front elevation (straight-on, orthographic look); RIGHT HALF bottom quarter = side profile (exact side, orthographic look). No text or labels. ' +
    'YOU author `prompt`: a PRECISE, element-by-element description of the OBJECT itself (shape, proportions, materials, colours, markings, wear, every part), with NO layout or camera words: the tool wraps it with the fixed layout. ' +
    'The three panels are detected and cropped into their own PNGs. With an objectId they are saved onto the card AUTOMATICALLY (no follow-up save_object): sheet + sheetCells, and the views threeQuarter / front / side (the crops, placed first, so the card image is the three-quarter crop); without referenceImages the card\'s photos (and its previous sheet when regenerating) are attached as references. ' +
    'Call shape: { prompt (REQUIRED, you author it), objectId?, referenceImages?: [absolute paths] }. ' +
    'model AUTO-SELECTS like generate_object_view: the `objects`-label model, else GPT Image 2 (the /edit variant whenever reference images are given). ' +
    'Returns: { success, sheet: <absolute path>, sheetCells: [{x,y,w,h} normalized: threeQuarter, front, side], views: [{id,label,path}], model, objectId?, attached? }. READ the sheet afterwards and check the three panels show the same object correctly.',
  thinkingHint: () => 'Generating object sheet',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'REQUIRED. YOUR precise, element-by-element description of the OBJECT itself (shape, proportions, materials, colours, markings, wear). No layout, panel or camera words: the tool adds the fixed sheet layout.' },
      objectId: { type: 'string', description: 'OPTIONAL id of a saved object (<project>/objects/<id>.json). The sheet, its cells and the three cropped views are saved onto it, and its photos (+ previous sheet) are attached as references when referenceImages is omitted.' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute paths used as reference (e.g. photos of the object). Any reference forces an image-editing model.' },
    },
    required: ['prompt'],
  },

  async execute(action, agent) {
    const prompt = (_isStr(action?.prompt) && action.prompt.trim()) ? action.prompt.trim() : '';
    if (!prompt) {
      return _err('needs an agent-authored `prompt`: a precise description of the object itself (see the `objects` skill). ' +
        'This tool only adds the sheet layout around it.');
    }
    const objectId = _isStr(action?.objectId) ? action.objectId.trim() : '';

    // References: caller-provided; else, with an objectId, the card's previous
    // sheet (when regenerating) and its input photos.
    const refs = _normRefs(action?.referenceImages);
    if (!refs.length && objectId) {
      try {
        const obj = readObject(objectId);
        if (obj) {
          const seen = new Set();
          const prevSheet = _isStr(obj.sheet) ? obj.sheet.trim() : '';
          for (const p of [prevSheet, ...(Array.isArray(obj.photos) ? obj.photos : [])]) {
            if (!_isStr(p) || !p.trim() || seen.has(p.trim()) || !fs.existsSync(p.trim())) continue;
            seen.add(p.trim());
            refs.push({ alias: `ref${refs.length + 1}`, path: p.trim() });
          }
        }
      } catch { /* object may not exist yet */ }
    }

    const model = await resolveObjectImageModel(null, refs.length > 0, 'generate_object_sheet');

    const genAction = {
      prompt: _buildSheetPrompt(prompt),
      model,
      aspectRatio: '3:2',
      // One-time identity anchor reused across the whole video; 4K like the views.
      resolution: '4k',
      quality: 'high',
      outputFormat: 'png',
      _internalDelegate: true,
      label: 'object_sheet',
    };
    if (refs.length) genAction.referenceImages = refs;

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

    let sharp;
    try {
      sharp = (await import('sharp')).default;
    } catch (e) {
      return _err(`image library unavailable: ${e.message}`);
    }
    let W = 0, H = 0;
    let sheetCells = null;
    try {
      const meta = await sharp(sheet).metadata();
      W = meta.width; H = meta.height;
      const det = await _detectCells(sharp, sheet);
      if (det?.cells) {
        sheetCells = det.cells.map((p) => ({ x: p.left / det.W, y: p.top / det.H, w: p.width / det.W, h: p.height / det.H }));
      } else {
        channel.log('generate_object_sheet', 'island detection did not yield 3 panels: using the fixed sheet geometry.');
      }
    } catch (e) {
      channel.log('generate_object_sheet', `cell detection failed: ${e.message}: using the fixed sheet geometry.`);
    }
    if (!sheetCells) sheetCells = _FIXED_CELLS.map((c) => ({ ...c }));
    if (!(W > 0) || !(H > 0)) return _err(`could not read the generated sheet ${sheet}.`);

    let crops;
    try {
      crops = await _cropCells(sharp, sheet, sheetCells, W, H);
    } catch (e) {
      return _err(`cropping the sheet failed: ${e.message}`);
    }
    let views = SHEET_VIEW_IDS.map((id, i) => ({ id, label: _VIEW_LABELS[id], path: crops[i] }));

    // ATTACH to the object when we have an id (best-effort: the GUI's action
    // call can time out on a multi-minute render, so persist here too).
    let attached = false;
    if (objectId) {
      try {
        const existing = readObject(objectId);
        if (existing && typeof existing.name === 'string') {
          const saveObject = (await import('./save-object.js')).default;
          const nextViews = mergeSheetViews(objectViews(existing), crops);
          const res = await saveObject.execute(
            { object: { ...existing, sheet, sheetCells, views: nextViews, image: undefined } }, agent);
          attached = !!(res && res.success !== false);
          if (attached) views = nextViews.slice(0, SHEET_VIEW_IDS.length);
        }
      } catch (e) {
        channel.log('generate_object_sheet', `attach to ${objectId} failed: ${e.message}`);
      }
    }

    channel.log('generate_object_sheet',
      `sheet ${sheet} (model ${r.model || model}, refs ${refs.length})${objectId ? ` [attached=${attached}]` : ''}`);

    let previz3d = [];
    if (objectId && attached) {
      try {
        const { previzForObject } = await import('../scene3d/_previz-sync.js');
        previz3d = previzForObject(objectId);
      } catch { /* advisory */ }
    }
    return {
      ...(previz3d.length ? { previz3d } : {}),
      success: true,
      sheet,
      sheetCells,
      views,
      model: r.model || model,
      ...(objectId ? { objectId, attached } : {}),
    };
  },
};
