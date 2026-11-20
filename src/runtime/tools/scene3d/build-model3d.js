/**
 * build_model3d — model one object or one set in Blender from a script the
 * agent writes, export it as .glb for the previz, and hand back the review
 * (turnaround + the model seen from each reference photo's camera next to
 * and over the photo) so the agent can correct it until it matches.
 */

import fs from 'fs';
import { solveCamera } from './_camera-solve.js';
import { imageSize } from './_card-models.js';
import path from 'path';
import { runBuilder, modelerScriptPath } from './_blender.js';
import { readModel, writeModel, modelDir, modelsDir, newModelId, cleanModelId } from './_models.js';
import { channel } from '../../io/channel.js';
import { stringifyDocJson } from '../../state/project-paths.js';

/** Makes [model] THE model of its location / object card, then brings every
 *  previz scene up to date with the cards. */
async function attachToCards(model) {
  const out = [];
  try {
    if (model.kind === 'set' && model.locationId) {
      const { readLocation, saveLocation } = await import('../../state/location-registry.js');
      const loc = readLocation(model.locationId);
      if (loc) {
        if (loc.model !== model.id) saveLocation({ ...loc, model: model.id, updatedAt: new Date().toISOString() });
        out.push(`location ${loc.id}`);
      }
    }
    if (model.kind !== 'set' && model.objectId) {
      const { readObject, saveObject } = await import('../../state/object-registry.js');
      const obj = readObject(model.objectId);
      if (obj) {
        if (obj.model !== model.id) saveObject({ ...obj, model: model.id, updatedAt: new Date().toISOString() });
        out.push(`object ${obj.id}`);
      }
    }
    const { syncCardModels } = await import('./_card-models.js');
    syncCardModels();
  } catch { /* best effort: the model itself is saved */ }
  return out;
}

/** While the modeler iterates, its card says so (`modelBuilding`): the card's 3D view shows
 *  "building" (the model blurred) instead of a half-done model. The LAST build (`final: true`)
 *  clears it; a forgotten final call expires in the GUI after a few minutes without builds. */
async function markCardsBuilding({ kind, locationId, objectId, modelId, rev }, building) {
  try {
    const now = new Date().toISOString();
    const apply = (doc) => {
      const next = { ...doc };
      if (building) next.modelBuilding = { modelId: modelId || null, rev: rev || null, updatedAt: now };
      else delete next.modelBuilding;
      return next;
    };
    if (kind === 'set' && locationId) {
      const { readLocation, saveLocation } = await import('../../state/location-registry.js');
      const loc = readLocation(locationId);
      if (loc && (building || loc.modelBuilding)) saveLocation(apply(loc));
    }
    if (kind !== 'set' && objectId) {
      const { readObject, saveObject } = await import('../../state/object-registry.js');
      const obj = readObject(objectId);
      if (obj && (building || obj.modelBuilding)) saveObject(apply(obj));
    }
  } catch { /* best effort: only the card's "building" badge */ }
}

/** The set's inside views are one more checklist line, judged like the rest (no box). */
const INSIDE_ITEM = 'inside views';
/** So are the views turning round what each photo looks at. */
const ORBIT_ITEM = 'orbit views';

/** The checklist as stored: { item, ref, box, status, note }, items with a name and a box. */
function normChecklist(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const item = typeof c?.item === 'string' ? c.item.trim() : '';
    const box = Array.isArray(c?.box) && c.box.length === 4 && c.box.every((v) => Number.isFinite(Number(v)))
      ? c.box.map(Number) : null;
    if (!item || (!box && item !== INSIDE_ITEM && item !== ORBIT_ITEM)) continue;
    out.push({
      item,
      ref: Number.isInteger(c.ref) ? c.ref : 0,
      ...(box ? { box } : {}),
      status: c.status === 'ok' ? 'ok' : c.status === 'fix' ? 'fix' : 'unchecked',
      ...(c.note ? { note: String(c.note) } : {}),
    });
  }
  return out;
}

/** No limit on builds (Antonio, 19/11/2026): the modeler stops as soon as the model is REASONABLY good (not
 *  perfect, nothing left looking wrong), declares it final, and the USER is asked whether it works for them or
 *  they want the 3D design improved. A model is a STAGE for the previz, not a copy of the photo. */

/** `final: true`: the build last reviewed is declared finished. Only real defects of the stage block it (faces
 *  that flicker, textures that smear). No rebuild: what is finished is what
 *  was reviewed. */
async function finalize(existing, params) {
  const fail = (error) => ({ success: false, error: `build_model3d final: ${error}`, final: false });
  if (!existing) return fail('pass the `id` of the model you built and reviewed.');
  const dir = modelDir(existing.id);
  let src = typeof params.script === 'string' && params.script.trim() ? params.script : null;
  if (!src && params.scriptFile) { try { src = fs.readFileSync(params.scriptFile, 'utf8'); } catch { /* */ } }
  if (src) {
    let built = '';
    try { built = fs.readFileSync(path.join(dir, 'build.py'), 'utf8'); } catch { /* */ }
    if (src.trim() !== built.trim()) {
      return fail('a script different from the last build: build it first (without `final`), review its images, then call final with no script.');
    }
  }
  // A stage for the previz, not a copy of the photo: no checklist to pass.
  // What the modeler still saw differ is listed, never blocking.
  const checklist = normChecklist(Array.isArray(params.checklist) ? params.checklist : existing.checklist);
  const open = checklist.filter((c) => c.status && c.status !== 'ok');
  // Faces of two objects on one plane flicker in stripes as the camera moves.
  const zf = existing.reviewed?.rev === existing.rev ? existing.reviewed.zFighting || [] : [];
  const st = existing.reviewed?.rev === existing.rev ? existing.reviewed.stretched || [] : [];
  if (['1', '2', '3', '4'].includes(String(existing.lastPass || ''))) {
    return fail('the last build is a SHAPES pass (plain clay, no materials). Once every shape is in place, do the MATERIALS '
      + 'pass: `pass: 5`, each material a pbr(color=photo_color(...) measured on ITS surface in the photo, texture= the kind '
      + 'of surface the photo shows), build, look at it, then call final.');
  }
  const prop = existing.kind === 'set' && existing.reviewed?.rev === existing.rev ? existing.reviewed.proportions : null;
  if (existing.kind === 'set' && (existing.references || []).length) {
    const why = proportionsProblem(prop);
    if (why) return fail(why);
  }
  if (st.length) {
    return fail(`stretched textures (streaks and blocks from any other point of view): ${st.join('; ')}. Give those `
      + 'surfaces a generated material instead (pbr(..., texture=...) in the colour photo_color measures), rebuild, look at the orbit views from above, then call final.');
  }
  if (zf.length) {
    return fail(`faces on one plane (they flicker as the camera moves): ${zf.join('; ')}. Pull the front one out 5 mm `
      + 'or more, or trim one so they only meet at an edge, rebuild, then call final.');
  }
  const pending = [
    ...open.map((c) => ({ item: c.item, note: c.note || '' })),
    ...zf.map((z) => ({ item: 'z-fighting', note: z })),
    ...st.map((t) => ({ item: 'stretched texture', note: t })),
  ];
  writeModel({ ...existing, checklist, final: existing.rev, pending, updatedAt: new Date().toISOString() });
  await markCardsBuilding({
    kind: existing.kind, locationId: existing.locationId, objectId: existing.objectId, modelId: existing.id, rev: existing.rev,
  }, false);
  return {
    success: true,
    final: true,
    model: { id: existing.id, name: existing.name, kind: existing.kind, rev: existing.rev, dims: existing.dims },
    ...(pending.length ? { pending } : {}),
    note: 'Finished: the card shows this build in 3D. NEVER show the user the review images (orbit, compare, turnaround) '
      + 'nor their paths: they look at the 3D on the card. Now ASK THE USER (in their language, one short question with options) whether the 3D '
      + 'works for them as it is or they want it closer to the photo (level 2 of the skill: pieces in parallel + assembly, from this model), naming in a few words what you would improve '
      + '(e.g. "the stair rail", "the roof shapes"). If they want it improved, rebuild the same `id` with what they ask, '
      + 'then final again and ask again. Never start improving without their answer.',
  };
}

/** How well the set's proportions match its main photo, from the anchors
 *  of the first reference (the camera solved from them): the user's rule
 *  (19/11/2026) is that the agent proves it looks like the photo, at least
 *  in proportions, before asking them anything. */
function proportionsOf(refs, cameraFit, offModel) {
  const r0 = refs?.[0];
  const fit = (cameraFit || []).find((f) => f.ref === 0);
  const anchors = (r0?.anchors || []).filter((a) => Array.isArray(a?.px) && Array.isArray(a?.world));
  if (!anchors.length) return { anchors: 0 };
  const xs = anchors.map((a) => Number(a.px[0])), ys = anchors.map((a) => Number(a.px[1]));
  const spread = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map((v) => Math.round(v * 100) / 100);
  // Which ninths of the photo hold an anchor: a part nobody anchored can be
  // anywhere (a table twice its size passed with all anchors elsewhere).
  const cells = [...new Set(anchors.map((a) => `${Math.min(2, Math.floor(Number(a.px[0]) * 3))},${Math.min(2, Math.floor(Number(a.px[1]) * 3))}`))];
  if (!fit || fit.error) return { anchors: anchors.length, spread, cells, error: fit?.error || 'not solved' };
  const h = fit.photoHeightPx || 1000;
  return {
    anchors: anchors.length, spread, cells,
    rms: Math.round((fit.rmsPx / h) * 1000) / 1000,
    worst: (fit.worst || []).map((w) => ({ label: w.label, err: Math.round((w.errPx / h) * 1000) / 1000, dx: w.dx, dy: w.dy })),
    offModel: (offModel || []).filter((a) => a.ref === 0).map((a) => a.label),
  };
}

// Structure faithful to the photo (user, 19/11/2026: a set at 1.8 % / 3.1 %
// still had the table twice too big and read as "nothing like it").
const PROP_MIN = 12;
const PROP_CELLS = 7;    // of the photo's 3 x 3 ninths
const PROP_RMS = 0.012;  // of the photo height
const PROP_WORST = 0.025;

function proportionsProblem(p) {
  const how = `Pass ${PROP_MIN}+ \`anchors\` on the main photo (references[0]), over the WHOLE photo (${PROP_CELLS} of its 9 ninths at least), near and far, `
    + 'AT LEAST TWO ON EVERY BIG PART (each wall\'s corners at floor and ceiling, door and window corners, the arch\'s key and both springs, '
    + 'the stair\'s first and top step, the table\'s corners and a leg foot, the chair, the barrel, beam ends); each `world` = that point ON your model. Build, read `cameraFit`, move the parts whose '
    + 'anchors are off, rebuild.';
  if (!p || !p.anchors) return `the proportions are not proven against the photo yet. ${how}`;
  if (p.anchors < PROP_MIN) return `only ${p.anchors} anchors: ${PROP_MIN} or more are needed to judge the structure. ${how}`;
  if (p.cells && p.cells.length < PROP_CELLS) return `the anchors cover only ${p.cells.length} of the photo's 9 ninths: a part nobody anchored can be anywhere. ${how}`;
  if (p.spread && (p.spread[0] < 0.6 || p.spread[1] < 0.45)) {
    return `the anchors are bunched (they span ${Math.round(p.spread[0] * 100)}% of the photo's width and ${Math.round(p.spread[1] * 100)}% of its height): spread them over the whole photo. ${how}`;
  }
  if (p.error) return `the camera could not be solved from the anchors (${p.error}). ${how}`;
  if (p.offModel?.length) return `anchors that are not on the model: ${p.offModel.join(', ')}. Each anchor's world point must be a point of the model.`;
  const bad = (p.worst || []).filter((w) => w.err > PROP_WORST);
  if (p.rms > PROP_RMS || bad.length) {
    return `the model does not match the photo's proportions yet (anchor error ${Math.round(p.rms * 1000) / 10}% of the photo height on `
      + `average, at most ${PROP_RMS * 100}% allowed; each under ${PROP_WORST * 100}%). Worst: `
      + (p.worst || []).slice(0, 4).map((w) => `${w.label} ${Math.round(w.err * 1000) / 10}% (dx ${w.dx}, dy ${w.dy} px)`).join('; ')
      + '. Move THOSE parts of the model (or fix a misread anchor), rebuild, then call final.';
  }
  return null;
}

export default {
  type: 'build_model3d',
  intent: 'build_model3d',
  description:
    'Model ONE object (a car, a machine, a piece of furniture…) or ONE set (a street, a room, a circuit) in Blender for ' +
    'the 3D previz, from a Blender Python script YOU write (activate the `3d-modeler` skill first: conventions, helpers, ' +
    'craft and the review loop). SCULPT IN PASSES: the first build is the blocks only (within ~3 minutes), each later build '
    + 'EDITS the script for one more pass, never one big script written at once. SHAPES FIRST, THEN MATERIALS: passes 1-4 '
    + '(blocks, shapes, detail, assembly) build in plain clay; only when EVERY shape is in place, pass 5 gives the materials, '
    + 'generated (wood, planks, brick, tiles, plaster, stone…) in the colours measured on the photo: never the photo\'s pixels. BUILD IT FROM THE KIT: room(), wall() with door / window / arch openings, stairs(), '
    + 'table(), chair(), barrel(), house() with its roof, ground(), road()… placed at their real sizes; the script is a '
    + 'few dozen lines of pieces, never hand-made faces or hand-made camera maths. Pass the script as `scriptFile` (a .py you wrote; edit it and call again to iterate) or ' +
    'inline `script`. `references`: the photos the model must match, each with the camera you estimate it was taken from ' +
    '({ image, camera:{ position:[x,y,z], target:[x,y,z], lens:mm } } in the model\'s frame) — the review renders the model ' +
    'from that camera next to the photo and blended over it. Re-call with the same `id` to rebuild. Returns { model:{ id, ' +
    'path, dims, triangles }, review } with the review images attached. Use it in a scene with prop `model: <id>` or ' +
    'set `model: <id>`.',
  thinkingHint: 'Modeling in 3D',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Model to rebuild, or the id to CREATE a new model under (a piece of a set: "<set>-<piece>", with `kind` and a script); omit to create with a fresh id.' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['object', 'set'] },
      description: { type: 'string', description: 'What it is (one line).' },
      scriptFile: { type: 'string', description: 'Absolute path of the Blender Python modeling script.' },
      script: { type: 'string', description: 'The script inline (instead of scriptFile).' },
      references: {
        type: 'array',
        items: { type: 'object' },
        description: '[{ image: <abs path>, camera: { position, target, lens, roll? }, anchors?, inSet? }]. A PIECE of a set seen in the '
          + 'set\'s photo: give the camera in the SET frame and `inSet: { at: [x, y, z] (its block\'s bottom centre), rot (deg) }`; the tool '
          + 'turns it into the piece\'s own frame. `anchors` (6+, spread over '
          + 'the whole photo, near and far): [{ label, px: [x, y] (where it is in the photo, 0..1, y DOWN), world: [x, y, z] '
          + '(the same point in YOUR model) }]: sharp points both show (room corners at floor and ceiling, window and door '
          + 'corners, the arch apex, table corners, a beam end). The tool then SOLVES the photo camera from them (`camera` is '
          + 'only the start) and returns `cameraFit`: the solved camera and each anchor\'s error in photo pixels.',
      },
      locationId: { type: 'string', description: 'Saved location this set is (kind "set"): the model becomes THE 3D set of that location card, and every previz scene in that place uses it.' },
      objectId: { type: 'string', description: 'Saved object card this object is (kind "object"): the model becomes THE 3D model of that card, and every previz prop that is this object uses it.' },
      characterId: { type: 'string', description: 'Saved character this belongs to, if any.' },
      checklist: {
        type: 'array',
        items: { type: 'object' },
        description: 'Optional: a few things to look at close up, [{ item, ref, box: [x0, y0, x1, y1] (0..1 of reference '
          + '`ref`, y DOWN), status: "ok" | "fix", note }]. Each build renders them [photo | model]. Never required.',
      },
      pass: {
        type: 'number',
        description: 'The sculpting pass this build is: 1 blocks, 2 shapes, 3 detail, 4 assembly (a set built from pieces), '
          + '5 MATERIALS. Passes 1-4 build in plain CLAY (no colour, no texture: the review shows only the forms); go to 5 only '
          + 'when every shape is in place. Pass 5: each material pbr(name, photo_color(photo, points ON that surface), '
          + 'texture="wood" | "planks" | "brick" | "tiles" | "plaster" | "stone" | "cobble" | "metal" | "fabric" | "earth" | '
          + '"grass" | "leaves" | "roof_tiles", as the photo shows that surface): the texture is generated in that colour at '
          + 'its real size. Pass 1 takes at most 2 builds, the assembly at most 3. `final` is refused on a clay build.',
      },
      final: {
        type: 'boolean',
        description: 'Declare the model finished: the card stops showing "building" and shows it. Call it WITHOUT a new '
          + 'script, on the build you last reviewed, as soon as it is REASONABLY good (not perfect): right size, every part in place, nothing that looks '
          + 'wrong from any side. Refused for faces that flicker or smeared textures.',
      },
    },
  },

  async execute(params = {}) {
    const existing = params.id ? readModel(cleanModelId(params.id)) : null;
    // A new model may be created under the id it was ASKED for (a piece of a
    // set: "zaguan-escalera"), so the set can place it before it exists.
    if (params.id && !existing && (params.final === true || !params.kind)) {
      return { success: false, error: `build_model3d: no model "${params.id}" (to create one under this id, pass \`kind\` and a script).` };
    }
    if (params.final === true) return finalize(existing, params);
    let src = typeof params.script === 'string' && params.script.trim() ? params.script : null;
    if (!src && params.scriptFile) {
      try { src = fs.readFileSync(params.scriptFile, 'utf8'); } catch (e) {
        return { success: false, error: `build_model3d: cannot read scriptFile: ${e.message}` };
      }
    }
    if (!src && existing) {
      try { src = fs.readFileSync(path.join(modelDir(existing.id), 'build.py'), 'utf8'); } catch { /* none */ }
    }
    if (!src) return { success: false, error: 'build_model3d: pass `scriptFile` or `script`.' };

    const refs = Array.isArray(params.references) ? params.references : existing?.references || [];
    const missing = refs.filter((r) => !r?.image || !fs.existsSync(r.image)).map((r) => r?.image);
    if (missing.length) return { success: false, error: `build_model3d: reference images not found: ${missing.join(', ')}` };
    // A photo was taken from ONE camera. The same image under a second
    // camera (e.g. the front elevation reused as a "top view") makes the
    // review fit the model to an outline that view never shows.
    const seen = new Set();
    const dup = [];
    for (const r of refs) {
      const k = path.resolve(r.image);
      if (seen.has(k)) dup.push(r.image);
      seen.add(k);
    }
    if (dup.length) {
      return { success: false, error: `build_model3d: the same reference image appears more than once (${[...new Set(dup)].join(', ')}). ` +
        'Each photo was taken from ONE camera: pass it once, with that camera. A view no image shows (e.g. the top) has no reference.' };
    }

    // Photos with anchors: their camera is solved, not guessed.
    const cameraFit = [];
    // A PIECE of a set seen in the set's photo: its camera given in the SET's
    // frame plus where the piece's block stands there (`inSet: { at, rot }`)
    // is turned into the piece's own frame (bottom centre at the origin,
    // its front +y), so the piece agent never does that maths.
    for (const r of refs) {
      const f = r?.inSet;
      if (!f || !Array.isArray(f.at) || !r.camera) continue;
      const a = (Number(f.rot) || 0) * Math.PI / 180;
      const to = (p) => {
        const dx = Number(p[0]) - Number(f.at[0]), dy = Number(p[1]) - Number(f.at[1]), dz = Number(p[2]) - (Number(f.at[2]) || 0);
        return [+(dx * Math.cos(-a) - dy * Math.sin(-a)).toFixed(4), +(dx * Math.sin(-a) + dy * Math.cos(-a)).toFixed(4), +dz.toFixed(4)];
      };
      if (Array.isArray(r.camera.position)) r.camera.position = to(r.camera.position);
      if (Array.isArray(r.camera.target)) r.camera.target = to(r.camera.target);
      r.placedFrom = f;
      delete r.inSet;
    }
    for (const [i, r] of refs.entries()) {
      if (!Array.isArray(r?.anchors) || !r.anchors.length) continue;
      const size = imageSize(r.image) || [16, 9];
      const fit = solveCamera({ anchors: r.anchors, camera: r.camera, aspect: size[0] / size[1], heightPx: size[1] });
      if (fit.error) { cameraFit.push({ ref: i, error: fit.error }); continue; }
      r.camera = { ...(r.camera || {}), ...fit.camera };
      if (!fit.camera.roll) delete r.camera.roll;
      cameraFit.push({ ref: i, camera: r.camera, rmsPx: fit.rmsPx, worst: fit.residuals.slice(0, 6), photoHeightPx: size[1] });
    }

    const id = existing?.id || (params.id ? cleanModelId(params.id) : newModelId(params.name));
    const dir = modelDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const rev = (existing?.rev || 0) + 1;
    const stage = path.join(dir, `rev-${rev}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const script = path.join(stage, 'build.py');
    fs.writeFileSync(script, src, 'utf8');
    const refsFile = path.join(stage, 'refs.json');
    fs.writeFileSync(refsFile, JSON.stringify(refs), 'utf8');
    const checklist = normChecklist(Array.isArray(params.checklist) ? params.checklist : existing?.checklist);
    const checkFile = path.join(stage, 'checklist.json');
    fs.writeFileSync(checkFile, JSON.stringify(checklist), 'utf8');
    const kind = params.kind === 'set' || (!params.kind && existing?.kind === 'set') ? 'set' : 'object';

    const cardRef = {
      kind,
      locationId: params.locationId ?? existing?.locationId,
      objectId: params.objectId ?? existing?.objectId,
      modelId: id,
      rev,
    };
    await markCardsBuilding(cardRef, true);
    try {
      await runBuilder(['--script', script, '--out', stage, '--kind', kind, '--refs', refsFile, '--checklist', checkFile, '--models-dir', modelsDir(), ...([1, 2, 3, 4].includes(Number(params.pass)) ? ['--clay'] : [])], {
        script: modelerScriptPath(),
        pool: 'model',
        timeoutMs: 10 * 60 * 1000,
        onProgress: (_p, label) => label && channel.log('model3d', label),
      });
    } catch (e) {
      // The previous good build stays the model; this rev is discarded.
      fs.rmSync(stage, { recursive: true, force: true });
      return { success: false, error: `build_model3d: ${e.message}`, hint: 'Fix the script (the traceback points at its lines) and call again.' };
    }

    let stats = {};
    try { stats = JSON.parse(fs.readFileSync(path.join(stage, 'stats.json'), 'utf8')); } catch { /* */ }
    for (const f of ['model.glb', 'build.py', 'refs.json']) {
      // Blender read the stage's refs.json (absolute paths); the model's own
      // copy is a project document: paths stored project-relative.
      if (f === 'refs.json') fs.writeFileSync(path.join(dir, `${f}.tmp`), stringifyDocJson(refs, path.join(dir, f), 0), 'utf8');
      else fs.copyFileSync(path.join(stage, f), path.join(dir, `${f}.tmp`));
      fs.renameSync(path.join(dir, `${f}.tmp`), path.join(dir, f));
    }
    for (const d of fs.readdirSync(dir)) {
      const m = /^rev-(\d+)$/.exec(d);
      if (m && Number(m[1]) < rev - 1) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    }

    const now = new Date().toISOString();
    const model = {
      ...(existing || {}),
      id,
      name: params.name || existing?.name || id,
      kind,
      description: params.description ?? existing?.description,
      locationId: params.locationId ?? existing?.locationId,
      objectId: params.objectId ?? existing?.objectId,
      characterId: params.characterId ?? existing?.characterId,
      dims: stats.dims,
      // Under the open sky (it has the photo's sky): its card shows it in daylight.
      openAir: !!stats.openAir,
      triangles: stats.triangles,
      materials: stats.materials,
      references: refs,
      checklist,
      passBuilds: (() => {
        const pb = { ...(existing?.passBuilds || {}) };
        const k = String(Number(params.pass) || 0);
        if (k !== '0') pb[k] = (existing?.lastPass === k ? (pb[k] || 0) : 0) + 1;
        return pb;
      })(),
      lastPass: String(Number(params.pass) || 0),
      // The review of this build, which a `final` call is judged against.
      reviewed: {
        rev,
        items: [
          ...(stats.review?.checklist || []).map((c) => c.item),
          ...(stats.review?.inside ? [INSIDE_ITEM] : []),
          ...(stats.review?.orbit?.length ? [ORBIT_ITEM] : []),
        ],
        match: (stats.review?.references || []).map((r) => r.match),
        proportions: proportionsOf(refs, cameraFit, stats.anchorsOffModel),
        zFighting: (stats.zFighting || []).map((z) => `${z.a} / ${z.b} at [${z.at.join(', ')}]`),
        stretched: (stats.stretchedTextures || []).map((t) => `${t.object} (${t.material}, ${t.areaM2} m², ${t.stretch}:1)`),
      },
      rev,
      // The 2×2 review views of this build: the cards' 3D preview.
      turnaround: stats.review?.turnaround || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    writeModel(model);
    // THE model of its card(s), and every scene follows the card.
    const attached = await attachToCards(model);
    await markCardsBuilding(cardRef, true);


    const review = stats.review || {};
    const images = [
      ...(review.references || []).map((r) => r.compare),
      ...(review.orbit || []),
      ...(review.checklist || []).map((c) => c.compare),
      review.turnaround,
    ].filter(Boolean);
    return {
      success: true,
      model: {
        id, name: model.name, kind, path: path.join(dir, 'model.glb'), script: path.join(dir, 'build.py'),
        dims: stats.dims, triangles: stats.triangles, objects: stats.objects, materials: stats.materials,
        recentredBy: stats.recentredBy, rev,
      },
      ...(attached.length ? { attachedTo: attached } : {}),
      ...(cameraFit.length ? {
        cameraFit,
        cameraFitNote: 'The photo camera was SOLVED from your anchors (used for this review and saved). Read the errors '
          + '(photo pixels): all small (under ~1% of the photo height) = camera and model agree there; a few large = THOSE '
          + 'parts of the model are not where the photo has them (move them, by dx/dy: + = right / down in the photo) or the '
          + 'anchor was misread; large everywhere = anchors wrong or too few / bunched. Pass the anchors again on every build.',
      } : {}),
      ...(stats.stretchedTextures?.length ? {
        stretchedTextures: stats.stretchedTextures,
        stretchedTexturesNote: 'These faces carry an image STRETCHED on them (`stretch` = how many times more image pixels '
          + 'per metre one way than the other): a photo laid on a floor, road or roof the photo saw almost edge-on. From the '
          + 'photo\'s point it looks right; from anywhere else, above all from above, it is streaks and blocks. Never lay '
          + 'photo pixels on a 3D surface: give those surfaces a generated '
          + 'pbr(..., texture=...) material in the colour photo_color measures. Fix every one.',
      } : {}),
      ...(stats.pieces?.length ? {
        pieces: stats.pieces,
        piecesNote: 'ASSEMBLY, with care: each piece placed with place_model. `fitOff` = how far it still differs from its block per axis after the uniform fit (0.08 = 8 % bigger). '
          + 'Over ~5 % on any axis: the piece or the block is wrong; look at the photo and fix that one (never stretch the piece). Then check in the review, piece by piece: '
          + 'standing on the floor (not sunk, not floating), against its wall where it touches it, facing the right way, nothing passing through another piece or a wall, '
          + 'the same light and colour family as the set round it. Fix the placement here, in the set script.',
      } : {}),
      ...(stats.anchorsOffModel?.length ? {
        anchorsOffModel: stats.anchorsOffModel,
        anchorsOffModelNote: 'These anchors\' `world` points lie on NO surface of your model (`offModelM` = how far): an anchor is a '
          + 'point OF THE MODEL (a corner, the arch\'s key, a table corner) where the photo shows that same point. Give the real '
          + 'point of the model, or move the part so it is there.',
      } : {}),
      ...(stats.zFighting?.length ? {
        zFighting: stats.zFighting,
        zFightingNote: 'These pairs of objects have faces on the SAME plane, facing the same way, overlapping (`at` = '
          + 'where, `areaM2` = how much): the renderer cannot tell which is in front, so they flicker in stripes when the '
          + 'camera moves. Fix every one: pull the part that should be in front out by 5 mm or more, or trim one so they '
          + 'only meet at an edge. Never two faces on one plane.',
      } : {}),
      review: {
        references: (review.references || []).map((r) => ({
          index: r.index, photo: r.image, compare: r.compare, match: r.match, worstAreas: r.worstAreas,
        })),
        ...(review.orbit?.length ? { orbit: review.orbit } : {}),
        ...(review.inside ? { inside: review.inside } : {}),
        checklist: (review.checklist || []).map((c) => ({
          item: c.item, compare: c.compare,
          status: checklist.find((x) => x.item === c.item)?.status || 'unchecked',
        })),
        turnaround: review.turnaround,
      },
      ...(review.orbit?.length ? { orbitNote: `The orbit images (a 3 x 3 grid: [photo | 35 left | 15 left / 15 right | 35 right | a little higher / from above | above left | above right], turning round what the photo looks at) show whether the stage holds up from other points: nothing floating, broken or smeared into streaks.` } : {}),
      _reviewImages: images,
      ...(() => {
        const k = model.lastPass;
        const n = Number(model.passBuilds?.[k] || 0);
        const cap = k === '1' ? 2 : k === '4' ? 3 : 0;
        return cap && n >= cap ? { passNote: `Pass ${k} has had ${n} builds, its budget. `
          + (k === '1' ? 'Blocks only need proportions and places ROUGHLY right: stop polishing them and go on NOW (list the piece blocks / next pass).'
            : 'The assembly is done when every piece sits right: fix only a piece that floats, sinks, clips or faces wrong, then final.') } : {};
      })(),
      reviewNote: 'Look at the review images (they are for YOU: never show them to the user, never put their paths in a reply).'
        + ' For a set, `final` needs the proportions PROVEN: 12+ anchors over 7 of the photo\'s 9 ninths, two or more on every big part, each a point of the model, '
        + 'solved camera error under 1.2% of the photo height (each under 2.5%); fix that in the shapes passes, before materials.'
        + '  THE GOAL is a STAGE for the previz, not a copy of the photo: the right size and '
        + 'proportions, every big part in its place (walls, floor, openings, stairs, main furniture), nothing broken, floating, '
        + 'smeared or flickering from any side. Colours and textures roughly right is enough. '
        + 'You SCULPT IN PASSES (blocks → shapes of the big parts → detail that reads at 2-3 m → assembly of pieces, all in clay → MATERIALS last): '
        + 'fix what this review shows wrong at the pass you are in, then EDIT the script for the next pass (a few lines, never a rewrite). '
        + 'Judge it: is it REASONABLY good (not perfect), with nothing that looks clearly wrong? Then call '
        + 'build_model3d { id, final: true } NOW (no script). If something still looks wrong (a part missing, misplaced, '
        + 'badly shaped, floating, smeared, flickering), fix those things and rebuild; never spend a round on detail, '
        + 'wood grain or exact texture placement.',
    };
  },
};
