import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Transpile TypeScript files to JavaScript
 */
export class TypeScriptTranspiler {
  constructor() {
    // Default TypeScript compiler options
    this.compilerOptions = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
      declaration: false,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      removeComments: false,
      preserveConstEnums: true,
      strict: false,
      noImplicitAny: false
    };
  }

  /**
   * Transpile a TypeScript file to JavaScript
   * @param {string} tsFilePath - Path to the TypeScript file
   * @param {string} outputPath - Optional output path (defaults to same directory with .js extension)
   * @returns {string} - Path to the generated JavaScript file
   */
  transpile(tsFilePath, outputPath = null) {
    // Read TypeScript source
    const tsSource = fs.readFileSync(tsFilePath, 'utf-8');

    // Determine output path
    if (!outputPath) {
      outputPath = tsFilePath.replace(/\.tsx?$/, '.js');
    }

    // Check if JS file exists and is newer than TS file
    if (fs.existsSync(outputPath)) {
      const tsStats = fs.statSync(tsFilePath);
      const jsStats = fs.statSync(outputPath);
      if (jsStats.mtime > tsStats.mtime) {
        // JS file is up to date
        return outputPath;
      }
    }

    // Transpile TypeScript to JavaScript
    const result = ts.transpileModule(tsSource, {
      compilerOptions: this.compilerOptions,
      fileName: path.basename(tsFilePath)
    });

    // Write output
    fs.writeFileSync(outputPath, result.outputText);

    return outputPath;
  }

  /**
   * Transpile multiple TypeScript files
   * @param {string[]} tsFilePaths - Array of TypeScript file paths
   * @returns {Map<string, string>} - Map of original path to transpiled path
   */
  transpileMultiple(tsFilePaths) {
    const resultMap = new Map();

    for (const tsPath of tsFilePaths) {
      try {
        const jsPath = this.transpile(tsPath);
        resultMap.set(tsPath, jsPath);
      } catch (error) {
        console.warn(`⚠️  Failed to transpile ${tsPath}: ${error.message}`);
      }
    }

    return resultMap;
  }

  /**
   * Load TypeScript config from tsconfig.json if available
   * @param {string} projectDir - Project directory to search for tsconfig.json
   */
  loadTsConfig(projectDir) {
    const tsconfigPath = this.findTsConfig(projectDir);

    if (tsconfigPath) {
      try {
        const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
        if (configFile.error) {
          console.warn(`⚠️  Error reading tsconfig.json: ${configFile.error.messageText}`);
          return;
        }

        const parsedConfig = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          path.dirname(tsconfigPath)
        );

        if (parsedConfig.errors.length > 0) {
          console.warn(`⚠️  Error parsing tsconfig.json:`, parsedConfig.errors[0].messageText);
          return;
        }

        // Merge with default options
        this.compilerOptions = {
          ...this.compilerOptions,
          ...parsedConfig.options
        };
      } catch (error) {
        console.warn(`⚠️  Failed to load tsconfig.json: ${error.message}`);
      }
    }
  }

  /**
   * Find tsconfig.json by walking up directory tree
   */
  findTsConfig(startDir) {
    let currentDir = startDir;

    while (true) {
      const tsconfigPath = path.join(currentDir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        return tsconfigPath;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached root
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }
}
