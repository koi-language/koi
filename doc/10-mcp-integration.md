# MCP Protocol

Model Context Protocol (MCP) enables connecting to remote agents and services. Koi supports both **consuming** external MCP servers and **exposing** agents as MCP servers.

## Table of Contents

- [Overview](#overview)
- [Consuming MCP Servers](#consuming-mcp-servers)
- [Exposing Agents as MCP Servers](#exposing-agents-as-mcp-servers)
- [MCP Address Format](#mcp-address-format)
- [Authentication](#authentication)
- [Connection Modes](#connection-modes)

## Overview

Koi provides complete MCP implementation with:
- **Client**: Connect to external MCP servers (`uses mcp`)
- **Server**: Expose agent handlers as MCP tools (`expose mcp`)
- WebSocket and HTTP/2 support
- Authentication & authorization
- Connection pooling
- Load balancing
- Retry logic & failover
- Streaming responses

## Consuming MCP Servers

Use `uses mcp` to connect agents to external MCP servers:

```koi
Team HybridTeam {
  local = LocalAgent
  remote = mcp://agent.local/processor
}

Agent Orchestrator : Worker {
  uses Team HybridTeam

  on start(args: Json) {
    const result = await send peers.event("process").role(Worker).any()(args)
    return result
  }
}
```

## Exposing Agents as MCP Servers

Koi agents can expose their event handlers as MCP tools, making them callable by any MCP client (Claude Code, Cursor, other Koi agents, etc.).

### Syntax

Add `expose mcp` inside an agent body. All public handlers become MCP tools:

```koi
role Reviewer { can review,
                can analyze }

agent CodeReviewer : Reviewer {
  expose mcp

  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on review(args: Json) {
    affordance "Review code for quality, style, and potential bugs"
    playbook """
    Review the following code: {{args.code}}
    Language: {{args.language}}

    Check for correctness, best practices, and security issues.
    Return JSON: { "issues": [...], "score": 0-10, "summary": "..." }
    """
  }

  on analyze(args: Json) {
    affordance "Analyze code complexity and suggest improvements"
    playbook """
    Analyze the complexity of: {{args.code}}
    Suggest improvements and simplifications.
    """
  }

  private on internal_step(args: Json) {
    // NOT exposed — private handlers are excluded from MCP
    playbook "Prepare internal analysis context"
  }
}
```

### Private Handlers

Use the `private` modifier to exclude specific handlers from MCP exposure:

```koi
agent MyAgent : Worker {
  expose mcp

  on public_action(args: Json) {    // Exposed as MCP tool
    playbook "..."
  }

  private on helper(args: Json) {   // NOT exposed
    playbook "..."
  }
}
```

Private handlers can still be called internally (`this.handle("helper", args)`) but are invisible to MCP clients.

### Running as MCP Server

Use the `koi serve` CLI command to start an agent as a stdio MCP server:

```bash
koi serve path/to/agent.koi
```

This:
1. Compiles the `.koi` file
2. Finds the agent with `expose mcp`
3. Starts a JSON-RPC 2.0 server reading from stdin and writing to stdout
4. Responds to `initialize`, `tools/list`, and `tools/call` messages

### Tool Discovery

When an MCP client sends `tools/list`, the server returns all public handlers with:
- **name**: The handler name (e.g., `review`, `analyze`)
- **description**: From the handler's `affordance` statement or auto-generated
- **inputSchema**: Accepts an `args` object parameter

### Configuring MCP Clients

Add a Koi agent to any MCP client's configuration. Example `.mcp.json`:

```json
{
  "mcpServers": {
    "code-reviewer": {
      "command": "koi",
      "args": ["serve", "path/to/code-reviewer.koi"]
    }
  }
}
```

This works with Claude Code, Cursor, and any other tool that supports MCP stdio servers.

### Example: End-to-End

**1. Create the agent** (`agents/reviewer.koi`):

```koi
role Reviewer { can review }

agent CodeReviewer : Reviewer {
  expose mcp

  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on review(args: Json) {
    affordance "Review code and provide feedback"
    playbook """
    Review this code: {{args.code}}
    Provide feedback on quality and correctness.
    """
  }
}
```

**2. Serve it**:

```bash
koi serve agents/reviewer.koi
```

**3. Test with JSON-RPC** (pipe to stdin):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | koi serve agents/reviewer.koi
```

Response:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"CodeReviewer","version":"1.0.0"}}}
```

**4. Add to your MCP config** and the agent's handlers appear as tools in your editor.

## MCP Address Format

```
mcp://server/path
```

Examples:
- `mcp://agent.local/processor` (local simulation)
- `mcp://production.example.com/agent` (HTTP/2)
- `mcp://ws://realtime.com/streaming` (WebSocket)

## Authentication

Set environment variables:

```bash
export MCP_AUTH_PRODUCTION_EXAMPLE_COM="your-token"
```

## Connection Modes

1. **Local Simulation** (`.local`) - for testing
2. **WebSocket** - for real-time streaming
3. **HTTP/2** - for request-response

For complete details, see [MCP_GUIDE.md](../MCP_GUIDE.md) in the root directory.

---

**Next**: [TypeScript Imports](11-typescript-imports.md) →
