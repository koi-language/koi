import path from 'path';

const SYMBOL_KIND = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package',
  5: 'Class', 6: 'Method', 7: 'Property', 8: 'Field',
  9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function',
  13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
  21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event',
  25: 'Operator', 26: 'TypeParameter'
};

export default {
  type: 'lsp_workspace_symbols',
  intent: 'lsp_workspace_symbols',
  description: 'Search for symbols (classes, functions, variables, etc.) across the entire workspace using LSP. Faster and more accurate than grep for finding code constructs. Fields: "query" (search string, can be partial). Returns: { success, symbols: [{ name, kind, file, line, containerName }] }.',
  thinkingHint: 'Searching symbols',
  permission: 'use_lsp',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name or partial name to search for' }
    },
    required: ['query']
  },

  examples: [
    { actionType: 'direct', intent: 'lsp_workspace_symbols', query: 'ActionRegistry' },
    { actionType: 'direct', intent: 'lsp_workspace_symbols', query: 'handle' }
  ],

  async execute(action, agent) {
    const lspManager = globalThis.lspManager;
    if (!lspManager) {
      return { success: false, reason: 'LSP not available' };
    }

    if (!lspManager._projectRoot) {
      lspManager._projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    }

    // We need a client — use any detected language or try to pick one
    const languages = lspManager.detectLanguages(lspManager._projectRoot);
    if (languages.length === 0) {
      return { success: false, reason: 'No supported languages detected in project' };
    }

    // Try each detected language until we get a working client
    let client = null;
    for (const lang of languages) {
      // Create a dummy file path with the right extension to trigger client creation
      const config = { typescript: '.ts', python: '.py', rust: '.rs', go: '.go' };
      const ext = config[lang] || '.txt';
      const dummyPath = path.join(lspManager._projectRoot, `__dummy${ext}`);
      client = await lspManager.getClientForFile(dummyPath);
      if (client) break;
    }

    if (!client) {
      return { success: false, reason: 'Could not start any LSP server' };
    }

    try {
      const result = await client.sendRequest('workspace/symbol', {
        query: action.query
      });

      if (!result || !Array.isArray(result)) {
        return { success: true, symbols: [] };
      }

      const projectRoot = lspManager._projectRoot;

      const symbols = result.map(sym => {
        const location = sym.location;
        let symFile = location?.uri || '';
        if (symFile.startsWith('file://')) {
          symFile = decodeURIComponent(symFile.replace('file://', ''));
          if (symFile.startsWith(projectRoot)) {
            symFile = path.relative(projectRoot, symFile);
          }
        }

        return {
          name: sym.name,
          kind: SYMBOL_KIND[sym.kind] || `Unknown(${sym.kind})`,
          file: symFile,
          line: (location?.range?.start?.line ?? 0) + 1,
          containerName: sym.containerName || null
        };
      });

      return { success: true, symbols };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }
};
