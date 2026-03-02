import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Convert a file path to a file:// URI.
 */
export function pathToUri(filePath) {
  const absolute = path.resolve(filePath);
  // Windows: C:\foo → file:///C:/foo
  if (process.platform === 'win32') {
    return 'file:///' + absolute.replace(/\\/g, '/');
  }
  return 'file://' + absolute;
}

/**
 * Convert a file:// URI back to a local path.
 */
function uriToPath(uri) {
  if (!uri.startsWith('file://')) return uri;
  let filePath = decodeURIComponent(uri.slice('file://'.length));
  // Windows: file:///C:/foo → C:\foo
  if (process.platform === 'win32' && filePath.startsWith('/')) {
    filePath = filePath.slice(1).replace(/\//g, '\\');
  }
  return filePath;
}

/**
 * LSP Client - Manages a single Language Server Protocol subprocess
 * communicating via JSON-RPC 2.0 over stdio with Content-Length framing.
 */
export class LSPClient {
  constructor(language, command, args = [], env = {}) {
    this.language = language;
    this.command = command;
    this.args = args;
    this.env = env;
    this.process = null;
    this.initialized = false;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._buffer = Buffer.alloc(0);
    this._stderrLines = [];
    this._openDocuments = new Map(); // uri → version
    this._diagnostics = new Map();   // uri → diagnostics[]
    this._serverCapabilities = null;
  }

  /**
   * Spawn LSP server, perform initialize handshake.
   */
  async connect(rootUri) {
    if (this.initialized) return;

    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch (e) { /* already dead */ }
      this.process = null;
    }
    this._buffer = Buffer.alloc(0);
    this._stderrLines = [];
    this._pendingRequests.clear();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`[LSP:${this.language}] Connection timeout after 30s`));
      }, 30000);

      try {
        this.process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.env }
        });

        this.process.stdout.on('data', (data) => {
          this._buffer = Buffer.concat([this._buffer, data]);
          this._processBuffer();
        });

        this.process.stderr.on('data', (data) => {
          const lines = data.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            this._stderrLines.push(line);
            if (this._stderrLines.length > 20) this._stderrLines.shift();
            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[LSP:${this.language}] ${line}`);
            }
          }
        });

        this.process.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`[LSP:${this.language}] Failed to spawn: ${err.message}`));
        });

        this.process.on('close', (code) => {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[LSP:${this.language}] Process exited with code ${code}`);
          }
          this.initialized = false;
          this.process = null;

          const stderrOutput = this._stderrLines.join('\n');
          const errorMsg = stderrOutput
            ? `LSP server "${this.language}" exited (code ${code}). Output:\n${stderrOutput}`
            : `LSP server "${this.language}" exited (code ${code}).`;

          for (const [id, pending] of this._pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(errorMsg));
          }
          this._pendingRequests.clear();

          if (!this.initialized) {
            clearTimeout(timeout);
            reject(new Error(errorMsg));
          }
        });

        // LSP initialize handshake
        this._sendRequest('initialize', {
          processId: process.pid,
          rootUri: rootUri,
          capabilities: {
            textDocument: {
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              hover: {
                dynamicRegistration: false,
                contentFormat: ['plaintext', 'markdown']
              },
              publishDiagnostics: { relatedInformation: false },
              synchronization: {
                didOpen: true,
                didClose: true
              }
            },
            workspace: {
              symbol: { dynamicRegistration: false }
            }
          },
          clientInfo: { name: 'koi-lsp-client', version: '1.0.0' }
        }).then((result) => {
          this._serverCapabilities = result.capabilities || {};

          // Send initialized notification
          this._sendNotification('initialized', {});
          this.initialized = true;

          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[LSP:${this.language}] Connected. Server: ${result.serverInfo?.name || 'unknown'}`);
          }

          clearTimeout(timeout);
          resolve();
        }).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`[LSP:${this.language}] Spawn error: ${err.message}`));
      }
    });
  }

  /**
   * Graceful LSP shutdown: shutdown request → exit notification → SIGTERM fallback.
   */
  async disconnect() {
    if (!this.process) return;

    try {
      await this._sendRequest('shutdown', null);
      this._sendNotification('exit', null);
    } catch (e) {
      // Server may already be dead
    }

    // Give it a moment then force kill
    await new Promise(resolve => setTimeout(resolve, 500));

    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch (e) { /* already dead */ }
    }

    this.initialized = false;
    this.process = null;
    this._openDocuments.clear();
    this._diagnostics.clear();
    this._pendingRequests.clear();
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Send an LSP request and return the result.
   */
  sendRequest(method, params) {
    return this._sendRequest(method, params);
  }

  /**
   * Ensure a document is open in the LSP server.
   * Reads the file, sends textDocument/didOpen if not already tracked.
   * Returns the document URI.
   */
  async ensureDocumentOpen(filePath) {
    const absolute = path.resolve(filePath);
    const uri = pathToUri(absolute);

    if (this._openDocuments.has(uri)) {
      return uri;
    }

    let text;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read file for LSP: ${err.message}`);
    }

    const languageId = this._inferLanguageId(absolute);
    this._sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text
      }
    });

    this._openDocuments.set(uri, 1);
    return uri;
  }

  /**
   * Close a document in the LSP server.
   */
  closeDocument(filePath) {
    const uri = pathToUri(path.resolve(filePath));
    if (!this._openDocuments.has(uri)) return;

    this._sendNotification('textDocument/didClose', {
      textDocument: { uri }
    });
    this._openDocuments.delete(uri);
  }

  /**
   * Get cached diagnostics for a URI (or all URIs if none specified).
   */
  getDiagnostics(uri) {
    if (uri) {
      return this._diagnostics.get(uri) || [];
    }
    // Return all
    const all = {};
    for (const [u, diags] of this._diagnostics) {
      if (diags.length > 0) {
        all[uriToPath(u)] = diags;
      }
    }
    return all;
  }

  // ---- Private Protocol Methods ----

  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin.writable) {
        return reject(new Error(`[LSP:${this.language}] Not connected`));
      }

      const id = ++this._requestId;
      const timeoutMs = 30000;
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`[LSP:${this.language}] Request ${method} (id=${id}) timed out after 30s`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timeout });

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      });

      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[LSP:${this.language}] -> ${method} (id=${id})`);
      }

      try {
        this.process.stdin.write(header + body);
      } catch (err) {
        clearTimeout(timeout);
        this._pendingRequests.delete(id);
        reject(new Error(`[LSP:${this.language}] Write failed: ${err.message}`));
      }
    });
  }

  _sendNotification(method, params) {
    if (!this.process || !this.process.stdin.writable) return;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    });

    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;

    try {
      this.process.stdin.write(header + body);
    } catch (e) {
      // Ignore write errors for notifications
    }
  }

  _processBuffer() {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerStr = this._buffer.slice(0, headerEnd).toString('utf8');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip past it
        this._buffer = this._buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      if (this._buffer.length < bodyStart + contentLength) {
        // Incomplete body — wait for more data
        break;
      }

      const bodyBuf = this._buffer.slice(bodyStart, bodyStart + contentLength);
      this._buffer = this._buffer.slice(bodyStart + contentLength);

      this._handleMessage(bodyBuf.toString('utf8'));
    }
  }

  _handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (e) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[LSP:${this.language}] Failed to parse: ${raw.substring(0, 200)}`);
      }
      return;
    }

    // Response to a request
    if (message.id !== undefined && this._pendingRequests.has(message.id)) {
      const pending = this._pendingRequests.get(message.id);
      this._pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(`[LSP:${this.language}] ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        if (process.env.KOI_DEBUG_LLM) {
          const preview = JSON.stringify(message.result).substring(0, 200);
          console.error(`[LSP:${this.language}] <- (id=${message.id}) ${preview}`);
        }
        pending.resolve(message.result);
      }
      return;
    }

    // Server notification
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params || {};
      if (uri) {
        this._diagnostics.set(uri, diagnostics || []);
      }
    } else if (process.env.KOI_DEBUG_LLM && message.method) {
      console.error(`[LSP:${this.language}] Notification: ${message.method}`);
    }
  }

  _inferLanguageId(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.c': 'c', '.h': 'c',
      '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
      '.cs': 'csharp',
      '.rb': 'ruby',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.lua': 'lua',
      '.zig': 'zig',
    };
    return map[ext] || 'plaintext';
  }
}
