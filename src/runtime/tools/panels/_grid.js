/**
 * Virtual panel-grid geometry for storyboard panel sheets.
 *
 * A panel sheet is ONE image (a 4:3 contact sheet) carrying a fixed grid of
 * panels (default 3 columns x 4 rows, which makes every cell exactly 16:9).
 * Panels are NEVER stored as separate artifacts: they are virtual rectangles
 * computed over the single sheet image. These helpers are shared by
 * extract_panel (ephemeral working copy) and replace_panel (in-place
 * composite back into the sheet).
 */

/**
 * Compute the pixel rect of a 1-based, row-major panel index inside a sheet.
 * An inset (default ~0.4% of the smaller dimension, min 2px) keeps the thin
 * black gutter lines out of the crop and untouched on composite.
 *
 * @returns {{left:number, top:number, width:number, height:number,
 *            cell:{left:number, top:number, width:number, height:number}}}
 */
export function panelRect({ width, height, panel, cols = 3, rows = 4, inset = null }) {
  const cellW = width / cols;
  const cellH = height / rows;
  const idx = panel - 1;
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  const pad = inset == null ? Math.max(2, Math.round(Math.min(width, height) * 0.004)) : inset;

  const cell = {
    left: Math.round(col * cellW),
    top: Math.round(row * cellH),
    width: Math.round(cellW),
    height: Math.round(cellH),
  };
  return {
    left: cell.left + pad,
    top: cell.top + pad,
    width: Math.min(width - (cell.left + pad), cell.width - pad * 2),
    height: Math.min(height - (cell.top + pad), cell.height - pad * 2),
    cell,
  };
}

/**
 * GUTTER-SNAPPED panel rect with full grid AUTO-DETECTION.
 *
 * The image model sometimes renders UNEVEN rows/columns, and the grid shape
 * itself (cols x rows) may vary per sheet. So instead of trusting fractions:
 *  - downsample to <=1024px greyscale and build per-scanline MAX-luminance
 *    profiles for rows and columns (a pure-black gutter line has max ~0 even
 *    when the panel imagery is dark);
 *  - cluster near-black scanlines into bands; THIN bands are gutters, THICK
 *    bands are empty black regions (their edges are also valid boundaries);
 *  - when cols/rows are not supplied, score candidate counts 2..6 by how many
 *    expected internal boundaries land on a detected gutter and pick the best;
 *  - snap each expected boundary to the nearest detected candidate within a
 *    +-18%-of-cell window, falling back to the uniform fraction otherwise.
 */
async function _profiles(sharp, sheet) {
  const meta = await sharp(sheet).metadata();
  const W = meta.width, H = meta.height;
  const targetW = Math.min(1024, W);
  const scale = W / targetW;
  const targetH = Math.max(8, Math.round(H / scale));
  const raw = await sharp(sheet).resize(targetW, targetH, { fit: 'fill', kernel: 'nearest' }).greyscale().raw().toBuffer();
  const rowMax = new Array(targetH).fill(0);
  const colMax = new Array(targetW).fill(0);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const v = raw[y * targetW + x];
      if (v > rowMax[y]) rowMax[y] = v;
      if (v > colMax[x]) colMax[x] = v;
    }
  }
  return { W, H, targetW, targetH, rowMax, colMax, raw };
}

/** Cluster near-black scanlines into bands; return boundary CANDIDATES:
 *  centers of thin bands (gutters) plus edges of thick bands (black regions). */
function _candidates(maxArr, extent) {
  const BLACK = 20;
  const thinMax = Math.max(3, Math.round(extent * 0.02));
  const out = [];
  let start = -1;
  for (let i = 0; i <= maxArr.length; i++) {
    const isBlack = i < maxArr.length && maxArr[i] < BLACK;
    if (isBlack && start < 0) start = i;
    if (!isBlack && start >= 0) {
      const w = i - start;
      let bandMax = 0;
      for (let k = start; k < i; k++) if (maxArr[k] > bandMax) bandMax = maxArr[k];
      if (w <= thinMax) out.push({ pos: Math.round(start + w / 2), max: bandMax, width: w });
      else {
        if (start > 0) out.push({ pos: start, max: bandMax, width: w });
        if (i < maxArr.length) out.push({ pos: i, max: bandMax, width: w });
      }
      start = -1;
    }
  }
  return out;
}

/** Pick the most plausible count (2..6) of cells along one axis.
 *  Nested grids ALIAS downward (a 4-row grid's middle gutter also satisfies
 *  n=2), so among high-scoring candidates prefer the LARGEST n: a genuine
 *  2-row grid cannot score high as 4 rows, but a 4-row grid scores 1.0 as 2. */
function _pickCount(cands, extent) {
  const scores = [];
  for (let n = 2; n <= 6; n++) {
    const cell = extent / n;
    const win = cell * 0.35;
    let hits = 0;
    for (let j = 1; j < n; j++) {
      const exp = j * cell;
      if (cands.some((c) => Math.abs(c.pos - exp) <= win)) hits++;
    }
    scores.push({ n, score: hits / (n - 1) });
  }
  const high = scores.filter((s) => s.score >= 0.75);
  if (high.length) return high[high.length - 1].n; // largest n among high scorers
  const best = scores.reduce((a, b) => (b.score > a.score + 1e-9 ? b : a));
  return best.score >= 0.5 ? best.n : null;
}

function _boundaries(count, extent, cands) {
  const out = [0];
  const cell = extent / count;
  for (let j = 1; j < count; j++) {
    const exp = j * cell;
    const win = cell * 0.35;
    // Rank in-window candidates by GUTTER QUALITY first (darker, thinner),
    // distance to the expected position only as tiebreak: a dark line inside
    // the panel imagery must not beat the real pure-black separator.
    let best = null;
    for (const c of cands) {
      const d = Math.abs(c.pos - exp);
      if (d > win) continue;
      const better = !best
        || c.max < best.max - 4
        || (Math.abs(c.max - best.max) <= 4 && c.width < best.width)
        || (Math.abs(c.max - best.max) <= 4 && c.width === best.width && d < Math.abs(best.pos - exp));
      if (better) best = c;
    }
    out.push(best == null ? Math.round(exp) : best.pos);
  }
  out.push(extent);
  // Monotonicity guard: boundaries must increase with a sane minimum cell;
  // any violation falls that boundary back to its uniform fraction.
  const minCell = cell * 0.4;
  for (let j = 1; j < count; j++) {
    if (out[j] - out[j - 1] < minCell || out[j + 1] - out[j] < minCell) out[j] = Math.round(j * cell);
  }
  return out;
}

/** Trim pure-black margins INSIDE a cell down to the content bounding box
 *  (sheets sometimes fill part of a cell with black). Works in downsampled
 *  coords; never trims more than 40% from any single edge. */
function _trimCellToContent(raw, targetW, cell) {
  const BLACK = 20;
  const maxRow = (y) => { let m = 0; for (let x = cell.l; x < cell.r; x += 2) { const v = raw[y * targetW + x]; if (v > m) m = v; } return m; };
  const maxCol = (x) => { let m = 0; for (let y = cell.t; y < cell.b; y += 2) { const v = raw[y * targetW + x]; if (v > m) m = v; } return m; };
  const capH = Math.round((cell.b - cell.t) * 0.4);
  const capW = Math.round((cell.r - cell.l) * 0.4);
  let { l, t: tt, r, b } = cell;
  let n = 0; while (tt < b - 4 && n < capH && maxRow(tt) < BLACK) { tt++; n++; }
  n = 0; while (b > tt + 4 && n < capH && maxRow(b - 1) < BLACK) { b--; n++; }
  n = 0; while (l < r - 4 && n < capW && maxCol(l) < BLACK) { l++; n++; }
  n = 0; while (r > l + 4 && n < capW && maxCol(r - 1) < BLACK) { r--; n++; }
  return { l, t: tt, r, b };
}

// ── CONTENT-ISLAND SEGMENTATION: the PRIMARY panel geometry ─────────────
//
// LAW (user explicit): panel geometry comes EXCLUSIVELY from analyzing the
// image (finding the black bands that cross it), NEVER from metadata. The
// hint/snap grid below survives only as the FALLBACK for implausible
// segmentations (legacy sheets keep working through their metadata).

/** Contiguous [start,end) runs where prof[i] >= thr. */
function _contentRuns(prof, thr) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= prof.length; i++) {
    const on = i < prof.length && prof[i] >= thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push({ start, end: i }); start = -1; }
  }
  return out;
}

/** Max of prof over [a,b). */
function _bandMax(prof, a, b) {
  let m = 0;
  for (let i = a; i < b; i++) if (prof[i] > m) m = prof[i];
  return m;
}

/** SLIVER MERGE: dark panel content can contain full-width near-black lines
 *  that split a stripe/island. Iteratively merge a run into its neighbour
 *  ACROSS the intervening band when the run's size < 40% of the median run
 *  size AND the band's max luminance > 6: real gutters in NEW sheets are pure
 *  #000000 (max 0), content noise bands are never pure 0. When both bands
 *  qualify, merge across the brighter (most content-like) one.
 *  [medianOverride] pins the sliver test to a SHEET-WIDE median: within one
 *  stripe made only of ghost fragments (blacked-out cell residue), the local
 *  median IS a fragment and nothing would ever qualify as a sliver. */
function _mergeSlivers(runs, prof, medianOverride = null) {
  let cur = runs.slice();
  let changed = true;
  while (changed && cur.length > 1) {
    changed = false;
    const sizes = cur.map((r) => r.end - r.start).sort((a, b) => a - b);
    const median = medianOverride ?? sizes[Math.floor(sizes.length / 2)];
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].end - cur[i].start >= median * 0.4) continue;
      let mergeWith = null, bestBand = 6;
      if (i > 0) {
        const bm = _bandMax(prof, cur[i - 1].end, cur[i].start);
        if (bm > bestBand) { bestBand = bm; mergeWith = i - 1; }
      }
      if (i < cur.length - 1) {
        const bm = _bandMax(prof, cur[i].end, cur[i + 1].start);
        if (bm > bestBand) { bestBand = bm; mergeWith = i + 1; }
      }
      if (mergeWith == null) continue;
      const a = Math.min(i, mergeWith), b = Math.max(i, mergeWith);
      cur.splice(a, 2, { start: cur[a].start, end: cur[b].end });
      changed = true;
      break; // restart the pass: the median moved
    }
  }
  return cur;
}

/**
 * Segment a sheet into CONTENT ISLANDS at FULL resolution (downsampling
 * blurs thin gutters; loops sample x/y stride 2 for speed):
 *   1) greyscale raw buffer; per-scanline MAX-luminance row profile;
 *   2) CONTENT STRIPES: row runs with max >= 20, discarding stripes shorter
 *      than 4% of H (noise slivers); black bands of ANY width separate them;
 *   3) per stripe: per-column max profile WITHIN the stripe; CONTENT ISLANDS
 *      are column runs with max >= 20 wider than 4% of W;
 *   4) panels = islands in reading order (stripes top-to-bottom, islands
 *      left-to-right), each the island's bounding box;
 *   5) sliver merge on both axes (see _mergeSlivers).
 * Returns { W, H, panels: [{left,top,width,height}], stripes }.
 */
export async function contentIslands({ sharp, sheet }) {
  // MEASURE ONCE, THEN CACHE (user requirement): the island geometry is
  // persisted at ~/.koi/panels/<base>/geometry.json and shared with the GUI
  // visor, keyed by the sheet's mtime (floor ms, matching Dart's integer
  // DateTime) + file size. A hit skips the pixel analysis entirely; any
  // mutation changes mtime/size AND the mutating tools delete the cache
  // right after writing, so stale geometry can never be served.
  let st = null;
  try { st = fs.statSync(sheet); } catch { /* the decode below will throw the real error */ }
  if (st) {
    const cached = _readGeometryCache(sheet, st);
    if (cached) return { W: cached.width, H: cached.height, panels: cached.islands, stripes: null, cached: true };
  }

  const meta = await sharp(sheet).metadata();
  const W = meta.width, H = meta.height;
  const raw = await sharp(sheet).greyscale().raw().toBuffer(); // FULL res
  const CONTENT = 20;

  // 1) Row profile (x stride 2; early-out once classification is fixed).
  const rowMax = new Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    let m = 0;
    for (let x = 0; x < W; x += 2) {
      const v = raw[off + x];
      if (v > m) { m = v; if (m >= CONTENT) break; }
    }
    rowMax[y] = m;
  }

  // 2) Content stripes + sliver merge.
  let stripes = _contentRuns(rowMax, CONTENT).filter((s) => s.end - s.start >= H * 0.04);
  stripes = _mergeSlivers(stripes, rowMax);

  // 3+4) Per-stripe islands, reading order. TWO passes: raw islands of every
  // stripe first, so the sliver merge can use the SHEET-WIDE median island
  // width (a stripe holding only ghost fragments of a blacked-out cell has no
  // full-size island of its own to anchor the local median).
  const perStripe = [];
  const allWidths = [];
  for (const s of stripes) {
    const colMax = new Array(W).fill(0);
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let y = s.start; y < s.end; y += 2) {
        const v = raw[y * W + x];
        if (v > m) { m = v; if (m >= CONTENT) break; }
      }
      colMax[x] = m;
    }
    const islands = _contentRuns(colMax, CONTENT).filter((r) => r.end - r.start >= W * 0.04);
    for (const r of islands) allWidths.push(r.end - r.start);
    perStripe.push({ stripe: s, colMax, islands });
  }
  allWidths.sort((a, b) => a - b);
  const globalMedian = allWidths.length ? allWidths[Math.floor(allWidths.length / 2)] : null;

  const panels = [];
  for (const { stripe: s, colMax, islands } of perStripe) {
    const merged = _mergeSlivers(islands, colMax, globalMedian);
    for (const isl of merged) {
      panels.push({ left: isl.start, top: s.start, width: isl.end - isl.start, height: s.end - s.start });
    }
  }
  if (st) _writeGeometryCache(sheet, st, { width: W, height: H, islands: panels });
  return { W, H, panels, stripes: stripes.length, cached: false };
}

export async function snappedPanelRect({ sharp, sheet, panel, cols = null, rows = null, inset = null }) {
  // ── ISLANDS FIRST (the law: pixels, never metadata). Fallback only on an
  //    implausible segmentation (count outside 1..24) or a panel index beyond
  //    the found islands (legacy sheets resolve through their hint). ──
  try {
    const seg = await contentIslands({ sharp, sheet });
    const n = seg.panels.length;
    if (n >= 1 && n <= 24 && panel <= n) {
      const box = seg.panels[panel - 1];
      const pad = inset == null ? Math.max(2, Math.round(Math.min(seg.W, seg.H) * 0.004)) : inset;
      const cell = { left: box.left, top: box.top, width: box.width, height: box.height };
      return {
        // READ rect: the island box with the usual small inset.
        left: cell.left + pad,
        top: cell.top + pad,
        width: Math.max(8, Math.min(seg.W - (cell.left + pad), cell.width - pad * 2)),
        height: Math.max(8, Math.min(seg.H - (cell.top + pad), cell.height - pad * 2)),
        cell,
        // WRITE targets: the island box EXACTLY (composites and blackens
        // must cover the whole island).
        cellFull: { ...cell },
        cellBounds: { ...cell },
        panelCount: n,
        sheetWidth: seg.W, sheetHeight: seg.H,
        snapped: true, geometry: 'islands',
      };
    }
  } catch { /* segmentation failure: legacy path below */ }

  let prof = null;
  try { prof = await _profiles(sharp, sheet); } catch { /* fall back below */ }

  if (!prof) {
    const meta = await sharp(sheet).metadata();
    const r = panelRect({ width: meta.width, height: meta.height, panel, cols: cols || 3, rows: rows || 4, inset });
    return { ...r, cols: cols || 3, rows: rows || 4, sheetWidth: meta.width, sheetHeight: meta.height, snapped: false, geometry: 'uniform' };
  }

  const { W, H, targetW, targetH, rowMax, colMax } = prof;
  const rowCands = _candidates(rowMax, targetH);
  const colCands = _candidates(colMax, targetW);

  // IRREGULAR GRIDS: when the detected gutters are clean, use them DIRECTLY
  // as the partition (no regularity assumption at all: row 2 may be taller
  // than row 1). Only fall back to expected-position snapping when the
  // candidate set is ambiguous.
  const direct = (cands, extent) => {
    const sorted = [...cands].sort((a, b) => a.pos - b.pos);
    const thinMax = Math.max(3, Math.round(extent * 0.02));
    const strong = [];
    for (const c of sorted) {
      // Direct partition trusts only THIN, very dark bands (real separators);
      // thick-region edges and dark content lines go through the fallback.
      if (c.max >= 16 || c.width > thinMax) continue;
      // Image-edge black borders are not internal gutters.
      if (c.pos < extent * 0.02 || c.pos > extent * 0.98) continue;
      if (strong.length && c.pos - strong[strong.length - 1] < extent * 0.01) continue;
      strong.push(c.pos);
    }
    const count = strong.length + 1;
    if (count < 2 || count > 6) return null;
    const b = [0, ...strong, extent];
    for (let i = 1; i < b.length; i++) {
      const seg = (b[i] - b[i - 1]) / extent;
      // Real cells never span more than ~60% of an axis; a merged-black
      // phantom segment does, which is what tells the two cases apart.
      if (seg < 0.12 || seg > 0.6) return null;
    }
    return b;
  };

  // Resolution order per axis: (1) the HINTED count (params or the sheet's
  // metadata.grid) with per-boundary snap-or-uniform: dark panel content can
  // forge thin near-black lines indistinguishable from real gutters, so a
  // declared grid always beats detection (a sheet whose stamp genuinely
  // mismatches its drawing is a legacy one-off: re-render it once);
  // (2) with no hint: the strict direct partition from clean thin gutters;
  // (3) windowed count inference as the last resort.
  let rowB = null, colB = null;
  if (!rows) rowB = direct(rowCands, targetH);
  if (!cols) colB = direct(colCands, targetW);
  const nRows = rows || (rowB ? rowB.length - 1 : (_pickCount(rowCands, targetH) || 4));
  const nCols = cols || (colB ? colB.length - 1 : (_pickCount(colCands, targetW) || 3));
  if (!rowB) rowB = _boundaries(nRows, targetH, rowCands);
  if (!colB) colB = _boundaries(nCols, targetW, colCands);
  rowB = rowB.map((v) => Math.round(v * (H / targetH)));
  colB = colB.map((v) => Math.round(v * (W / targetW)));

  const idx = panel - 1;
  const col = idx % nCols;
  const row = Math.floor(idx / nCols);
  if (row >= nRows) {
    return { error: `panel ${panel} is outside the detected ${nCols}x${nRows} grid (max ${nCols * nRows}).` };
  }
  // Snap to gutters, then trim any pure-black filler inside the cell down to
  // the real content box (downsampled coords -> back to full-res).
  const sx = targetW / W, sy = targetH / H;
  const down = {
    l: Math.max(0, Math.round(colB[col] * sx)),
    t: Math.max(0, Math.round(rowB[row] * sy)),
    r: Math.min(targetW, Math.round(colB[col + 1] * sx)),
    b: Math.min(targetH, Math.round(rowB[row + 1] * sy)),
  };
  const trimmed = _trimCellToContent(prof.raw, targetW, down);
  const cell = {
    left: Math.round(trimmed.l / sx),
    top: Math.round(trimmed.t / sy),
    width: Math.round((trimmed.r - trimmed.l) / sx),
    height: Math.round((trimmed.b - trimmed.t) / sy),
  };
  const pad = inset == null ? Math.max(2, Math.round(Math.min(W, H) * 0.004)) : inset;
  // FULL cell (boundary to boundary): the WRITE target. Composites must cover
  // the whole cell or leftovers of the previous panel show as borders; the
  // trimmed content box above is only for READING (edit working copies).
  const bLeft = colB[col], bTop = rowB[row];
  const cellFull = {
    left: bLeft + pad,
    top: bTop + pad,
    width: Math.max(8, colB[col + 1] - bLeft - pad * 2),
    height: Math.max(8, rowB[row + 1] - bTop - pad * 2),
  };
  const cellBounds = { left: bLeft, top: bTop, width: colB[col + 1] - bLeft, height: rowB[row + 1] - bTop };
  return {
    left: cell.left + pad,
    top: cell.top + pad,
    width: Math.max(8, Math.min(W - (cell.left + pad), cell.width - pad * 2)),
    height: Math.max(8, Math.min(H - (cell.top + pad), cell.height - pad * 2)),
    cell, cellFull, cellBounds, cols: nCols, rows: nRows,
    sheetWidth: W, sheetHeight: H, snapped: true, geometry: 'grid-fallback',
  };
}

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Grid hint from the sheet creation's metadata (metadata.grid), tolerant of
 *  nesting and a missing MediaLibrary. Anchors detection on sheets whose black
 *  regions swallow gutters (e.g. after delete_panel blackens cells). */
export async function readGridHint(sheet) {
  try {
    const { MediaLibrary } = await import('../../state/media-library.js');
    const row = await MediaLibrary.global().getByPath(sheet);
    const meta = row?.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null;
    const m = meta?.metadata && typeof meta.metadata === 'object' ? meta.metadata : meta;
    const g = m?.grid;
    if (g && Number.isInteger(g.cols) && Number.isInteger(g.rows)) return { cols: g.cols, rows: g.rows };
  } catch { /* no library / no row: caller falls back to inference */ }
  return null;
}

/** Per-panel version store: ~/.koi/panels/<sheet-basename>/p<N>/ */
export function versionsDir(sheet, panel) {
  const home = process.env.HOME || os.homedir();
  const base = path.basename(sheet).replace(/\.[a-z0-9]+$/i, '');
  return path.join(home, '.koi', 'panels', base, `p${panel}`);
}

/** Shared island-geometry cache file, read/written by BOTH the engine tools
 *  and the GUI visor so each sheet is measured exactly once until it changes:
 *  ~/.koi/panels/<sheet-basename>/geometry.json with
 *  { algo, mtimeMs, fileSize, width, height, islands, analyzedAt }. */
export function geometryCachePath(sheet) {
  const home = process.env.HOME || os.homedir();
  const base = path.basename(sheet).replace(/\.[a-z0-9]+$/i, '');
  return path.join(home, '.koi', 'panels', base, 'geometry.json');
}

function _readGeometryCache(sheet, st) {
  try {
    const j = JSON.parse(fs.readFileSync(geometryCachePath(sheet), 'utf8'));
    if (j?.algo !== 'islands-v1') return null;
    if (j.mtimeMs !== Math.floor(st.mtimeMs) || j.fileSize !== st.size) return null;
    if (!Array.isArray(j.islands) || !Number.isInteger(j.width) || !Number.isInteger(j.height)) return null;
    return j;
  } catch { return null; }
}

function _writeGeometryCache(sheet, st, { width, height, islands }) {
  try {
    const p = geometryCachePath(sheet);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({
      algo: 'islands-v1',
      mtimeMs: Math.floor(st.mtimeMs),
      fileSize: st.size,
      width,
      height,
      islands,
      analyzedAt: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, p);
  } catch { /* cache is an optimization: never fatal */ }
}

/** Drop the cached geometry. Mutating tools call this right after writing
 *  the sheet: mtime+size usually change anyway, but a same-millisecond
 *  rewrite must never serve stale islands. */
export function invalidateGeometryCache(sheet) {
  try { fs.rmSync(geometryCachePath(sheet), { force: true }); } catch { /* */ }
}

export function readVersions(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8')); }
  catch { return { current: null, order: [] }; }
}

export function writeVersions(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.versions-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path.join(dir, 'versions.json'));
}

/** Composite an image into a panel's (snapped) cell, replacing the sheet
 *  atomically. Shared by replace_panel and panel_versions restore. */
export async function compositePanel({ sharp, sheet, panel, image, cols = null, rows = null, drawNumber = false }) {
  const r = await snappedPanelRect({ sharp, sheet, panel, cols, rows });
  if (r.error) return { error: r.error };
  // Write target = the FULL cell: covering less leaves borders of the old panel.
  const dst = r.cellFull || r;
  let panelBuf = await sharp(image)
    .resize(dst.width, dst.height, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
  if (drawNumber) {
    panelBuf = await sharp(panelBuf)
      .composite([{ input: numberOverlaySvg({ width: dst.width, height: dst.height, number: panel }), left: 0, top: 0 }])
      .png()
      .toBuffer();
  }
  const tmpOut = path.join(path.dirname(sheet), `.${path.basename(sheet)}.panel-tmp-${Date.now()}.png`);
  await sharp(sheet)
    .composite([{ input: panelBuf, left: dst.left, top: dst.top }])
    .png()
    .toFile(tmpOut);
  fs.renameSync(tmpOut, sheet);
  invalidateGeometryCache(sheet);
  return { rect: dst };
}

/** Validate the shared { sheet, panel, cols, rows } params. Returns an error string or null. */
export function validateGridParams({ sheet, panel, cols = null, rows = null }) {
  if (typeof sheet !== 'string' || !sheet.trim() || !sheet.startsWith('/')) {
    return '"sheet" is required: the ABSOLUTE path to the panel-sheet image (the PNG returned by generate_image / inspect_creation).';
  }
  if (!Number.isInteger(panel) || panel < 1) {
    return '"panel" is required: the 1-based panel number (row-major: top-left is 1).';
  }
  const given = (v) => v != null;
  if (given(cols) !== given(rows)) return 'Pass BOTH "cols" and "rows", or NEITHER (auto-detect).';
  if (given(cols)) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 6 || rows > 6) {
      return '"cols"/"rows" must be small positive integers (or omitted for auto-detection).';
    }
    if (panel > cols * rows) {
      return `"panel" ${panel} is outside the ${cols}x${rows} grid (max ${cols * rows}).`;
    }
  }
  return null;
}

/** SVG overlay that stamps the panel number top-left, matching the sheet convention
 *  (plain white numeral with a dark outline). */
export function numberOverlaySvg({ width, height, number }) {
  const fontSize = Math.max(18, Math.round(height * 0.10));
  const pad = Math.max(8, Math.round(height * 0.035));
  const stroke = Math.max(2, Math.round(fontSize * 0.10));
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${pad}" y="${pad + fontSize}" font-family="Helvetica, Arial, sans-serif" ` +
    `font-weight="700" font-size="${fontSize}" fill="#ffffff" stroke="#000000" ` +
    `stroke-width="${stroke}" paint-order="stroke">${number}</text></svg>`
  );
}
