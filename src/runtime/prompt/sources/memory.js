/**
 * Memory source — calls memory.retrieve / memory.list.
 *
 * Slot config:
 *   {
 *     source: 'memory',
 *     query: {
 *       semantic: '{{trigger.payload.task}}',  // template-interpolated
 *       filter: { type: 'decision', status: 'active' },
 *       hops: 2,
 *       limit: 8,
 *       scope: 'project',                       // optional
 *     }
 *   }
 *
 * If `semantic` is empty/absent, falls back to memory.list (no ranking).
 *
 * Returns a markdown-formatted block of the matched notes with their
 * descriptions and titles.
 */

import * as memory from '../../memory/index.js';

export async function resolve(slotConfig, ctx) {
  const q = slotConfig.query || {};
  const semantic = _interpolate(q.semantic, ctx);
  const filter = q.filter || {};
  const limit = q.limit ?? 8;
  const scope = q.scope || 'project';
  const agent = ctx.agent;

  let results = [];
  if (semantic && String(semantic).trim().length > 0) {
    results = await memory.retrieve({ query: semantic, filter, limit, scope, agent });
  } else {
    results = await memory.list({ filter, limit, scope });
    // Coerce list shape to retrieve shape (no .score)
    results = results.map((r) => ({ title: r.title, score: 0, frontmatter: r.frontmatter }));
  }

  if (results.length === 0) return '';

  const lines = results.map((r) => {
    const fm = r.frontmatter || {};
    const desc = fm.description ? ` — ${fm.description}` : '';
    const type = fm.type ? `[${fm.type}]` : '';
    const proj = Array.isArray(fm.project) && fm.project.length
      ? ` (${fm.project.join(', ')})`
      : '';
    return `- ${type} **${r.title}**${desc}${proj}`;
  });
  return lines.join('\n');
}

function _interpolate(template, ctx) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, id) => {
    const v = _lookup(ctx, id);
    return v == null ? '' : String(v);
  });
}

function _lookup(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
