import { SourceMapGenerator } from 'source-map';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export class KoiSemanticError extends Error {
  constructor(message, location = null) {
    super(message);
    this.name = 'KoiSemanticError';
    this.location = location;
  }
}

export class KoiTranspiler {
  constructor(sourceFile = 'source.zs', options = {}) {
    this.sourceFile = sourceFile;
    this.sourceMap = new SourceMapGenerator({ file: sourceFile + '.js' });
    this.currentLine = 1;
    this.currentColumn = 0;
    this.indent = 0;
    this.inEventHandler = false;
    this.cacheData = options.cacheData || null; // Build-time optimizations
    this.outputPath = options.outputPath || null;
    this.runtimePath = options.runtimePath || null;
    this.externalImports = options.externalImports || []; // TypeScript/JavaScript imports
  }

  transpile(ast) {
    let code = this.generateProgram(ast);
    return {
      code,
      map: this.sourceMap.toString()
    };
  }

  addMapping(node) {
    if (node?.location) {
      this.sourceMap.addMapping({
        generated: { line: this.currentLine, column: this.currentColumn },
        source: this.sourceFile,
        original: { line: node.location.start.line, column: node.location.start.column - 1 }
      });
    }
  }

  emit(code, node = null) {
    if (node) this.addMapping(node);

    for (const char of code) {
      if (char === '\n') {
        this.currentLine++;
        this.currentColumn = 0;
      } else {
        this.currentColumn++;
      }
    }
    return code;
  }

  getIndent() {
    return '  '.repeat(this.indent);
  }

  /**
   * Generate a safe JavaScript identifier from an import path
   * e.g., "./utils/helpers" -> "utils_helpers"
   *       "lodash" -> "lodash"
   *       "@types/node" -> "types_node"
   */
  generateSafeImportName(importPath) {
    // Remove file extension
    let name = importPath.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');

    // Remove leading ./ and ../
    name = name.replace(/^\.\.?\//g, '');

    // Replace special characters with underscores
    name = name.replace(/[^a-zA-Z0-9_$]/g, '_');

    // Remove leading underscores
    name = name.replace(/^_+/, '');

    // If starts with a number, prepend with underscore
    if (/^\d/.test(name)) {
      name = '_' + name;
    }

    // If empty after sanitization, use a default
    if (!name) {
      name = 'external_module';
    }

    return name;
  }

  // ============================================================
  // Program
  // ============================================================

  generateProgram(node) {
    let code = this.emit(`// Generated from ${this.sourceFile}\n`);

    // Support KOI_RUNTIME_PATH for local development
    // This allows developers to work on Koi itself without reinstalling
    const koiRuntimePath = process.env.KOI_RUNTIME_PATH;

    let runtimeImportPath;
    let routerImportPath;

    if (koiRuntimePath) {
      // Development mode: use local runtime
      const runtimeIndexPath = path.join(koiRuntimePath, 'index.js');
      const routerPath = path.join(koiRuntimePath, 'router.js');

      runtimeImportPath = pathToFileURL(path.resolve(runtimeIndexPath)).href;
      routerImportPath = pathToFileURL(path.resolve(routerPath)).href;

      code += this.emit(`// Using local runtime from KOI_RUNTIME_PATH: ${koiRuntimePath}\n`);
    } else {
      // Production mode: use package imports
      runtimeImportPath = '@koi-language/koi';
      routerImportPath = '@koi-language/koi/router';
    }

    // Store routerImportPath for later use
    this.routerImportPath = routerImportPath;

    code += this.emit(`import { Agent, Team, Skill, Role, Runtime, SkillRegistry, skillSelector, registry, mcpRegistry } from '${runtimeImportPath}';\n`);

    // Add CommonJS compatibility for require() in ES modules
    code += this.emit(`import { createRequire } from 'module';\n`);
    code += this.emit(`const require = createRequire(import.meta.url);\n\n`);

    // Generate imports for external TypeScript/JavaScript modules
    if (this.externalImports && this.externalImports.length > 0) {
      code += this.emit(`// External TypeScript/JavaScript imports\n`);

      for (const extImport of this.externalImports) {
        // Use the resolved path (which points to transpiled .js for TypeScript files)
        let importPath = extImport.originalPath;

        // Check if this is a node_modules package (resolved path contains node_modules)
        const isNodeModule = extImport.resolvedPath.includes('node_modules');

        // For relative imports, recalculate path from output location
        if (extImport.originalPath.startsWith('./') || extImport.originalPath.startsWith('../')) {
          if (this.outputPath) {
            const outputDir = path.dirname(this.outputPath);
            const relPath = path.relative(outputDir, extImport.resolvedPath);
            importPath = relPath.split(path.sep).join('/');
            if (!importPath.startsWith('.')) {
              importPath = './' + importPath;
            }
          }
        } else if (isNodeModule) {
          // For node_modules packages, keep original package name
          importPath = extImport.originalPath;
        } else {
          // For other absolute imports, use resolved path
          importPath = extImport.resolvedPath;
        }

        // Generate a safe identifier from the original import path (not resolved)
        const safeName = this.generateSafeImportName(extImport.originalPath);

        // For node_modules packages, use default import first, then also get named exports
        if (isNodeModule) {
          code += this.emit(`import ${safeName}_default from '${importPath}';\n`);
          code += this.emit(`import * as ${safeName}_named from '${importPath}';\n`);
          // Prefer default export if it exists, otherwise use named exports
          code += this.emit(`const ${safeName} = ${safeName}_default || ${safeName}_named;\n`);
        } else {
          // For local files, use namespace import
          code += this.emit(`import * as ${safeName} from '${importPath}';\n`);
        }

        // Make it available globally
        code += this.emit(`globalThis.${safeName} = ${safeName};\n`);
      }

      code += this.emit(`\n`);
    }

    // Make SkillRegistry, registry, and mcpRegistry available globally
    code += this.emit(`globalThis.SkillRegistry = SkillRegistry;\n`);
    code += this.emit(`globalThis.skillSelector = skillSelector;\n`);
    code += this.emit(`globalThis.registry = registry;\n`);
    code += this.emit(`globalThis.mcpRegistry = mcpRegistry;\n\n`);

    // Inject build-time cache if available
    if (this.cacheData && this.cacheData.affordances) {
      code += this.emit(this.generateCacheCode());
    }

    // Separate run statements from other declarations
    const agentDecls = [];
    const skillDecls = [];
    const runStatements = [];
    const sortableDecls = [];

    for (const decl of node.declarations) {
      if (decl.type === 'RunStatement') {
        runStatements.push(decl);
      } else {
        sortableDecls.push(decl);
        if (decl.type === 'AgentDecl') agentDecls.push(decl);
        else if (decl.type === 'SkillDecl') skillDecls.push(decl);
      }
    }

    // Validate no duplicate top-level declarations (catches role/agent/skill defined twice
    // e.g. when both an imported file and the main file declare the same role name)
    this._validateNoDuplicates(sortableDecls);

    // Generate declarations in dependency order using topological sort.
    // Dependencies:
    //   AgentDecl  → depends on teams from "uses team X" body items
    //   TeamDecl   → depends on its member agents
    //   RoleDecl, SkillDecl, MCPDecl → no deps (generated first)
    this.skipAgentRegistration = true;

    const sorted = this._topologicalSortDeclarations(sortableDecls);
    for (const decl of sorted) {
      code += this.generateDeclaration(decl);
    }

    this.skipAgentRegistration = false;

    // Generate main async function that coordinates everything
    if (agentDecls.length > 0 || skillDecls.length > 0 || runStatements.length > 0) {
      code += this.emit(`\n// Main execution function\n`);
      code += this.emit(`(async () => {\n`);
      this.indent++;

      // Register all agents
      if (agentDecls.length > 0) {
        code += this.emit(`${this.getIndent()}// Register agents with router\n`);
        code += this.emit(`${this.getIndent()}const { agentRouter } = await import('${this.routerImportPath}');\n\n`);

        for (const decl of agentDecls) {
          const agentName = decl.name.name;
          const hasCachedAffordances = this.cacheData && this.cacheData.affordances && this.cacheData.affordances[agentName];

          if (hasCachedAffordances) {
            code += this.emit(`${this.getIndent()}await agentRouter.register(${agentName}, CACHED_AFFORDANCES['${agentName}']);\n`);
          } else {
            code += this.emit(`${this.getIndent()}await agentRouter.register(${agentName});\n`);
          }
        }

        code += this.emit(`\n`);
      }

      // Register all skills with skillSelector
      if (skillDecls.length > 0) {
        code += this.emit(`${this.getIndent()}// Register skills with skillSelector\n`);

        for (const decl of skillDecls) {
          const skillName = decl.name.name;
          const hasCachedAffordance = this.cacheData && this.cacheData.skillAffordances && this.cacheData.skillAffordances[skillName];

          // Get function names for this skill
          const functionNames = decl.functions
            ? decl.functions.filter(f => f.isExport).map(f => f.name.name)
            : [];

          if (functionNames.length > 0) {
            // Build functions array
            code += this.emit(`${this.getIndent()}const ${skillName}Functions = [${functionNames.map(fn => `{ name: '${fn}', fn: ${fn}, description: SkillRegistry.get('${skillName}', '${fn}')?.metadata?.affordance || 'Function from ${skillName}' }`).join(', ')}];\n`);

            // Register with cached affordance if available
            if (hasCachedAffordance) {
              code += this.emit(`${this.getIndent()}await skillSelector.register('${skillName}', ${skillName}Functions, CACHED_SKILL_AFFORDANCES['${skillName}']);\n`);
            } else {
              code += this.emit(`${this.getIndent()}await skillSelector.register('${skillName}', ${skillName}Functions);\n`);
            }
          }
        }

        code += this.emit(`\n`);
      }

      // Execute run statements
      for (const runStmt of runStatements) {
        code += this.generateRunBody(runStmt);
      }

      // Graceful MCP shutdown on signals
      code += this.emit(`${this.getIndent()}const _gracefulShutdown = async () => { await mcpRegistry.disconnectAll(); if (globalThis.lspManager) await globalThis.lspManager.disconnectAll(); process.exit(0); };\n`);
      code += this.emit(`${this.getIndent()}process.on('SIGINT', _gracefulShutdown);\n`);
      code += this.emit(`${this.getIndent()}process.on('SIGTERM', _gracefulShutdown);\n\n`);

      // Clean exit
      code += this.emit(`${this.getIndent()}await mcpRegistry.disconnectAll();\n`);
      code += this.emit(`${this.getIndent()}if (globalThis.lspManager) await globalThis.lspManager.disconnectAll();\n`);
      code += this.emit(`${this.getIndent()}process.stdout.write('\\r\\x1b[K\\x1b[?25h');\n`);
      code += this.emit(`${this.getIndent()}process.exit(0);\n`);

      this.indent--;
      code += this.emit(`})().catch(err => {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}console.error('Error:', err.message);\n`);
      code += this.emit(`${this.getIndent()}process.exit(1);\n`);
      this.indent--;
      code += this.emit(`});\n`);
    }

    return code;
  }

  generateCacheCode() {
    const meta = this.cacheData.metadata;
    let code = this.emit('// ============================================================\n');
    code += this.emit('// Pre-computed Affordances (Build-time Cache)\n');
    code += this.emit(`// Generated at: ${new Date(meta.generatedAt).toISOString()}\n`);
    code += this.emit(`// Total agents: ${meta.totalAgents || 0}\n`);
    code += this.emit(`// Total agent affordances: ${meta.totalAffordances || 0}\n`);
    code += this.emit(`// Total skills: ${meta.totalSkills || 0}\n`);
    code += this.emit(`// Total skill affordances: ${meta.totalSkillAffordances || 0}\n`);
    code += this.emit('// This avoids embedding API calls at runtime\n');
    code += this.emit('// ============================================================\n\n');
    code += this.emit(`const CACHED_AFFORDANCES = ${JSON.stringify(this.cacheData.affordances || {}, null, 2)};\n\n`);
    code += this.emit(`const CACHED_SKILL_AFFORDANCES = ${JSON.stringify(this.cacheData.skillAffordances || {}, null, 2)};\n\n`);
    return code;
  }

  // ============================================================
  // Declaration ordering (topological sort)
  // ============================================================

  /**
   * Extract the name of a declaration node.
   */
  _getDeclName(decl) {
    if (decl.name && decl.name.name) return decl.name.name;
    if (decl.name && typeof decl.name === 'string') return decl.name;
    return null;
  }

  /**
   * Get dependency names for a declaration.
   *   AgentDecl  → depends on teams from "uses team X"
   *   TeamDecl   → depends on its member agents
   *   Others     → no deps
   */
  _getDeclDeps(decl) {
    const deps = [];
    if (decl.type === 'AgentDecl' && decl.body) {
      for (const item of decl.body) {
        if (item.type === 'UsesTeam') {
          const teamName = item.team?.name || (typeof item.team === 'string' ? item.team : null);
          if (teamName) deps.push(teamName);
        }
      }
    } else if (decl.type === 'TeamDecl' && decl.members) {
      for (const member of decl.members) {
        let agentName = null;
        if (member.value?.type === 'AgentReference') {
          agentName = member.value.agent.name;
        } else if (member.value?.type === 'Identifier') {
          agentName = member.value.name;
        }
        if (agentName) deps.push(agentName);
      }
    }
    return deps;
  }

  /**
   * Check for duplicate top-level declarations (same type + same name).
   * Throws a friendly error before generating bad JavaScript.
   * This catches cases like a role declared in both an imported file and the main file.
   */
  _validateNoDuplicates(decls) {
    const NAMED_TYPES = ['RoleDecl', 'AgentDecl', 'SkillDecl', 'TeamDecl', 'PromptDecl', 'MCPDecl'];
    const seen = new Map(); // key: "Type:name" → first declaration

    for (const decl of decls) {
      if (!NAMED_TYPES.includes(decl.type)) continue;
      const name = decl.name?.name;
      if (!name) continue;

      const key = `${decl.type}:${name}`;
      if (seen.has(key)) {
        const typeName = decl.type.replace('Decl', '').toLowerCase();
        throw new KoiSemanticError(
          `'${name}' is already declared (possibly imported from another file). ` +
          `Remove the duplicate declaration or rename one of them.`,
          decl.location
        );
      }
      seen.set(key, decl);
    }
  }

  /**
   * Topological sort of declarations to prevent forward reference errors.
   * Roles, Skills, MCPs have no deps and go first.
   * Agents and Teams are sorted by their dependency graph.
   */
  _topologicalSortDeclarations(decls) {
    // Priority for types without dependencies (lower = earlier)
    const typePriority = { RoleDecl: 0, MCPDecl: 1, SkillDecl: 2, PromptDecl: 3 };

    // Split into no-dep types (always first) and graph-sorted types
    const noDeps = [];
    const graphDecls = [];
    for (const decl of decls) {
      if (typePriority[decl.type] !== undefined) {
        noDeps.push(decl);
      } else if (decl.type === 'AgentDecl' || decl.type === 'TeamDecl') {
        graphDecls.push(decl);
      } else {
        noDeps.push(decl);
      }
    }

    // Sort no-dep types by priority
    noDeps.sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99));

    if (graphDecls.length === 0) return [...noDeps];

    // Build adjacency: name → decl, name → deps
    const nameToDecl = new Map();
    const nameToIdx = new Map();
    for (let i = 0; i < graphDecls.length; i++) {
      const name = this._getDeclName(graphDecls[i]);
      if (name) {
        nameToDecl.set(name, graphDecls[i]);
        nameToIdx.set(name, i);
      }
    }

    // Kahn's algorithm for topological sort
    const inDegree = new Array(graphDecls.length).fill(0);
    const adj = new Array(graphDecls.length).fill(null).map(() => []);

    for (let i = 0; i < graphDecls.length; i++) {
      const deps = this._getDeclDeps(graphDecls[i]);
      for (const dep of deps) {
        const j = nameToIdx.get(dep);
        if (j !== undefined && j !== i) {
          adj[j].push(i); // j must come before i
          inDegree[i]++;
        }
      }
    }

    const queue = [];
    for (let i = 0; i < graphDecls.length; i++) {
      if (inDegree[i] === 0) queue.push(i);
    }

    const sorted = [];
    while (queue.length > 0) {
      const i = queue.shift();
      sorted.push(graphDecls[i]);
      for (const next of adj[i]) {
        inDegree[next]--;
        if (inDegree[next] === 0) queue.push(next);
      }
    }

    // If cycle detected, fall back to original order
    if (sorted.length < graphDecls.length) {
      console.warn('[Transpiler] Circular dependency detected in declarations, using original order');
      return [...noDeps, ...graphDecls];
    }

    return [...noDeps, ...sorted];
  }

  // ============================================================
  // Declarations
  // ============================================================

  generateDeclaration(node) {
    switch (node.type) {
      case 'PackageDecl':
        return ''; // Package declarations are ignored (kept for backwards compatibility)
      case 'ImportDecl':
        return this.generateImport(node);
      case 'RoleDecl':
        return this.generateRole(node);
      case 'TeamDecl':
        return this.generateTeam(node);
      case 'AgentDecl':
        return this.generateAgent(node);
      case 'SkillDecl':
        return this.generateSkill(node);
      case 'MCPDecl':
        return this.generateMCP(node);
      case 'PromptDecl':
        return this.generatePromptDecl(node);
      case 'RunStatement':
        return this.generateRun(node);
      default:
        return this.emit(`/* Unknown declaration: ${node.type} */\n`);
    }
  }

  generatePromptDecl(node) {
    const name = node.name.name;

    if (node.content.type === 'ComposeDecl') {
      const { fragments, template, model } = node.content;
      const composeParams = node.content.params || [];
      const hasComposeParams = composeParams.length > 0;
      const composeParamNames = composeParams.map(p => p.name).join(', ');
      const fragmentsStr = fragments
        .map(f => `    ${JSON.stringify(f.name)}: ${f.ref}`)
        .join(',\n');

      const wrapWithParams = (obj) => {
        if (hasComposeParams) return `(${composeParamNames}) => (${obj})`;
        return obj;
      };

      // Directive-based compose: compile template directly (no LLM, fully deterministic)
      if (this._hasComposeDirectives(template)) {
        const fragmentNames = fragments.map(f => f.name);
        const resolverBody = this._compileComposeTemplate(template, fragmentNames);
        const indentedResolver = resolverBody
          .split('\n')
          .map(line => `    ${line}`)
          .join('\n');
        const composeObj = `{ __isCompose__: true, fragments: {\n${fragmentsStr}\n  }, resolve: async (fragments, callAction, context) => {\n${indentedResolver}\n  } }`;
        return this.emit(
          `const ${name} = ${wrapWithParams(composeObj)};\n\n`,
          node
        );
      }

      // Use compile-time generated resolver if available (preferred: no runtime LLM call)
      const resolverCode = this.cacheData?.composeResolvers?.[name];
      if (resolverCode) {
        // Indent the resolver body for readability
        const indentedResolver = resolverCode
          .split('\n')
          .map(line => `    ${line}`)
          .join('\n');
        const composeObj = `{ __isCompose__: true, fragments: {\n${fragmentsStr}\n  }, resolve: async (fragments, callAction, context) => {\n${indentedResolver}\n  } }`;
        return this.emit(
          `const ${name} = ${wrapWithParams(composeObj)};\n\n`,
          node
        );
      }

      // Fallback: static object with template (runtime LLM will resolve at execution time)
      const templateStr = JSON.stringify(template);
      const modelStr = model ? `, model: ${JSON.stringify(model)}` : '';
      const composeObj = `{ __isCompose__: true, fragments: {\n${fragmentsStr}\n  }, template: ${templateStr}${modelStr} }`;
      return this.emit(
        `const ${name} = ${wrapWithParams(composeObj)};\n\n`,
        node
      );
    }

    // Concatenation of N prompts/strings: A + B + C + ...
    if (node.content.type === 'PromptConcatExpr') {
      const parts = node.content.parts.map(p => {
        if (p.type === 'StringLiteral') return JSON.stringify(p.value);
        if (p.type === 'Identifier') return p.name; // reference to another prompt variable
        return '""';
      });
      return this.emit(`const ${name} = ${parts.join(' + "\\n\\n" + ')};\n\n`, node);
    }

    // Single identifier reference: prompt A = B
    if (node.content.type === 'Identifier') {
      return this.emit(`const ${name} = ${node.content.name};\n\n`, node);
    }

    if (node.params.length > 0) {
      // Parameterized → arrow function with template literal
      // Convert {{param}} syntax to ${param} for JS template literal evaluation
      const paramNames = node.params.map(p => p.name.name).join(', ');
      let content = node.content.value.replace(/`/g, '\\`');
      content = content.replace(/\{\{(\w[\w.]*)\}\}/g, '${$1}');
      return this.emit(`const ${name} = (${paramNames}) => \`${content}\`;\n\n`, node);
    } else {
      // Simple → string constant
      return this.emit(`const ${name} = ${JSON.stringify(node.content.value)};\n\n`, node);
    }
  }

  // ============================================================
  // Compose Template Compilation (deterministic, no LLM)
  // ============================================================

  /**
   * Check if compose template contains template directives (@let, @if).
   */
  _hasComposeDirectives(template) {
    return /@let\s|@if\s|\{\{/.test(template);
  }

  /**
   * Taint analysis: classify template variables as static or dynamic (tainted).
   * Tainted = depends on runtime state (callAction, state, args, userMessage).
   * Also detects discriminator patterns: top-level @if (taintedVar === 'literal')
   * that define prompt variants for cache optimization.
   *
   * @param {string[]} lines - Template lines
   * @returns {{ taintedVars: Set<string>, discriminator: { varName: string, values: string[] }|null }}
   */
  _analyzeTaint(lines) {
    // Classify context variables by volatility:
    // - DYNAMIC (tainted): changes between turns → content goes to __dynamicParts
    // - STATIC: constant for the session → content stays in __staticParts
    //
    // Only variables that change BETWEEN LLM CALLS should be tainted.
    // Variables from env or agent config are constant for the entire session.
    const taintedVars = new Set([
      'state',        // changes (phase transitions, permissions) — but discriminator handles phase
      'args',         // task args — can change on delegation
      'userMessage',  // changes every turn
      // NOT tainted: nonInteractive (env var, constant), agentName (constant)
    ]);

    // First pass: collect @let assignments and propagate taint
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      const letMatch = trimmed.match(/^@let\s+(\w+)\s*=\s*(.+)$/);
      if (!letMatch) continue;
      const [, varName, expr] = letMatch;
      // callAction is always tainted
      if (expr.includes('callAction')) {
        taintedVars.add(varName);
        continue;
      }
      // Check if expr references any tainted variable
      for (const tv of taintedVars) {
        if (new RegExp(`\\b${tv}\\b`).test(expr)) {
          taintedVars.add(varName);
          break;
        }
      }
    }

    // Second pass: detect discriminator — top-level @if (taintedVar === 'literal')
    // grouped by variable. ≥2 literal values on a tainted var = discriminator.
    const candidates = new Map(); // varName → Set<literal>
    let depth = 0;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed === '}') { depth = Math.max(0, depth - 1); continue; }
      const ifMatch = trimmed.match(/^@if\s*\((.+)\)\s*\{$/);
      if (ifMatch) {
        if (depth === 0) {
          // Check for pattern: var === 'literal' or var === "literal"
          const condMatch = ifMatch[1].match(/^(\w+)\s*===\s*['"]([^'"]+)['"]\s*$/);
          if (condMatch) {
            const [, varName, literal] = condMatch;
            if (taintedVars.has(varName)) {
              if (!candidates.has(varName)) candidates.set(varName, new Set());
              candidates.get(varName).add(literal);
            }
          }
        }
        depth++;
        continue;
      }
      if (/^@(?:else\s+)?if\s*\(/.test(trimmed) || /^@else\s*\{/.test(trimmed)) {
        // else-if / else at current depth — don't change depth
      }
    }

    // Pick the discriminator with the most variants (typically 'phase')
    let discriminator = null;
    for (const [varName, values] of candidates) {
      if (values.size >= 2) {
        if (!discriminator || values.size > discriminator.values.length) {
          discriminator = { varName, values: [...values] };
        }
      }
    }

    return { taintedVars, discriminator };
  }

  /**
   * Check if an expression references any tainted variable.
   * @param {string} expr - JavaScript expression
   * @param {Set<string>} taintedVars - Set of tainted variable names
   * @returns {boolean}
   */
  _isTainted(expr, taintedVars) {
    for (const tv of taintedVars) {
      if (new RegExp(`\\b${tv}\\b`).test(expr)) return true;
    }
    return false;
  }

  /**
   * Compile compose template directives into a JavaScript resolver body.
   * Handles: {{fragmentName}}, @let, @if, {{expr}}, plain text.
   *
   * When a discriminator is detected (e.g., @if phase === 'routing'), generates
   * cache-aware code that returns { _cacheKey, static, dynamic } instead of a
   * single string, enabling LLM prompt prefix caching.
   */
  _compileComposeTemplate(template, fragmentNames) {
    const lines = template.split('\n');
    const { taintedVars, discriminator } = this._analyzeTaint(lines);
    const cacheAware = !!discriminator;

    const jsLines = [
      'const { args, state, agentName, userMessage, nonInteractive } = context || {};',
      cacheAware ? 'const __staticParts = [];' : '',
      cacheAware ? 'const __dynamicParts = [];' : '',
      cacheAware ? 'let __cacheKey = null;' : '',
      cacheAware ? 'const __dynStack = [];' : '', // stack-based: push on tainted @if, pop on }, only dynamic when stack is non-empty
      'const __parts = [];',
      'const __images = [];',
      'const __str = (v) => v == null ? "" : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);',
      cacheAware ? 'const __push = (v) => __dynStack.length > 0 ? __dynamicParts.push(v) : __staticParts.push(v);' : '',
    ].filter(Boolean);


    // In cache-aware mode, __push routes to __staticParts or __dynamicParts.
    // We use __parts.push for the legacy single-string path.
    const pushFn = cacheAware ? '__push' : '__parts.push';

    let textBuffer = [];
    const flushText = () => {
      if (textBuffer.length === 0) return;
      const text = textBuffer.join('\n');
      if (text.trim()) {
        jsLines.push(`${pushFn}(${JSON.stringify(text)});`);
      }
      textBuffer = [];
    };

    // Track @if nesting depth to detect discriminator branches (depth === 0)
    let ifDepth = 0;
    // Whether we're inside a discriminator variant branch
    let inDiscriminatorBranch = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      // @let varName = expr
      const letMatch = trimmed.match(/^@let\s+(\w+)\s*=\s*(.+)$/);
      if (letMatch) {
        flushText();
        const [, varName, expr] = letMatch;
        jsLines.push(`const ${varName} = await ${expr};`);
        // Auto-collect images for frame_server_state and browser_observe
        if (expr.includes('frame_server_state') || expr.includes('browser_observe')) {
          jsLines.push(`if (${varName}?.screenshot) {`);
          jsLines.push(`  __images.push({ data: ${varName}.screenshot, mimeType: ${varName}.mimeType || 'image/jpeg' });`);
          jsLines.push(`}`);
        }
        // Set cache key when the discriminator variable is assigned
        if (cacheAware && varName === discriminator.varName) {
          jsLines.push(`__cacheKey = ${varName};`);
        }
        continue;
      }

      // @if (expr) {
      const ifMatch = trimmed.match(/^@if\s*\((.+)\)\s*\{$/);
      if (ifMatch) {
        flushText();
        const cond = ifMatch[1];

        // Detect discriminator branch: top-level @if on the discriminator variable
        if (cacheAware && ifDepth === 0 && discriminator) {
          const discMatch = cond.match(/^(\w+)\s*===\s*['"]([^'"]+)['"]\s*$/);
          if (discMatch && discMatch[1] === discriminator.varName) {
            inDiscriminatorBranch = true;
            jsLines.push(`__dynStack.length = 0;`); // reset for each variant
            jsLines.push(`if (${cond}) {`);
            ifDepth++;
            continue;
          }
        }

        // Nested @if inside a discriminator branch: if condition is tainted,
        // push onto dynamic stack (content inside this @if goes to dynamic,
        // but content AFTER the closing } returns to static)
        if (cacheAware && inDiscriminatorBranch && this._isTainted(cond, taintedVars)) {
          jsLines.push(`__dynStack.push(true);`);
        }

        jsLines.push(`if (${cond}) {`);
        ifDepth++;
        continue;
      }

      // @else if (expr) {  — replaces the preceding }
      const elseIfMatch = trimmed.match(/^@else\s+if\s*\((.+)\)\s*\{$/);
      if (elseIfMatch) {
        flushText();
        if (jsLines.length > 0 && jsLines[jsLines.length - 1] === '}') {
          jsLines[jsLines.length - 1] = `} else if (${elseIfMatch[1]}) {`;
        } else {
          jsLines.push(`} else if (${elseIfMatch[1]}) {`);
        }
        continue;
      }

      // @else {  — replaces the preceding }
      if (/^@else\s*\{$/.test(trimmed)) {
        flushText();
        if (jsLines.length > 0 && jsLines[jsLines.length - 1] === '}') {
          jsLines[jsLines.length - 1] = `} else {`;
        } else {
          jsLines.push(`} else {`);
        }
        continue;
      }

      // } @else { on the same line
      if (/^\}\s*@else\s*\{$/.test(trimmed)) {
        flushText();
        jsLines.push(`} else {`);
        continue;
      }

      // } @else if (...) { on the same line
      const sameLineElseIfMatch = trimmed.match(/^\}\s*@else\s+if\s*\((.+)\)\s*\{$/);
      if (sameLineElseIfMatch) {
        flushText();
        jsLines.push(`} else if (${sameLineElseIfMatch[1]}) {`);
        continue;
      }

      // Closing } on its own line
      if (trimmed === '}') {
        flushText();
        ifDepth = Math.max(0, ifDepth - 1);
        if (cacheAware && ifDepth === 0 && inDiscriminatorBranch) {
          inDiscriminatorBranch = false;
          jsLines.push(`__dynStack.length = 0;`); // reset after variant branch
        } else if (cacheAware && inDiscriminatorBranch) {
          // Pop the dynamic stack when closing a nested tainted @if
          // Content after this } returns to static (if stack becomes empty)
          jsLines.push(`if (__dynStack.length > 0) __dynStack.pop();`);
        }
        jsLines.push('}');
        continue;
      }

      // Line contains {{expr}} interpolation(s) (including fragment references)
      if (/\{\{.+?\}\}/.test(trimmed)) {
        flushText();
        this._compileInterpolatedLine(rawLine, fragmentNames, jsLines, cacheAware ? pushFn : null, taintedVars);
        continue;
      }

      // Plain text line
      textBuffer.push(rawLine);
    }

    flushText();

    if (cacheAware) {
      jsLines.push("const __static = __staticParts.filter(Boolean).join('\\n');");
      jsLines.push("const __dynamic = __dynamicParts.filter(Boolean).join('\\n');");
      jsLines.push("if (__images.length > 0) return { _cacheKey: __cacheKey, static: __static, dynamic: __dynamic, images: __images };");
      jsLines.push("return { _cacheKey: __cacheKey, static: __static, dynamic: __dynamic };");
    } else {
      jsLines.push("const __text = __parts.filter(Boolean).join('\\n');");
      jsLines.push("return __images.length > 0 ? { text: __text, images: __images } : __text;");
    }

    return jsLines.join('\n');
  }

  /**
   * Compile a line containing {{expr}} interpolations (including fragment references)
   * into __parts.push() calls. If {{expr}} matches a known fragment name, it emits
   * a fragment inclusion; otherwise it emits an interpolated expression.
   */
  _compileInterpolatedLine(line, fragmentNames, jsLines, pushFn = null, taintedVars = null) {
    const push = pushFn || '__parts.push';
    let remaining = line;

    // Collect all segments of this line. If ALL interpolations are inline expressions
    // (not fragment inclusions), concatenate them into a single __parts.push() to
    // avoid the join('\n') in the resolver from splitting one template line into
    // multiple output lines.
    const segments = [];  // { type: 'text'|'expr'|'fragment', value: string }

    while (remaining.length > 0) {
      const interpIdx = remaining.indexOf('{{');

      if (interpIdx < 0) {
        if (remaining.trim()) {
          segments.push({ type: 'text', value: remaining });
        }
        break;
      }

      // Text before the pattern
      const before = remaining.substring(0, interpIdx);
      if (before) {
        segments.push({ type: 'text', value: before });
      }

      const endIdx = remaining.indexOf('}}', interpIdx + 2);
      if (endIdx >= 0) {
        const expr = remaining.substring(interpIdx + 2, endIdx).trim();
        if (fragmentNames.includes(expr)) {
          segments.push({ type: 'fragment', value: expr });
        } else {
          const safeExpr = this._safePropertyAccess(expr);
          segments.push({ type: 'expr', value: safeExpr });
        }
        remaining = remaining.substring(endIdx + 2);
      } else {
        // Unclosed {{ — treat rest as text
        segments.push({ type: 'text', value: remaining });
        break;
      }
    }

    // If ANY segment is a fragment, emit them separately (fragments are multi-line blocks).
    const hasFragment = segments.some(s => s.type === 'fragment');
    if (hasFragment) {
      for (const seg of segments) {
        if (seg.type === 'text' && seg.value.trim()) {
          jsLines.push(`${push}(${JSON.stringify(seg.value)});`);
        } else if (seg.type === 'expr') {
          // If cache-aware and expr is tainted, push to dynamic just for this value
          const _exprTainted = pushFn && taintedVars && this._isTainted(seg.value, taintedVars);
          if (_exprTainted) jsLines.push(`__dynStack.push(true);`);
          jsLines.push(`${push}(__str(${seg.value}));`);
          if (_exprTainted) jsLines.push(`__dynStack.pop();`);
        } else if (seg.type === 'fragment') {
          jsLines.push(`${push}(fragments.${seg.value});`);
        }
      }
    } else {
      // All inline: concatenate into a single string expression to avoid split lines.
      const parts = segments.map(s => {
        if (s.type === 'text') return JSON.stringify(s.value);
        return `__str(${s.value})`;
      });
      if (parts.length > 0) {
        // If any expression is tainted, push/pop dynamic just for this line
        if (pushFn && taintedVars) {
          const hasTaintedExpr = segments.some(s => s.type === 'expr' && this._isTainted(s.value, taintedVars));
          if (hasTaintedExpr) {
            jsLines.push(`__dynStack.push(true);`);
          }
        }
        jsLines.push(`${push}(${parts.join(' + ')});`);
        if (pushFn && taintedVars) {
          const hasTaintedExpr = segments.some(s => s.type === 'expr' && this._isTainted(s.value, taintedVars));
          if (hasTaintedExpr) jsLines.push(`__dynStack.pop();`);
        }
      }
    }
  }

  /**
   * Convert property access to optional chaining for safety in interpolations.
   * e.g., "foo.bar" → "foo?.bar"
   */
  _safePropertyAccess(expr) {
    return expr.replace(/(?<=[a-zA-Z0-9_\]])\.(?=[a-zA-Z_])/g, '?.');
  }

  generateImport(node) {
    return this.emit(`// Import ${node.what}: ${node.name.value}\n`, node);
  }

  generateRole(node) {
    const caps = node.capabilities.map(c => `'${c.name.name}'`).join(', ');
    return this.emit(
      `const ${node.name.name}_role = new Role('${node.name.name}', [${caps}]);\n\n`,
      node
    );
  }

  generateTeam(node) {
    let code = this.emit(`const ${node.name.name} = new Team('${node.name.name}', {\n`, node);
    this.indent++;
    for (const member of node.members) {
      let value;

      // Handle MCP addresses
      if (member.value.type === 'MCPAddress') {
        value = `'${member.value.address}'`;
      }
      // Handle AgentReference
      else if (member.value.type === 'AgentReference') {
        value = member.value.agent.name;
      }
      // Handle Identifier
      else if (member.value.type === 'Identifier') {
        value = member.value.name;
      }
      // Handle regular values
      else if (typeof member.value === 'string') {
        value = `'${member.value}'`;
      }
      else if (member.value.value) {
        value = `'${member.value.value}'`;
      }
      else {
        value = member.value.name || 'undefined';
      }

      code += this.emit(`${this.getIndent()}${member.name.name}: ${value},\n`);
    }
    this.indent--;
    code += this.emit(`});\n\n`);
    return code;
  }

  generateMCP(node) {
    let code = this.emit(`// MCP Server: ${node.name.name}\n`, node);
    code += this.emit(`mcpRegistry.register('${node.name.name}', ${this.generateExpression(node.config)});\n\n`);
    return code;
  }

  generateAgent(node) {
    const hasLocalPrompts = node._localPrompts && node._localPrompts.length > 0;
    let code = '';

    if (hasLocalPrompts) {
      // Wrap in IIFE to scope non-exported prompts from the same file (file-level visibility)
      code += this.emit(`const ${node.name.name} = (() => {\n`, node);
      this.indent++;
      for (const promptDecl of node._localPrompts) {
        code += this.generatePromptDecl(promptDecl);
      }
      code += this.emit(`${this.getIndent()}return new Agent({\n`);
    } else {
      code += this.emit(`const ${node.name.name} = new Agent({\n`, node);
    }

    this.indent++;
    code += this.emit(`${this.getIndent()}name: '${node.name.name}',\n`);
    code += this.emit(`${this.getIndent()}role: ${node.role.name}_role,\n`);

    // Extract body items
    const skills = node.body.filter(b => b.type === 'UsesSkill');
    const usesTeams = node.body.filter(b => b.type === 'UsesTeam');
    const usesMCP = node.body.filter(b => b.type === 'UsesMCP');
    const agentAffordance = node.body.find(b => b.type === 'AffordanceDecl');
    const llmConfig = node.body.find(b => b.type === 'LLMConfig');
    const eventHandlers = node.body.filter(b => b.type === 'EventHandler');
    const state = node.body.find(b => b.type === 'StateDecl');
    const playbooks = node.body.filter(b => b.type === 'PlaybookDecl');
    const resilience = node.body.find(b => b.type === 'ResilienceDecl');
    const amnesia = node.body.find(b => b.type === 'AmnesiaDecl');
    const exposesMCP = node.body.find(b => b.type === 'ExposesMCP');
    const peers = node.body.find(b => b.type === 'PeersDecl');

    // Track if agent has handlers for auto-registration
    this.agentHasHandlers = eventHandlers.length > 0;

    if (agentAffordance) {
      const desc = agentAffordance.content.value
        .split('\n').map(l => l.trim()).filter(l => l.length > 0).join(' ');
      code += this.emit(`${this.getIndent()}description: ${JSON.stringify(desc)},\n`);
    }

    if (skills.length > 0) {
      code += this.emit(`${this.getIndent()}skills: [${skills.map(s => `'${s.skill.name}'`).join(', ')}],\n`);
    }

    if (usesTeams.length > 0) {
      code += this.emit(`${this.getIndent()}usesTeams: [${usesTeams.map(t => t.team.name).join(', ')}],\n`);

      // For backward compatibility: if no explicit peers and usesTeams exists,
      // set peers to the first team for 'peers.event()' syntax to work
      if (!peers && usesTeams.length > 0) {
        code += this.emit(`${this.getIndent()}peers: ${usesTeams[0].team.name}, // Auto-assigned from uses Team\n`);
      }
    }

    if (usesMCP.length > 0) {
      code += this.emit(`${this.getIndent()}usesMCP: [${usesMCP.map(m => `'${m.mcp.name}'`).join(', ')}],\n`);
    }

    if (exposesMCP) {
      code += this.emit(`${this.getIndent()}exposesMCP: true,\n`);
    }

    if (llmConfig) {
      code += this.emit(`${this.getIndent()}llm: ${this.generateExpression(llmConfig.config)},\n`);
    }

    if (amnesia) {
      code += this.emit(`${this.getIndent()}amnesia: ${amnesia.value.value},\n`);
    }

    if (state) {
      code += this.emit(`${this.getIndent()}state: {\n`);
      this.indent++;
      for (const field of state.fields) {
        const init = field.init ? this.generateExpression(field.init) : 'null';
        code += this.emit(`${this.getIndent()}${field.name.name}: ${init},\n`);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}},\n`);
    }

    if (playbooks.length > 0) {
      code += this.emit(`${this.getIndent()}playbooks: {\n`);
      this.indent++;
      for (const pb of playbooks) {
        code += this.emit(`${this.getIndent()}${pb.name.value}: ${this.generateExpression(pb.content)},\n`);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}},\n`);
    }

    if (resilience) {
      code += this.emit(`${this.getIndent()}resilience: {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}name: ${resilience.name.value},\n`);
      for (const prop of resilience.properties) {
        const val = this.generateExpression(prop.value);
        code += this.emit(`${this.getIndent()}${prop.name.name}: ${val},\n`);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}},\n`);
    }

    if (peers) {
      let teamName;
      if (peers.team && typeof peers.team === 'object') {
        // Handle TeamReference with override
        teamName = peers.team.name ? peers.team.name.name : peers.team;
      } else {
        teamName = peers.team;
      }
      code += this.emit(`${this.getIndent()}peers: ${teamName},\n`);
    }

    if (eventHandlers.length > 0) {
      code += this.emit(`${this.getIndent()}handlers: {\n`);
      this.indent++;
      for (const handler of eventHandlers) {
        code += this.generateEventHandler(handler, node.name.name);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}}\n`);
    }

    this.indent--;
    if (hasLocalPrompts) {
      code += this.emit(`${this.getIndent()}});\n`);  // close new Agent({})
      this.indent--;
      code += this.emit(`})();\n`);  // close IIFE
    } else {
      code += this.emit(`});\n`);
    }

    // Auto-register agent with router if it has handlers (only if not skipping)
    if (this.agentHasHandlers && !this.skipAgentRegistration) {
      const agentName = node.name.name;
      const hasCachedAffordances = this.cacheData && this.cacheData.affordances && this.cacheData.affordances[agentName];

      code += this.emit(`\n// Auto-register agent with router for dynamic discovery\n`);
      code += this.emit(`(async () => {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}const { agentRouter } = await import('${this.routerImportPath}');\n`);

      if (hasCachedAffordances) {
        // Use cached affordances (no embedding generation needed)
        code += this.emit(`${this.getIndent()}// Using pre-generated descriptions from build cache\n`);
        code += this.emit(`${this.getIndent()}await agentRouter.register(${agentName}, CACHED_AFFORDANCES['${agentName}']);\n`);
      } else {
        // No cache, generate at runtime
        code += this.emit(`${this.getIndent()}await agentRouter.register(${agentName});\n`);
      }

      this.indent--;
      code += this.emit(`})();\n`);
    }

    code += this.emit(`\n`);
    return code;
  }

  generateEventHandler(node, agentName = null) {
    const params = node.params.map(p => p.name.name).join(', ');
    const handlerName = node.event.name;

    // Extract parameter type annotations (e.g., { args: 'Json', task: 'Task' })
    const paramTypes = {};
    for (const p of node.params) {
      if (p.type && p.type.name) {
        paramTypes[p.name.name] = p.type.name;
      }
    }
    const hasParamTypes = Object.keys(paramTypes).length > 0;

    // Explicit affordance statement in body takes priority; fall back to build cache
    const affordanceStmt = node.body.find(s => s.type === 'AffordanceStatement');
    const cachedDesc = affordanceStmt
      ? affordanceStmt.content.value
      : (agentName && this.cacheData?.affordances?.[agentName]?.[handlerName]?.description);

    // Check if this is a playbook-only handler (only has PlaybookStatement + optional AffordanceStatement)
    const nonAffordanceBody = node.body.filter(s => s.type !== 'AffordanceStatement');
    const hasOnlyPlaybook = nonAffordanceBody.length === 1 && nonAffordanceBody[0].type === 'PlaybookStatement';

    if (hasOnlyPlaybook) {
      const playbookNode = nonAffordanceBody[0];
      const parts = playbookNode.parts;
      const isSingleStringPart = parts.length === 1 && parts[0].type === 'StringPart';

      let code = this.emit(`${this.getIndent()}${handlerName}: (() => {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}const handler = async function(${params}) {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}// This should not be called - playbook will be executed by LLM\n`);
      code += this.emit(`${this.getIndent()}throw new Error('Playbook-only handler called directly');\n`);
      this.indent--;
      code += this.emit(`${this.getIndent()}};\n`);
      code += this.emit(`${this.getIndent()}handler.__playbookOnly__ = true;\n`);

      if (isSingleStringPart) {
        // Simple string: backward-compatible __playbook__
        const escapedPlaybook = JSON.stringify(parts[0].content.value);
        code += this.emit(`${this.getIndent()}handler.__playbook__ = ${escapedPlaybook};\n`);
      } else {
        // Composed prompt: use __playbookFn__ evaluated at call time (async for compose support)
        const partsExpr = parts.map(p => this.generatePlaybookPartExpression(p)).join(', ');
        code += this.emit(`${this.getIndent()}handler.__playbookFn__ = async (args, state, __agent__) => {\n`);
        code += this.emit(`${this.getIndent()}  const __parts__ = [${partsExpr}];\n`);
        code += this.emit(`${this.getIndent()}  const __resolved__ = await Promise.all(__parts__.map(async __p__ => {\n`);
        code += this.emit(`${this.getIndent()}    if (__p__ && __p__.__isCompose__) return await __agent__._executeComposePrompt(__p__, args);\n`);
        code += this.emit(`${this.getIndent()}    if (typeof __p__ === 'function') return __p__(args, state);\n`);
        code += this.emit(`${this.getIndent()}    return __p__ || '';\n`);
        code += this.emit(`${this.getIndent()}  }));\n`);
        // If only one part and it's a structured cache-aware result, pass through directly
        code += this.emit(`${this.getIndent()}  if (__resolved__.length === 1 && typeof __resolved__[0] === 'object' && __resolved__[0]?._cacheKey !== undefined) return __resolved__[0];\n`);
        // Flatten any structured results that appear alongside other parts
        code += this.emit(`${this.getIndent()}  return __resolved__.map(__r__ => typeof __r__ === 'object' && __r__?._cacheKey !== undefined ? [__r__.static, __r__.dynamic].filter(Boolean).join('\\n') : __r__).join('\\n');\n`);
        code += this.emit(`${this.getIndent()}};\n`);
      }

      if (cachedDesc) {
        code += this.emit(`${this.getIndent()}handler.__description__ = ${JSON.stringify(cachedDesc)};\n`);
      }
      if (node.isPrivate) {
        code += this.emit(`${this.getIndent()}handler.__private__ = true;\n`);
      }
      if (hasParamTypes) {
        code += this.emit(`${this.getIndent()}handler.__paramTypes__ = ${JSON.stringify(paramTypes)};\n`);
      }
      code += this.emit(`${this.getIndent()}return handler;\n`);
      this.indent--;
      code += this.emit(`${this.getIndent()}})(),\n`);
      return code;
    }

    // Regular handler with code
    if (cachedDesc || node.isPrivate) {
      // Wrap in IIFE to attach __description__ / __private__
      let code = this.emit(`${this.getIndent()}${handlerName}: (() => {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}const handler = async function(${params}) {\n`);
      this.indent++;
      this.inEventHandler = true;
      for (const stmt of nonAffordanceBody) {
        code += this.generateStatement(stmt);
      }
      this.inEventHandler = false;
      this.indent--;
      code += this.emit(`${this.getIndent()}};\n`);
      if (cachedDesc) {
        code += this.emit(`${this.getIndent()}handler.__description__ = ${JSON.stringify(cachedDesc)};\n`);
      }
      if (node.isPrivate) {
        code += this.emit(`${this.getIndent()}handler.__private__ = true;\n`);
      }
      if (hasParamTypes) {
        code += this.emit(`${this.getIndent()}handler.__paramTypes__ = ${JSON.stringify(paramTypes)};\n`);
      }
      code += this.emit(`${this.getIndent()}return handler;\n`);
      this.indent--;
      code += this.emit(`${this.getIndent()}})(),\n`);
      return code;
    }

    // Regular handler without IIFE — if we have paramTypes, we need an IIFE wrapper
    if (hasParamTypes) {
      let code = this.emit(`${this.getIndent()}${handlerName}: (() => {\n`);
      this.indent++;
      code += this.emit(`${this.getIndent()}const handler = async function(${params}) {\n`);
      this.indent++;
      this.inEventHandler = true;
      for (const stmt of nonAffordanceBody) {
        code += this.generateStatement(stmt);
      }
      this.inEventHandler = false;
      this.indent--;
      code += this.emit(`${this.getIndent()}};\n`);
      code += this.emit(`${this.getIndent()}handler.__paramTypes__ = ${JSON.stringify(paramTypes)};\n`);
      code += this.emit(`${this.getIndent()}return handler;\n`);
      this.indent--;
      code += this.emit(`${this.getIndent()}})(),\n`);
      return code;
    }

    let code = this.emit(`${this.getIndent()}${handlerName}: async function(${params}) {\n`);
    this.indent++;
    this.inEventHandler = true;
    for (const stmt of nonAffordanceBody) {
      code += this.generateStatement(stmt);
    }
    this.inEventHandler = false;
    this.indent--;
    code += this.emit(`${this.getIndent()}},\n`);
    return code;
  }

  generateSkill(node) {
    let code = '';
    const skillName = node.name.name;

    // Generate skill comment header
    code += this.emit(`// ============================================================\n`);
    code += this.emit(`// Skill: ${skillName}\n`);
    if (node.affordance) {
      code += this.emit(`// ${node.affordance.replace(/\n/g, '\\n// ')}\n`);
    }
    code += this.emit(`// ============================================================\n\n`);

    // Check if we need to create a closure for local scope
    const hasLocalDeclarations = (node.constants && node.constants.length > 0) ||
                                   (node.variables && node.variables.length > 0) ||
                                   (node.functions && node.functions.some(f => !f.isExport));

    const exportedFunctionNames = node.functions ? node.functions.filter(f => f.isExport).map(f => f.name.name) : [];

    if (hasLocalDeclarations && exportedFunctionNames.length > 0) {
      // Use IIFE to create local scope and export functions
      code += this.emit(`const { ${exportedFunctionNames.join(', ')} } = (() => {\n`);
      this.indent++;
    }

    // Generate constants
    if (node.constants && node.constants.length > 0) {
      for (const constDecl of node.constants) {
        code += this.generateSkillConstant(constDecl);
      }
      code += this.emit(`\n`);
    }

    // Generate variables
    if (node.variables && node.variables.length > 0) {
      for (const varDecl of node.variables) {
        code += this.generateSkillVariable(varDecl);
      }
      code += this.emit(`\n`);
    }

    // Generate internal agents
    if (node.agents && node.agents.length > 0) {
      for (const agent of node.agents) {
        code += this.generateAgent(agent);
      }
    }

    // Generate internal teams
    if (node.teams && node.teams.length > 0) {
      for (const team of node.teams) {
        code += this.generateTeam(team);
      }
    }

    // Generate all functions (exported and non-exported)
    if (node.functions && node.functions.length > 0) {
      for (const func of node.functions) {
        // Remove 'export' keyword if inside IIFE closure
        const funcCopy = hasLocalDeclarations && exportedFunctionNames.length > 0
          ? { ...func, isExport: false }
          : func;
        code += this.generateFunction(funcCopy);
      }
    }

    // Return exported functions from IIFE
    if (hasLocalDeclarations && exportedFunctionNames.length > 0) {
      code += this.emit(`${this.getIndent()}return { ${exportedFunctionNames.join(', ')} };\n`);
      this.indent--;
      code += this.emit(`})();\n\n`);
    }

    // Register exported functions in SkillRegistry
    if (exportedFunctionNames.length > 0) {
      code += this.emit(`// Register skill functions\n`);
      for (const funcName of exportedFunctionNames) {
        code += this.emit(`SkillRegistry.register('${skillName}', '${funcName}', ${funcName}, { affordance: ${JSON.stringify(node.affordance || '')} });\n`);
      }
      code += this.emit(`\n`);
    }

    code += this.emit(`\n`);
    return code;
  }

  generateFunction(node) {
    let code = '';

    // Function signature (strip TypeScript type annotations for JavaScript output)
    const exportKeyword = node.isExport ? 'export ' : '';
    const asyncKeyword = node.isAsync ? 'async ' : '';
    const params = node.params ? node.params.map(p => {
      const paramName = p.name.name;
      if (p.default) {
        const defaultValue = this.generateExpression(p.default);
        return `${paramName} = ${defaultValue}`;
      }
      return paramName;
    }).join(', ') : '';

    code += this.emit(`${exportKeyword}${asyncKeyword}function ${node.name.name}(${params}) {\n`, node);

    // Function body - emit as raw code
    if (node.body && node.body.code) {
      this.indent++;
      const bodyLines = node.body.code.split('\n');
      for (const line of bodyLines) {
        if (line.trim()) {
          code += this.emit(`${this.getIndent()}${line}\n`);
        } else {
          code += this.emit(`\n`);
        }
      }
      this.indent--;
    }

    code += this.emit(`}\n\n`);
    return code;
  }

  generateSkillConstant(node) {
    const pattern = this.generateDestructuringPattern(node.pattern);
    const value = this.generateExpression(node.value);
    return this.emit(`${this.getIndent()}const ${pattern} = ${value};\n`);
  }

  generateSkillVariable(node) {
    const pattern = this.generateDestructuringPattern(node.pattern);
    const init = node.init ? ` = ${this.generateExpression(node.init)}` : '';
    return this.emit(`${this.getIndent()}let ${pattern}${init};\n`);
  }

  generateDestructuringPattern(pattern) {
    if (typeof pattern === 'string') {
      return pattern;
    }

    if (pattern.type === 'Identifier') {
      return pattern.name;
    }

    if (pattern.type === 'ObjectPattern') {
      const props = pattern.properties.map(prop => {
        if (prop.key === prop.value) {
          return prop.key;
        }
        return `${prop.key}: ${prop.value}`;
      }).join(', ');
      return `{ ${props} }`;
    }

    if (pattern.type === 'ArrayPattern') {
      return `[ ${pattern.elements.join(', ')} ]`;
    }

    return pattern;
  }

  generateTypeExpression(typeNode) {
    if (!typeNode) return 'any';

    switch (typeNode.type) {
      case 'AnyType': return 'any';
      case 'StringType': return 'string';
      case 'NumberType': return 'number';
      case 'BooleanType': return 'boolean';
      case 'JsonType': return 'any';
      case 'PromiseType':
        return `Promise<${this.generateTypeExpression(typeNode.inner)}>`;
      case 'CustomType':
        return typeNode.name;
      default:
        return 'any';
    }
  }

  generateRun(node) {
    // Check if target is MemberExpression (Agent.event)
    if (node.target.type === 'MemberExpression') {
      const agent = this.generateExpression(node.target.object);
      const event = typeof node.target.property === 'string'
        ? node.target.property
        : node.target.property.name;
      const args = node.arguments.map(arg => this.generateExpression(arg)).join(', ');

      return this.emit(
        `\n// Run\n(async () => {\n  const result = await ${agent}.handle('${event}', ${args});\n  // Result handled by actions\n})();\n`,
        node
      );
    } else {
      // Direct function call
      const target = this.generateExpression(node.target);
      const args = node.arguments.map(arg => this.generateExpression(arg)).join(', ');
      return this.emit(`\n// Run\n(async () => {\n  const result = await ${target}(${args});\n  // Result handled by actions\n})();\n`, node);
    }
  }

  generateRunBody(node) {
    // Generate just the body of a run statement (without IIFE wrapper)
    // Used when generating coordinated main function
    let code = '';

    if (node.target.type === 'MemberExpression') {
      const agent = this.generateExpression(node.target.object);
      const event = typeof node.target.property === 'string'
        ? node.target.property
        : node.target.property.name;
      const args = node.arguments.map(arg => this.generateExpression(arg)).join(', ');

      code += this.emit(`${this.getIndent()}// Execute\n`);
      code += this.emit(`${this.getIndent()}const result = await ${agent}.handle('${event}', ${args});\n`);
      code += this.emit(`${this.getIndent()}// Result handled by actions\n\n`);
    } else {
      // Direct function call
      const target = this.generateExpression(node.target);
      const args = node.arguments.map(arg => this.generateExpression(arg)).join(', ');

      code += this.emit(`${this.getIndent()}// Execute\n`);
      code += this.emit(`${this.getIndent()}const result = await ${target}(${args});\n`);
      code += this.emit(`${this.getIndent()}// Result handled by actions\n\n`);
    }

    return code;
  }

  // ============================================================
  // Statements
  // ============================================================

  generateStatement(node) {
    switch (node.type) {
      case 'PlaybookStatement': {
        // Replace newlines with spaces and truncate safely
        const firstStringPart = node.parts && node.parts.find(p => p.type === 'StringPart');
        const rawText = firstStringPart ? firstStringPart.content.value : '[composed prompt]';
        const playbookText = rawText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        const truncated = playbookText.length > 80 ? playbookText.substring(0, 80) + '...' : playbookText;
        return this.emit(`${this.getIndent()}// Playbook: ${truncated}\n`, node);
      }
      case 'VariableDeclaration':
        return this.generateVarDecl(node);
      case 'ConstDeclaration':
        return this.generateConstDecl(node);
      case 'IfStatement':
        return this.generateIf(node);
      case 'ForStatement':
        return this.generateFor(node);
      case 'ForOfStatement':
        return this.generateForOf(node);
      case 'ForInStatement':
        return this.generateForIn(node);
      case 'WhileStatement':
        return this.generateWhile(node);
      case 'ReturnStatement':
        return this.generateReturn(node);
      case 'ThrowStatement':
        return this.generateThrow(node);
      case 'TryStatement':
        return this.generateTry(node);
      case 'SendStatement':
        return this.generateSend(node);
      case 'UsePlaybookStatement':
        return this.emit(`${this.getIndent()}// Use playbook: ${node.name.name || node.name.value}\n`, node);
      case 'ExpressionStatement':
        return this.emit(`${this.getIndent()}${this.generateExpression(node.expression)};\n`, node);
      case 'CodeBlockStatement':
      case 'RawCodeBlock':
        // Emit raw code block with proper indentation
        // Transform await send expressions to Runtime.send calls
        const rawCode = this.transformSendExpressions(node.code);
        const lines = rawCode.split('\n');
        let code = '';
        for (const line of lines) {
          if (line.trim()) {
            code += this.emit(`${this.getIndent()}${line}\n`);
          } else {
            code += this.emit('\n');
          }
        }
        return code;
      default:
        return this.emit(`${this.getIndent()}/* Unknown statement: ${node.type} */\n`);
    }
  }

  generateVarDecl(node) {
    const init = node.init ? ` = ${this.generateExpression(node.init)}` : '';
    return this.emit(`${this.getIndent()}let ${node.name.name}${init};\n`, node);
  }

  generateConstDecl(node) {
    return this.emit(`${this.getIndent()}const ${node.name.name} = ${this.generateExpression(node.value)};\n`, node);
  }

  generateIf(node) {
    let code = this.emit(`${this.getIndent()}if (${this.generateExpression(node.condition)}) {\n`, node);
    this.indent++;
    for (const stmt of node.then) {
      code += this.generateStatement(stmt);
    }
    this.indent--;
    code += this.emit(`${this.getIndent()}}`);

    if (node.else && node.else.length > 0) {
      code += this.emit(` else {\n`);
      this.indent++;
      for (const stmt of node.else) {
        code += this.generateStatement(stmt);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}}`);
    }

    code += this.emit(`\n`);
    return code;
  }

  generateFor(node) {
    const init = node.init ? this.generateExpression(node.init) : '';
    const condition = node.condition ? this.generateExpression(node.condition) : '';
    const update = node.update ? this.generateExpression(node.update) : '';
    let code = this.emit(`${this.getIndent()}for (${init}; ${condition}; ${update}) {\n`, node);
    this.indent++;
    for (const stmt of node.body) {
      code += this.generateStatement(stmt);
    }
    this.indent--;
    code += this.emit(`${this.getIndent()}}\n`);
    return code;
  }

  generateForOf(node) {
    const decl = node.declaration || 'const';
    const id = node.id.name || node.id;
    const expr = this.generateExpression(node.expression);
    let code = this.emit(`${this.getIndent()}for (${decl} ${id} of ${expr}) {\n`, node);
    this.indent++;
    for (const stmt of node.body) {
      code += this.generateStatement(stmt);
    }
    this.indent--;
    code += this.emit(`${this.getIndent()}}\n`);
    return code;
  }

  generateForIn(node) {
    const decl = node.declaration || 'const';
    const id = node.id.name || node.id;
    const expr = this.generateExpression(node.expression);
    let code = this.emit(`${this.getIndent()}for (${decl} ${id} in ${expr}) {\n`, node);
    this.indent++;
    for (const stmt of node.body) {
      code += this.generateStatement(stmt);
    }
    this.indent--;
    code += this.emit(`${this.getIndent()}}\n`);
    return code;
  }

  generateWhile(node) {
    let code = this.emit(`${this.getIndent()}while (${this.generateExpression(node.condition)}) {\n`, node);
    this.indent++;
    for (const stmt of node.body) {
      code += this.generateStatement(stmt);
    }
    this.indent--;
    code += this.emit(`${this.getIndent()}}\n`);
    return code;
  }

  generateReturn(node) {
    const value = node.value ? ` ${this.generateExpression(node.value)}` : '';
    return this.emit(`${this.getIndent()}return${value};\n`, node);
  }

  generateThrow(node) {
    return this.emit(`${this.getIndent()}throw ${this.generateExpression(node.argument)};\n`, node);
  }

  generateTry(node) {
    let code = this.emit(`${this.getIndent()}try {\n`, node);
    this.indent++;
    for (const stmt of node.body) {
      code += this.generateStatement(stmt);
    }
    this.indent--;
    code += this.emit(`${this.getIndent()}}`);

    if (node.handler) {
      code += this.emit(` catch (${node.handler.param.name}) {\n`);
      this.indent++;
      for (const stmt of node.handler.body) {
        code += this.generateStatement(stmt);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}}`);
    }

    if (node.finalizer) {
      code += this.emit(` finally {\n`);
      this.indent++;
      for (const stmt of node.finalizer) {
        code += this.generateStatement(stmt);
      }
      this.indent--;
      code += this.emit(`${this.getIndent()}}`);
    }

    code += this.emit('\n');
    return code;
  }

  generateSend(node) {
    let code = `await Runtime.send({\n`;
    this.indent++;
    code += `${this.getIndent()}base: ${this.generateExpression(node.target.base)},\n`;

    if (node.target.filters.length > 0) {
      code += `${this.getIndent()}filters: [\n`;
      this.indent++;
      for (const filter of node.target.filters) {
        if (filter.type === 'EventFilter') {
          code += `${this.getIndent()}{ type: 'event', name: ${this.generateExpression(filter.event)} },\n`;
        } else if (filter.type === 'RoleFilter') {
          code += `${this.getIndent()}{ type: 'role', role: ${filter.role.name}_role },\n`;
        } else if (filter.type === 'SelectionFilter') {
          code += `${this.getIndent()}{ type: 'select', mode: '${filter.mode}' },\n`;
        }
      }
      this.indent--;
      code += `${this.getIndent()}],\n`;
    }

    // Pass arguments: single argument directly, multiple as array
    if (node.arguments.length === 1) {
      code += `${this.getIndent()}args: ${this.generateExpression(node.arguments[0])},\n`;
    } else if (node.arguments.length > 1) {
      code += `${this.getIndent()}args: [${node.arguments.map(arg => this.generateExpression(arg)).join(', ')}],\n`;
    } else {
      code += `${this.getIndent()}args: {},\n`;
    }

    if (node.timeout) {
      code += `${this.getIndent()}timeout: ${node.timeout.value}${node.timeout.unit === 's' ? '000' : ''},\n`;
    }

    code += `${this.getIndent()}caller: this\n`;

    this.indent--;
    code += `${this.getIndent()}})`;
    return this.emit(`${this.getIndent()}${code};\n`, node);
  }

  // ============================================================
  // Playbook composition helpers
  // ============================================================

  generatePlaybookPartExpression(part) {
    if (part.type === 'StringPart') {
      return JSON.stringify(part.content.value);
    } else if (part.type === 'PromptRef') {
      return part.name.name;
    } else if (part.type === 'PromptCall') {
      const args = part.args.map(a => this.transpilePromptCallArg(a)).join(', ');
      return `${part.name.name}(${args})`;
    }
    return '""';
  }

  transpilePromptCallArg(arg) {
    if (arg.type === 'StringLiteral') return JSON.stringify(arg.value);
    if (arg.type === 'PropAccess') return `${arg.obj.name}.${arg.prop.name}`;
    if (arg.type === 'VarRef') return arg.name.name;
    return '""';
  }

  // ============================================================
  // Expressions
  // ============================================================

  generateExpression(node) {
    if (!node) return 'null';

    switch (node.type) {
      case 'BinaryExpression':
        return `(${this.generateExpression(node.left)} ${node.operator} ${this.generateExpression(node.right)})`;
      case 'UnaryExpression':
        return `${node.operator}${this.generateExpression(node.argument)}`;
      case 'NewExpression':
        return this.generateNewExpression(node);
      case 'CallExpression':
        return this.generateCall(node);
      case 'MemberExpression':
        return this.generateMember(node);
      case 'AwaitExpression':
        return this.generateAwaitExpression(node);
      case 'Identifier':
        // Add 'this.' prefix for agent properties when inside event handler
        if (this.inEventHandler && (node.name === 'peers' || node.name === 'state' || node.name === 'callAction')) {
          return `this.${node.name}`;
        }
        return node.name;
      case 'StringLiteral':
        return JSON.stringify(node.value);
      case 'RegexLiteral':
        return `/${node.pattern}/${node.flags}`;
      case 'NumberLiteral':
        return String(node.value);
      case 'BooleanLiteral':
        return String(node.value);
      case 'NullLiteral':
        return 'null';
      case 'ObjectLiteral':
        return this.generateObject(node);
      case 'ArrayLiteral':
        return this.generateArray(node);
      case 'ArrowFunction':
        return this.generateArrowFunction(node);
      case 'TemplateLiteral':
        return this.generateTemplateLiteral(node);
      case 'AssignmentExpression':
        return this.generateAssignment(node);
      case 'ConditionalExpression':
        return `(${this.generateExpression(node.test)} ? ${this.generateExpression(node.consequent)} : ${this.generateExpression(node.alternate)})`;
      default:
        return `/* Unknown expr: ${node.type} */`;
    }
  }

  transformSendExpressions(code) {
    // Transform: await send target.event("name").role(Role).any()(args) timeout Xs
    // To: await Runtime.send({ base: this.target, filters: [...], args: args, timeout: X000 })

    const sendRegex = /await\s+send\s+(\w+)\.event\("([^"]+)"\)((?:\.\w+\([^)]*\))*)\s*\(([^)]*)\)(?:\s+timeout\s+(\d+)(s|ms))?/g;

    return code.replace(sendRegex, (match, target, eventName, chain, args, timeoutVal, timeoutUnit) => {
      const filters = [`{ type: 'event', name: "${eventName}" }`];

      // Parse the chain (.role(X).any())
      if (chain) {
        const roleMatch = chain.match(/\.role\((\w+)\)/);
        if (roleMatch) {
          filters.push(`{ type: 'role', role: ${roleMatch[1]} }`);
        }

        const selectMatch = chain.match(/\.(any|all|first)\(\)/);
        if (selectMatch) {
          filters.push(`{ type: 'select', mode: '${selectMatch[1]}' }`);
        }
      }

      // If target is 'peers', it refers to this.peers in the agent context
      const targetExpr = target === 'peers' ? 'this.peers' : target;

      let result = `await Runtime.send({ base: ${targetExpr}, filters: [${filters.join(', ')}], args: ${args || '{}'}`;

      if (timeoutVal) {
        const timeout = timeoutUnit === 's' ? parseInt(timeoutVal) * 1000 : parseInt(timeoutVal);
        result += `, timeout: ${timeout}`;
      }

      result += ', caller: this })';
      return result;
    });
  }

  generateAwaitExpression(node) {
    // Check if this is a regular await expression (await someFunction())
    // or a send expression (await send ...)
    if (node.argument) {
      // Regular await expression - just generate: await <expression>
      return `await ${this.generateExpression(node.argument)}`;
    }

    // Send expression - generate Runtime.send(...)
    let code = `await Runtime.send({\n`;
    this.indent++;
    code += `${this.getIndent()}base: ${this.generateExpression(node.target.base)},\n`;

    if (node.target.filters.length > 0) {
      code += `${this.getIndent()}filters: [\n`;
      this.indent++;
      for (const filter of node.target.filters) {
        if (filter.type === 'EventFilter') {
          code += `${this.getIndent()}{ type: 'event', name: ${this.generateExpression(filter.event)} },\n`;
        } else if (filter.type === 'RoleFilter') {
          code += `${this.getIndent()}{ type: 'role', role: ${filter.role.name}_role },\n`;
        } else if (filter.type === 'SelectionFilter') {
          code += `${this.getIndent()}{ type: 'select', mode: '${filter.mode}' },\n`;
        }
      }
      this.indent--;
      code += `${this.getIndent()}],\n`;
    }

    // Pass arguments: single argument directly, multiple as array
    if (node.arguments.length === 1) {
      code += `${this.getIndent()}args: ${this.generateExpression(node.arguments[0])},\n`;
    } else if (node.arguments.length > 1) {
      code += `${this.getIndent()}args: [${node.arguments.map(arg => this.generateExpression(arg)).join(', ')}],\n`;
    } else {
      code += `${this.getIndent()}args: {},\n`;
    }

    if (node.timeout) {
      code += `${this.getIndent()}timeout: ${node.timeout.value}${node.timeout.unit === 's' ? '000' : ''}\n`;
    }

    this.indent--;
    code += `${this.getIndent()}})`;
    return code;
  }

  generateNewExpression(node) {
    const callee = this.generateExpression(node.callee);
    const args = node.arguments.map(arg => this.generateExpression(arg)).join(', ');
    return `new ${callee}(${args})`;
  }

  generateCall(node) {
    // Special handling for peers(TeamName) - access specific team
    if (this.inEventHandler &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'peers' &&
        node.arguments.length === 1) {
      // peers(TeamName) → this._getTeam(TeamName)
      const teamName = this.generateExpression(node.arguments[0]);
      return `this._getTeam(${teamName})`;
    }

    const callee = this.generateExpression(node.callee);
    const args = node.arguments.map(arg => this.generateExpression(arg)).join(', ');
    const optional = node.optional ? '?.' : '';
    return `${callee}${optional}(${args})`;
  }

  generateMember(node) {
    const obj = this.generateExpression(node.object);
    const optional = node.optional ? '?' : '';

    // Check if property is computed (array access with brackets)
    if (node.computed || node.property.type === 'NumberLiteral') {
      const prop = this.generateExpression(node.property);
      return `${obj}${optional}[${prop}]`;
    }

    // Regular property access with dot notation
    const prop = typeof node.property === 'string'
      ? node.property
      : node.property.name || this.generateExpression(node.property);
    return `${obj}${optional}.${prop}`;
  }

  generateObject(node) {
    if (node.properties.length === 0) return '{}';

    const props = node.properties.map(prop => {
      // Handle spread properties (...expr)
      if (prop.type === 'SpreadProperty') {
        return `...${this.generateExpression(prop.argument)}`;
      }
      // Regular key: value properties
      const key = prop.key.name || prop.key.value;
      const value = this.generateExpression(prop.value);
      return `${key}: ${value}`;
    }).join(', ');

    return `{ ${props} }`;
  }

  generateArray(node) {
    const elements = node.elements.map(el => this.generateExpression(el)).join(', ');
    return `[${elements}]`;
  }

  generateArrowFunction(node) {
    // Generate parameters
    const params = node.params.map(p => p.name || p).join(', ');
    const asyncKeyword = node.isAsync ? 'async ' : '';

    // Generate body
    if (node.body.type === 'BlockStatement') {
      // Multi-statement body with {}
      let body = '{\n';
      this.indent++;
      for (const stmt of node.body.statements) {
        body += this.generateStatement(stmt);
      }
      this.indent--;
      body += `${this.getIndent()}}`;
      return `${asyncKeyword}(${params}) => ${body}`;
    } else {
      // Expression body (implicit return)
      const body = this.generateExpression(node.body);

      // If body is an object literal, wrap it in parentheses to avoid ambiguity
      if (node.body.type === 'ObjectLiteral') {
        return `${asyncKeyword}(${params}) => (${body})`;
      }

      return `${asyncKeyword}(${params}) => ${body}`;
    }
  }

  generateTemplateLiteral(node) {
    if (node.parts.length === 0) {
      return '``';
    }

    const parts = node.parts.map(part => {
      if (part.type === 'TemplateString') {
        // Raw string part - keep as-is but escape backticks
        return part.value.replace(/`/g, '\\`');
      } else if (part.type === 'TemplateExpression') {
        // Expression part ${...}
        return '${' + this.generateExpression(part.expression) + '}';
      }
      return '';
    }).join('');

    return `\`${parts}\``;
  }

  generateAssignment(node) {
    const left = this.generateExpression(node.left);
    const right = this.generateExpression(node.right);
    return `${left} ${node.operator} ${right}`;
  }
}
