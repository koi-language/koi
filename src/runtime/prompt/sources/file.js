/**
 * File source — reads sections of a file from the project root.
 *
 * Slot config:
 *   { source: 'file', path: 'KOI.md', sections: ['# Stack', '# Constraints'] }
 *
 * Sections are markdown headings (matched literally). When `sections` is
 * absent, the whole file is returned. Path is resolved relative to
 * ctx.projectRoot.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function resolve(slotConfig, ctx) {
  if (!slotConfig.path) throw new Error('file source: path required');
  const root = ctx.projectRoot || process.cwd();
  const fullPath = path.isAbsolute(slotConfig.path)
    ? slotConfig.path
    : path.join(root, slotConfig.path);

  let content;
  try {
    content = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }

  if (!Array.isArray(slotConfig.sections) || slotConfig.sections.length === 0) {
    return content;
  }

  return _extractSections(content, slotConfig.sections).join('\n\n').trim();
}

function _extractSections(content, headings) {
  const lines = content.split('\n');
  const out = [];
  for (const wanted of headings) {
    let collecting = false;
    let collected = [];
    let level = null;
    for (const line of lines) {
      const headingMatch = /^(#+)\s+(.+)$/.exec(line);
      if (collecting && headingMatch) {
        const m = headingMatch;
        // Stop at same-or-higher-level heading
        if (m[1].length <= level) break;
      }
      if (collecting) collected.push(line);
      if (!collecting && line.trim() === wanted) {
        collecting = true;
        level = (/^(#+)/.exec(line) || ['#'])[0].length;
        collected.push(line);
      }
    }
    if (collected.length > 0) out.push(collected.join('\n'));
  }
  return out;
}
