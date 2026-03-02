/**
 * Persistent Cache Manager
 *
 * Manages a persistent cache directory for build-time optimizations.
 * Uses SHA-256 hashing to detect source file changes and avoid
 * regenerating expensive computations (embeddings, etc.)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class CacheManager {
  constructor(config = {}) {
    // Cache directory relative to project root
    this.cacheDir = config.cacheDir || path.join(process.cwd(), '.koi', 'cache');
    this.verbose = config.verbose || false;
    // Runtime fingerprint: invalidates cache when runtime code changes
    // (e.g. build-optimizer adds new compose actions, agent.js changes APIs)
    this._runtimeFingerprint = null;

    // Ensure cache directory exists
    this.ensureCacheDir();
  }

  /**
   * Ensure cache directory exists
   */
  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      if (this.verbose) {
        console.log(`[Cache] Created cache directory: ${this.cacheDir}`);
      }
    }
  }

  /**
   * Compute SHA-256 hash of file content + runtime fingerprint.
   * The runtime fingerprint ensures the cache is invalidated when
   * runtime code changes (e.g. build-optimizer.js adds new compose
   * actions, agent.js changes APIs). Without this, changing the runtime
   * but not the .koi file would serve stale compiled code.
   */
  hashContent(content) {
    const fingerprint = this._getRuntimeFingerprint();
    return crypto.createHash('sha256').update(content + fingerprint).digest('hex');
  }

  /**
   * Get the runtime fingerprint (cached per instance).
   * Hashes the content of key runtime files that affect code generation.
   * If any of these files change, ALL caches are invalidated.
   */
  _getRuntimeFingerprint() {
    if (this._runtimeFingerprint) return this._runtimeFingerprint;

    // Files whose content affects the generated compose resolvers and affordances.
    // When any of these changes, cached compile output must be regenerated.
    const runtimeFiles = [
      path.join(__dirname, 'build-optimizer.js'),
      path.join(__dirname, 'transpiler.js'),
    ];

    const hash = crypto.createHash('sha256');
    for (const filePath of runtimeFiles) {
      try {
        hash.update(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        // File not found (e.g. in binary build) — use a constant
        hash.update(`missing:${filePath}`);
      }
    }
    this._runtimeFingerprint = hash.digest('hex');
    return this._runtimeFingerprint;
  }

  /**
   * Get cache file path for a source file
   */
  getCachePath(sourceHash) {
    return path.join(this.cacheDir, `affordances-${sourceHash}.json`);
  }

  /**
   * Get metadata file path
   */
  getMetadataPath() {
    return path.join(this.cacheDir, 'cache-metadata.json');
  }

  /**
   * Load cache metadata (tracks all cached files)
   */
  loadMetadata() {
    const metaPath = this.getMetadataPath();

    if (!fs.existsSync(metaPath)) {
      return {
        version: '1.0.0',
        files: {}
      };
    }

    try {
      const content = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.warn(`[Cache] Failed to load metadata: ${error.message}`);
      return {
        version: '1.0.0',
        files: {}
      };
    }
  }

  /**
   * Save cache metadata
   */
  saveMetadata(metadata) {
    const metaPath = this.getMetadataPath();

    try {
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      console.warn(`[Cache] Failed to save metadata: ${error.message}`);
    }
  }

  /**
   * Check if cache exists for source content
   */
  has(sourceContent) {
    const hash = this.hashContent(sourceContent);
    const cachePath = this.getCachePath(hash);
    return fs.existsSync(cachePath);
  }

  /**
   * Get cached data for source content
   */
  get(sourceContent, sourcePath = null) {
    const hash = this.hashContent(sourceContent);
    const cachePath = this.getCachePath(hash);

    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(cachePath, 'utf-8');
      const cached = JSON.parse(content);

      if (this.verbose) {
        console.log(`[Cache] ✓ Cache hit for ${sourcePath || 'source'} (hash: ${hash.substring(0, 8)}...)`);
        console.log(`[Cache]   Cached: ${cached.metadata.totalAffordances} affordances from ${new Date(cached.metadata.generatedAt).toLocaleString()}`);
      }

      return cached;
    } catch (error) {
      console.warn(`[Cache] Failed to read cache: ${error.message}`);
      return null;
    }
  }

  /**
   * Store data in cache
   */
  set(sourceContent, sourcePath, data) {
    const hash = this.hashContent(sourceContent);
    const cachePath = this.getCachePath(hash);

    // Add cache metadata
    const cacheEntry = {
      ...data,
      cacheMetadata: {
        sourceHash: hash,
        sourcePath: sourcePath,
        cachedAt: Date.now()
      }
    };

    try {
      fs.writeFileSync(cachePath, JSON.stringify(cacheEntry, null, 2));

      if (this.verbose) {
        console.log(`[Cache] ✓ Cached ${data.metadata.totalAffordances} affordances to ${path.basename(cachePath)}`);
      }

      // Update metadata index
      const metadata = this.loadMetadata();
      metadata.files[sourcePath] = {
        hash: hash,
        lastCached: Date.now(),
        affordanceCount: data.metadata.totalAffordances
      };
      this.saveMetadata(metadata);

      return true;
    } catch (error) {
      console.warn(`[Cache] Failed to write cache: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear cache for a specific file or all cache
   */
  clear(sourcePath = null) {
    if (!sourcePath) {
      // Clear all cache
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        files.forEach(file => {
          const filePath = path.join(this.cacheDir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true });
          } else {
            fs.unlinkSync(filePath);
          }
        });
        console.log(`[Cache] Cleared all cache (${files.length} files)`);
      }
      return;
    }

    // Clear cache for specific file
    const metadata = this.loadMetadata();
    const fileInfo = metadata.files[sourcePath];

    if (fileInfo) {
      const cachePath = this.getCachePath(fileInfo.hash);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
        delete metadata.files[sourcePath];
        this.saveMetadata(metadata);
        console.log(`[Cache] Cleared cache for ${sourcePath}`);
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const metadata = this.loadMetadata();
    const files = Object.keys(metadata.files).length;

    let totalSize = 0;
    let totalAffordances = 0;

    if (fs.existsSync(this.cacheDir)) {
      const cacheFiles = fs.readdirSync(this.cacheDir);
      cacheFiles.forEach(file => {
        const filePath = path.join(this.cacheDir, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      });
    }

    Object.values(metadata.files).forEach(info => {
      totalAffordances += info.affordanceCount || 0;
    });

    return {
      cacheDir: this.cacheDir,
      files: files,
      totalAffordances: totalAffordances,
      totalSize: totalSize,
      totalSizeFormatted: this.formatBytes(totalSize)
    };
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Print cache summary
   */
  printStats() {
    const stats = this.getStats();

    console.log(`\n📊 Cache Statistics:`);
    console.log(`   Location: ${stats.cacheDir}`);
    console.log(`   Cached files: ${stats.files}`);
    console.log(`   Total affordances: ${stats.totalAffordances}`);
    console.log(`   Cache size: ${stats.totalSizeFormatted}`);

    if (stats.files > 0) {
      const metadata = this.loadMetadata();
      console.log(`\n   Recent files:`);
      const sorted = Object.entries(metadata.files)
        .sort((a, b) => b[1].lastCached - a[1].lastCached)
        .slice(0, 5);

      sorted.forEach(([filepath, info]) => {
        const time = new Date(info.lastCached).toLocaleString();
        console.log(`   • ${path.basename(filepath)} (${info.affordanceCount} affordances, ${time})`);
      });
    }
    console.log('');
  }
}
