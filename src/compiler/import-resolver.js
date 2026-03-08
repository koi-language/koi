import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TypeScriptTranspiler } from './typescript-transpiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves imports recursively and merges imported Skills and Agents into the main AST
 */
export class ImportResolver {
  constructor(parse) {
    this.parse = parse;
    this.processedFiles = new Set(); // Files already fully resolved (shared deps → skip silently)
    this.importStack = new Set();   // Files currently being processed (ancestors → true circular)
    this.importedSkills = []; // Collect all imported Skills
    this.importedAgents = []; // Collect all imported Agents
    this.importedRoles = []; // Collect all imported Roles
    this.importedTeams = []; // Collect all imported Teams
    this.importedPrompts = []; // Collect all imported exported Prompts
    this.externalImports = []; // Track TypeScript/JavaScript imports
    this.tsTranspiler = new TypeScriptTranspiler(); // TypeScript transpiler
  }

  /**
   * Resolve all imports in an AST recursively
   * @param {object} ast - The AST to process
   * @param {string} sourceFile - The source file path (for resolving relative paths)
   * @returns {object} - AST with imports resolved and all declarations merged
   */
  async resolveImports(ast, sourceFile) {
    // Track this file as currently being processed (for circular detection)
    this.importStack.add(sourceFile);

    const sourceDir = path.dirname(sourceFile);
    const imports = [];
    const nonImportDecls = [];

    // Separate imports from other declarations
    for (const decl of ast.declarations) {
      if (decl.type === 'ImportDecl') {
        imports.push(decl);
      } else {
        nonImportDecls.push(decl);
      }
    }

    // Process each import
    for (const importDecl of imports) {
      const importPath = (importDecl.what === 'named_import' || importDecl.what === 'typed_import')
        ? importDecl.path.value
        : importDecl.name.value;
      const resolvedPath = this.resolveImportPath(importPath, sourceDir, sourceFile);

      // Handle typed imports: `import name: Type from "path"`
      // When Type is Prompt, read the file as plain text — UNLESS it's a .koi file,
      // which must be parsed so that compose prompts become functions, not strings.
      if (importDecl.what === 'typed_import') {
        const importTypeName = importDecl.importType.name;
        if (importTypeName === 'prompt') {
          const typedExt = path.extname(resolvedPath);
          if (typedExt !== '.koi') {
            // Non-.koi files (e.g. .md, .prompt, .txt): read as plain text
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            const promptName = importDecl.name.name;
            const exists = this.importedPrompts.find(p => p.name.name === promptName);
            if (!exists) {
              this.importedPrompts.push({
                type: 'PromptDecl',
                exported: true,
                name: { name: promptName },
                params: [],
                content: { type: 'StringLiteral', value: content },
              });
            }
            // Track files so their content is included in the source fingerprint
            this.processedFiles.add(resolvedPath);
            continue;
          }
          // .koi files: fall through to the normal parse-and-extract path below
        } else {
          throw new Error(`Unknown import type "${importTypeName}" in typed import. Supported types: prompt`);
        }
      }

      // Handle .prompt files imported without a type annotation — plain text, derive name from filename
      const ext = path.extname(resolvedPath);
      if (ext === '.prompt') {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        let promptName;
        if (importDecl.what === 'named_import') {
          promptName = importDecl.name.name;
        } else {
          const basename = path.basename(resolvedPath, '.prompt');
          promptName = basename.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
        }
        const exists = this.importedPrompts.find(p => p.name.name === promptName);
        if (!exists) {
          this.importedPrompts.push({
            type: 'PromptDecl',
            exported: true,
            name: { name: promptName },
            params: [],
            content: { type: 'StringLiteral', value: content },
          });
        }
        // Track .prompt files so their content is included in the source fingerprint
        this.processedFiles.add(resolvedPath);
        continue;
      }

      // Check if this is an external (TypeScript/JavaScript) import
      const isExternalImport = ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext);

      if (isExternalImport) {
        // Handle TypeScript/JavaScript imports
        let finalPath = resolvedPath;

        // Transpile TypeScript files to JavaScript
        if (ext === '.ts' || ext === '.tsx') {
          try {
            finalPath = this.tsTranspiler.transpile(resolvedPath);
          } catch (error) {
            throw new Error(`Failed to transpile TypeScript file "${importPath}": ${error.message}`);
          }
        }

        if (!this.externalImports.find(e => e.resolvedPath === finalPath)) {
          this.externalImports.push({
            originalPath: importPath,
            resolvedPath: finalPath,
            sourceFile: sourceFile,
            isTypeScript: ext === '.ts' || ext === '.tsx'
          });
        }
        continue;
      }

      // True circular: file is an ancestor in the current resolution chain
      if (this.importStack.has(resolvedPath)) {
        console.warn(`⚠️  Circular import detected and skipped: ${importPath}`);
        continue;
      }

      // Shared dependency: already fully resolved by another branch — skip silently
      if (this.processedFiles.has(resolvedPath)) {
        continue;
      }

      // Mark as fully processed before recursing (prevents re-entry)
      this.processedFiles.add(resolvedPath);

      try {
        // Load and parse the imported file
        const importedSource = fs.readFileSync(resolvedPath, 'utf-8');
        const importedAst = this.parse(importedSource);

        // Recursively resolve imports in the imported file
        const resolvedImportedAst = await this.resolveImports(importedAst, resolvedPath);

        // Extract declarations from imported file
        // Use the original importedAst to get local declarations only (not transitive imports)
        const localDecls = importedAst.declarations.filter(d => d.type !== 'ImportDecl');

        // Track agents and non-exported prompts from this file
        const localAgents = [];
        const localNonExportedPrompts = [];

        for (const decl of localDecls) {
          // Add to global collections, avoiding duplicates
          if (decl.type === 'SkillDecl') {
            const existingSkill = this.importedSkills.find(s => s.name.name === decl.name.name);
            if (!existingSkill) {
              this.importedSkills.push(decl);
            }
          } else if (decl.type === 'AgentDecl') {
            const existingAgent = this.importedAgents.find(a => a.name.name === decl.name.name);
            if (!existingAgent) {
              this.importedAgents.push(decl);
              localAgents.push(decl);
            }
          } else if (decl.type === 'RoleDecl') {
            const existingRole = this.importedRoles.find(r => r.name.name === decl.name.name);
            if (!existingRole) {
              this.importedRoles.push(decl);
            }
          } else if (decl.type === 'TeamDecl') {
            const existingTeam = this.importedTeams.find(t => t.name.name === decl.name.name);
            if (!existingTeam) {
              this.importedTeams.push(decl);
            }
          } else if (decl.type === 'PromptDecl') {
            if (decl.exported) {
              // Exported prompts: globally visible (public)
              const exists = this.importedPrompts.find(p => p.name.name === decl.name.name);
              if (!exists) {
                this.importedPrompts.push(decl);
              }
            } else {
              // Non-exported prompts: file-scoped (private, only for agents in same file)
              localNonExportedPrompts.push(decl);
            }
          }
        }

        // Attach non-exported prompts to agents from the same file
        // so the transpiler can scope them in an IIFE (file-level visibility)
        if (localNonExportedPrompts.length > 0) {
          for (const agent of localAgents) {
            agent._localPrompts = localNonExportedPrompts;
          }
        }
      } catch (error) {
        // Preserve location info from PEG.js parse errors so the top-level
        // handler can print file + line/column instead of a generic message.
        // Use the innermost sourceFile/location so nested import errors always
        // point to the file where the actual syntax error is, not the importer.
        const loc = error.location;
        const locStr = loc ? ` (Line ${loc.start.line}, Column ${loc.start.column})` : '';
        const err = new Error(`Failed to import from "${resolvedPath}"${locStr}: ${error.message}`);
        if (loc) err.location = loc;
        err.sourceFile = error.sourceFile || resolvedPath;
        throw err;
      }
    }

    // Remove from import stack now that this file is fully resolved
    this.importStack.delete(sourceFile);

    // Merge imported declarations with current declarations
    // Order: Roles -> Skills -> Prompts -> Agents -> Teams -> Other
    const mergedDeclarations = [
      ...this.importedRoles,
      ...this.importedSkills,
      ...this.importedPrompts,
      ...this.importedAgents,
      ...this.importedTeams,
      ...nonImportDecls
    ];

    return {
      ...ast,
      declarations: mergedDeclarations
    };
  }

  /**
   * Resolve import path - supports relative paths, absolute paths, and node_modules
   * @param {string} importPath - The import path from the import statement
   * @param {string} sourceDir - The directory of the source file
   * @param {string} sourceFile - The full source file path
   * @returns {string} - Absolute path to the imported file
   */
  resolveImportPath(importPath, sourceDir, sourceFile) {
    // 1. Relative paths (./ or ../)
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const resolved = this.resolveRelativePath(importPath, sourceDir);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      throw new Error(`Import file not found: ${resolved}`);
    }

    // 2. Absolute paths
    if (path.isAbsolute(importPath)) {
      if (fs.existsSync(importPath)) {
        return importPath;
      }
      throw new Error(`Import file not found: ${importPath}`);
    }

    // 3. Package imports (from node_modules)
    const packageResolved = this.resolveFromNodeModules(importPath, sourceDir);
    if (packageResolved) {
      return packageResolved;
    }

    throw new Error(`Cannot resolve import: ${importPath}`);
  }

  /**
   * Resolve a relative path, trying different extensions and directory index
   */
  resolveRelativePath(importPath, sourceDir) {
    const basePath = path.resolve(sourceDir, importPath);

    // 1. Try exact path first
    if (fs.existsSync(basePath)) {
      // If it's a file, return it
      if (fs.statSync(basePath).isFile()) {
        return basePath;
      }
      // If it's a directory, try index files
      if (fs.statSync(basePath).isDirectory()) {
        // Try index.koi first
        const indexKoi = path.join(basePath, 'index.koi');
        if (fs.existsSync(indexKoi)) {
          return indexKoi;
        }
        // Try index.ts
        const indexTs = path.join(basePath, 'index.ts');
        if (fs.existsSync(indexTs)) {
          return indexTs;
        }
        // Try index.js
        const indexJs = path.join(basePath, 'index.js');
        if (fs.existsSync(indexJs)) {
          return indexJs;
        }
      }
    }

    // 2. Try with different extensions if no extension provided
    if (!path.extname(basePath)) {
      const extensions = ['.koi', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
      for (const ext of extensions) {
        const withExt = basePath + ext;
        if (fs.existsSync(withExt)) {
          return withExt;
        }
      }
    }

    // 3. Try as directory with index files
    const indexKoi = path.join(basePath, 'index.koi');
    if (fs.existsSync(indexKoi)) {
      return indexKoi;
    }
    const indexTs = path.join(basePath, 'index.ts');
    if (fs.existsSync(indexTs)) {
      return indexTs;
    }
    const indexJs = path.join(basePath, 'index.js');
    if (fs.existsSync(indexJs)) {
      return indexJs;
    }

    return basePath;
  }

  /**
   * Resolve from node_modules, checking each parent directory
   */
  resolveFromNodeModules(packageName, sourceDir) {
    let currentDir = sourceDir;

    // Walk up the directory tree looking for node_modules
    while (true) {
      const nodeModulesPath = path.join(currentDir, 'node_modules', packageName);

      // Try to resolve the package
      const resolved = this.resolvePackage(nodeModulesPath, packageName);
      if (resolved) {
        return resolved;
      }

      // Move to parent directory
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached root, stop
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  /**
   * Resolve a package, checking package.json for main/exports
   */
  resolvePackage(packagePath, packageName) {
    // Check if package directory exists
    if (!fs.existsSync(packagePath)) {
      return null;
    }

    // Try package.json
    const packageJsonPath = path.join(packagePath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Check "koi" field (custom field for Koi packages)
        if (packageJson.koi) {
          const koiEntry = path.join(packagePath, packageJson.koi);
          if (fs.existsSync(koiEntry)) {
            return koiEntry;
          }
        }

        // Check "main" field
        if (packageJson.main) {
          const mainPath = path.join(packagePath, packageJson.main);
          if (fs.existsSync(mainPath)) {
            return mainPath;
          }
        }

        // Check "exports" field (modern Node.js)
        if (packageJson.exports) {
          const exports = packageJson.exports;
          if (typeof exports === 'string') {
            const exportPath = path.join(packagePath, exports);
            if (fs.existsSync(exportPath)) {
              return exportPath;
            }
          } else if (exports['.']) {
            const defaultExport = typeof exports['.'] === 'string' ? exports['.'] : exports['.'].default;
            if (defaultExport) {
              const exportPath = path.join(packagePath, defaultExport);
              if (fs.existsSync(exportPath)) {
                return exportPath;
              }
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️  Failed to parse package.json for ${packageName}: ${error.message}`);
      }
    }

    // Try index files in order: .koi, .ts, .js
    const indexKoi = path.join(packagePath, 'index.koi');
    if (fs.existsSync(indexKoi)) {
      return indexKoi;
    }

    const indexTs = path.join(packagePath, 'index.ts');
    if (fs.existsSync(indexTs)) {
      return indexTs;
    }

    const indexJs = path.join(packagePath, 'index.js');
    if (fs.existsSync(indexJs)) {
      return indexJs;
    }

    // Try packageName with extensions
    const namedKoi = path.join(packagePath, `${packageName}.koi`);
    if (fs.existsSync(namedKoi)) {
      return namedKoi;
    }

    const namedTs = path.join(packagePath, `${packageName}.ts`);
    if (fs.existsSync(namedTs)) {
      return namedTs;
    }

    const namedJs = path.join(packagePath, `${packageName}.js`);
    if (fs.existsSync(namedJs)) {
      return namedJs;
    }

    return null;
  }

  /**
   * Reset the resolver state
   */
  reset() {
    this.processedFiles.clear();
    this.importStack.clear();
    this.importedSkills = [];
    this.importedAgents = [];
    this.importedRoles = [];
    this.importedTeams = [];
    this.importedPrompts = [];
    this.externalImports = [];
  }
}
