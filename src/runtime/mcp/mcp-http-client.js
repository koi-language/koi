/**
 * MCP HTTP Client — MCP Streamable HTTP transport.
 * Sends JSON-RPC 2.0 requests via HTTP POST to a single URL endpoint.
 * Same interface as MCPStdioClient: connect(), callTool(), disconnect(),
 * .tools, .initialized, ._stderrLines.
 */

export class MCPHttpClient {
  constructor(name, config) {
    this.name = name;
    this.url = config.url;
    this.headers = config.headers || {};
    this.tools = [];
    this.initialized = false;
    this._stderrLines = [];
    this._requestId = 0;
    this.serverInfo = null;
    this.capabilities = null;
  }

  /**
   * Perform MCP initialize handshake + cache tools/list.
   */
  async connect() {
    if (this.initialized) return;

    this.tools = [];
    this._stderrLines = [];
    this.serverInfo = null;
    this.capabilities = null;

    const timeout = 30_000;

    // initialize handshake
    const initResult = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'koi-mcp-client', version: '1.0.0' }
    }, timeout);

    this.serverInfo = initResult.serverInfo || null;
    this.capabilities = initResult.capabilities || null;

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[MCP:${this.name}] Server: ${initResult.serverInfo?.name || 'unknown'} v${initResult.serverInfo?.version || '?'}`);
    }

    // Send initialized notification (fire-and-forget)
    this._sendNotification('notifications/initialized', {}).catch(() => {});

    // Cache tools list
    const toolsResult = await this._sendRequest('tools/list', {}, timeout);
    this.tools = toolsResult.tools || [];
    this.initialized = true;

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[MCP:${this.name}] Connected. ${this.tools.length} tools: ${this.tools.map(t => t.name).join(', ')}`);
    }
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} toolName
   * @param {object} args
   * @returns {object} Tool result
   */
  async callTool(toolName, args = {}) {
    if (!this.initialized) {
      await this.connect();
    }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args
    }, 5 * 60_000);

    // Extract text content from MCP response format
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);

      if (textParts.length === 1) {
        try {
          return JSON.parse(textParts[0]);
        } catch {
          return { result: textParts[0] };
        }
      } else if (textParts.length > 1) {
        return { result: textParts.join('\n') };
      }
    }

    return result;
  }

  /**
   * No-op for HTTP transport (no persistent connection to close).
   */
  async disconnect() {
    this.initialized = false;
    this.tools = [];
    this._stderrLines = [];
  }

  // ---- Private ----

  async _sendRequest(method, params, timeoutMs = 30_000) {
    const id = ++this._requestId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[MCP:${this.name}] → ${method} (id=${id})`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // MCP Streamable HTTP requires accepting both JSON and SSE (RFC: MCP spec)
          'Accept': 'application/json, text/event-stream',
          ...this.headers
        },
        body,
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`[MCP:${this.name}] Request ${method} timed out`);
      }
      throw new Error(`[MCP:${this.name}] HTTP error: ${err.message}`);
    }
    clearTimeout(timer);

    if (response.status === 401) {
      throw new Error(
        `[MCP:${this.name}] Authentication required. ` +
        `Run /mcp inside koi-cli to authenticate this server.`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`[MCP:${this.name}] HTTP ${response.status}: ${text.substring(0, 200)}`);
    }

    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      // Parse Server-Sent Events: extract first data: line with matching JSON-RPC id
      const text = await response.text();
      data = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          if (parsed.id === id || parsed.id === null) { data = parsed; break; }
        } catch { /* skip non-JSON data lines */ }
      }
      if (!data) throw new Error(`[MCP:${this.name}] No matching SSE message for id=${id}`);
    } else {
      try {
        data = await response.json();
      } catch (err) {
        throw new Error(`[MCP:${this.name}] Invalid JSON response: ${err.message}`);
      }
    }

    if (data.error) {
      throw new Error(`[MCP:${this.name}] ${data.error.message || JSON.stringify(data.error)}`);
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[MCP:${this.name}] ← (id=${id}) ${JSON.stringify(data.result).substring(0, 200)}`);
    }

    return data.result;
  }

  async _sendNotification(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...this.headers
        },
        body
      });
    } catch {
      // Notifications are fire-and-forget; ignore errors
    }
  }
}
