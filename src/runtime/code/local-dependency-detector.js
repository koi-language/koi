/**
 * Local Dependency Detector — Discovers sibling/local project dependencies.
 *
 * Scans project config files to find references to other local directories
 * (e.g. `file:../backend`, `../shared`, path references in tsconfig, etc.).
 *
 * Uses a registry of detector strategies — one per ecosystem. Each detector
 * reads config files and returns resolved absolute paths to local dependencies.
 * New ecosystems are added as data (one entry in DETECTORS), not as logic.
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../io/channel.js';

// ─── Detector Registry ──────────────────────────────────────────────────────
// Each detector: { files: string[], detect: (projectDir, fileContent, filePath) => string[] }
// `files` = config filenames to look for (relative to projectDir)
// `detect` returns an array of absolute directory paths that are local dependencies

const DETECTORS = [
  // ── Node.js / npm / yarn / pnpm ──────────────────────────────────────
  {
    name: 'npm-local-deps',
    files: ['package.json'],
    detect: (projectDir, content) => {
      try {
        const pkg = JSON.parse(content);
        const paths = [];
        for (const depMap of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
          if (!depMap) continue;
          for (const val of Object.values(depMap)) {
            // file:../path, link:../path
            const match = val.match(/^(?:file:|link:)(.+)/);
            if (match) paths.push(path.resolve(projectDir, match[1]));
          }
        }
        return paths;
      } catch { return []; }
    },
  },

  // ── node_modules symlinks (npm link, workspaces, pnpm) ─────────────────
  {
    name: 'node-modules-symlinks',
    files: ['node_modules'],
    detect: (projectDir) => {
      const nmDir = path.join(projectDir, 'node_modules');
      const paths = [];
      try {
        const entries = fs.readdirSync(nmDir, { withFileTypes: true });
        for (const entry of entries) {
          // Check top-level packages and scoped packages (@org/pkg)
          const full = path.join(nmDir, entry.name);
          if (entry.name.startsWith('@')) {
            // Scan inside scope dir
            try {
              const scoped = fs.readdirSync(full, { withFileTypes: true });
              for (const sub of scoped) {
                const subFull = path.join(full, sub.name);
                const target = _resolveSymlink(subFull, projectDir);
                if (target) paths.push(target);
              }
            } catch { /* ignore */ }
          } else {
            const target = _resolveSymlink(full, projectDir);
            if (target) paths.push(target);
          }
        }
      } catch { /* node_modules doesn't exist */ }
      return paths;
    },
  },

  // ── pnpm workspace ────────────────────────────────────────────────────
  {
    name: 'pnpm-workspace',
    files: ['pnpm-workspace.yaml'],
    detect: (projectDir, content) => {
      // Simple YAML parsing for `packages:` list — avoids adding a YAML dep
      const paths = [];
      const lines = content.split('\n');
      let inPackages = false;
      for (const line of lines) {
        if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
        if (inPackages && /^\s+-\s+['"]?(.+?)['"]?\s*$/.test(line)) {
          const pattern = RegExp.$1.replace(/\/\*$/, ''); // strip glob star
          const resolved = path.resolve(projectDir, pattern);
          if (fs.existsSync(resolved)) paths.push(resolved);
        } else if (inPackages && /^\S/.test(line)) {
          break; // new top-level key
        }
      }
      return paths;
    },
  },

  // ── TypeScript project references / path aliases ──────────────────────
  {
    name: 'tsconfig-references',
    files: ['tsconfig.json', 'tsconfig.base.json'],
    detect: (projectDir, content) => {
      try {
        // Strip comments (// and /* */) for JSON parsing
        const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const tsconfig = JSON.parse(cleaned);
        const paths = [];

        // Project references: { "path": "../shared" }
        // Only include references that point OUTSIDE the project directory
        // (sibling projects). References to files within the same project
        // (e.g. "./tsconfig.app.json") are internal configs, not dependencies.
        if (Array.isArray(tsconfig.references)) {
          for (const ref of tsconfig.references) {
            if (!ref.path) continue;
            const resolved = path.resolve(projectDir, ref.path);
            // Skip if it resolves to a file (not a directory) — internal tsconfig ref
            // Skip if it's inside the project directory — not an external dependency
            try {
              const stat = fs.statSync(resolved);
              if (!stat.isDirectory()) continue;
            } catch {
              // Path doesn't exist or is inaccessible — skip
              continue;
            }
            if (resolved.startsWith(projectDir + path.sep) || resolved === projectDir) continue;
            paths.push(resolved);
          }
        }

        // compilerOptions.paths: { "@shared/*": ["../shared/src/*"] }
        const cpPaths = tsconfig.compilerOptions?.paths;
        if (cpPaths) {
          for (const targets of Object.values(cpPaths)) {
            for (const target of targets) {
              const clean = target.replace(/\/\*$/, '');
              if (clean.startsWith('..')) {
                paths.push(path.resolve(projectDir, clean));
              }
            }
          }
        }

        return paths;
      } catch { return []; }
    },
  },

  // ── Go modules — local replace directives ─────────────────────────────
  {
    name: 'go-mod-replace',
    files: ['go.mod'],
    detect: (projectDir, content) => {
      const paths = [];
      // replace github.com/foo/bar => ../bar
      const replaceRegex = /^\s*replace\s+\S+\s+=>\s+(\.\S+)/gm;
      let m;
      while ((m = replaceRegex.exec(content))) {
        paths.push(path.resolve(projectDir, m[1]));
      }
      // Also inside replace ( ) blocks
      const blockRegex = /replace\s*\(([\s\S]*?)\)/g;
      while ((m = blockRegex.exec(content))) {
        const lineRegex = /\S+\s+=>\s+(\.\S+)/g;
        let lm;
        while ((lm = lineRegex.exec(m[1]))) {
          paths.push(path.resolve(projectDir, lm[1]));
        }
      }
      return paths;
    },
  },

  // ── Python — local path dependencies ──────────────────────────────────
  {
    name: 'python-local-deps',
    files: ['pyproject.toml', 'requirements.txt', 'setup.cfg'],
    detect: (projectDir, content, filePath) => {
      const paths = [];
      const fileName = path.basename(filePath);

      if (fileName === 'requirements.txt') {
        // -e ../path or -e file:../path
        for (const line of content.split('\n')) {
          const m = line.match(/^\s*-e\s+(?:file:)?(\.\S+)/);
          if (m) paths.push(path.resolve(projectDir, m[1]));
        }
      }

      if (fileName === 'pyproject.toml') {
        // path = "../shared" in [tool.poetry.dependencies.xxx] or similar
        const pathRegex = /path\s*=\s*["'](\.\.[^"']+)["']/g;
        let m;
        while ((m = pathRegex.exec(content))) {
          paths.push(path.resolve(projectDir, m[1]));
        }
      }

      if (fileName === 'setup.cfg') {
        // dependency_links or local file: references
        const pathRegex = /file:(\.\.[^\s]+)/g;
        let m;
        while ((m = pathRegex.exec(content))) {
          paths.push(path.resolve(projectDir, m[1]));
        }
      }

      return paths;
    },
  },

  // ── Java / Gradle — composite builds and included projects ────────────
  {
    name: 'gradle-composite',
    files: ['settings.gradle', 'settings.gradle.kts'],
    detect: (projectDir, content) => {
      const paths = [];
      // includeBuild("../shared") or includeBuild '../shared'
      const regex = /includeBuild\s*\(?['"](\.\.[^'"]+)['"]\)?/g;
      let m;
      while ((m = regex.exec(content))) {
        paths.push(path.resolve(projectDir, m[1]));
      }
      return paths;
    },
  },

  // ── Java / Maven — multi-module with relative paths ───────────────────
  {
    name: 'maven-modules',
    files: ['pom.xml'],
    detect: (projectDir, content) => {
      const paths = [];
      // <module>../sibling</module> (only relative paths outside project)
      const regex = /<module>\s*(\.\.[^<]+)\s*<\/module>/g;
      let m;
      while ((m = regex.exec(content))) {
        paths.push(path.resolve(projectDir, m[1]));
      }
      return paths;
    },
  },

  // ── Rust / Cargo — local path dependencies ────────────────────────────
  {
    name: 'cargo-local-deps',
    files: ['Cargo.toml'],
    detect: (projectDir, content) => {
      const paths = [];
      // path = "../shared-lib"
      const regex = /path\s*=\s*["'](\.\.[^"']+)["']/g;
      let m;
      while ((m = regex.exec(content))) {
        paths.push(path.resolve(projectDir, m[1]));
      }
      return paths;
    },
  },

  // ── .NET / C# — project references ────────────────────────────────────
  {
    name: 'dotnet-project-refs',
    files: ['*.csproj', '*.sln'],
    detect: (projectDir, content) => {
      const paths = [];
      // <ProjectReference Include="..\Shared\Shared.csproj" />
      const regex = /Include=["'](\.\.[^"']+)["']/g;
      let m;
      while ((m = regex.exec(content))) {
        const refPath = m[1].replace(/\\/g, '/');
        const dir = path.dirname(path.resolve(projectDir, refPath));
        paths.push(dir);
      }
      return paths;
    },
  },

  // ── Monorepo markers — lerna, nx ──────────────────────────────────────
  {
    name: 'monorepo-packages',
    files: ['lerna.json', 'nx.json'],
    detect: (projectDir, content, filePath) => {
      try {
        const config = JSON.parse(content);
        const paths = [];
        // Lerna: { "packages": ["packages/*", "libs/*"] }
        const patterns = config.packages || config.workspaces || [];
        for (const pattern of patterns) {
          const clean = pattern.replace(/\/\*$/, '');
          const resolved = path.resolve(projectDir, clean);
          if (fs.existsSync(resolved)) paths.push(resolved);
        }
        return paths;
      } catch { return []; }
    },
  },
];

// ─── Manual Dependencies (.koi/dependencies.json) ────────────────────────
// Agents can register dependencies discovered through user conversation.
// Format: { "dependencies": [ { "path": "/abs/path", "name": "backend", "reason": "user mentioned" } ] }

const DEPS_FILENAME = 'dependencies.json';

function _getDepsFilePath(projectDir) {
  return path.join(projectDir, '.koi', DEPS_FILENAME);
}

function _loadManualDependencies(projectDir) {
  try {
    const raw = fs.readFileSync(_getDepsFilePath(projectDir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.dependencies) ? data.dependencies : [];
  } catch { return []; }
}

function _saveManualDependencies(projectDir, deps) {
  const dir = path.join(projectDir, '.koi');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_getDepsFilePath(projectDir), JSON.stringify({ dependencies: deps }, null, 2));
}

/**
 * Add a manual dependency. Deduplicates by resolved path.
 * @param {string} projectDir
 * @param {string} depPath - Absolute or relative path to the dependency
 * @param {string} [name] - Display name (defaults to basename)
 * @param {string} [reason] - Why this is a dependency
 * @returns {{ added: boolean, path: string }}
 */
export function addManualDependency(projectDir, depPath, name, reason) {
  const resolved = path.resolve(projectDir, depPath);
  if (!fs.existsSync(resolved)) {
    return { added: false, path: resolved, error: `Directory does not exist: ${resolved}` };
  }
  const deps = _loadManualDependencies(projectDir);
  if (deps.some(d => path.resolve(projectDir, d.path) === resolved)) {
    return { added: false, path: resolved, error: 'Already registered as a dependency' };
  }
  deps.push({
    path: resolved,
    name: name || path.basename(resolved),
    reason: reason || 'added by agent',
    addedAt: new Date().toISOString(),
  });
  _saveManualDependencies(projectDir, deps);
  channel.log('dep-detector', `Manual dependency added: ${resolved} (${reason || 'no reason'})`);
  return { added: true, path: resolved };
}

/**
 * Remove a manual dependency by path.
 */
export function removeManualDependency(projectDir, depPath) {
  const resolved = path.resolve(projectDir, depPath);
  const deps = _loadManualDependencies(projectDir);
  const filtered = deps.filter(d => path.resolve(projectDir, d.path) !== resolved);
  if (filtered.length === deps.length) return { removed: false };
  _saveManualDependencies(projectDir, filtered);
  return { removed: true };
}

/**
 * List all manual dependencies.
 */
export function listManualDependencies(projectDir) {
  return _loadManualDependencies(projectDir);
}

/**
 * Seed .koi/dependencies.json with auto-detected dependencies.
 * Merges newly discovered deps into the existing file without duplicating.
 * Called at startup so the file always reflects the current state.
 */
export function seedDependenciesFile(projectDir) {
  const existing = _loadManualDependencies(projectDir);
  const existingPaths = new Set(existing.map(d => path.resolve(projectDir, d.path)));

  // Run all auto-detectors (config files, symlinks, etc.) — NOT manual deps
  const autoDetected = _detectFromConfigFiles(projectDir);

  let added = 0;
  for (const depPath of autoDetected) {
    if (existingPaths.has(depPath) || depPath === projectDir) continue;
    existing.push({
      path: depPath,
      name: path.basename(depPath),
      reason: 'auto-detected',
      addedAt: new Date().toISOString(),
    });
    existingPaths.add(depPath);
    added++;
  }

  if (added > 0 || existing.length > 0) {
    _saveManualDependencies(projectDir, existing);
    if (added > 0) {
      channel.log('dep-detector', `Seeded ${added} new dependencies into dependencies.json`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Auto-detect dependencies from config files and symlinks only (no manual deps).
 * Used internally by seedDependenciesFile to avoid circular reads.
 */
function _detectFromConfigFiles(projectDir) {
  const found = new Set();
  for (const detector of DETECTORS) {
    for (const filePattern of detector.files) {
      const filePaths = filePattern.includes('*')
        ? _globSimple(projectDir, filePattern)
        : [path.join(projectDir, filePattern)];

      for (const filePath of filePaths) {
        let content = null;
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) content = fs.readFileSync(filePath, 'utf8');
        } catch { continue; }

        try {
          const deps = detector.detect(projectDir, content, filePath);
          for (const dep of deps) {
            const resolved = path.resolve(dep);
            if (resolved !== projectDir && fs.existsSync(resolved)) {
              found.add(resolved);
              channel.log('dep-detector', `[${detector.name}] ${path.basename(filePath)} → ${resolved}`);
            }
          }
        } catch (err) {
          channel.log('dep-detector', `[${detector.name}] Error processing ${filePath}: ${err.message}`);
        }
      }
    }
  }
  return [...found];
}

/**
 * Detect local project directories that `projectDir` depends on.
 * Reads from .koi/dependencies.json which contains both manually added
 * and auto-discovered dependencies (seeded at startup).
 * Returns deduplicated, existing absolute paths (excludes projectDir itself).
 */
export function detectLocalDependencies(projectDir) {
  const found = new Set();

  // All dependencies are in .koi/dependencies.json (manual + auto-seeded)
  for (const dep of _loadManualDependencies(projectDir)) {
    const resolved = path.resolve(projectDir, dep.path);
    if (resolved !== projectDir && fs.existsSync(resolved)) {
      found.add(resolved);
    }
  }

  return [...found];
}

/**
 * Recursively detect dependencies (transitive).
 * Returns all local project dirs reachable from projectDir (excluding itself).
 * Depth-limited to avoid infinite loops in circular dependencies.
 */
export function detectAllLocalDependencies(projectDir, maxDepth = 3) {
  const all = new Set();
  const visited = new Set();

  const walk = (dir, depth) => {
    if (depth > maxDepth || visited.has(dir)) return;
    visited.add(dir);

    const deps = detectLocalDependencies(dir);
    for (const dep of deps) {
      if (dep !== projectDir) all.add(dep);
      walk(dep, depth + 1);
    }
  };

  walk(projectDir, 0);
  channel.log('dep-detector', `Total local dependencies for ${path.basename(projectDir)}: ${all.size} projects`);
  return [...all];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Simple single-level glob for patterns like "*.csproj" */
function _globSimple(dir, pattern) {
  const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  try {
    return fs.readdirSync(dir)
      .filter(f => regex.test(f))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

/**
 * If `entryPath` is a symlink pointing outside `projectDir`, resolve and return
 * the target directory. Returns null if not a symlink or points inside the project.
 */
function _resolveSymlink(entryPath, projectDir) {
  try {
    const lstat = fs.lstatSync(entryPath);
    if (!lstat.isSymbolicLink()) return null;
    const target = fs.realpathSync(entryPath);
    // Only return if it points outside the project (local dependency, not internal)
    if (!target.startsWith(projectDir + path.sep) && target !== projectDir) {
      // Return the project root of the symlink target (where package.json lives),
      // not the deep path. Walk up until we find package.json or hit root.
      let dir = target;
      for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return target; // fallback: return as-is
    }
  } catch { /* broken symlink or permission error */ }
  return null;
}
