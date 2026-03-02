#!/usr/bin/env node

/**
 * Simple Echo MCP Server for testing Koi's MCP stdio integration.
 * Communicates via JSON-RPC 2.0 over stdin/stdout.
 *
 * Tools:
 *   - echo: Echoes back the input message
 *   - reverse: Reverses the input string
 *   - uppercase: Converts input to uppercase
 */

import { createInterface } from 'readline';

const SERVER_INFO = {
  name: 'echo-mcp-server',
  version: '1.0.0'
};

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the input message',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to echo back' }
      },
      required: ['message']
    }
  },
  {
    name: 'reverse',
    description: 'Reverse the input string',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to reverse' }
      },
      required: ['text']
    }
  },
  {
    name: 'uppercase',
    description: 'Convert text to uppercase',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to convert to uppercase' }
      },
      required: ['text']
    }
  }
];

function sendResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

function sendError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(response + '\n');
}

function handleRequest(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      switch (toolName) {
        case 'echo':
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify({ echo: args.message || '' }) }]
          });
          break;

        case 'reverse':
          const reversed = (args.text || '').split('').reverse().join('');
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify({ reversed }) }]
          });
          break;

        case 'uppercase':
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify({ uppercased: (args.text || '').toUpperCase() }) }]
          });
          break;

        default:
          sendError(id, -32601, `Unknown tool: ${toolName}`);
      }
      break;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications don't require a response
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// Read JSON-RPC messages from stdin (newline-delimited)
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const message = JSON.parse(trimmed);
    handleRequest(message);
  } catch (e) {
    process.stderr.write(`[echo-mcp-server] Parse error: ${e.message}\n`);
  }
});

rl.on('close', () => {
  process.exit(0);
});
