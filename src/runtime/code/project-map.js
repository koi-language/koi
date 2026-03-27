/**
 * Project Map — Generates a summary of the workspace and its dependencies.
 *
 * Reads each dependency's package.json / README.md to build a human-readable
 * map that agents can use to understand the workspace layout.
 *
 * The map is cached per session and injected into agent system prompts so
 * every agent (System, Planner, Developers) knows where things are.
 *
 * Usage:
 *   const map = await getProjectMap(projectDir);
 *   // Returns a markdown string describing all projects
 */

import fs from 'fs';
import path from 'path';
import { detectLocalDependencies, listManualDependencies } from './local-dependency-detector.js';
import { channel } from '../io/channel.js';

let _cache = null;
let _cacheDir = null;

/**
 * Detect the tech stack / framework from a project directory.
 * Reads package.json, requirements.txt, etc. to identify the stack.
 */
function _detectStack(projectDir) {
  const parts = [];

  // Node.js
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Framework detection
      if (allDeps['next']) parts.push('Next.js');
      else if (allDeps['nuxt']) parts.push('Nuxt');
      else if (allDeps['@nestjs/core']) parts.push('NestJS');
      else if (allDeps['fastify']) parts.push('Fastify');
      else if (allDeps['express']) parts.push('Express');
      else if (allDeps['hono']) parts.push('Hono');
      else if (allDeps['koa']) parts.push('Koa');

      if (allDeps['react'] || allDeps['react-dom']) parts.push('React');
      if (allDeps['vue']) parts.push('Vue');
      if (allDeps['svelte']) parts.push('Svelte');
      if (allDeps['@angular/core']) parts.push('Angular');
      if (allDeps['vite']) parts.push('Vite');
      if (allDeps['esbuild']) parts.push('esbuild');
      if (allDeps['typescript']) parts.push('TypeScript');
      if (allDeps['drizzle-orm']) parts.push('Drizzle ORM');
      if (allDeps['prisma'] || allDeps['@prisma/client']) parts.push('Prisma');
      if (allDeps['stripe']) parts.push('Stripe');
      if (allDeps['ink']) parts.push('Ink (terminal UI)');

      if (parts.length === 0) parts.push('Node.js');

      // Description from package.json
      if (pkg.description) return { stack: parts.join(', '), description: pkg.description };
    } catch { /* non-fatal */ }
  }

  // Python
  if (fs.existsSync(path.join(projectDir, 'requirements.txt')) ||
      fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
    parts.push('Python');
  }

  // Go
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) parts.push('Go');

  // Rust
  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) parts.push('Rust');

  // Java
  if (fs.existsSync(path.join(projectDir, 'pom.xml'))) parts.push('Java/Maven');
  if (fs.existsSync(path.join(projectDir, 'build.gradle'))) parts.push('Java/Gradle');

  return { stack: parts.join(', ') || 'unknown', description: null };
}

/**
 * Extract a one-line description from README.md if available.
 */
function _getReadmeDescription(projectDir) {
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const fp = path.join(projectDir, name);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf8');
      // Find first non-heading, non-empty line
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('[')) continue;
        if (trimmed.length > 10) return trimmed.substring(0, 150);
      }
    } catch { /* non-fatal */ }
  }
  return null;
}

/**
 * Build the project map for the current workspace.
 * Returns a markdown string describing all projects and their relationships.
 */
export async function getProjectMap(projectDir) {
  if (_cache && _cacheDir === projectDir) return _cache;

  const projectName = path.basename(projectDir);
  // Merge auto-detected + manually registered dependencies, deduplicate by path
  // Auto deps are string paths, manual deps are objects with { path, name }
  const autoDeps = detectLocalDependencies(projectDir).map(p =>
    typeof p === 'string' ? { path: p, name: path.basename(p) } : p
  );
  const manualDeps = listManualDependencies(projectDir);
  const seen = new Set();
  const deps = [];
  for (const d of [...autoDeps, ...manualDeps]) {
    const resolved = path.resolve(d.path);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      deps.push(d);
    }
  }

  const lines = ['## Workspace Projects\n'];

  // Main project
  const mainInfo = _detectStack(projectDir);
  const mainDesc = mainInfo.description || _getReadmeDescription(projectDir) || '';
  lines.push(`- **${projectName}** (this project): ${mainInfo.stack}${mainDesc ? ' — ' + mainDesc : ''}`);

  // Dependencies
  for (const dep of deps) {
    if (!fs.existsSync(dep.path)) continue;
    // Skip node_modules subdirs, parent dirs, and duplicates of the main project
    const resolved = path.resolve(dep.path);
    if (resolved.includes('node_modules')) continue;
    if (resolved === path.resolve(projectDir)) continue;
    const depName = dep.name || path.basename(dep.path);
    // Skip if same name as main project (likely a duplicate)
    if (depName === projectName) continue;
    const relPath = path.relative(projectDir, dep.path);
    if (!relPath || relPath === '.') continue;
    const info = _detectStack(dep.path);
    if (info.stack === 'unknown') continue;
    const desc = info.description || _getReadmeDescription(dep.path) || '';
    lines.push(`- **${depName}** (${relPath}): ${info.stack}${desc ? ' — ' + desc : ''}`);
  }

  const map = lines.join('\n');
  _cache = map;
  _cacheDir = projectDir;

  channel.log('project-map', `Generated project map: ${deps.length} dependencies`);
  return map;
}

/**
 * Reset the cache (e.g. when dependencies change).
 */
export function resetProjectMapCache() {
  _cache = null;
  _cacheDir = null;
}
