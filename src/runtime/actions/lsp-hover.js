import path from 'path';

export default {
  type: 'lsp_hover',
  intent: 'lsp_hover',
  description: 'Get type information and documentation for a symbol at a position using LSP hover. Fields: "file" (path), "line" (1-based), "character" (1-based). Returns: { success, contents } where contents is the hover text (type signature, docs).',
  thinkingHint: 'Getting type info',
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      file:      { type: 'string', description: 'Path to the source file' },
      line:      { type: 'number', description: 'Line number (1-based)' },
      character: { type: 'number', description: 'Column number (1-based)' }
    },
    required: ['file', 'line', 'character']
  },

  examples: [
    { actionType: 'direct', intent: 'lsp_hover', file: 'src/app.ts', line: 20, character: 12 }
  ],

  async execute(action, agent) {
    const lspManager = globalThis.lspManager;
    if (!lspManager) {
      return { success: false, reason: 'LSP not available' };
    }

    if (!lspManager._projectRoot) {
      lspManager._projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    }

    const filePath = path.resolve(action.file);
    const client = await lspManager.getClientForFile(filePath);
    if (!client) {
      return { success: false, reason: `No LSP server available for ${path.extname(filePath)} files` };
    }

    try {
      const uri = await client.ensureDocumentOpen(filePath);

      const result = await client.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position: {
          line: action.line - 1,
          character: action.character - 1
        }
      });

      if (!result || !result.contents) {
        return { success: true, contents: null };
      }

      // Normalize contents — can be MarkupContent, MarkedString, or MarkedString[]
      const contents = result.contents;
      let text;

      if (typeof contents === 'string') {
        text = contents;
      } else if (contents.value !== undefined) {
        // MarkupContent { kind, value } or MarkedString { language, value }
        text = contents.value;
      } else if (Array.isArray(contents)) {
        text = contents.map(c => {
          if (typeof c === 'string') return c;
          if (c.value !== undefined) return c.value;
          return JSON.stringify(c);
        }).join('\n\n');
      } else {
        text = JSON.stringify(contents);
      }

      return { success: true, contents: text };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }
};
