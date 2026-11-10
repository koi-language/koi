/**
 * generate_object_detail: generate ONE story-critical DETAIL of a story
 * object / prop and attach it to the object card's `details`.
 *
 * A detail is what the story needs the object to keep exactly the same in
 * every take that the sheet alone does not lock: a CLOSE-UP of a specific
 * part (a number painted on a door, a dented tank, a gauge, a lock), or, with
 * `framing: "interior"`, a WIDE view INSIDE the object (a car cabin toward
 * the windshield, a train cab, the inside of a boxcar).
 *
 * The creative content is the AGENT's precise description of that detail
 * (`prompt`); this tool only wraps it with the fixed framing requirements
 * (insert / macro framing on the sheet's neutral background, or an interior
 * view) and ALWAYS attaches the card's sheet (or, without one, its first view
 * and photos) as reference so it is the SAME object, plus the image of the
 * detail it replaces.
 *
 * With `detailId` it fills or replaces that slot (a user label is kept);
 * without one it appends a new detail. Saved through save_object.
 */

import fs from 'fs';

import { channel } from '../../io/channel.js';
import { readObject, objectViews, objectDetails, mergeObjectDetail } from '../../state/object-registry.js';
import generateImage from '../media/generate-image.js';
import { resolveObjectImageModel } from './generate-object-view.js';

function _err(msg) { return { success: false, error: `generate_object_detail: ${msg}` }; }

function _isStr(v) { return typeof v === 'string'; }

const FRAMINGS = ['closeup', 'interior'];

const _ASPECT = { closeup: '1:1', interior: '16:9' };

// Fixed technical framing around the agent-authored DETAIL description.
// Everything here is a machine requirement (framing, background, light, the
// identity tie to the reference), never creative content.
function _buildDetailPrompt(description, framing, replacing) {
  const refs = replacing
    ? 'Every reference image except the last shows this SAME object (its reference sheet or reference views): identical materials, colours, markings and wear. The LAST reference image is the previous version of this same detail: keep what is correct and fix it to match the description.'
    : 'The reference image(s) show this SAME object (its reference sheet or reference views): identical materials, colours, markings and wear.';
  if (framing === 'interior') {
    return [
      'Interior view of an object: ONE wide image (16:9) taken INSIDE the object, looking from the viewpoint described below.',
      refs,
      'The interior must belong to that exact object: the same paint and exterior colours wherever they are seen through windows or around openings, the same trim colours, materials and finish, the same era and condition.',
      'Natural interior light consistent with the object\'s materials and colours; sharp focus, realistic detail. Empty of people unless the description says otherwise.',
      `INTERIOR: ${description}`,
      'No text overlays, captions, labels, arrows or watermark; text appears only where it is physically on the object, and then exactly as described.',
    ].join('\n');
  }
  return [
    'Detail close-up of an object: ONE image, a macro / insert shot of ONE specific part of the object, framed tight on that part so it fills the frame and reads clearly.',
    refs,
    'Same neutral light-grey seamless background and the same even studio light as the reference sheet wherever background is visible; sharp focus across the detail, realistic materials and texture.',
    `DETAIL: ${description}`,
    'No text overlays, captions, labels, arrows or watermark. If the detail IS text or a number on the object, render exactly that text, exactly as described, as part of the object\'s surface.',
  ].join('\n');
}

/** The references of a detail: the card's sheet (else its first view with an
 *  image + its photos), then the image of the detail being replaced. */
function _detailRefs(obj, detailId) {
  const sheet = _isStr(obj?.sheet) ? obj.sheet.trim() : '';
  const anchors = sheet
    ? [sheet]
    : [
      objectViews(obj).find((v) => _isStr(v?.path) && v.path.trim())?.path,
      ...(Array.isArray(obj?.photos) ? obj.photos : []),
    ];
  const prev = detailId ? objectDetails(obj).find((d) => d?.id === detailId)?.path : null;
  const seen = new Set();
  const identity = [];
  for (const p of anchors) {
    if (!_isStr(p) || !p.trim() || seen.has(p.trim()) || !fs.existsSync(p.trim())) continue;
    seen.add(p.trim());
    identity.push(p.trim());
  }
  const replacing = _isStr(prev) && prev.trim() && !seen.has(prev.trim()) && fs.existsSync(prev.trim())
    ? prev.trim() : null;
  const paths = replacing ? [...identity, replacing] : identity;
  return { identity, replacing, refs: paths.map((p, i) => ({ alias: `ref${i + 1}`, path: p })) };
}

export const _test = { _buildDetailPrompt, _detailRefs, FRAMINGS };

export default {
  type: 'generate_object_detail',
  intent: 'generate_object_detail',
  description:
    'REQUIRED FIRST: activate the `objects` skill: it documents which details a story needs and the object JSON. ' +
    'Generate ONE story-critical DETAIL of a saved story OBJECT and attach it to the card\'s `details`. framing "closeup" (default): a macro / insert close-up of ONE specific part (a number painted on a door, a dented tank, a gauge, a lock) on the sheet\'s neutral light-grey background and light, sharp, no text overlays (text only when the detail IS text on the object, exactly that text), 1:1. framing "interior": a WIDE view INSIDE the object from one viewpoint (a car cabin from the back seat toward the windshield, the driver\'s side with the dashboard, a train cab, the inside of a boxcar), natural interior light consistent with the sheet\'s materials and colours, empty of people unless told, 16:9; label it starting with "Interior:". ' +
    'YOU author `prompt`: a PRECISE description of that detail only (what part, where on the object, shape, material, colour, wear, exact text if any; for an interior, the viewpoint and everything in view). The tool adds the fixed framing. ' +
    'It ALWAYS attaches the card\'s sheet (or, without one, its first view and photos) as reference so it is the SAME object, plus the detail it replaces. The object must already have a sheet, a view or a photo. ' +
    'Call shape: { prompt (REQUIRED), objectId (REQUIRED), label?, detailId?, framing? ("closeup" | "interior") }. With detailId it fills / replaces that slot (a user label is kept); without one it appends a new detail with a fresh id. ' +
    'model AUTO-SELECTS like generate_object_view (the `objects`-label model, else the /edit variant of GPT Image 2, since references are always given). ' +
    'Returns: { success, path, detailId, model, objectId, attached }. The detail is saved onto the card automatically (no follow-up save_object). READ the result and compare it with the sheet.',
  thinkingHint: (a) => `Generating object detail${(_isStr(a?.label) && a.label.trim()) ? ` ${a.label.trim()}` : ''}`,
  permission: null,

  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'REQUIRED. YOUR precise description of THIS detail of the object (which part, where, shape, material, colour, wear, exact text if the detail is text; for an interior, the viewpoint and everything in view). The tool adds the fixed framing.' },
      objectId: { type: 'string', description: 'REQUIRED id of a saved object (<project>/objects/<id>.json). Its sheet (or first view / photos) is attached as reference and the detail is saved onto it.' },
      label: { type: 'string', description: 'OPTIONAL short label of what the detail shows, e.g. "number 4417 painted on the boxcar door", "Interior: cabin toward the windshield". A label the user wrote on the slot is never overwritten.' },
      detailId: { type: 'string', description: 'OPTIONAL id of the detail in object.details this image fills or replaces (e.g. an empty slot the user added). Omit to add a new detail.' },
      framing: { type: 'string', enum: FRAMINGS, description: 'OPTIONAL. "closeup" (default): macro / insert of one part on the neutral background. "interior": a wide 16:9 view inside the object.' },
      model: { type: 'string', description: 'Image model slug, as the objects skill says (GPT Image 2.6: the /edit variant when references are given).' },
    },
    required: ['prompt', 'objectId'],
  },

  async execute(action, agent) {
    const prompt = (_isStr(action?.prompt) && action.prompt.trim()) ? action.prompt.trim() : '';
    if (!prompt) {
      return _err('needs an agent-authored `prompt`: a precise description of the detail (see the `objects` skill). ' +
        'This tool only adds the framing around it.');
    }
    const objectId = _isStr(action?.objectId) ? action.objectId.trim() : '';
    if (!objectId) return _err('needs `objectId`: a detail always belongs to a saved object card.');
    const framing = (_isStr(action?.framing) && action.framing.trim()) ? action.framing.trim() : 'closeup';
    if (!FRAMINGS.includes(framing)) {
      return _err(`"framing" must be one of ${FRAMINGS.map((f) => `"${f}"`).join(', ')}. Got ${JSON.stringify(action.framing)}.`);
    }
    const detailId = _isStr(action?.detailId) ? action.detailId.trim() : '';
    const label = _isStr(action?.label) ? action.label.trim() : '';

    const obj = readObject(objectId);
    if (!obj || !_isStr(obj.name)) return _err(`object "${objectId}" not found: create it with save_object first.`);

    const { identity, replacing, refs } = _detailRefs(obj, detailId);
    if (!identity.length) {
      return _err(`object "${objectId}" has no sheet, view or photo to use as reference: ` +
        'generate its sheet with generate_object_sheet first, so the detail is the SAME object.');
    }

    const model = await resolveObjectImageModel(action?.model, true, 'generate_object_detail');

    const genAction = {
      prompt: _buildDetailPrompt(prompt, framing, !!replacing),
      model,
      aspectRatio: _ASPECT[framing],
      // An identity anchor reused across the whole video, like the sheet; 4K.
      resolution: '4k',
      quality: 'high',
      outputFormat: 'png',
      referenceImages: refs,
      _internalDelegate: true,
      label: 'object_detail',
    };

    let r;
    try {
      r = await generateImage.execute(genAction, agent);
    } catch (e) {
      return _err(`detail generation error: ${e.message}`);
    }
    if (!r || r.success === false) {
      return _err(`detail generation failed: ${r?.error || 'unknown error'}`);
    }
    const img = Array.isArray(r.images) ? r.images[0] : null;
    const detailPath = img?.exportedTo || img?.savedTo;
    if (!detailPath) return _err('generation returned no image path.');

    // ATTACH to the object (re-read: the card may have changed during a
    // multi-minute render).
    let attached = false;
    let attachedId = detailId;
    try {
      const existing = readObject(objectId);
      if (existing && _isStr(existing.name)) {
        const saveObject = (await import('./save-object.js')).default;
        const merged = mergeObjectDetail(objectDetails(existing), { detailId, label, path: detailPath });
        attachedId = merged.detailId;
        const res = await saveObject.execute(
          { object: { ...existing, details: merged.details, image: undefined } }, agent);
        attached = !!(res && res.success !== false);
      }
    } catch (e) {
      channel.log('generate_object_detail', `attach to ${objectId} failed: ${e.message}`);
    }

    channel.log('generate_object_detail',
      `detail ${attachedId || '(unattached)'} [${framing}] ${detailPath} (model ${r.model || model}, refs ${refs.length}) [attached=${attached}]`);

    let previz3d = [];
    if (attached) {
      try {
        const { previzForObject } = await import('../scene3d/_previz-sync.js');
        previz3d = previzForObject(objectId);
      } catch { /* advisory */ }
    }
    return {
      ...(previz3d.length ? { previz3d } : {}),
      success: true,
      path: detailPath,
      detailId: attachedId,
      model: r.model || model,
      objectId,
      attached,
    };
  },
};
