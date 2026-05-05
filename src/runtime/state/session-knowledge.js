/**
 * Session Knowledge — DEPRECATED no-op shim.
 *
 * The ephemeral in-memory fact store was replaced by the persistent Ori vault
 * (see `src/runtime/memory/`). All real reads/writes now go through
 * `memory.write()` / `memory.list()`. The `learn_fact` and `recall_facts`
 * tool actions already route to the new system.
 *
 * This file remains only so existing imports compile. Every method on the
 * exported singletons is a no-op or returns sensible empty values.
 */

import { EventEmitter } from 'events';

class _NoopKnowledge extends EventEmitter {
  constructor() { super(); this.size = 0; this._restored = false; }
  /** @returns {void} */
  learn(_key, _value, _opts) { /* no-op — see tools/knowledge/learn-fact.js */ }
  /** @returns {Array} */
  recall(_categoryFilter) { return []; }
  /** @returns {string|null} */
  format() { return null; }
  /** @returns {Array} */
  serialize() { return []; }
  /** @returns {void} */
  restore(_data) { /* no-op — Ori vault is the persistent store */ }
  /** @returns {void} */
  clear() { /* no-op */ }
}

export const sessionKnowledge = new _NoopKnowledge();
export const planKnowledge = new _NoopKnowledge();
