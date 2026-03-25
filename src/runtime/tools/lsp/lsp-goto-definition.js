import path from 'path';
import { pathToUri } from '../../lsp/lsp-client.js';

export default {
  type: 'lsp_goto_definition',
  intent: 'lsp_goto_definition',
  description: 'Go to the definition of a symbol using the Language Server Protocol. Provides precise, semantic navigation (not text search). Fields: "file" (path to the file), "line" (1-based line number), "character" (1-based column). Returns: { success, definitions: [{ file, line, character }] }. Falls back gracefully if no LSP server is available.',
  thinkingHint: 'Finding definition',
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
    { actionType: 'direct', intent: 'lsp_goto_definition', file: 'src/index.ts', line: 10, character: 5 }
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

      const result = await client.sendRequest('textDocument/definition', {
        textDocument: { uri },
        position: {
          line: action.line - 1,       // Convert 1-based to 0-based
          character: action.character - 1
        }
      });

      if (!result) {
        return { success: true, definitions: [] };
      }

      // Normalize: result can be Location, Location[], or LocationLink[]
      const locations = Array.isArray(result) ? result : [result];
      const projectRoot = lspManager._projectRoot;

      const definitions = locations.map(loc => {
        const targetUri = loc.targetUri || loc.uri;
        const range = loc.targetRange || loc.range;
        let defFile = targetUri;
        if (targetUri && targetUri.startsWith('file://')) {
          defFile = decodeURIComponent(targetUri.replace('file://', ''));
          // Make relative to project root
          if (defFile.startsWith(projectRoot)) {
            defFile = path.relative(projectRoot, defFile);
          }
        }
        return {
          file: defFile,
          line: (range?.start?.line ?? 0) + 1,       // Convert 0-based to 1-based
          character: (range?.start?.character ?? 0) + 1
        };
      });

      return { success: true, definitions };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }
};
