import { spawn } from 'child_process';

/**
 * MCP Stdio Client - Manages a single MCP server subprocess
 * and communicates via JSON-RPC 2.0 over stdin/stdout.
 */
export class MCPStdioClient {
  constructor(name, config) {
    this.name = name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.process = null;
    this.tools = [];
    this.initialized = false;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._buffer = '';
    this._stderrLines = [];
    this.lastError = null; // Human-readable error cause when process crashes
  }

  /**
   * Spawn subprocess, perform MCP initialize handshake, and cache tools/list.
   */
  async connect() {
    if (this.initialized) return;

    // Clean up old state from previous crash before reconnecting
    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch (e) { /* already dead */ }
      this.process = null;
    }
    this._buffer = '';
    this._stderrLines = [];
    this._pendingRequests.clear();
    this.lastError = null;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`[MCP:${this.name}] Connection timeout after 30s`));
      }, 30000);

      try {
        // Build env: config values override process.env, but skip empty/null values
        // so that env: { "API_KEY": "" } in .koi doesn't override a real env var
        const configEnv = {};
        for (const [key, value] of Object.entries(this.env)) {
          if (value !== '' && value !== null && value !== undefined) {
            configEnv[key] = value;
          }
        }

        this.process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...configEnv }
        });

        this.process.stdout.on('data', (data) => {
          this._buffer += data.toString();
          this._processBuffer();
        });

        this.process.stderr.on('data', (data) => {
          const lines = data.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            this._stderrLines.push(line);
            // Keep only last 20 lines to avoid unbounded growth
            if (this._stderrLines.length > 20) {
              this._stderrLines.shift();
            }
            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[MCP:${this.name}] ${line}`);
            }
          }
        });

        this.process.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`[MCP:${this.name}] Failed to spawn: ${err.message}`));
        });

        this.process.on('close', (code) => {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[MCP:${this.name}] Process exited with code ${code}`);
          }
          this.initialized = false;
          this.process = null;

          // Capture full stderr buffer for the LLM to interpret (already capped at 20 lines)
          const stderrOutput = this._stderrLines.join('\n');
          this.lastError = stderrOutput || null;

          const errorMsg = stderrOutput
            ? `MCP server "${this.name}" crashed (exit code ${code}). Server output:\n${stderrOutput}`
            : `MCP server "${this.name}" crashed (exit code ${code}). No output captured.`;

          // Reject all pending requests (process died)
          for (const [id, pending] of this._pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(errorMsg));
          }
          this._pendingRequests.clear();

          // If we were still connecting, reject the connect promise
          if (!this.initialized) {
            clearTimeout(timeout);
            reject(new Error(errorMsg));
          }
        });

        // Perform initialize handshake
        this._initialize().then(async () => {
          // Send initialized notification
          this._sendNotification('notifications/initialized', {});

          // Cache tools
          try {
            const toolsResult = await this._sendRequest('tools/list', {});
            this.tools = toolsResult.tools || [];
            this.initialized = true;

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[MCP:${this.name}] Connected. ${this.tools.length} tools available: ${this.tools.map(t => t.name).join(', ')}`);
            }

            clearTimeout(timeout);
            resolve();
          } catch (err) {
            clearTimeout(timeout);
            reject(new Error(`[MCP:${this.name}] tools/list failed: ${err.message}`));
          }
        }).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`[MCP:${this.name}] Spawn error: ${err.message}`));
      }
    });
  }

  /**
   * Send shutdown request and kill subprocess.
   */
  async disconnect() {
    if (!this.process) return;

    try {
      // Try graceful shutdown
      this._sendNotification('notifications/cancelled', {});
    } catch (e) {
      // Ignore errors during shutdown
    }

    // Kill the process
    try {
      this.process.kill('SIGTERM');
    } catch (e) {
      // Already dead
    }

    this.initialized = false;
    this.process = null;
    this.tools = [];
    this._pendingRequests.clear();
    this._buffer = '';
    this._stderrLines = [];
  }

  /**
   * Return cached tools list.
   */
  async listTools() {
    if (!this.initialized) {
      await this.connect();
    }
    return this.tools;
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} toolName - Name of the tool
   * @param {object} args - Tool input parameters
   * @returns {object} Tool result
   */
  async callTool(toolName, args = {}) {
    if (!this.initialized) {
      await this.connect();
    }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args
    });

    // Extract text content from MCP response format
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);

      if (textParts.length === 1) {
        // Try to parse as JSON
        try {
          return JSON.parse(textParts[0]);
        } catch (e) {
          return { result: textParts[0] };
        }
      } else if (textParts.length > 1) {
        return { result: textParts.join('\n') };
      }
    }

    return result;
  }

  // ---- Private Protocol Methods ----

  async _initialize() {
    const result = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'koi-mcp-client',
        version: '1.0.0'
      }
    });

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[MCP:${this.name}] Server: ${result.serverInfo?.name || 'unknown'} v${result.serverInfo?.version || '?'}`);
    }

    return result;
  }

  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      // tools/call can take minutes (e.g. mobile automation); handshake methods are fast
      const timeoutMs = method === 'tools/call' ? 5 * 60 * 1000 : 30000;
      const timeoutLabel = method === 'tools/call' ? '5m' : '30s';
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`[MCP:${this.name}] Request ${method} (id=${id}) timed out after ${timeoutLabel}`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timeout });

      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      });

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCP:${this.name}] → ${method} (id=${id})`);
      }

      try {
        this.process.stdin.write(message + '\n');
      } catch (err) {
        clearTimeout(timeout);
        this._pendingRequests.delete(id);
        reject(new Error(`[MCP:${this.name}] Write failed: ${err.message}`));
      }
    });
  }

  _sendNotification(method, params) {
    if (!this.process || !this.process.stdin.writable) return;

    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    });

    try {
      this.process.stdin.write(message + '\n');
    } catch (e) {
      // Ignore write errors for notifications
    }
  }

  _processBuffer() {
    // Process newline-delimited JSON-RPC messages
    let newlineIndex;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.substring(0, newlineIndex).trim();
      this._buffer = this._buffer.substring(newlineIndex + 1);

      if (line) {
        this._handleLine(line);
      }
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCP:${this.name}] Failed to parse: ${line.substring(0, 200)}`);
      }
      return;
    }

    // Response to a request
    if (message.id !== undefined && this._pendingRequests.has(message.id)) {
      const pending = this._pendingRequests.get(message.id);
      this._pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(`[MCP:${this.name}] ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        if (process.env.KOI_DEBUG_LLM) {
          const preview = JSON.stringify(message.result).substring(0, 200);
          console.error(`[MCP:${this.name}] ← (id=${message.id}) ${preview}`);
        }
        pending.resolve(message.result);
      }
    } else if (message.method) {
      // Server notification or request (we don't handle server-initiated requests)
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[MCP:${this.name}] Notification: ${message.method}`);
      }
    }
  }
}
