/**
 * Attachment Registry — Maps attachment IDs to file paths.
 *
 * When a user attaches files (images, documents) to a message, they are
 * registered here with a unique ID. This ID is stored in message metadata
 * so any component (LLM provider, image generator, etc.) can resolve the
 * file path and attach it via the provider's native file API.
 *
 * Usage:
 *   attachmentRegistry.register('/path/to/image.png') → 'att-1'
 *   attachmentRegistry.resolve('att-1') → '/path/to/image.png'
 *   attachmentRegistry.resolveAll(['att-1', 'att-2']) → ['/path/to/image.png', ...]
 */

import fs from 'fs';
import path from 'path';

class AttachmentRegistry {
  constructor() {
    this._map = new Map();   // id → { path, mimeType, registeredAt }
    this._counter = 0;
  }

  /**
   * Register a file and return its attachment ID.
   * If the file is already registered, returns the existing ID.
   */
  /**
   * Register a file and return its attachment ID.
   * If the file is already registered, returns the existing ID.
   * @param {string} filePath
   * @param {Object} [meta] - Optional metadata (e.g. { role: 'annotation' })
   */
  register(filePath, meta = {}) {
    const resolved = path.resolve(filePath);

    // Check if already registered
    for (const [id, entry] of this._map) {
      if (entry.path === resolved) return id;
    }

    const id = `att-${++this._counter}`;
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
      '.txt': 'text/plain', '.md': 'text/markdown',
      '.json': 'application/json', '.csv': 'text/csv',
      '.js': 'text/javascript', '.ts': 'text/typescript',
      '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    const fileName = path.basename(resolved);

    // Auto-detect annotation role from filename
    const role = meta.role || (fileName.startsWith('braxil-annotation-') ? 'annotation' : null);

    this._map.set(id, {
      path: resolved,
      mimeType,
      fileName,
      role,
      registeredAt: Date.now(),
    });

    return id;
  }

  /**
   * Resolve an attachment ID to its file path.
   * Returns null if not found.
   */
  resolve(id) {
    const entry = this._map.get(id);
    return entry?.path ?? null;
  }

  /**
   * Get full entry (path, mimeType, fileName) for an attachment ID.
   */
  get(id) {
    return this._map.get(id) ?? null;
  }

  /**
   * Resolve multiple attachment IDs.
   */
  resolveAll(ids) {
    return ids.map(id => this.resolve(id)).filter(Boolean);
  }

  /**
   * Get all entries for multiple IDs.
   */
  getAll(ids) {
    return ids.map(id => this.get(id)).filter(Boolean);
  }

  /**
   * Check if a path is an image.
   */
  isImage(id) {
    const entry = this._map.get(id);
    return entry?.mimeType?.startsWith('image/') ?? false;
  }

  /**
   * Get all registered attachments.
   */
  all() {
    return [...this._map.entries()].map(([id, entry]) => ({ id, ...entry }));
  }

  /**
   * Clear all attachments.
   */
  clear() {
    this._map.clear();
    this._counter = 0;
  }
}

// Singleton
const _instance = globalThis.__koiAttachmentRegistry || new AttachmentRegistry();
if (!globalThis.__koiAttachmentRegistry) globalThis.__koiAttachmentRegistry = _instance;

export const attachmentRegistry = _instance;
export default attachmentRegistry;
