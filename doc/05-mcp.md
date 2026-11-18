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

What the agent does with that playbook, step by step (the tool names are whatever the servers offer;
these are examples):

1. It opens `mail` and sees its tools: `search_messages`, `get_message`, `send_message`.
2. It calls `search_messages` with `{ since: "2026-11-17" }` and gets 12 emails. It reads each one with
   `get_message` and decides which are purchase orders: 4 are, 8 are not (an invoice, two newsletters...).
3. For the first order it opens `erp`, finds `find_customer` and calls it with the sender's email. The customer
   exists. It calls `search_products` for each line: "tornillo M6 inox caja 100" matches the reference
   TM6-100.
4. It creates the order with `create_order`, status `pending_approval`.
5. It repeats for the other orders, and returns the list.

None of those steps is written in the `.koi` file: the playbook says what to achieve and which rules to keep,
and the agent chains the tools. If tomorrow the ERP adds a tool, the agent can use it without a code change.

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
