/**
 * Static source — reads a markdown/text file from disk.
 *
 * Slot config:
 *   { source: 'static', path: 'agents/planner/identity.md' }
 *
 * Path is resolved relative to the agents root (passed in ctx.agentsRoot).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function resolve(slotConfig, ctx) {
  if (!slotConfig.path) throw new Error('static source: path required');
  const root = ctx.agentsRoot || '.';
  const fullPath = path.isAbsolute(slotConfig.path)
    ? slotConfig.path
    : path.join(root, slotConfig.path);
  try {
    return await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}
