/**
 * Session Knowledge Store — shared in-memory fact store for the current process.
 *
 * When one agent discovers something (tech stack, file paths, service URLs,
 * required env vars, config constraints…), it calls sessionKnowledge.learn()
 * and every subsequently-started agent gets that fact injected into its context
 * automatically — no re-discovery needed.
 *
 * Facts are EPHEMERAL: they exist only for the lifetime of the current process.
 * For persistent cross-session memory use context-memory.js instead.
 *
 * Usage:
 *   sessionKnowledge.learn('frontend_stack', 'React 18 + Vite + TS', { category: 'tech_stack', agentName: 'Planner' })
 *   sessionKnowledge.format()   → markdown block or null
 *   sessionKnowledge.recall('path') → filtered array
 */

import { EventEmitter } from 'events';

const VALID_CATEGORIES = new Set([
  'tech_stack',   // language, framework, version
  'path',         // file/directory locations
  'config',       // config values, ports, feature flags
  'credential',   // env var names (never values) for secrets
  'status',       // service URLs, cluster names, deployment outputs
  'dependency',   // inter-service dependencies, required env vars
]);

const MAX_VALUE_LEN = 300;

class SessionKnowledge extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {key, value, category, agentName, ts}>} */
    this._facts = new Map();
  }

  /**
   * Store a discovered fact. Overwrites if key already exists.
   * @param {string} key - Unique snake_case identifier
   * @param {string} value - Concise fact (max 300 chars, no code/file contents)
   * @param {{ category?: string, agentName?: string }} opts
   */
  learn(key, value, { category = 'config', agentName = 'unknown' } = {}) {
    if (!key || value === undefined || value === null) return;
    // Reject facts without a valid category — no catch-all "other" bucket
    if (!VALID_CATEGORIES.has(category)) return;
    const entry = {
      key: String(key),
      value: String(value).slice(0, MAX_VALUE_LEN),
      category,
      agentName: String(agentName),
      ts: Date.now(),
    };
    const isUpdate = this._facts.has(key);
    this._facts.set(key, entry);
    this.emit('learn', { ...entry, isUpdate });
  }

  /**
   * Retrieve facts, optionally filtered by category.
   * @param {string|null} category
   * @returns {Array<{key, value, category, agentName, ts}>}
   */
  recall(category = null) {
    const all = [...this._facts.values()];
    return category ? all.filter(f => f.category === category) : all;
  }

  /**
   * Format all facts as a compact markdown block for injection into agent context.
   * Returns null when the store is empty.
   * @returns {string|null}
   */
  format() {
    const facts = [...this._facts.values()];
    if (facts.length === 0) return null;
    const lines = facts.map(f =>
      `- [${f.category}] **${f.key}**: ${f.value}  _(learned by ${f.agentName})_`
    );
    return `## Shared session knowledge\n_Facts discovered during this session — use them, don't rediscover them._\n\n${lines.join('\n')}`;
  }

  get size() {
    return this._facts.size;
  }

  /** Remove all facts (e.g. on session reset). */
  clear() {
    this._facts.clear();
    this.emit('clear');
  }

  /** Serialize all facts to a plain array for disk persistence. */
  serialize() {
    return [...this._facts.values()];
  }

  /** Restore facts from a serialized array (e.g. on session resume).
   *  Filters out facts with invalid categories (legacy "other" entries). */
  restore(data) {
    if (!Array.isArray(data)) return;
    for (const entry of data) {
      if (entry && entry.key && entry.value !== undefined && VALID_CATEGORIES.has(entry.category)) {
        this._facts.set(entry.key, entry);
      }
    }
  }
}

// Module-level singleton — shared across all imports in the same process.
export const sessionKnowledge = new SessionKnowledge();

/**
 * Plan Knowledge Store — ephemeral shared facts scoped to the current plan.
 *
 * When a developer implements a task, it stores implementation details here:
 * file paths created, patterns used, integration points, etc. Sibling tasks
 * pick these up via recall so they don't re-explore the same codebase.
 *
 * Cleared automatically when all tasks in the plan are completed. This is
 * the "working memory" of a plan, not durable project knowledge.
 *
 * Uses the same SessionKnowledge class but is a SEPARATE instance so the
 * two stores have independent lifecycles.
 */
export const planKnowledge = new SessionKnowledge();
