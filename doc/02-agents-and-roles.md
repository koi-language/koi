# 2. Agents and roles

## Roles: what an agent may do

A role is a list of capabilities. An agent has exactly one role, and only the tools its capabilities grant
exist for it: an agent without `can write` cannot write a file, whatever its playbook says.

```python
role Clerk   { can execute, can read, can call_mcp }
role Manager { can execute, can delegate, can prompt_user }
```

| Capability | Gives the agent |
|---|---|
| `execute` | run shell commands, finish phases (`phase_done`) |
| `read` | read and search files and code |
| `write` | write and edit files |
| `web_access` | search the web and fetch pages |
| `call_mcp` | call the tools of MCP servers (see [MCP](05-mcp.md)) |
| `delegate` | hand work to other agents (see [Teams](04-teams-and-delegation.md)) |
| `ask_parent` | ask a question to the agent that delegated to it |
| `prompt_user` | ask the user a question (in the terminal or the app running Koi) |
| `read_tasks`, `write_tasks` | read and manage a shared task list and work queue |
| `generate_image`, `generate_video`, `generate_audio` | generate and edit media (through the Koi API) |
| `use_browser` | drive a web browser |
| `use_lsp` | code intelligence (definitions, references, diagnostics) |
| `use_mobile` | drive a mobile device |
| `agenda` | schedule tasks for later |
| `manage_session` | inspect and restore the files changed in the session |

Some tools need no capability: `print`, `return`, memory (`add_memory`, `recall_memory`) and skills.

## Agents and handlers

```python
agent InvoiceAuditor : Clerk {
  affordance "Audits supplier invoices against purchase orders"

  on audit(args: { folder: string, strict?: boolean }) {
    affordance "Check every invoice in a folder against its purchase order"
    playbook """
      Review the invoices in {{args.folder}}. For each one, find its purchase order and compare
      amounts, VAT and supplier. Return [{ invoice, ok, problems }].
    """
  }

  private on reconcile(args: Json) {
    playbook "Reconcile the ledger for {{args.month}}."
  }
}
```

- **Handlers** (`on name(args: ...)`) are what the agent can be asked to do. An agent may have several.
- **`private on`** handlers are not exported to TypeScript and not offered to other agents.
- **Argument types**: `string`, `number`, `boolean`, `Json` (any object), object types
  (`{ folder: string, strict?: boolean }`), arrays (`string[]`, `Array<{ id: number }>`) and unions
  (`string | number`). They become the TypeScript types of the handler.
- **`affordance`**: one line saying what the agent or the handler is for. Other agents read it to decide whom
  to delegate to, so write one for every handler.

## Playbooks

The playbook is the agent's instructions for that handler. Write it like a brief for a capable colleague:
the goal, the rules it must not break, and what to return.

- `{{args.x}}` inserts an argument; `{{state.x}}` a value of the agent's state.
- A playbook can be a reusable prompt instead of inline text: `playbook AuditRules`, or a combination:
  `playbook AuditRules + "Also check the currency."` (see [Prompts](03-prompts.md)).
- Say what to return and its shape. The agent finishes with its `return` tool, and what it returns is the
  result the caller gets.

## Results

The value the agent returns is what `await` gives you in TypeScript:

```ts
const results = await InvoiceAuditor.audit({ folder: "./invoices/2026-11" });
// results: [{ invoice: "F-0012", ok: false, problems: ["VAT 10% instead of 21%"] }, ...]
```

## More agent settings

```python
agent Analyst : Clerk {
  llm default = { provider: "auto", model: "auto" }   // see Models
  amnesia = true                                     // no memory between turns

  state {
    attempts: number = 0
  }

  on analyse(args: Json) { playbook "..." }
}
```

- **`llm default`**: the model of this agent. Leave it out (or `provider: "auto", model: "auto"`) and Koi
  chooses one per step (see [Models](09-models.md)).
- **`amnesia = true`**: the agent forgets the conversation after each turn. It matters for an agent that
  talks to a user over several turns (`koi run`); a call from TypeScript, or a delegation from another agent,
  always starts from a clean conversation anyway.
- **`state { ... }`**: values the agent keeps, readable in playbooks as `{{state.attempts}}`.

Next: [Prompts](03-prompts.md).
