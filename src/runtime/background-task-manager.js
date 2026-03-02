/**
 * Background Task Manager - Runs async tasks without blocking the agent loop.
 *
 * Zero knowledge of Ink/React — communicates status via cliLogger.setTaskStatus().
 * Tasks are deduplicated by name. Status auto-clears after completion.
 */

import path from 'path';
import { cliLogger } from './cli-logger.js';

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
   * Combine all running task statuses into one string and push to cliLogger.
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
    cliLogger.setTaskStatus(parts.length > 0 ? parts.join(' | ') : '');
  }

  /**
   * Helper: start semantic code indexing using SemanticIndex + LanceDB.
   * @param {string} projectDir - Project root directory
   * @param {import('./llm-provider.js').LLMProvider} llmProvider
   */
  startSemanticIndexing(projectDir, llmProvider) {
    return this.run('semantic-index', async (report) => {
      const { getSemanticIndex } = await import('./semantic-index.js');
      const cacheDir = path.join(projectDir, '.koi', 'cache', 'semantic-index');
      const index = getSemanticIndex(cacheDir, llmProvider);

      if (await index.isUpToDate(projectDir)) {
        cliLogger.log('background', 'Semantic index up-to-date');
        // Pre-load cache so searches never need to touch LanceDB
        await index.ensureCacheLoaded();
        return;
      }

      await index.build(projectDir, (done, total) => {
        const pct = Math.round((done / total) * 100);
        report(`indexing ${pct}%`);
      });

      cliLogger.log('background', 'Semantic indexing complete');
    });
  }
}

export const backgroundTaskManager = new BackgroundTaskManager();
