/**
 * Index Code Action — Trigger semantic code indexing for the project.
 *
 * Parses source files into class/function hierarchy, generates LLM descriptions,
 * creates embeddings, and stores in LanceDB for semantic_code_search.
 *
 * Permission: read (reads source files only)
 */

import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { getFilePermissions } from '../file-permissions.js';
import { cliSelect } from '../cli-select.js';

export default {
  type: 'index_code',
  intent: 'index_code',
  description: 'Build or update the semantic code index for the project. Parses source files, generates descriptions via LLM, and creates embeddings for semantic_code_search. Use "force" to rebuild everything. Fields: "path" (directory to index, default cwd), "force" (boolean, re-index all files)',
  thinkingHint: 'Indexing code',
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to index (default: project root)',
      },
      force: {
        type: 'boolean',
        description: 'Force re-indexing of all files (ignores cache)',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'index_code' },
    { actionType: 'direct', intent: 'index_code', path: 'src/', force: true },
  ],

  async execute(action, agent) {
    const projectDir = path.resolve(action.path || process.env.KOI_PROJECT_ROOT || process.cwd());

    // Permission check
    const permissions = getFilePermissions(agent);
    if (!permissions.isAllowed(projectDir, 'read')) {
      cliLogger.clearProgress();
      const value = await cliSelect('Allow reading files for indexing?', [
        { title: 'Yes', value: 'yes' },
        { title: 'Always allow in this directory', value: 'always' },
        { title: 'No', value: 'no' },
      ]);
      if (value === 'always') permissions.allow(projectDir, 'read');
      else if (value !== 'yes') return { success: false, denied: true };
    }

    try {
      const { getSemanticIndex } = await import('../semantic-index.js');
      const cacheDir = path.join(projectDir, '.koi', 'cache', 'semantic-index');
      const index = getSemanticIndex(cacheDir, agent.llmProvider);

      if (action.force) {
        index.clearManifest();
      }

      cliLogger.progress('Building semantic index...');

      const stats = await index.build(projectDir, (done, total) => {
        const pct = Math.round((done / total) * 100);
        cliLogger.progress(`Indexing ${pct}%...`);
      });

      cliLogger.clear();
      cliLogger.print(`Semantic index complete: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.total} total files`);

      return {
        success: true,
        indexed: stats.indexed,
        skipped: stats.skipped,
        total: stats.total,
      };
    } catch (err) {
      cliLogger.clear();
      return { success: false, error: `Indexing failed: ${err.message}` };
    }
  },
};
