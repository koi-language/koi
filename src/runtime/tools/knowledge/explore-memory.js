/**
 * explore_memory — multi-hop graph traversal of the project memory vault.
 *
 * Backed by the Ori-vendored RMH explore pipeline:
 *   single-pass retrieve → seed PPR → spread along wiki-link edges →
 *   if depth > 0 and an LLM is wired, decompose into sub-questions, recurse,
 *   converge when new passes stop surfacing new notes.
 *
 * Difference vs `recall_memory`:
 *   recall_memory  — single-pass keyword + embedding similarity. Cheap, fast.
 *   explore_memory — graph-aware. Follows [[wiki-links]] between notes,
 *                    decomposes the query into sub-questions, retrieves
 *                    against each, fuses. Right answer when the relevant
 *                    note is two hops away (e.g. "the rationale for X is
 *                    in note A, which links to note B which holds the
 *                    actual constraint we hit").
 *
 * Use explore_memory when:
 *   - You called recall_memory, got a near-miss, and suspect the answer is
 *     adjacent (linked from) a note you found.
 *   - The question is composite ("why did we choose JWT given how rate
 *     limiting is implemented?") — a single search misses the join.
 *   - You're orienting on an unfamiliar area and want a wider net of
 *     connected notes, not just the top match.
 *
 * Don't use when:
 *   - You already know the exact title or topic — recall_memory is faster.
 *   - The vault has no wiki-links yet — explore degrades to recall_memory
 *     plus extra LLM cost.
 */

import * as memory from '../../memory/index.js';

export default {
  type: 'explore_memory',
  intent: 'explore_memory',
  description:
    'Multi-hop graph search of the project memory vault. Decomposes the query ' +
    'into sub-questions, follows [[wiki-links]] between notes, and surfaces ' +
    'related context that single-pass recall_memory would miss. ' +
    '\n\n' +
    'Use when recall_memory returned partial results and you suspect the answer ' +
    'is one hop away, or when the question crosses multiple topics. Slower than ' +
    'recall_memory (does an LLM-driven decomposition pass). Returns ranked notes ' +
    'plus the link paths that connected them.',
  thinkingHint: 'Exploring memory',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The original question. Phrase it as you would naturally — explore ' +
          'will decompose it into sub-questions and search each. Examples: ' +
          '"why did we pick JWT and how does that interact with rate limiting?", ' +
          '"what blocks us from shipping auth refactor?".',
      },
      filter: {
        type: 'object',
        description:
          'Optional filter on the candidate set. Same fields as recall_memory.',
        properties: {
          type: { description: 'Restrict to types: idea | decision | learning | insight | blocker | opportunity.' },
          project: { description: 'Restrict to project tags.' },
          status: { description: 'Restrict to status (default: active).' },
        },
      },
      depth: {
        type: 'number',
        description:
          'Traversal depth. 1=shallow (cheap, near neighbours only), ' +
          '2=standard (default), 3=deep (more PPR iterations, more recursion).',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 8.',
      },
    },
    required: ['query'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'explore_memory',
      query: 'what decisions led to the current auth design?',
    },
    {
      actionType: 'direct',
      intent: 'explore_memory',
      query: 'rate limiting and how it interacts with the gateway',
      filter: { project: 'api' },
      depth: 3,
    },
  ],

  async execute(action, agent) {
    const { query, filter, limit, depth } = action;
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'explore_memory: query (string) is required' };
    }

    try {
      await memory.ensureInit(agent);
    } catch {
      return { success: true, results: [], message: 'Memory unavailable.' };
    }

    try {
      const out = await memory.explore({
        query,
        filter: filter || {},
        limit: typeof limit === 'number' ? limit : 8,
        depth: typeof depth === 'number' ? depth : undefined,
        agent: agent?.name,
      });
      return {
        success: true,
        count: out.results.length,
        results: out.results.map((r) => ({
          title: r.title,
          score: Number((r.score ?? 0).toFixed(3)),
          source: r.source ?? null,
          type: r.frontmatter?.type ?? null,
          description: r.frontmatter?.description ?? '',
          project: r.frontmatter?.project ?? [],
        })),
        paths: out.paths,
        sub_queries: out.subQueries,
        converged: out.converged,
        recursion_depth: out.recursionDepth,
      };
    } catch (err) {
      return { success: false, error: `explore_memory failed: ${err.message}` };
    }
  },
};
