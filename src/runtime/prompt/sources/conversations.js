/**
 * Conversations source — KNN over the per-session embeddings index
 * built by `src/runtime/state/conversations.js`. Surfaces past chat
 * sessions whose summary is semantically close to the current user
 * message, so an agent on a fresh session can pick up "we already
 * talked about X last week" without depending on the RMH vault being
 * up to date.
 *
 * Slot config:
 *   {
 *     source: 'conversations',
 *     query: {
 *       semantic: '{{trigger.payload.task}}',  // template-interpolated
 *       k: 5,
 *       projectScope: true,                    // restrict to current projectRoot
 *     },
 *     budget: 1200,
 *   }
 *
 * Returns a markdown bullet list of `**title** — summary` per match.
 * Excludes the CURRENT session (so the agent doesn't see its own
 * in-progress summary as "previous context"). Empty result yields '',
 * which the compiler treats as "skip this slot".
 */

import { searchConversations } from '../../state/conversations.js';

export async function resolve(slotConfig, ctx) {
  const q = slotConfig.query || {};
  const semantic = _interpolate(q.semantic, ctx);
  if (!semantic || !String(semantic).trim()) return '';

  // The KNN needs an llmProvider to embed the query text. The agent
  // already has one wired (state/conversations.js shares it via
  // session-tracker's setConversationIndexProvider singleton); fall
  // back to the agentObject if the singleton isn't bound yet (e.g.
  // first call in a fresh process before the agent's LLMProvider is
  // instantiated).
  const llmProvider = await _resolveLlmProvider(ctx);
  if (!llmProvider) return '';

  const projectRoot = q.projectScope ? (ctx.projectRoot || null) : null;
  const k = q.k ?? 5;
  // Pull a few extra results so we can drop the current session
  // (which would always rank #1 once it's been indexed) and still
  // hand back k usable matches.
  const padded = Math.max(k + 2, 5);

  let items;
  try {
    items = await searchConversations({
      query: String(semantic),
      projectRoot,
      k: padded,
      llmProvider,
    });
  } catch {
    return '';
  }
  if (!Array.isArray(items) || items.length === 0) return '';

  const currentSessionId = ctx.sessionId || null;
  const filtered = items
    .filter((it) => !currentSessionId || it.sessionId !== currentSessionId)
    .slice(0, k);
  if (filtered.length === 0) return '';

  const lines = filtered.map((it) => {
    const title = (it.title || '(untitled session)').trim();
    const summary = (it.summary || it.lastUserMsg || '').replace(/\s+/g, ' ').trim();
    const when = _ago(it.updatedAt);
    const tail = summary ? ` — ${summary}` : '';
    const meta = when ? ` _(${when})_` : '';
    return `- **${title}**${meta}${tail}`;
  });
  return lines.join('\n');
}

async function _resolveLlmProvider(ctx) {
  // Preferred: the singleton the conversations index uses for write-
  // side embedding (set by agent.js when it first instantiates the
  // LLMProvider — see setConversationIndexProvider). Reusing it
  // means the read embeddings come from the same model as the index.
  try {
    const { getConversationIndexProvider } = await import('../../state/session-tracker.js');
    const p = getConversationIndexProvider();
    if (p && typeof p.getEmbedding === 'function') return p;
  } catch { /* fall through */ }
  // Fallback: the live agent's own provider.
  const ag = ctx.agentObject;
  if (ag?.llmProvider && typeof ag.llmProvider.getEmbedding === 'function') {
    return ag.llmProvider;
  }
  return null;
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

function _ago(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const delta = Date.now() - t;
  const m = Math.floor(delta / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
