/**
 * Semantic Code Search Action — Search the semantic code index by natural language query.
 *
 * Searches across files, classes, and functions using vector embeddings.
 * Requires a prior index_code run (or background indexing) to populate the index.
 *
 * Permission: read
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { getFilePermissions } from '../file-permissions.js';
import { cliSelect } from '../cli-select.js';

export default {
  type: 'semantic_code_search',
  intent: 'semantic_code_search',
  description: 'Search the codebase semantically using natural language. Finds files, classes, and functions by meaning, not just text. Fields: "query" (what to search for), "type" (file|class|function — optional filter), "path" (directory scope), "maxResults" (default 20)',
  thinkingHint: (action) => `Searching: ${action.query ? action.query.slice(0, 40) : 'code'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query (e.g. "function that validates email addresses")',
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
    { actionType: 'direct', intent: 'semantic_code_search', query: 'function that validates email addresses' },
    { actionType: 'direct', intent: 'semantic_code_search', query: 'authentication middleware', type: 'function' },
    { actionType: 'direct', intent: 'semantic_code_search', query: 'database connection setup', path: 'src/db/' },
  ],

  async execute(action, agent) {
    const { query, type, maxResults = 20 } = action;

    if (!query) {
      return { success: false, error: 'semantic_code_search requires a "query" field' };
    }

    const projectDir = path.resolve(action.path ? path.dirname(action.path) : (process.env.KOI_PROJECT_ROOT || process.cwd()));
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
      const { getSemanticIndex } = await import('../semantic-index.js');
      const cacheDir = path.join(
        process.env.KOI_PROJECT_ROOT || process.cwd(),
        '.koi', 'cache', 'semantic-index'
      );
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

      // Include source code for top results so the LLM can analyze actual code.
      // Only top 5 get source to keep token usage reasonable.
      const SOURCE_CODE_LIMIT = 5;
      const FILE_PREVIEW_LINES = 80;
      const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

      return {
        success: true,
        query,
        count: results.length,
        results: results.map((r, i) => {
          let sourceCode = r.sourceCode;

          // For file-type results (no sourceCode stored), read a preview from disk
          if (i < SOURCE_CODE_LIMIT && !sourceCode && r.filePath) {
            try {
              const fullPath = path.isAbsolute(r.filePath) ? r.filePath : path.join(projectRoot, r.filePath);
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              sourceCode = lines.slice(0, FILE_PREVIEW_LINES).join('\n');
              if (lines.length > FILE_PREVIEW_LINES) sourceCode += `\n... (${lines.length - FILE_PREVIEW_LINES} more lines)`;
            } catch { /* file not readable */ }
          }

          return {
            type: r.type,
            name: r.name,
            filePath: r.filePath,
            lineFrom: r.lineFrom,
            lineTo: r.lineTo,
            description: r.description,
            score: Math.round(r.score * 1000) / 1000,
            ...(r.signature && { signature: r.signature }),
            ...(r.className && { className: r.className }),
            ...(i < SOURCE_CODE_LIMIT && sourceCode && { sourceCode }),
          };
        }),
      };
    } catch (err) {
      cliLogger.clear();
      return { success: false, error: `Semantic search failed: ${err.message}` };
    }
  },
};
