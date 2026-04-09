import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { LSPClient, pathToUri } from './lsp-client.js';
import { channel } from '../io/channel.js';

const LSP_SERVERS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.koi', 'lsp-servers');

/**
 * Language configuration: markers for detection, extension mapping,
 * LSP server binary, and installation instructions.
 */
const LANGUAGE_CONFIGS = {
  typescript: {
    markers: ['tsconfig.json', 'tsconfig.build.json', 'package.json'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    serverBin: 'typescript-language-server',
    serverArgs: ['--stdio'],
    installDir: 'typescript',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execSync('npm init -y && npm install typescript-language-server typescript', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'node_modules', '.bin', 'typescript-language-server')
  },
  python: {
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
    extensions: ['.py', '.pyi'],
    serverBin: 'pyright-langserver',
    serverArgs: ['--stdio'],
    installDir: 'python',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execSync('npm init -y && npm install pyright', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'node_modules', '.bin', 'pyright-langserver')
  },
  rust: {
    markers: ['Cargo.toml'],
    extensions: ['.rs'],
    serverBin: 'rust-analyzer',
    serverArgs: [],
    installDir: 'rust',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const platform = process.platform;
      const arch = process.arch;
      let target;
      if (platform === 'darwin' && arch === 'arm64') target = 'aarch64-apple-darwin';
      else if (platform === 'darwin') target = 'x86_64-apple-darwin';
      else if (platform === 'linux' && arch === 'x64') target = 'x86_64-unknown-linux-gnu';
      else if (platform === 'win32') target = 'x86_64-pc-windows-msvc';
      else throw new Error(`Unsupported platform for rust-analyzer: ${platform}-${arch}`);

      const url = `https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-${target}.gz`;
      const gzPath = path.join(dir, 'rust-analyzer.gz');
      const binPath = path.join(dir, 'rust-analyzer');

      execSync(`curl -sL "${url}" -o "${gzPath}" && gunzip -f "${gzPath}" && chmod +x "${binPath}"`, {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'rust-analyzer')
  },
  go: {
    markers: ['go.mod'],
    extensions: ['.go'],
    serverBin: 'gopls',
    serverArgs: ['serve'],
    installDir: 'go',
    install: (dir) => {
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      execSync('go install golang.org/x/tools/gopls@latest', {
        cwd: dir, stdio: 'pipe',
        env: { ...process.env, GOBIN: path.join(dir, 'bin') }
      });
    },
    binPath: (dir) => path.join(dir, 'bin', 'gopls')
  },
  dart: {
    markers: ['pubspec.yaml'],
    extensions: ['.dart'],
    serverBin: 'dart',
    serverArgs: ['language-server', '--protocol=lsp'],
    installDir: 'dart',
    // Dart LSP ships with the Dart/Flutter SDK — no separate install needed.
    // If `dart` is not on PATH, the user needs to install the SDK.
    install: () => { throw new Error('Dart SDK not found on PATH. Install Flutter/Dart SDK: https://flutter.dev/docs/get-started/install'); },
    binPath: () => 'dart' // always expect it on PATH
  },
  java: {
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', '.classpath'],
    extensions: ['.java'],
    serverBin: 'jdtls',
    serverArgs: [],
    installDir: 'java',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const url = 'https://www.eclipse.org/downloads/download.php?file=/jdtls/milestones/1.43.0/jdt-language-server-1.43.0-202501152348.tar.gz&r=1';
      const tarPath = path.join(dir, 'jdtls.tar.gz');
      execSync(`curl -sL "${url}" -o "${tarPath}" && tar xzf "${tarPath}" -C "${dir}" && rm "${tarPath}"`, {
        cwd: dir, stdio: 'pipe'
      });
      // Create a wrapper script
      const wrapper = path.join(dir, 'bin', 'jdtls');
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      const dataDir = path.join(dir, 'data');
      const configDir = path.join(dir, process.platform === 'darwin' ? 'config_mac' : process.platform === 'win32' ? 'config_win' : 'config_linux');
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec java -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product -Dlog.level=ALL -noverify -Xmx1G --add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED -jar "${dir}"/plugins/org.eclipse.equinox.launcher_*.jar -configuration "${configDir}" -data "${dataDir}" "$@"\n`);
      execSync(`chmod +x "${wrapper}"`, { stdio: 'pipe' });
    },
    binPath: (dir) => path.join(dir, 'bin', 'jdtls')
  },
  csharp: {
    markers: ['*.csproj', '*.sln', '*.fsproj', 'global.json'],
    extensions: ['.cs', '.fs', '.fsx'],
    serverBin: 'csharp-ls',
    serverArgs: [],
    installDir: 'csharp',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      // csharp-ls is a .NET tool — requires .NET SDK on PATH
      execSync('dotnet tool install --tool-path . csharp-ls', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'csharp-ls')
  },
  cpp: {
    markers: ['CMakeLists.txt', 'Makefile', 'compile_commands.json', 'meson.build', '.clangd'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    serverBin: 'clangd',
    serverArgs: ['--background-index'],
    installDir: 'cpp',
    // clangd ships with LLVM/Xcode — no separate install on macOS.
    // On Linux: apt install clangd or similar.
    install: () => { throw new Error('clangd not found on PATH. Install LLVM/clangd: https://clangd.llvm.org/installation'); },
    binPath: () => 'clangd'
  },
  ruby: {
    markers: ['Gemfile', 'Rakefile', '.ruby-version'],
    extensions: ['.rb', '.rake', '.gemspec'],
    serverBin: 'solargraph',
    serverArgs: ['stdio'],
    installDir: 'ruby',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execSync('gem install solargraph --install-dir .', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => {
      // gem install puts the binary in a bin/ subdir
      const localBin = path.join(dir, 'bin', 'solargraph');
      if (fs.existsSync(localBin)) return localBin;
      return 'solargraph'; // fallback to PATH
    }
  },
  php: {
    markers: ['composer.json', 'artisan', 'index.php'],
    extensions: ['.php'],
    serverBin: 'intelephense',
    serverArgs: ['--stdio'],
    installDir: 'php',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execSync('npm init -y && npm install intelephense', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'node_modules', '.bin', 'intelephense')
  },
  swift: {
    markers: ['Package.swift', '*.xcodeproj', '*.xcworkspace'],
    extensions: ['.swift'],
    serverBin: 'sourcekit-lsp',
    serverArgs: [],
    installDir: 'swift',
    // sourcekit-lsp ships with the Swift toolchain / Xcode.
    install: () => { throw new Error('sourcekit-lsp not found on PATH. Install Xcode or Swift toolchain: https://swift.org/download/'); },
    binPath: () => 'sourcekit-lsp'
  },
  kotlin: {
    markers: ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts'],
    extensions: ['.kt', '.kts'],
    serverBin: 'kotlin-language-server',
    serverArgs: [],
    installDir: 'kotlin',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const url = 'https://github.com/fwcd/kotlin-language-server/releases/latest/download/server.zip';
      const zipPath = path.join(dir, 'server.zip');
      execSync(`curl -sL "${url}" -o "${zipPath}" && unzip -qo "${zipPath}" -d "${dir}" && rm "${zipPath}"`, {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'server', 'bin', 'kotlin-language-server')
  },
  scala: {
    markers: ['build.sbt', 'build.sc', '.bsp'],
    extensions: ['.scala', '.sc'],
    serverBin: 'metals',
    serverArgs: [],
    installDir: 'scala',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      // Metals is distributed via coursier
      execSync('curl -fL https://github.com/coursier/coursier/releases/latest/download/cs-x86_64-apple-darwin.gz | gzip -d > cs && chmod +x cs && ./cs install metals --install-dir .', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => {
      const localBin = path.join(dir, 'metals');
      if (fs.existsSync(localBin)) return localBin;
      return 'metals';
    }
  },
  elixir: {
    markers: ['mix.exs'],
    extensions: ['.ex', '.exs'],
    serverBin: 'elixir-ls',
    serverArgs: [],
    installDir: 'elixir',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const url = 'https://github.com/elixir-lsp/elixir-ls/releases/latest/download/elixir-ls.zip';
      const zipPath = path.join(dir, 'elixir-ls.zip');
      execSync(`curl -sL "${url}" -o "${zipPath}" && unzip -qo "${zipPath}" -d "${dir}" && rm "${zipPath}" && chmod +x "${dir}"/language_server.sh`, {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'language_server.sh')
  },
  lua: {
    markers: ['.luarc.json', '.luarc.jsonc', '.luacheckrc'],
    extensions: ['.lua'],
    serverBin: 'lua-language-server',
    serverArgs: [],
    installDir: 'lua',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const platform = process.platform;
      const arch = process.arch;
      let target;
      if (platform === 'darwin' && arch === 'arm64') target = 'darwin-arm64';
      else if (platform === 'darwin') target = 'darwin-x64';
      else if (platform === 'linux' && arch === 'x64') target = 'linux-x64';
      else if (platform === 'win32') target = 'win32-x64';
      else throw new Error(`Unsupported platform for lua-language-server: ${platform}-${arch}`);

      const url = `https://github.com/LuaLS/lua-language-server/releases/latest/download/lua-language-server-3.13.5-${target}.tar.gz`;
      const tarPath = path.join(dir, 'luals.tar.gz');
      execSync(`curl -sL "${url}" -o "${tarPath}" && tar xzf "${tarPath}" -C "${dir}" && rm "${tarPath}"`, {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'bin', 'lua-language-server')
  },
  zig: {
    markers: ['build.zig', 'build.zig.zon'],
    extensions: ['.zig'],
    serverBin: 'zls',
    serverArgs: [],
    installDir: 'zig',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const platform = process.platform;
      const arch = process.arch;
      let target;
      if (platform === 'darwin' && arch === 'arm64') target = 'aarch64-macos';
      else if (platform === 'darwin') target = 'x86_64-macos';
      else if (platform === 'linux' && arch === 'x64') target = 'x86_64-linux';
      else if (platform === 'win32') target = 'x86_64-windows';
      else throw new Error(`Unsupported platform for zls: ${platform}-${arch}`);

      const url = `https://github.com/zigtools/zls/releases/latest/download/zls-${target}.tar.xz`;
      const tarPath = path.join(dir, 'zls.tar.xz');
      execSync(`curl -sL "${url}" -o "${tarPath}" && tar xJf "${tarPath}" -C "${dir}" && rm "${tarPath}"`, {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'zls')
  },
  clojure: {
    markers: ['project.clj', 'deps.edn', 'shadow-cljs.edn'],
    extensions: ['.clj', '.cljs', '.cljc', '.edn'],
    serverBin: 'clojure-lsp',
    serverArgs: [],
    installDir: 'clojure',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const platform = process.platform;
      let target;
      if (platform === 'darwin') target = 'macos-amd64';
      else if (platform === 'linux') target = 'linux-amd64';
      else throw new Error(`Unsupported platform for clojure-lsp: ${platform}`);

      const url = `https://github.com/clojure-lsp/clojure-lsp/releases/latest/download/clojure-lsp-native-${target}.zip`;
      const zipPath = path.join(dir, 'clojure-lsp.zip');
      execSync(`curl -sL "${url}" -o "${zipPath}" && unzip -qo "${zipPath}" -d "${dir}" && rm "${zipPath}" && chmod +x "${dir}"/clojure-lsp`, {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'clojure-lsp')
  },
  haskell: {
    markers: ['stack.yaml', 'cabal.project', '*.cabal', 'hie.yaml'],
    extensions: ['.hs', '.lhs'],
    serverBin: 'haskell-language-server-wrapper',
    serverArgs: ['--lsp'],
    installDir: 'haskell',
    // HLS is best installed via ghcup — too complex to auto-install.
    install: () => { throw new Error('haskell-language-server not found on PATH. Install via ghcup: https://www.haskell.org/ghcup/'); },
    binPath: () => 'haskell-language-server-wrapper'
  },
  svelte: {
    markers: ['svelte.config.js', 'svelte.config.ts'],
    extensions: ['.svelte'],
    serverBin: 'svelteserver',
    serverArgs: ['--stdio'],
    installDir: 'svelte',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execSync('npm init -y && npm install svelte-language-server', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'node_modules', '.bin', 'svelteserver')
  },
  vue: {
    markers: ['nuxt.config.ts', 'nuxt.config.js', 'vite.config.ts'],
    extensions: ['.vue'],
    serverBin: 'vue-language-server',
    serverArgs: ['--stdio'],
    installDir: 'vue',
    install: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execSync('npm init -y && npm install @vue/language-server', {
        cwd: dir, stdio: 'pipe'
      });
    },
    binPath: (dir) => path.join(dir, 'node_modules', '.bin', 'vue-language-server')
  }
};

/**
 * Map file extensions to language keys.
 */
const EXT_TO_LANGUAGE = {};
for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
  for (const ext of config.extensions) {
    EXT_TO_LANGUAGE[ext] = lang;
  }
}

/**
 * LSP Manager - Auto-detects languages, installs LSP servers, manages clients.
 */
class LSPManager {
  constructor() {
    this._clients = new Map();  // language → LSPClient
    this._detectedLanguages = null;
    this._projectRoot = null;
    this._installing = new Map(); // language → Promise (prevents concurrent installs)
  }

  /**
   * Detect languages present in the project root.
   */
  detectLanguages(projectRoot) {
    if (this._detectedLanguages && this._projectRoot === projectRoot) {
      return this._detectedLanguages;
    }

    this._projectRoot = projectRoot;
    const detected = [];

    for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
      for (const marker of config.markers) {
        if (fs.existsSync(path.join(projectRoot, marker))) {
          detected.push(lang);
          break;
        }
      }
    }

    this._detectedLanguages = detected;

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[LSPManager] Detected languages in ${projectRoot}: ${detected.join(', ') || 'none'}`);
    }

    return detected;
  }

  /**
   * Get an LSP client for a given file path.
   * Auto-detects language from extension, lazily starts the server.
   * Returns null if no LSP is available for this file type.
   */
  async getClientForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const language = EXT_TO_LANGUAGE[ext];
    if (!language) return null;

    // Ensure project root is set
    if (!this._projectRoot) {
      this._projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    }

    // Return existing client
    if (this._clients.has(language) && this._clients.get(language).initialized) {
      return this._clients.get(language);
    }

    // Resolve server binary
    const binary = await this._resolveServerBinary(language);
    if (!binary) return null;

    const config = LANGUAGE_CONFIGS[language];
    const client = new LSPClient(language, binary, config.serverArgs);

    try {
      channel.setLspStatus(`LSP: connecting ${language}...`);
      await client.connect(pathToUri(this._projectRoot));
      this._clients.set(language, client);

      // Open a representative file so the server creates an inferred project.
      // Without this, servers like typescript-language-server fail workspace
      // requests with "No Project" when no tsconfig.json/jsconfig.json exists.
      await this._openRepresentativeFile(client, language);

      this._updateStatus();

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[LSPManager] Started LSP for ${language}: ${binary}`);
      }

      return client;
    } catch (err) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[LSPManager] Failed to start ${language} LSP: ${err.message}`);
      }
      this._updateStatus();
      return null;
    }
  }

  /**
   * Resolve the LSP server binary for a language.
   * Checks PATH first, then ~/.koi/lsp-servers/, then auto-installs.
   */
  async _resolveServerBinary(language) {
    const config = LANGUAGE_CONFIGS[language];
    if (!config) return null;

    // 1. Check PATH
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const found = execSync(`${which} ${config.serverBin}`, { stdio: 'pipe' }).toString().trim().split('\n')[0];
      if (found) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[LSPManager] Found ${config.serverBin} on PATH: ${found}`);
        }
        return found;
      }
    } catch (e) {
      // Not on PATH
    }

    // 2. Check local install dir
    const installDir = path.join(LSP_SERVERS_DIR, config.installDir);
    const localBin = config.binPath(installDir);
    if (fs.existsSync(localBin)) {
      return localBin;
    }

    // 3. Auto-install
    return this._installServer(language);
  }

  /**
   * Install an LSP server to ~/.koi/lsp-servers/<language>/.
   * Returns the binary path or null on failure.
   */
  async _installServer(language) {
    // Prevent concurrent installs for the same language
    if (this._installing.has(language)) {
      return this._installing.get(language);
    }

    const config = LANGUAGE_CONFIGS[language];
    const installDir = path.join(LSP_SERVERS_DIR, config.installDir);

    const promise = (async () => {
      try {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[LSPManager] Installing ${config.serverBin} to ${installDir}...`);
        }

        channel.setLspStatus(`LSP: installing ${config.serverBin}...`);
        config.install(installDir);
        const binPath = config.binPath(installDir);

        if (fs.existsSync(binPath)) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[LSPManager] Installed ${config.serverBin} successfully`);
          }
          return binPath;
        }

        console.error(`[LSPManager] Install completed but binary not found at ${binPath}`);
        return null;
      } catch (err) {
        console.error(`[LSPManager] Failed to install ${config.serverBin}: ${err.message}`);
        return null;
      } finally {
        this._installing.delete(language);
      }
    })();

    this._installing.set(language, promise);
    return promise;
  }

  /**
   * Open a real source file so the LSP server creates an inferred project.
   * Needed for servers like typescript-language-server when no tsconfig.json exists.
   */
  async _openRepresentativeFile(client, language) {
    const config = LANGUAGE_CONFIGS[language];
    if (!config) return;

    const extensions = config.extensions;

    // Try common entry points first
    const candidates = ['src/index', 'src/main', 'index', 'main', 'src/app'];
    for (const base of candidates) {
      for (const ext of extensions) {
        const filePath = path.join(this._projectRoot, base + ext);
        if (fs.existsSync(filePath)) {
          try { await client.ensureDocumentOpen(filePath); return; } catch { /* ignore */ }
        }
      }
    }

    // Fallback: first matching file in src/ or root
    try {
      const srcDir = path.join(this._projectRoot, 'src');
      const dir = fs.existsSync(srcDir) ? srcDir : this._projectRoot;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (extensions.some(ext => f.endsWith(ext))) {
          try { await client.ensureDocumentOpen(path.join(dir, f)); return; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Build and emit the combined LSP status indicator from active clients.
   */
  _updateStatus() {
    const active = [...this._clients.keys()].filter(lang => this._clients.get(lang).initialized);
    if (active.length > 0) {
      channel.setLspStatus('LSP: ' + active.join(' \u00b7 '));
    } else {
      channel.setLspStatus('');
    }
  }

  /**
   * Disconnect all active LSP clients.
   */
  async disconnectAll() {
    const promises = [];
    for (const [language, client] of this._clients) {
      if (client.initialized) {
        promises.push(client.disconnect().catch(err => {
          console.error(`[LSPManager] Failed to disconnect ${language}: ${err.message}`);
        }));
      }
    }
    await Promise.all(promises);
    this._clients.clear();
    channel.setLspStatus('');
  }
}

// Singleton
export const lspManager = new LSPManager();
globalThis.lspManager = lspManager;
