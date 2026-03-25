/**
 * JavaScript/TypeScript Code Parser Plugin
 *
 * Extracts class → method and standalone function hierarchy from JS/TS/TSX ASTs.
 * Used by code-parser.js for semantic indexing.
 */

const plugin = {
  name: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],

  /**
   * Extract file hierarchy from a tree-sitter AST.
   * @param {object} tree - tree-sitter parse tree
   * @param {string} content - raw file content
   * @returns {{ classes: ClassInfo[], functions: FunctionInfo[] }}
   */
  extractHierarchy(tree, content) {
    const classes = [];
    const functions = [];

    for (const node of tree.rootNode.children) {
      this._processNode(node, content, classes, functions);
    }

    return { classes, functions };
  },

  /**
   * Process a top-level AST node (handles export wrappers).
   * @private
   */
  _processNode(node, content, classes, functions) {
    const type = node.type;

    // Unwrap export wrappers
    if (type === 'export_statement' || type === 'export_default_declaration') {
      for (const child of node.children) {
        this._processNode(child, content, classes, functions);
      }
      return;
    }

    if (type === 'class_declaration' || type === 'class') {
      this._extractClass(node, content, classes);
    } else if (type === 'function_declaration' || type === 'generator_function_declaration') {
      this._extractFunction(node, content, functions);
    } else if (type === 'lexical_declaration' || type === 'variable_declaration') {
      this._extractVariableFunction(node, content, functions);
    }
  },

  /**
   * Extract a class and its methods.
   * @private
   */
  _extractClass(node, content, classes) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const className = nameNode.text;
    const methods = [];
    const body = node.childForFieldName('body');

    if (body) {
      for (const member of body.children) {
        if (member.type === 'method_definition') {
          const methodName = member.childForFieldName('name');
          if (!methodName) continue;
          const params = member.childForFieldName('parameters');
          methods.push({
            name: methodName.text,
            lineFrom: member.startPosition.row + 1,
            lineTo: member.endPosition.row + 1,
            signature: `${methodName.text}(${params ? params.text.slice(1, -1) : ''})`,
            sourceCode: content.substring(member.startIndex, member.endIndex),
            isMethod: true,
            className
          });
        }
      }
    }

    classes.push({
      name: className,
      lineFrom: node.startPosition.row + 1,
      lineTo: node.endPosition.row + 1,
      sourceCode: content.substring(node.startIndex, node.endIndex),
      methods
    });
  },

  /**
   * Extract a standalone function declaration.
   * @private
   */
  _extractFunction(node, content, functions) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const params = node.childForFieldName('parameters');

    functions.push({
      name: nameNode.text,
      lineFrom: node.startPosition.row + 1,
      lineTo: node.endPosition.row + 1,
      signature: `${nameNode.text}(${params ? params.text.slice(1, -1) : ''})`,
      sourceCode: content.substring(node.startIndex, node.endIndex),
      isMethod: false,
      className: null
    });
  },

  /**
   * Extract arrow functions / function expressions assigned to top-level variables.
   * @private
   */
  _extractVariableFunction(node, content, functions) {
    for (const child of node.children) {
      if (child.type !== 'variable_declarator') continue;
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;

      if (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function') {
        const params = valueNode.childForFieldName('parameters');
        functions.push({
          name: nameNode.text,
          lineFrom: node.startPosition.row + 1,
          lineTo: node.endPosition.row + 1,
          signature: `${nameNode.text}(${params ? params.text.slice(1, -1) : ''})`,
          sourceCode: content.substring(node.startIndex, node.endIndex),
          isMethod: false,
          className: null
        });
      }
    }
  }
};

export default plugin;
