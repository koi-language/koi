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

  // Generous core: dilate every region.
  const m = Math.min(3, Math.max(0.5, Number(margin) || 1));
  const R = Math.max(3, Math.round((Math.max(W, H) * 0.015 * m) / BS));
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
  // Feather OUTSIDE the core: grow, then ramp; the core itself stays opaque.
  const F = Math.max(8, Math.round(Math.max(W, H) * 0.008 * m));
  const grown = await sharp(coreFull, { raw: { width: W, height: H, channels: 1 } }).blur(F).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < grown.length; i++) grown[i] = grown[i] > 4 ? 255 : 0;
  const alpha = await sharp(grown, { raw: { width: W, height: H, channels: 1 } }).blur(F / 2).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < W * H; i++) if (coreFull[i]) alpha[i] = 255;

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
  return { width: W, height: H, regions: comps, coverage: +(covered / (W * H)).toFixed(4) };
}

const compositePartialEditAction = {
  type: 'composite_partial_edit',
  intent: 'composite_partial_edit',
  description:
    'Image edit mode "master": build the partial edit = the clean MASTER with ONLY the areas the model really changed in its edit pasted on top (1:1, generous cut, fade outside the change), and register it as a creation. ' +
    'Required: "masterImage", "editImage" (the model\'s edit OF that master, same size). Optional: "regions" (normalised boxes [{x,y,w,h}] around where the change was asked; changed areas not touching them are left out), ' +
    '"sensitivity" (default 1; >1 catches subtler changes), "margin" (default 1; >1 cuts wider), "path" (output), "summary".',
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
    return {
      success: true,
      savedTo: outPath,
      id: reg?.id || null,
      regions: built.regions,
      coverage: built.coverage,
      checkImage: previewPath,
      note: 'Look at checkImage (pasted area tinted magenta) AND at the composite before delivering. A missed change → raise sensitivity or margin, or pass regions; a stray area → pass regions. Never deliver the whole edit instead.',
    };
  },
};

export default compositePartialEditAction;
