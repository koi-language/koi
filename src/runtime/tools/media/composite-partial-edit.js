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
    .map((r) => ({ x: Number(r?.x), y: Number(r?.y), w: Number(r?.w), h: Number(r?.h), shape: r?.shape === 'box' ? 'box' : undefined }))
    .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
}

/** Otsu threshold of a list of values (0..maxV). */
function _otsu(vals, maxV) {
  const bins = 256;
  const hist = new Float64Array(bins);
  for (const v of vals) hist[Math.min(bins - 1, Math.floor((v / maxV) * (bins - 1)))]++;
  const total = vals.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; th = i; }
  }
  return ((th + 0.5) / (bins - 1)) * maxV;
}

/**
 * SURGICAL paste for SMALL asked areas (an iris, a button, a badge, a scar),
 * any shape: the model's patch is ALIGNED onto the master (shift + scale),
 * then the cut is the exact shape of what changed (Otsu over a difference
 * weighted by what the change is: colour or light, each by how much it stands
 * out of the drift round the box), every part touching the box, holes inside
 * filled unless as big as the change (a frame's untouched picture stays),
 * feathered in proportion to the box (a pixel or two for an iris).
 */
async function _surgical({ sharp, A, B, W, H, regions, s, m }) {
  const fA = await sharp(A, { raw: { width: W, height: H, channels: 3 } }).blur(0.8).raw().toBuffer();
  const fB = await sharp(B, { raw: { width: W, height: H, channels: 3 } }).blur(0.8).raw().toBuffer();
  const alpha = new Float32Array(W * H);
  // What is pasted: the model's pixels ALIGNED onto the master.
  const src = Buffer.from(B);
  const comps = [];
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x * W)), y0 = Math.max(0, Math.floor(r.y * H));
    const x1 = Math.min(W, Math.ceil((r.x + r.w) * W)), y1 = Math.min(H, Math.ceil((r.y + r.h) * H));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 2 || rh < 2) continue;
    const S = Math.min(rw, rh);
    // The model re-draws: its eye / button sits a few pixels off and a bit
    // bigger or smaller. Align its patch onto the master first (shift +
    // scale that best matches the shapes round the region), then compare
    // and paste the ALIGNED pixels; never the model's patch where it lies.
    const lum = (buf, i) => 0.299 * buf[3 * i] + 0.587 * buf[3 * i + 1] + 0.114 * buf[3 * i + 2];
    const samp = (buf, x, y, c) => {
      const xi = Math.max(0, Math.min(W - 2, Math.floor(x))), yi = Math.max(0, Math.min(H - 2, Math.floor(y)));
      const fx = Math.max(0, Math.min(1, x - xi)), fy = Math.max(0, Math.min(1, y - yi));
      const i00 = yi * W + xi, i10 = i00 + 1, i01 = i00 + W, i11 = i01 + 1;
      return (buf[3 * i00 + c] * (1 - fx) + buf[3 * i10 + c] * fx) * (1 - fy) + (buf[3 * i01 + c] * (1 - fx) + buf[3 * i11 + c] * fx) * fy;
    };
    const cx = x0 + rw / 2, cy = y0 + rh / 2;
    const ex = Math.round(rw * 0.5), ey = Math.round(rh * 0.5);
    const ax0 = Math.max(0, x0 - ex), ay0 = Math.max(0, y0 - ey), ax1 = Math.min(W, x1 + ex), ay1 = Math.min(H, y1 + ey);
    const step = Math.max(1, Math.round(Math.max(ax1 - ax0, ay1 - ay0) / 60));
    let mA = 0, nA = 0;
    for (let y = ay0; y < ay1; y += step) for (let x = ax0; x < ax1; x += step) { mA += lum(fA, y * W + x); nA++; }
    mA /= nA;
    const M = Math.max(2, Math.round(S * 0.4));
    let best = { dx: 0, dy: 0, sc: 1, e: Infinity };
    const tryFit = (dx, dy, sc) => {
      let mB = 0;
      const pts = [];
      for (let y = ay0; y < ay1; y += step) for (let x = ax0; x < ax1; x += step) {
        const bx = cx + (x - cx) * sc + dx, by = cy + (y - cy) * sc + dy;
        const v = 0.299 * samp(fB, bx, by, 0) + 0.587 * samp(fB, bx, by, 1) + 0.114 * samp(fB, bx, by, 2);
        pts.push(v); mB += v;
      }
      mB /= pts.length;
      let e = 0, k = 0;
      for (let y = ay0; y < ay1; y += step) for (let x = ax0; x < ax1; x += step) {
        const t = (lum(fA, y * W + x) - mA) - (pts[k++] - mB);
        e += t * t;
      }
      if (e < best.e) best = { dx, dy, sc, e };
    };
    for (const sc of [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15]) {
      for (let dy = -M; dy <= M; dy += Math.max(1, Math.round(M / 8))) for (let dx = -M; dx <= M; dx += Math.max(1, Math.round(M / 8))) tryFit(dx, dy, sc);
    }
    { // refine round the best
      const b0 = { ...best };
      const st = Math.max(1, Math.round(M / 8));
      for (let dy = b0.dy - st; dy <= b0.dy + st; dy++) for (let dx = b0.dx - st; dx <= b0.dx + st; dx++) {
        for (const sc of [b0.sc - 0.025, b0.sc, b0.sc + 0.025]) tryFit(dx, dy, sc);
      }
    }
    // Over a window round the box (the thing may stick out of a box drawn a
    // bit off: an iris half under it), the ALIGNED edit against the master.
    const ww = ax1 - ax0, wh = ay1 - ay0;
    const al = new Float32Array(ww * wh * 3);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      const bx = cx + (ax0 + x - cx) * best.sc + best.dx, by = cy + (ay0 + y - cy) * best.sc + best.dy;
      for (let c = 0; c < 3; c++) al[3 * (y * ww + x) + c] = samp(B, bx, by, c);
    }
    const fal = await sharp(Buffer.from(al.map((v) => Math.max(0, Math.min(255, Math.round(v))))), { raw: { width: ww, height: wh, channels: 3 } })
      .blur(Math.max(0.6, S * 0.02)).raw().toBuffer();
    const fA2 = await sharp(A, { raw: { width: W, height: H, channels: 3 } })
      .extract({ left: ax0, top: ay0, width: ww, height: wh }).blur(Math.max(0.6, S * 0.02)).raw().toBuffer();
    // The difference, weighted by what the change IS: a hue change (hazel →
    // green) or a light one (a pale scar, a darker shadow). Each channel's
    // weight = how much it stands out of its own drift inside the box (its
    // 95th percentile over its median): the model's relighting of skin and
    // lids is everywhere and so weighs little; the asked change stands out.
    const dY = new Float32Array(ww * wh), dC = new Float32Array(ww * wh);
    const boxIdx = [];
    for (let k = 0; k < ww * wh; k++) {
      const yA = 0.299 * fA2[3 * k] + 0.587 * fA2[3 * k + 1] + 0.114 * fA2[3 * k + 2];
      const yB = 0.299 * fal[3 * k] + 0.587 * fal[3 * k + 1] + 0.114 * fal[3 * k + 2];
      dY[k] = Math.abs(yA - yB);
      dC[k] = Math.abs((fA2[3 * k + 2] - yA) - (fal[3 * k + 2] - yB)) + Math.abs((fA2[3 * k] - yA) - (fal[3 * k] - yB));
      const x = k % ww, y = (k / ww) | 0;
      if (ax0 + x >= x0 && ax0 + x < x1 && ay0 + y >= y0 && ay0 + y < y1) boxIdx.push(k);
    }
    // Signal inside the box, drift in the window round it (a change that fills
    // the whole box must not pass for the box's normal level).
    const inSet = new Uint8Array(ww * wh);
    for (const k of boxIdx) inSet[k] = 1;
    const outIdx = [];
    for (let k = 0; k < ww * wh; k++) if (!inSet[k]) outIdx.push(k);
    const pct = (arr, idx, q) => {
      const v = idx.map((k) => arr[k]).sort((p_, q_) => p_ - q_);
      return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : 0;
    };
    const ref = outIdx.length > 20 ? outIdx : boxIdx;
    const standY = pct(dY, boxIdx, 0.9) / (pct(dY, ref, 0.6) + 2);
    const standC = pct(dC, boxIdx, 0.9) / (pct(dC, ref, 0.6) + 2);
    const wY = standY / (standY + standC + 1e-6), wC = 1 - wY;
    const d = new Float32Array(ww * wh);
    let maxV = 1;
    for (let k = 0; k < ww * wh; k++) {
      const v = 2 * (wY * dY[k] + wC * 0.75 * dC[k]);
      d[k] = v;
      if (v > maxV) maxV = v;
    }
    const th = Math.max(_otsu(d, maxV), 14 / s);
    const mask = new Uint8Array(ww * wh);
    for (let k = 0; k < mask.length; k++) if (d[k] > th) mask[k] = 1;
    // Keep only the change that touches the asked box (connected parts).
    const inBox = (x, y) => ax0 + x >= x0 && ax0 + x < x1 && ay0 + y >= y0 && ay0 + y < y1;
    const lab = new Int32Array(ww * wh).fill(-1);
    const keep = new Uint8Array(ww * wh);
    const minArea = Math.max(3, Math.round(rw * rh * 0.01));
    for (let k0 = 0; k0 < mask.length; k0++) {
      if (!mask[k0] || lab[k0] >= 0) continue;
      const st = [k0], comp = [];
      lab[k0] = k0;
      let touches = false;
      while (st.length) {
        const g = st.pop(); comp.push(g);
        const gx = g % ww, gy = (g / ww) | 0;
        if (inBox(gx, gy)) touches = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
          const q = ny * ww + nx;
          if (mask[q] && lab[q] < 0) { lab[q] = k0; st.push(q); }
        }
      }
      if (touches && comp.length >= minArea) for (const g of comp) keep[g] = 1;
    }
    // Fill the holes inside the change that belong to it (the pupil and the
    // catch-lights of a recoloured iris did not change, but are part of it).
    // A hole as big as the change itself or bigger is something the change
    // surrounds and the model left alone (the photo inside a new frame): it
    // stays the master's.
    {
      let changed = 0;
      for (let k = 0; k < keep.length; k++) changed += keep[k];
      const seen = new Uint8Array(ww * wh);
      for (let k0 = 0; k0 < keep.length; k0++) {
        if (keep[k0] || seen[k0]) continue;
        const st = [k0], comp = [];
        seen[k0] = 1;
        let border = false;
        while (st.length) {
          const g = st.pop(); comp.push(g);
          const gx = g % ww, gy = (g / ww) | 0;
          if (gx === 0 || gy === 0 || gx === ww - 1 || gy === wh - 1) border = true;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = gx + dx, ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
            const q = ny * ww + nx;
            if (!keep[q] && !seen[q]) { seen[q] = 1; st.push(q); }
          }
        }
        if (border) continue;
        if (comp.length <= changed * 0.6 || comp.length < rw * rh * 0.01) for (const g of comp) keep[g] = 1;
      }
    }
    // A hair wider than the change, then a feather in proportion to the box.
    const F = Math.max(0.6, S * 0.06 * m);
    const grown = await sharp(Buffer.from(keep.map((v) => v * 255)), { raw: { width: ww, height: wh, channels: 1 } })
      .blur(Math.max(0.4, F * 0.5)).extractChannel(0).raw().toBuffer();
    const core = new Uint8Array(ww * wh);
    for (let k = 0; k < core.length; k++) core[k] = grown[k] > 40 ? 255 : 0;
    const soft = await sharp(Buffer.from(core), { raw: { width: ww, height: wh, channels: 1 } })
      .blur(Math.max(0.4, F * 0.5)).extractChannel(0).raw().toBuffer();
    let bx0 = ww, by0 = wh, bx1 = -1, by1 = -1;
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      const k = y * ww + x;
      const t = soft[k] / 255;
      if (t <= 0.004) continue;
      const i = (ay0 + y) * W + (ax0 + x);
      if (t > alpha[i]) {
        alpha[i] = t;
        for (let c = 0; c < 3; c++) src[3 * i + c] = Math.max(0, Math.min(255, Math.round(al[3 * k + c])));
      }
      if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
    }
    if (bx1 >= 0) comps.push({ x: +((ax0 + bx0) / W).toFixed(4), y: +((ay0 + by0) / H).toFixed(4), w: +((bx1 - bx0 + 1) / W).toFixed(4), h: +((by1 - by0 + 1) / H).toFixed(4) });
  }
  return { alpha, comps, src };
}

export async function buildPartialComposite({ masterPath, editPath, outPath, previewPath, regions = [], sensitivity = 1, margin = 1 }) {
  const sharp = (await import('sharp')).default;
  const a = await sharp(masterPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(editPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = a.info.width, H = a.info.height;
  if (b.info.width !== W || b.info.height !== H) {
    return { error: `size mismatch: master ${W}x${H}, edit ${b.info.width}x${b.info.height}. A resolution change makes the edit the NEW master: deliver it whole, no composite.` };
  }
  // Small asked areas (each under ~6 % of the picture's side): surgical cut.
  // Mixed with big ones: the big ones first (the detector), then the small
  // ones surgically on top of that result.
  const isSmall = (r) => Math.max(r.w * W, r.h * H) < Math.max(W, H) * 0.06;
  const smallR = regions.filter(isSmall), bigR = regions.filter((r) => !isSmall(r));
  if (smallR.length && bigR.length) {
    const mid = outPath.replace(/\.[^.]+$/, '') + '.big.png';
    const r1 = await buildPartialComposite({ masterPath, editPath, outPath: mid, previewPath: null, regions: bigR, sensitivity, margin });
    if (r1.error) return r1;
    const r2 = await buildPartialComposite({ masterPath: mid, editPath, outPath, previewPath, regions: smallR, sensitivity, margin });
    try { fs.unlinkSync(mid); } catch { /* */ }
    if (r2.error) return r2;
    return { ...r1, regions: [...r1.regions, ...r2.regions], coverage: +(r1.coverage + r2.coverage).toFixed(6), surgical: true,
      ghosts: r1.ghosts || [] };
  }
  if (regions.length && regions.every(isSmall)) {
    const s = Math.min(3, Math.max(0.3, Number(sensitivity) || 1));
    const m = Math.min(3, Math.max(0.5, Number(margin) || 1));
    const { alpha, comps, src } = await _surgical({ sharp, A: a.data, B: b.data, W, H, regions, s, m });
    if (!comps.length) return { error: 'no change found inside the regions (raise "sensitivity", or draw the regions on the changed spot).' };
    const A = a.data, B = src;
    const out = Buffer.alloc(W * H * 3);
    let covered = 0;
    for (let i = 0; i < W * H; i++) {
      const t = alpha[i];
      if (t > 0) covered++;
      for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(A[3 * i + c] * (1 - t) + B[3 * i + c] * t);
    }
    await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(outPath);
    if (previewPath) {
      const ov = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) {
        const t = alpha[i] * 0.5;
        ov[3 * i] = Math.round(A[3 * i] * (1 - t) + 255 * t);
        ov[3 * i + 1] = Math.round(A[3 * i + 1] * (1 - t));
        ov[3 * i + 2] = Math.round(A[3 * i + 2] * (1 - t) + 255 * t);
      }
      await sharp(ov, { raw: { width: W, height: H, channels: 3 } }).resize(Math.min(W, 1600)).jpeg({ quality: 85 }).toFile(previewPath);
    }
    return { width: W, height: H, regions: comps, coverage: +(covered / (W * H)).toFixed(6), surgical: true,
      ghostRepairs: 0, ghostFraction: 0, ghosts: [] };
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

/**
 * Surgical cut: one zoom per region (master | model's edit | composite), the
 * region outlined, so the caller SEES whether its box sat on the thing (an
 * iris) or beside it (the eyelid), and moves it if not.
 */
export async function surgicalZooms({ masterPath, editPath, outPath, regions, width: W, height: H }) {
  const out = [];
  try {
    const sharp = (await import('sharp')).default;
    for (const [k, q] of (regions || []).slice(0, 8).entries()) {
      const rx = q.x * W, ry = q.y * H, rw = q.w * W, rh = q.h * H;
      const pad = Math.max(rw, rh) * 1.2;
      const left = Math.max(0, Math.floor(rx - pad)), top = Math.max(0, Math.floor(ry - pad));
      const width = Math.min(W - left, Math.ceil(rw + 2 * pad)), height = Math.min(H - top, Math.ceil(rh + 2 * pad));
      const th = 360, sc = th / height, tw = Math.round(width * sc);
      const box = Buffer.from(`<svg width="${tw}" height="${th}"><rect x="${(rx - left) * sc}" y="${(ry - top) * sc}" width="${rw * sc}" height="${rh * sc}" fill="none" stroke="#ff00ff" stroke-width="2"/></svg>`);
      const tiles = await Promise.all([masterPath, editPath, outPath].map((p, i) => sharp(p).removeAlpha()
        .extract({ left, top, width, height }).resize({ width: tw, height: th, kernel: 'nearest' })
        .composite(i === 2 ? [] : [{ input: box, left: 0, top: 0 }]).png().toBuffer()));
      const zoom = path.join(os.tmpdir(), path.basename(outPath).replace(/\.[^.]+$/, '') + `.region${k + 1}.png`);
      await sharp({ create: { width: tw * 3 + 16, height: th, channels: 3, background: '#000' } })
        .composite(tiles.map((input, i) => ({ input, left: i * (tw + 8), top: 0 }))).png().toFile(zoom);
      out.push({ ...q, zoom });
    }
  } catch { /* the composite stands */ }
  return out;
}

export const SURGICAL_NOTE = 'SURGICAL cut: each small region was pasted whole (aligned). READ every regionZooms[].zoom (master with your box | edit with your box | composite) before delivering: if a box is not ON the changed thing (e.g. it covers the eyelid, not the iris), move / resize it and call again.';

export { _normRegions as normRegions };

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
    'Required: "masterImage", "editImage" (the model\'s edit OF that master, same size). Optional: "regions" (normalised boxes [{x,y,w,h}] around where the change was asked; changed areas not touching them are left out). SMALL regions (an iris, a button, a badge: each under ~6 % of the picture\'s side) switch to a SURGICAL cut: the region IS the cut. The model\'s patch is first ALIGNED onto the master (it re-draws a few px off), then everything inside the region is pasted, as an ellipse (or shape:"box"), with a feather of ~12 % of the region (margin scales it). So draw each box TIGHT round exactly the thing that changes (one box per iris, per view), nothing more, ' +
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
    const regionZooms = built.surgical
      ? await surgicalZooms({ masterPath, editPath, outPath, regions: _normRegions(action.regions), width: built.width, height: built.height })
      : [];
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
      ...(regionZooms.length ? {
        surgical: true,
        regionZooms,
        regionNote: SURGICAL_NOTE,
      } : {}),
      ...(owner ? { characterSheetOf: { characterId: owner.id, name: owner.name } } : {}),
      note: ghostNote + 'Look at checkImage (pasted area tinted magenta) AND at the composite before delivering. A missed change → raise sensitivity or margin, or pass regions; a stray area → pass regions. Never deliver the whole edit instead.' +
        (owner
          ? ` This is an edit of ${owner.name}'s turnaround SHEET. Applying it to the character (whenever the user asks to put / apply / save the change on the character, or approves it for the character) is ONE call: save_character({ character: { id: "${owner.id}", sheet: "${outPath}" } }); only those two fields, everything else on the character is kept. Never tell the user the app cannot assign it.`
          : ''),
    };
  },
};

export default compositePartialEditAction;
