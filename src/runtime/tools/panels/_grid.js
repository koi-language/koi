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

/**
 * Segment a sheet into CONTENT ISLANDS at FULL resolution (downsampling
 * blurs thin gutters; loops sample x/y stride 2 for speed).
 *
 * islands-v4: SEPARATORS are classified by STRUCTURE (purity + width),
 * not content by brightness: brightness alone cannot distinguish dark
 * panel interiors (near-black corridor ceilings/floors) from gutters,
 * which made v3 eat / split dark panels. Every scanline (row OR column,
 * identical test) lands in one of three classes:
 *   - CONTENT: any of the v3 arms fires (>= 50% of samples >= 24, OR
 *     > 5% >= 41 (p95 > 40), OR >= 0.4% (min 1) >= 64);
 *   - PURE-DARK: not content AND <= 5% of samples reach luminance 17
 *     (line p95 <= 16). Measured: true gutters/fillers sit at
 *     f17 0.000-0.009 while dark panel interiors never fell below
 *     f17 0.09 (star-wars corridor sheet) / 0.26 (typical);
 *   - IMPURE-DARK: the rest (dark ceilings, walls, night interiors).
 * SEPARATORS:
 *   - every maximal PURE-DARK run, ANY width (thin pure gutters and the
 *     wide black filler of empty cells alike). The purity boundary is
 *     exactly where an impure dark panel bottom meets the pure filler,
 *     so touching dark content never bleeds into the filler;
 *   - a maximal IMPURE-DARK run ONLY under the HAIRLINE exception: run
 *     length <= 0.5% of the axis extent AND band frac24 <= 0.30 AND
 *     BOTH flanking scanlines are SATURATED content (line frac24 >=
 *     0.85). This is the ringing-contaminated thin gutter between two
 *     bright panels (mqtz88lw 4/5: f17 16-36%, neighbors f24
 *     0.99/0.97); dark-content hairlines always have weak flanks
 *     (measured <= 0.45) and internal pencil-sketch divides are far too
 *     impure (f17 0.73+) with weak flanks (0.34), so neither splits.
 *
 * islands-v5 rebuilds the geometry on top of that per-line classifier as a
 * CUT-LINE GRID (user's law): the sheet is a grid whose cut lines always
 * cross it fully, top-to-bottom or left-to-right, at ARBITRARY (never
 * uniform) spacings. A vertical line is an x-interval that is separator in
 * EVERY row lane AND in the full-height global lane; horizontal lines are
 * symmetric over the column lanes + the full-width global lane. This is
 * what lets a mostly-black panel keep its cell: its own boundaries are
 * invisible locally, but the lines agreed on by every other lane still
 * cross it, while a dark band inside one panel never crosses the whole
 * grid, so it can never split anything. Cells = rows x columns; a cell
 * with content evidence is a panel spanning its FULL cell; a pure-black
 * cell (deleted panel, trailing filler) is dropped. A row may carry its
 * own extra vertical gutters (row-major strip layouts, e.g. 3+2 with a
 * panoramic row): see the level-2 subdivision inside contentIslands.
 * Sliver spans merge across residue bands only, never across a pure drawn
 * line (see mergeSliverSpans).
 * Returns { W, H, panels: [{left,top,width,height}], stripes }.
 */
const _LUM_PURE = 17;   // purity luminance (line p95 <= 16 when <= 5% reach it)
const _LUM_BASE = 24;   // bulk arm luminance
const _LUM_P95 = 41;    // p95 arm luminance (p95 > 40)
const _LUM_BRIGHT = 64; // bright-evidence arm luminance

/** Per-arm sample-count thresholds for a scanline of [n] samples. */
function _armNeeds(n) {
  return {
    base: Math.ceil(n * 0.5),            // >= 50% of samples >= 24
    p95: Math.floor(n * 0.05) + 1,       // > 5% of samples >= 41
    bright: Math.max(1, Math.ceil(n * 0.004)), // >= 0.4% of samples >= 64
    pure: Math.floor(n * 0.05),          // <= 5% of samples >= 17
  };
}

/**
 * Classify separator scanlines for one axis (shared by v4/v5).
 * [cls]: per-line class (2 content, 1 impure-dark, 0 pure-dark);
 * [f24]: per-line fraction of samples >= 24; [extent] = axis length.
 * Returns a boolean mask: true = separator line.
 */
function _separatorMask(cls, f24, extent) {
  const sep = new Array(cls.length).fill(false);
  const hairMax = Math.max(2, Math.round(extent * 0.005));
  const strong = (i) => i >= 0 && i < cls.length && f24[i] >= 0.85;
  let i = 0;
  while (i < cls.length) {
    const c = cls[i];
    let j = i;
    while (j < cls.length && cls[j] === c) j++;
    if (c === 0) {
      // Pure-dark: always a separator (gutter or filler).
      for (let k = i; k < j; k++) sep[k] = true;
    } else if (c === 1 && j - i <= hairMax) {
      // Impure-dark: hairline ringing-gutter exception only.
      let band = 0;
      for (let k = i; k < j; k++) band += f24[k];
      if (band / (j - i) <= 0.30 && strong(i - 1) && strong(j)) {
        for (let k = i; k < j; k++) sep[k] = true;
      }
    }
    i = j;
  }
  return sep;
}

/** Maximal [start,end) runs of NON-separator lines. */
function _islandSpans(sep) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= sep.length; i++) {
    const on = i < sep.length && !sep[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push({ start, end: i }); start = -1; }
  }
  return out;
}
export async function contentIslands({ sharp, sheet }) {
  // MEASURE ONCE, THEN CACHE (user requirement): the island geometry is
  // persisted at <project>/panels/<base>/geometry.json and shared with the GUI
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

  // Per-line profile for one axis position: class (2 content / 1 impure
  // / 0 pure), frac24, and raw max (sliver band test). NO early-out: the
  // purity and frac24 of every line feed the separator rules.
  const _profileLine = (get, n, needs) => {
    let m = 0, c17 = 0, c24 = 0, c41 = 0, c64 = 0;
    for (let i = 0; i < n; i++) {
      const v = get(i);
      if (v > m) m = v;
      if (v >= _LUM_PURE) {
        c17++;
        if (v >= _LUM_BASE) {
          c24++;
          if (v >= _LUM_P95) {
            c41++;
            if (v >= _LUM_BRIGHT) c64++;
          }
        }
      }
    }
    const content = c24 >= needs.base || c41 >= needs.p95 || c64 >= needs.bright;
    const cls = content ? 2 : (c17 <= needs.pure ? 0 : 1);
    return { cls, f24: c24 / n, max: m };
  };

  // Profile ONE AXIS restricted to a band of the cross axis (stride 2):
  // per-position class (2 content / 1 impure / 0 pure) + separator mask.
  const profileCols = (lo, hi) => {
    const n = Math.max(1, Math.ceil((hi - lo) / 2));
    const needs = _armNeeds(n);
    const cls = new Array(W).fill(0);
    const f24 = new Array(W).fill(0);
    const max = new Array(W).fill(0);
    for (let x = 0; x < W; x++) {
      const p = _profileLine((i) => raw[(lo + i * 2) * W + x], n, needs);
      cls[x] = p.cls; f24[x] = p.f24; max[x] = p.max;
    }
    return { cls, max, sep: _separatorMask(cls, f24, W) };
  };
  const profileRows = (lo, hi) => {
    const n = Math.max(1, Math.ceil((hi - lo) / 2));
    const needs = _armNeeds(n);
    const cls = new Array(H).fill(0);
    const f24 = new Array(H).fill(0);
    const max = new Array(H).fill(0);
    for (let y = 0; y < H; y++) {
      const off = y * W + lo;
      const p = _profileLine((i) => raw[off + i * 2], n, needs);
      cls[y] = p.cls; f24[y] = p.f24; max[y] = p.max;
    }
    return { cls, max, sep: _separatorMask(cls, f24, H) };
  };

  // SLIVER SPANS after the AND: a dark band can still forge a cut line when
  // it happens to cross EVERY lane (all panels dark at the same height). A
  // real drawn line is pure black; a forged one carries residue. Merge a
  // span < 40% of the median size into its neighbour ACROSS such a residue
  // band, but NEVER across a band containing a pure run (>= 4 scanlines
  // with raw max <= 6): that pure run is a genuine drawn line, and jumping
  // it is exactly how dark panels used to get glued to their neighbours.
  const mergeSliverSpans = (spans, maxProf) => {
    const crossable = (a, b) => {
      let run = 0, impure = false;
      for (let k = a; k < b; k++) {
        if (maxProf[k] <= 6) { run++; if (run >= 4) return false; } else { run = 0; impure = true; }
      }
      return impure;
    };
    const cur = spans.slice();
    let changed = true;
    while (changed && cur.length > 1) {
      changed = false;
      const sizes = cur.map((r) => r.end - r.start).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)];
      for (let i = 0; i < cur.length; i++) {
        if (cur[i].end - cur[i].start >= median * 0.4) continue;
        let mergeWith = null;
        if (i > 0 && crossable(cur[i - 1].end, cur[i].start)) mergeWith = i - 1;
        else if (i < cur.length - 1 && crossable(cur[i].end, cur[i + 1].start)) mergeWith = i + 1;
        if (mergeWith == null) continue;
        const a = Math.min(i, mergeWith), b = Math.max(i, mergeWith);
        cur.splice(a, 2, { start: cur[a].start, end: cur[b].end });
        changed = true;
        break;
      }
    }
    return cur;
  };

  // Content evidence over [a,b) of a class array: some genuinely bright
  // scanlines, or a sustained impure-dark region (a dark but real panel).
  // Pure-black cells (deleted panels, trailing filler) have neither.
  const evidence = (cls, a, b) => {
    let c2 = 0, c1 = 0;
    const n = Math.max(1, b - a);
    for (let i = a; i < b; i++) {
      if (cls[i] === 2) c2++;
      else if (cls[i] === 1) c1++;
    }
    return c2 / n >= 0.01 || c1 / n >= 0.25;
  };

  // 1) Provisional stripes from the GLOBAL row mask: the lanes for the
  // vertical-line AND. Over-splitting is harmless here (both halves of a
  // falsely split row still agree on the vertical lines), and without a
  // sliver merge nothing ever glues lanes across a real line.
  const g = profileRows(0, W);
  const stripes0 = _islandSpans(g.sep).filter((s) => s.end - s.start >= H * 0.04);
  const lanes = stripes0.length ? stripes0 : [{ start: 0, end: H }];

  // 2) VERTICAL CUT LINES: x positions that are separator in EVERY lane
  // AND in the full-height global mask (the "all lanes together" lane). The
  // sheet's cut lines always cross the whole grid, so a dark band that
  // fails to be a separator in even one stripe (or whose aggregate carries
  // content) is panel imagery, not a line.
  const colMasks = lanes.map((s) => profileCols(s.start, s.end));
  const gCols = profileCols(0, H);
  colMasks.push(gCols);
  const vSep = new Array(W).fill(true);
  for (let x = 0; x < W; x++) {
    for (const m of colMasks) if (!m.sep[x]) { vSep[x] = false; break; }
  }
  const columns = mergeSliverSpans(
    _islandSpans(vSep).filter((r) => r.end - r.start >= W * 0.04), gCols.max);

  // 3) HORIZONTAL CUT LINES: y positions that are separator in EVERY
  // column AND in the full-width global mask. A band that is dark across
  // one column but carries content in another (a coincidentally dark
  // stretch of a dark panel) never crosses the whole grid, so it is not a
  // line: this is what keeps a row of all-dark panels in one piece. The
  // global lane symmetrically kills a band that looks dark inside every
  // margin-diluted column but whose aggregate content is plainly visible.
  const rowMasks = (columns.length ? columns : [{ start: 0, end: W }]).map((c) => profileRows(c.start, c.end));
  rowMasks.push(g);
  const hSep = new Array(H).fill(true);
  for (let y = 0; y < H; y++) {
    for (const m of rowMasks) if (!m.sep[y]) { hSep[y] = false; break; }
  }
  const rows = mergeSliverSpans(
    _islandSpans(hSep).filter((r) => r.end - r.start >= H * 0.04), g.max);

  // 4) CELLS = rows x columns (each row/column keeps its own extent: the
  // grid's spacing is arbitrary, never uniform fractions). A cell with
  // content evidence is a panel spanning its FULL cell (the cell IS the
  // panel; interior black is part of the image). LEVEL-2 SUBDIVISION, X
  // ONLY: sheets are ROW-MAJOR strips, so a row may carry its own extra
  // vertical gutters (a 3+2 layout whose extra gutter does not cross the
  // panoramic row), but a horizontal band confined to one column is never
  // a line (it is dark imagery, e.g. a thin shadow crossing one dark
  // panel). A THIN separator run (a real drawn gutter, <= ~1.5% of the
  // axis) strictly inside a cell splits it ONLY when EVERY resulting
  // sub-cell reads as a real panel: content evidence, >= 4% of the sheet
  // width, and a plausible panel aspect (width / row height >= 0.45; no
  // real panel is narrower than 9:16). A thin dark edge inside a photo (a
  // doorframe, a pillar) fails those tests, so it never splits; wide dark
  // regions never split (dark imagery); a side without content never
  // splits (black stage margins).
  const subCells = (cls, sep, a, b, extent, cellH) => {
    const whole = () => (evidence(cls, a, b) ? [{ start: a, end: b }] : []);
    const thinMax = Math.max(6, Math.round(extent * 0.015));
    const cuts = [];
    let s = -1;
    for (let i = a; i <= b; i++) {
      const on = i < b && sep[i];
      if (on && s < 0) s = i;
      if (!on && s >= 0) {
        const w = i - s;
        if (s > a && i < b && w >= 4 && w <= thinMax) cuts.push({ s, e: i });
        s = -1;
      }
    }
    if (!cuts.length) return whole();
    const bounds = [a];
    for (const c of cuts) { bounds.push(c.s, c.e); }
    bounds.push(b);
    const spans = [];
    for (let i = 0; i < bounds.length; i += 2) spans.push({ start: bounds[i], end: bounds[i + 1] });
    if (spans.length < 2) return whole();
    const valid = (sp) => sp.end - sp.start >= extent * 0.04
      && (sp.end - sp.start) / cellH >= 0.45
      && evidence(cls, sp.start, sp.end);
    if (!spans.every(valid)) return whole();
    return spans;
  };

  const rowColMasks = rows.map((r) => profileCols(r.start, r.end));
  const panels = [];
  rows.forEach((r, ri) => {
    const cm = rowColMasks[ri];
    for (const c of (columns.length ? columns : [{ start: 0, end: W }])) {
      for (const xs of subCells(cm.cls, cm.sep, c.start, c.end, W, r.end - r.start)) {
        panels.push({ left: xs.start, top: r.start, width: xs.end - xs.start, height: r.end - r.start });
      }
    }
  });
  if (st) _writeGeometryCache(sheet, st, { width: W, height: H, islands: panels });
  return { W, H, panels, stripes: rows.length, cached: false };
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

import { docDir } from '../../state/doc-root.js';
import { readDocJson, stringifyDocJson } from '../../state/project-paths.js';
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

/** Per-panel version store: <project>/panels/<sheet-basename>/p<N>/ */
export function versionsDir(sheet, panel) {
  const home = process.env.HOME || os.homedir();
  const base = path.basename(sheet).replace(/\.[a-z0-9]+$/i, '');
  return path.join(docDir('panels'), base, `p${panel}`);
}

/** Shared island-geometry cache file, read/written by BOTH the engine tools
 *  and the GUI visor so each sheet is measured exactly once until it changes:
 *  <project>/panels/<sheet-basename>/geometry.json with
 *  { algo, mtimeMs, fileSize, width, height, islands, analyzedAt }. */
export function geometryCachePath(sheet) {
  const home = process.env.HOME || os.homedir();
  const base = path.basename(sheet).replace(/\.[a-z0-9]+$/i, '');
  return path.join(docDir('panels'), base, 'geometry.json');
}

function _readGeometryCache(sheet, st) {
  try {
    const j = JSON.parse(fs.readFileSync(geometryCachePath(sheet), 'utf8'));
    if (j?.algo !== 'islands-v5') return null;
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
      algo: 'islands-v5',
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
  try { return readDocJson(path.join(dir, 'versions.json')); }
  catch { return { current: null, order: [] }; }
}

export function writeVersions(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.versions-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, stringifyDocJson(state, path.join(dir, 'versions.json')));
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
