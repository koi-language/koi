/**
 * extract_panel — ephemeral WORKING COPY of one virtual panel of a panel sheet.
 *
 * A panel sheet is ONE image; panels are virtual grid cells over it (3x4 by
 * default, every cell exactly 16:9 on a 4:3 sheet). This tool crops one cell
 * into a TEMPORARY working file so an image-edit model can regenerate it.
 * The temp file is scratch: it is NOT a creation, NOT registered anywhere,
 * and is meaningless once replace_panel has composited the fixed panel back
 * into the sheet. The sheet always remains the single source of truth.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { snappedPanelRect, validateGridParams, readGridHint } from './_grid.js';

export default {
  type: 'extract_panel',
  intent: 'extract_panel',
  description:
    'Extract ONE panel of a storyboard panel-sheet image into a TEMPORARY working file, so that single panel can be ' +
    'regenerated/edited without touching the rest of the sheet. The sheet is ONE image with a virtual grid of panels ' +
    '(default 3 columns x 4 rows, row-major, panel 1 = top-left); nothing is permanently split. ' +
    'Call shape: { sheet: "/abs/path/sheet.png", panel: 5, cols?: 3, rows?: 4 }. ' +
    'Returns { success, path, panel, rect, sheetWidth, sheetHeight } where `path` is the temp working image (16:9 for the standard grid). ' +
    'The temp file is scratch for the edit flow only: read_file it (to see it and unlock it as a generation reference), ' +
    'edit/regenerate it via generate_image, then composite the result back with replace_panel. Do NOT present the temp file ' +
    'to the user as an artifact and do NOT treat panels as independent images: the sheet stays the single canonical file.',
  instructions:
    'Flow to fix one bad panel: (1) extract_panel -> (2) read_file the returned path (mandatory: you must SEE the panel and ' +
    'the read unlocks it as a reference for generation) -> (3) generate_image in edit mode with the working panel plus the ' +
    'character/set references, instructing it to change ONLY what is wrong and to PRESERVE the style and framing (render no numbers or labels) ' +
    '-> (4) read_file the result -> (5) replace_panel with it. The grid is 3x4 unless the sheet was generated with another grid.',
  thinkingHint: (action) => `Extracting panel ${action?.panel ?? ''} of the sheet`.trim(),
  permission: null,

  schema: {
    type: 'object',
    properties: {
      sheet: { type: 'string', description: 'Absolute path to the panel-sheet image (PNG/JPG).' },
      panel: { type: 'integer', description: '1-based panel number, row-major (top-left = 1).' },
      cols: { type: 'integer', description: 'Grid columns. OMIT to auto-detect from the image (recommended).' },
      rows: { type: 'integer', description: 'Grid rows. OMIT to auto-detect from the image (recommended).' },
    },
    required: ['sheet', 'panel'],
  },

  async execute(action) {
    const sheet = String(action?.sheet || '').trim();
    const panel = action?.panel;
    const cols = Number.isInteger(action?.cols) ? action.cols : null;
    const rows = Number.isInteger(action?.rows) ? action.rows : null;

    let hintedCols = cols, hintedRows = rows;
    if (hintedCols == null && hintedRows == null) {
      const hint = await readGridHint(sheet);
      if (hint) { hintedCols = hint.cols; hintedRows = hint.rows; }
    }
    const paramError = validateGridParams({ sheet, panel, cols: hintedCols, rows: hintedRows });
    if (paramError) return { success: false, error: paramError };
    if (!fs.existsSync(sheet)) {
      return { success: false, error: `Sheet image not found at ${sheet}. Pass the absolute path of the generated sheet (from generate_image / inspect_creation).` };
    }

    let sharp;
    try { sharp = (await import('sharp')).default; }
    catch (e) { return { success: false, error: `sharp unavailable: ${e.message}` }; }

    try {
      // Gutter-snapped: tolerates sheets whose rows/columns rendered unevenly.
      const rect = await snappedPanelRect({ sharp, sheet, panel, cols: hintedCols, rows: hintedRows });
      if (rect.error) return { success: false, error: rect.error };

      const dir = path.join(os.tmpdir(), 'koi-panel-work');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(sheet).replace(/\.[a-z0-9]+$/i, '');
      const out = path.join(dir, `${base}-panel${panel}-${Date.now()}.png`);

      await sharp(sheet)
        .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
        .png()
        .toFile(out);

      const _ar = (w, h) => {
        const opts = [['16:9',16/9],['9:16',9/16],['4:3',4/3],['3:4',3/4],['1:1',1],['3:2',3/2],['2:3',2/3],['21:9',21/9]];
        const a = w / h;
        opts.sort((x, y) => Math.abs(x[1] - a) - Math.abs(y[1] - a));
        return opts[0][0];
      };
      const hint = rect.cellFull || rect;
      return {
        success: true,
        path: out,
        panel,
        width: hint.width,
        height: hint.height,
        aspectRatio: _ar(hint.width, hint.height),
        note2: 'CRITICAL: any regenerated replacement MUST come back at these same dimensions/aspect (pass this aspectRatio to generate_image); replace_panel rejects mismatched aspects. And match the SIZE, not just the shape: the cell is only width x height px (~1MP), so generate at the LOWEST resolution tier that covers it (omit the resolution param or pick the smallest; NEVER 4k, NEVER quality high for a single panel: it wastes credits and time and gets downscaled on composite anyway).',
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        sheetWidth: rect.sheetWidth,
        sheetHeight: rect.sheetHeight,
        snapped: rect.snapped === true,
        note: 'Temporary working copy only — the sheet remains the single canonical image. read_file this path, edit it, then replace_panel.',
      };
    } catch (e) {
      return { success: false, error: `extract_panel failed: ${e.message}` };
    }
  },
};
