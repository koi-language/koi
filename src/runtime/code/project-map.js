/**
 * Project Map — Generates a summary of the workspace and its dependencies.
 *
 * Reads each dependency's package.json / README.md to build a human-readable
 * map that agents can use to understand the workspace layout.
 *
 * The map is cached per session and injected into agent system prompts so
 * every agent (System, Planner, Developers) knows where things are.
 *
 * Usage:
 *   const map = await getProjectMap(projectDir);
 *   // Returns a markdown string describing all projects
 */

import fs from 'fs';
import path from 'path';
import { detectLocalDependencies, listManualDependencies } from './local-dependency-detector.js';
import { channel } from '../io/channel.js';

let _cache = null;
let _cacheDir = null;

/**
 * Detect the tech stack / framework from a project directory.
 * Reads package.json, requirements.txt, etc. to identify the stack.
 */
function _detectStack(projectDir) {
  const parts = [];

  // Node.js
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Framework detection
      if (allDeps['next']) parts.push('Next.js');
      else if (allDeps['nuxt']) parts.push('Nuxt');
      else if (allDeps['@nestjs/core']) parts.push('NestJS');
      else if (allDeps['fastify']) parts.push('Fastify');
      else if (allDeps['express']) parts.push('Express');
      else if (allDeps['hono']) parts.push('Hono');
      else if (allDeps['koa']) parts.push('Koa');

      if (allDeps['react'] || allDeps['react-dom']) parts.push('React');
      if (allDeps['vue']) parts.push('Vue');
      if (allDeps['svelte']) parts.push('Svelte');
      if (allDeps['@angular/core']) parts.push('Angular');
      if (allDeps['vite']) parts.push('Vite');
      if (allDeps['esbuild']) parts.push('esbuild');
      if (allDeps['typescript']) parts.push('TypeScript');
      if (allDeps['drizzle-orm']) parts.push('Drizzle ORM');
      if (allDeps['prisma'] || allDeps['@prisma/client']) parts.push('Prisma');
      if (allDeps['stripe']) parts.push('Stripe');
      if (allDeps['ink']) parts.push('Ink (terminal UI)');

      if (parts.length === 0) parts.push('Node.js');

      // Description from package.json
      if (pkg.description) return { stack: parts.join(', '), description: pkg.description };
    } catch { /* non-fatal */ }
  }

  // Python
  if (fs.existsSync(path.join(projectDir, 'requirements.txt')) ||
      fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
    parts.push('Python');
  }

  // Go
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) parts.push('Go');

  // Rust
  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) parts.push('Rust');

  // Java
  if (fs.existsSync(path.join(projectDir, 'pom.xml'))) parts.push('Java/Maven');
  if (fs.existsSync(path.join(projectDir, 'build.gradle'))) parts.push('Java/Gradle');

  return { stack: parts.join(', ') || 'unknown', description: null };
}

/**
 * Extract a one-line description from README.md if available.
 */
function _getReadmeDescription(projectDir) {
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const fp = path.join(projectDir, name);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf8');
      // Find first non-heading, non-empty line
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('[')) continue;
        if (trimmed.length > 10) return trimmed.substring(0, 150);
      }
    } catch { /* non-fatal */ }
  }
  return null;
}

/**
 * Build the project map for the current workspace.
 * Returns a markdown string describing all projects and their relationships.
 */
export async function getProjectMap(projectDir) {
  if (_cache && _cacheDir === projectDir) return _cache;

  const projectName = path.basename(projectDir);
  // Merge auto-detected + manually registered dependencies, deduplicate by path
  // Auto deps are string paths, manual deps are objects with { path, name }
  const autoDeps = detectLocalDependencies(projectDir).map(p =>
    typeof p === 'string' ? { path: p, name: path.basename(p) } : p
  );
  const manualDeps = listManualDependencies(projectDir);
  const seen = new Set();
  const deps = [];
  for (const d of [...autoDeps, ...manualDeps]) {
    const resolved = path.resolve(d.path);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      deps.push(d);
    }
  }

  const lines = ['## Workspace Projects\n'];

  // Main project
  const mainInfo = _detectStack(projectDir);
  const mainDesc = mainInfo.description || _getReadmeDescription(projectDir) || '';
  lines.push(`- **${projectName}** (this project): ${mainInfo.stack}${mainDesc ? ' — ' + mainDesc : ''}`);

  // Dependencies
  for (const dep of deps) {
    if (!fs.existsSync(dep.path)) continue;
    // Skip node_modules subdirs, parent dirs, and duplicates of the main project
    const resolved = path.resolve(dep.path);
    if (resolved.includes('node_modules')) continue;
    if (resolved === path.resolve(projectDir)) continue;
    const depName = dep.name || path.basename(dep.path);
    // Skip if same name as main project (likely a duplicate)
    if (depName === projectName) continue;
    const relPath = path.relative(projectDir, dep.path);
    if (!relPath || relPath === '.') continue;
    const info = _detectStack(dep.path);
    if (info.stack === 'unknown') continue;
    const desc = info.description || _getReadmeDescription(dep.path) || '';
    lines.push(`- **${depName}** (${relPath}): ${info.stack}${desc ? ' — ' + desc : ''}`);
  }

  // Include the project scan (directory structure) if available
  let scanContent = '';
  try {
    scanContent = await ensureProjectScan(projectDir);
  } catch {}

  const map = lines.join('\n') + (scanContent ? '\n\n' + scanContent : '');
  _cache = map;
  _cacheDir = projectDir;

  channel.log('project-map', `Generated project map: ${deps.length} dependencies`);
  return map;
}

/**
 * Reset the cache (e.g. when dependencies change).
 */
export function resetProjectMapCache() {
  _cache = null;
  _cacheDir = null;
}

// ─── Initial project scan ──────────────────────────────────────────────────

const SCAN_FILE = 'project-scan.md';
const SCAN_VERSION = 4; // Bump this to force re-scan when format changes
const SCAN_VERSION_HEADER = '<!-- scan-version:';
const IGNORE_DIRS = new Set([
  // Build / cache
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
  '.dart_tool', '.pub-cache', '.eggs', '*.egg-info',
  // IDE / system
  '.git', '.koi', '.idea', '.vscode', '.DS_Store',
  // Data / runtime (not source code)
  'logs', 'tmp', 'temp', 'uploads', 'downloads', 'data',
  '.terraform', '.serverless',
]);

const SOURCE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt',
  '.dart', '.vue', '.svelte', '.css', '.scss', '.html', '.rb', '.php',
  '.c', '.cpp', '.h', '.cs', '.swift', '.m', '.ex', '.exs',
]);

const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pubspec.yaml', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];

// No hardcoded directory annotations — use LLM to annotate intelligently

/** Build a tree line with proper connectors */
function _treeLine(prefix, name, isLast, annotation) {
  const connector = isLast ? '└── ' : '├── ';
  const ann = annotation ? `  # ${annotation}` : '';
  return `${prefix}${connector}${name}${ann}`;
}

function _childPrefix(prefix, isLast) {
  return prefix + (isLast ? '    ' : '│   ');
}

/** Count source files (non-recursive) */
function _countSrc(dir) {
  try {
    return fs.readdirSync(dir).filter(f =>
      !f.startsWith('.') && SOURCE_EXTS.has(path.extname(f).toLowerCase())
    ).length;
  } catch { return 0; }
}

/** Count source files recursively */
function _countSrcRecursive(dir, depth = 0) {
  if (depth > 5) return 0;
  let count = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) count++;
      else if (e.isDirectory()) count += _countSrcRecursive(path.join(dir, e.name), depth + 1);
    }
  } catch {}
  return count;
}

/** Check if a directory is relevant (contains source code or key config files) */
function _isRelevantDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    // Has source files?
    if (entries.some(e => e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase()))) return true;
    // Has project markers?
    if (entries.some(e => e.isFile() && PROJECT_MARKERS.includes(e.name))) return true;
    // Has subdirs with source files? (1 level deep)
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
        if (_countSrc(path.join(dirPath, e.name)) > 0) return true;
      }
    }
  } catch {}
  return false;
}

/** Count immediate subdirectories */
function _countSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch { return 0; }
}

// Annotations are generated by LLM, not hardcoded

/** Get annotation for key config files */
function _annotateFile(name) {
  const n = name.toLowerCase();
  if (n === 'package.json') return 'Node.js project';
  if (n === 'tsconfig.json' || n.startsWith('tsconfig.')) return 'TypeScript config';
  if (n === 'pubspec.yaml') return 'Dart/Flutter project';
  if (n === 'cargo.toml') return 'Rust project';
  if (n === 'go.mod') return 'Go module';
  if (n === 'pyproject.toml' || n === 'setup.py') return 'Python project';
  if (n === 'pom.xml') return 'Maven project';
  if (n === 'build.gradle') return 'Gradle project';
  if (n.startsWith('dockerfile') || n === 'docker-compose.yml' || n === 'docker-compose.yaml') return 'Docker';
  if (n === 'makefile') return 'Build script';
  if (n === '.env.example') return 'Environment template';
  if (n === 'readme.md') return 'Documentation';
  return null;
}

/**
 * Build a smart visual tree of the project.
 * - Only shows directories that contain source code
 * - Collapses large directories (>10 subdirs with no source) into a summary
 * - Annotates directories by inspecting content, not just name
 */
function _buildTree(dir, maxDepth = 4, prefix = '', depth = 0) {
  if (depth >= maxDepth) return [];
  const lines = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  // Filter directories: only show if they contain source code or are relevant
  const allDirs = entries
    .filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const relevantDirs = allDirs.filter(d => _isRelevantDir(path.join(dir, d.name)));

  // If there are many irrelevant dirs (like jobs/), mention them as a group
  const irrelevantDirs = allDirs.filter(d => !relevantDirs.includes(d));

  // Key config files
  const keyFiles = entries.filter(e => e.isFile() && _annotateFile(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Entry point files (only at root or src level)
  const entryFiles = (depth <= 1) ? entries.filter(e =>
    e.isFile() && /^(index|main|app|server|koi-cli)\.(js|ts|jsx|tsx|py|go|rs|dart)$/i.test(e.name)
  ).filter(f => !keyFiles.some(k => k.name === f.name)) : [];

  const allItems = [
    ...keyFiles.map(f => ({ type: 'file', entry: f })),
    ...entryFiles.map(f => ({ type: 'entry', entry: f })),
    ...relevantDirs.map(d => ({ type: 'dir', entry: d })),
  ];

  // Add collapsed group for irrelevant dirs if there are many
  if (irrelevantDirs.length > 0) {
    allItems.push({ type: 'collapsed', dirs: irrelevantDirs });
  }

  allItems.forEach((item, idx) => {
    const isLast = idx === allItems.length - 1;

    if (item.type === 'file' || item.type === 'entry') {
      const ann = _annotateFile(item.entry.name) || (item.type === 'entry' ? 'Entry point' : null);
      lines.push(_treeLine(prefix, item.entry.name, isLast, ann));
    } else if (item.type === 'collapsed') {
      // Show a summary line for non-source directories
      const names = item.dirs.map(d => d.name);
      if (names.length === 1) {
        lines.push(_treeLine(prefix, `${names[0]}/`, isLast, 'non-source directory'));
      } else if (names.length <= 3) {
        lines.push(_treeLine(prefix, `${names.join('/, ')}/, ...`, isLast, `${names.length} non-source directories`));
      } else {
        lines.push(_treeLine(prefix, `... ${names.length} more directories`, isLast, 'non-source (data, output, etc.)'));
      }
    } else {
      const d = item.entry;
      const childPath = path.join(dir, d.name);
      const srcCount = _countSrc(childPath);
      const totalSrc = _countSrcRecursive(childPath);
      const subdirCount = _countSubdirs(childPath);
      const ann = null; // LLM will annotate later

      // If dir has many subdirs but no direct source files, and subdirs
      // are all similar (like jobs/date/task), collapse
      if (srcCount === 0 && subdirCount > 10 && totalSrc === 0) {
        lines.push(_treeLine(prefix, `${d.name}/`, isLast, `${subdirCount} subdirectories (data/output)`));
        // Don't recurse into this
      } else {
        const countStr = totalSrc > 0 ? ` (${totalSrc} source files)` : '';
        lines.push(_treeLine(prefix, `${d.name}/${countStr}`, isLast, ann));

        if (depth < maxDepth - 1) {
          const children = _buildTree(childPath, maxDepth, _childPrefix(prefix, isLast), depth + 1);
          lines.push(...children);
        }
      }
    }
  });

  return lines;
}

/**
 * Detect build scripts from package.json / Makefile / etc.
 */
function _detectBuildScripts(dir) {
  const scripts = [];
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts) {
        const important = ['build', 'dev', 'start', 'test', 'lint', 'watch', 'deploy', 'preview'];
        for (const key of important) {
          if (pkg.scripts[key]) scripts.push({ cmd: `npm run ${key}`, desc: pkg.scripts[key].substring(0, 80) });
        }
      }
    } catch {}
  }
  // Makefile
  if (fs.existsSync(path.join(dir, 'Makefile'))) {
    scripts.push({ cmd: 'make', desc: 'Makefile available' });
  }
  return scripts;
}

/**
 * Detect sub-projects in a workspace directory.
 */
function _detectSubProjects(dir) {
  if (PROJECT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) return null;

  const subProjects = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const childDir = path.join(dir, entry.name);
      const hasMarker = PROJECT_MARKERS.some(m => fs.existsSync(path.join(childDir, m)));
      if (hasMarker) {
        const info = _detectStack(childDir);
        subProjects.push({ name: entry.name, stack: info.stack, path: childDir });
      }
    }
  } catch {}
  return subProjects.length > 0 ? subProjects : null;
}

/**
 * Run the initial project scan and save to .koi/project-scan.md.
 * Only runs once per project (checks if scan file exists).
 */
export async function ensureProjectScan(projectDir) {
  const koiDir = path.join(projectDir, '.koi');
  const scanPath = path.join(koiDir, SCAN_FILE);

  // Check existing scan — return if up-to-date version
  if (fs.existsSync(scanPath)) {
    try {
      const existing = fs.readFileSync(scanPath, 'utf8');
      if (existing.includes(`${SCAN_VERSION_HEADER}${SCAN_VERSION}`)) return existing;
      // Outdated version — regenerate
      channel.log('project-map', `Scan version outdated (need v${SCAN_VERSION}), regenerating...`);
    } catch {}
  }

  channel.log('project-map', 'Running project scan...');
  // Show scanning status in footer
  const _s = globalThis.__koiStrings || {};
  channel.setTaskStatus?.(_s.scanningProject || 'scanning project...');

  const lines = [];
  const projectName = path.basename(projectDir);
  const subProjects = _detectSubProjects(projectDir);

  if (subProjects) {
    // ── Multi-project workspace ────────────────────────────
    lines.push(`# Workspace: ${projectName}`);
    lines.push('');
    lines.push('This directory contains multiple projects:');
    lines.push('');

    for (const sp of subProjects) {
      lines.push(`## ${sp.name} (${sp.stack})`);
      lines.push('');
      lines.push('```');
      lines.push(`${sp.name}/`);
      const tree = _buildTree(sp.path, 3, '');
      lines.push(...tree);
      lines.push('```');

      // Build scripts added after LLM annotation
      if (false) {
      }
      lines.push('');
    }
  } else {
    // ── Single project ─────────────────────────────────────
    const info = _detectStack(projectDir);
    const desc = _getReadmeDescription(projectDir);

    lines.push(`# Project: ${projectName}`);
    lines.push('');
    if (info.stack !== 'unknown') lines.push(`**Stack:** ${info.stack}`);
    if (desc) lines.push(`**Description:** ${desc}`);
    lines.push('');

    lines.push('## Tree structure');
    lines.push('');
    lines.push('```');
    lines.push(`${projectName}/`);
    const tree = _buildTree(projectDir, 3);
    lines.push(...tree);
    lines.push('```');

    // Build scripts are added AFTER LLM annotation (not passed to LLM)
  }

  const rawContent = lines.join('\n');

  // Use LLM to annotate the tree with descriptions of what each directory does
  let annotatedContent = rawContent;
  try {
    const { Agent } = await import('../agent/agent.js');
    const agent = Agent._lastActiveAgent;
    if (agent?.llmProvider) {
      channel.log('project-map', 'Annotating project tree with LLM...');
      const system = 'You are a project analyzer. Given a directory tree of a software project, add brief annotations (# comment) to each important directory explaining its purpose. Also identify and mark directories that are NOT source code (data, output, logs, generated files, etc.). Return the annotated tree ONLY — no explanation, no markdown fences.';
      const user = `Annotate this project tree. Add "# purpose" comments to directories. Mark non-source dirs. Collapse directories with many similar subdirs (e.g. "jobs/ with 60 task directories" instead of listing all).\n\n${rawContent}`;
      const result = await agent.llmProvider.callSummary(system, user, 2000);
      if (result && result.trim().length > 50) {
        // Replace the tree section with the annotated version
        annotatedContent = result.trim();
        // Re-add the header parts that were before the tree
        const headerEnd = rawContent.indexOf('```\n');
        if (headerEnd !== -1) {
          const header = rawContent.substring(0, headerEnd);
          annotatedContent = header + '```\n' + annotatedContent + '\n```';
        }
      }
    }
  } catch (err) {
    channel.log('project-map', `LLM annotation failed: ${err.message} — using raw tree`);
  }

  // Append build scripts (detected from package.json / Makefile — not LLM-generated)
  let scriptsSection = '';
  const _subProjects = _detectSubProjects(projectDir);
  if (_subProjects) {
    for (const sp of _subProjects) {
      const scripts = _detectBuildScripts(sp.path);
      if (scripts.length > 0) {
        scriptsSection += `\n### ${sp.name} — Build scripts\n\n`;
        for (const s of scripts) scriptsSection += `- \`${s.cmd}\` — \`${s.desc}\`\n`;
      }
    }
  } else {
    const scripts = _detectBuildScripts(projectDir);
    if (scripts.length > 0) {
      scriptsSection += '\n## Build scripts\n\n';
      for (const s of scripts) scriptsSection += `- \`${s.cmd}\` — \`${s.desc}\`\n`;
    }
  }

  const content = `${SCAN_VERSION_HEADER}${SCAN_VERSION} -->\n` + annotatedContent + scriptsSection + '\n';

  if (fs.existsSync(koiDir)) {
    try { fs.writeFileSync(scanPath, content, 'utf8'); } catch {}
  }

  channel.setTaskStatus?.('');
  channel.log('project-map', `Project scan complete`);
  return content;
}
