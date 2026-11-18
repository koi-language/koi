# 6. Skills and subagents

Koi reads the same Markdown formats as Claude Code: `SKILL.md` skills and Markdown subagents, from the
project's `.koi/` folder. What you already wrote for Claude Code works here.

```
.koi/
├── skills/
│   └── order-policy/
│       └── SKILL.md          # a skill
└── agents/
    └── credit-checker.md     # a subagent
```

## Skills

A skill is knowledge an agent loads when it needs it: company rules, a procedure, a style guide, how to use an
internal API.

`.koi/skills/order-policy/SKILL.md`:

```markdown
---
name: order-policy
description: Company rules for accepting customer orders. Use before accepting, rejecting or pricing an order.
---
- Never accept orders from customers with invoices overdue more than 30 days.
- Orders with a delivery date in less than 48 hours go to the warehouse manager.
- Prices come from the customer's price list, never from the email.
```

- `name` and `description` are required. The description says **when** to use the skill: every agent sees
  the catalog of skills (names and descriptions) and loads the ones a task needs.
- The body is loaded only when the skill is activated, so a large catalog costs nothing until it is used.
- Skills are found in the project (`.koi/skills/<name>/SKILL.md`) and for the user (`~/.koi/skills/`); a project
  skill wins over a user skill with the same name.

### Loading a skill always

When an agent must always follow a skill, load it with `uses skill`:

```python
export agent OrderClerk : OrderDesk {
  uses mcp mail, erp
  uses skill "order-policy"
  ...
}
```

The skill is activated every time the agent starts a task. Quote the name when it has dashes; several are
separated by commas: `uses skill "order-policy", "pricing-rules"`.

### Skills written in Koi

A skill can also be code: functions the agent calls as tools, for what must be exact.

```python
skill Pricing {
  affordance "Exact price and VAT calculations"

  export function withVat(amount: number, rate: number): number {
    return Math.round(amount * (1 + rate / 100) * 100) / 100
  }
}

agent Quoter : Sales {
  uses skill Pricing
  ...
}
```

`uses skill` tells them apart by name: a `skill` declared in Koi is a code skill, any other name is a
`SKILL.md`.

## Subagents in Markdown

A subagent is an agent written as a Markdown file: a description and its instructions.

`.koi/agents/credit-checker.md`:

```markdown
---
name: creditChecker
description: Checks a customer's credit and payment history and says whether a new order fits.
skills: [order-policy]
---
You decide whether a new order fits a customer's credit. Look at the credit limit, the open balance
and the invoices overdue, and answer with { fits, available, reason }.
```

- Any agent whose role has `can delegate` can hand work to it, deciding by its `description`.
- `skills` are activated every time the subagent starts.
- `name` is optional (by default, the file name in camelCase); folders inside `.koi/agents/` are searched too.
- A Markdown subagent runs with broad permissions (read, write, shell, web, MCP, delegate, ask the user).
  When you need to restrict what it may do, write it as a Koi agent with its own role instead.

Next: [Phases and transitions](07-phases-and-transitions.md).
