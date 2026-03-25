/**
 * Semantic Code Search Action — Search the semantic code index by natural language query.
 *
 * Searches across files, classes, and functions using vector embeddings.
 * Requires a prior index_code run (or background indexing) to populate the index.
 *
 * Permission: read
 */

import path from 'path';

import { getFilePermissions } from '../../code/file-permissions.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'semantic_code_search',
  intent: 'semantic_code_search',
  description: 'Search the codebase semantically by keywords and concepts. Finds files, classes, and functions by meaning. Write queries as keyword lists (NOT questions): "email validation regex format", "database connection pool setup". Drop filler words (where, which, how). Fields: "query" (keywords), "type" (file|class|function — optional filter), "path" (directory scope), "maxResults" (default 20)',
  instructions: `Semantic search queries MUST be compact keyword queries, not natural-language questions.

Guidelines:
- Remove filler words such as: where, which, how, what, is, the, are, does, find
- Prefer technical keywords
- Expand with synonyms when helpful

Bad:
"where is semantic indexing implemented"

Good:
"semantic index build embed vector store"

Bad:
"which languages are supported"

Good:
"language support parser javascript typescript python"

Split searches only when the request contains independent subquestions or distinct search targets.
If multiple independent searches do not depend on each other, they MUST be run in a single parallel block.

Do NOT split a query merely because it contains multiple nouns if they refer to the same concept.

Search results are leads, not answers:
- You MUST read_file the relevant source before answering questions about code behavior or implementation
- If search results are low-confidence, incomplete, or ambiguous, use additional tools before answering
- Never summarize unread content
- If a result has not been returned yet, you do not know it
- If the answer cannot be found after reasonable attempts, say so honestly; never fabricate`,
  thinkingHint: (action) => `Searching: ${action.query ? action.query.slice(0, 40) : 'code'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords and concepts to search for. Use nouns and domain terms, not questions. E.g. "email validation regex format check"',
      },
      type: {
        type: 'string',
        enum: ['file', 'class', 'function'],
        description: 'Filter results to a specific type',
      },
      path: {
        type: 'string',
        description: 'Restrict search to files under this directory prefix',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default 20)',
      },
    },
    required: ['query'],
  },

  examples: [
    { actionType: 'direct', intent: 'semantic_code_search', query: 'email validation regex format check' },
    { actionType: 'direct', intent: 'semantic_code_search', query: 'authentication login session token middleware', type: 'function' },
    { actionType: 'direct', intent: 'semantic_code_search', query: 'database connection pool setup config', path: 'src/db/' },
  ],

  async execute(action, agent) {
    const { query, type, maxResults = 20 } = action;

    if (!query) {
      return { success: false, error: 'semantic_code_search requires a "query" field' };
    }

    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    const projectDir = path.resolve(action.path || projectRoot);
    // Only apply pathPrefix for subdirectory scoping within the main project
    const pathPrefix = (action.path && !action.path.includes('node_modules') && !action.path.startsWith('dep:'))
      ? action.path : undefined;

    // Permission check
    const permissions = getFilePermissions(agent);
    if (!permissions.isAllowed(projectDir, 'read')) {
      channel.clearProgress();
      const value = await channel.select('Allow reading files for search?', [
        { title: 'Yes', value: 'yes' },
        { title: 'Always allow in this directory', value: 'always' },
        { title: 'No', value: 'no' },
      ]);
      if (value === 'always') permissions.allow(projectDir, 'read');
      else if (value !== 'yes') return { success: false, denied: true };
    }

    try {
      const _t0 = Date.now();
      const { getSemanticIndex } = await import('../../state/semantic-index.js');
      channel.log('semantic-search', `[${query.slice(0, 40)}] import: ${Date.now() - _t0}ms`);

      // Single unified index — includes main project + dependency files
      const cacheDir = path.join(projectRoot, '.koi', 'cache', 'semantic-index');
      const index = getSemanticIndex(cacheDir, agent.llmProvider);
      channel.log('semantic-search', `[${query.slice(0, 40)}] getIndex: ${Date.now() - _t0}ms, building=${index.isBuilding()}`);

      if (index.isBuilding()) {
        return {
          success: false,
          error: 'Semantic index is currently being built in the background. Use text-based search (search mode:query or grep) as a fallback, and retry semantic_code_search later.',
        };
      }

      if (!(await index.isReady())) {
        return {
          success: false,
          error: 'Semantic index not built yet. Use index_code first, or wait for background indexing to complete.',
        };
      }
      channel.log('semantic-search', `[${query.slice(0, 40)}] isReady: ${Date.now() - _t0}ms`);

      // Embed the query
      channel.log('semantic-search', `[${query.slice(0, 40)}] Getting embedding...`);
      const queryEmbedding = await agent.llmProvider.getEmbedding(query);
      channel.log('semantic-search', `[${query.slice(0, 40)}] Embedding received, searching cache...`);

      // Search the unified index (includes main project + dependency files)
      const results = await index.search(queryEmbedding, {
        type,
        limit: maxResults,
        pathPrefix,
      });

      channel.log('semantic-search', `[${query.slice(0, 40)}] Search done, ${results.length} results`);

      channel.clear();

      // Filter pure noise (< 0.2) but keep everything else — let the agent
      // decide which results are relevant based on their descriptions and context.
      const MIN_SCORE = 0.2;
      const MAX_RESULTS = 10;

      const filtered = results.filter(r => r.score >= MIN_SCORE).slice(0, MAX_RESULTS);

      if (filtered.length === 0) {
        return {
          success: true,
          query,
          count: 0,
          results: [],
                    hint: 'ZERO RESULTS. You MUST search using other tools NOW: grep(pattern:"..."), search(mode:symbols,query:"..."), search(mode:glob,pattern:"*keyword*"). Do NOT answer until you have found and READ the actual source code.',
        };
      }

      const mapped = filtered.map((r) => ({
        type: r.type,
        name: r.name,
        filePath: r.filePath,
        lineFrom: r.lineFrom,
        lineTo: r.lineTo,
        description: r.description,
        score: Math.round(r.score * 1000) / 1000,
        ...(r.signature && { signature: r.signature }),
        ...(r.className && { className: r.className }),
      }));

      return {
        success: true,
        query,
        count: mapped.length,
        results: mapped,
                hint: 'DECIDE AND ZOOM IN: Review each result\'s description against what you are looking for. For any result whose description matches your search intent, call read_file IMMEDIATELY using its filePath and lineFrom/lineTo. Do NOT skip to grep/glob — the descriptions tell you which files are worth reading. Only fall back to text-based search if NONE of the descriptions match your needs.',
      };
    } catch (err) {
      channel.clear();
      return { success: false, error: `Semantic search failed: ${err.message}` };
    }
  },
};
