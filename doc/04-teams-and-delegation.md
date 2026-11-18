# 4. Teams and delegation

One agent should do one job well. For bigger work, a lead agent hands parts of it to specialists: it decides
whom to call, what to give them, and what to do with what they return.

## A team

```python
role Specialist { can execute, can read, can web_access }
role Lead       { can execute, can delegate }

agent Researcher : Specialist {
  on research(args: { topic: string }) {
    affordance "Finds facts about a topic, with sources"
    playbook "Research {{args.topic}} on the web and return [{ fact, source }]."
  }
}

agent Writer : Specialist {
  on write(args: { facts: Json, audience: string }) {
    affordance "Writes a clear one-page brief from a list of facts"
    playbook "Write a one-page brief for {{args.audience}} from {{args.facts}}. Return it as Markdown."
  }
}

team Content {
  researcher: Researcher,
  writer: Writer
}

export agent Editor : Lead {
  uses team Content

  on brief(args: { topic: string, audience: string }) {
    playbook """
      Produce a one-page brief about {{args.topic}} for {{args.audience}}.
      Get the facts from the researcher, have the writer draft it, check that every claim
      has a source, and return the brief.
    """
  }
}
```

- `team Content { key: Agent }` groups agents under a key.
- `uses team Content` lets the agent delegate to them. Its role needs `can delegate`.
- The lead decides on its own whom to call and when: it sees each member's handlers, their argument types and
  their `affordance`. Good affordances are what make routing work.
- A member receives, as `args`, what the lead passes; declare the argument types so the lead knows what to
  send.
- What a member returns comes back to the lead as the result of the delegation. The lead can delegate
  several tasks in parallel.

## What happens, step by step

When your code calls `Editor.brief({ topic: "heat pumps", audience: "hotel owners" })`:

1. The Editor starts. Besides its playbook, it sees its team: `researcher` can `research(topic)` ("Finds facts
   about a topic, with sources") and `writer` can `write(facts, audience)` ("Writes a clear one-page brief...").
2. It decides to start with the research and delegates to `researcher` with `{ topic: "heat pumps" }`.
3. The Researcher runs on its own: its own role (`web_access`, but not `delegate`), its own playbook, its own
   reasoning loop. It searches, reads, and returns `[{ fact, source }, ...]`.
4. That list comes back to the Editor as the result of its delegation. It now delegates to `writer` with
   `{ facts: [...], audience: "hotel owners" }`.
5. The Writer returns the draft. The Editor checks that every claim has a source (it may send it back to the
   writer, or ask the researcher for a missing source) and returns the brief to your code.

Each member works with only what the lead gives it: it does not see the lead's conversation. Write the lead's
playbook so that it passes everything a member needs.

When steps don't depend on each other, the lead can start several delegations at once: three researchers for
three topics, for example, and wait for all of them.

## Questions back to the lead

A member whose role has `can ask_parent` can ask the lead a question instead of guessing; the lead answers
from what it knows, and the member continues. Without `prompt_user`, a member never talks to the user directly:
its questions go to the lead.

## Reacting to a result

Each member is a variable in the lead's templates and transitions, with `.result` set right after it
returns: `{ success, data }`.

```python
agent Coordinator : Lead {
  uses team Planning

  transitions {
    when planner.result {
      if (planner.result.success) {
        phase('executing').start()
      } else {
        phase('routing').start()
      }
    }
  }
  ...
}
```

`when any.result { ... }` catches the return of any member that has no specific clause. Phases and transitions
are explained in [Phases and transitions](07-phases-and-transitions.md).

## Markdown subagents

Besides team members, any agent with `can delegate` can use the subagents written in Markdown in
`.koi/agents/`. See [Skills and subagents](06-skills-and-subagents.md).

Next: [MCP](05-mcp.md).
