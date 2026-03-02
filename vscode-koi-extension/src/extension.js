const vscode = require('vscode');
const KoiDefinitionProvider = require('./definitionProvider');

/**
 * Extension activation
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('Koi Language extension is now active');

  // Register Definition Provider for Go to Definition (Cmd+Click / Ctrl+Click)
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'koi', scheme: 'file' },
    new KoiDefinitionProvider()
  );

  context.subscriptions.push(definitionProvider);

  console.log('Koi Definition Provider registered');
}

/**
 * Extension deactivation
 */
function deactivate() {
  console.log('Koi Language extension deactivated');
}

module.exports = {
  activate,
  deactivate
};
