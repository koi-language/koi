/**
 * Background Task Manager - Runs async tasks without blocking the agent loop.
 *
 * Zero knowledge of Ink/React — communicates status via channel.setTaskStatus().
 * Tasks are deduplicated by name. Status auto-clears after completion.
 */

import path from 'path';
import { channel } from '../io/channel.js';

function progressBar(done, total, width = 10) {
  const pct = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * width);
  const bar = '▰'.repeat(filled) + '▱'.repeat(width - filled);
  return `indexing ${bar} ${pct}%`;
}

class BackgroundTaskManager {
  constructor() {
    /** @type {Map<string, { status: 'running'|'done'|'error', progress?: string, error?: string, promise: Promise }>} */
    this._tasks = new Map();
  }

  /**
   * Run a named background task. Deduplicates by name (skips if already running/done).
   * @param {string} name - Unique task name
   * @param {Function} asyncFn - async (reportProgress) => result. reportProgress(text) updates the footer.
   * @returns {Promise} The task promise (fire-and-forget safe)
   */
  run(name, asyncFn) {
    if (this._tasks.has(name)) return this._tasks.get(name).promise;

    const entry = { status: 'running', progress: '', promise: null };
    this._tasks.set(name, entry);
    this._updateFooter();

    const promise = (async () => {
      try {
        await asyncFn((progressText) => {
          entry.progress = progressText;
          this._updateFooter();
        });
        entry.status = 'done';
        entry.progress = '';
        this._updateFooter();
        // Auto-cleanup after 3s
        setTimeout(() => {
          if (this._tasks.get(name) === entry) {
            this._tasks.delete(name);
            this._updateFooter();
          }
        }, 3000);
      } catch (err) {
        entry.status = 'error';
        entry.error = err.message;
        this._updateFooter();
        channel.log('background', `Task "${name}" FAILED: ${err.message}\n${err.stack || ''}`);
        // Auto-cleanup after 5s
        setTimeout(() => {
          if (this._tasks.get(name) === entry) {
            this._tasks.delete(name);
            this._updateFooter();
          }
        }, 5000);
      }
    })();

    entry.promise = promise;
    return promise;
  }

  /**
   * Get the current state of a task.
   * @param {string} name
   * @returns {{ status, progress?, error? } | null}
   */
  get(name) {
    return this._tasks.get(name) || null;
  }

  /**
   * Combine all running task statuses into one string and push to channel.
   * @private
   */
  _updateFooter() {
    const parts = [];
    for (const [name, entry] of this._tasks) {
      if (entry.status === 'running') {
        parts.push(entry.progress || name);
      } else if (entry.status === 'done') {
        parts.push(`${name} \u2713`);
      } else if (entry.status === 'error') {
        parts.push(`${name} \u2717`);
      }
    }
    channel.setTaskStatus(parts.length > 0 ? parts.join(' | ') : '');
  }

  /**
   * Re-run a named task even if it already completed.
   * If the task is currently running, waits for it to finish first.
   * @param {string} name - Task name to restart
   * @param {Function} asyncFn - Same as run()
   */
  async rerun(name, asyncFn) {
    const existing = this._tasks.get(name);
    if (existing && existing.status === 'running') {
      await existing.promise;
    }
    this._tasks.delete(name);
    return this.run(name, asyncFn);
  }

  /**
   * Helper: start semantic code indexing using SemanticIndex + LanceDB.
   * @param {string} projectDir - Project root directory
   * @param {import('../llm/llm-provider.js').LLMProvider} llmProvider
   */
  /** @private Shared indexing logic used by start/restart. */
  _indexingFn(projectDir, llmProvider) {
    return async (report) => {
      channel.log('background', 'Loading semantic-index module...');
      const { getSemanticIndex } = await import('../state/semantic-index.js');
      channel.log('background', 'semantic-index module loaded OK');

      // Detect local dependencies — their files will be indexed into the SAME DB.
      let depDirs = [];
      try {
        const { detectAllLocalDependencies, seedDependenciesFile } = await import('../code/local-dependency-detector.js');
        seedDependenciesFile(projectDir);
        depDirs = detectAllLocalDependencies(projectDir);
        if (depDirs.length > 0) {
          channel.log('background', `Local dependencies found: ${depDirs.map(d => path.basename(d)).join(', ')}`);
        }
      } catch (depErr) {
        channel.log('background', `Dependency detection failed: ${depErr.message}`);
      }

      const cacheDir = path.join(projectDir, '.koi', 'cache', 'semantic-index');
      const index = getSemanticIndex(cacheDir, llmProvider);

      channel.log('background', 'Checking if index is up-to-date...');
      const upToDate = await index.isUpToDate(projectDir, { depDirs });
      channel.log('background', `isUpToDate: ${upToDate}`);

      if (upToDate) {
        channel.log('background', 'Semantic index up-to-date — pre-loading cache');
        await index.ensureCacheLoaded();
        return;
      }

      channel.log('background', 'Starting index.build()...');
      await index.build(projectDir, (done, total) => {
        report(progressBar(done, total));
      }, { depDirs });

      channel.log('background', 'Semantic indexing complete');
    };
  }

  startSemanticIndexing(projectDir, llmProvider) {
    channel.log('background', `startSemanticIndexing called — projectDir: ${projectDir}`);
    // Store params so restartSemanticIndexing can reuse them
    this._lastIndexProjectDir = projectDir;
    this._lastIndexLlmProvider = llmProvider;
    return this.run('semantic-index', this._indexingFn(projectDir, llmProvider));
  }

  /**
   * Re-trigger semantic indexing (e.g. after a new dependency is added).
   * Waits for any in-progress indexing to finish, then re-runs.
   */
  restartSemanticIndexing() {
    if (!this._lastIndexProjectDir || !this._lastIndexLlmProvider) return;
    channel.log('background', 'restartSemanticIndexing — new dependency added, re-indexing');
    return this.rerun('semantic-index', this._indexingFn(this._lastIndexProjectDir, this._lastIndexLlmProvider));
  }
}

export const backgroundTaskManager = new BackgroundTaskManager();
