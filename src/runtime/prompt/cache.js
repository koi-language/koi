/**
 * Slot-level cache for the Context Compiler.
 *
 * Cache key = (agent, slot_id, query_hash, vault_version).
 * Cache invalidation: vault_version is the most recent mtime of any
 *   tracked input (vault notes/, event log file). When inputs change, the
 *   key changes and lookups miss naturally.
 *
 * Storage is process-local in-memory (Map). Memory cap: keep last N entries
 * via simple LRU.
 */

import { createHash } from 'node:crypto';

const MAX_ENTRIES = 256;
const _cache = new Map(); // insertion order = LRU order
let _hits = 0;
let _misses = 0;

export function _resetForTests() {
  _cache.clear();
  _hits = 0;
  _misses = 0;
}

export function getStats() {
  return { hits: _hits, misses: _misses, size: _cache.size };
}

/**
 * Build a stable cache key from (agent, slot, query, vaultVersion).
 */
export function makeKey(agent, slotId, queryHash, vaultVersion) {
  return `${agent}::${slotId}::${queryHash}::${vaultVersion}`;
}

/** Get cached value. Updates LRU order on hit. */
export function get(key) {
  if (!_cache.has(key)) { _misses += 1; return undefined; }
  const v = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, v);
  _hits += 1;
  return v;
}

/** Set a cached value. Evicts oldest if over MAX_ENTRIES. */
export function set(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, value);
  if (_cache.size > MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/** Hash a deterministic representation of an object — for query identity. */
export function hashObject(obj) {
  if (obj === undefined || obj === null) return '_';
  const json = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha1').update(json).digest('hex').slice(0, 12);
}
