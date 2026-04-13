/**
 * Index Code Action — Trigger semantic code indexing for the project.
 *
 * Parses source files into class/function hierarchy, generates LLM descriptions,
 * creates embeddings, and stores in LanceDB for semantic_code_search.
 *
 * Permission: read (reads source files only)
 */

import path from 'path';

import { getFilePermissions } from '../../code/file-permissions.js';
import { channel } from '../../io/channel.js';
import { t } from '../../i18n.js';

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
      channel.clearProgress();
      const value = await channel.select(t('allowReadForIndexing'), [
        { title: t('permYes'), value: 'yes' },
        { title: t('permAlwaysAllow'), value: 'always' },
        { title: t('permNo'), value: 'no' },
      ]);
      if (value === 'always') permissions.allow(projectDir, 'read');
      else if (value !== 'yes') return { success: false, denied: true };
    }

    try {
      const { getSemanticIndex } = await import('../../state/semantic-index.js');
      const { detectAllLocalDependencies } = await import('../../code/local-dependency-detector.js');

      // Detect local dependencies — indexed into the SAME DB as the main project
      const depDirs = detectAllLocalDependencies(projectDir);
      if (depDirs.length > 0) {
        channel.log('index-code', `Local dependencies: ${depDirs.map(d => path.basename(d)).join(', ')}`);
      }

      const cacheDir = path.join(projectDir, '.koi', 'cache', 'semantic-index');
      const index = getSemanticIndex(cacheDir, agent.llmProvider);

      if (action.force) {
        index.clearManifest();
      }

      channel.progress('Building semantic index...');

      const stats = await index.build(projectDir, (done, total) => {
        const pct = Math.round((done / total) * 100);
        const filled = Math.round((done / total) * 10);
        const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
        channel.progress(`indexing ${bar} ${pct}%`);
        if (channel.sendIndexStatus) {
          channel.sendIndexStatus({ progress: done, total, isBuilding: true });
        }
      }, { depDirs });

      channel.clear();

      const depSummary = depDirs.length > 0
        ? ` (includes ${depDirs.length} dependencies: ${depDirs.map(d => path.basename(d)).join(', ')})`
        : '';
      channel.print(`Semantic index complete: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.total} total files${depSummary}`);

      return {
        success: true,
        indexed: stats.indexed,
        skipped: stats.skipped,
        total: stats.total,
        dependencies: depDirs.map(d => path.basename(d)),
      };
    } catch (err) {
      channel.clear();
      // Rethrow quota-exceeded so the agent's action catch handles it uniformly
      // (shows the upgrade dialog once and parks the session). Returning a
      // plain failure here would cause the LLM to be re-called and trigger a
      // second dialog from the LLM catch path.
      const { isQuotaExceededError, toQuotaExceededError } = await import('../../llm/quota-exceeded-error.js');
      if (isQuotaExceededError(err)) {
        throw toQuotaExceededError(err) || err;
      }
      return { success: false, error: `Indexing failed: ${err.message}` };
    }
  },
};
