/**
 * replace_panel — composite a regenerated panel back INTO its cell of the
 * panel-sheet image, in place.
 *
 * The sheet is the single canonical image: this tool writes the new panel
 * pixels into the virtual grid cell (leaving the black gutter lines intact),
 * atomically replacing the sheet file so watchers/GUI never see a half-written
 * image. A timestamped backup of the previous sheet is kept in the OS temp dir
 * so a bad replacement can be undone by copying it back.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { snappedPanelRect, validateGridParams, versionsDir, readVersions, writeVersions, compositePanel, readGridHint } from './_grid.js';

export default {
  type: 'replace_panel',
  intent: 'replace_panel',
  description:
    'Replace ONE panel of a storyboard panel-sheet image with a new image, compositing it into that panel\'s grid cell ' +
    'IN PLACE (the sheet stays one single file; panels are virtual cells of a 3x4 grid by default, row-major, 1 = top-left). ' +
    'Call shape: { sheet: "/abs/path/sheet.png", panel: 5, image: "/abs/path/new-panel.png", cols?: 3, rows?: 4, drawNumber?: false }. ' +
    'The new image is resized (cover) to the cell; set drawNumber: true to stamp the panel number top-left when the new image ' +
    'lacks the corner numeral. Returns { success, sheet, panel, backup } — `backup` is a temp copy of the sheet as it was ' +
    'BEFORE the replacement (restore by copying it back if the result is worse). ' +
    'Use with extract_panel: extract -> edit via generate_image -> replace. Never rebuild a whole sheet to fix one panel.',
  instructions:
    'After replacing, the sheet file on disk IS the updated sheet (same path): the GUI picks it up automatically and any ' +
    'later video render uses it. Verify the composite by read_file-ing the sheet afterwards. If the new panel looks wrong, ' +
    'restore the returned `backup` (copy it over the sheet path) or run the flow again.',
  thinkingHint: (action) => `Replacing panel ${action?.panel ?? ''} of the sheet`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      sheet: { type: 'string', description: 'Absolute path to the panel-sheet image to modify in place.' },
      panel: { type: 'integer', description: '1-based panel number, row-major (top-left = 1).' },
      image: { type: 'string', description: 'Absolute path to the new panel image (any aspect; it is cover-fitted to the cell).' },
      cols: { type: 'integer', description: 'Grid columns. OMIT to auto-detect from the image (recommended).' },
      rows: { type: 'integer', description: 'Grid rows. OMIT to auto-detect from the image (recommended).' },
      force: { type: 'boolean', description: 'Override the aspect-mismatch guard and cover-crop the image into the cell. Default false.' },
      drawNumber: { type: 'boolean', description: 'Stamp the panel number top-left (white numeral, dark outline). Default false — use when the new image has no corner number.' },
    },
    required: ['sheet', 'panel', 'image'],
  },

  async execute(action) {
    const sheet = String(action?.sheet || '').trim();
    const image = String(action?.image || '').trim();
    const panel = action?.panel;
    const cols = Number.isInteger(action?.cols) ? action.cols : null;
    const rows = Number.isInteger(action?.rows) ? action.rows : null;
    const drawNumber = action?.drawNumber === true;

    let hintedCols = cols, hintedRows = rows;
    if (hintedCols == null && hintedRows == null) {
      const hint = await readGridHint(sheet);
      if (hint) { hintedCols = hint.cols; hintedRows = hint.rows; }
    }
    const paramError = validateGridParams({ sheet, panel, cols: hintedCols, rows: hintedRows });
    if (paramError) return { success: false, error: paramError };
    if (!image || !image.startsWith('/')) {
      return { success: false, error: '"image" is required: the ABSOLUTE path of the new panel image to composite into the cell.' };
    }
    if (!fs.existsSync(sheet)) return { success: false, error: `Sheet image not found at ${sheet}.` };
    if (!fs.existsSync(image)) return { success: false, error: `New panel image not found at ${image}.` };

    let sharp;
    try { sharp = (await import('sharp')).default; }
    catch (e) { return { success: false, error: `sharp unavailable: ${e.message}` }; }

    try {
      // VERSION HISTORY: the pre-replacement cell content becomes a version
      // (the first replace also archives the original), the new panel becomes
      // the CURRENT version. No confirmation flow: history is the safety net.
      const vDir = versionsDir(sheet, panel);
      const state = readVersions(vDir);
      const rect0 = await snappedPanelRect({ sharp, sheet, panel, cols: hintedCols, rows: hintedRows });
      if (rect0.error) return { success: false, error: rect0.error };

      // HARD ASPECT GUARD: the replacement must match the cell's aspect, or
      // cover-fitting would silently crop/distort content. force: true overrides.
      const imMeta = await sharp(image).metadata();
      const g0 = rect0.cellFull || rect0;
      const cellA = g0.width / g0.height;
      const imA = imMeta.width / imMeta.height;
      if (action?.force !== true && Math.abs(imA - cellA) / cellA > 0.05) {
        return { success: false, error:
          `Aspect mismatch: the cell is ${g0.width}x${g0.height} (${cellA.toFixed(3)}) but the image is ` +
          `${imMeta.width}x${imMeta.height} (${imA.toFixed(3)}). Regenerate the panel at the SAME dimensions/aspect ` +
          `as the extracted working copy (extract_panel returns width/height/aspectRatio), or pass force: true to cover-crop.` };
      }
      fs.mkdirSync(vDir, { recursive: true });
      if (state.order.length === 0) {
        const orig = `${Date.now() - 1}.png`;
        await sharp(sheet)
          .extract({ left: g0.left, top: g0.top, width: g0.width, height: g0.height })
          .png()
          .toFile(path.join(vDir, orig));
        state.order.push(orig);
      }

      const result = await compositePanel({ sharp, sheet, panel, image, cols: hintedCols, rows: hintedRows, drawNumber });
      if (result.error) return { success: false, error: result.error };

      const newFile = `${Date.now()}.png`;
      fs.copyFileSync(image, path.join(vDir, newFile));
      state.order.push(newFile);
      state.current = newFile;
      writeVersions(vDir, state);

      return {
        success: true,
        sheet,
        panel,
        rect: result.rect ? { left: result.rect.left, top: result.rect.top, width: result.rect.width, height: result.rect.height } : undefined,
        versions: state.order.length,
        note: 'Sheet updated in place; the previous content is kept as a panel version (panel_versions op:list / restore / delete).',
      };
    } catch (e) {
      return { success: false, error: `replace_panel failed: ${e.message}` };
    }
  },
};
