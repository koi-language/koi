/**
 * Image Lineage — compact provenance tracking for media files.
 *
 * Every time a tool produces a media file (generate_image,
 * background_removal, upscale_image, …) it calls `recordImageOp(...)`.
 * The resulting note enters the project memory vault tagged with
 * `image-lineage`, so the System agent can see — via memory.list or
 * recall_facts — what operations have already been applied to the file
 * currently in the user's working area.
 *
 * Why: after a mid-pipeline failure (e.g. a ProviderBlockedError) System
 * tends to "retry" by replaying the WHOLE user request. Without lineage
 * it does not know that the active image is already the output of
 * bg-remove + upscale, so it asks Worker to bg-remove + upscale again.
 * With lineage surfaced in context, System can skip the steps that are
 * already represented in the file's history and only re-delegate what
 * actually failed.
 *
 * Storage: notes are written to the project vault with type=insight,
 * project=[image-lineage]. They persist across sessions and are filterable.
 *
 * Title format:  `image-lineage-<basename-without-ext>`
 * Description: `<output-path> ops: <op1> → <op2> → ...; from: <root-source>`
 */

import path from 'path';
import * as memory from '../memory/index.js';
import { channel } from '../io/channel.js';

/** Strip the extension to form a stable, filesystem-safe key suffix. */
function _keyFor(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // Normalise to slug form used by memory.write title slugifier.
  return `image-lineage-${base.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Parse the pipeline segment (between "ops:" and ";") back into an op list. */
function _extractOps(value) {
  if (typeof value !== 'string') return [];
  const m = value.match(/ops:\s*([^;]+)/);
  if (!m) return [];
  return m[1].split('→').map(s => s.trim()).filter(Boolean);
}

/** Human-readable op string — e.g. `upscale(factor=2)` or `bg-remove`. */
function _formatOp(op, params) {
  if (!params || Object.keys(params).length === 0) return op;
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `${op}(${parts.join(',')})` : op;
}

/**
 * Look up the lineage for a given file path. Returns `null` when the file
 * has no recorded history (brand-new generation, external user-supplied
 * image, or memory subsystem not yet initialized).
 *
 * NOTE: now async (was sync). Internal use only — no external callers.
 *
 * @param {string} filePath
 * @returns {Promise<{ops: string[], sourcePath: string|null} | null>}
 */
export async function getImageLineage(filePath) {
  if (!filePath) return null;
  if (!memory.isInitialized()) return null;
  const key = _keyFor(filePath);
  try {
    const matches = await memory.list({
      filter: { project: 'image-lineage', type: 'insight' },
      limit: 200,
    });
    const entry = matches.find(m => m.title === key || m.title.startsWith(`${key}-`));
    if (!entry) return null;
    const desc = entry.frontmatter?.description || '';
    const ops = _extractOps(desc);
    const fromMatch = desc.match(/from:\s*(.+?)(?:$|;)/);
    return { ops, sourcePath: fromMatch ? fromMatch[1].trim() : null };
  } catch {
    return null;
  }
}

/**
 * Record that `op` was applied to produce `outputPath` from `sourcePath`.
 * Automatically inherits the source file's lineage so a chain of
 * operations reads in order (e.g. "generate → bg-remove → upscale").
 *
 * Safe to call from any tool — never throws. Failures are logged and
 * swallowed so they cannot break the main action result.
 *
 * Now async (was sync). Callers don't have to await — the tools that use
 * this already wrap it in fire-and-forget try/catch.
 *
 * @param {Object} args
 * @param {string} args.op          — 'generate' | 'upscale' | 'bg-remove' | 'edit' | …
 * @param {string} args.outputPath  — absolute path of the file this op produced
 * @param {string} [args.sourcePath] — absolute path of the input file (if any)
 * @param {Object} [args.params]    — small param bag that ends up in `op(k=v,…)`
 * @param {string} [args.agentName] — who recorded it (informational)
 */
export async function recordImageOp({ op, outputPath, sourcePath, params, agentName } = {}) {
  if (!op || !outputPath) return;
  if (!memory.isInitialized()) return; // best-effort — silent no-op when memory not ready
  try {
    const parent = sourcePath ? await getImageLineage(sourcePath) : null;
    const ops = parent ? [...parent.ops] : [];
    ops.push(_formatOp(op, params));

    const rootSource = parent?.sourcePath || sourcePath || null;
    // Format must keep `;` as the boundary between ops and from segments
    // so _extractOps's `ops:\s*([^;]+)` regex still terminates correctly.
    const opsSegment = `${outputPath} — ops: ${ops.join(' → ')}`;
    const fromSegment = rootSource ? `; from: ${rootSource}` : '';
    const description = (opsSegment + fromSegment).slice(0, 200);

    await memory.write({
      title: _keyFor(outputPath),
      description,
      type: 'insight',
      project: ['image-lineage', agentName || 'media-tool'],
      confidence: 'validated',
      body: [opsSegment, fromSegment.replace(/^;\s*/, '')].filter(Boolean).join('\n'),
    });
  } catch (err) {
    channel.log('image', `[image-lineage] record failed (non-fatal): ${err?.message || err}`);
  }
}
