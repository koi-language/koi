/**
 * Background Task Manager - Runs async tasks without blocking the agent loop.
 *
 * Zero knowledge of Ink/React — communicates status via cliLogger.setTaskStatus().
 * Tasks are deduplicated by name. Status auto-clears after completion.
 */

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
   * Helper: start project indexing using VectorStore.
   * @param {string} projectDir - Project root directory
   * @param {Function} embedFn - async (text) => number[] embedding function
   */
  startProjectIndexing(projectDir, embedFn) {
    return this.run('indexing', async (report) => {
      const { discoverFiles } = await import('./file-discovery.js');
      const { getOrCreateVectorStore } = await import('./vector-store.js');

      const files = discoverFiles(projectDir);
      if (files.length === 0) return;

      const store = getOrCreateVectorStore(projectDir);
      if (store.built) return; // Already indexed in this process

      // Fast path: try loading everything from disk cache (no API calls)
      if (store.tryLoadFromCache(files, projectDir)) {
        cliLogger.log('background', `Project index loaded from cache: ${files.length} files`);
        return; // All files cached — no "indexing X/Y" shown
      }

      // Slow path: some files need (re-)embedding
      await store.build(files, projectDir, embedFn, (done, total) => {
        report(`indexing ${done}/${total}`);
      });

      cliLogger.log('background', `Project indexing complete: ${files.length} files`);
    });
  }
}

export const backgroundTaskManager = new BackgroundTaskManager();
