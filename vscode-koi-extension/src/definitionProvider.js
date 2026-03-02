const vscode = require('vscode');
const path = require('path');

/**
 * Provides "Go to Definition" functionality for Koi language
 * Supports: Skills, Agents, Roles, Teams
 */
class KoiDefinitionProvider {
  provideDefinition(document, position, token) {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }

    const word = document.getText(wordRange);
    const line = document.lineAt(position.line).text;

    // Check if this is a reference to a Skill, Agent, Role, or Team
    const context = this.getContext(line, word);
    if (!context) {
      return null;
    }

    // Search for the definition in the current file and imported files
    return this.findDefinition(document, word, context.type);
  }

  /**
   * Determine the context of the symbol (Skill, Agent, Role, Team)
   */
  getContext(line, word) {
    // uses skill <word> or uses skill A, B, <word>
    if (/uses\s+skill\s+[\w\s,]+/i.test(line)) {
      const usesSkillMatch = line.match(/uses\s+skill\s+([\w\s,]+)/i);
      if (usesSkillMatch) {
        const skillNames = usesSkillMatch[1].split(',').map(s => s.trim());
        if (skillNames.includes(word)) {
          return { type: 'Skill' };
        }
      }
    }

    // uses team <word> or uses team A, B, <word>
    if (/uses\s+team\s+[\w\s,]+/i.test(line)) {
      const usesTeamMatch = line.match(/uses\s+team\s+([\w\s,]+)/i);
      if (usesTeamMatch) {
        const teamNames = usesTeamMatch[1].split(',').map(s => s.trim());
        if (teamNames.includes(word)) {
          return { type: 'Team' };
        }
      }
    }

    // uses mcp <word> or uses mcp A, B, <word>
    if (/uses\s+mcp\s+[\w\s,]+/i.test(line)) {
      const usesMCPMatch = line.match(/uses\s+mcp\s+([\w\s,]+)/i);
      if (usesMCPMatch) {
        const mcpNames = usesMCPMatch[1].split(',').map(s => s.trim());
        if (mcpNames.includes(word)) {
          return { type: 'MCP' };
        }
      }
    }

    // agent <name> : <word> (role reference)
    if (/agent\s+\w+\s*:\s*\w+/i.test(line) && line.includes(word)) {
      return { type: 'Role' };
    }

    // team <name> { member: <word> } or member = <word> (agent reference)
    if (/\w+\s*[:=]\s*\w+/.test(line) && line.includes(word)) {
      return { type: 'Agent' };
    }

    // send peers.event(...).role(<word>)
    if (/role\s*\(\s*\w+\s*\)/.test(line) && line.includes(word)) {
      return { type: 'Role' };
    }

    return null;
  }

  /**
   * Find the definition of a symbol in the document
   */
  async findDefinition(document, symbolName, symbolType) {
    const locations = [];

    // Search in current file
    const currentFileLocation = this.searchInDocument(document, symbolName, symbolType);
    if (currentFileLocation) {
      locations.push(currentFileLocation);
    }

    // Search in imported files
    const importedLocations = await this.searchInImports(document, symbolName, symbolType);
    locations.push(...importedLocations);

    return locations.length > 0 ? locations : null;
  }

  /**
   * Search for definition in a single document
   */
  searchInDocument(document, symbolName, symbolType) {
    const text = document.getText();
    const lines = text.split('\n');

    // Build regex pattern based on symbol type
    let pattern;
    switch (symbolType) {
      case 'Skill':
        pattern = new RegExp(`^\\s*[Ss]kill\\s+${symbolName}\\s*\\{`, 'm');
        break;
      case 'Agent':
        pattern = new RegExp(`^\\s*[Aa]gent\\s+${symbolName}\\s*:`, 'm');
        break;
      case 'Role':
        pattern = new RegExp(`^\\s*role\\s+${symbolName}\\s*\\{`, 'mi');
        break;
      case 'Team':
        pattern = new RegExp(`^\\s*[Tt]eam\\s+${symbolName}\\s*\\{`, 'm');
        break;
      case 'MCP':
        pattern = new RegExp(`^\\s*mcp\\s+${symbolName}\\s*=`, 'mi');
        break;
      default:
        return null;
    }

    // Find the line number
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        return new vscode.Location(
          document.uri,
          new vscode.Position(i, lines[i].indexOf(symbolName))
        );
      }
    }

    return null;
  }

  /**
   * Search for definition in imported files
   */
  async searchInImports(document, symbolName, symbolType) {
    const locations = [];
    const text = document.getText();
    const importRegex = /import\s+"([^"]+)"/g;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (!workspaceFolder) {
      return locations;
    }

    let match;
    while ((match = importRegex.exec(text)) !== null) {
      const importPath = match[1];

      // Resolve the import path
      const resolvedPath = this.resolveImportPath(
        importPath,
        path.dirname(document.uri.fsPath),
        workspaceFolder.uri.fsPath
      );

      if (!resolvedPath) {
        continue;
      }

      try {
        const importedDoc = await vscode.workspace.openTextDocument(resolvedPath);
        const location = this.searchInDocument(importedDoc, symbolName, symbolType);
        if (location) {
          locations.push(location);
        }
      } catch (error) {
        // File not found or can't be opened
        continue;
      }
    }

    return locations;
  }

  /**
   * Resolve import path to absolute file path
   */
  resolveImportPath(importPath, currentDir, workspaceRoot) {
    // Relative path
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      let resolved = path.resolve(currentDir, importPath);

      // Try with .koi extension
      if (!resolved.endsWith('.koi')) {
        if (require('fs').existsSync(resolved + '.koi')) {
          return resolved + '.koi';
        }
        // Try index.koi in directory
        const indexPath = path.join(resolved, 'index.koi');
        if (require('fs').existsSync(indexPath)) {
          return indexPath;
        }
      }

      if (require('fs').existsSync(resolved)) {
        return resolved;
      }
    }

    // Absolute path
    if (path.isAbsolute(importPath)) {
      if (require('fs').existsSync(importPath)) {
        return importPath;
      }
    }

    // npm package (node_modules)
    const nodeModulesPath = path.join(workspaceRoot, 'node_modules', importPath);
    if (require('fs').existsSync(nodeModulesPath)) {
      // Try package.json
      const packageJsonPath = path.join(nodeModulesPath, 'package.json');
      if (require('fs').existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf-8'));
          if (packageJson.koi) {
            const koiPath = path.join(nodeModulesPath, packageJson.koi);
            if (require('fs').existsSync(koiPath)) {
              return koiPath;
            }
          }
          if (packageJson.main) {
            const mainPath = path.join(nodeModulesPath, packageJson.main);
            if (require('fs').existsSync(mainPath)) {
              return mainPath;
            }
          }
        } catch (error) {
          // Invalid package.json
        }
      }

      // Try index.koi
      const indexPath = path.join(nodeModulesPath, 'index.koi');
      if (require('fs').existsSync(indexPath)) {
        return indexPath;
      }
    }

    return null;
  }
}

module.exports = KoiDefinitionProvider;
