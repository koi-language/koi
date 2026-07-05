/**
 * delete_panel — remove ONE panel from a panel sheet and SHIFT the rest.
 *
 * Deleting a cuadro must never leave a black hole in its place: every later
 * panel slides one cell back (pixel-level move, no regeneration, no credits)
 * and the last previously-filled cell becomes bare black. The sheet creation's
 * metadata.clips is re-indexed to match (best effort), and the per-panel
 * version stores of shifted cells are cleared (they no longer correspond).
 * The interactive storyboard must be updated FIRST (source of truth); this
 * tool only propagates the deletion to the derived sheet.
 */

import fs from 'fs';
import path from 'path';
import { snappedPanelRect, validateGridParams, versionsDir, readGridHint, contentIslands, invalidateGeometryCache } from './_grid.js';

export default {
  type: 'delete_panel',
  intent: 'delete_panel',
  description:
    'Delete ONE panel from a panel-sheet image by SHIFTING every later panel one cell back (pixel move, free, no ' +
    'regeneration) and blackening the last previously-filled cell. NEVER paint a deleted panel black in place: use this. ' +
    'Call shape: { sheet: "/abs/sheet.png", panel: N, panelCount?: M }. panelCount defaults to the count derived from the ' +
    'sheet creation metadata (clips) when available. Also re-indexes metadata.clips (panels > N shift down; N is removed) ' +
    'and clears the version history of shifted cells. Update the INTERACTIVE STORYBOARD first (remove the shot there): ' +
    'this tool only propagates to the derived sheet. Returns { success, shifted, panelCount, updatedClips? }.',
  instructions:
    'Flow for "elimina el cuadro N": (1) update the interactive storyboard (remove/adjust the shot via save_storyboard); ' +
    '(2) delete_panel on the sheet; (3) verify with read_file. Panels never flow BETWEEN sheets: each sheet just ends ' +
    'with one more bare black cell.',
  thinkingHint: (action) => `Deleting panel ${action?.panel ?? ''} and shifting the rest`.trim(),
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      sheet: { type: 'string', description: 'Absolute path to the panel-sheet image.' },
      panel: { type: 'integer', description: '1-based panel number to delete (row-major).' },
      panelCount: { type: 'integer', description: 'How many panels the sheet currently holds. Default: derived from metadata.clips.' },
    },
    required: ['sheet', 'panel'],
  },

  async execute(action) {
    const sheet = String(action?.sheet || '').trim();
    const panel = action?.panel;
    const paramError = validateGridParams({ sheet, panel });
    if (paramError) return { success: false, error: paramError };
    if (!fs.existsSync(sheet)) return { success: false, error: `Sheet image not found at ${sheet}.` };

    let sharp;
    try { sharp = (await import('sharp')).default; }
    catch (e) { return { success: false, error: `sharp unavailable: ${e.message}` }; }

    // Resolve panelCount + clips from the creation metadata when available.
    let row = null, meta = null, clips = null;
    try {
      const { MediaLibrary } = await import('../../state/media-library.js');
      row = await MediaLibrary.global().getByPath(sheet);
      meta = row?.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null;
      const m = meta?.metadata && typeof meta.metadata === 'object' ? meta.metadata : meta;
      if (Array.isArray(m?.clips) && m.clips.length) clips = m.clips;
    } catch { /* metadata unavailable: proceed with explicit panelCount */ }

    // ── GEOMETRY: content islands FIRST (the law: pixels, never metadata).
    //    Segment ONCE up front: island boxes stay fixed while content moves
    //    inside them, so a single segmentation is both faster and more
    //    correct than re-detecting between shifts. Legacy hint/snap path
    //    remains the fallback for implausible segmentations. ──
    let boxes = null;
    let geometry = 'grid-fallback';
    try {
      const seg = await contentIslands({ sharp, sheet });
      if (seg.panels.length >= 1 && seg.panels.length <= 24) {
        boxes = seg.panels;
        geometry = 'islands';
      }
    } catch { /* fall back below */ }

    let panelCount = Number.isInteger(action?.panelCount) ? action.panelCount : null;
    if (boxes) {
      // Islands are the authoritative count: a stale clips-derived count
      // must not blacken cells the pixels say don't exist.
      panelCount = boxes.length;
    } else if (!panelCount && clips) {
      panelCount = Math.max(...clips.flatMap((c) => (Array.isArray(c.panels) ? c.panels : [])));
    }
    if (!panelCount) return { success: false, error: 'Pass panelCount (could not derive it from the sheet metadata.clips).' };
    if (panel > panelCount) return { success: false, error: `panel ${panel} > panelCount ${panelCount}.` };

    const hint = await readGridHint(sheet);
    const hc = hint?.cols ?? null, hr = hint?.rows ?? null;
    try {
      // Shift pixels: cell i takes cell i+1's content, working back to front
      // is unnecessary since we always read from the CURRENT file state and
      // write sequentially forward (i reads i+1 before i+1 is overwritten).
      let shifted = 0;
      for (let i = panel; i < panelCount; i++) {
        let srcB, dstB;
        if (boxes) {
          srcB = boxes[i];       // island i+1 (1-based)
          dstB = boxes[i - 1];   // island i
        } else {
          const src = await snappedPanelRect({ sharp, sheet, panel: i + 1, cols: hc, rows: hr, inset: 0 });
          if (src.error) return { success: false, error: src.error };
          const dst = await snappedPanelRect({ sharp, sheet, panel: i, cols: hc, rows: hr, inset: 0 });
          if (dst.error) return { success: false, error: dst.error };
          srcB = src.cellBounds;
          dstB = dst.cellBounds;
        }
        const buf = await sharp(sheet)
          .extract({ left: srcB.left, top: srcB.top, width: srcB.width, height: srcB.height })
          .resize(dstB.width, dstB.height, { fit: 'fill' })
          .png()
          .toBuffer();
        const tmp = path.join(path.dirname(sheet), `.${path.basename(sheet)}.shift-${Date.now()}-${i}.png`);
        await sharp(sheet).composite([{ input: buf, left: dstB.left, top: dstB.top }]).png().toFile(tmp);
        fs.renameSync(tmp, sheet);
        invalidateGeometryCache(sheet);
        shifted++;
      }

      // Blacken the last previously-filled cell (the full island box).
      let lastB = null;
      if (boxes) {
        lastB = boxes[panelCount - 1];
      } else {
        const last = await snappedPanelRect({ sharp, sheet, panel: panelCount, cols: hc, rows: hr, inset: 0 });
        if (!last.error) lastB = last.cellBounds;
      }
      if (lastB) {
        const black = await sharp({ create: { width: lastB.width, height: lastB.height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .png().toBuffer();
        const tmp = path.join(path.dirname(sheet), `.${path.basename(sheet)}.blk-${Date.now()}.png`);
        await sharp(sheet).composite([{ input: black, left: lastB.left, top: lastB.top }]).png().toFile(tmp);
        fs.renameSync(tmp, sheet);
        invalidateGeometryCache(sheet);
      }

      // Version stores of shifted cells no longer correspond: clear them.
      for (let i = panel; i <= panelCount; i++) {
        try { fs.rmSync(versionsDir(sheet, i), { recursive: true, force: true }); } catch { /* */ }
      }

      // Re-index clips metadata (best effort).
      let updatedClips = null;
      if (clips) {
        updatedClips = clips
          .map((c) => ({
            ...c,
            panels: (Array.isArray(c.panels) ? c.panels : [])
              .filter((p) => p !== panel)
              .map((p) => (p > panel ? p - 1 : p)),
          }))
          .filter((c) => c.panels.length > 0);
        try {
          const { MediaLibrary } = await import('../../state/media-library.js');
          const lib = MediaLibrary.global();
          const outer = meta?.metadata && typeof meta.metadata === 'object' ? meta : null;
          const inner = outer ? { ...meta.metadata, clips: updatedClips } : { ...(meta || {}), clips: updatedClips };
          const newMeta = outer ? { ...meta, metadata: inner } : inner;
          await lib.save({
            filePath: sheet,
            metadata: newMeta,
            description: row?.description || undefined,
            summary: row?.summary || undefined,
            replaceByPath: true,
          });
        } catch { updatedClips = null; }
      }

      return {
        success: true,
        sheet,
        deleted: panel,
        shifted,
        panelCount: panelCount - 1,
        geometry,
        updatedClips: updatedClips || undefined,
        note: updatedClips
          ? 'Panels shifted, last cell blackened, metadata.clips re-indexed. The viewer refreshes alone.'
          : 'Panels shifted and last cell blackened, but metadata.clips could NOT be re-indexed: the viewer mapping may be stale until the sheet is re-rendered or metadata is fixed.',
      };
    } catch (e) {
      return { success: false, error: `delete_panel failed: ${e.message}` };
    }
  },
};
