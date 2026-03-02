/**
 * Dependency Graph - Import graph + call graph for impact analysis.
 *
 * Builds two graphs from tree-sitter ASTs:
 *   1. Import graph: module A imports from module B → edge A→B
 *   2. Symbol graph: function A references symbol from module B → weighted edge
 *
 * Then provides:
 *   - impactOf(file): BFS expansion from a file, ranked by distance
 *   - impactOfSymbol(symbol): which files/functions are affected transitively
 *   - dependsOn(file): what does this file depend on (upstream)
 *   - dependedBy(file): what depends on this file (downstream / consumers)
 *
 * Uses tree-sitter for precise import resolution and symbol extraction.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cliLogger } from './cli-logger.js';
import { extractSymbols } from './symbol-resolver.js';

// ─── Import Resolution ─────────────────────────────────────────────────

/**
 * Extract import sources from a file using tree-sitter AST.
 * Returns the resolved file paths that this file imports from.
 */
function extractImports(filePath, content, allFilePaths) {
  const ext = path.extname(filePath).toLowerCase();
  const isPython = ext === '.py';
  const lines = content.split('\n');
  const imports = [];

  if (isPython) {
    // Python: import foo / from foo import bar
    for (const line of lines) {
      const fromMatch = line.match(/^\s*from\s+([.\w]+)\s+import/);
      const importMatch = line.match(/^\s*import\s+([.\w]+)/);
      if (fromMatch) imports.push(fromMatch[1]);
      else if (importMatch) imports.push(importMatch[1]);
    }
  } else {
    // JS/TS: import ... from '...' / require('...')
    for (const line of lines) {
      const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/);
      const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (fromMatch) imports.push(fromMatch[1]);
      else if (requireMatch) imports.push(requireMatch[1]);
    }
  }

  // Resolve import specifiers to actual file paths
  const dir = path.dirname(filePath);
  const resolved = [];

  for (const spec of imports) {
    // Skip node_modules / external packages
    if (!spec.startsWith('.') && !spec.startsWith('/') && !isPython) continue;

    const candidates = resolveImportPath(spec, dir, isPython);
    for (const candidate of candidates) {
      if (allFilePaths.includes(candidate)) {
        resolved.push(candidate);
        break;
      }
    }
  }

  return resolved;
}

/**
 * Resolve a relative import specifier to possible file paths.
 */
function resolveImportPath(spec, fromDir, isPython) {
  if (isPython) {
    // Python relative imports: . = current, .. = parent
    const dotMatch = spec.match(/^(\.+)(.*)/);
    if (dotMatch) {
      const dots = dotMatch[1].length;
      let base = fromDir;
      for (let i = 1; i < dots; i++) base = path.dirname(base);
      const rest = dotMatch[2].replace(/\./g, '/');
      return [
        path.join(base, rest + '.py'),
        path.join(base, rest, '__init__.py')
      ];
    }
    // Absolute imports — skip (would need sys.path resolution)
    return [];
  }

  // JS/TS resolution
  const resolved = path.resolve(fromDir, spec);
  return [
    resolved,
    resolved + '.js',
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '.jsx',
    resolved + '.mjs',
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.ts')
  ];
}

// ─── Dependency Graph ───────────────────────────────────────────────────

export class DependencyGraph {
  constructor() {
    // Adjacency lists (file paths as keys)
    this.imports = new Map();      // file → Set<file>  (this file imports from...)
    this.importedBy = new Map();   // file → Set<file>  (these files import this file)
    this.fileSymbols = new Map();  // file → { definitions[], references[] }
    this.files = [];
    this.built = false;
  }

  /**
   * Build the dependency graph from a list of files.
   * @param {string[]} filePaths - Absolute file paths
   */
  build(filePaths) {
    this.files = filePaths;

    // Initialize adjacency lists
    for (const f of filePaths) {
      this.imports.set(f, new Set());
      this.importedBy.set(f, new Set());
    }

    // Phase 1: Extract imports and build import graph
    for (const filePath of filePaths) {
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

      const importedFiles = extractImports(filePath, content, filePaths);
      for (const imported of importedFiles) {
        this.imports.get(filePath)?.add(imported);
        if (!this.importedBy.has(imported)) {
          this.importedBy.set(imported, new Set());
        }
        this.importedBy.get(imported).add(filePath);
      }
    }

    // Phase 2: Extract symbols per file (for symbol-level impact)
    const SUPPORTED_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
    for (const filePath of filePaths) {
      if (!SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase())) continue;
      const symbols = extractSymbols(filePath);
      this.fileSymbols.set(filePath, symbols);
    }

    this.built = true;
  }

  /**
   * Get downstream impact of changing a file.
   * BFS from the file through importedBy edges, ranked by distance.
   *
   * @param {string} filePath - Absolute path of the changed file
   * @param {number} maxDepth - Max BFS depth (default: 10)
   * @returns {Array<{ file: string, depth: number, via: string }>}
   */
  impactOf(filePath, maxDepth = 10) {
    const resolved = path.resolve(filePath);
    const visited = new Map(); // file → { depth, via }
    const queue = [{ file: resolved, depth: 0, via: null }];

    while (queue.length > 0) {
      const { file, depth, via } = queue.shift();
      if (visited.has(file)) continue;
      if (depth > maxDepth) continue;

      visited.set(file, { depth, via });

      const consumers = this.importedBy.get(file);
      if (consumers) {
        for (const consumer of consumers) {
          if (!visited.has(consumer)) {
            queue.push({ file: consumer, depth: depth + 1, via: file });
          }
        }
      }
    }

    // Remove the source file itself and sort by depth
    visited.delete(resolved);

    return [...visited.entries()]
      .map(([file, { depth, via }]) => ({ file, depth, via }))
      .sort((a, b) => a.depth - b.depth);
  }

  /**
   * Get upstream dependencies of a file.
   * What does this file depend on?
   *
   * @param {string} filePath
   * @param {number} maxDepth
   * @returns {Array<{ file: string, depth: number }>}
   */
  dependsOn(filePath, maxDepth = 10) {
    const resolved = path.resolve(filePath);
    const visited = new Map();
    const queue = [{ file: resolved, depth: 0 }];

    while (queue.length > 0) {
      const { file, depth } = queue.shift();
      if (visited.has(file)) continue;
      if (depth > maxDepth) continue;

      visited.set(file, depth);

      const deps = this.imports.get(file);
      if (deps) {
        for (const dep of deps) {
          if (!visited.has(dep)) {
            queue.push({ file: dep, depth: depth + 1 });
          }
        }
      }
    }

    visited.delete(resolved);
    return [...visited.entries()]
      .map(([file, depth]) => ({ file, depth }))
      .sort((a, b) => a.depth - b.depth);
  }

  /**
   * Impact analysis for a specific symbol.
   * 1. Find where the symbol is defined (file A)
   * 2. Find all files that import from file A
   * 3. Among those files, find which ones actually reference the symbol
   * 4. Expand transitively (if symbol is re-exported)
   *
   * @param {string} symbolName
   * @param {string} basePath - For relative path output
   * @returns {{ source: object, directUsers: object[], transitiveImpact: object[], totalFiles: number }}
   */
  impactOfSymbol(symbolName, basePath) {
    // Find definition file
    let sourceFile = null;
    let sourceDef = null;

    for (const [file, symbols] of this.fileSymbols) {
      for (const def of symbols.definitions) {
        if (def.name === symbolName && def.kind !== 'import' && def.kind !== 'export') {
          sourceFile = file;
          sourceDef = def;
          break;
        }
      }
      if (sourceFile) break;
    }

    if (!sourceFile) {
      return { source: null, directUsers: [], transitiveImpact: [], totalFiles: 0 };
    }

    // Find direct users: files that import from sourceFile AND reference the symbol
    const directUsers = [];
    const importers = this.importedBy.get(sourceFile) || new Set();

    for (const importer of importers) {
      const symbols = this.fileSymbols.get(importer);
      if (!symbols) continue;

      // Check if this file actually references the symbol
      const refs = symbols.references.filter(r => r.name === symbolName);
      const imports = symbols.definitions.filter(d => d.name === symbolName && d.kind === 'import');

      if (refs.length > 0 || imports.length > 0) {
        directUsers.push({
          file: path.relative(basePath, importer),
          references: refs.length,
          lines: refs.map(r => r.line)
        });
      }
    }

    // Transitive impact: BFS from sourceFile through the full import graph
    const transitiveImpact = this.impactOf(sourceFile);

    return {
      source: {
        file: path.relative(basePath, sourceFile),
        kind: sourceDef.kind,
        line: sourceDef.line,
        signature: sourceDef.signature
      },
      directUsers,
      transitiveImpact: transitiveImpact.map(({ file, depth, via }) => ({
        file: path.relative(basePath, file),
        depth,
        via: via ? path.relative(basePath, via) : null
      })),
      totalFiles: new Set([
        ...directUsers.map(u => u.file),
        ...transitiveImpact.map(i => path.relative(basePath, i.file))
      ]).size
    };
  }

  /**
   * Get a summary of the most "central" files (most connections).
   * Useful for understanding project architecture.
   *
   * @param {string} basePath
   * @param {number} topN
   * @returns {Array<{ file: string, importedByCount: number, importsCount: number, score: number }>}
   */
  hotspots(basePath, topN = 15) {
    const scores = [];

    for (const file of this.files) {
      const importedByCount = this.importedBy.get(file)?.size || 0;
      const importsCount = this.imports.get(file)?.size || 0;
      // Score: downstream impact matters more (2x weight)
      const score = importedByCount * 2 + importsCount;

      if (score > 0) {
        scores.push({
          file: path.relative(basePath, file),
          importedByCount,
          importsCount,
          score
        });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topN);
  }
}

// ─── Disk + Memory cache ────────────────────────────────────────────────

const graphCache = new Map();
const GRAPH_TTL = 2 * 60 * 1000; // 2 minutes in-memory

function _graphCacheDir() {
  return path.join(process.cwd(), '.koi', 'cache', 'graphs');
}

function _filesFingerprint(files) {
  const entries = files.map(f => {
    try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return f; }
  });
  return crypto.createHash('md5').update(entries.sort().join('\n')).digest('hex');
}

/**
 * Get or build a DependencyGraph for a directory.
 * Caches import graph to disk, symbols rebuilt from disk cache.
 */
export function getOrBuildGraph(dirKey, filePaths) {
  // 1. In-memory cache
  const memCached = graphCache.get(dirKey);
  if (memCached && (Date.now() - memCached.timestamp) < GRAPH_TTL) {
    return memCached.graph;
  }

  // 2. Disk cache — only the import graph (lightweight)
  const fingerprint = _filesFingerprint(filePaths);
  const cacheDir = _graphCacheDir();
  const cachePath = path.join(cacheDir, `graph-${fingerprint.substring(0, 16)}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const graph = new DependencyGraph();
      graph.files = filePaths;

      // Restore import graph from cache
      for (const [file, deps] of data.imports) {
        graph.imports.set(file, new Set(deps));
      }
      for (const [file, consumers] of data.importedBy) {
        graph.importedBy.set(file, new Set(consumers));
      }

      // Symbols must be rebuilt (too large/complex to serialize)
      const SUPPORTED_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
      for (const filePath of filePaths) {
        if (!SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase())) continue;
        const symbols = extractSymbols(filePath);
        graph.fileSymbols.set(filePath, symbols);
      }

      graph.built = true;
      graphCache.set(dirKey, { graph, timestamp: Date.now() });
      return graph;
    } catch { /* corrupted cache, rebuild */ }
  }

  // 3. Build fresh
  cliLogger.planning('Indexing (dependency graph)');
  const graph = new DependencyGraph();
  graph.build(filePaths);
  graphCache.set(dirKey, { graph, timestamp: Date.now() });
  cliLogger.clearProgress();

  // 4. Save import graph to disk
  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const serialized = {
      imports: [...graph.imports.entries()].map(([k, v]) => [k, [...v]]),
      importedBy: [...graph.importedBy.entries()].map(([k, v]) => [k, [...v]])
    };
    fs.writeFileSync(cachePath, JSON.stringify(serialized));
  } catch { /* non-fatal */ }

  return graph;
}
