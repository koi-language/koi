# 3. Prompts

Long instructions don't belong inline in a handler. In Koi, prompts are values: you write them in Markdown
files, import them, combine them, and fill them with placeholders and conditions that are resolved every time
the agent thinks.

## Importing

```python
import Tone: prompt from "./prompts/tone.md"                  // a Markdown file as a prompt
import RefundPolicy: prompt from "./prompts/refund-policy.md"
import AssignedTask: prompt from "./common/assigned-task.koi"  // an `export prompt` of another .koi file
import "./core/team.koi"                                       // everything another .koi file declares
```

| Form | Imports |
|---|---|
| `import Name: prompt from "./x.md"` | the whole file as a prompt called `Name` (also `.txt` or any text file) |
| `import Name: prompt from "./x.koi"` | the prompt that `x.koi` declares as `export prompt Name` |
| `import "./x.koi"` | every agent, role, team, skill and exported prompt of `x.koi` |

Paths are relative to the importing file.

## A prompt in a Markdown file

A prompt file is plain Markdown: headings, lists, examples, whatever the agent should read. Placeholders
(`{{...}}`) are filled in when the prompt is used.

`agents/prompts/refund-policy.md`:

```markdown
## Refund policy

- Orders can be refunded up to 30 days after delivery.
- Digital products are refunded only if they were never downloaded.
- Above 500 EUR, a refund needs a manager: never approve it yourself.

The customer is {{args.customer}}. Answer in their language.
```

`agents/refunds.koi`:

```python
import RefundPolicy: prompt from "./prompts/refund-policy.md"

role SupportRole { can execute, can call_mcp }

export agent RefundAgent : SupportRole {
  on decide(args: { customer: string, order: string }) {
    playbook RefundPolicy + "Decide whether order {{args.order}} can be refunded. Return { refund, reason }."
  }
}
```

`playbook` takes a prompt, a string, or several joined with `+`. Writers can edit the Markdown without
touching the code.

## Placeholders

`{{ }}` inserts a value where the prompt is used:

| Placeholder | Value |
|---|---|
| `{{args.order}}` | an argument of the handler |
| `{{state.attempts}}` | a value of the agent's `state` |
| `{{user.language}}` | the user's language (also `user.message`, `user.interactive`) |
| `{{phase.name}}` | the current phase |
| `{{tone}}` | a fragment of a `compose` prompt (below) |
| `{{open.length}}` | a variable declared with `@let` in a template (below) |

In a playbook written in the handler or in a prompt file used directly as a playbook, `{{args.x}}` and
`{{state.x}}` are filled in. Everything else (`user`, `phase`, conditions, tool calls) is available inside
`compose` prompts, explained next.

To write braces literally in a Markdown fragment, escape them: `\{{not a placeholder}}`.

## `compose`: prompts with logic

A `compose` prompt is a template, evaluated every time the agent thinks. It includes other prompts
(**fragments**) and shows or hides parts depending on the phase, the user, what failed, or the state of
the work. This is how the agents of the Koi CLI are written:

```python
import CoreIdentity: prompt from "./common/core-identity.md"
import CommunicationRules: prompt from "./common/communication-rules.md"
import BlockedResultHandling: prompt from "./common/blocked-result-handling.md"

prompt SystemPrompt = compose {

  fragments: {
    coreIdentity: CoreIdentity,
    communicationRules: CommunicationRules,
    blockedResultHandling: BlockedResultHandling
  }

  template: """
@let taskResult = tool('task_list').call()
@let pendingCount = taskResult?.tasks?.filter(t => t.status === 'pending')?.length || 0

# Assistant

{{coreIdentity}}
---
{{communicationRules}}
---
@if (recentFailure) {
{{blockedResultHandling}}
---
}

@if (phase.name == 'routing') {
Decide who does the work: answer trivial questions yourself, delegate the rest.
@if (pendingCount > 0) {
There are {{pendingCount}} pending tasks: finish them before starting anything new.
}
}

@if (phase.name == 'running_plan') {
@if (user.interactive) {
When everything is done, hand control back to the user.
} @else {
When everything is done, call `return` with a summary.
}
}
"""
}

agent System : Coordinator {
  ...
  on prompt_user(args: Json) {
    playbook SystemPrompt
  }
}
```

### Template syntax

One directive per line:

| Syntax | Meaning |
|---|---|
| `{{fragment}}` | insert a fragment |
| `{{expr}}` | insert any JavaScript expression: `{{args.topic}}`, `{{tasks.length}}`, `{{(task?.subject \|\| '')}}` |
| `@let name = expr` | a variable for the rest of the template; any JavaScript expression |
| `@if (cond) {` ... `}` | a block shown only when `cond` is true; any JavaScript condition (`==`, `&&`, `!`, ...) |
| `} @else {` | the alternative, on the line that closes the `@if` |
| `@else if (cond) {` | another alternative, on the line after the closing `}` |
| `tool('name').call(args)` | call a tool while building the prompt: `tool('task_list').call()`, `tool('task_get').call({ taskId: args.taskId })` |

Blocks can be nested. Variables available in a template:

| Variable | Contents |
|---|---|
| `args` | the handler's arguments |
| `state` | the agent's state |
| `phase` | `phase.name`, `phase.is('x')`, `phase.in('a', 'b')` (see [Phases](07-phases-and-transitions.md)) |
| `user` | `user.message`, `user.language`, `user.interactive` (false when called from code) |
| `recentFailure` | true while the agent is reacting to an action that failed in this turn |
| `agentName` | the agent's name |
| a team member's key | e.g. `planner.result` (`{ success, data }`) right after it returns (see [Teams](04-teams-and-delegation.md)) |

### Conditions inside a Markdown fragment

A Markdown file used as a **fragment** of a `compose` can have conditions too, with a simpler syntax:
`@let name = path`, `@if (path) { ... }` (shown when the value exists and is not empty) and `{{path}}`, where
a path is a dotted name like `user.language`. No operators, no `@else`, no nesting: for logic, put it in the
`compose` template. From the Koi CLI's `communication-rules.md`:

```markdown
### Language
Write all user-facing output in the user's language.
@if (user.language) {

Default to **{{user.language}}** until a longer user message in another language overrides it.
}
```

### Sharing a template between files

A `compose` prompt marked `export` can be imported by name from another `.koi` file. With `compose()` it
receives the same `args` and context as the agent that uses it:

```python
// common/assigned-task.koi
import AssignedTaskRules: prompt from "./assigned-task-rules.md"

export prompt AssignedTask = compose() {
  fragments: {
    assignedTaskRules: AssignedTaskRules
  }
  template: """
@let myTask = tool('my_task').call()
@if (myTask && myTask.id) {
{{assignedTaskRules}}
**Your assigned task (id: {{myTask.id}}):** {{myTask.subject}}
**Description:** {{myTask.description}}
}
@else if (args && args.description) {
{{assignedTaskRules}}
Your task: {{args.description}}
}
@else {
No task was given: call `return` with { success: false, reason: "No task description" }.
}
"""
}
```

```python
// core/team.koi
import AssignedTask: prompt from "./../common/assigned-task.koi"

prompt WorkerPlaybook = compose {
  fragments: {
    assignedTask: AssignedTask
  }
  template: """
{{assignedTask}}
Do the task, check your work, and call `return`.
"""
}
```

### Why it matters

The agent only sees what applies right now. Rules that only matter after a failure, or in one phase, cost
nothing the rest of the time; and the parts of the template that never change are cached by the model
provider, so a long, stable prompt is cheap to send again.

### Names

Agents, prompts, teams and skills share one namespace: `prompt Support` and `agent Support` in the same
program is an error. A common convention is `SupportPlaybook` for the agent `Support`.

Next: [Teams and delegation](04-teams-and-delegation.md).
