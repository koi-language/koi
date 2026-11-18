# Koi documentation

Koi is a programming language for agents that do real work: they reason about a task, use your systems,
delegate to other agents and return a result. You call them from TypeScript as async functions.

Read in order: each guide builds on the previous ones.

| # | Guide | What you learn |
|---|---|---|
| 1 | [Getting started](01-getting-started.md) | Install, your first agent, call it from TypeScript |
| 2 | [Agents and roles](02-agents-and-roles.md) | Roles and capabilities, handlers, playbooks, arguments, results |
| 3 | [Prompts](03-prompts.md) | Reusable prompts, prompts in `.md` files, `compose` templates |
| 4 | [Teams and delegation](04-teams-and-delegation.md) | Agents that hand work to other agents |
| 5 | [MCP](05-mcp.md) | Connect agents to your systems through MCP servers, and expose them as one |
| 6 | [Skills and subagents](06-skills-and-subagents.md) | `SKILL.md` skills and Markdown subagents, the Claude Code formats |
| 7 | [Phases and transitions](07-phases-and-transitions.md) | Multi-step agents as state machines, model effort per step |
| 8 | [Calling agents from TypeScript](08-typescript.md) | Options, events, questions, permissions, errors, types, packages |
| 9 | [Models](09-models.md) | Provider keys, the Koi API, how the model is chosen |

For AI assistants (Claude Code, Cursor, ...): [llms.md](llms.md) is a one-page summary of everything needed to
write Koi agents. Copy it into your project's `CLAUDE.md` or `AGENTS.md`.
