/**
 * generate_object_view: generate ONE view of a story object / prop (the PROP
 * analog of a location plate), from a prompt the AGENT authored.
 *
 * This tool NEVER writes the prompt itself: no templates, no internal LLM call.
 * The real agent authors a PRECISE description of the object and passes it as
 * `prompt`.
 *
 * ONE call = ONE EXTRA view of the object's free list of views (`views`,
 * labelled by the user), on demand. The card's standard views come from ONE
 * generate_object_sheet call (three-quarter, front elevation, side profile
 * cropped from a single sheet). Every extra view attaches the sheet (first)
 * and the views already generated as references so it stays the SAME object;
 * with an `objectId` the tool adds them itself.
 *
 * With an `objectId` the image fills the view named by `viewId`, or a new view;
 * without one the caller attaches it with save_object.
 */

import { channel } from '../../io/channel.js';
import { readObject, objectViews } from '../../state/object-registry.js';
import generateImage from '../media/generate-image.js';
import { mediaModelsByLabel } from '../../llm/providers/gateway.js';

/**
 * The image model for an object image (a view or the sheet): explicit slug
 * wins; else the `objects`-label model; else GPT Image 2. Any reference image
 * makes it an EDIT op, so an edit-capable model is forced. Shared with
 * generate_object_sheet so both choose the same way.
 */
export async function resolveObjectImageModel(explicit, hasRefs, logTag = 'generate_object_view') {
  let model = (_isStr(explicit) && explicit.trim() && explicit.trim() !== 'auto')
    ? explicit.trim()
    : null;
  if (!model) {
    try {
      const rows = await mediaModelsByLabel('image', 'objects');
      if (Array.isArray(rows) && rows.length && _isStr(rows[0]?.slug)) model = rows[0].slug;
    } catch (e) {
      channel.log(logTag, `label 'objects' resolve failed: ${e.message}`);
    }
  }
  if (!model) {
    model = hasRefs ? 'openai/gpt-image-2/edit' : 'openai/gpt-image-2';
  } else if (hasRefs && model === 'openai/gpt-image-2') {
    model = 'openai/gpt-image-2/edit';
  }
  return model;
}

function _err(msg) { return { success: false, error: `generate_object_view: ${msg}` }; }

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
  type: 'generate_object_view',
  intent: 'generate_object_view',
  description:
    'REQUIRED FIRST: activate the `objects` skill: it documents the sheet + views procedure and the object JSON. ' +
    'Generate ONE EXTRA view of a story OBJECT / prop (a motorbike, a freight train, a laptop), ON DEMAND only: the card\'s standard views (three-quarter, front elevation, side profile) come from ONE generate_object_sheet call, not from this tool. The object ALONE on a clean neutral seamless background, product-shot lighting, the WHOLE object in frame. YOU author the prompt: this tool never writes it. ' +
    'Write a PRECISE, element-by-element description of the object (shape, proportions, materials, colours, markings, every part) framed as the requested view, with its `label` (e.g. "Top plan", "Rear", "Detail of the dashboard"). When the card already has an empty slot with that label (e.g. created by the GUI), fill it by passing its `viewId`. ' +
    'The view MUST attach the object\'s images as references so it stays the SAME object: with an objectId the tool attaches the card\'s sheet (first), existing views and photos itself; without one pass them in `referenceImages`. ' +
    'Call shape: { prompt (REQUIRED, you author it), objectId?, label?, viewId?, referenceImages?: [absolute paths], aspectRatio? (default 1:1), model? }. ' +
    'model AUTO-SELECTS: explicit slug wins; else the `objects`-label model; else GPT Image 2 (the /edit variant whenever reference images are given). ' +
    'Returns: { success, path: <absolute path>, viewId?, model, objectId?, attached? }. With an objectId the view is attached automatically (no follow-up save_object); without one, attach it through save_object `views`.',
  thinkingHint: (a) => `Generating object view${(_isStr(a?.label) && a.label.trim()) ? ` ${a.label.trim()}` : ''}`,
  permission: null,

  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'REQUIRED. The full image prompt YOU authored for THIS view: a precise, element-by-element description of the object alone on a clean neutral seamless background, framed as this view asks. This tool NEVER writes the prompt itself.' },
      objectId: { type: 'string', description: 'OPTIONAL id of a saved object (<project>/objects/<id>.json). The generated image is attached to its view in object.views, and the card\'s sheet + existing views + photos are attached as references.' },
      label: { type: 'string', description: 'OPTIONAL short label for a view that has none, e.g. "Top plan", "Rear", "Detail". Labels the user wrote are never overwritten.' },
      viewId: { type: 'string', description: 'OPTIONAL id of the view in object.views this image fills or replaces (e.g. an empty slot). Omit to add a new view.' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute paths used as reference (e.g. the object\'s photos, or the views already made when there is no objectId). Any reference forces an image-editing model.' },
      model: { type: 'string', description: 'OPTIONAL image model slug. Omit to auto-pick.' },
      aspectRatio: { type: 'string', description: 'OPTIONAL aspect ratio. Defaults to 1:1.' },
    },
    required: ['prompt'],
  },

  async execute(action, agent) {
    const prompt = (_isStr(action?.prompt) && action.prompt.trim()) ? action.prompt.trim() : '';
    if (!prompt) {
      return _err('needs an agent-authored `prompt`: this tool never writes the prompt itself. ' +
        'Author a precise description of the object view (see the `objects` skill) and pass it as `prompt`.');
    }

    const viewId = _isStr(action?.viewId) ? action.viewId.trim() : '';
    const label = _isStr(action?.label) ? action.label.trim() : '';
    const objectId = _isStr(action?.objectId) ? action.objectId.trim() : '';

    // References: caller-provided + the card's SHEET (first: one image with its
    // three views) + the views already made + its input photos, so every extra
    // view stays the SAME object. The view being replaced is left out while
    // another view anchors the object.
    const refs = _normRefs(action?.referenceImages);
    if (objectId) {
      try {
        const obj = readObject(objectId);
        if (obj) {
          const made = objectViews(obj).filter((v) => _isStr(v?.path) && v.path.trim());
          const others = made.filter((v) => v.id !== viewId);
          const anchors = (others.length ? others : made).map((v) => v.path.trim());
          const photos = Array.isArray(obj.photos) ? obj.photos : [];
          const sheet = _isStr(obj.sheet) ? obj.sheet.trim() : '';
          const seen = new Set(refs.map((r) => r.path));
          for (const p of [sheet, ...anchors, ...photos]) {
            if (!_isStr(p) || !p.trim() || seen.has(p.trim())) continue;
            seen.add(p.trim());
            refs.push({ alias: `ref${refs.length + 1}`, path: p.trim() });
          }
        }
      } catch { /* object may not exist yet */ }
    }

    const model = await resolveObjectImageModel(action?.model, refs.length > 0);

    const aspectRatio = (_isStr(action?.aspectRatio) && action.aspectRatio.trim())
      ? action.aspectRatio.trim()
      : '1:1';

    const genAction = {
      prompt,
      model,
      aspectRatio,
      // The views are a one-time identity anchor reused across the whole video; 4K.
      resolution: '4k',
      quality: 'high',
      outputFormat: 'png',
      _internalDelegate: true,
      label: 'object_view',
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
    const viewPath = img?.exportedTo || img?.savedTo;
    if (!viewPath) return _err('generation returned no image path.');

    // ATTACH to the object when we have an id (best-effort: the GUI's action
    // call can time out on a multi-minute render, so persist here too).
    let attached = false;
    let attachedViewId = viewId;
    if (objectId) {
      try {
        const existing = readObject(objectId);
        if (existing && typeof existing.name === 'string') {
          const saveObject = (await import('./save-object.js')).default;
          attachedViewId = viewId || `v-${Date.now()}`;
          const views = objectViews(existing);
          const known = views.some((v) => v.id === attachedViewId);
          const nextViews = known
            ? views.map((v) => (v.id === attachedViewId
              ? { ...v, path: viewPath, label: v.label || label }
              : v))
            : [...views, { id: attachedViewId, label, path: viewPath }];
          const res = await saveObject.execute(
            { object: { ...existing, views: nextViews, image: undefined } }, agent);
          attached = !!(res && res.success !== false);
        }
      } catch (e) {
        channel.log('generate_object_view', `attach to ${objectId} failed: ${e.message}`);
      }
    }

    channel.log('generate_object_view',
      `view ${attachedViewId || '(unattached)'} ${viewPath} (model ${r.model || model}, refs ${refs.length})${objectId ? ` [attached=${attached}]` : ''}`);

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
      path: viewPath,
      ...(attachedViewId ? { viewId: attachedViewId } : {}),
      model: r.model || model,
      ...(objectId ? { objectId, attached } : {}),
    };
  },
};
