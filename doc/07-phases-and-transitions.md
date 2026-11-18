# 7. Phases and transitions

## The problem phases solve

An agent with one playbook sees all its instructions, and all its tools, all the time. For a simple job that is
fine. For a longer one it causes three typical failures:

- it **rushes**: it starts changing things before it has understood the task;
- it **skips steps**: it returns before checking its own work;
- it **overthinks the easy parts**: the whole task runs with the effort (and the cost) of its hardest step.

Phases split the work into stages. In each stage the agent sees only that stage's instructions, can only use
that stage's tools, and thinks with that stage's effort. **Transitions** decide which stage comes next.

## Example 1: the smallest agent with phases

A writer that must draft first and review afterwards:

```python
role WriterRole { can execute, can web_access }

export agent Writer : WriterRole {

  phases {
    drafting  { reasoning: medium, cant return }
    reviewing { reasoning: high }
  }

  transitions {
    when invoked {
      phase('drafting').start()
    }
    when phase('drafting').done {
      phase('reviewing').start()
    }
  }

  on write(args: { topic: string }) {
    playbook WriterPlaybook
  }
}

prompt WriterPlaybook = compose {
  template: """
Topic: {{args.topic}}

@if (phase.name == 'drafting') {
Write a first draft of 300 words. Do not polish it yet.
When the draft is complete, call phase_done.
}

@if (phase.name == 'reviewing') {
Review your draft: check every fact on the web, cut what is vague, fix the tone.
Then call return with { text, changes }.
}
"""
}
```

What happens when you call `Writer.write({ topic: "solar panels for SMEs" })`:

1. The agent starts. The event `invoked` fires, and the transition `when invoked` starts the phase `drafting`.
2. The agent thinks with medium effort and sees only the drafting instructions:
   ```
   Write a first draft of 300 words. Do not polish it yet.
   When the draft is complete, call phase_done.
   Topic: solar panels for SMEs
   ```
   (Koi places the parts that change on every call, like the topic, after the fixed ones, so the model
   provider can cache the fixed part.)
3. It writes the draft. If it tried to `return` now, it would be refused: the phase says `cant return`.
4. It calls `phase_done`. The event `phase('drafting').done` fires, and its transition starts `reviewing`.
5. The agent now thinks with high effort and sees only the reviewing instructions. It checks, corrects, and
   calls `return`. What it returns is what your `await` receives.

Three things to remember from this example:

- **Nothing starts a phase by itself.** Without `when invoked { phase('drafting').start() }` the agent has no
  phase, and every `@if (phase.name == ...)` block of its prompt is hidden.
- **The agent never chooses the next phase.** It only says "I'm done with this one" (`phase_done`, which needs
  `can execute` in the role); the transitions decide where to go.
- **`cant return`** is what stops it from skipping the review.

## Example 2: different tools in each phase

`can` and `cant` inside a phase narrow down what the role allows, only for that phase:

```python
role DeveloperRole { can execute, can read, can write }

agent Fixer : DeveloperRole {
  phases {
    investigating { reasoning: high,   can read, can execute, cant return }
    fixing        { reasoning: medium, cant return }
    reporting     { reasoning: low,    cant write }
  }

  transitions {
    when invoked                       { phase('investigating').start() }
    when phase('investigating').done   { phase('fixing').start() }
    when phase('fixing').done          { phase('reporting').start() }
  }

  on fix(args: { bug: string }) {
    playbook FixerPlaybook
  }
}
```

- In `investigating` the agent can only read and run commands (`can read, can execute` keeps just those): it
  **cannot** modify a file, however sure it is of the fix.
- In `fixing` it has everything its role allows.
- In `reporting` it can no longer write (`cant write`): it can only describe what it did and return.

`can` lists what remains in that phase (only capabilities the role already has); `cant` removes capabilities.
The tools of a removed capability disappear from what the agent sees in that phase.

## Example 3: effort per phase

Each phase says how much the model should think, and that decides which model runs it and what it costs:

```python
phases {
  triage    { reasoning: low }                     // read and classify: a fast, cheap model
  analysis  { reasoning: high, code: medium }      // the hard part: the strongest model
  answer    { reasoning: low, maxOutputTokens: 2000 }
}
```

| Setting | Values | Meaning |
|---|---|---|
| `reasoning` | `none`, `low`, `medium`, `high` | how hard the model thinks |
| `code` | `none`, `low`, `medium`, `high` | how much coding ability the phase needs |
| `maxOutputTokens` | a number | a cap on the length of each answer |

With models chosen automatically (the default, see [Models](09-models.md)), a `low` phase runs on a fast model
and a `high` one on the strongest available. A long task where most steps are routine costs a fraction of
running it all at `high`.

## Example 4: reacting to what another agent returns

A lead agent asks a planner for a plan, and only if there is one, executes it:

```python
role LeadRole { can execute, can delegate }

team Planning {
  planner: Planner
}

export agent Lead : LeadRole {
  uses team Planning

  phases {
    planning  { reasoning: low }
    executing { reasoning: medium }
    giving_up { reasoning: low }
  }

  transitions {
    when invoked {
      phase('planning').start()
    }
    when planner.result {
      if (planner.result.success) {
        phase('executing').start()
      } else {
        phase('giving_up').start()
      }
    }
  }

  on achieve(args: { goal: string }) {
    playbook LeadPlaybook
  }
}

prompt LeadPlaybook = compose {
  template: """
Goal: {{args.goal}}

@if (phase.name == 'planning') {
Ask the planner for a plan to reach the goal.
}
@if (phase.name == 'executing') {
Carry out, step by step, the plan the planner returned.
}
@if (phase.name == 'giving_up') {
The planner could not make a plan. Return { success: false, reason } explaining why.
}
"""
}
```

- `when planner.result` fires the moment the team member `planner` returns. `planner.result.success` and
  `planner.result.data` are what it returned. They are set only at that moment: in later steps the agent finds
  the plan in its own conversation, which is why the `executing` instructions just refer to it.
- The phase changes without the lead calling `phase_done`: the planner's answer is what moves it forward.
- `when any.result { ... }` catches the return of any member that has no clause of its own.

## Example 5: recovering from errors

Model calls sometimes fail: a malformed answer, a timeout, a refusal. `error.llm` lets the agent react:

```python
transitions {
  when error.llm {
    if (error.count < 3) {
      bump(reasoning, +20, max: 85)
    } else {
      phase('planning').start()
      effort(high)
    }
  }
}
```

- `error.count` is how many model calls have failed in a row.
- The first two times, `bump` raises the reasoning score by 20 (scores go from 0 to 100), up to 85: the next
  attempt thinks harder, or moves to a stronger model.
- The third time, it starts over from `planning` with high effort. Order matters: starting a phase resets the
  settings to that phase's own, so `effort(high)` goes after `phase('planning').start()`.

| Action | Effect |
|---|---|
| `phase('x').start()` | go to phase `x` (its settings replace the current ones) |
| `effort(low)` / `effort(medium)` / `effort(high)` | set the reasoning effort from now on |
| `score(reasoning, 70)`, `score(code, 40)` | set a score, 0 to 100 (`low` is about 30, `medium` 60, `high` 90) |
| `bump(reasoning, +20, max: 85)` | raise or lower a score; `min:` and `max:` keep it within limits |

## Example 6: an agent that talks to a user

An assistant used from the terminal (`koi run`) waits for the user between turns. Every message starts it
again, so the transitions bring it back to the right phase. This is the structure of the Koi CLI's main agent:

```python
export agent Assistant : AssistantRole {
  uses team Specialists

  phases {
    routing      { reasoning: low, cant return }
    running_plan { reasoning: low, cant return }
  }

  transitions {
    when user.message, session.start, session.resumed {
      phase('routing').start()
    }
    when planner.result {
      if (planner.result.success) {
        phase('running_plan').start()
      } else {
        phase('routing').start()
      }
    }
    when phase('running_plan').done {
      phase('routing').start()
    }
  }

  on chat(args: Json) {
    playbook AssistantPlaybook
  }
}
```

- `when user.message, session.start, session.resumed`: one clause for three events. Whatever happened, the
  agent goes back to `routing` and decides what to do with the new message.
- In `routing` it answers simple questions itself or asks the planner for a plan. A good plan moves it to
  `running_plan`; when the plan is finished (`phase_done`), it goes back to `routing` for the next message.
- `cant return` in both phases: an assistant does not end, it waits for the user (`prompt_user`).

## All the events

| Event | Fires when |
|---|---|
| `invoked` | the agent is called, by your code or by another agent |
| `user.message` | the user writes (agents that talk to a user) |
| `session.start` / `session.resumed` | a session starts / resumes |
| `phase('x').done` | the agent called `phase_done` in phase `x` |
| `phase.done` | the agent called `phase_done`, in any phase |
| `<member>.result` | the team member with that key returned |
| `any.result` | a team member returned and no clause names it |
| `error.llm` | a model call failed (`error.count` = failures in a row) |

Conditions inside a clause: `if (...) { } else { }`, with `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`, and
values such as `error.count`, `planner.result.success` or `true`.

## Common mistakes

| Symptom | Cause |
|---|---|
| The agent ignores its instructions: every `@if (phase.name == ...)` is hidden | no `when invoked { phase('...').start() }`: it never entered a phase |
| "phase_done is a no-op in phase X" | no transition for `phase('X').done`: add one, or let that phase `return` |
| The agent can't call `phase_done` | its role lacks `can execute` |
| The agent never finishes | every phase has `cant return`: the last phase must allow it |
| "Invalid phase" in the logs | `phase('name')` with a name not declared in `phases { }` |

Next: [Calling agents from TypeScript](08-typescript.md).
