/**
 * Code Parser — Dispatcher for language-specific code hierarchy extraction.
 *
 * Detects the language from the file extension, loads the matching plugin,
 * parses via tree-sitter, and returns a FileParseResult (classes + standalone functions).
 *
 * Reuses tree-sitter bindings already used by symbol-resolver.js.
 */

import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScriptLangs from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import path from 'path';

import jsPlugin from './code-parser-plugins/javascript.js';
import pyPlugin from './code-parser-plugins/python.js';

const { typescript: TypeScript, tsx: TSX } = TypeScriptLangs;

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
const parser = new Parser();

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
 *   null if the language is unsupported
 */
export function parseFile(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const lang = LANG_MAP[ext];
  const plugin = pluginRegistry.get(ext);

  if (!lang || !plugin) return null;

  parser.setLanguage(lang);
  const tree = parser.parse(content);

  return plugin.extractHierarchy(tree, content);
}
