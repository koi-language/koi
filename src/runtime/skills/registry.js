/**
 * Registry - Shared data store for agent collaboration
 *
 * Provides a simple, transparent API for agents to share information.
 * Backend is configurable (local file, Redis, MongoDB, etc.)
 *
 * Usage from agents:
 *   await registry.set('user:123', { name: 'Alice', age: 30 })
 *   const user = await registry.get('user:123')
 *   const users = await registry.search({ age: { $gte: 25 } })
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Registry {
  constructor(config = {}) {
    this.backend = null;
    this.config = config;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    // Load configuration from .koi-config.json if exists
    const configPath = path.join(process.cwd(), '.koi-config.json');
    let fileConfig = {};

    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        fileConfig = JSON.parse(content);
      } catch (error) {
        console.warn(`[Registry] Failed to load .koi-config.json: ${error.message}`);
      }
    }

    // Merge configs: constructor config > file config > defaults
    const mergedConfig = {
      backend: 'local',
      options: {},
      ...fileConfig.registry,
      ...this.config
    };

    // Load backend
    const backendName = mergedConfig.backend;
    try {
      const backendModule = await import(`./registry-backends/${backendName}.js`);
      this.backend = new backendModule.default(mergedConfig.options);
      await this.backend.init();
      this.initialized = true;
    } catch (error) {
      console.error(`[Registry] Failed to load backend '${backendName}': ${error.message}`);
      throw error;
    }
  }

  async ensureInit() {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * Get a value by key
   * @param {string} key - The key to retrieve
   * @returns {Promise<any>} The stored value or null if not found
   */
  async get(key) {
    await this.ensureInit();
    return await this.backend.get(key);
  }

  /**
   * Set a value by key
   * @param {string} key - The key to store
   * @param {any} value - The value to store (will be JSON serialized)
   * @returns {Promise<void>}
   */
  async set(key, value) {
    await this.ensureInit();
    return await this.backend.set(key, value);
  }

  /**
   * Delete a value by key
   * @param {string} key - The key to delete
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async delete(key) {
    await this.ensureInit();
    return await this.backend.delete(key);
  }

  /**
   * Check if a key exists
   * @param {string} key - The key to check
   * @returns {Promise<boolean>}
   */
  async has(key) {
    await this.ensureInit();
    return await this.backend.has(key);
  }

  /**
   * List all keys matching a prefix
   * @param {string} prefix - The prefix to match (e.g., 'user:')
   * @returns {Promise<string[]>} Array of matching keys
   */
  async keys(prefix = '') {
    await this.ensureInit();
    return await this.backend.keys(prefix);
  }

  /**
   * Search for entries matching a query
   * @param {object} query - Query object (syntax depends on backend)
   * @returns {Promise<object[]>} Array of matching {key, value} objects
   */
  async search(query) {
    await this.ensureInit();
    return await this.backend.search(query);
  }

  /**
   * Clear all data (use with caution!)
   * @returns {Promise<void>}
   */
  async clear() {
    await this.ensureInit();
    return await this.backend.clear();
  }

  /**
   * Get statistics about the registry
   * @returns {Promise<object>} Stats object with count, size, etc.
   */
  async stats() {
    await this.ensureInit();
    return await this.backend.stats();
  }
}

// Singleton instance
let registryInstance = null;

export function getRegistry(config = {}) {
  if (!registryInstance) {
    registryInstance = new Registry(config);
  }
  return registryInstance;
}

export const registry = getRegistry();

export default Registry;
