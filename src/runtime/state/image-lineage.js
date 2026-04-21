/**
 * Image Lineage — compact provenance tracking for media files.
 *
 * Every time a tool produces a media file (generate_image,
 * background_removal, upscale_image, …) it calls `recordImageOp(...)`.
 * The resulting fact enters the plan-scoped knowledge store, so the
 * System agent can see — via `recall_facts` — what operations have
 * already been applied to the file currently in the user's working area.
 *
 * Why: after a mid-pipeline failure (e.g. a ProviderBlockedError) System
 * tends to "retry" by replaying the WHOLE user request. Without lineage
 * it does not know that the active image is already the output of
 * bg-remove + upscale, so it asks Worker to bg-remove + upscale again.
 * With lineage surfaced in context, System can skip the steps that are
 * already represented in the file's history and only re-delegate what
 * actually failed.
 *
 * Facts live in `planKnowledge` (not `sessionKnowledge`):
 *   - They are transient working-memory of the current plan.
 *   - They auto-clear when the plan completes, so a fresh user request
 *     doesn't pick up stale "this file was upscaled" signals from an
 *     earlier unrelated task.
 *
 * Key format:  `image_lineage_<basename-without-ext>`
 * Value format (human-readable, parseable — ≤300 chars):
 *   <abs-path> — ops: <op1>(k=v,…) → <op2> → …; from: <source-abs-path>
 *
 * Example:
 *   key   = image_lineage_upscale_1776687611619_0
 *   value = /Users/me/.koi/images/upscale_…png —
 *           ops: bg-remove → upscale(factor=2); from: /Users/me/…/photo.jpg
 */

import path from 'path';
import { planKnowledge } from './session-knowledge.js';
import { channel } from '../io/channel.js';

/** Strip the extension to form a stable, filesystem-safe key suffix. */
function _keyFor(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // Restrict to [a-zA-Z0-9_-] so the recall_facts markdown stays readable.
  return `image_lineage_${base.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
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
 * Look up the lineage string for a given file path. Returns `null` when
 * the file has no recorded history (e.g. a brand-new generation, or an
 * external image the user dropped in).
 *
 * @param {string} filePath
 * @returns {{ops: string[], sourcePath: string|null} | null}
 */
export function getImageLineage(filePath) {
  if (!filePath) return null;
  const key = _keyFor(filePath);
  const entries = planKnowledge.recall();
  const entry = entries.find(e => e.key === key);
  if (!entry) return null;
  const ops = _extractOps(entry.value);
  const fromMatch = entry.value.match(/from:\s*(.+?)(?:$|;)/);
  return { ops, sourcePath: fromMatch ? fromMatch[1].trim() : null };
}

/**
 * Record that `op` was applied to produce `outputPath` from `sourcePath`.
 * Automatically inherits the source file's lineage so a chain of
 * operations reads in order (e.g. "generate → bg-remove → upscale").
 *
 * Safe to call from any tool — never throws. Failures are logged and
 * swallowed so they cannot break the main action result.
 *
 * @param {Object} args
 * @param {string} args.op          — short label: 'generate', 'upscale', 'bg-remove', 'edit'
 * @param {string} args.outputPath  — absolute path of the file this op produced
 * @param {string} [args.sourcePath] — absolute path of the input file (if any)
 * @param {Object} [args.params]    — small param bag that ends up in `op(k=v,…)`
 * @param {string} [args.agentName] — who recorded it (usually the tool-owning agent)
 */
export function recordImageOp({ op, outputPath, sourcePath, params, agentName } = {}) {
  if (!op || !outputPath) return;
  try {
    // Inherit upstream ops so a single fact answers "what has been done
    // to this file up to now" without the caller having to walk the
    // chain.
    const parent = sourcePath ? getImageLineage(sourcePath) : null;
    const ops = parent ? [...parent.ops] : [];
    ops.push(_formatOp(op, params));

    // Root source: prefer the parent's root if any, so long pipelines
    // keep pointing back to the original input instead of the immediate
    // predecessor.
    const rootSource = parent?.sourcePath || sourcePath || null;

    const parts = [outputPath, `ops: ${ops.join(' → ')}`];
    if (rootSource) parts.push(`from: ${rootSource}`);
    const value = parts.join(' — ');

    planKnowledge.learn(_keyFor(outputPath), value, {
      category: 'status',
      agentName: agentName || 'media-tool',
    });
  } catch (err) {
    channel.log('image', `[image-lineage] record failed (non-fatal): ${err?.message || err}`);
  }
}
