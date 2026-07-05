/**
 * panel_versions — per-panel VERSION HISTORY of a panel sheet.
 *
 * Every replace_panel automatically records versions under
 * ~/.koi/panels/<sheet-basename>/p<N>/ (the pre-existing cell content becomes
 * the first version, each replacement appends one; versions.json tracks order
 * and which one is currently composited into the sheet). This tool lists,
 * restores or deletes those versions. The sheet itself always shows the
 * CURRENT version; restoring composites an older version back into the cell.
 */

import fs from 'fs';
import path from 'path';
import { validateGridParams, versionsDir, readVersions, writeVersions, compositePanel } from './_grid.js';

export default {
  type: 'panel_versions',
  intent: 'panel_versions',
  description:
    'List, restore or delete the VERSION HISTORY of one panel of a panel-sheet image. Every replace_panel records versions ' +
    'automatically (the original cell content becomes version 1). Call shapes: ' +
    '{ sheet, panel, op: "list" } -> { versions: [{ file, ts, current }] } newest last; ' +
    '{ sheet, panel, op: "restore", version: "<file>" } -> composites that version back into the sheet cell and marks it current; ' +
    '{ sheet, panel, op: "delete", version: "<file>" } -> deletes a NON-current version (refused when it is the only one or the current one). ' +
    'The sheet always displays the current version; there is no confirmation step, the history IS the safety net.',
  instructions:
    'Use op "list" before restore/delete to get the exact file names. Restore updates the sheet in place; the panels viewer refreshes alone.',
  thinkingHint: (action) => `Panel ${action?.panel ?? ''} versions: ${action?.op || 'list'}`.trim(),
  permission: null,

  schema: {
    type: 'object',
    properties: {
      sheet: { type: 'string', description: 'Absolute path to the panel-sheet image.' },
      panel: { type: 'integer', description: '1-based panel number, row-major.' },
      op: { type: 'string', description: '"list" (default), "restore" or "delete".' },
      version: { type: 'string', description: 'Version file name (from op "list") for restore/delete.' },
    },
    required: ['sheet', 'panel'],
  },

  async execute(action) {
    const sheet = String(action?.sheet || '').trim();
    const panel = action?.panel;
    const op = String(action?.op || 'list');
    const paramError = validateGridParams({ sheet, panel });
    if (paramError) return { success: false, error: paramError };
    if (!fs.existsSync(sheet)) return { success: false, error: `Sheet image not found at ${sheet}.` };

    const dir = versionsDir(sheet, panel);
    const state = readVersions(dir);

    if (op === 'list') {
      const versions = state.order
        .filter((f) => fs.existsSync(path.join(dir, f)))
        .map((f) => ({ file: f, path: path.join(dir, f), ts: Number(f.replace(/\.png$/, '')) || 0, current: f === state.current }));
      return { success: true, sheet, panel, versions };
    }

    const version = String(action?.version || '').trim();
    if (!version || !state.order.includes(version)) {
      return { success: false, error: `Unknown version "${version}". Use op "list" first.` };
    }

    if (op === 'delete') {
      if (state.order.length <= 1) return { success: false, error: 'Cannot delete the only version of a panel.' };
      if (version === state.current) return { success: false, error: 'Cannot delete the CURRENT version; restore another one first.' };
      try { fs.unlinkSync(path.join(dir, version)); } catch { /* already gone */ }
      state.order = state.order.filter((f) => f !== version);
      writeVersions(dir, state);
      return { success: true, sheet, panel, deleted: version, remaining: state.order.length };
    }

    if (op === 'restore') {
      let sharp;
      try { sharp = (await import('sharp')).default; }
      catch (e) { return { success: false, error: `sharp unavailable: ${e.message}` }; }
      const result = await compositePanel({ sharp, sheet, panel, image: path.join(dir, version) });
      if (result.error) return { success: false, error: result.error };
      state.current = version;
      writeVersions(dir, state);
      return { success: true, sheet, panel, restored: version, note: 'Sheet updated in place; the panels viewer refreshes alone.' };
    }

    return { success: false, error: `Unknown op "${op}": use "list", "restore" or "delete".` };
  },
};
