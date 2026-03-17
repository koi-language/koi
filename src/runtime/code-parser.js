/**
 * Code Parser — Dispatcher for language-specific code hierarchy extraction.
 *
 * Detects the language from the file extension, loads the matching plugin,
 * parses via tree-sitter, and returns a FileParseResult (classes + standalone functions).
 *
 * Reuses tree-sitter bindings already used by symbol-resolver.js.
 *
 * Graceful degradation: if tree-sitter or a grammar is unavailable (e.g. inside
 * a compiled binary without native addons), parseFile() returns null and callers
 * skip structural parsing for that file.
 */

import path from 'path';
import { cliLogger } from './cli-logger.js';

import jsPlugin from './code-parser-plugins/javascript.js';
import pyPlugin from './code-parser-plugins/python.js';

// Load tree-sitter and grammars gracefully — they are native addons that may
// be unavailable in compiled binaries targeting platforms without prebuilds.
let Parser = null;
let JavaScript = null;
let TypeScript = null;
let TSX = null;
let Python = null;

try {
  Parser = (await import('tree-sitter')).default;
  cliLogger.log('semantic-index', 'tree-sitter runtime loaded OK');
} catch {
  // tree-sitter not available (expected in binary builds)
}

try {
  JavaScript = (await import('tree-sitter-javascript')).default;
} catch { /* not available */ }

try {
  const ts = (await import('tree-sitter-typescript')).default;
  TypeScript = ts?.typescript ?? null;
  TSX = ts?.tsx ?? null;
} catch { /* not available */ }

try {
  Python = (await import('tree-sitter-python')).default;
} catch { /* not available */ }

// ─── Language → tree-sitter grammar mapping ─────────────────────────────

const LANG_MAP = {
  '.js':  JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
  '.jsx': JavaScript,
  '.ts':  TypeScript,
  '.tsx': TSX,
  '.py':  Python,
};

// ─── Extension → plugin mapping ─────────────────────────────────────────

const pluginRegistry = new Map();

for (const plugin of [jsPlugin, pyPlugin]) {
  for (const ext of plugin.extensions) {
    pluginRegistry.set(ext, plugin);
  }
}

// Shared parser instance (tree-sitter is stateful per setLanguage call)
let parser = null;
if (Parser) {
  try {
    parser = new Parser();
    cliLogger.log('semantic-index', 'tree-sitter Parser instance created OK');
  } catch {
    // Parser instantiation failed — code parsing disabled
  }
}

/**
 * Get the set of file extensions supported by registered plugins.
 * @returns {Set<string>}
 */
export function getSupportedExtensions() {
  return new Set(pluginRegistry.keys());
}

/**
 * Parse a source file and extract its class/function hierarchy.
 *
 * @param {string} filePath - Path to file (used for language detection)
 * @param {string} content  - File contents
 * @returns {{ classes: ClassInfo[], functions: FunctionInfo[] } | null}
 *   null if the language is unsupported or tree-sitter is unavailable
 */
export function parseFile(filePath, content) {
  if (!parser) return null; // tree-sitter runtime not available

  const ext = path.extname(filePath).toLowerCase();
  const lang = LANG_MAP[ext];
  const plugin = pluginRegistry.get(ext);

  if (!lang || !plugin) return null;

  try {
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    return plugin.extractHierarchy(tree, content);
  } catch {
    return null;
  }
}
