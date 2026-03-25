/**
 * MCP Agent Server — exposes a Koi agent's event handlers as MCP tools over stdio.
 *
 * Implements the JSON-RPC 2.0 based MCP protocol (protocol version 2024-11-05)
 * using newline-delimited JSON over stdin/stdout.
 *
 * Usage:
 *   const server = new MCPAgentServer(agent);
 *   server.start();
 */

import { createInterface } from 'readline';

export class MCPAgentServer {
  constructor(agent) {
    this.agent = agent;
    this._tools = null; // lazily built
  }

  /**
   * Build the MCP tool list from the agent's handlers, filtering out private ones.
   */
  getTools() {
    if (this._tools) return this._tools;

    const tools = [];
    for (const [name, handler] of Object.entries(this.agent.handlers)) {
      if (handler.__private__) continue;

      const description = handler.__description__ || `Handler '${name}' on agent '${this.agent.name}'`;

      // Build input schema from handler metadata
      // Default: accept a single `args` parameter of type object
      const inputSchema = {
        type: 'object',
        properties: {
          args: {
            type: 'object',
            description: 'Arguments passed to the handler'
          }
        }
      };

      tools.push({ name, description, inputSchema });
    }

    this._tools = tools;
    return tools;
  }

  /**
   * Start the stdio server — reads newline-delimited JSON-RPC from stdin,
   * writes responses to stdout.
   */
  start() {
    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this._write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        });
        return;
      }

      const response = await this._handleMessage(msg);
      if (response) {
        this._write(response);
      }
    });

    rl.on('close', () => {
      process.exit(0);
    });
  }

  /**
   * Handle a single JSON-RPC message and return the response (or null for notifications).
   */
  async _handleMessage(msg) {
    const { id, method, params } = msg;

    // Notifications (no id) — no response needed
    if (id === undefined && method === 'notifications/initialized') {
      return null;
    }

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: this.agent.name,
              version: '1.0.0'
            }
          }
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: this.getTools() }
        };

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        const handler = this.agent.handlers[toolName];
        if (!handler) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${toolName}`
            }
          };
        }

        if (handler.__private__) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Tool '${toolName}' is private and cannot be called externally`
            }
          };
        }

        try {
          let result;

          if (handler.__playbookOnly__) {
            // For playbook-only handlers, resolve the playbook text and return it
            // The caller (MCP client) can then use it as a prompt
            let playbook;
            if (handler.__playbook__) {
              playbook = handler.__playbook__;
            } else if (handler.__playbookFn__) {
              playbook = await handler.__playbookFn__(
                toolArgs.args || toolArgs,
                this.agent.state,
                this.agent
              );
            } else {
              playbook = '(no playbook defined)';
            }

            // Execute the playbook via the agent's handle method
            result = await this.agent.handle(toolName, toolArgs.args || toolArgs);
          } else {
            // Regular handler — call directly
            result = await handler(toolArgs.args || toolArgs);
          }

          const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }]
            }
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: err.message || 'Internal error'
            }
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  }

  /**
   * Write a JSON-RPC response to stdout.
   */
  _write(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}
