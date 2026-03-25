import path from 'path';

export default {
  type: 'lsp_find_references',
  intent: 'lsp_find_references',
  description: 'Find all references to a symbol using the Language Server Protocol. Semantic analysis, not text search — finds actual usages, not string matches. Fields: "file" (path), "line" (1-based), "character" (1-based). Returns: { success, references: [{ file, line, character }], count }.',
  thinkingHint: 'Finding references',
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
    { actionType: 'direct', intent: 'lsp_find_references', file: 'src/utils.ts', line: 15, character: 10 }
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

      const result = await client.sendRequest('textDocument/references', {
        textDocument: { uri },
        position: {
          line: action.line - 1,
          character: action.character - 1
        },
        context: { includeDeclaration: true }
      });

      if (!result || !Array.isArray(result)) {
        return { success: true, references: [], count: 0 };
      }

      const projectRoot = lspManager._projectRoot;

      const references = result.map(loc => {
        let refFile = loc.uri;
        if (refFile && refFile.startsWith('file://')) {
          refFile = decodeURIComponent(refFile.replace('file://', ''));
          if (refFile.startsWith(projectRoot)) {
            refFile = path.relative(projectRoot, refFile);
          }
        }
        return {
          file: refFile,
          line: (loc.range?.start?.line ?? 0) + 1,
          character: (loc.range?.start?.character ?? 0) + 1
        };
      });

      return { success: true, references, count: references.length };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }
};
