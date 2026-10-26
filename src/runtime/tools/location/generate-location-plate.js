/**
 * generate_location_plate — generate ONE establishing VIEW of a location (the
 * SET/PLATÓ analog of a character turnaround), from a prompt the AGENT authored.
 *
 * This tool NEVER writes the prompt itself — no templates, no internal LLM call.
 * The real agent authors a PRECISE description of the location and passes it as
 * `prompt`.
 *
 * ONE call = ONE view, and **only FRONT is part of creating a location**:
 *   • FRONT (`view:'front'` → `plate`): the agent writes a faithful,
 *     element-by-element description of the empty place. This is the mandatory
 *     anchor — the SET analog of a character turnaround.
 *   • REAR / LEFT / RIGHT (→ `plateRear` / `plateLeft` / `plateRight`): OPTIONAL
 *     extra angles, generated only when the story actually needs them or the
 *     user asks. Each MUST attach the FRONT via `referenceImages` — that is what
 *     keeps the view the SAME place instead of a re-invented one.
 * Generating rear as a routine second step is NOT the flow: a location with just
 * a front view is complete.
 *
 * A plate carries no face, so there is no likeness-filter laundering.
 *
 * With a `locationId` the generated view is attached to its matching field on
 * that location doc; without one the caller attaches it with save_location.
 */

import { channel } from '../../io/channel.js';
import { readLocation } from '../../state/location-registry.js';
import generateImage from '../media/generate-image.js';
import { mediaModelsByLabel } from '../../llm/providers/gateway.js';

function _err(msg) { return { success: false, error: `generate_location_plate: ${msg}` }; }

/** The location field each view is persisted into. Every view owns its own
 *  slot — the earlier "front → plate, everything else → plateRear" rule made
 *  a LEFT view silently overwrite the REAR one. */
const _FIELD_BY_VIEW = {
  front: 'plate',
  rear:  'plateRear',
  left:  'plateLeft',
  right: 'plateRight',
};
function _isStr(v) { return typeof v === 'string'; }

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

export default {
  type: 'generate_location_plate',
  intent: 'generate_location_plate',
  description:
    'REQUIRED FIRST: activate the `locations` skill — it documents the 2-step plate procedure and the location JSON. ' +
    'Generate ONE establishing VIEW of a location (the SET analog of a character turnaround). YOU author the prompt — this tool never writes it. Build the plate in TWO steps: ' +
    'FRONT is the ONLY view a new location needs — write a PRECISE, faithful description of the empty location naming EVERY element it has (every piece of furniture, TV, clock, tiling, beams, doors, windows, lamps, the exact palette and light), call { view:"front", prompt, locationId } → saved as `plate`. ' +
    'REAR / LEFT / RIGHT are OPTIONAL extra views — generate one ONLY when the story actually needs that angle or the user asks for it, never as a routine second step. Each saves to its OWN field (`plateRear` / `plateLeft` / `plateRight`) and MUST attach the FRONT image via `referenceImages:[<front plate path>]` so it stays the SAME place. REAR = camera 180° opposite (the FRONT back wall / window now BEHIND the camera, not visible). ' +
    'Call shape: { view?: "front"|"rear"|"left"|"right" (default front), prompt (REQUIRED, you author it), referenceImages?: [absolute paths], locationId?, photos?: [absolute paths], model?, aspectRatio? }. ' +
    'model AUTO-SELECTS: explicit slug wins; else the `locations`-label model; else GPT Image 2 (the /edit variant whenever reference images are given — the REAR always references the FRONT). ' +
    'Returns: { success, view, plate|plateRear: <absolute path>, model, locationId?, attached? }. With a locationId the view is attached automatically (no follow-up save_location); without one, attach it with save_location { id, plate } or { id, plateRear }.',
  thinkingHint: (a) => `Generating location ${(_isStr(a?.view) && a.view.trim()) || 'front'} view`,
  permission: null,

  schema: {
    type: 'object',
    properties: {
      view: { type: 'string', description: 'Which view this call renders: "front" (default), "rear", "left" or "right". Each saves to its own field: front → `plate`, rear → `plateRear`, left → `plateLeft`, right → `plateRight`. Only FRONT is needed for a new location; the others are optional extra angles, and each MUST attach the FRONT via referenceImages so it stays the same place.' },
      prompt: { type: 'string', description: 'REQUIRED. The full image prompt YOU authored for THIS view — a precise, faithful, element-by-element description of the empty location. This tool NEVER writes the prompt itself.' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute paths used as reference. For the REAR/LEFT/RIGHT views, pass the FRONT plate path here so the view stays the SAME room. Any reference forces an image-editing model.' },
      locationId: { type: 'string', description: 'OPTIONAL id of a saved location (~/.koi/locations/<id>.json). The generated view is attached to its matching field (front → plate, rear → plateRear, left → plateLeft, right → plateRight).' },
      photos: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute paths to reference photos of the real place, added as references.' },
      model: { type: 'string', description: 'OPTIONAL image model slug. Omit to auto-pick.' },
      aspectRatio: { type: 'string', description: 'OPTIONAL aspect ratio. Defaults to 16:9 (a wide establishing view).' },
    },
    required: ['prompt'],
  },

  async execute(action, agent) {
    const prompt = (_isStr(action?.prompt) && action.prompt.trim()) ? action.prompt.trim() : '';
    if (!prompt) {
      return _err('needs an agent-authored `prompt` — this tool never writes the prompt itself. ' +
        'Author a precise, faithful description of the location view (see the `locations` skill) and pass it as `prompt`.');
    }

    const viewRaw = (_isStr(action?.view) && action.view.trim()) ? action.view.trim().toLowerCase() : 'front';
    const view = ['front', 'rear', 'left', 'right'].includes(viewRaw) ? viewRaw : 'front';
    const locationId = _isStr(action?.locationId) ? action.locationId.trim() : '';

    // References: caller-provided (the FRONT plate for a reverse view) + any
    // real photos of the place, sourced from the location doc when absent.
    let refs = [..._normRefs(action?.referenceImages), ..._normRefs(action?.photos)];
    if (locationId && refs.length === 0) {
      try {
        const loc = readLocation(locationId);
        if (loc && Array.isArray(loc.photos)) {
          refs = _normRefs(loc.photos);
        }
      } catch { /* location may not exist yet */ }
    }

    // MODEL: explicit slug wins; else the `locations`-label model; else GPT Image
    // 2. Any reference image makes this an EDIT op → force an edit-capable model.
    let model = (_isStr(action?.model) && action.model.trim() && action.model.trim() !== 'auto')
      ? action.model.trim()
      : null;
    if (!model) {
      try {
        const rows = await mediaModelsByLabel('image', 'locations');
        if (Array.isArray(rows) && rows.length && _isStr(rows[0]?.slug)) model = rows[0].slug;
      } catch (e) {
        channel.log('generate_location_plate', `label 'locations' resolve failed: ${e.message}`);
      }
    }
    if (!model) {
      model = refs.length ? 'openai/gpt-image-2/edit' : 'openai/gpt-image-2';
    } else if (refs.length && model === 'openai/gpt-image-2') {
      model = 'openai/gpt-image-2/edit';
    }

    const aspectRatio = (_isStr(action?.aspectRatio) && action.aspectRatio.trim())
      ? action.aspectRatio.trim()
      : '16:9';

    const genAction = {
      prompt,
      model,
      aspectRatio,
      // The plate is a one-time world anchor reused across the whole video; 4K.
      resolution: '4k',
      quality: 'high',
      outputFormat: 'png',
      _internalDelegate: true,
      label: `location_${view}`,
    };
    if (refs.length) genAction.referenceImages = refs;

    let r;
    try {
      r = await generateImage.execute(genAction, agent);
    } catch (e) {
      return _err(`${view} view generation error: ${e.message}`);
    }
    if (!r || r.success === false) {
      return _err(`${view} view generation failed: ${r?.error || 'unknown error'}`);
    }
    const img = Array.isArray(r.images) ? r.images[0] : null;
    const platePath = img?.exportedTo || img?.savedTo;
    if (!platePath) return _err('generation returned no image path.');

    // Which location field this view fills. Each view owns its OWN field:
    // folding left/right into `plateRear` (the old behaviour) meant
    // generating a side view silently OVERWROTE the reverse shot.
    const field = _FIELD_BY_VIEW[view] || 'plate';

    // ATTACH to the location when we have an id (best-effort — the GUI's action
    // call can time out on a multi-minute render, so persist here too).
    let attached = false;
    if (locationId) {
      try {
        const existing = readLocation(locationId);
        if (existing && typeof existing.name === 'string') {
          const saveLocation = (await import('./save-location.js')).default;
          const res = await saveLocation.execute(
            { location: { ...existing, [field]: platePath } }, agent);
          attached = !!(res && res.success !== false);
        }
      } catch (e) {
        channel.log('generate_location_plate', `attach to ${locationId} failed: ${e.message}`);
      }
    }

    channel.log('generate_location_plate',
      `${view} view ${platePath} (model ${r.model || model}, refs ${refs.length})${locationId ? ` [attached=${attached}]` : ''}`);

    let previz3d = [];
    if (locationId && attached) {
      try {
        const { previzForLocation } = await import('../scene3d/_previz-sync.js');
        previz3d = previzForLocation(locationId);
      } catch { /* advisory */ }
    }
    return {
      ...(previz3d.length ? { previz3d } : {}),
      success: true,
      view,
      [field]: platePath,
      model: r.model || model,
      ...(locationId ? { locationId, attached } : {}),
    };
  },
};
