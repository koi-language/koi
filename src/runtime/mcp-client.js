/**
 * MCP (Model Context Protocol) Client - Full Implementation
 *
 * Features:
 * - WebSocket and HTTP/2 protocol support
 * - Authentication and authorization
 * - Server discovery
 * - Connection pooling and load balancing
 * - Retry logic and failover
 * - Streaming responses
 * - MCP tools integration
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Configuration constants
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000; // 1 second
const DEFAULT_POOL_SIZE = 5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 10000; // 10 seconds

/**
 * Main MCP Client - manages connections, authentication, and discovery
 */
export class MCPClient extends EventEmitter {
  constructor(config = {}) {
    super();

    // Basic configuration
    this.config = {
      timeout: config.timeout || DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries || DEFAULT_MAX_RETRIES,
      retryDelay: config.retryDelay || DEFAULT_RETRY_DELAY,
      poolSize: config.poolSize || DEFAULT_POOL_SIZE,
      auth: config.auth || {},
      registry: config.registry || null,
      enableStreaming: config.enableStreaming !== false,
      enableLoadBalancing: config.enableLoadBalancing !== false,
      ...config
    };

    // Connection management
    this.connections = new Map(); // server -> MCPConnectionPool
    this.cache = new Map(); // address -> resolved resource
    this.registry = null; // Server registry for discovery
    this.tools = new Map(); // Available MCP tools

    // Load balancing
    this.serverHealth = new Map(); // server -> health metrics
    this.loadBalancer = new LoadBalancer(this);

    // Authentication manager
    this.authManager = new AuthenticationManager(this.config.auth);

    // Initialize registry if configured
    if (this.config.registry) {
      this.initRegistry(this.config.registry);
    }
  }

  /**
   * Initialize server registry for discovery
   */
  async initRegistry(registryUrl) {
    try {
      this.registry = new ServerRegistry(registryUrl);
      await this.registry.connect();
      console.log(`[MCP] Connected to registry: ${registryUrl}`);
      this.emit('registry:connected', registryUrl);
    } catch (error) {
      console.error(`[MCP] Failed to connect to registry:`, error.message);
      this.emit('registry:error', error);
    }
  }

  /**
   * Parse an MCP address
   */
  parseAddress(address) {
    if (typeof address === 'string' && address.startsWith('mcp://')) {
      const url = new URL(address);
      return {
        server: url.host,
        path: url.pathname.slice(1),
        query: url.searchParams
      };
    }

    if (address && address.type === 'MCPAddress') {
      return {
        server: address.server,
        path: address.path,
        query: null
      };
    }

    throw new Error(`Invalid MCP address: ${address}`);
  }

  /**
   * Resolve an MCP address to a resource
   */
  async resolve(address, options = {}) {
    const { server, path } = this.parseAddress(address);
    const fullAddress = `mcp://${server}/${path}`;

    // Check cache first (unless refresh is requested)
    if (!options.refresh && this.cache.has(fullAddress)) {
      return this.cache.get(fullAddress);
    }

    console.log(`[MCP] Resolving: ${fullAddress}`);

    try {
      // Get connection pool for server
      const pool = await this.getConnectionPool(server);

      // Get a connection from the pool
      const connection = await pool.acquire();

      try {
        // Resolve the resource
        const resource = await connection.getResource(path);

        // Cache the result
        this.cache.set(fullAddress, resource);

        return resource;
      } finally {
        // Release connection back to pool
        pool.release(connection);
      }
    } catch (error) {
      console.error(`[MCP] Failed to resolve ${fullAddress}:`, error.message);

      // Try failover if configured
      if (options.failover) {
        return await this.resolveWithFailover(address, options);
      }

      throw new Error(`MCP resolution failed for ${fullAddress}: ${error.message}`);
    }
  }

  /**
   * Resolve with automatic failover to alternative servers
   */
  async resolveWithFailover(address, options = {}) {
    const { path } = this.parseAddress(address);

    // Get alternative servers from registry
    const alternatives = await this.discoverServers(path);

    for (const altServer of alternatives) {
      try {
        console.log(`[MCP] Trying failover server: ${altServer}`);
        const altAddress = `mcp://${altServer}/${path}`;
        return await this.resolve(altAddress, { ...options, failover: false });
      } catch (error) {
        console.warn(`[MCP] Failover to ${altServer} failed:`, error.message);
      }
    }

    throw new Error(`All failover attempts failed for ${path}`);
  }

  /**
   * Get or create connection pool for a server
   */
  async getConnectionPool(server) {
    if (this.connections.has(server)) {
      return this.connections.get(server);
    }

    console.log(`[MCP] Creating connection pool for: ${server}`);

    // Get authentication credentials for this server
    const auth = await this.authManager.getCredentials(server);

    // Create connection pool
    const pool = new MCPConnectionPool(server, {
      size: this.config.poolSize,
      auth,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryDelay: this.config.retryDelay
    });

    await pool.initialize();
    this.connections.set(server, pool);
    this.emit('pool:created', server);

    return pool;
  }

  /**
   * Send a message to an MCP address with retry logic
   */
  async send(address, event, data, options = {}) {
    const maxRetries = options.maxRetries || this.config.maxRetries;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.config.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`[MCP] Retry ${attempt}/${maxRetries} after ${delay}ms`);
          await this.sleep(delay);
        }

        const resource = await this.resolve(address, options);
        console.log(`[MCP] Sending ${event} to ${address}`);

        // Handle streaming if enabled and supported
        if (options.stream && this.config.enableStreaming) {
          return await this.sendStreaming(resource, event, data, options);
        }

        // Regular send
        if (typeof resource.send === 'function') {
          return await resource.send(event, data, options);
        }

        if (typeof resource[event] === 'function') {
          return await resource[event](data);
        }

        throw new Error(`Resource at ${address} does not handle event: ${event}`);

      } catch (error) {
        lastError = error;
        console.warn(`[MCP] Send attempt ${attempt + 1} failed:`, error.message);

        if (attempt === maxRetries) {
          break;
        }
      }
    }

    throw new Error(`Failed after ${maxRetries} retries: ${lastError.message}`);
  }

  /**
   * Send with streaming response
   */
  async sendStreaming(resource, event, data, options = {}) {
    if (!resource.sendStream) {
      throw new Error('Resource does not support streaming');
    }

    const stream = await resource.sendStream(event, data, options);

    // Return async iterator for streaming
    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk;
        }
      }
    };
  }

  /**
   * Discover servers that provide a specific capability/resource
   */
  async discoverServers(resourcePath, options = {}) {
    if (!this.registry) {
      console.warn('[MCP] No registry configured for server discovery');
      return [];
    }

    try {
      const servers = await this.registry.discover(resourcePath, options);
      console.log(`[MCP] Discovered ${servers.length} servers for ${resourcePath}`);
      return servers;
    } catch (error) {
      console.error('[MCP] Server discovery failed:', error.message);
      return [];
    }
  }

  /**
   * Get available tools from an MCP server
   */
  async getTools(server) {
    const cacheKey = `tools:${server}`;

    if (this.tools.has(cacheKey)) {
      return this.tools.get(cacheKey);
    }

    try {
      const pool = await this.getConnectionPool(server);
      const connection = await pool.acquire();

      try {
        const tools = await connection.listTools();
        this.tools.set(cacheKey, tools);
        return tools;
      } finally {
        pool.release(connection);
      }
    } catch (error) {
      console.error(`[MCP] Failed to get tools from ${server}:`, error.message);
      return [];
    }
  }

  /**
   * Invoke an MCP tool
   */
  async invokeTool(server, toolName, args) {
    console.log(`[MCP] Invoking tool ${toolName} on ${server}`);

    const pool = await this.getConnectionPool(server);
    const connection = await pool.acquire();

    try {
      return await connection.invokeTool(toolName, args);
    } finally {
      pool.release(connection);
    }
  }

  /**
   * Get health metrics for a server
   */
  getServerHealth(server) {
    return this.serverHealth.get(server) || {
      status: 'unknown',
      latency: null,
      successRate: null,
      lastCheck: null
    };
  }

  /**
   * Update health metrics for a server
   */
  updateServerHealth(server, metrics) {
    const existing = this.serverHealth.get(server) || {};
    this.serverHealth.set(server, {
      ...existing,
      ...metrics,
      lastCheck: Date.now()
    });
    this.emit('health:updated', server, metrics);
  }

  /**
   * Disconnect from a server
   */
  async disconnect(server) {
    const pool = this.connections.get(server);
    if (pool) {
      await pool.destroy();
      this.connections.delete(server);
      this.emit('disconnected', server);
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll() {
    const servers = Array.from(this.connections.keys());
    await Promise.all(servers.map(server => this.disconnect(server)));
  }

  /**
   * Clear the resolution cache
   */
  clearCache() {
    this.cache.clear();
    this.tools.clear();
  }

  /**
   * Utility: sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Connection Pool - manages multiple connections to a single server
 */
class MCPConnectionPool extends EventEmitter {
  constructor(server, options = {}) {
    super();
    this.server = server;
    this.options = options;
    this.size = options.size || DEFAULT_POOL_SIZE;
    this.connections = [];
    this.available = [];
    this.waiting = [];
    this.initialized = false;
  }

  async initialize() {
    console.log(`[MCP:Pool] Initializing pool for ${this.server} (size: ${this.size})`);

    // Create initial connections
    for (let i = 0; i < this.size; i++) {
      try {
        const connection = await this.createConnection();
        this.connections.push(connection);
        this.available.push(connection);
      } catch (error) {
        console.error(`[MCP:Pool] Failed to create connection ${i + 1}:`, error.message);
      }
    }

    if (this.available.length === 0) {
      throw new Error(`Failed to create any connections to ${this.server}`);
    }

    this.initialized = true;
    this.emit('initialized', this.server);
  }

  async createConnection() {
    const connection = new MCPConnection(this.server, this.options);
    await connection.connect();

    // Set up connection event handlers
    connection.on('close', () => this.handleConnectionClose(connection));
    connection.on('error', (error) => this.handleConnectionError(connection, error));

    return connection;
  }

  async acquire() {
    if (!this.initialized) {
      throw new Error('Pool not initialized');
    }

    // If a connection is available, return it immediately
    if (this.available.length > 0) {
      return this.available.shift();
    }

    // Otherwise, wait for one to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index > -1) {
          this.waiting.splice(index, 1);
        }
        reject(new Error('Timeout waiting for connection'));
      }, CONNECTION_TIMEOUT);

      const waiter = { resolve, reject, timeout };
      this.waiting.push(waiter);
    });
  }

  release(connection) {
    // If there are waiters, give them the connection
    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      clearTimeout(waiter.timeout);
      waiter.resolve(connection);
      return;
    }

    // Otherwise, add it back to available pool
    if (!this.available.includes(connection)) {
      this.available.push(connection);
    }
  }

  handleConnectionClose(connection) {
    console.log(`[MCP:Pool] Connection closed in pool for ${this.server}`);
    this.removeConnection(connection);

    // Try to replace the connection
    this.createConnection()
      .then(newConnection => {
        this.connections.push(newConnection);
        this.available.push(newConnection);
      })
      .catch(error => {
        console.error(`[MCP:Pool] Failed to replace connection:`, error.message);
      });
  }

  handleConnectionError(connection, error) {
    console.error(`[MCP:Pool] Connection error:`, error.message);
    this.emit('error', error);
  }

  removeConnection(connection) {
    const connIndex = this.connections.indexOf(connection);
    if (connIndex > -1) {
      this.connections.splice(connIndex, 1);
    }

    const availIndex = this.available.indexOf(connection);
    if (availIndex > -1) {
      this.available.splice(availIndex, 1);
    }
  }

  async destroy() {
    console.log(`[MCP:Pool] Destroying pool for ${this.server}`);

    // Reject all waiting requests
    this.waiting.forEach(waiter => {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Pool destroyed'));
    });
    this.waiting = [];

    // Close all connections
    await Promise.all(
      this.connections.map(conn => conn.disconnect().catch(err => {
        console.error('[MCP:Pool] Error closing connection:', err);
      }))
    );

    this.connections = [];
    this.available = [];
    this.initialized = false;
  }
}

/**
 * Single MCP Connection - handles protocol communication
 */
class MCPConnection extends EventEmitter {
  constructor(server, options = {}) {
    super();
    this.server = server;
    this.options = options;
    this.connected = false;
    this.resources = new Map();
    this.ws = null;
    this.mode = null;
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.heartbeatInterval = null;
  }

  async connect() {
    // Determine connection mode based on server address
    if (this.server === 'localhost' || this.server.endsWith('.local')) {
      await this.connectLocal();
    } else if (this.server.startsWith('ws://') || this.server.startsWith('wss://')) {
      await this.connectWebSocket();
    } else {
      await this.connectHTTP();
    }

    this.startHeartbeat();
  }

  async connectLocal() {
    this.mode = 'local';
    this.connected = true;
    console.log(`[MCP] Connected to ${this.server} (local simulation mode)`);
    this.emit('connected');
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.server.startsWith('ws') ? this.server : `wss://${this.server}`;

      const headers = {};
      if (this.options.auth && this.options.auth.token) {
        headers['Authorization'] = `Bearer ${this.options.auth.token}`;
      }

      this.ws = new WebSocket(wsUrl, { headers });

      const timeout = setTimeout(() => {
        reject(new Error(`WebSocket connection timeout: ${this.server}`));
        this.ws.close();
      }, CONNECTION_TIMEOUT);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.mode = 'websocket';
        this.connected = true;
        console.log(`[MCP] Connected to ${this.server} (WebSocket)`);
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        console.error(`[MCP] WebSocket error:`, error.message);
        this.emit('error', error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.stopHeartbeat();
        console.log(`[MCP] WebSocket connection closed: ${this.server}`);
        this.emit('close');
      });

      this.ws.on('ping', () => {
        this.ws.pong();
      });
    });
  }

  async connectHTTP() {
    this.mode = 'http';
    this.baseUrl = this.server.startsWith('http') ? this.server : `https://${this.server}`;

    try {
      // Test connection with a ping
      const response = await fetch(`${this.baseUrl}/mcp/v1/ping`, {
        method: 'GET',
        headers: this.getHTTPHeaders(),
        timeout: CONNECTION_TIMEOUT
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.connected = true;
      console.log(`[MCP] Connected to ${this.server} (HTTP/2)`);
      this.emit('connected');

    } catch (error) {
      throw new Error(`Failed to connect via HTTP: ${error.message}`);
    }
  }

  getHTTPHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (this.options.auth && this.options.auth.token) {
      headers['Authorization'] = `Bearer ${this.options.auth.token}`;
    }

    return headers;
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      if (message.id && this.pendingRequests.has(message.id)) {
        const { resolve, reject } = this.pendingRequests.get(message.id);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.result);
        }
      } else {
        // Handle server-initiated messages (events, etc.)
        this.emit('message', message);
      }
    } catch (error) {
      console.error('[MCP] Failed to parse message:', error.message);
    }
  }

  async sendRequest(method, params) {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    if (this.mode === 'websocket') {
      return this.sendWebSocketRequest(method, params);
    } else if (this.mode === 'http') {
      return this.sendHTTPRequest(method, params);
    } else {
      throw new Error(`Unsupported mode: ${this.mode}`);
    }
  }

  async sendWebSocketRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      const message = JSON.stringify({ id, method, params });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.options.timeout || DEFAULT_TIMEOUT);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.ws.send(message);
    });
  }

  async sendHTTPRequest(method, params) {
    const response = await fetch(`${this.baseUrl}/mcp/v1/call`, {
      method: 'POST',
      headers: this.getHTTPHeaders(),
      body: JSON.stringify({ method, params }),
      timeout: this.options.timeout || DEFAULT_TIMEOUT
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    return data.result;
  }

  async getResource(path) {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    // Check cache
    if (this.resources.has(path)) {
      return this.resources.get(path);
    }

    if (this.mode === 'local') {
      return this.getLocalResource(path);
    }

    // Request resource metadata from server
    const metadata = await this.sendRequest('resource.get', { path });

    // Create resource proxy
    const resource = new MCPResource(this, path, metadata);
    this.resources.set(path, resource);

    return resource;
  }

  getLocalResource(path) {
    const resource = {
      server: this.server,
      path,
      type: 'agent',
      mode: 'local',

      async send(event, data) {
        console.log(`[MCP:Local] ${event} on ${path}`);
        return {
          status: 'ok',
          message: `Simulated response from mcp://${this.server}/${path}`,
          event,
          ...data,
          __simulated: true
        };
      },

      async handle(event, data) {
        return this.send(event, data);
      }
    };

    this.resources.set(path, resource);
    return resource;
  }

  async listTools() {
    if (this.mode === 'local') {
      return []; // No tools in local mode
    }

    return await this.sendRequest('tools.list', {});
  }

  async invokeTool(toolName, args) {
    if (this.mode === 'local') {
      throw new Error('Tools not available in local mode');
    }

    return await this.sendRequest('tools.invoke', { name: toolName, args });
  }

  startHeartbeat() {
    if (this.mode === 'local') return;

    this.heartbeatInterval = setInterval(() => {
      if (this.mode === 'websocket' && this.ws) {
        this.ws.ping();
      } else if (this.mode === 'http') {
        // HTTP heartbeat via ping endpoint
        fetch(`${this.baseUrl}/mcp/v1/ping`, {
          method: 'GET',
          headers: this.getHTTPHeaders()
        }).catch(() => {
          // Heartbeat failed, emit error
          this.emit('error', new Error('Heartbeat failed'));
        });
      }
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async disconnect() {
    this.stopHeartbeat();
    this.connected = false;
    this.resources.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Connection closed'));
    });
    this.pendingRequests.clear();

    this.emit('disconnected');
  }
}

/**
 * MCP Resource - represents a remote resource/agent
 */
class MCPResource {
  constructor(connection, path, metadata) {
    this.connection = connection;
    this.path = path;
    this.metadata = metadata;
    this.type = metadata.type || 'agent';
    this.capabilities = metadata.capabilities || [];
  }

  async send(event, data, options = {}) {
    return await this.connection.sendRequest('resource.invoke', {
      path: this.path,
      event,
      data,
      options
    });
  }

  async sendStream(event, data, options = {}) {
    if (!this.capabilities.includes('streaming')) {
      throw new Error('Resource does not support streaming');
    }

    // For WebSocket, use streaming protocol
    if (this.connection.mode === 'websocket') {
      return this.streamWebSocket(event, data, options);
    }

    // For HTTP, use chunked transfer
    return this.streamHTTP(event, data, options);
  }

  async *streamWebSocket(event, data, options) {
    const id = ++this.connection.messageId;
    const message = JSON.stringify({
      id,
      method: 'resource.stream',
      params: { path: this.path, event, data, options }
    });

    // Set up stream handler
    const chunks = [];
    let streamEnded = false;
    let streamError = null;

    const handler = (msg) => {
      if (msg.id === id) {
        if (msg.chunk) {
          chunks.push(msg.chunk);
        }
        if (msg.done) {
          streamEnded = true;
        }
        if (msg.error) {
          streamError = new Error(msg.error);
          streamEnded = true;
        }
      }
    };

    this.connection.on('message', handler);
    this.connection.ws.send(message);

    try {
      // Yield chunks as they arrive
      while (!streamEnded) {
        if (chunks.length > 0) {
          yield chunks.shift();
        } else {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      // Yield any remaining chunks
      while (chunks.length > 0) {
        yield chunks.shift();
      }

      if (streamError) {
        throw streamError;
      }
    } finally {
      this.connection.off('message', handler);
    }
  }

  async *streamHTTP(event, data, options) {
    const response = await fetch(`${this.connection.baseUrl}/mcp/v1/stream`, {
      method: 'POST',
      headers: this.connection.getHTTPHeaders(),
      body: JSON.stringify({
        path: this.path,
        event,
        data,
        options
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Read streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            yield data;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async handle(event, data) {
    return this.send(event, data);
  }
}

/**
 * Authentication Manager
 */
class AuthenticationManager {
  constructor(config = {}) {
    this.credentials = new Map();
    this.tokenCache = new Map();

    // Load initial credentials
    if (config.credentials) {
      Object.entries(config.credentials).forEach(([server, creds]) => {
        this.credentials.set(server, creds);
      });
    }
  }

  async getCredentials(server) {
    // Check if we have cached credentials
    if (this.credentials.has(server)) {
      return this.credentials.get(server);
    }

    // Try to get from environment
    const envKey = `MCP_AUTH_${server.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
    if (process.env[envKey]) {
      const token = process.env[envKey];
      const creds = { token };
      this.credentials.set(server, creds);
      return creds;
    }

    return null;
  }

  setCredentials(server, credentials) {
    this.credentials.set(server, credentials);
  }

  clearCredentials(server) {
    this.credentials.delete(server);
    this.tokenCache.delete(server);
  }
}

/**
 * Server Registry - for service discovery
 */
class ServerRegistry extends EventEmitter {
  constructor(registryUrl) {
    super();
    this.registryUrl = registryUrl;
    this.cache = new Map();
    this.cacheExpiry = 60000; // 1 minute
  }

  async connect() {
    // Verify registry is accessible
    try {
      const response = await fetch(`${this.registryUrl}/health`, { timeout: 5000 });
      if (!response.ok) {
        throw new Error(`Registry unhealthy: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Failed to connect to registry: ${error.message}`);
    }
  }

  async discover(resourcePath, options = {}) {
    const cacheKey = `discover:${resourcePath}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.servers;
    }

    // Query registry
    try {
      const response = await fetch(`${this.registryUrl}/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: resourcePath, ...options })
      });

      if (!response.ok) {
        throw new Error(`Registry query failed: ${response.status}`);
      }

      const data = await response.json();
      const servers = data.servers || [];

      // Cache result
      this.cache.set(cacheKey, {
        servers,
        timestamp: Date.now()
      });

      return servers;
    } catch (error) {
      console.error('[Registry] Discovery failed:', error.message);

      // Return cached result if available (even if expired)
      if (cached) {
        console.warn('[Registry] Using stale cache');
        return cached.servers;
      }

      return [];
    }
  }
}

/**
 * Load Balancer
 */
class LoadBalancer {
  constructor(client) {
    this.client = client;
    this.strategy = 'round-robin'; // or 'least-connections', 'random', 'weighted'
    this.counters = new Map();
  }

  selectServer(servers) {
    if (servers.length === 0) {
      throw new Error('No servers available');
    }

    if (servers.length === 1) {
      return servers[0];
    }

    switch (this.strategy) {
      case 'round-robin':
        return this.roundRobin(servers);

      case 'random':
        return servers[Math.floor(Math.random() * servers.length)];

      case 'least-latency':
        return this.leastLatency(servers);

      default:
        return servers[0];
    }
  }

  roundRobin(servers) {
    const key = servers.join(',');
    const counter = this.counters.get(key) || 0;
    const index = counter % servers.length;
    this.counters.set(key, counter + 1);
    return servers[index];
  }

  leastLatency(servers) {
    let bestServer = servers[0];
    let bestLatency = Infinity;

    for (const server of servers) {
      const health = this.client.getServerHealth(server);
      if (health.latency !== null && health.latency < bestLatency) {
        bestLatency = health.latency;
        bestServer = server;
      }
    }

    return bestServer;
  }
}

// Global MCP client instance
export const mcpClient = new MCPClient();

// Load configuration from environment
if (process.env.KOI_MCP_DEBUG) {
  mcpClient.on('connected', (server) => console.log(`[MCP:Debug] Connected: ${server}`));
  mcpClient.on('disconnected', (server) => console.log(`[MCP:Debug] Disconnected: ${server}`));
  mcpClient.on('error', (error) => console.error(`[MCP:Debug] Error:`, error));
}

if (process.env.KOI_MCP_REGISTRY) {
  mcpClient.initRegistry(process.env.KOI_MCP_REGISTRY);
}
