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
import { readModel, writeModel, modelDir, newModelId, cleanModelId } from './_models.js';
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

/** Builds one pass of a model may take (counted since its last final). Past it, `final` closes the model
 *  with what still differs listed, and no further rebuild is accepted until then: a set left 32 hours and
 *  20 builds chasing wood grain and rush weave the previz never needed (Antonio, 18/11/2026). */
export const MAX_ROUNDS = 8;
const roundsUsed = (m) => (m?.rev || 0) - (Number.isInteger(m?.final) ? m.final : 0);

/** `final: true`: the build last reviewed is declared finished, only when its whole checklist was
 *  judged "ok" on that build's own close-ups. No rebuild: what is finished is what was reviewed. */
async function finalize(existing, params) {
  const spent = roundsUsed(existing) >= MAX_ROUNDS;
  // Within the budget a refusal is a reason to change method; once it is spent, final closes the model.
  const KEEP_GOING = ` (${roundsUsed(existing)}/${MAX_ROUNDS} builds used.) An item still "fix" after 2 rebuilds `
    + 'with the same approach needs another method (another construction, re-measured size and colour, photo '
    + 'texture); a stalled match needs the camera re-estimated; a worse build goes back to the best script.';
  const fail = (error) => ({ success: false, error: `build_model3d final: ${error}${KEEP_GOING}`, final: false });
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
  const checklist = normChecklist(Array.isArray(params.checklist) ? params.checklist : existing.checklist);
  const reviewed = existing.reviewed?.rev === existing.rev ? existing.reviewed.items || [] : [];
  if (!checklist.length || !reviewed.length) {
    return fail('the last build has no checklist close-ups. Build again with `checklist` (EVERY thing the photos show, with its box), review each close-up, then call final.');
  }
  const missing = reviewed.filter((it) => !checklist.some((c) => c.item === it));
  if (missing.length) return fail(`no verdict for: ${missing.join(', ')}. Give every item of the last build a status.`);
  const notReviewed = checklist.filter((c) => !reviewed.includes(c.item));
  if (notReviewed.length) {
    return fail(`never rendered close up: ${notReviewed.map((c) => c.item).join(', ')}. Build again with them in the checklist and review them first.`);
  }
  // "ok" is "indistinguishable from the photo": an "ok" that still notes a difference is a "fix".
  const noted = checklist.filter((c) => c.status === 'ok' && c.note && c.note.trim());
  if (noted.length && !spent) {
    return fail(`"ok" with a difference noted: ${noted.map((c) => `${c.item} (${c.note})`).join('; ')}. `
      + '"ok" means the close-up is indistinguishable from the photo, with NO note. Anything noted is "fix": fix it and rebuild. '
      + `Within the ${MAX_ROUNDS}-build budget anything noted is fixed.`);
  }
  const open = checklist.filter((c) => c.status !== 'ok' || (c.note && c.note.trim()));
  if (open.length && !spent) {
    return fail(`not finished, still to fix: ${open.map((c) => c.item + (c.note ? ` (${c.note})` : '')).join('; ')}. `
      + 'Fix them, rebuild, review the close-ups again.');
  }
  // Faces of two objects on one plane flicker in stripes as the camera moves.
  const zf = existing.reviewed?.rev === existing.rev ? existing.reviewed.zFighting || [] : [];
  const st = existing.reviewed?.rev === existing.rev ? existing.reviewed.stretched || [] : [];
  if (st.length && !spent) {
    return fail(`stretched textures (streaks and blocks from any other point of view): ${st.join('; ')}. Give those `
      + 'surfaces their own material, a clean patch repeated at real size, rebuild, look at the orbit views from above, then call final.');
  }
  if (zf.length && !spent) {
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
    note: pending.length
      ? `Finished at the ${MAX_ROUNDS}-build budget: the card shows this build. Tell the user, in one short list, what `
        + 'still differs from the photo (`pending`), and that a person can ask for another pass on any of it.'
      : 'Finished: the card now shows this build. Every checklist item was judged "ok".',
  };
}

export default {
  type: 'build_model3d',
  intent: 'build_model3d',
  description:
    'Model ONE object (a car, a machine, a piece of furniture…) or ONE set (a street, a room, a circuit) in Blender for ' +
    'the 3D previz, from a Blender Python script YOU write (activate the `3d-modeler` skill first: conventions, helpers, ' +
    'craft and the review loop). Pass the script as `scriptFile` (a .py you wrote; edit it and call again to iterate) or ' +
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
      id: { type: 'string', description: 'Existing model id to rebuild (omit to create).' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['object', 'set'] },
      description: { type: 'string', description: 'What it is (one line).' },
      scriptFile: { type: 'string', description: 'Absolute path of the Blender Python modeling script.' },
      script: { type: 'string', description: 'The script inline (instead of scriptFile).' },
      references: {
        type: 'array',
        items: { type: 'object' },
        description: '[{ image: <abs path>, camera: { position, target, lens, roll? }, anchors? }]. `anchors` (6+, spread over '
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
        description: 'The check list of the model: EVERY thing the photos show, one line each (each piece of furniture, each '
          + 'door, window, lamp, the arch, the stairs and their posts, the beams, the floor, the walls, the ceiling…): '
          + '[{ item: "chair", ref: 0, box: [x0, y0, x1, y1], status: "ok" | "fix", note }]. `box` = where it is in reference '
          + '`ref` (0..1, y DOWN). Each build renders every item close up, [photo | model] from the photo camera. `status` is '
          + 'YOUR verdict on the close-up you last saw: "ok" only when shape, carving / detail, texture and colour read the '
          + 'same as the photo; else "fix" with what differs in `note`. Kept between builds: pass it again to update it.',
      },
      final: {
        type: 'boolean',
        description: 'Declare the model finished: the card stops showing "building" and shows it. Call it WITHOUT a new '
          + 'script, on the build you last reviewed, with the `checklist` all "ok". Refused if any item is not "ok", if an '
          + 'item of that build is missing, or with a script different from that build, UNTIL the model has used its '
          + `${MAX_ROUNDS} builds: then it closes the model with what still differs listed. Every iteration before: omit.`,
      },
    },
  },

  async execute(params = {}) {
    const existing = params.id ? readModel(cleanModelId(params.id)) : null;
    if (params.id && !existing) return { success: false, error: `build_model3d: no model "${params.id}".` };
    if (params.final === true) return finalize(existing, params);
    if (existing && roundsUsed(existing) >= MAX_ROUNDS) {
      return {
        success: false,
        error: `build_model3d: this model used its ${MAX_ROUNDS} builds. Do not rebuild: call build_model3d { id: "${existing.id}", `
          + 'final: true, checklist } now (no script), with every item\'s honest status and note. Final accepts it and lists '
          + 'what still differs; then report that to the user and stop.',
      };
    }
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
    for (const [i, r] of refs.entries()) {
      if (!Array.isArray(r?.anchors) || !r.anchors.length) continue;
      const size = imageSize(r.image) || [16, 9];
      const fit = solveCamera({ anchors: r.anchors, camera: r.camera, aspect: size[0] / size[1], heightPx: size[1] });
      if (fit.error) { cameraFit.push({ ref: i, error: fit.error }); continue; }
      r.camera = { ...(r.camera || {}), ...fit.camera };
      if (!fit.camera.roll) delete r.camera.roll;
      cameraFit.push({ ref: i, camera: r.camera, rmsPx: fit.rmsPx, worst: fit.residuals.slice(0, 6), photoHeightPx: size[1] });
    }

    const id = existing?.id || newModelId(params.name);
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
      await runBuilder(['--script', script, '--out', stage, '--kind', kind, '--refs', refsFile, '--checklist', checkFile], {
        script: modelerScriptPath(),
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
      triangles: stats.triangles,
      materials: stats.materials,
      references: refs,
      checklist,
      // The review of this build, which a `final` call is judged against.
      reviewed: {
        rev,
        items: [
          ...(stats.review?.checklist || []).map((c) => c.item),
          ...(stats.review?.inside ? [INSIDE_ITEM] : []),
          ...(stats.review?.orbit?.length ? [ORBIT_ITEM] : []),
        ],
        match: (stats.review?.references || []).map((r) => r.match),
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
      review.inside,
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
          + 'photo pixels the photo saw at a grazing angle: give those surfaces their OWN material, a clean patch of that '
          + 'surface repeated at its real size (photo_project does both by itself; keep its max_angle). Fix every one.',
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
      ...(review.orbit?.length ? { orbitItem: `Judge the orbit images (a 3 x 3 grid: [photo | 35 left | 15 left / 15 right | 35 right | a little higher / from above | above left | above right], turning round what the photo looks at) as checklist item "${ORBIT_ITEM}" (no box). The photo's own view is nearly always right: these are the views that show the truth. "ok" only when EVERY view is the same place seen from elsewhere: same depths and distances, every object solid and at its place, and every texture real from that side too: floor, road, roofs and walls with their own material at its real scale, never photo pixels smeared into streaks or blocks (a texture laid for the photo's point of view only).` } : {}),
      ...(review.inside ? { insideItem: `Judge the inside image as checklist item "${INSIDE_ITEM}" (no box): "ok" only when every direction holds up (real textures on floor, walls, ceiling and furniture, no streaks, holes, flat untextured surfaces or floating parts).` } : {}),
      ...(checklist.length ? {} : { checklistMissing: 'No checklist yet: pass `checklist` with EVERY thing the photos show (box in the photo) on the next build; `final` is refused without it.' }),
      _reviewImages: images,
      reviewNote: 'LOOK at every attached image. THE GOAL: from the photo camera the model looks THE SAME as the photo. '
        + 'Each reference image is [photo | model from the photo camera | both blended | where they differ (red)], with '
        + '`match` (1 = identical) and `worstAreas` (boxes of the photo, y down): every red area is something to fix. '
        + 'Fix the camera when the whole blend is off the same way, else the part. '
        + (review.inside ? 'The inside image (a set seen from where the photo was taken: wider, left, right, back, down, up) '
          + 'shows what the photo frame does not: no streaks, holes, floating or missing parts, nothing that breaks the place. ' : '')
        + 'Then go down the CHECKLIST: each close-up is [photo | model] of ONE item; judge it alone (shape, carving and '
        + 'detail, texture, colour) and set its status "ok" or "fix" + note in `checklist` on the next call. '
        + '"ok" = indistinguishable from the photo, with NO note; any difference you can name is "fix". '
        + `Build ${roundsUsed(model)} of ${MAX_ROUNDS}: spend them on what the previz needs first (proportions, positions, `
        + 'the camera fit, nothing broken), surface detail last. '
      + 'Rebuild with this id until every item is "ok" and nothing is red. Then call build_model3d { id, final: true, '
        + 'checklist } with no new script: the card shows "building" until then.',
    };
  },
};
