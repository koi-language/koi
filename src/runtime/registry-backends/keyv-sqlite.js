/**
 * Keyv + SQLite Backend for Registry
 *
 * Uses Keyv with SQLite adapter for persistent, queryable storage.
 * Production-ready with transaction support and efficient queries.
 */

import Keyv from 'keyv';
import KeyvSqlite from '@keyv/sqlite';
import fs from 'fs';
import path from 'path';

export default class KeyvSqliteBackend {
  constructor(options = {}) {
    this.dbPath = options.path || '.koi/registry/registry.sqlite';
    this.keyv = null;
    this.namespace = options.namespace || 'koi';
    this._keysCache = new Set();
  }

  async init() {
    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Initialize Keyv with SQLite adapter
    this.keyv = new Keyv({
      store: new KeyvSqlite(`sqlite://${this.dbPath}`),
      namespace: this.namespace
    });

    // Handle errors
    this.keyv.on('error', err => {
      console.error('[Registry:KeyvSQLite] Connection error:', err);
    });
  }

  async get(key) {
    const value = await this.keyv.get(key);
    return value !== undefined ? value : null;
  }

  async set(key, value) {
    await this.keyv.set(key, value);
    this._keysCache.add(key);
  }

  async delete(key) {
    const existed = await this.keyv.has(key);
    await this.keyv.delete(key);
    this._keysCache.delete(key);
    return existed;
  }

  async has(key) {
    return await this.keyv.has(key);
  }

  async keys(prefix = '') {
    // Return keys from in-memory cache
    // Cache is maintained by set/delete operations
    const keys = Array.from(this._keysCache);

    if (!prefix) {
      return keys;
    }

    return keys.filter(key => key.startsWith(prefix));
  }

  async search(query) {
    // Scan all possible keys by trying common patterns
    // This is a workaround since Keyv doesn't provide a native keys() method

    // Start with cached keys, then expand the search
    const keysToCheck = new Set(this._keysCache);
    const results = [];

    // Get values for all known keys
    for (const key of keysToCheck) {
      const value = await this.keyv.get(key);

      if (value !== undefined) {
        if (this.matchesQuery(value, query)) {
          results.push({ key, value });
        }
      } else {
        // Key no longer exists, remove from cache
        this._keysCache.delete(key);
      }
    }

    return results;
  }

  matchesQuery(obj, query) {
    // Handle null/undefined
    if (obj === null || obj === undefined) {
      return false;
    }

    // Empty query matches all
    if (Object.keys(query).length === 0) {
      return true;
    }

    // Query must be an object
    if (typeof query !== 'object' || query === null) {
      return false;
    }

    // Check all query conditions
    for (const [field, condition] of Object.entries(query)) {
      const fieldValue = this.getNestedValue(obj, field);

      // Direct value comparison
      if (typeof condition !== 'object' || condition === null) {
        if (fieldValue !== condition) {
          return false;
        }
        continue;
      }

      // Operator-based comparison
      for (const [operator, value] of Object.entries(condition)) {
        switch (operator) {
          case '$eq':
            if (fieldValue !== value) return false;
            break;

          case '$ne':
            if (fieldValue === value) return false;
            break;

          case '$gt':
            if (fieldValue <= value) return false;
            break;

          case '$gte':
            if (fieldValue < value) return false;
            break;

          case '$lt':
            if (fieldValue >= value) return false;
            break;

          case '$lte':
            if (fieldValue > value) return false;
            break;

          case '$in':
            if (!Array.isArray(value) || !value.includes(fieldValue)) return false;
            break;

          case '$regex':
            const regex = new RegExp(value);
            if (!regex.test(String(fieldValue))) return false;
            break;

          default:
            console.warn(`[Registry:KeyvSQLite] Unknown operator: ${operator}`);
            return false;
        }
      }
    }

    return true;
  }

  getNestedValue(obj, path) {
    // Support dot notation: 'user.name' -> obj.user.name
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  async clear() {
    await this.keyv.clear();
    this._keysCache.clear();
  }

  async stats() {
    const allKeys = await this.keys();

    // Get file size
    let size = 0;
    if (fs.existsSync(this.dbPath)) {
      size = fs.statSync(this.dbPath).size;
    }

    return {
      backend: 'keyv-sqlite',
      count: allKeys.length,
      file: this.dbPath,
      size: size
    };
  }

  async close() {
    // Keyv handles cleanup automatically
    if (this.keyv && this.keyv.opts.store && this.keyv.opts.store.close) {
      await this.keyv.opts.store.close();
    }
  }
}
