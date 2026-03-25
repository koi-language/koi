/**
 * Symbol Resolver - AST-based symbol extraction using tree-sitter.
 *
 * Parses source files into ASTs and extracts:
 *   - Definitions: function, class, variable, method, interface, type
 *   - References: usages of symbols (calls, property access, assignments)
 *   - Imports/Exports: module-level dependencies
 *
 * Supports: JavaScript, TypeScript, TSX, Python
 * Provides: "go to definition", "find references", "impact radius" for a symbol.
 *
 * Uses tree-sitter (native) for precise, language-aware parsing.
 */

import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScriptLangs from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import fs from 'fs';
import path from 'path';

const { typescript: TypeScript, tsx: TSX } = TypeScriptLangs;

// ─── Language Detection ─────────────────────────────────────────────────

const LANG_MAP = {
  '.js': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
  '.jsx': JavaScript,
  '.ts': TypeScript,
  '.tsx': TSX,
  '.py': Python,
};

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_MAP[ext] || null;
}

// ─── Symbol Types ───────────────────────────────────────────────────────

/**
 * @typedef {'function'|'class'|'variable'|'method'|'interface'|'type'|'import'|'export'} SymbolKind
 *
 * @typedef {Object} SymbolDef
 * @property {string} name
 * @property {SymbolKind} kind
 * @property {string} file
 * @property {number} line
 * @property {number} endLine
 * @property {string} signature - short text snippet of the definition
 *
 * @typedef {Object} SymbolRef
 * @property {string} name
 * @property {string} file
 * @property {number} line
 * @property {string} context - the line of code containing the reference
 */

// ─── AST Symbol Extractor ───────────────────────────────────────────────

const parser = new Parser();

/**
 * Extract all symbol definitions from a file using tree-sitter AST.
 * @param {string} filePath
 * @param {string} [content] - optional pre-read content
 * @returns {{ definitions: SymbolDef[], references: SymbolRef[] }}
 */
export function extractSymbols(filePath, content) {
  const lang = getLanguage(filePath);
  if (!lang) return { definitions: [], references: [] };

  if (!content) {
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { definitions: [], references: [] }; }
  }

  parser.setLanguage(lang);
  const tree = parser.parse(content);
  const lines = content.split('\n');
  const ext = path.extname(filePath).toLowerCase();
  const isPython = ext === '.py';

  const definitions = [];
  const references = [];
  const definedNames = new Set();

  // Walk the AST
  walkNode(tree.rootNode, (node) => {
    // ─── DEFINITIONS ────────────────────────────────────────────
    if (isPython) {
      extractPythonDefinitions(node, filePath, lines, definitions, definedNames);
    } else {
      extractJSDefinitions(node, filePath, lines, definitions, definedNames);
    }
  });

  // Second pass: find references (identifiers that aren't definitions)
  walkNode(tree.rootNode, (node) => {
    if (node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'type_identifier') {
      const name = node.text;
      if (name.length < 2) return; // skip single-char identifiers
      if (isDefinitionNode(node)) return; // skip definition sites

      references.push({
        name,
        file: filePath,
        line: node.startPosition.row + 1,
        context: lines[node.startPosition.row]?.trim() || ''
      });
    }
  });

  return { definitions, references };
}

/**
 * Extract definitions from JS/TS AST nodes.
 */
function extractJSDefinitions(node, filePath, lines, definitions, definedNames) {
  const type = node.type;

  // function foo() {}
  if (type === 'function_declaration' || type === 'generator_function_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'function', filePath, node, lines);
    }
  }

  // class Foo {}
  else if (type === 'class_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'class', filePath, node, lines);
    }
  }

  // const/let/var foo = ... (only top-level or module-level, not locals inside functions)
  else if (type === 'variable_declarator') {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (nameNode && nameNode.type === 'identifier') {
      const isTopLevel = isTopLevelNode(node);
      const isFunc = valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression');
      // Only report top-level variables or function-assigned variables at any level
      if (isTopLevel || isFunc) {
        const kind = isFunc ? 'function' : 'variable';
        addDef(definitions, definedNames, nameNode.text, kind, filePath, node, lines);
      }
    }
  }

  // method_definition (inside class body)
  else if (type === 'method_definition') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'method', filePath, node, lines);
    }
  }

  // interface Foo {} (TS)
  else if (type === 'interface_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'interface', filePath, node, lines);
    }
  }

  // type Foo = ... (TS)
  else if (type === 'type_alias_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'type', filePath, node, lines);
    }
  }

  // import { foo } from '...'
  else if (type === 'import_statement' || type === 'import_declaration') {
    const specifiers = node.descendantsOfType('import_specifier');
    for (const spec of specifiers) {
      const nameNode = spec.childForFieldName('name') || spec.namedChildren[0];
      if (nameNode) {
        addDef(definitions, definedNames, nameNode.text, 'import', filePath, node, lines);
      }
    }
    // import Default from '...'
    const clauseNode = node.descendantsOfType('import_clause');
    for (const clause of clauseNode) {
      for (const child of clause.namedChildren) {
        if (child.type === 'identifier') {
          addDef(definitions, definedNames, child.text, 'import', filePath, node, lines);
        }
      }
    }
    // import * as foo from '...'
    const nsImports = node.descendantsOfType('namespace_import');
    for (const ns of nsImports) {
      const idNode = ns.namedChildren.find(c => c.type === 'identifier');
      if (idNode) {
        addDef(definitions, definedNames, idNode.text, 'import', filePath, node, lines);
      }
    }
  }

  // export { foo }
  else if (type === 'export_statement') {
    // export default ...
    const decl = node.namedChildren.find(c =>
      c.type === 'function_declaration' || c.type === 'class_declaration' ||
      c.type === 'lexical_declaration' || c.type === 'variable_declaration'
    );
    if (!decl) {
      // Named exports: export { foo, bar }
      const specifiers = node.descendantsOfType('export_specifier');
      for (const spec of specifiers) {
        const nameNode = spec.childForFieldName('name') || spec.namedChildren[0];
        if (nameNode) {
          addDef(definitions, definedNames, nameNode.text, 'export', filePath, node, lines);
        }
      }
    }
  }
}

/**
 * Extract definitions from Python AST nodes.
 */
function extractPythonDefinitions(node, filePath, lines, definitions, definedNames) {
  const type = node.type;

  // def foo():
  if (type === 'function_definition') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'function', filePath, node, lines);
    }
  }

  // class Foo:
  else if (type === 'class_definition') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      addDef(definitions, definedNames, nameNode.text, 'class', filePath, node, lines);
    }
  }

  // foo = ... (top-level assignment only)
  else if (type === 'assignment' && node.parent?.type === 'module') {
    const left = node.childForFieldName('left');
    if (left?.type === 'identifier') {
      addDef(definitions, definedNames, left.text, 'variable', filePath, node, lines);
    }
  }

  // import foo / from foo import bar
  else if (type === 'import_statement' || type === 'import_from_statement') {
    const names = node.descendantsOfType('dotted_name');
    for (const name of names) {
      addDef(definitions, definedNames, name.text, 'import', filePath, node, lines);
    }
    const aliases = node.descendantsOfType('aliased_import');
    for (const alias of aliases) {
      const nameNode = alias.childForFieldName('alias') || alias.namedChildren[0];
      if (nameNode) {
        addDef(definitions, definedNames, nameNode.text, 'import', filePath, node, lines);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Check if a node is at the top level (module scope, not inside a function/method body).
 */
function isTopLevelNode(node) {
  let current = node.parent;
  while (current) {
    const t = current.type;
    // If we hit a function/method body, it's not top-level
    if (t === 'function_declaration' || t === 'function_expression' ||
        t === 'arrow_function' || t === 'method_definition' ||
        t === 'generator_function_declaration' || t === 'function_definition') {
      return false;
    }
    // If we hit program/module, it's top-level
    if (t === 'program' || t === 'module') return true;
    // Class body is considered "top-level" for class-level properties
    if (t === 'class_body') return true;
    current = current.parent;
  }
  return true;
}

function addDef(definitions, definedNames, name, kind, filePath, node, lines) {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const signature = lines[node.startPosition.row]?.trim() || '';

  definitions.push({ name, kind, file: filePath, line, endLine, signature });
  definedNames.add(`${name}:${line}`);
}

/**
 * Check if a node is the "name" part of a definition (not a reference).
 */
function isDefinitionNode(node) {
  const parent = node.parent;
  if (!parent) return false;

  const parentType = parent.type;

  // Direct definition name
  if (['function_declaration', 'generator_function_declaration', 'class_declaration',
    'method_definition', 'interface_declaration', 'type_alias_declaration',
    'function_definition', 'class_definition'].includes(parentType)) {
    return parent.childForFieldName('name') === node;
  }

  // Variable declarator name
  if (parentType === 'variable_declarator') {
    return parent.childForFieldName('name') === node;
  }

  // Import specifier
  if (parentType === 'import_specifier' || parentType === 'export_specifier' ||
    parentType === 'import_clause' || parentType === 'namespace_import') {
    return true;
  }

  // Python assignment left-hand side
  if (parentType === 'assignment' && parent.childForFieldName('left') === node) {
    return true;
  }

  // Formal parameter
  if (parentType === 'formal_parameters' || parentType === 'parameters' ||
    parentType === 'required_parameter' || parentType === 'optional_parameter') {
    return true;
  }

  return false;
}

function walkNode(node, callback) {
  callback(node);
  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i), callback);
  }
}

// ─── High-Level Search API ──────────────────────────────────────────────

/**
 * Index all files and find a symbol: its definition(s) and all references.
 *
 * @param {string} symbolName - Symbol to search for
 * @param {string[]} filePaths - Files to analyze
 * @param {string} basePath - Base directory for relative paths
 * @param {Object} [options]
 * @param {'definition'|'references'|'all'} [options.mode='all'] - What to search for
 * @returns {{ definitions: SymbolDef[], references: SymbolRef[], impactRadius: number }}
 */
export function findSymbol(symbolName, filePaths, basePath, options = {}) {
  const mode = options.mode || 'all';
  const allDefs = [];
  const allRefs = [];

  for (const filePath of filePaths) {
    const lang = getLanguage(filePath);
    if (!lang) continue;

    const { definitions, references } = extractSymbols(filePath);

    if (mode === 'definition' || mode === 'all') {
      for (const def of definitions) {
        if (def.name === symbolName) {
          allDefs.push({ ...def, file: path.relative(basePath, def.file) });
        }
      }
    }

    if (mode === 'references' || mode === 'all') {
      for (const ref of references) {
        if (ref.name === symbolName) {
          allRefs.push({ ...ref, file: path.relative(basePath, ref.file) });
        }
      }
    }
  }

  // Deduplicate references (same file+line)
  const seenRefs = new Set();
  const uniqueRefs = allRefs.filter(ref => {
    const key = `${ref.file}:${ref.line}`;
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  });

  // Impact radius: number of unique files that reference the symbol
  const impactFiles = new Set(uniqueRefs.map(r => r.file));

  return {
    definitions: allDefs,
    references: uniqueRefs,
    impactRadius: impactFiles.size
  };
}

/**
 * List all symbols defined in a set of files.
 * Useful for "outline" / "go to symbol in workspace" functionality.
 *
 * @param {string[]} filePaths
 * @param {string} basePath
 * @param {Object} [options]
 * @param {string} [options.kind] - Filter by kind: 'function', 'class', 'variable', etc.
 * @param {string} [options.filter] - Substring filter on symbol name
 * @returns {SymbolDef[]}
 */
export function listSymbols(filePaths, basePath, options = {}) {
  const allDefs = [];

  for (const filePath of filePaths) {
    const lang = getLanguage(filePath);
    if (!lang) continue;

    const { definitions } = extractSymbols(filePath);

    for (const def of definitions) {
      if (options.kind && def.kind !== options.kind) continue;
      if (options.filter && !def.name.toLowerCase().includes(options.filter.toLowerCase())) continue;
      allDefs.push({ ...def, file: path.relative(basePath, def.file) });
    }
  }

  return allDefs;
}
