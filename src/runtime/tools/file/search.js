/**
 * Search Action - Multi-mode code search across the project.
 *
 * Modes:
 *   1. pattern  — regex grep across file contents
 *   2. glob     — file name matching with glob patterns
 *   3. query    — BM25 ranked full-text search (inverted index, 1-min cache)
 *   4. semantic — hierarchical code search via SemanticIndex + LanceDB
 *   5. symbols  — AST-based symbol resolution via tree-sitter
 *   6. impact   — dependency graph analysis (import graph + symbol refs)
 *
 * Permission: per directory, shared with read_file/edit_file/write_file.
 */

import fs from 'fs';
import path from 'path';

import { t } from '../../i18n.js';
import { getFilePermissions } from '../../code/file-permissions.js';
import { discoverFiles } from '../../code/file-discovery.js';
import { channel } from '../../io/channel.js';

// ─── BM25 Inverted Index ────────────────────────────────────────────────

let bm25Cache = null;
let bm25CacheTime = 0;
const BM25_TTL = 60 * 1000; // 1-minute cache

function tokenize(text) {
  return text.toLowerCase().match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [];
}

function buildInvertedIndex(files, basePath) {
  const now = Date.now();
  if (bm25Cache && (now - bm25CacheTime) < BM25_TTL && bm25Cache.basePath === basePath) {
    return bm25Cache;
  }

  const index = Object.create(null); // term → [{ file, tf, lines }]
  const docLengths = Object.create(null); // file → token count
  let totalLength = 0;

  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const tokens = tokenize(content);
    const rel = path.relative(process.cwd(), filePath);
    docLengths[rel] = tokens.length;
    totalLength += tokens.length;

    // Build term frequency + line numbers
    // Object.create(null) avoids prototype pollution: tokens like "constructor",
    // "toString", etc. would otherwise match inherited Object properties.
    const termInfo = Object.create(null);
    for (let i = 0; i < lines.length; i++) {
      const lineTokens = tokenize(lines[i]);
      for (const t of lineTokens) {
        if (!termInfo[t]) termInfo[t] = { tf: 0, lines: [] };
        termInfo[t].tf++;
        if (termInfo[t].lines.length < 5) termInfo[t].lines.push(i + 1);
      }
    }

    for (const [term, info] of Object.entries(termInfo)) {
      if (!index[term]) index[term] = [];
      index[term].push({ file: rel, fullPath: filePath, tf: info.tf, lines: info.lines });
    }
  }

  const result = {
    index,
    docLengths,
    avgDl: totalLength / Math.max(1, files.length),
    N: files.length,
    basePath
  };
  bm25Cache = result;
  bm25CacheTime = now;
  return result;
}

function bm25Search(query, files, basePath, maxResults = 20) {
  const { index, docLengths, avgDl, N } = buildInvertedIndex(files, basePath);
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const k1 = 1.5, b = 0.75;
  const scores = {};
  const lineHits = {};

  for (const term of queryTerms) {
    const postings = index[term];
    if (!postings) continue;
    const df = postings.length;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    for (const { file, fullPath, tf, lines } of postings) {
      const dl = docLengths[file] || 1;
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl));
      scores[file] = (scores[file] || 0) + idf * tfNorm;
      if (!lineHits[file]) lineHits[file] = { fullPath, lines: [] };
      lineHits[file].lines.push(...lines);
    }
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([file, score]) => ({
      file,
      score: Math.round(score * 1000) / 1000,
      lines: [...new Set(lineHits[file].lines)].sort((a, b) => a - b).slice(0, 10)
    }));
}

// ─── Pattern Search (grep) ──────────────────────────────────────────────

function patternSearch(pattern, files, basePath, maxResults = 30) {
  let regex;
  try { regex = new RegExp(pattern, 'gi'); } catch {
    return { error: `Invalid regex: ${pattern}` };
  }

  const results = [];
  for (const filePath of files) {
    if (results.length >= maxResults) break;
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
        if (matches.length >= 5) break; // max 5 matches per file
      }
      regex.lastIndex = 0; // reset for global regex
    }
    if (matches.length > 0) {
      results.push({ file: path.relative(process.cwd(), filePath), matches });
    }
  }
  return results;
}

// ─── Glob Search ────────────────────────────────────────────────────────

function globSearch(pattern, files, basePath, maxResults = 50) {
  // Convert glob to regex: * → [^/]*, ** → .*, ? → .
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '⭐⭐')
    .replace(/\*/g, '[^/]*')
    .replace(/⭐⭐/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(escaped, 'i');

  return files
    .map(f => path.relative(process.cwd(), f))
    .filter(rel => regex.test(rel))
    .slice(0, maxResults)
    .map(file => ({ file }));
}

// ─── Main Action ────────────────────────────────────────────────────────

export default {
  type: 'search',
  intent: 'search',
  description: 'Search code. PICK THE RIGHT MODE: "symbols" to find function/class definitions and references (set "symbol" field); "query" for natural language BM25 search; "semantic" for AI vector search (best for conceptual queries); "glob" for file name patterns; "pattern" ONLY for exact regex grep; "impact" for dependency tracing. Do NOT default to "pattern" — prefer "symbols" for named entities and "query"/"semantic" for concepts. Fields: "query" (search text), "mode" (required), "symbol" (for symbols mode), "pattern" (for glob/pattern modes), "path" (optional dir or file).',
  thinkingHint: 'Analyzing search results',
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text' },
      pattern: { type: 'string', description: 'Regex pattern (mode=pattern) or glob pattern (mode=glob)' },
      mode: { type: 'string', description: 'Search mode: pattern, glob, query, semantic, symbols, impact' },
      path: { type: 'string', description: 'Directory to search in (defaults to cwd)' },
      symbol: { type: 'string', description: 'Symbol name (mode=symbols or impact)' },
      symbolsMode: { type: 'string', description: 'all, definition, or references (mode=symbols)' },
      file: { type: 'string', description: 'Target file for impact analysis (mode=impact)' },
      impactMode: { type: 'string', description: 'downstream, upstream, symbol, or hotspots (mode=impact)' },
      maxResults: { type: 'number', description: 'Maximum results to return (default varies by mode)' }
    },
    required: []
  },

  async execute(action, agent) {
    const resolvedPath = path.resolve(action.path || process.cwd());
    const maxResults = action.maxResults || 20;

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `Path not found: ${resolvedPath}` };
    }

    // Detect if path is a file (not a directory)
    const stat = fs.statSync(resolvedPath);
    const isFilePath = stat.isFile();
    const searchDir = isFilePath ? path.dirname(resolvedPath) : resolvedPath;

    // Check permission
    const permissions = getFilePermissions(agent);
    if (!permissions.isAllowed(searchDir, 'read')) {
      channel.clearProgress();
      const agentName = agent?.name || 'Agent';
      channel.print(`🔍 ${agentName} ${t('wantsToSearch')} \x1b[33m${searchDir}\x1b[0m`);

      const value = await channel.select(t('allowSearchDir'), [
        { title: t('permYes'), value: 'yes', description: t('allowThisTime') },
        { title: t('permAlwaysAllow'), value: 'always', description: t('alwaysAllowDir') },
        { title: t('permNo'), value: 'no', description: t('denyAccess') }
      ]);

      if (value === 'always') {
        permissions.allow(searchDir, 'read');
      } else if (value !== 'yes') {
        channel.print(`\x1b[2m${t('skipped')}\x1b[0m`);
        return { success: false, denied: true, message: 'User denied search access' };
      }
    }

    // Auto-detect mode
    let mode = action.mode || 'query';
    if (!action.mode) {
      if (action.symbol) mode = 'symbols';
      else if (action.impactMode || (action.file && !action.query)) mode = 'impact';
      else if (action.pattern && !action.query) {
        mode = action.pattern.includes('*') || action.pattern.includes('?') ? 'glob' : 'pattern';
      }
    }

    // If path was a file, search only that file; otherwise discover all files in directory
    const files = isFilePath ? [resolvedPath] : discoverFiles(searchDir);
    if (files.length === 0) {
      return { success: false, error: 'No source files found in directory' };
    }

    try {
      switch (mode) {
        case 'pattern': {
          const pat = action.pattern || action.query;
          if (!pat) return { success: false, error: 'pattern mode requires "pattern" or "query" field' };
          const results = patternSearch(pat, files, searchDir, maxResults);
          if (results.error) return { success: false, error: results.error };
          return { success: true, mode: 'pattern', count: results.length, results };
        }

        case 'glob': {
          const pat = action.pattern || action.query;
          if (!pat) return { success: false, error: 'glob mode requires "pattern" or "query" field' };
          const results = globSearch(pat, files, searchDir, maxResults);
          return { success: true, mode: 'glob', count: results.length, results };
        }

        case 'query': {
          const q = action.query;
          if (!q) return { success: false, error: 'query mode requires "query" field' };
          const results = bm25Search(q, files, searchDir, maxResults);
          return { success: true, mode: 'query', count: results.length, results };
        }

        case 'semantic': {
          const q = action.query;
          if (!q) return { success: false, error: 'semantic mode requires "query" field' };

          const { getSemanticIndex } = await import('../../state/semantic-index.js');
          const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
          const cacheDir = path.join(projectRoot, '.koi', 'cache', 'semantic-index');
          const index = getSemanticIndex(cacheDir, agent.llmProvider);

          if (index.isBuilding() || !(await index.isReady())) {
            // Fallback to BM25 while semantic index builds
            const fallbackResults = bm25Search(q, files, searchDir, maxResults);
            return {
              success: true,
              mode: 'query',
              note: 'Semantic index not ready yet — used BM25 fallback. Run index_code or wait for background indexing.',
              count: fallbackResults.length,
              results: fallbackResults
            };
          }

          const queryEmb = await agent.llmProvider.getEmbedding(q);
          const results = await index.search(queryEmb, { limit: maxResults });

          return {
            success: true,
            mode: 'semantic',
            count: results.length,
            results: results.map(r => ({
              type: r.type,
              name: r.name,
              file: r.filePath,
              score: Math.round(r.score * 1000) / 1000,
              lineFrom: r.lineFrom,
              lineTo: r.lineTo,
              description: r.description,
              ...(r.signature && { signature: r.signature }),
              ...(r.className && { className: r.className }),
            }))
          };
        }

        case 'symbols': {
          const symbolName = action.symbol || action.query;
          if (!symbolName) return { success: false, error: 'symbols mode requires "symbol" or "query" field' };

          const { findSymbol, listSymbols } = await import('../../code/symbol-resolver.js');
          const symbolsMode = action.symbolsMode || 'all';

          // If query looks like listing (e.g., "list functions"), use listSymbols
          if (symbolName === '*' || symbolName === 'all') {
            const defs = listSymbols(files, searchDir, { kind: action.kind, filter: action.filter });
            return {
              success: true,
              mode: 'symbols',
              count: defs.length,
              results: defs.slice(0, maxResults).map(d => ({
                name: d.name,
                kind: d.kind,
                file: path.relative(process.cwd(), d.file),
                line: d.line,
                signature: d.signature
              }))
            };
          }

          const result = findSymbol(symbolName, files, searchDir, { mode: symbolsMode });
          return {
            success: true,
            mode: 'symbols',
            symbol: symbolName,
            definitions: result.definitions.slice(0, maxResults).map(d => ({
              name: d.name,
              kind: d.kind,
              file: path.relative(process.cwd(), d.file),
              line: d.line,
              endLine: d.endLine,
              signature: d.signature
            })),
            references: result.references.slice(0, maxResults).map(r => ({
              name: r.name,
              file: path.relative(process.cwd(), r.file),
              line: r.line,
              context: r.context
            })),
            impactRadius: result.impactRadius
          };
        }

        case 'impact': {
          const { getOrBuildGraph } = await import('../../agent/dependency-graph.js');

          channel.clearProgress();
          channel.progress('Building dependency graph...');
          const graph = getOrBuildGraph(searchDir, files);
          channel.clearProgress();

          const impactMode = action.impactMode || 'downstream';

          // Auto-detect sub-mode
          if (impactMode === 'hotspots' || action.query === 'hotspots') {
            const hotspots = graph.hotspots(searchDir, maxResults);
            return {
              success: true,
              mode: 'impact',
              subMode: 'hotspots',
              count: hotspots.length,
              results: hotspots.map(h => ({
                file: h.file,
                importedByCount: h.importedByCount,
                importsCount: h.importsCount,
                score: h.score
              }))
            };
          }

          if (impactMode === 'symbol' && action.symbol) {
            const impact = graph.impactOfSymbol(action.symbol, searchDir);
            return {
              success: true,
              mode: 'impact',
              subMode: 'symbol',
              symbol: action.symbol,
              source: impact.source,
              directUsers: impact.directUsers,
              transitiveImpact: impact.transitiveImpact.slice(0, maxResults),
              totalFiles: impact.totalFiles
            };
          }

          const targetFile = action.file || action.query;
          if (!targetFile) return { success: false, error: 'impact mode requires "file" or "query" field' };
          const resolvedTarget = path.resolve(searchDir, targetFile);

          if (impactMode === 'upstream') {
            const deps = graph.dependsOn(resolvedTarget, 10);
            return {
              success: true,
              mode: 'impact',
              subMode: 'upstream',
              file: targetFile,
              count: deps.length,
              results: deps.map(d => ({
                file: path.relative(process.cwd(), d.file),
                depth: d.depth
              }))
            };
          }

          // Default: downstream
          const impact = graph.impactOf(resolvedTarget, 10);
          return {
            success: true,
            mode: 'impact',
            subMode: 'downstream',
            file: targetFile,
            count: impact.length,
            results: impact.map(d => ({
              file: path.relative(process.cwd(), d.file),
              depth: d.depth,
              via: d.via ? path.relative(process.cwd(), d.via) : null
            }))
          };
        }

        default:
          return { success: false, error: `Unknown search mode: ${mode}` };
      }
    } catch (err) {
      return { success: false, error: `Search failed: ${err.message}` };
    }
  }
};
