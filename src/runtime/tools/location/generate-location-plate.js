/**
 * generate_location_plate — generate ONE establishing VIEW of a location (the
 * SET/PLATÓ analog of a character turnaround), from a prompt the AGENT authored.
 *
 * This tool NEVER writes the prompt itself — no templates, no internal LLM call.
 * The real agent authors a PRECISE description of the location and passes it as
 * `prompt`.
 *
 * ONE call = ONE view of the location's free list of views (`views`, labelled
 * by the user; there are no fixed angles). The first image is the anchor: it
 * must describe the empty place element by element. Any further view is optional,
 * generated only when the story needs it or the user asks, and MUST attach the
 * anchor via `referenceImages` so it stays the SAME place.
 *
 * A plate carries no face, so there is no likeness-filter laundering.
 *
 * With a `locationId` the image fills the view named by `viewId`, or a new view;
 * without one the caller attaches it with save_location.
 */

import { channel } from '../../io/channel.js';
import { readLocation, locationViews } from '../../state/location-registry.js';
import generateImage from '../media/generate-image.js';
import { mediaModelsByLabel } from '../../llm/providers/gateway.js';

function _err(msg) { return { success: false, error: `generate_location_plate: ${msg}` }; }

// The location's 3D set is built by default as soon as it has an image: the order for it.
async function _setModelNext(locationId, attached) {
  if (!locationId || !attached) return {};
  try {
    const { setModel3dNext } = await import('./save-location.js');
    const next = setModel3dNext(readLocation(locationId));
    return next ? { next } : {};
  } catch { return {}; }
}

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
    'REQUIRED FIRST: activate the `locations` skill — it documents the plate procedure and the location JSON. ' +
    'Generate ONE establishing VIEW of a location (the SET analog of a character turnaround). YOU author the prompt — this tool never writes it. ' +
    'A location has a free list of views labelled by the user, with no fixed angles. The first image is all a new location needs — write a PRECISE, faithful description of the empty location naming EVERY element it has (every piece of furniture, TV, clock, tiling, beams, doors, windows, lamps, the exact palette and light), call { prompt, locationId }. ' +
    'Any further view is OPTIONAL — generate one ONLY when the story actually needs it or the user asks, never as a routine second step, and it MUST attach the location\'s `plate` via `referenceImages:[<plate path>]` so it stays the SAME place. ' +
    'Call shape: { prompt (REQUIRED, you author it), viewId?, label?, referenceImages?: [absolute paths], locationId?, photos?: [absolute paths], model?, aspectRatio? }. ' +
    'model AUTO-SELECTS: explicit slug wins; else the `locations`-label model; else GPT Image 2 (the /edit variant whenever reference images are given). ' +
    'Returns: { success, path: <absolute path>, viewId?, model, locationId?, attached? }. With a locationId the view is attached automatically (no follow-up save_location); without one, attach it through save_location `views`.',
  thinkingHint: (a) => `Generating location view${(_isStr(a?.label) && a.label.trim()) ? ` ${a.label.trim()}` : ''}`,
  permission: null,

  schema: {
    type: 'object',
    properties: {
      viewId: { type: 'string', description: 'OPTIONAL id of the view in location.views this image fills or replaces. Omit to add a new view.' },
      label: { type: 'string', description: 'OPTIONAL short label for a view that has none. Labels the user wrote are never overwritten.' },
      prompt: { type: 'string', description: 'REQUIRED. The full image prompt YOU authored for THIS view — a precise, faithful, element-by-element description of the empty location. This tool NEVER writes the prompt itself.' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute paths used as reference. For any view after the first, pass the location plate path here so the view stays the SAME room. Any reference forces an image-editing model.' },
      locationId: { type: 'string', description: 'OPTIONAL id of a saved location (<project>/locations/<id>.json). The generated image is attached to its view in location.views.' },
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

    const viewId = _isStr(action?.viewId) ? action.viewId.trim() : '';
    const label = _isStr(action?.label) ? action.label.trim() : '';
    const locationId = _isStr(action?.locationId) ? action.locationId.trim() : '';

    // References: caller-provided (the location's plate for an extra view) + any
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
      model = refs.length ? 'openai/gpt-image-2.6/sunburst/edit' : 'openai/gpt-image-2.6/sunburst/text-to-image';
    } else if (refs.length && /^openai\/gpt-image-2(\.\d+\/[a-z]+)?(\/text-to-image)?$/.test(model)) {
      model = model.replace(/\/text-to-image$/, '') + '/edit';
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
      label: 'location_view',
    };
    if (refs.length) genAction.referenceImages = refs;

    let r;
    try {
      r = await generateImage.execute(genAction, agent);
    } catch (e) {
      return _err(`view generation error: ${e.message}`);
    }
    if (!r || r.success === false) {
      return _err(`view generation failed: ${r?.error || 'unknown error'}`);
    }
    const img = Array.isArray(r.images) ? r.images[0] : null;
    const platePath = img?.exportedTo || img?.savedTo;
    if (!platePath) return _err('generation returned no image path.');

    // ATTACH to the location when we have an id (best-effort — the GUI's action
    // call can time out on a multi-minute render, so persist here too).
    let attached = false;
    let attachedViewId = viewId;
    if (locationId) {
      try {
        const existing = readLocation(locationId);
        if (existing && typeof existing.name === 'string') {
          const saveLocation = (await import('./save-location.js')).default;
          attachedViewId = viewId || `v-${Date.now()}`;
          const views = locationViews(existing);
          const known = views.some((v) => v.id === attachedViewId);
          const nextViews = known
            ? views.map((v) => (v.id === attachedViewId
              ? { ...v, path: platePath, label: v.label || label }
              : v))
            : [...views, { id: attachedViewId, label, path: platePath }];
          const res = await saveLocation.execute(
            { location: { ...existing, views: nextViews, plate: undefined } }, agent);
          attached = !!(res && res.success !== false);
        }
      } catch (e) {
        channel.log('generate_location_plate', `attach to ${locationId} failed: ${e.message}`);
      }
    }

    channel.log('generate_location_plate',
      `view ${attachedViewId || '(unattached)'} ${platePath} (model ${r.model || model}, refs ${refs.length})${locationId ? ` [attached=${attached}]` : ''}`);

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
      path: platePath,
      ...(attachedViewId ? { viewId: attachedViewId } : {}),
      model: r.model || model,
      ...(locationId ? { locationId, attached } : {}),
      ...(await _setModelNext(locationId, attached)),
    };
  },
};
