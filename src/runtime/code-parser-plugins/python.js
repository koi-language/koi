/**
 * Python Code Parser Plugin
 *
 * Extracts class → method and standalone function hierarchy from Python ASTs.
 * Used by code-parser.js for semantic indexing.
 */

const plugin = {
  name: 'python',
  extensions: ['.py'],

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
      if (node.type === 'decorated_definition') {
        // Unwrap decorator to get the actual definition
        const inner = node.children.find(c => c.type === 'class_definition' || c.type === 'function_definition');
        if (inner) {
          this._processNode(inner, node, content, classes, functions);
        }
      } else {
        this._processNode(node, node, content, classes, functions);
      }
    }

    return { classes, functions };
  },

  /**
   * Process a top-level node.
   * @param {object} node - The definition node (class_definition or function_definition)
   * @param {object} outerNode - The outermost node (may include decorators)
   * @private
   */
  _processNode(node, outerNode, content, classes, functions) {
    if (node.type === 'class_definition') {
      this._extractClass(node, outerNode, content, classes);
    } else if (node.type === 'function_definition') {
      this._extractFunction(node, outerNode, content, functions);
    }
  },

  /**
   * Extract a class and its methods.
   * @private
   */
  _extractClass(node, outerNode, content, classes) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const className = nameNode.text;
    const methods = [];
    const body = node.childForFieldName('body');

    if (body) {
      for (const child of body.children) {
        let funcNode = child;
        let funcOuter = child;
        if (child.type === 'decorated_definition') {
          funcNode = child.children.find(c => c.type === 'function_definition');
          funcOuter = child;
          if (!funcNode) continue;
        }
        if (funcNode.type === 'function_definition') {
          const methodName = funcNode.childForFieldName('name');
          if (!methodName) continue;
          const params = funcNode.childForFieldName('parameters');
          methods.push({
            name: methodName.text,
            lineFrom: funcOuter.startPosition.row + 1,
            lineTo: funcOuter.endPosition.row + 1,
            signature: `${methodName.text}(${params ? params.text.slice(1, -1) : ''})`,
            sourceCode: content.substring(funcOuter.startIndex, funcOuter.endIndex),
            isMethod: true,
            className
          });
        }
      }
    }

    classes.push({
      name: className,
      lineFrom: outerNode.startPosition.row + 1,
      lineTo: outerNode.endPosition.row + 1,
      sourceCode: content.substring(outerNode.startIndex, outerNode.endIndex),
      methods
    });
  },

  /**
   * Extract a standalone function definition.
   * @private
   */
  _extractFunction(node, outerNode, content, functions) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const params = node.childForFieldName('parameters');

    functions.push({
      name: nameNode.text,
      lineFrom: outerNode.startPosition.row + 1,
      lineTo: outerNode.endPosition.row + 1,
      signature: `${nameNode.text}(${params ? params.text.slice(1, -1) : ''})`,
      sourceCode: content.substring(outerNode.startIndex, outerNode.endIndex),
      isMethod: false,
      className: null
    });
  }
};

export default plugin;
