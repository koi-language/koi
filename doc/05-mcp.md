# 5. MCP

MCP (Model Context Protocol) is the standard way to give an agent access to a system: a mailbox, an ERP, a
database, a CRM. Each MCP server offers tools; a Koi agent connected to it can use them.

## Declare a server

A **local** server is a program Koi starts and talks to over stdio:

```python
mcp mail = {
  command: "node",
  args: ["./mcp/mail-server.js"],
  env: { IMAP_USER: process.env.IMAP_USER, IMAP_PASSWORD: process.env.IMAP_PASSWORD },
  description: "The company mailbox: read, search and send email"
}
```

A **remote** server is reached over HTTP:

```python
mcp erp = {
  url: "https://erp.example.com/mcp",
  headers: { Authorization: `Bearer ${process.env.ERP_TOKEN}` },
  description: "The ERP: customers, products, stock, orders"
}
```

- Credentials come from the environment (`process.env.X`); never write them in the `.koi` file.
- `description` tells the agent what the server is for.
- A server with a `url` and no `command` is remote; `type: "http"` says so explicitly.

## Use it from an agent

```python
role OrderDesk { can execute, can call_mcp }

export agent OrderClerk : OrderDesk {
  uses mcp mail, erp

  on processInbox(args: { since: string }) {
    playbook """
      Read the emails received since {{args.since}}. For each purchase order, find the customer and the
      products in the ERP and create the order as "pending approval". Never confirm an order yourself.
    """
  }
}
```

- `uses mcp mail, erp` connects the agent to those servers. Its role needs `can call_mcp`.
- The agent discovers the tools of each server (`open_mcp`), reads a tool's parameters when it needs them
  (`get_mcp_tool_info`) and calls it (`call_mcp`). You don't list the tools: you describe the job in the
  playbook, and the agent works out which tools to use and in what order.
- If a server cannot connect, the agent is told and continues without it. Called from TypeScript, the error
  also reaches your `onEvent` (see [TypeScript](08-typescript.md)).
- Write in the playbook the rules the agent must never break ("never confirm an order"); limit at the server
  what it must never be able to do (a read-only token, an account without delete permissions).

## Expose an agent as an MCP server

The other way round: make an agent a tool that Claude Code, Cursor or any MCP client can call.

```python
role Reviewer { can execute, can read }

agent CodeReviewer : Reviewer {
  expose mcp

  on review(args: { code: string }) {
    affordance "Review code for bugs and risky patterns"
    playbook "Review this code and return [{ line, problem, fix }]: {{args.code}}"
  }

  private on internalStep(args: Json) {
    playbook "Not exposed: private handlers are left out."
  }
}
```

```bash
koi serve agents/reviewer.koi
```

In a client's `.mcp.json`:

```json
{ "mcpServers": { "reviewer": { "command": "npx", "args": ["koi", "serve", "agents/reviewer.koi"] } } }
```

Each public handler becomes an MCP tool, described by its `affordance`.

Next: [Skills and subagents](06-skills-and-subagents.md).
