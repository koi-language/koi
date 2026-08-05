/**
 * generate_location_plate — build a location ESTABLISHING PLATE (the SET/PLATÓ
 * analog of a character turnaround sheet).
 *
 * Produces ONE image: a clean, wide establishing shot of the EMPTY location
 * (no people), photorealistic unless the description says otherwise, that locks
 * the world's look / palette / lighting so every clip set here matches. Unlike
 * a character turnaround this is a single frame, not an 8-cell grid — a plate
 * carries no face, so there is no cell detection and no likeness-filter
 * laundering (a set plate never trips Seedance's face filter).
 *
 * Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the place
 * (either is enough; both is best). When only `locationId` is given, the
 * description + photos are read from that saved location.
 *
 * This tool does NOT write the location file unless a `locationId` is passed —
 * it returns { plate } for the caller (the GUI, or a follow-up save_location)
 * to persist; with a `locationId` it attaches `plate` to that location doc.
 */

import { channel } from '../../io/channel.js';
import { readLocation } from '../../state/location-registry.js';
import generateImage from '../media/generate-image.js';
import { mediaModelsByLabel } from '../../llm/providers/gateway.js';

function _err(msg) { return { success: false, error: `generate_location_plate: ${msg}` }; }
function _isStr(v) { return typeof v === 'string'; }

// The creative content is the caller-authored DESCRIPTION (and the reference
// photos); this scaffold just forces a clean, people-free establishing plate.
function _buildPlatePrompt(description, timeOfDay, palette) {
  const desc = (description && description.trim())
    ? description.trim()
    : 'a location (infer a consistent, plausible look from the reference photos)';
  const lines = [
    'Establishing location plate: ONE single wide establishing shot of the EMPTY location, photorealistic unless the description says otherwise.',
    'NO people, no characters, no figures — a clean empty set that reads as the world of the scene: architecture, layout, furniture/props in place, materials, textures, depth (foreground/midground/background).',
    `LOCATION: ${desc}.`,
  ];
  if (timeOfDay && timeOfDay.trim()) lines.push(`TIME OF DAY / LIGHT: ${timeOfDay.trim()}.`);
  if (palette && palette.trim()) lines.push(`COLOR / MOOD: ${palette.trim()}.`);
  lines.push('Natural, motivated lighting; no text, no watermark, no logos, no burned-in labels, no people.');
  return lines.join('\n');
}

export default {
  type: 'generate_location_plate',
  intent: 'generate_location_plate',
  description:
    'REQUIRED FIRST: activate the `locations` skill — it documents the location JSON. ' +
    'Generate a location ESTABLISHING PLATE: ONE clean wide shot of the EMPTY location (no people) that locks the world\'s look / palette / lighting across every clip set there. It is the SET analog of a character turnaround sheet (a scene = characters + location; each is a reusable identity anchor). ' +
    'Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the place (either is enough; both is best). When only `locationId` is given, the description + photos are read from that saved location. ' +
    'Call shape: { description?, photos?: [absolute paths], locationId?, model?, aspectRatio?, timeOfDay?, palette? }. ' +
    'model AUTO-SELECTS: an explicit slug wins; else the `locations`-label model if the catalog has one; else GPT Image 2 (edit variant when reference photos are given, else base). A plate carries no face, so no likeness-laundering is needed. Do NOT override `model` unless the user asks. ' +
    'Returns: { success, plate: <absolute path>, model, locationId?, attached? }. ' +
    'When a locationId is passed, the plate is AUTOMATICALLY attached to that location (plate saved onto its doc) — no follow-up save_location needed. Without a locationId, attach it yourself with save_location { id, plate }.',
  thinkingHint: () => 'Generating location plate',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the location looks like (architecture, layout, furniture, materials, mood). Used verbatim as the creative content of the plate.' },
      photos: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute file paths to one or more reference photos of the place, used to preserve its look.' },
      locationId: { type: 'string', description: 'OPTIONAL id of a saved location (~/.koi/locations/<id>.json). When description/photos are omitted they are sourced from this location, and the plate is attached to it.' },
      model: { type: 'string', description: 'OPTIONAL image model slug. Omit to auto-pick.' },
      aspectRatio: { type: 'string', description: 'OPTIONAL aspect ratio for the plate. Defaults to 16:9 (a wide establishing plate).' },
      timeOfDay: { type: 'string', description: 'OPTIONAL time-of-day / light note woven into the plate (e.g. "night", "golden hour").' },
      palette: { type: 'string', description: 'OPTIONAL color / mood note woven into the plate.' },
    },
  },

  async execute(action, agent) {
    let description = _isStr(action?.description) ? action.description.trim() : '';
    let photos = Array.isArray(action?.photos)
      ? action.photos.filter((p) => _isStr(p) && p.trim()).map((p) => p.trim())
      : [];
    let timeOfDay = _isStr(action?.timeOfDay) ? action.timeOfDay.trim() : '';
    let palette = _isStr(action?.palette) ? action.palette.trim() : '';
    const locationId = _isStr(action?.locationId) ? action.locationId.trim() : '';

    // Source description / photos / attrs from an existing location when absent.
    if (locationId && (!description || photos.length === 0)) {
      try {
        const loc = readLocation(locationId);
        if (loc) {
          if (!description && _isStr(loc.description)) description = loc.description.trim();
          if (photos.length === 0 && Array.isArray(loc.photos)) {
            photos = loc.photos.filter((p) => _isStr(p) && p.trim()).map((p) => p.trim());
          }
          if (!timeOfDay && _isStr(loc.timeOfDay)) timeOfDay = loc.timeOfDay.trim();
          if (!palette && _isStr(loc.palette)) palette = loc.palette.trim();
        }
      } catch { /* location may not exist yet */ }
    }

    if (!description && photos.length === 0) {
      return _err('need at least a description or one reference photo to generate a plate.');
    }

    // MODEL: explicit slug wins; else the `locations`-label model (edit variant
    // when photos exist — that's what the label tags); else GPT Image 2. A plate
    // carries no face, so no synthetic/laundering split is needed.
    let model = (_isStr(action?.model) && action.model.trim() && action.model.trim() !== 'auto')
      ? action.model.trim()
      : null;
    if (!model) {
      try {
        const rows = await mediaModelsByLabel('image', 'locations');
        if (Array.isArray(rows) && rows.length && _isStr(rows[0]?.slug)) {
          model = rows[0].slug;
        }
      } catch (e) {
        channel.log('generate_location_plate', `label 'locations' resolve failed: ${e.message}`);
      }
    }
    if (!model) {
      model = photos.length ? 'openai/gpt-image-2/edit' : 'openai/gpt-image-2';
    }

    const aspectRatio = (_isStr(action?.aspectRatio) && action.aspectRatio.trim())
      ? action.aspectRatio.trim()
      : '16:9';

    const genAction = {
      prompt: _buildPlatePrompt(description, timeOfDay, palette),
      model,
      aspectRatio,
      // The plate is a one-time world anchor reused across the whole video; 2K.
      resolution: '2k',
      quality: 'high',
      outputFormat: 'png',
      _internalDelegate: true,
      label: 'location_plate',
    };
    if (photos.length) {
      genAction.referenceImages = photos.map((p, i) => ({ alias: `ref${i + 1}`, path: p }));
    }

    let r;
    try {
      r = await generateImage.execute(genAction, agent);
    } catch (e) {
      return _err(`plate generation error: ${e.message}`);
    }
    if (!r || r.success === false) {
      return _err(`plate generation failed: ${r?.error || 'unknown error'}`);
    }
    const img = Array.isArray(r.images) ? r.images[0] : null;
    const plate = img?.exportedTo || img?.savedTo;
    if (!plate) return _err('generation returned no image path.');

    // ATTACH to the location when we have an id (best-effort — the GUI's action
    // call can time out on a multi-minute render, so persist here too).
    let attached = false;
    if (locationId) {
      try {
        const existing = readLocation(locationId);
        if (existing && typeof existing.name === 'string') {
          const saveLocation = (await import('./save-location.js')).default;
          const res = await saveLocation.execute(
            { location: { ...existing, plate } }, agent);
          attached = !!(res && res.success !== false);
        }
      } catch (e) {
        channel.log('generate_location_plate', `attach to ${locationId} failed: ${e.message}`);
      }
    }

    channel.log('generate_location_plate',
      `plate ${plate} (model ${r.model || model})${locationId ? ` [attached=${attached}]` : ''}`);

    return {
      success: true,
      plate,
      model: r.model || model,
      ...(locationId ? { locationId, attached } : {}),
    };
  },
};
