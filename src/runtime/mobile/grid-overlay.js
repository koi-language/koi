/**
 * Grid Overlay System — visual coordinate reference for LLM-driven interactions.
 *
 * Overlays a labeled grid (columns A-X, rows 1-48) onto screenshots so the LLM
 * can specify tap/swipe targets using cell IDs like "E12" instead of raw pixel
 * coordinates. Works for any screenshot source (iOS, Android, browser, screen).
 *
 * Requires: sharp (npm install sharp)
 *
 * Ported from mobile-mcps/src/vision/grid-overlay.js.
 */

let sharp = null;
let _sharpLoaded = false;

async function loadSharp() {
  if (_sharpLoaded) return;
  _sharpLoaded = true;
  try {
    const mod = await import('sharp');
    sharp = mod.default || mod;
  } catch {
    sharp = null;
  }
}

const DEFAULT_COLS = 24;  // A-X
const DEFAULT_ROWS = 48;  // 1-48

// ─── Cell Conversion ────────────────────────────────────────────────────

/**
 * Convert a column index (0-based) to its letter representation.
 * 0→A, 1→B, ..., 23→X, 25→Z, 26→AA
 */
function colToLetter(col) {
  let s = '';
  let c = col;
  while (c >= 0) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  }
  return s;
}

/**
 * Convert a cell ID like "F12" to 0-based column/row indices.
 * @param {string} cellId - e.g. "F12", "AA3"
 * @returns {{ col: number, row: number }|null}
 */
export function cellToIndices(cellId) {
  const match = cellId.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;

  const colLetter = match[1].toUpperCase();
  const row = parseInt(match[2], 10);

  let col = 0;
  for (let i = 0; i < colLetter.length; i++) {
    col = col * 26 + (colLetter.charCodeAt(i) - 64);
  }
  col -= 1; // 0-indexed

  return { col, row: row - 1 }; // row is 1-indexed in cell ID
}

/**
 * Convert a cell ID to pixel center coordinates in the image.
 * @param {string} cellId
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} [cols=24]
 * @param {number} [rows=48]
 * @returns {{ x: number, y: number }|null}
 */
export function cellToCoordinates(cellId, imageWidth, imageHeight, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const indices = cellToIndices(cellId);
  if (!indices) return null;

  const { col, row } = indices;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;

  const cellWidth = imageWidth / cols;
  const cellHeight = imageHeight / rows;

  return {
    x: Math.round((col + 0.5) * cellWidth),
    y: Math.round((row + 0.5) * cellHeight),
  };
}

/**
 * Validate a cell ID against the grid dimensions.
 */
export function isValidCell(cellId, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const indices = cellToIndices(cellId);
  if (!indices) return false;
  return indices.col >= 0 && indices.col < cols && indices.row >= 0 && indices.row < rows;
}

/**
 * Get a human-readable description of the grid.
 */
export function getGridInfo(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const lastCol = colToLetter(cols - 1);
  return `Grid: ${cols}x${rows} (columns A-${lastCol}, rows 1-${rows})`;
}

// ─── SVG Generation ─────────────────────────────────────────────────────

/**
 * Cache for generated grid SVG buffers.
 * Key: "widthxheight_colsxrows" → Buffer
 * Since we always resize to 480px width, the SVG is nearly always the same.
 */
const _svgCache = new Map();

/**
 * Get a cached grid SVG buffer or create and cache a new one.
 */
function getOrCreateGridSvg(width, height, cols, rows) {
  const key = `${width}x${height}_${cols}x${rows}`;
  if (_svgCache.has(key)) return _svgCache.get(key);
  const svg = createGridSvg(width, height, cols, rows);
  const buf = Buffer.from(svg);
  _svgCache.set(key, buf);
  return buf;
}

/**
 * Create an SVG grid overlay.
 */
function createGridSvg(width, height, cols, rows) {
  const cellW = width / cols;
  const cellH = height / rows;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;

  // Vertical lines
  for (let c = 0; c <= cols; c++) {
    const x = Math.round(c * cellW);
    const isMajor = c % 5 === 0;
    const stroke = isMajor ? 'rgba(255,0,0,0.6)' : 'rgba(255,0,0,0.25)';
    const strokeWidth = isMajor ? 2 : 1;
    svg += `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }

  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = Math.round(r * cellH);
    const isMajor = r % 5 === 0;
    const stroke = isMajor ? 'rgba(255,0,0,0.6)' : 'rgba(255,0,0,0.25)';
    const strokeWidth = isMajor ? 2 : 1;
    svg += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }

  // Column labels at top
  const fontSize = Math.max(10, Math.min(16, Math.round(cellW * 0.6)));
  for (let c = 0; c < cols; c++) {
    const x = Math.round((c + 0.5) * cellW);
    const label = colToLetter(c);
    svg += `<text x="${x}" y="${fontSize + 2}" text-anchor="middle" fill="rgba(255,60,60,0.85)" `
        + `font-size="${fontSize}" font-family="monospace" font-weight="bold">${label}</text>`;
  }

  // Row labels on left
  for (let r = 0; r < rows; r++) {
    const y = Math.round((r + 0.5) * cellH) + fontSize * 0.35;
    const label = String(r + 1);
    svg += `<text x="3" y="${y}" fill="rgba(255,60,60,0.85)" `
        + `font-size="${fontSize}" font-family="monospace" font-weight="bold">${label}</text>`;
  }

  // Strategic cell labels (corners, center, navigation areas) for orientation
  const strategicCells = [
    [0, 0], [cols - 1, 0],                              // top corners
    [0, rows - 1], [cols - 1, rows - 1],                // bottom corners
    [Math.floor(cols / 2), Math.floor(rows / 2)],       // center
    [Math.floor(cols / 2), Math.floor(rows * 0.25)],    // upper center
    [Math.floor(cols / 2), Math.floor(rows * 0.75)],    // lower center
  ];

  const labelFontSize = Math.max(8, Math.min(12, Math.round(cellW * 0.45)));
  for (const [c, r] of strategicCells) {
    const x = Math.round((c + 0.5) * cellW);
    const y = Math.round((r + 0.5) * cellH) + labelFontSize * 0.35;
    const label = `${colToLetter(c)}${r + 1}`;
    svg += `<text x="${x}" y="${y}" text-anchor="middle" fill="rgba(255,255,0,0.7)" `
        + `font-size="${labelFontSize}" font-family="monospace" font-weight="bold">${label}</text>`;
  }

  svg += '</svg>';
  return svg;
}

// ─── Main Export ─────────────────────────────────────────────────────────

/**
 * Add a grid overlay to a screenshot buffer.
 *
 * @param {Buffer} imageBuffer - PNG screenshot
 * @param {object} [options]
 * @param {number} [options.cols=24] - Number of columns (A-X)
 * @param {number} [options.rows=48] - Number of rows (1-48)
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, cols: number, rows: number, cellWidth: number, cellHeight: number }>}
 */
export async function addGridOverlay(imageBuffer, options = {}) {
  await loadSharp();
  if (!sharp) {
    throw new Error(
      'Grid overlay requires the "sharp" package.\n' +
      'Install it with: npm install sharp'
    );
  }

  const { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = options;

  const metadata = await sharp(imageBuffer).metadata();
  const { width, height } = metadata;

  const gridBuffer = getOrCreateGridSvg(width, height, cols, rows);

  const result = await sharp(imageBuffer)
    .composite([{ input: gridBuffer, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return {
    buffer: result,
    width,
    height,
    cols,
    rows,
    cellWidth: width / cols,
    cellHeight: height / rows,
  };
}

/**
 * Check if sharp is available (loads it lazily on first call).
 */
export async function isSharpAvailable() {
  await loadSharp();
  return sharp !== null;
}
