import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { LSPClient, pathToUri } from './lsp-client.js';
import { cliLogger } from './cli-logger.js';

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
      cliLogger.setLspStatus(`LSP: connecting ${language}...`);
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

        cliLogger.setLspStatus(`LSP: installing ${config.serverBin}...`);
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
      cliLogger.setLspStatus('LSP: ' + active.join(' \u00b7 '));
    } else {
      cliLogger.setLspStatus('');
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
    cliLogger.setLspStatus('');
  }
}

// Singleton
export const lspManager = new LSPManager();
globalThis.lspManager = lspManager;
