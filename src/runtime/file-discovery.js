/**
 * File Discovery - Shared file discovery logic for search and indexing.
 *
 * Walks the project directory tree, skipping common non-source directories,
 * and returns source files filtered by extension.
 */

import fs from 'fs';
import path from 'path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.build', '.koi', '.koi-cache',
  'dist', 'build', 'coverage', '__pycache__', '.next', '.nuxt',
  'vendor', '.venv', 'venv', 'env'
]);

export const SOURCE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java', '.rs', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.md', '.txt',
  '.koi', '.sh', '.bash', '.zsh'
]);

export function discoverFiles(baseDir, maxFiles = 5000) {
  const files = [];
  function walk(dir, depth) {
    if (depth > 15 || files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) files.push(full);
      }
    }
  }
  walk(baseDir, 0);
  return files;
}
