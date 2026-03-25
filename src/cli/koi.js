#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KoiTranspiler, KoiSemanticError } from '../compiler/transpiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;

const COMMANDS = {
  compile: 'Compile Koi files to JavaScript',
  run: 'Compile and run Koi files',
  serve: 'Start an agent as an MCP server (stdio)',
  init: 'Initialize a new Koi project',
  cache: 'Manage build cache (stats, clear)',
  registry: 'Manage registry data (stats, clear)',
  version: 'Show version information (and credits)',
  help: 'Show this help message'
};

const FLAGS = {
  '--no-precalculate': 'Disable description pre-generation (dynamic at runtime)',
  '--no-cache': 'Disable persistent cache (always regenerate descriptions)',
  '--verbose': 'Show detailed output',
  '--debug': 'Show all LLM prompts and responses',
  '--log [file]': 'Log internal activity to file (default: koi-<timestamp>.log)',
  '--output, -o': 'Specify output file path',
  '--help, -h': 'Show help for a command'
};

function showBanner() {
  const red  = '\x1b[1m\x1b[38;2;235;65;72m';
  const blue = '\x1b[1m\x1b[38;2;80;150;255m';
  const reset = '\x1b[0m';
  const grey = '\x1b[38;2;140;140;140m';
  const koi = `${blue}Ko${red}i${reset}`;
  const lines = [
    `🌊 ${koi} ${grey}v${VERSION}${reset}`,
    `${grey}   Agent-first language. Calm orchestration.${reset}`,
    `${grey}   ` + process.cwd().replace(process.env.HOME, '~') + reset,
    ' ',
    ' ',
  ];
  console.log(lines.join('\n'));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function showHelp(command = null) {
  if (command) {
    showCommandHelp(command);
    return;
  }

  showBanner();
  console.log('Usage: koi <command> [options] [file]\n');

  console.log('Commands:');
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(12)} ${desc}`);
  }

  console.log('\nGlobal Flags:');
  for (const [flag, desc] of Object.entries(FLAGS)) {
    console.log(`  ${flag.padEnd(20)} ${desc}`);
  }

  console.log('\nExamples:');
  console.log('  koi run examples/hello-world.koi           # Runs with auto-optimization');
  console.log('  koi compile examples/simple.koi            # Compiles with cache');
  console.log('  koi compile -o output.js examples/simple.koi');
  console.log('  koi init my-project');
  console.log('  koi cache stats');
  console.log('  koi registry clear');
  console.log('  koi version');
  console.log('\nInteractive assistant:');
  console.log('  koi-cli                                    # Launch interactive CLI (install separately)');

  console.log('\nGet started:');
  console.log('  1. Create a .env file with your OpenAI API key');
  console.log('  2. Run: koi run examples/hello-world.koi');
  console.log('  3. Embeddings are pre-computed and cached automatically!');

  console.log('\nDocumentation:');
  console.log('  README.md - Full language documentation');
  console.log('  SETUP_LLM.md - LLM integration guide');
  console.log('  examples/ - Example Koi programs');
}

function showCommandHelp(command) {
  showBanner();

  switch (command) {
    case 'compile':
      console.log('koi compile - Compile Koi source to JavaScript\n');
      console.log('By default: Pre-generates handler descriptions and caches them.');
      console.log('Use --no-precalculate or --no-cache to customize behavior.\n');
      console.log('Usage:');
      console.log('  koi compile <file.koi>');
      console.log('  koi compile -o <output.js> <file.koi>\n');
      console.log('Options:');
      console.log('  -o, --output <path>      Output file path');
      console.log('  --no-precalculate        Disable description pre-generation (dynamic at runtime)');
      console.log('  --no-cache               Disable persistent cache (always regenerate)');
      console.log('\nExamples:');
      console.log('  koi compile examples/simple.koi                    # Default: pre-compute + cache');
      console.log('  koi compile --no-cache examples/simple.koi         # Pre-compute without cache');
      console.log('  koi compile --no-precalculate examples/simple.koi  # No pre-computation');
      console.log('  koi compile -o dist/app.js src/main.koi');
      break;

    case 'run':
      console.log('koi run - Compile and execute Koi programs\n');
      console.log('By default: Pre-generates handler descriptions and caches them.\n');
      console.log('Usage:');
      console.log('  koi run <file.koi>\n');
      console.log('Options:');
      console.log('  --no-precalculate     Disable description pre-generation');
      console.log('  --no-cache            Disable persistent cache');
      console.log('  --verbose             Show detailed execution logs');
      console.log('\nExamples:');
      console.log('  koi run examples/hello-world.koi                   # Default: pre-compute + cache');
      console.log('  koi run --no-cache examples/hello-world.koi        # No persistent cache');
      break;

    case 'init':
      console.log('koi init - Initialize a new Koi project\n');
      console.log('Usage:');
      console.log('  koi init <project-name>\n');
      console.log('Examples:');
      console.log('  koi init my-agent-system');
      console.log('  koi init ./my-project');
      break;

    case 'cache':
      console.log('koi cache - Manage build cache\n');
      console.log('Usage:');
      console.log('  koi cache stats       Show cache statistics');
      console.log('  koi cache clear       Clear all cache');
      console.log('  koi cache clear <file> Clear cache for specific file\n');
      console.log('The cache stores pre-generated handler descriptions to avoid API calls.');
      console.log('Cache is stored in .koi/cache/ directory.\n');
      console.log('Examples:');
      console.log('  koi cache stats');
      console.log('  koi cache clear');
      console.log('  koi cache clear src/main.koi');
      break;

    case 'serve':
      console.log('koi serve - Start an agent as an MCP server\n');
      console.log('Compiles a .koi file and starts an MCP server over stdio (JSON-RPC 2.0).');
      console.log('The agent must use `expose mcp` to export its handlers as MCP tools.\n');
      console.log('Usage:');
      console.log('  koi serve <file.koi>\n');
      console.log('Options:');
      console.log('  --no-precalculate     Disable description pre-generation');
      console.log('  --no-cache            Disable persistent cache\n');
      console.log('Examples:');
      console.log('  koi serve src/my-agent.koi');
      console.log('\nUse in .mcp.json:');
      console.log('  { "mcpServers": { "my-agent": { "command": "koi", "args": ["serve", "agent.koi"] } } }');
      break;

    case 'registry':
      console.log('koi registry - Manage registry data\n');
      console.log('Usage:');
      console.log('  koi registry stats    Show registry statistics');
      console.log('  koi registry clear    Clear all registry data\n');
      console.log('The registry is a shared data store for agent collaboration.');
      console.log('Data is stored based on the configured backend (default: local files).\n');
      console.log('Examples:');
      console.log('  koi registry stats');
      console.log('  koi registry clear');
      break;

    default:
      console.log(`Unknown command: ${command}\n`);
      showHelp();
  }
}

function showVersion({ includeCredits = false } = {}) {
  console.log(`Koi version ${VERSION}`);
  if (includeCredits) {
    console.log('Written by Antonio Párraga Navarro (aka Programming Motherfucker 100x)');
  }
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
}

function showCredits() {
  showVersion({ includeCredits: true });
}

async function compileFile(sourcePath, outputPath = null, options = {}) {
  const { channel: cliLogger } = await import('../runtime/io/channel.js');
  const verbose = options.verbose || false;

  if (verbose) {
    console.log(`\n📦 Compiling: ${sourcePath}`);

    // Show development mode if KOI_RUNTIME_PATH is set
    if (process.env.KOI_RUNTIME_PATH) {
      console.log(`🔧 Development mode: Using local runtime from ${process.env.KOI_RUNTIME_PATH}`);
    }
  }

  // Check if we need to build the parser first
  const parserPath = path.join(__dirname, '../compiler/parser.js');
  if (!fs.existsSync(parserPath)) {
    cliLogger.progress('⚠️  Parser not found. Building grammar...');
    await buildGrammar();
    cliLogger.clear();
  }

  // Import parser dynamically
  const { parse } = await import('../compiler/parser.js');

  // Read source
  const source = fs.readFileSync(sourcePath, 'utf-8');

  // Parse
  if (verbose) {
    cliLogger.progress('🔍 Parsing...');
  }
  let ast;
  try {
    ast = parse(source);
    if (verbose) {
      cliLogger.clear();
    }
  } catch (error) {
    if (verbose) {
      cliLogger.clear();
    }
    console.error(`❌ Parse error in ${sourcePath}:`);
    if (error.location) {
      console.error(`  Line ${error.location.start.line}, Column ${error.location.start.column}`);
      console.error(`  ${error.message}`);

      // Show source context
      const lines = source.split('\n');
      const lineNum = error.location.start.line - 1;
      if (lineNum >= 0 && lineNum < lines.length) {
        console.error(`\n  ${lines[lineNum]}`);
        console.error(`  ${' '.repeat(error.location.start.column - 1)}^`);
      }
    } else {
      console.error(`  ${error.message}`);
    }
    process.exit(1);
  }

  // Resolve imports
  if (verbose) {
    cliLogger.progress('📦 Resolving imports...');
  }
  const { ImportResolver } = await import('../compiler/import-resolver.js');
  const importResolver = new ImportResolver(parse);
  try {
    ast = await importResolver.resolveImports(ast, sourcePath);

    if (verbose) {
      const counts = {
        skills: importResolver.importedSkills.length,
        agents: importResolver.importedAgents.length,
        roles: importResolver.importedRoles.length,
        teams: importResolver.importedTeams.length,
        external: importResolver.externalImports.length
      };

      const total = counts.skills + counts.agents + counts.roles + counts.teams + counts.external;

      if (total > 0) {
        cliLogger.clear();
        const parts = [];
        if (counts.skills > 0) parts.push(`${counts.skills} skill(s)`);
        if (counts.agents > 0) parts.push(`${counts.agents} agent(s)`);
        if (counts.roles > 0) parts.push(`${counts.roles} role(s)`);
        if (counts.teams > 0) parts.push(`${counts.teams} team(s)`);
        if (counts.external > 0) parts.push(`${counts.external} external module(s)`);
        console.log(`✅ Imported ${parts.join(', ')}`);
      }
    }
    if (verbose) {
      cliLogger.clear();
    }
  } catch (error) {
    if (verbose) {
      cliLogger.clear();
    }
    const file = error.sourceFile || sourcePath;
    console.error(`❌ Parse error in ${file}:`);
    if (error.location) {
      console.error(`  Line ${error.location.start.line}, Column ${error.location.start.column}`);
      try {
        const errSrc = fs.readFileSync(file, 'utf-8').split('\n');
        const lineNum = error.location.start.line - 1;
        if (lineNum >= 0 && lineNum < errSrc.length) {
          console.error(`\n  ${errSrc[lineNum]}`);
          console.error(`  ${' '.repeat(error.location.start.column - 1)}^`);
        }
      } catch { /* file unreadable */ }
    }
    console.error(`  ${error.message}`);
    process.exit(1);
  }

  // Build-time optimization: BY DEFAULT pre-calculate and cache
  // Use --no-precalculate to disable pre-calculation (dynamic at runtime)
  // Use --no-cache to disable persistent cache (always regenerate)
  let cacheData = null;

  const shouldPrecalculate = !options.noPrecalculate;
  const shouldCache = !options.noCache;

  // Build a combined source fingerprint that includes the entry file AND all
  // imported files. This ensures the cache is invalidated when ANY imported
  // .koi file changes (e.g. navigator.koi), not just the entry system.koi.
  let sourceFingerprint = source;
  if (importResolver.processedFiles.size > 0) {
    const importedContents = [...importResolver.processedFiles]
      .sort() // deterministic order
      .map(f => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } });
    sourceFingerprint = source + '\n' + importedContents.join('\n');
  }

  if (shouldPrecalculate) {
    const { CacheManager } = await import('../compiler/cache-manager.js');
    const cacheManager = new CacheManager({ verbose: options.verbose });

    // Try to load from cache if caching is enabled
    if (shouldCache) {
      if (verbose) {
        cliLogger.progress('🔍 Checking cache...');
      }
      cacheData = cacheManager.get(sourceFingerprint, sourcePath);

      if (cacheData && verbose) {
        cliLogger.success(`✅ Using cached descriptions (${cacheData.metadata.totalAffordances} affordances)`);
      } else if (verbose) {
        cliLogger.clear();
      }
    }

    // Generate if no cache or cache disabled
    if (!cacheData) {
      const { BuildTimeOptimizer } = await import('../compiler/build-optimizer.js');
      const optimizer = new BuildTimeOptimizer({
        cache: shouldCache,
        verbose: options.verbose
      });

      try {
        if (shouldCache) {
          if (verbose) {
            cliLogger.progress('🔄 Generating handler descriptions...');
          }
          cacheData = await optimizer.optimizeAST(ast, sourceFingerprint, sourcePath);
          if (verbose) {
            cliLogger.success(`✅ Generated ${cacheData.metadata.totalAffordances} descriptions`);
          }
        } else {
          if (verbose) {
            cliLogger.progress('🔄 Generating handler descriptions (no cache)...');
          }
          cacheData = await optimizer.optimizeASTWithoutCache(ast);
          if (verbose) {
            cliLogger.success(`✅ Generated ${cacheData.metadata.totalAffordances} descriptions`);
          }
        }
      } catch (error) {
        if (verbose) {
          cliLogger.clear();
        }
        console.error('⚠️  Build-time optimization failed:', error.message);
        console.error('   Continuing without pre-generated descriptions...\n');
      }
    }
  } else {
    if (options.verbose) {
      cliLogger.info('[Optimizer] Pre-generation disabled. Runtime will generate descriptions dynamically.');
    }
  }

  // Determine output path first (needed for transpiler to calculate runtime path)
  if (!outputPath) {
    // Create .build directory if it doesn't exist
    const buildDir = path.join(path.dirname(sourcePath), '.build');
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }

    // Ensure package.json exists in .build directory for ES modules
    const packageJsonPath = path.join(buildDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      fs.writeFileSync(packageJsonPath, JSON.stringify({ type: 'module' }, null, 2));
    }

    const basename = path.basename(sourcePath, '.koi');
    outputPath = path.join(buildDir, basename + '.ts');
  }

  // Transpile with output path so it can calculate correct runtime import path
  if (verbose) {
    cliLogger.progress('🔨 Transpiling...');
  }
  // Ensure KOI_RUNTIME_PATH is set so the transpiler emits absolute file:// imports
  // instead of @koi-language/koi package imports (which require the package in node_modules)
  if (!process.env.KOI_RUNTIME_PATH) {
    process.env.KOI_RUNTIME_PATH = path.resolve(__dirname, '../runtime');
  }

  const runtimePath = path.join(__dirname, '../runtime/index.js');
  const transpiler = new KoiTranspiler(path.basename(sourcePath), {
    cacheData,
    outputPath: path.resolve(outputPath),
    runtimePath: path.resolve(runtimePath),
    externalImports: importResolver.externalImports
  });
  let code, map;
  try {
    ({ code, map } = transpiler.transpile(ast));
  } catch (error) {
    cliLogger.clear();
    if (error instanceof KoiSemanticError) {
      console.error('❌ Semantic error:');
      if (error.location) {
        console.error(`  Line ${error.location.start.line}, Column ${error.location.start.column}`);
        console.error(`  ${error.message}`);
        // Show source context if available
        try {
          const lines = fs.readFileSync(sourcePath, 'utf-8').split('\n');
          const line = lines[error.location.start.line - 1];
          if (line) {
            console.error(`\n  ${line}`);
            console.error(`  ${' '.repeat(error.location.start.column - 1)}^`);
          }
        } catch (_) {}
      } else {
        console.error(`  ${error.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
  if (verbose) {
    cliLogger.clear();
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });

    // Ensure package.json exists in output directory for ES modules
    const packageJsonPath = path.join(outputDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      fs.writeFileSync(packageJsonPath, JSON.stringify({ type: 'module' }, null, 2));
    }
  }

  // Write output
  if (verbose) {
    cliLogger.progress(`💾 Writing: ${outputPath}`);
  }
  fs.writeFileSync(outputPath, code + `\n//# sourceMappingURL=${path.basename(outputPath)}.map`);
  fs.writeFileSync(outputPath + '.map', map);
  if (verbose) {
    cliLogger.clear();
  }

  if (verbose) {
    console.log('✅ Compilation complete!\n');
  }
  return outputPath;
}

async function runFile(sourcePath, options = {}) {
  const verbose = options.verbose || false;
  const debug = options.debug || false;

  // Show simple 1-line progress during compilation (cleared before child spawns)
  const isCli = process.env.KOI_CLI_MODE === '1';

  if (!verbose && !isCli) {
    process.stdout.write(`🌊 Running ${sourcePath}`);
  }

  // Compile first
  const jsPath = await compileFile(sourcePath, null, options);

  // Clear the "🌊 Running" line now that compilation is done
  if (!verbose && !isCli) {
    process.stdout.write('\r\x1b[K');
  }

  // Run
  if (verbose) {
    console.log(`🚀 Executing: ${jsPath}\n`);
    console.log('─'.repeat(60));
  }

  // Execute in a child process to avoid module cache issues
  // This ensures each run uses the freshly compiled code
  const { spawn } = await import('child_process');

  // Prepare environment variables (pass COLUMNS so child knows terminal width)
  const env = { ...process.env };
  if (process.stdout.columns) {
    env.COLUMNS = String(process.stdout.columns);
  }
  if (debug) {
    env.KOI_DEBUG_LLM = '1';
  }
  if (options.log) {
    // --log or --log myfile.log
    const logFile = typeof options.log === 'string'
      ? options.log
      : 'koi.log';
    env.KOI_LOG_FILE = path.resolve(logFile);
    console.log(`📝 Logging to: ${env.KOI_LOG_FILE}\n`);
  }

  // Session management: check for previous session or create new one
  const projectRoot = process.cwd();
  let sessionId;

  if (options.resume) {
    sessionId = options.resume;
  }

  // Honour session ID set by the parent process (e.g. koi-cli.js sets
  // KOI_SESSION_ID before spawning `koi run system.koi`).
  if (!sessionId && process.env.KOI_SESSION_ID) {
    sessionId = process.env.KOI_SESSION_ID;
  }

  if (!sessionId) {
    sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  env.KOI_SESSION_ID = sessionId;
  env.KOI_PROJECT_ROOT = projectRoot;

  // Clean up old sessions (>7 days)
  cleanOldSessions(projectRoot);

  // Prefer the local tsx binary bundled with @koi-language/koi.
  // Fall back to global tsx / npx tsx only if the local one is missing.
  const { existsSync: _exists } = await import('fs');
  const tsxLocal = path.join(__dirname, '../../node_modules/.bin/tsx');
  const [tsxBin, tsxArgs] = _exists(tsxLocal)
    ? [tsxLocal, [jsPath]]
    : ['npx', ['tsx', jsPath]];

  const child = spawn(tsxBin, tsxArgs, {
    stdio: 'inherit',
    env,
    shell: false
  });

  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code !== 0) {
        // Exit silently - error message already shown by child process
        process.exit(code);
      } else {
        const pendingFile = path.join(projectRoot, '.koi', '.resume-pending');
        if (process.env.KOI_CLI_MODE === '1' && !_exists(pendingFile)) {
          process.stderr.write(`\x1b[2mResume this session with:\nkoi-cli --resume ${sessionId}\x1b[0m\n\n`);
        }
        resolve();
      }
    });

    child.on('error', (error) => {
      console.error('\n❌ Runtime error:');
      console.error(error);
      process.exit(1);
    });
  });
}

async function serveFile(sourcePath, options = {}) {
  // Ensure KOI_RUNTIME_PATH is set so the transpiler emits absolute file:// imports
  // instead of @koi-language/koi package imports (which may not resolve in all contexts)
  if (!process.env.KOI_RUNTIME_PATH) {
    process.env.KOI_RUNTIME_PATH = path.resolve(__dirname, '../runtime');
  }

  // Compile the .koi file to JS
  const jsPath = await compileFile(sourcePath, null, options);

  // The compiled output uses .ts extension and needs tsx to run.
  // Write a temporary .mjs serve script (not .ts to avoid esbuild issues with tsx --eval)
  // that loads the compiled module and starts the MCP server.
  const { spawn: _spawn } = await import('child_process');
  const { existsSync: _exists } = await import('fs');

  const routerPath = path.resolve(__dirname, '../runtime/router.js');
  const mcpServerPath = path.resolve(__dirname, '../runtime/mcp/mcp-agent-server.js');
  const compiledAbsPath = path.resolve(jsPath);

  const serveScriptPath = path.join(path.dirname(compiledAbsPath), '_mcp-serve.mjs');

  const serveScript = `// Auto-generated MCP serve script
// The compiled module's IIFE registers agents then calls process.exit(0).
// We intercept exit(0) and resolve a promise when it fires, signalling registration is done.
let resolveReady;
const ready = new Promise(r => { resolveReady = r; });
const origExit = process.exit;
process.exit = (code) => {
  if (code !== 0) origExit(code);
  resolveReady();
};
(async () => {
  const { agentRouter } = await import('file://${routerPath}');
  await import('file://${compiledAbsPath}');
  await ready;
  process.exit = origExit;
  let target = null;
  for (const agent of agentRouter.agents.values()) {
    if (agent.exposesMCP) { target = agent; break; }
  }
  if (!target) { process.stderr.write('No agent with expose mcp found\\n'); process.exit(1); }
  const { MCPAgentServer } = await import('file://${mcpServerPath}');
  const server = new MCPAgentServer(target);
  server.start();
})().catch(err => { process.stderr.write(String(err.stack || err) + '\\n'); origExit(1); });
`;

  fs.writeFileSync(serveScriptPath, serveScript);

  const tsxLocal = path.join(__dirname, '../../node_modules/.bin/tsx');
  const [tsxBin, tsxArgs] = _exists(tsxLocal)
    ? [tsxLocal, [serveScriptPath]]
    : ['npx', ['tsx', serveScriptPath]];

  const child = _spawn(tsxBin, tsxArgs, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env },
    shell: false
  });

  return new Promise((resolve) => {
    child.on('exit', (code) => {
      // Clean up the temp script
      try { fs.unlinkSync(serveScriptPath); } catch {}
      process.exit(code || 0);
    });
    child.on('error', (err) => {
      try { fs.unlinkSync(serveScriptPath); } catch {}
      console.error('❌ Failed to start MCP server:', err.message);
      process.exit(1);
    });
  });
}

async function buildGrammar() {
  const { execSync } = await import('child_process');
  const grammarPath = path.join(__dirname, '../grammar/koi.pegjs');
  const outputPath = path.join(__dirname, '../compiler/parser.js');

  console.log('🏗️  Building parser from grammar...');
  try {
    execSync(`npx peggy --format es -o "${outputPath}" "${grammarPath}"`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '../..')
    });
    console.log('✅ Parser built successfully!\n');
  } catch (error) {
    console.error('❌ Failed to build parser');
    process.exit(1);
  }
}

async function initProject(projectName) {
  if (!projectName) {
    console.error('❌ Please provide a project name');
    console.log('Usage: koi init <project-name>');
    process.exit(1);
  }

  const projectPath = path.resolve(projectName);

  if (fs.existsSync(projectPath)) {
    console.error(`⚠️ Directory already exists: ${projectPath}`);
    process.exit(1);
  }

  console.log(`🌊 Initializing Koi project: ${projectName}\n`);

  // Create directories
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'src'));
  fs.mkdirSync(path.join(projectPath, 'dist'));

  // Create example main.koi
  const exampleCode = `// ${projectName} - Koi Project
package "${projectName}"

role Worker { can execute }

// Agent with LLM playbook - generates creative greetings
Agent Greeter : Worker {
  llm default = { provider: "auto", model: "auto" }

  on greet(args: Json) {
    playbook """
    Generate a friendly and creative greeting for \${args.name}.

    The greeting should:
    - Start with "Hello"
    - Include the person's name
    - Add a motivational message or fun fact
    - Be brief (2-3 sentences)

    Return JSON: { "greeting": "your greeting here", "emoji": "an appropriate emoji" }
    """
  }
}

run Greeter.greet({ name: "World" })
`;

  fs.writeFileSync(path.join(projectPath, 'src', 'main.koi'), exampleCode);

  // Create package.json
  const packageJson = {
    name: projectName.toLowerCase().replace(/\s+/g, '-'),
    version: '1.0.0',
    description: `${projectName} - Koi project`,
    type: 'module',
    scripts: {
      start: 'koi run src/main.koi',
      compile: 'koi compile src/main.koi'
    },
    keywords: ['koi', 'agents'],
    author: '',
    license: 'MIT',
    dependencies: {
      '@koi-language/koi': '^1.0.0'
    }
  };

  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));

  // Create .env.example
  const envExample = `# OpenAI API Key
OPENAI_API_KEY=your-key-here

# Anthropic API Key (optional)
# ANTHROPIC_API_KEY=your-key-here
`;

  fs.writeFileSync(path.join(projectPath, '.env.example'), envExample);

  // Create README
  const readme = `# ${projectName}

Koi project - Agent-first language. Calm orchestration.

## Quick Start

1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

2. Configure API key:
   \`\`\`bash
   cp .env.example .env
   # Edit .env and add your OpenAI API key
   \`\`\`

3. Run:
   \`\`\`bash
   npm start
   # or directly: koi run src/main.koi
   \`\`\`

## Structure

- \`src/\` - Koi source files (.koi)
- \`dist/\` - Compiled JavaScript output

## Documentation

- [Koi Language Docs](https://github.com/yourusername/koi)
`;

  fs.writeFileSync(path.join(projectPath, 'README.md'), readme);

  // Create .gitignore
  const gitignore = `node_modules/
.env
dist/
.build/
.koi/
*.js.map
.DS_Store
`;

  fs.writeFileSync(path.join(projectPath, '.gitignore'), gitignore);

  console.log('✅ Project initialized!');
  console.log(`\nNext steps:`);
  console.log(`  cd ${projectName}`);
  console.log(`  npm install`);
  console.log(`  cp .env.example .env`);
  console.log(`  # Edit .env and add your API key`);
  console.log(`  npm start`);
}

/**
 * Clean up session tracking directories older than 7 days.
 */
function cleanOldSessions(projectRoot) {
  const sessionsDir = path.join(projectRoot, '.koi', 'sessions');
  if (!fs.existsSync(sessionsDir)) return;
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  try {
    for (const entry of fs.readdirSync(sessionsDir)) {
      const ts = parseInt(entry.split('-')[0], 10);
      if (!isNaN(ts) && now - ts > maxAge) {
        fs.rmSync(path.join(sessionsDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Non-fatal — ignore cleanup errors
  }
}

// Parse arguments and flags
function parseArgs(argv) {
  const flags = {};
  const positional = [];

  // Define which flags are boolean (don't take values)
  const booleanFlags = ['no-precalculate', 'no-cache', 'verbose', 'debug', 'help', 'h', 'version', 'v'];
  // Define which flags take values
  const valuedFlags = ['output', 'o'];
  // Flags that optionally take a value (boolean if no value follows)
  const optionalValueFlags = ['log'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      // Long flag
      const flagName = arg.slice(2);

      if (booleanFlags.includes(flagName)) {
        flags[flagName] = true;
      } else if (optionalValueFlags.includes(flagName)) {
        // Optional value: use next arg if it doesn't look like a flag or .koi file
        if (argv[i + 1] && !argv[i + 1].startsWith('-') && !argv[i + 1].endsWith('.koi')) {
          flags[flagName] = argv[++i];
        } else {
          flags[flagName] = true; // boolean mode
        }
      } else if (valuedFlags.includes(flagName)) {
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          flags[flagName] = argv[++i];
        } else {
          console.error(`⚠️ Flag --${flagName} requires a value`);
          process.exit(1);
        }
      } else {
        // Unknown flag: try to guess
        if (argv[i + 1] && !argv[i + 1].startsWith('-') && !argv[i + 1].endsWith('.koi')) {
          flags[flagName] = argv[++i];
        } else {
          flags[flagName] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flag
      const flagChar = arg[1];

      if (valuedFlags.includes(flagChar)) {
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          flags[flagChar] = argv[++i];
        } else {
          console.error(`⚠️ Flag -${flagChar} requires a value`);
          process.exit(1);
        }
      } else {
        flags[flagChar] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

// Main
const rawArgs = process.argv.slice(2);

if (rawArgs[0] === 'help' || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
  showHelp(rawArgs[1]);
  process.exit(0);
}

if (rawArgs.length === 0) {
  showHelp();
  process.exit(0);
}

const { flags, positional } = parseArgs(rawArgs);
let command = positional[0];

// Handle version
if (command === 'version' || flags.version || flags.v) {
  showVersion({ includeCredits: true });
  process.exit(0);
}



// Check command exists
if (!COMMANDS[command]) {
  console.error(`⚠️ Unknown command: ${command}\n`);
  showHelp();
  process.exit(1);
}

// Handle init
if (command === 'init') {
  await initProject(positional[1]);
  process.exit(0);
}

// Handle cache
if (command === 'cache') {
  const { CacheManager } = await import('../compiler/cache-manager.js');
  const cacheManager = new CacheManager({ verbose: true });

  const subcommand = positional[1];

  if (!subcommand || subcommand === 'stats') {
    cacheManager.printStats();
  } else if (subcommand === 'clear') {
    const targetFile = positional[2];
    if (targetFile) {
      cacheManager.clear(targetFile);
    } else {
      cacheManager.clear();
    }
  } else {
    console.error(`⚠️ Unknown cache subcommand: ${subcommand}\n`);
    console.log('Usage: koi cache [stats|clear]');
    process.exit(1);
  }

  process.exit(0);
}

// Handle registry
if (command === 'registry') {
  const { registry } = await import('../runtime/skills/registry.js');
  const subcommand = positional[1];

  if (!subcommand || subcommand === 'stats') {
    console.log('🌊 Registry Statistics\n');
    try {
      const stats = await registry.stats();
      console.log(`Total entries: ${stats.count}`);
      console.log(`Storage size:  ${formatBytes(stats.size)}`);
      console.log(`Backend:       ${stats.backend || 'local'}`);
      if (stats.location) {
        console.log(`Location:      ${stats.location}`);
      }
    } catch (error) {
      console.error(`⚠️ Failed to get registry stats: ${error.message}`);
      process.exit(1);
    }
  } else if (subcommand === 'clear') {
    console.log('🌊 Clearing Registry\n');
    try {
      const statsBefore = await registry.stats();
      console.log(`Entries before: ${statsBefore.count}`);

      await registry.clear();

      const statsAfter = await registry.stats();
      console.log(`Entries after:  ${statsAfter.count}`);
      console.log('\n✅ Registry cleared successfully!');
    } catch (error) {
      console.error(`⚠️ Failed to clear registry: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error(`⚠️ Unknown registry subcommand: ${subcommand}\n`);
    console.log('Usage: koi registry [stats|clear]');
    process.exit(1);
  }

  process.exit(0);
}

// Handle serve (MCP server mode)
if (command === 'serve') {
  const file = positional[1];

  if (!file) {
    console.error(`⚠️ Please provide a Koi file\n`);
    console.log(`Usage: koi serve <file.koi>`);
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`⚠️ File not found: ${file}`);
    process.exit(1);
  }

  await serveFile(file, {
    noPrecalculate: flags['no-precalculate'] || false,
    noCache: flags['no-cache'] || false,
    verbose: flags.verbose || false
  });
}

// Handle compile and run
if (command === 'compile' || command === 'run') {

  const file = positional[1];

  if (!file) {
    console.error(`⚠️ Please provide a Koi file\n`);
    console.log(`Usage: koi ${command} <file.koi>`);
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`⚠️ File not found: ${file}`);
    process.exit(1);
  }

  // Build options object
  // By default: pre-calculate AND cache (best performance)
  // Use --no-precalculate to disable pre-calculation (dynamic at runtime)
  // Use --no-cache to disable persistent cache (always regenerate)
  const options = {
    noPrecalculate: flags['no-precalculate'] || false,
    noCache: flags['no-cache'] || false,
    verbose: flags.verbose || false,
    debug: flags.debug || false,
    log: flags.log || false
  };

  if (command === 'compile') {
    const outputPath = flags.output || flags.o;
    await compileFile(file, outputPath, options);
  } else if (command === 'run') {
    await runFile(file, options);
  }
}
