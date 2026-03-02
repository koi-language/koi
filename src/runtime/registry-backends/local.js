/**
 * Local File Backend for Registry
 *
 * Stores data in a JSON file with in-memory cache for performance.
 * Simple, no dependencies, perfect for development and single-machine deployments.
 */

import fs from 'fs';
import path from 'path';

export default class LocalBackend {
  constructor(options = {}) {
    this.dataDir = options.path || '.koi/registry';
    this.dataFile = path.join(this.dataDir, 'data.json');
    this.cache = new Map();
    this.dirty = false;
    this.autoSaveInterval = options.autoSaveInterval || 5000; // 5 seconds
    this.autoSaveTimer = null;
  }

  async init() {
    // Ensure directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Load existing data
    if (fs.existsSync(this.dataFile)) {
      try {
        const content = fs.readFileSync(this.dataFile, 'utf-8');
        const data = JSON.parse(content);

        // Load into cache
        for (const [key, value] of Object.entries(data)) {
          this.cache.set(key, value);
        }
      } catch (error) {
        console.warn(`[Registry:Local] Failed to load data file: ${error.message}`);
      }
    }

    // Start auto-save timer
    this.startAutoSave();
  }

  startAutoSave() {
    if (this.autoSaveTimer) return;

    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) {
        this.persist().catch(err => {
          console.error(`[Registry:Local] Auto-save failed: ${err.message}`);
        });
      }
    }, this.autoSaveInterval);

    // Don't keep process alive
    if (this.autoSaveTimer.unref) {
      this.autoSaveTimer.unref();
    }
  }

  stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  async persist() {
    if (!this.dirty) return;

    try {
      // Convert Map to plain object
      const data = {};
      for (const [key, value] of this.cache.entries()) {
        data[key] = value;
      }

      // Write to file
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (error) {
      console.error(`[Registry:Local] Failed to persist: ${error.message}`);
      throw error;
    }
  }

  async get(key) {
    return this.cache.get(key) || null;
  }

  async set(key, value) {
    this.cache.set(key, value);
    this.dirty = true;

    // Immediate persist for important operations
    // (optional: could debounce this)
    await this.persist();
  }

  async delete(key) {
    const existed = this.cache.has(key);
    this.cache.delete(key);

    if (existed) {
      this.dirty = true;
      await this.persist();
    }

    return existed;
  }

  async has(key) {
    return this.cache.has(key);
  }

  async keys(prefix = '') {
    const allKeys = Array.from(this.cache.keys());

    if (!prefix) {
      return allKeys;
    }

    return allKeys.filter(key => key.startsWith(prefix));
  }

  async search(query) {
    // Simple search implementation for local backend
    // Supports basic query patterns:
    // - { field: value } - exact match
    // - { field: { $eq: value } } - exact match
    // - { field: { $ne: value } } - not equal
    // - { field: { $gt: value } } - greater than
    // - { field: { $gte: value } } - greater than or equal
    // - { field: { $lt: value } } - less than
    // - { field: { $lte: value } } - less than or equal
    // - { field: { $in: [values] } } - in array
    // - { field: { $regex: pattern } } - regex match

    const results = [];

    for (const [key, value] of this.cache.entries()) {
      if (this.matchesQuery(value, query)) {
        results.push({ key, value });
      }
    }

    return results;
  }

  matchesQuery(obj, query) {
    // Handle null/undefined
    if (obj === null || obj === undefined) {
      return false;
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
            console.warn(`[Registry:Local] Unknown operator: ${operator}`);
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
    this.cache.clear();
    this.dirty = true;
    await this.persist();
  }

  async stats() {
    return {
      backend: 'local',
      count: this.cache.size,
      file: this.dataFile,
      size: fs.existsSync(this.dataFile)
        ? fs.statSync(this.dataFile).size
        : 0
    };
  }

  // Cleanup on exit
  async close() {
    this.stopAutoSave();
    if (this.dirty) {
      await this.persist();
    }
  }
}
