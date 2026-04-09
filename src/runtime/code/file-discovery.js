/**
 * File Discovery - Shared file discovery logic for search and indexing.
 *
 * Walks the project directory tree, skipping common non-source directories,
 * and returns source files filtered by extension.
 */

import fs from 'fs';
import path from 'path';

// Default ignore list — overridden by .koi/ignore-dirs.json if present
const _DEFAULT_IGNORE = [
  'node_modules', '.git', '.build', '.koi', '.koi-cache',
  'dist', 'build', 'out', 'target', 'coverage', 'generated',
  '__pycache__', '.next', '.nuxt', '.svelte-kit', '.output',
  'vendor', '.venv', 'venv', 'env',
  '.dart_tool', '.flutter-plugins', '.pub-cache',
  '.gradle', '.idea', '.vscode', '.vs',
  'Pods', 'DerivedData', 'xcuserdata',
];

let _ignoreDirs = null;

export function getIgnoreDirs() {
  if (_ignoreDirs) return _ignoreDirs;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const configPath = path.join(projectRoot, '.koi', 'ignore-dirs.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (Array.isArray(data)) {
        _ignoreDirs = new Set(data);
        return _ignoreDirs;
      }
    }
  } catch { /* use defaults */ }
  // Create the file with defaults so the user can customize it
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(_DEFAULT_IGNORE, null, 2) + '\n');
  } catch { /* non-critical */ }
  _ignoreDirs = new Set(_DEFAULT_IGNORE);
  return _ignoreDirs;
}

// Backwards compat — existing code imports IGNORE_DIRS directly
export const IGNORE_DIRS = { has(name) { return getIgnoreDirs().has(name); } };

// Default indexable extensions + filenames — overridden by .koi/index-extensions.json
const _DEFAULT_EXTENSIONS = [
  // C / C++
  '.c', '.h', '.i', '.cc', '.cp', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx',
  '.inl', '.ipp', '.ixx', '.tpp',
  // Objective-C
  '.m', '.mm',
  // Rust
  '.rs',
  // Go
  '.go',
  // Java / JVM
  '.java', '.kt', '.kts', '.scala', '.sc', '.groovy', '.gvy', '.gy', '.gsh',
  // Clojure
  '.clj', '.cljs', '.cljc', '.edn',
  // Haskell / ML / F#
  '.hs', '.lhs', '.ml', '.mli', '.fs', '.fsi', '.fsx',
  // C# / VB
  '.cs', '.csx', '.vb',
  // Swift / Dart
  '.swift', '.dart',
  // Other compiled
  '.zig', '.nim', '.nims', '.d', '.jl', '.lua',
  // Ada / Erlang / Elixir
  '.adb', '.ads', '.erl', '.hrl', '.ex', '.exs',
  // Perl / R / MATLAB / SAS / AWK / Tcl / Pascal
  '.pl', '.pm', '.pod', '.t', '.r', '.R', '.sas', '.awk', '.tcl',
  '.pas', '.pp', '.lpr',
  // Fortran / COBOL / Assembly
  '.for', '.f', '.f77', '.f90', '.f95', '.f03', '.f08',
  '.cob', '.cbl', '.cpy', '.asm', '.s', '.S',
  // Web frontend
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.vue', '.svelte', '.html', '.htm', '.xhtml',
  '.css', '.scss', '.sass', '.less', '.styl',
  // Shell & scripts
  '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh', '.tcsh',
  '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
  // Python
  '.py', '.pyw', '.pyx', '.pxd', '.pxi', '.pyi',
  // PHP
  '.php', '.phtml', '.php3', '.php4', '.php5', '.phps', '.phpt',
  // Ruby
  '.rb', '.rake', '.gemspec', '.ru', '.erb',
  // SQL
  '.sql', '.psql', '.pls', '.plsql',
  // Config / data
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.properties', '.xml', '.gradle', '.sbt', '.cmake', '.mk',
  '.tf', '.tfvars', '.hcl',
  '.proto', '.thrift', '.avdl', '.graphql', '.gql',
  // Apple
  '.storyboard', '.xib', '.plist', '.xaml',
  // Lisp / Scheme / Racket
  '.lisp', '.lsp', '.cl', '.el', '.scm', '.ss', '.rkt',
  // HDL
  '.v', '.sv', '.vh', '.svh', '.vhd', '.vhdl',
  // Blockchain / Build / Policy
  '.sol', '.move', '.bzl', '.rego', '.cue',
  // Shaders
  '.wgsl', '.glsl', '.vert', '.frag', '.geom', '.comp',
  // Koi
  '.koi',
];

// Filenames without extension that should be indexed
const _DEFAULT_FILENAMES = [
  'Makefile', 'Dockerfile', 'CMakeLists.txt', 'Jenkinsfile',
  'Rakefile', 'Gemfile', 'Podfile', 'Vagrantfile', 'Brewfile',
  'BUILD', 'WORKSPACE',
];

let _sourceExts = null;
let _sourceFilenames = null;

function _loadIndexExtensions() {
  if (_sourceExts) return;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const configPath = path.join(projectRoot, '.koi', 'index-extensions.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.extensions) _sourceExts = new Set(data.extensions);
      if (data.filenames) _sourceFilenames = new Set(data.filenames);
    }
  } catch { /* use defaults */ }
  if (!_sourceExts) {
    _sourceExts = new Set(_DEFAULT_EXTENSIONS);
    _sourceFilenames = new Set(_DEFAULT_FILENAMES);
    // Create the file so the user can customize
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ extensions: _DEFAULT_EXTENSIONS, filenames: _DEFAULT_FILENAMES }, null, 2) + '\n');
    } catch { /* non-critical */ }
  }
  if (!_sourceFilenames) _sourceFilenames = new Set(_DEFAULT_FILENAMES);
}

export function isIndexableFile(filename) {
  _loadIndexExtensions();
  if (_sourceFilenames.has(filename)) return true;
  const ext = path.extname(filename).toLowerCase();
  return ext !== '' && _sourceExts.has(ext);
}

// Backwards compat export
export const SOURCE_EXTS = { has(ext) { _loadIndexExtensions(); return _sourceExts.has(ext); } };


export function discoverFiles(baseDir, maxFiles = 5000) {
  const files = [];
  function walk(dir, depth) {
    if (depth > 15 || files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (isIndexableFile(entry.name)) files.push(full);
      }
    }
  }
  walk(baseDir, 0);
  return files;
}
