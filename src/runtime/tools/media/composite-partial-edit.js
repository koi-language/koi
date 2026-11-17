/**
 * composite_partial_edit — build a "master" partial edit deterministically.
 *
 * Image edit models re-render the WHOLE picture: even with "change only X"
 * every pixel drifts (texture, grain, faces). Master mode keeps the clean
 * master and takes from the model's edit ONLY the areas it really changed.
 *
 * Detection works on low-frequency copies of both images (block averages):
 * re-render drift is high-frequency noise and cancels out, real changes
 * (a red cuff turned grey, a removed badge) survive. Strong changes seed the
 * regions, which then grow into connected weaker change (hysteresis), so a
 * region is never cut short of its shadows / fabric. `regions` (optional,
 * normalised boxes) keeps only the changed areas that touch them, for when
 * the caller knows where the change was asked.
 *
 * The cut is generous: every region is dilated, and the alpha ramp lies
 * OUTSIDE the dilated area, so nothing of the old content shows through at
 * the edges. Pixels are pasted 1:1 at the same coordinates, never moved,
 * scaled or altered. Different sizes → refused: a resolution change makes
 * the edit the new master, there is nothing to composite.
 *
 * The result is registered as a creation via save_composite_image, and a
 * preview with the pasted area tinted is written to the temp dir for checking.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const BS = 8; // detection block size (px)

function _boxesOverlap(compBox, regions, gw, gh) {
  const [x0, y0, x1, y1] = compBox;
  return regions.some((r) => {
    const rx0 = r.x * gw, ry0 = r.y * gh, rx1 = (r.x + r.w) * gw, ry1 = (r.y + r.h) * gh;
    return x0 <= rx1 && x1 >= rx0 && y0 <= ry1 && y1 >= ry0;
  });
}

function _normRegions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({ x: Number(r?.x), y: Number(r?.y), w: Number(r?.w), h: Number(r?.h) }))
    .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
}

export async function buildPartialComposite({ masterPath, editPath, outPath, previewPath, regions = [], sensitivity = 1, margin = 1 }) {
  const sharp = (await import('sharp')).default;
  const a = await sharp(masterPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(editPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = a.info.width, H = a.info.height;
  if (b.info.width !== W || b.info.height !== H) {
    return { error: `size mismatch: master ${W}x${H}, edit ${b.info.width}x${b.info.height}. A resolution change makes the edit the NEW master: deliver it whole, no composite.` };
  }
  const gw = Math.max(1, Math.round(W / BS)), gh = Math.max(1, Math.round(H / BS));
  const small = (buf) => sharp(buf, { raw: { width: W, height: H, channels: 3 } }).resize(gw, gh, { kernel: 'cubic' }).raw().toBuffer();
  const SA = await small(a.data), SB = await small(b.data);

  const s = Math.min(3, Math.max(0.3, Number(sensitivity) || 1));
  const hi = 70 / s, lo = 50 / s;
  // Weak change only joins a region close to its strong core: drift (puddles,
  // cloth folds) must not leak a region across the frame.
  const maxGrow = Math.max(2, Math.round((Math.max(W, H) * 0.02) / BS));
  const diff = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    diff[i] = Math.abs(SA[3 * i] - SB[3 * i]) + Math.abs(SA[3 * i + 1] - SB[3 * i + 1]) + Math.abs(SA[3 * i + 2] - SB[3 * i + 2]);
  }

  // Hysteresis region growing from strong seeds into connected weaker change.
  const lab = new Int32Array(gw * gh).fill(-1);
  const keep = new Uint8Array(gw * gh);
  const minBlocks = Math.max(4, Math.round(gw * gh * 0.0002));
  const comps = [];
  for (let s0 = 0; s0 < gw * gh; s0++) {
    if (diff[s0] <= hi || lab[s0] >= 0) continue;
    const stack = [s0], comp = [];
    const dist = new Map([[s0, 0]]);
    lab[s0] = s0;
    let bx0 = gw, by0 = gh, bx1 = 0, by1 = 0, strong = 0;
    while (stack.length) {
      const g = stack.pop();
      comp.push(g);
      if (diff[g] > hi) strong++;
      const x = g % gw, y = (g / gw) | 0;
      if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (lab[n] >= 0) continue;
        const d = diff[n] > hi ? 0 : (dist.get(g) + 1);
        if (diff[n] > lo && d <= maxGrow) { lab[n] = s0; dist.set(n, d); stack.push(n); }
      }
    }
    if (strong < minBlocks) continue;
    const box = [bx0, by0, bx1, by1];
    if (regions.length && !_boxesOverlap(box, regions, gw, gh)) continue;
    for (const g of comp) keep[g] = 1;
    comps.push({ x: +(bx0 / gw).toFixed(3), y: +(by0 / gh).toFixed(3), w: +((bx1 - bx0 + 1) / gw).toFixed(3), h: +((by1 - by0 + 1) / gh).toFixed(3) });
  }
  // Follow every kept change to its end. A change has two sides: where the
  // new content appears AND where the old content disappears (a strap that
  // moved is new strap + strap gone). Both are change, connected along the
  // object, often weaker in the middle (dark on dark). If the cut stops
  // half-way, the old content survives next to the new one (two straps).
  // So grow the kept areas, with no distance limit, into any change that
  // touches them (bridging gaps of up to 2 blocks), until it fades out.
  {
    const sorted = Float32Array.from(diff).sort();
    const drift = sorted[Math.floor(sorted.length * 0.9)];
    const cont = Math.max(lo, drift * 1.3);
    const queue = [];
    for (let g = 0; g < gw * gh; g++) if (keep[g]) queue.push(g);
    while (queue.length) {
      const g = queue.pop();
      const x = g % gw, y = (g / gw) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (!keep[n] && diff[n] > cont) { keep[n] = 1; queue.push(n); }
      }
    }
  }
  if (!comps.length) return { error: 'no changed region found between the master and the edit (raise "sensitivity", or check the regions).' };

  const m = Math.min(3, Math.max(0.5, Number(margin) || 1));
  const R = Math.max(3, Math.round((Math.max(W, H) * 0.015 * m) / BS));
  const F = Math.max(8, Math.round(Math.max(W, H) * 0.008 * m));
  // keep (block grid) → the paste alpha (full res): a generous dilated core, opaque, and a
  // feather ramp that lies OUTSIDE it.
  const buildAlpha = async () => {
    const core = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      if (!keep[y * gw + x]) continue;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) core[ny * gw + nx] = 255;
      }
    }
    const coreFull = await sharp(Buffer.from(core), { raw: { width: gw, height: gh, channels: 1 } })
      .resize(W, H, { kernel: 'nearest' }).extractChannel(0).raw().toBuffer();
    const grown = await sharp(coreFull, { raw: { width: W, height: H, channels: 1 } }).blur(F).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < grown.length; i++) grown[i] = grown[i] > 4 ? 255 : 0;
    const al = await sharp(grown, { raw: { width: W, height: H, channels: 1 } }).blur(F / 2).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < W * H; i++) if (coreFull[i]) al[i] = 255;
    return al;
  };

  // SELF-CHECK: a GHOST is a semi-transparent object: the feather ramp (0 < alpha < 1) crosses
  // something the model really changed (an iron bowl over a dark sash: weak at block scale, so
  // the detector stopped half-way), and the old and new pictures show through each other.
  // Compared on lightly blurred copies (the fine re-render grain cancels, object edges stay).
  // Every ghost block joins the paste and the change is followed further from there, then the
  // alpha is rebuilt, until the ramp only crosses pixels where master and edit agree.
  const fineA = await sharp(a.data, { raw: { width: W, height: H, channels: 3 } }).blur(1.5).raw().toBuffer();
  const fineB = await sharp(b.data, { raw: { width: W, height: H, channels: 3 } }).blur(1.5).raw().toBuffer();
  const GHOST_PX = 90 / s; // summed |dRGB| that reads as a visible double image
  const ghostScan = (al) => {
    const blocks = new Map();
    let band = 0, ghost = 0;
    for (let i = 0; i < W * H; i++) {
      const t = al[i];
      if (t === 0 || t === 255) continue;
      band++;
      const d = Math.abs(fineA[3 * i] - fineB[3 * i]) + Math.abs(fineA[3 * i + 1] - fineB[3 * i + 1]) + Math.abs(fineA[3 * i + 2] - fineB[3 * i + 2]);
      if (d * Math.min(t, 255 - t) / 127.5 < GHOST_PX * 0.5) continue; // only where it really shows
      ghost++;
      const x = i % W, y = (i / W) | 0;
      const g = Math.min(gh - 1, Math.floor(y / BS)) * gw + Math.min(gw - 1, Math.floor(x / BS));
      blocks.set(g, (blocks.get(g) || 0) + 1);
    }
    // A block is a ghost when a visible share of its pixels doubles (not a lone noisy pixel).
    const bad = [...blocks].filter(([, n]) => n >= BS * BS * 0.08).map(([g]) => g);
    return { bad, ghostFraction: band ? ghost / band : 0 };
  };
  let alpha = await buildAlpha();
  let scan = ghostScan(alpha);
  let repairs = 0;
  {
    const sorted = Float32Array.from(diff).sort();
    const drift = sorted[Math.floor(sorted.length * 0.9)];
    // Weaker than the first pass (the object that was missed IS weak), but bounded in distance
    // from each ghost so the drift of a whole garment never joins.
    const weak = Math.max(drift, lo * 0.4);
    const reach = Math.max(3, Math.round((Math.max(W, H) * 0.04) / BS));
    while (scan.bad.length && repairs < 4) {
      repairs++;
      const dist = new Map();
      const queue = [];
      for (const g of scan.bad) { if (!keep[g]) { keep[g] = 1; } dist.set(g, 0); queue.push(g); }
      while (queue.length) {
        const g = queue.pop();
        const x = g % gw, y = (g / gw) | 0, d0 = dist.get(g);
        if (d0 >= reach) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (dist.has(n) || keep[n] || diff[n] <= weak) continue;
          keep[n] = 1; dist.set(n, d0 + 1); queue.push(n);
        }
      }
      alpha = await buildAlpha();
      scan = ghostScan(alpha);
    }
  }
  const ghostBoxes = [];
  if (scan.bad.length) {
    // Still doubling after the repairs: say WHERE, so the caller zooms in there.
    const seen = new Set();
    for (const g0 of scan.bad) {
      if (seen.has(g0)) continue;
      let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
      const st = [g0]; seen.add(g0);
      const set = new Set(scan.bad);
      while (st.length) {
        const g = st.pop(); const x = g % gw, y = (g / gw) | 0;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const n = (y + dy) * gw + (x + dx);
          if (set.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
        }
      }
      ghostBoxes.push({ x: +(x0 / gw).toFixed(3), y: +(y0 / gh).toFixed(3), w: +((x1 - x0 + 1) / gw).toFixed(3), h: +((y1 - y0 + 1) / gh).toFixed(3) });
    }
  }

  const A = a.data, B = b.data;
  const out = Buffer.alloc(W * H * 3);
  let covered = 0;
  for (let i = 0; i < W * H; i++) {
    const t = alpha[i] / 255;
    if (alpha[i]) covered++;
    for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(A[3 * i + c] * (1 - t) + B[3 * i + c] * t);
  }
  await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(outPath);

  if (previewPath) {
    const ov = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const t = (alpha[i] / 255) * 0.5;
      ov[3 * i] = Math.round(A[3 * i] * (1 - t) + 255 * t);
      ov[3 * i + 1] = Math.round(A[3 * i + 1] * (1 - t));
      ov[3 * i + 2] = Math.round(A[3 * i + 2] * (1 - t) + 255 * t);
    }
    await sharp(ov, { raw: { width: W, height: H, channels: 3 } }).resize(Math.min(W, 1600)).jpeg({ quality: 85 }).toFile(previewPath);
  }
  return {
    width: W, height: H, regions: comps, coverage: +(covered / (W * H)).toFixed(4),
    ghostRepairs: repairs, ghostFraction: +scan.ghostFraction.toFixed(4), ghosts: ghostBoxes,
  };
}

// The character whose CURRENT sheet [masterPath] is, or descends from through earlier partial
// edits; null when the master is not a character sheet.
async function _sheetOwner(masterPath) {
  try {
    const { listCharacters } = await import('../../state/character-registry.js');
    const { MediaLibrary } = await import('../../state/media-library.js');
    const lib = MediaLibrary.global();
    const chain = [];
    let p = masterPath;
    for (let hop = 0; p && hop < 16; hop++) {
      chain.push(path.resolve(p));
      const meta = (await lib.getByPath(p))?.metadata || {};
      p = meta.partialEdit === true && typeof meta.compositeMasterPath === 'string' ? meta.compositeMasterPath : null;
    }
    return listCharacters().find((c) => typeof c.sheet === 'string' && c.sheet && chain.includes(path.resolve(c.sheet))) || null;
  } catch {
    return null;
  }
}

const compositePartialEditAction = {
  type: 'composite_partial_edit',
  intent: 'composite_partial_edit',
  description:
    'Image edit mode "master": build the partial edit = the clean MASTER with ONLY the areas the model really changed in its edit pasted on top (1:1, generous cut, fade outside the change), and register it as a creation. ' +
    'Required: "masterImage", "editImage" (the model\'s edit OF that master, same size). Optional: "regions" (normalised boxes [{x,y,w,h}] around where the change was asked; changed areas not touching them are left out), ' +
    '"sensitivity" (default 1; >1 catches subtler changes), "margin" (default 1; >1 cuts wider), "path" (output), "summary". ' +
    'When the master is a character\'s turnaround sheet the result says whose (characterSheetOf) and how to apply it to that character: save_character({ character: { id, sheet } }).',
  thinkingHint: 'Compositing edit',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      masterImage: { type: 'string', description: 'Absolute path of the master.' },
      editImage: { type: 'string', description: 'Absolute path of the model\'s edit of that master.' },
      regions: { type: 'array', items: { type: 'object' }, description: 'Optional normalised boxes {x,y,w,h} (0..1) around the requested change.' },
      sensitivity: { type: 'number' },
      margin: { type: 'number' },
      path: { type: 'string', description: 'Output path (default: next to the edit, "-partial.png").' },
      summary: { type: 'string' },
    },
    required: ['masterImage', 'editImage'],
  },

  async execute(action, agent) {
    const abs = (p) => (typeof p === 'string' && p.trim() ? path.resolve(p.trim()) : null);
    const masterPath = abs(action.masterImage), editPath = abs(action.editImage);
    for (const [k, p] of [['masterImage', masterPath], ['editImage', editPath]]) {
      if (!p) return { success: false, error: `composite_partial_edit: "${k}" is required (absolute path).` };
      if (!fs.existsSync(p)) return { success: false, error: `composite_partial_edit: "${k}" not found: ${p}` };
    }
    const outPath = abs(action.path) || editPath.replace(/\.[^.]+$/, '') + '-partial.png';
    // Outside the project: a check image is not a creation.
    const previewPath = path.join(os.tmpdir(), path.basename(outPath).replace(/\.[^.]+$/, '') + '.check.jpg');
    let built;
    try {
      built = await buildPartialComposite({
        masterPath, editPath, outPath, previewPath,
        regions: _normRegions(action.regions), sensitivity: action.sensitivity, margin: action.margin,
      });
    } catch (e) {
      return { success: false, error: `composite_partial_edit: ${e.message}` };
    }
    if (built.error) return { success: false, error: `composite_partial_edit: ${built.error}` };

    const { default: saveComposite } = await import('./save-composite-image.js');
    const reg = await saveComposite.execute({ path: outPath, masterImage: masterPath, editImage: editPath, summary: action.summary }, agent);
    const owner = await _sheetOwner(masterPath);
    // Ghosts the self-repair could not remove: one zoom per spot (master | edit | composite)
    // so the caller SEES the doubling instead of guessing from a thumbnail.
    const ghostCrops = [];
    if (built.ghosts?.length) {
      try {
        const sharp = (await import('sharp')).default;
        for (const [k, q] of built.ghosts.slice(0, 4).entries()) {
          const pad = 0.04;
          const left = Math.max(0, Math.floor((q.x - pad) * built.width));
          const top = Math.max(0, Math.floor((q.y - pad) * built.height));
          const width = Math.min(built.width - left, Math.ceil((q.w + 2 * pad) * built.width));
          const height = Math.min(built.height - top, Math.ceil((q.h + 2 * pad) * built.height));
          const tile = (p) => sharp(p).removeAlpha().extract({ left, top, width, height }).resize({ height: 480 }).png().toBuffer();
          const tiles = await Promise.all([masterPath, editPath, outPath].map(tile));
          const tw = (await sharp(tiles[0]).metadata()).width;
          const crop = path.join(os.tmpdir(), path.basename(outPath).replace(/\.[^.]+$/, '') + `.ghost${k + 1}.png`);
          await sharp({ create: { width: tw * 3 + 16, height: 480, channels: 3, background: '#000' } })
            .composite(tiles.map((input, i) => ({ input, left: i * (tw + 8), top: 0 }))).png().toFile(crop);
          ghostCrops.push({ ...q, zoom: crop });
        }
      } catch { /* the boxes alone still say where */ }
    }
    const ghostNote = built.ghosts?.length
      ? `NOT READY: ${built.ghosts.length} spot(s) still show the old and the new picture through each other (semi-transparent object at the edge of the paste). LOOK at each ghosts[].zoom (master | edit | composite), then re-run composite_partial_edit with regions that cover the whole changed object at those spots (and a higher margin). Do not deliver it like this. `
      : '';
    return {
      success: true,
      savedTo: outPath,
      id: reg?.id || null,
      regions: built.regions,
      coverage: built.coverage,
      checkImage: previewPath,
      selfCheck: built.ghosts?.length ? 'ghosts' : 'clean',
      ...(ghostCrops.length ? { ghosts: ghostCrops } : {}),
      ...(owner ? { characterSheetOf: { characterId: owner.id, name: owner.name } } : {}),
      note: ghostNote + 'Look at checkImage (pasted area tinted magenta) AND at the composite before delivering. A missed change → raise sensitivity or margin, or pass regions; a stray area → pass regions. Never deliver the whole edit instead.' +
        (owner
          ? ` This is an edit of ${owner.name}'s turnaround SHEET. Applying it to the character (whenever the user asks to put / apply / save the change on the character, or approves it for the character) is ONE call: save_character({ character: { id: "${owner.id}", sheet: "${outPath}" } }); only those two fields, everything else on the character is kept. Never tell the user the app cannot assign it.`
          : ''),
    };
  },
};

export default compositePartialEditAction;
