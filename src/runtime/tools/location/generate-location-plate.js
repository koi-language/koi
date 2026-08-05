/**
 * generate_location_plate — build a location VIEWS SHEET (the SET/PLATÓ analog
 * of a character turnaround sheet).
 *
 * Produces ONE image: a 1-column × 4-ROW sheet of the SAME EMPTY location (no
 * people) — 4 WIDE PANORAMIC camera views (FRONT, REAR, LEFT, RIGHT), each row
 * labelled in its black gutter — that locks the world's look / palette /
 * lighting so every clip set here matches. It is generated DIRECTLY as one image
 * (the model draws the grid); we then detect the 4 cell rects so the GUI can
 * crop each view. NO pre-processing (no floor-plan authoring, no derived
 * per-view renders) — one generation, straight to the sheet, at 4K.
 *
 * A plate carries no face, so there is no likeness-filter laundering (a set
 * plate never trips Seedance's face filter).
 *
 * Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the place
 * (either is enough; both is best). When only `locationId` is given, the
 * description + photos are read from that saved location.
 *
 * This tool does NOT write the location file unless a `locationId` is passed —
 * it returns { plate, plateCells } for the caller (the GUI, or a follow-up
 * save_location) to persist; with a `locationId` it attaches them to that doc.
 */

import { channel } from '../../io/channel.js';
import { readLocation } from '../../state/location-registry.js';
import generateImage from '../media/generate-image.js';
import { mediaModelsByLabel, getGatewayBase, getAuthHeaders } from '../../llm/providers/gateway.js';

function _err(msg) { return { success: false, error: `generate_location_plate: ${msg}` }; }
function _isStr(v) { return typeof v === 'string'; }

// GUIDANCE (system prompt) for the model that WRITES the image prompt. The tool
// never hardcodes the creative wording — an LLM authors the actual image prompt,
// tailored to the specific location, from this guidance. Only the structural
// contract the downstream cropping depends on (1×N grid, black gutters, the row
// labels) is pinned here as a requirement the authored prompt must satisfy.
// `viewLabels` is 2 (FRONT/REAR, the default) or 4 (FRONT/REAR/LEFT/RIGHT).
function _platePromptSystem(viewLabels) {
  const n = viewLabels.length;
  const rowsList = viewLabels.map((l, i) => `ROW ${i + 1} "${l}"`).join(', ');
  const labelList = viewLabels.map((l) => `"${l}"`).join(', ');
  const lines = [
    'You are a location / set art director writing ONE image-generation prompt (plain text only — no preamble, no markdown, no quotes) for a photorealistic view of a specific EMPTY location (no people, no characters, no figures).',
    '',
    '### 1. DESCRIBE THE PLACE IN FULL — this is your main job.',
    'The LOCATION text you are given is the SOURCE OF TRUTH. Your prompt MUST be a RICH, SPECIFIC, vivid description of THAT exact place — never a thin or generic one-liner like "a traditional Spanish dining room at night". Reproduce FAITHFULLY and by name EVERY concrete element the description mentions — do NOT drop or genericize a single one. If the description says there is a TELEVISION, a WALL CLOCK, a china cabinet / vitrina, a sideboard, azulejo tiling, ceiling beams, a specific dining table, a chandelier, curtains, plants, framed paintings, a balcony — then ALL of those must appear, described concretely (material, wood tone, style, period, size, where it sits). Then enrich with the plausible specifics such a place would have (surfaces, textures, floor, walls, moldings, the exact light sources and how the light falls, the palette, the era and mood). Only fill gaps in a way consistent with the description; never contradict it and never leave out what it names.',
    'Before writing, mentally list the key objects the description implies (e.g. "TV in the corner, wall clock over the sideboard, vitrina on the right, 8 chairs, balcony with the city behind") and make sure each one is in your prompt.',
    '',
    '### 2. FRAME IT AS A VIEWS SHEET.',
    `The image is a strict grid of 1 COLUMN by ${n} ROWS (${n} cells stacked vertically) of the SAME place. The ${n} rows, top to bottom, are ${rowsList}. Each row is a WIDE PANORAMIC (ultra-wide, letterbox) view of the WHOLE location. FRONT and REAR look at it from OPPOSITE sides (exactly 180° apart) — in the REAR view the wall the FRONT camera stood at is now in front, and the FRONT view's back wall (with its window / balcony) is now BEHIND the camera and NOT visible.`,
  ];
  if (n === 4) {
    lines.push('LEFT SIDE and RIGHT SIDE look at it from the two opposite lateral sides (90° from FRONT, and its opposite). These side views exist ONLY because front + rear cannot fully capture this location (an exterior / a building or house seen from outside).');
  }
  lines.push('');
  lines.push('### 3. KEEP IT ONE COHERENT PLACE.');
  lines.push('Every row depicts ONE identical place — fix one mental floor plan and keep it: the SAME architecture, the SAME furniture / features in the SAME positions against the SAME walls. Every UNIQUE object is the SAME SINGLE object in the SAME fixed spot in EVERY view (the ONE television, the ONE wall clock, the ONE sideboard stay in their ONE corner and simply face the camera from a different side as it moves — NEVER duplicated, NEVER on a different wall between rows). The COUNT of every repeated object is identical across rows (same number of chairs / windows / pictures). It must be possible to reconstruct ONE single coherent 3D place from the rows.');
  lines.push('');
  lines.push('### 4. TECHNICAL (machine-cropped — state it briefly at the end).');
  lines.push(`The strict 1-column × ${n}-row grid; rows separated by THICK solid pure-black (#000000) horizontal gutter bars running fully edge to edge so the grid is cleanly croppable, every row equal height and full width, no columns; a SMALL clean sans-serif UPPERCASE label inside the black bar right above each row reading exactly ${labelList} (top to bottom), gutters staying overwhelmingly black; no people, no other text, no watermark, no logos.`);
  lines.push('');
  lines.push('Output ONLY the final image prompt — and make it detailed and specific to the place, not generic.');
  return lines.join('\n');
}

// Author the image prompt via the LLM. Works from BOTH an agent run
// (agent.llmProvider) AND the GUI button (agent === null → standalone gateway
// call, mirroring storyboard-image-prompt Path B). Returns the prompt text, or
// null when unavailable (→ caller returns a clear error; NO template fallback).
async function _authorPlatePrompt(agent, description, timeOfDay, palette, viewLabels) {
  const user = [
    `LOCATION: ${(description && description.trim()) || '(infer a consistent, plausible look from the reference photos)'}`,
    timeOfDay && timeOfDay.trim() ? `TIME OF DAY / LIGHT: ${timeOfDay.trim()}` : '',
    palette && palette.trim() ? `COLOR / MOOD: ${palette.trim()}` : '',
  ].filter(Boolean).join('\n');
  const messages = [
    { role: 'system', content: _platePromptSystem(viewLabels) },
    { role: 'user', content: user },
  ];
  try {
    let text = '';
    if (agent?.llmProvider) {
      // Path A: agent-bound.
      const llm = agent.llmProvider._createLLM({ maxTokens: 2200, temperature: 0.6 });
      const r = await llm.complete(messages, {});
      text = r?.text || '';
    } else {
      // Path B: standalone (GUI executeAction passes agent=null) — pick a capable
      // reasoning model from the catalog and POST directly to the gateway.
      if (!process.env.KOI_AUTH_TOKEN) {
        channel.log('generate_location_plate', 'prompt: no agent and no KOI_AUTH_TOKEN — cannot author the image prompt.');
        return null;
      }
      const { selectAutoModel, getAvailableProviders, loadRemoteModels } =
        await import('../../llm/auto-model-selector.js');
      // The model catalog loads async; force-load it first so the provider list
      // isn't empty when the tool runs before the catalog is warm.
      try { await loadRemoteModels(); } catch { /* fall through */ }
      const providers = getAvailableProviders();
      const selected = providers?.length ? selectAutoModel('reasoning', 55, providers, {}) : null;
      if (!selected?.model) {
        channel.log('generate_location_plate', `prompt: no reasoning model matched (providers=${JSON.stringify(providers)}).`);
        return null;
      }
      const res = await fetch(`${getGatewayBase()}/chat/completions`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ model: selected.model, messages, max_tokens: 2200, temperature: 0.6 }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        channel.log('generate_location_plate', `prompt: gateway ${res.status}: ${body.slice(0, 200)}`);
        return null;
      }
      const parsed = await res.json();
      text = parsed?.choices?.[0]?.message?.content || '';
    }
    const cleaned = String(text || '')
      .replace(/^\s*```(?:\w+)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    return cleaned || null;
  } catch (e) {
    channel.log('generate_location_plate', `prompt authoring failed: ${e.message}`);
    return null;
  }
}

// ── Cell detection (ported from generate-character-sheet.js) ─────────────────
// Maximal runs along an axis where the MEAN brightness stays ABOVE the gutter
// threshold T (i.e. real content, not a pure-black gutter bar), each ≥ minFrac
// of the extent (rejects slivers / the small gutter labels).
function _contentBands(mean, extent, T, minFrac) {
  const bands = [];
  let s = -1;
  for (let i = 0; i < extent; i++) {
    if (mean[i] > T) { if (s < 0) s = i; }
    else if (s >= 0) { if (i - s >= minFrac * extent) bands.push([s, i]); s = -1; }
  }
  if (s >= 0 && extent - s >= minFrac * extent) bands.push([s, extent]);
  return bands;
}
// Sweep the gutter brightness threshold; take the first that yields EXACTLY
// nCells content bands. Brightness-based (not dark-fraction) so a DARK night
// scene — which still has bright highlights (a lamp) and brown walls well above
// pure black — is never mistaken for a black gutter bar. Robust to labels in
// the gutters (a few white label pixels don't lift the bar's mean much).
function _axisCells(mean, extent, nCells, minFrac) {
  for (let T = 6; T <= 34; T += 2) {
    const b = _contentBands(mean, extent, T, minFrac);
    if (b.length === nCells) return b;
  }
  return null;
}
// Line-based cols×rows detector: finds the cut lines from the per-column /
// per-row MEAN brightness (a gutter bar is near-pure-black → very low mean),
// then builds the cell matrix. Returns row-major normalized { x, y, w, h }
// cells, or null when unreadable. Works for a bright studio turnaround AND a
// dark night location plate (both separate content from pure-black gutters).
async function _detectSheetCells(sharp, sheet, cols, rows) {
  const { data, info } = await sharp(sheet).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  if (!(W > 0) || !(H > 0)) return null;
  const colMean = new Float64Array(W);
  const rowMean = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W * ch;
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      const v = data[base + x * ch];
      rowSum += v;
      colMean[x] += v;
    }
    rowMean[y] = rowSum / W;
  }
  for (let x = 0; x < W; x++) colMean[x] /= H;
  // Single-column sheet (the location 1×4 views sheet): the whole width is one
  // column, so skip column detection and just split the rows.
  const cx = cols === 1 ? [[0, W]] : _axisCells(colMean, W, cols, 0.08);
  const ry = _axisCells(rowMean, H, rows, 0.06);
  if (!cx || !ry) return null;
  const cells = [];
  for (const [y0, y1] of ry) {
    for (const [x0, x1] of cx) {
      cells.push({ x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });
    }
  }
  return cells;
}
// Fallback even split, row-major.
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
  type: 'generate_location_plate',
  intent: 'generate_location_plate',
  description:
    'REQUIRED FIRST: activate the `locations` skill — it documents the location JSON. ' +
    'Generate a location VIEWS SHEET (SET analog of a character turnaround sheet): a 1-column sheet of the SAME EMPTY location (no people). BY DEFAULT just 2 rows — ROW 1 FRONT VIEW + ROW 2 REAR VIEW (two wide establishing views of the SAME place from opposite sides) — because fewer views means fewer chances for the model to contradict itself. ONLY an EXTERIOR (locationType "exterior": a building / house that front+rear cannot capture) gets 4 rows: FRONT / REAR / LEFT SIDE / RIGHT SIDE. Each row is LABELLED. ' +
    'HOW: an LLM first WRITES the image prompt tailored to the location (never a hardcoded template — pass your own `prompt` to override), then it is generated as ONE image (the model draws the grid) at 4K, and the cell rects are detected so each view can be cropped. ' +
    'Inputs: a DESCRIPTION and/or one or more reference PHOTOS of the place (either is enough; both is best). When only `locationId` is given, the description + photos are read from that saved location. ' +
    'Call shape: { description?, photos?: [absolute paths], locationId?, model?, aspectRatio?, timeOfDay?, palette? }. ' +
    'model AUTO-SELECTS: an explicit slug wins; else the `locations`-label model if the catalog has one; else GPT Image 2 (edit variant when reference photos are given, else base). Do NOT override `model` unless the user asks. ' +
    'Returns: { success, plate: <absolute path>, plateCells: [4 {x,y,w,h}], views: [4 labels], model, locationId?, attached? }. ' +
    'When a locationId is passed, the sheet + its detected cells are AUTOMATICALLY attached to that location (plate + plateCells saved onto its doc) — no follow-up save_location needed. Without a locationId, attach them yourself with save_location { id, plate, plateCells }. ' +
    'To change ONE view without touching the rest, do NOT regenerate the whole sheet: use extract_panel → generate_image (edit) → replace_panel on the plate with cols:1, rows:4 (see the `locations` skill).',
  thinkingHint: () => 'Generating location plate',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the location looks like (architecture, layout, furniture, materials, mood). Fed to the model that AUTHORS the image prompt.' },
      prompt: { type: 'string', description: 'OPTIONAL full image prompt YOU (the agent) authored for the 1×4 views sheet. When given it is used verbatim; when omitted the tool authors the prompt from `description` via the LLM. Never a hardcoded template.' },
      photos: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL absolute file paths to one or more reference photos of the place, used to preserve its look.' },
      locationId: { type: 'string', description: 'OPTIONAL id of a saved location (~/.koi/locations/<id>.json). When description/photos/locationType are omitted they are sourced from this location, and the plate is attached to it.' },
      locationType: { type: 'string', description: 'OPTIONAL interior|exterior|mixed. Only "exterior" adds the LEFT/RIGHT side views (4-row sheet); anything else = 2-row FRONT/REAR sheet. Sourced from the location doc when a locationId is given.' },
      model: { type: 'string', description: 'OPTIONAL image model slug. Omit to auto-pick.' },
      aspectRatio: { type: 'string', description: 'OPTIONAL aspect ratio for the whole sheet. Defaults to 9:16 (a tall 4-row stack of wide panoramic views).' },
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
    let locationType = _isStr(action?.locationType) ? action.locationType.trim().toLowerCase() : '';
    const locationId = _isStr(action?.locationId) ? action.locationId.trim() : '';

    // Source description / photos / attrs from an existing location when absent.
    if (locationId && (!description || photos.length === 0 || !locationType)) {
      try {
        const loc = readLocation(locationId);
        if (loc) {
          if (!description && _isStr(loc.description)) description = loc.description.trim();
          if (photos.length === 0 && Array.isArray(loc.photos)) {
            photos = loc.photos.filter((p) => _isStr(p) && p.trim()).map((p) => p.trim());
          }
          if (!timeOfDay && _isStr(loc.timeOfDay)) timeOfDay = loc.timeOfDay.trim();
          if (!palette && _isStr(loc.palette)) palette = loc.palette.trim();
          if (!locationType && _isStr(loc.locationType)) locationType = loc.locationType.trim().toLowerCase();
        }
      } catch { /* location may not exist yet */ }
    }

    // VIEW COUNT: default is just FRONT + REAR (two establishing views of the
    // SAME place — fewer views = fewer chances for the model to contradict
    // itself). Only an EXTERIOR (a building / house that front+rear can't fully
    // capture) gets the 4-view FRONT/REAR/LEFT/RIGHT set.
    const needsSides = locationType === 'exterior';
    const viewLabels = needsSides
      ? ['FRONT VIEW', 'REAR VIEW', 'LEFT SIDE VIEW', 'RIGHT SIDE VIEW']
      : ['FRONT VIEW', 'REAR VIEW'];
    const nViews = viewLabels.length;

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

    // A stack of wide panoramic rows is tall — default to a portrait aspect so
    // each row reads as a cinematic panorama (taller for the 4-row exterior set).
    const aspectRatio = (_isStr(action?.aspectRatio) && action.aspectRatio.trim())
      ? action.aspectRatio.trim()
      : (nViews === 4 ? '9:16' : '4:5');

    // The IMAGE PROMPT is written by the model (never a hardcoded template): use
    // the caller-authored `prompt` when an agent passes one, else author it via
    // the LLM (agent-bound or standalone gateway). No template fallback — if
    // authoring fails, fail loudly so the real reason is visible.
    let prompt = (_isStr(action?.prompt) && action.prompt.trim()) ? action.prompt.trim() : '';
    if (!prompt) {
      prompt = await _authorPlatePrompt(agent, description, timeOfDay, palette, viewLabels);
    }
    if (!prompt) {
      return _err('could NOT author the plate image prompt (the LLM step returned nothing). ' +
        'Check the engine log for the reason (no reasoning model / gateway error / missing KOI_AUTH_TOKEN). ' +
        'No image was generated.');
    }
    channel.log('generate_location_plate', `authored prompt (${prompt.length} chars): ${prompt.slice(0, 400)}`);

    const genAction = {
      prompt,
      model,
      aspectRatio,
      // The plate is a one-time world anchor reused across the whole video; 4K.
      resolution: '4k',
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

    // Detect the cell rects from the black gutters so the GUI can crop each
    // view; even-split fallback if the gutters are unreadable.
    let plateCells;
    try {
      const sharp = (await import('sharp')).default;
      plateCells = await _detectSheetCells(sharp, plate, 1, nViews);
    } catch (e) {
      channel.log('generate_location_plate', `cell detection failed: ${e.message}`);
      plateCells = null;
    }
    if (!plateCells || plateCells.length !== nViews) plateCells = _evenGrid(1, nViews);

    // ATTACH to the location when we have an id (best-effort — the GUI's action
    // call can time out on a multi-minute render, so persist here too).
    let attached = false;
    if (locationId) {
      try {
        const existing = readLocation(locationId);
        if (existing && typeof existing.name === 'string') {
          const saveLocation = (await import('./save-location.js')).default;
          const res = await saveLocation.execute(
            { location: { ...existing, plate, plateCells } }, agent);
          attached = !!(res && res.success !== false);
        }
      } catch (e) {
        channel.log('generate_location_plate', `attach to ${locationId} failed: ${e.message}`);
      }
    }

    channel.log('generate_location_plate',
      `plate ${plate} (model ${r.model || model}, ${plateCells.length} cells)${locationId ? ` [attached=${attached}]` : ''}`);

    return {
      success: true,
      plate,
      plateCells,
      views: viewLabels,
      model: r.model || model,
      ...(locationId ? { locationId, attached } : {}),
    };
  },
};
