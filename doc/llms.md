# Koi: reference for AI assistants

Koi is a programming language for agents. An agent is declared in a `.koi` file with a role (what it may do),
handlers (what it can be asked), and playbooks (plain-language instructions). At run time each handler is a
reasoning loop: the model picks one action, sees the result, and continues until it calls `return`.
TypeScript imports `.koi` files and calls agents as typed async functions.

Use this page to write Koi code. Syntax highlighting: mark Koi code blocks as `python`.

## Project layout

```
my-app/
├── agents/*.koi              # Koi agents, imported from TS as "#agents/<file>.koi"
├── agents/prompts/*.md       # long instructions, imported as prompts
├── .koi/skills/<name>/SKILL.md   # skills (Claude Code format)
├── .koi/agents/*.md          # Markdown subagents (Claude Code format)
├── src/*.ts                  # application code
└── .env                      # model keys
```

Setup once: `npx @koi-language/koi setup`. Types: `koi types` (writes `agents/<file>.d.koi.ts`).

## Syntax

```python
import Rules: prompt from "./prompts/rules.md"     // a Markdown file as a prompt
import "./shared.koi"                              // everything another .koi file declares

role OrderDesk { can execute, can call_mcp, can delegate }

mcp erp = {                                        // remote MCP server
  url: "https://erp.example.com/mcp",
  headers: { Authorization: `Bearer ${process.env.ERP_TOKEN}` },
  description: "ERP: customers, products, stock, orders"
}
mcp mail = { command: "node", args: ["./mcp/mail.js"], env: { IMAP_PASSWORD: process.env.IMAP_PASSWORD } }

prompt Tone = "Answer in the customer's language."
prompt Playbook = compose {
  fragments: { rules: Rules, tone: Tone }
  template: """
{{rules}}
@if (phase.name == 'working') {
Process the orders since {{args.since}}. Call phase_done when all are in the ERP.
}
@if (phase.name == 'reporting') {
{{tone}}
Call return with [{ orderId, status, issues }].
}
"""
}

agent CreditChecker : OrderDesk {
  on check(args: { customer: string, total: number }) {
    affordance "Says whether an order fits the customer's credit"
    playbook "Check {{args.customer}}'s credit in the ERP for {{args.total}} EUR. Return { fits, reason }."
  }
}

team Desk { credit: CreditChecker }

export agent OrderClerk : OrderDesk {
  affordance "Turns order emails into ERP orders pending approval"
  uses mcp mail, erp
  uses team Desk
  uses skill "order-policy"            // a SKILL.md, activated on every task

  phases {
    working   { reasoning: medium, cant return }
    reporting { reasoning: low }
  }
  transitions {
    when invoked                 { phase('working').start() }
    when phase('working').done   { phase('reporting').start() }
    when error.llm               { if (error.count < 3) { bump(reasoning, +20, max: 85) } }
  }

  on processInbox(args: { since: string }) {
    playbook Playbook
  }
}

run OrderClerk.processInbox({ since: "2026-11-17" })   // only for `koi run`; ignored when imported
```

## Reference

**Declarations**: `import`, `role`, `mcp`, `prompt`, `team`, `agent` (`export agent` to import it from TS),
`skill` (code skill), `run`.

**Agent body**: `affordance "..."`, `on name(args: Type) { playbook ... }`, `private on`, `uses mcp a, b`,
`uses team T`, `uses skill X, "md-skill"`, `phases { }`, `transitions { }`, `state { x: number = 0 }`,
`amnesia = true`, `llm default = { provider: "auto", model: "auto" }`, `expose mcp`.

**Argument types**: `string`, `number`, `boolean`, `Json`, `{ a: string, b?: number }`, `string[]`,
`Array<T>`, `A | B`. No string-literal types (`"a" | "b"` does not parse).

**Imports**: `import Name: prompt from "./x.md"` (a text file as a prompt), `import Name: prompt from
"./x.koi"` (an `export prompt Name` of another file), `import "./x.koi"` (everything it declares).

**Playbook**: a string (`"..."` or `"""..."""`), a prompt name, or several joined with `+`.
In plain text playbooks (and `.md` prompts used directly), `{{args.x}}` and `{{state.x}}` are filled in.

**Capabilities** (`can x` in a role):

| Capability | Tools |
|---|---|
| `execute` | shell, `phase_done` |
| `read` / `write` | read, search / write, edit files |
| `web_access` | web search, fetch |
| `call_mcp` | tools of the MCP servers in `uses mcp` |
| `delegate` | delegate to team members and Markdown subagents |
| `ask_parent` | ask the delegating agent |
| `prompt_user` | ask the user |
| `read_tasks`, `write_tasks` | shared task list and work queue |
| `generate_image`, `generate_video`, `generate_audio` | media (needs the Koi API) |
| `use_browser`, `use_lsp`, `use_mobile`, `agenda`, `manage_session` | browser, code intelligence, mobile, scheduling, session files |

Always available: `print`, `return`, memory, skills.

**Phases**: `name { reasoning: none|low|medium|high, code: ..., maxOutputTokens: N, can x, cant x }`.
`can` = only these capabilities in the phase; `cant` = not these; `cant return` = cannot finish here.
The agent calls `phase_done` (needs `can execute`); transitions choose the next phase.

**Transitions**: `when <event>[, <event>] { actions }`. Events: `invoked`, `user.message`, `session.start`,
`session.resumed`, `phase('x').done`, `phase.done`, `<teamKey>.result`, `any.result`, `error.llm`
(`error.count`). Actions: `phase('x').start()`, `effort(low|medium|high)`, `score(reasoning|code, 0-100)`,
`bump(reasoning|code, +N, max: N, min: N)`. Conditions: `if (...) { } else { }`, `== != < > && || !`.

**`compose` templates** (evaluated every time the agent thinks; one directive per line, blocks can nest):
`{{fragment}}`, `{{expr}}` (any JS expression), `@let x = expr` (any JS expression), `@if (cond) {` ... `}`,
`} @else {`, `@else if (cond) {` (on the line after `}`), `tool('name').call(args)`. Variables: `args`,
`state`, `phase` (`phase.name`, `phase.is('x')`), `user` (`message`, `language`, `interactive`),
`recentFailure`, `agentName`, and each team member key with `.result` (`{ success, data }`) right after it
returns. `export prompt X = compose() { ... }` shares a template between files.

```python
prompt WorkerPlaybook = compose {
  fragments: { rules: Rules, task: AssignedTask }
  template: """
@let tasks = tool('task_list').call()
@let pending = tasks?.tasks?.filter(t => t.status === 'pending') || []
{{rules}}
{{task}}
@if (phase.name == 'working') {
@if (pending.length > 0) {
{{pending.length}} tasks pending; start with: {{pending[0].subject}}
} @else {
Nothing pending: call phase_done.
}
}
"""
}
```

**`.md` fragments** of a `compose` may contain simple conditions: `@let x = path`, `@if (path) { ... }`
(true when the value exists), `{{path}}` (dotted names like `user.language`); no operators, `@else` or
nesting. `\{{` writes literal braces.

**Skills**: `.koi/skills/<name>/SKILL.md` with frontmatter `name`, `description` (when to use it). Agents see
the catalog and load what they need; `uses skill "name"` loads it on every task. **Markdown subagents**:
`.koi/agents/<file>.md` with frontmatter `name`, `description`, `skills: [..]`; usable by any agent with
`can delegate`; they run with broad permissions.

**Models**: `.env` with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`, or `KOI_API_KEY`
(+ optional `KOI_API_URL`) for the Koi API. Image, video and audio only through the Koi API. By default the
model is chosen per step from the phase's needs.

## Calling from TypeScript

```ts
import { OrderClerk } from "#agents/orders.koi";

const orders = await OrderClerk.processInbox(
  { since: "2026-11-17" },
  {
    timeoutMs: 600_000,          // KOI_TIMEOUT
    maxSteps: 150,               // KOI_MAX_STEPS
    signal,                      // KOI_ABORTED
    autoApprove: false,          // shell / file writes / paid media denied unless true
    onEvent: (e) => {},          // progress, action, output, status, question, answer, log
    onQuestion: (q) => null,     // answer the agent, or null: it decides on its own
  },
);
```

Other error codes: `KOI_AGENT_FAILED` (gave up), `KOI_NO_PROVIDER` (no model key). A call never prints and never
reads stdin. Calls are independent and can run in parallel.

## Rules of thumb

- One agent, one job. Split big work into a lead (`can delegate`, `uses team`) and specialists.
- Give every handler an `affordance`: other agents choose whom to delegate to by it.
- Type the arguments: they are the TS types and what a lead passes when it delegates.
- In the playbook, state the goal, the rules that must never be broken, and the exact shape to return.
- Grant the fewest capabilities; restrict at the MCP server what must never happen (read-only tokens).
- Secrets only via `process.env` in `mcp` declarations; never in the `.koi` file.
- Put long instructions in `.md` files and phase-specific parts behind `@if (phase.name == ...)`.
- Handler names cannot be keywords (`run`, `return`, `state`, `prompt`, `skill`, `team`, ...).
- Quote `SKILL.md` names with dashes: `uses skill "order-policy"`.
- Only `export agent`s are importable; `run` statements are ignored when a file is imported.
