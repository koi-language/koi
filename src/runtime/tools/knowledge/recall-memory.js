/**
 * recall_memory — retrieve relevant project memories on demand.
 *
 * Backed by the Ori-vendored RMH retrieval pipeline:
 *   BM25 keyword + composite embedding cosine + RRF fusion + (optionally)
 *   PPR graph boost, ACT-R vitality, Hebbian co-occurrence, warmth re-ranking.
 *
 * The Context Compiler ALREADY runs retrieval automatically before each
 * agent turn (the slot map decides which queries to fire and merges results
 * into your prompt). Most of the time you DON'T need to call this — the
 * memories you need are already in your context. This tool is for the
 * residual cases where:
 *
 *   - You realised mid-task you need a fact that wasn't in your prompt.
 *   - You want a specific filter the slot map doesn't apply (e.g. all
 *     blockers tagged with a specific project).
 *   - You're checking whether something is documented before asking the
 *     user.
 *
 * If you find yourself calling recall_memory frequently, it's a signal that
 * the slot map for your role isn't pulling enough — flag it (in your
 * response, not as a memory) and the human will tune it.
 */

import path from 'path';
import os from 'os';
import * as memory from '../../memory/index.js';
import { searchConversations } from '../../state/conversations.js';

/** Resolve a conversation row to its verbatim transcript path. */
function _dialoguePath(row) {
  if (row?.sessionDir) return path.join(row.sessionDir, 'dialogue.jsonl');
  if (row?.sessionId) return path.join(os.homedir(), '.koi', 'sessions', String(row.sessionId), 'dialogue.jsonl');
  return null;
}

export default {
  type: 'recall_memory',
  intent: 'recall_memory',
  description:
    'Search the project memory vault for relevant notes by semantic similarity ' +
    'and keyword match. Returns ranked notes (decisions, learnings, insights, ' +
    'ideas, blockers, opportunities) about the project. ' +
    '\n\n' +
    'IMPORTANT: project knowledge is ALREADY retrieved into your prompt by the ' +
    'Context Compiler before you start. Check your prompt first — call this ' +
    'tool only if you need something specific that was NOT surfaced. ' +
    '\n\n' +
    'WHEN TO CALL (rare):\n' +
    '  • You hit a question mid-task that the prompt didn\'t cover. E.g. you ' +
    'were planning auth and now need to know how rate limiting was decided.\n' +
    '  • You want to filter by a specific type or project tag the slot map ' +
    'didn\'t request. E.g. "all open blockers in ./api".\n' +
    '  • You\'re double-checking before assuming nothing exists about a topic.\n' +
    '\n' +
    'WHEN NOT to call:\n' +
    '  - At the start of every task ("just in case"). The Compiler handles that.\n' +
    '  - To rediscover something already in your conversation history.\n' +
    '  - To search for code (use semantic_code_search instead — that searches ' +
    'the codebase, not memory).\n' +
    '\n' +
    'Fields: `query` (required, free text — phrase as a question or topic), ' +
    '`filter` (optional, narrow by type / project / status / confidence), ' +
    '`limit` (default 8). Returns `results` (vault notes ranked by relevance) ' +
    'PLUS `conversations` — matching PAST CHAT SESSIONS (federated from the ' +
    'conversation index). This is your single recall surface: it finds ' +
    'distilled notes, files the agent created, AND past conversations. ' +
    'Each conversation match carries a `dialoguePath` — `read_file` it to read ' +
    'that conversation VERBATIM and work from the raw transcript.',
  thinkingHint: 'Recalling memory',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text query. Phrase as a topic or question — the retrieval engine ' +
          'uses both keyword and semantic similarity. Examples: "how do we ' +
          'handle authentication?", "rate limiting", "deployment target".',
      },
      filter: {
        type: 'object',
        description:
          'Optional filter narrowing the result set. Combine with the semantic ' +
          'query to focus on a specific area or status.',
        properties: {
          type: {
            description:
              'Restrict to specific note types. Single value or array. Enum: ' +
              'idea | decision | learning | insight | blocker | opportunity.',
          },
          project: {
            description:
              'Restrict to notes tagged with one or more project tags. Single ' +
              'string or array. E.g. "auth", ["api", "gateway"].',
          },
          status: {
            description:
              'Restrict by status. Default skipped (returns active). Enum: ' +
              'active | inbox | superseded | completed | archived.',
          },
          confidence: {
            description:
              'Restrict by confidence level. Useful when you want only validated ' +
              'facts. Enum: speculative | promising | validated.',
          },
        },
      },
      limit: {
        type: 'number',
        description:
          'Max results to return. Default 8. Higher values include lower-scored ' +
          'matches (more recall, less precision).',
      },
      includeConversations: {
        type: 'boolean',
        description:
          'OPTIONAL. Default true — also search PAST CONVERSATIONS and return them ' +
          'under `conversations`. Set false for a pure vault-note lookup.',
      },
      allProjects: {
        type: 'boolean',
        description:
          'OPTIONAL. Default false → past conversations are scoped to the CURRENT ' +
          'project. Set true to search conversations across all projects.',
      },
    },
    required: ['query'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'recall_memory',
      query: 'how do we handle authentication?',
    },
    {
      actionType: 'direct',
      intent: 'recall_memory',
      query: 'rate limiting',
      filter: { type: 'decision', project: 'api' },
      limit: 5,
    },
    {
      actionType: 'direct',
      intent: 'recall_memory',
      query: 'open issues blocking release',
      filter: { type: 'blocker', status: 'active' },
    },
  ],

  async execute(action, agent) {
    const { query, filter, limit } = action;
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'recall_memory: query (string) is required' };
    }
    const _limit = typeof limit === 'number' ? limit : 8;

    // ── 1. Vault notes — distilled notes (decisions/learnings/insights) AND the
    // auto-note left for every file the agent creates. Best-effort: a vault
    // outage must not block the conversation search below. ──
    let vaultResults = [];
    try {
      await memory.ensureInit(agent);
      const results = await memory.retrieve({
        query,
        filter: filter || {},
        limit: _limit,
        agent: agent?.name,
      });
      // Relevance floor. The fused RRF score tops out around 1/(rrf_k+1) ≈ 0.016
      // (rrf_k=60); anything near ~0.002 is NOISE — a query that matches NOTHING
      // still returns the closest junk (image-lineage notes for an email query,
      // score 0.002), which misleads the agent into treating garbage as a hit.
      // Drop sub-floor results so "nothing relevant" reads as nothing. Tunable
      // via KOI_RECALL_MIN_SCORE.
      const MIN_SCORE = Number(process.env.KOI_RECALL_MIN_SCORE) || 0.005;
      vaultResults = results
        .filter((r) => (r.score ?? 0) >= MIN_SCORE)
        .map((r) => ({
          title: r.title,
          score: Number(r.score?.toFixed(3) ?? 0),
          type: r.frontmatter?.type ?? null,
          description: r.frontmatter?.description ?? '',
          project: r.frontmatter?.project ?? [],
          status: r.frontmatter?.status ?? null,
          confidence: r.frontmatter?.confidence ?? null,
          created: r.frontmatter?.created ?? null,
        }));
    } catch { /* vault unavailable — still try conversations */ }

    // ── 2. Federated: PAST CONVERSATIONS. They live in their own auto-built
    // index (not the vault — dumping raw transcripts there would drown the
    // curated notes), but recall_memory is the SINGLE recall surface, so we
    // search it here too. Each match carries a `dialoguePath` the agent can
    // `read_file` for the VERBATIM transcript. ──
    let conversations = [];
    if (action.includeConversations !== false) {
      try {
        const rows = await searchConversations({
          query,
          projectRoot: action.allProjects ? null : (process.env.KOI_PROJECT_ROOT || null),
          k: Math.min(_limit, 5),
          llmProvider: agent?.llmProvider,
        });
        conversations = (rows || [])
          .map((r) => ({
            sessionId: r.sessionId,
            title: r.title || '',
            summary: r.summary || '',
            dialoguePath: _dialoguePath(r),
          }))
          .filter((c) => c.dialoguePath);
      } catch { /* conversation index unavailable — best-effort */ }
    }

    // ── 3. One response: notes + conversations. ──
    const out = {
      success: true,
      count: vaultResults.length,
      results: vaultResults,
      conversations,
      conversationCount: conversations.length,
    };
    if (vaultResults.length === 0 && conversations.length === 0) {
      out.message = 'Nothing matched — no vault note and no past conversation for this query. Do NOT disk-search blindly; ask the user or proceed.';
    } else if (conversations.length > 0) {
      out.note = 'Past conversations matched — `read_file` a `dialoguePath` to read that conversation VERBATIM and work from the raw transcript.';
    }
    return out;
  },
};
