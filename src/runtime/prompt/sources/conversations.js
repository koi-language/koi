/**
 * Conversations source — surfaces past chat exchanges relevant to the
 * current user message, so an agent on a fresh session can pick up "we
 * already talked about X last week" without depending on the RMH vault
 * being up to date.
 *
 * Primary engine: the conversation PALACE (`state/palace.js`) — per-
 * exchange VERBATIM drawers searched via vector + BM25 + RRF. The slot
 * injects the literal text of the matching exchanges (MemPalace
 * philosophy: no summarising, no paraphrasing), so the agent reads what
 * was actually said, not a lossy 2-sentence recap.
 *
 * Fallback: the legacy per-session title+summary KNN
 * (`state/conversations.js`) — only when the palace has no drawers for
 * this wing yet (fresh install, backfill still running) or no hit.
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
 * Returns a markdown list — one entry per matching EXCHANGE:
 *   - **<session title>** _(2w ago)_ [topic: <room>]
 *     User: <verbatim>
 *     Assistant: <verbatim>
 *
 * Excludes the CURRENT session (so the agent doesn't see its own
 * in-progress turns as "previous context"). Empty result yields '',
 * which the compiler treats as "skip this slot".
 */

import { searchConversations } from '../../state/conversations.js';
import { searchPalace, countPalaceDrawers } from '../../state/palace.js';

// Verbatim caps for the PROMPT slot (tighter than the tool payload —
// the slot budget is ~1200 tokens for k≈4-5 exchanges). The stored
// drawer is always full; these only bound what the slot injects.
const SLOT_USER_CAP = 300;
const SLOT_ASSISTANT_CAP = 450;

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
  const currentSessionId = ctx.sessionId || null;

  // ── 1. Palace: verbatim per-exchange drawers. ──
  try {
    const drawerCount = await countPalaceDrawers(projectRoot);
    if (drawerCount > 0) {
      const hits = await searchPalace({
        query: String(semantic),
        projectRoot,
        k: padded,
        llmProvider,
      });
      const filtered = (hits || [])
        .filter((h) => !currentSessionId || h.sessionId !== currentSessionId)
        .filter((h) => h.snippet)
        .slice(0, k);
      if (filtered.length > 0) return _renderDrawerHits(filtered);
    }
  } catch { /* palace unavailable — fall through to legacy */ }

  // ── 2. Legacy: per-session title+summary KNN. ──
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

/**
 * Render palace hits as verbatim exchange blocks. The snippet coming
 * from searchPalace is `User: …\nAssistant: …` (verbatim, tool-payload
 * caps); re-cap each half tighter for the prompt budget, preserving
 * the literal wording — never reflow or paraphrase.
 */
function _renderDrawerHits(hits) {
  const blocks = hits.map((h) => {
    const title = (h.title || '(untitled session)').trim();
    const when = _ago(h.ts);
    const meta = when ? ` _(${when})_` : '';
    const topic = h.room ? ` [topic: ${h.room}]` : '';
    const body = _capSnippet(h.snippet)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `- **${title}**${meta}${topic}\n${body}`;
  });
  return blocks.join('\n');
}

function _capSnippet(snippet) {
  // snippet = "User: <text>" or "User: <text>\nAssistant: <text>"
  const nl = snippet.indexOf('\nAssistant: ');
  if (nl < 0) return _capLine(snippet, SLOT_USER_CAP);
  const userLine = _capLine(snippet.slice(0, nl), SLOT_USER_CAP);
  const assistantLine = _capLine(snippet.slice(nl + 1), SLOT_ASSISTANT_CAP);
  return `${userLine}\n${assistantLine}`;
}

function _capLine(line, cap) {
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length <= cap ? collapsed : collapsed.slice(0, cap - 1) + '…';
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

function _ago(when) {
  if (!when) return '';
  // Accepts an ISO string (legacy conversations rows) or epoch ms
  // (palace drawer `ts`).
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t) || t <= 0) return '';
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
