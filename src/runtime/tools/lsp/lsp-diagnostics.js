import path from 'path';

const SEVERITY_MAP = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint'
};

export default {
  type: 'lsp_diagnostics',
  intent: 'lsp_diagnostics',
  description: 'Get compiler/linter diagnostics (errors, warnings) from the LSP server. No file means all diagnostics. Fields: optional "file" (path to check). Returns: { success, diagnostics: { [file]: [{ line, character, severity, message, source }] } }.',
  thinkingHint: 'Checking diagnostics',
  permission: 'use_lsp',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to file (omit for all diagnostics)' }
    },
    required: []
  },

  examples: [
    { actionType: 'direct', intent: 'lsp_diagnostics', file: 'src/index.ts' },
    { actionType: 'direct', intent: 'lsp_diagnostics' }
  ],

  async execute(action, agent) {
    const lspManager = globalThis.lspManager;
    if (!lspManager) {
      return { success: false, reason: 'LSP not available' };
    }

    if (!lspManager._projectRoot) {
      lspManager._projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    }

    const projectRoot = lspManager._projectRoot;

    if (action.file) {
      // Diagnostics for a specific file
      const filePath = path.resolve(action.file);
      const client = await lspManager.getClientForFile(filePath);
      if (!client) {
        return { success: false, reason: `No LSP server available for ${path.extname(filePath)} files` };
      }

      // Ensure the document is open so the server analyzes it
      await client.ensureDocumentOpen(filePath);

      // Give the server a moment to produce diagnostics
      await new Promise(resolve => setTimeout(resolve, 1000));

      const { pathToUri } = await import('../../lsp/lsp-client.js');
      const uri = pathToUri(filePath);
      const diags = client.getDiagnostics(uri);

      let relFile = filePath;
      if (filePath.startsWith(projectRoot)) {
        relFile = path.relative(projectRoot, filePath);
      }

      const formatted = (Array.isArray(diags) ? diags : []).map(d => ({
        line: (d.range?.start?.line ?? 0) + 1,
        character: (d.range?.start?.character ?? 0) + 1,
        severity: SEVERITY_MAP[d.severity] || 'unknown',
        message: d.message,
        source: d.source || null
      }));

      return {
        success: true,
        diagnostics: { [relFile]: formatted }
      };
    }

    // All diagnostics from all active clients
    const allDiagnostics = {};

    for (const [language, client] of lspManager._clients) {
      if (!client.initialized) continue;

      const clientDiags = client.getDiagnostics();
      for (const [file, diags] of Object.entries(clientDiags)) {
        let relFile = file;
        if (file.startsWith(projectRoot)) {
          relFile = path.relative(projectRoot, file);
        }

        allDiagnostics[relFile] = diags.map(d => ({
          line: (d.range?.start?.line ?? 0) + 1,
          character: (d.range?.start?.character ?? 0) + 1,
          severity: SEVERITY_MAP[d.severity] || 'unknown',
          message: d.message,
          source: d.source || null
        }));
      }
    }

    return { success: true, diagnostics: allDiagnostics };
  }
};
