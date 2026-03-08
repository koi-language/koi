/**
 * Semantic Code Search Action — Search the semantic code index by natural language query.
 *
 * Searches across files, classes, and functions using vector embeddings.
 * Requires a prior index_code run (or background indexing) to populate the index.
 *
 * Permission: read
 */

import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { getFilePermissions } from '../file-permissions.js';
import { cliSelect } from '../cli-select.js';

export default {
  type: 'semantic_code_search',
  intent: 'semantic_code_search',
  description: 'Search the codebase semantically by keywords and concepts. Finds files, classes, and functions by meaning. Write queries as keyword lists (NOT questions): "email validation regex format", "database connection pool setup". Drop filler words (where, which, how). Fields: "query" (keywords), "type" (file|class|function — optional filter), "path" (directory scope), "maxResults" (default 20)',
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

    const projectDir = path.resolve(action.path || (process.env.KOI_PROJECT_ROOT || process.cwd()));
    const pathPrefix = action.path || undefined;

    // Permission check
    const permissions = getFilePermissions(agent);
    if (!permissions.isAllowed(projectDir, 'read')) {
      cliLogger.clearProgress();
      const value = await cliSelect('Allow reading files for search?', [
        { title: 'Yes', value: 'yes' },
        { title: 'Always allow in this directory', value: 'always' },
        { title: 'No', value: 'no' },
      ]);
      if (value === 'always') permissions.allow(projectDir, 'read');
      else if (value !== 'yes') return { success: false, denied: true };
    }

    try {
      const { getSemanticIndex, findProjectCacheDir } = await import('../semantic-index.js');

      // Determine which project's index to use.
      // If action.path points outside KOI_PROJECT_ROOT, look for a .koi index there.
      const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
      const searchPath = action.path ? path.resolve(projectRoot, action.path) : projectRoot;
      const isExternal = !searchPath.startsWith(projectRoot + path.sep) && searchPath !== projectRoot;

      let cacheDir;
      let indexProjectRoot = projectRoot;
      if (isExternal) {
        const externalCache = findProjectCacheDir(searchPath);
        if (externalCache) {
          cacheDir = externalCache;
          // The project root is 3 levels up from .koi/cache/semantic-index
          indexProjectRoot = path.resolve(externalCache, '..', '..', '..');
        }
      }
      if (!cacheDir) {
        cacheDir = path.join(projectRoot, '.koi', 'cache', 'semantic-index');
      }

      const index = getSemanticIndex(cacheDir, agent.llmProvider);

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

      cliLogger.progress('Searching semantic index...');

      // Embed the query
      cliLogger.log('semantic-search', `[${query.slice(0, 40)}] Getting embedding...`);
      const queryEmbedding = await agent.llmProvider.getEmbedding(query);
      cliLogger.log('semantic-search', `[${query.slice(0, 40)}] Embedding received, searching cache...`);

      const results = await index.search(queryEmbedding, {
        type,
        limit: maxResults,
        pathPrefix,
      });
      cliLogger.log('semantic-search', `[${query.slice(0, 40)}] Search done, ${results.length} results`);

      cliLogger.clear();

      // Two-tier scoring: high confidence (>= 0.35) and low confidence (0.2-0.35).
      // Below 0.2 is pure noise and gets discarded.
      const HIGH_SCORE = 0.35;
      const MIN_SCORE = 0.2;
      const MAX_RESULTS = 10;

      const aboveMin = results.filter(r => r.score >= MIN_SCORE).slice(0, MAX_RESULTS);

      if (aboveMin.length === 0) {
        return {
          success: true,
          query,
          count: 0,
          results: [],
          ...(isExternal && { projectRoot: indexProjectRoot }),
          hint: 'ZERO RESULTS. DO NOT answer the user — you have no information yet. You MUST search using other tools NOW: grep(pattern:"..."), search(mode:symbols,query:"..."), search(mode:glob,pattern:"*keyword*"). Do NOT print a response until you have found and READ the actual source code.',
        };
      }

      const hasHighConfidence = aboveMin.some(r => r.score >= HIGH_SCORE);

      const mapped = aboveMin.map((r) => ({
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
        ...(isExternal && { projectRoot: indexProjectRoot }),
        ...(!hasHighConfidence && {
          hint: 'WARNING: All results have LOW confidence (< 0.35) — they are likely WRONG. DO NOT answer the user based on these descriptions. You MUST verify by using grep, search(mode:symbols), or search(mode:glob) to find the actual files, then read_file to confirm before answering.',
        }),
      };
    } catch (err) {
      cliLogger.clear();
      return { success: false, error: `Semantic search failed: ${err.message}` };
    }
  },
};
