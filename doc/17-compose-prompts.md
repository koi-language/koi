# Compose Prompts

**Dynamic, deterministic prompt assembly with template directives.** 🧩

Compose prompts let you build complex system prompts that pull in runtime data (task lists, screen state, action history), include fragments conditionally, and adapt to context — all without involving an LLM at compile time.

## Table of Contents

- [Why Compose?](#why-compose)
- [Basic Structure](#basic-structure)
- [Fragments](#fragments)
- [Template Directives](#template-directives)
  - [Plain Text](#plain-text)
  - [Fragment Insertion (`\`fragmentName\``)](#fragment-insertion)
  - [Variable Binding (`@let`)](#variable-binding-let)
  - [Conditionals (`@if` / `@else if` / `@else`)](#conditionals)
  - [Interpolation (`{{expr}}`)](#interpolation)
- [Built-in Context Variables](#built-in-context-variables)
- [Image Support](#image-support)
- [Complete Example](#complete-example)
- [How It Works](#how-it-works)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Why Compose?

Regular prompts (`prompt Name = """..."""`) are **static text**. They work great for instructions that never change. But sometimes your system prompt needs to:

- Include data fetched at runtime (task lists, screen state, action history)
- Show or hide sections based on conditions
- Combine multiple prompt fragments in a specific order
- Attach images (e.g., mobile screenshots) alongside text

**Before compose** you had two options: write everything inline (messy) or rely on an LLM to generate the resolver at build time (unreliable, non-deterministic, cache-dependent).

**Compose prompts** solve this with a lightweight template syntax that compiles directly to JavaScript — no LLM involved, fully deterministic, works even with `--no-cache`.

---

## Basic Structure

```koi
export prompt MyPlaybook = compose {
  fragments: {
    instructions: InstructionsPrompt,
    rules: RulesPrompt
  }

  template: """
  `instructions`

  @let data = callAction('task_list')

  @if (data?.tasks?.length > 0) {
    You have {{data.tasks.length}} tasks to complete.
  }

  `rules`
  """
}
```

A compose block has two parts:

| Part | Purpose |
|------|---------|
| `fragments` | Named references to other prompt constants |
| `template` | Template string with directives that assembles the final prompt |

The `template` string is where the magic happens — it uses **template directives** to control what ends up in the final system prompt.

---

## Fragments

Fragments are named references to other prompts declared elsewhere in your `.koi` file (or imported):

```koi
export prompt Greeting = """
Hello! I am your assistant.
"""

export prompt Safety = """
Never share personal information.
"""

export prompt Assistant = compose {
  fragments: {
    greeting: Greeting,
    safety: Safety
  }

  template: """
  `greeting`
  `safety`
  Now help the user with their request.
  """
}
```

Inside `template`, insert a fragment with backtick-wrapped names: `` `greeting` ``, `` `safety` ``. The fragment's full text replaces the reference at runtime.

---

## Template Directives

### Plain Text

Any line that isn't a directive is included as-is in the final prompt:

```koi
template: """
This is plain text.
It goes directly into the system prompt.
Multiple lines are fine.
"""
```

Consecutive plain text lines are grouped together as a single block.

---

### Fragment Insertion

**Syntax:** `` `fragmentName` ``

Inserts the full content of a named fragment:

```koi
template: """
`instructions`

Some text in between.

`rules`
"""
```

The fragment name must match a key declared in the `fragments` block. Fragment references must appear **on their own line** (not mixed with other text on the same line).

---

### Variable Binding (`@let`)
```koi
export prompt MyPlaybook = compose {
  fragments: {
    instructions: InstructionsPrompt,
    rules: RulesPrompt
  }

  template: """
  `instructions`

  @let history = callAction('action_history', { count: 15 })
  """
}
```

#### Available actions

| Action | Parameters | Returns |
|--------|-----------|---------|
| `task_list` | — | `{ tasks: [...], summary: { total, pending, in_progress, completed, blocked } }` |
| `action_history` | `{ count: N }` | `{ summary: string, total: number, step: number }` |
| `frame_server_state` | `{ precision: "low"\|"medium"\|"high"\|"full" }` | `{ screenshot: base64, mimeType: string, elements: string, elementCount: number }` or `null` |

You can use `@let` results in `@if` conditions and `{{interpolations}}` later in the template.

#### Automatic image collection

When `@let` calls `frame_server_state`, the transpiler automatically generates code to collect the screenshot as an image attachment. You don't need to handle this manually — the resolver returns `{ text, images }` when images are present.

---

### Conditionals

#### `@if`

**Syntax:** `@if (expression) { ... }`

Conditionally includes a block of content. The expression is passed through to JavaScript as-is, so you can use any valid JS expression:

```koi
template: """
@let taskResult = callAction('task_list')

@if (taskResult?.tasks?.length > 0) {
  You have pending tasks. Focus on completing them.
  `taskPrompt`
}
"""
```

#### `@else`

**Syntax:** `} @else { ... }`

Alternative block when the condition is false:

```koi
template: """
@let taskResult = callAction('task_list')

@if (taskResult?.tasks?.some(t => t.status === 'pending')) {
  `hasTasksPrompt`
}
@else {
  `noTasksPrompt`
}
"""
```

#### `@else if`

**Syntax:** `} @else if (expression) { ... }`

Chain multiple conditions:

```koi
template: """
@let taskResult = callAction('task_list')
@let pending = taskResult?.summary?.pending || 0
@let inProgress = taskResult?.summary?.in_progress || 0

@if (pending > 0) {
  There are {{pending}} pending tasks. Start working on them.
}
@else if (inProgress > 0) {
  All tasks are in progress. Continue your current work.
}
@else {
  All tasks are complete. Ask the user what to do next.
}
"""
```

#### Formatting rules

- The opening `{` must be on the **same line** as `@if`, `@else if`, or `@else`.
- The closing `}` must be on its **own line**.
- `@else` and `@else if` go on the line **immediately after** the closing `}`.

```
✅ Correct:

@if (condition) {
  content
}
@else {
  other content
}


❌ Wrong — opening brace on next line:

@if (condition)
{
  content
}


❌ Wrong — else on same line as closing brace:

@if (condition) {
  content
} @else {
  other content
}
```

---

### Interpolation

**Syntax:** `{{expression}}`

Inserts the string value of a JavaScript expression. Property access is automatically converted to optional chaining for safety (`.` becomes `?.`):

```koi
template: """
@let history = callAction('action_history', { count: 10 })
@let taskResult = callAction('task_list')

Last actions: {{history.summary}}

Total tasks: {{taskResult.summary.total}}
"""
```

The template `{{history.summary}}` compiles to `String(history?.summary ?? '')` — so if `history` is `null`, it safely produces an empty string instead of throwing.

> **Note:** The `?.` auto-conversion only applies inside `{{...}}` interpolations. In `@if` and `@let` expressions, write optional chaining explicitly when needed: `@if (result?.tasks?.length > 0)`.

---

## Built-in Context Variables

Every compose resolver has access to these variables automatically — no `@let` needed:

| Variable | Type | Description |
|----------|------|-------------|
| `args` | `Object` | Handler arguments from the delegation. Typically contains `args.goal` with the user's task instruction. |
| `state` | `Object` | The agent's persistent state object. Survives across iterations of the reactive loop. |
| `agentName` | `String` | The name of the agent executing this prompt (e.g., `"System"`, `"MobileNavigator"`). |
| `userMessage` | `String \| null` | The user's most recent input. See details below. |

### `args` — Handler arguments

Contains whatever was passed when the agent's handler was invoked. For delegated agents, this typically has a `goal` field:

```koi
template: """
Your task: {{args.goal}}

`instructions`
"""
```

### `state` — Agent state

Access the agent's persistent state. Useful for agents that track progress across iterations:

```koi
template: """
@if (state.retryCount > 3) {
  You have retried multiple times. Try a completely different approach.
}
"""
```

### `agentName` — Agent name

```koi
template: """
You are the {{agentName}} agent.
"""
```

### `userMessage` — Latest user input

This is the key variable for knowing **what the user just typed**. Its value depends on the current turn:

| Turn | `userMessage` value |
|------|-------------------|
| First turn (delegation) | Falls back to `args.goal` (the original task) |
| After `prompt_user` | The user's response (e.g., `"Yes, go ahead"`) |
| Autonomous iterations | `null` (the agent is acting without user input) |

`userMessage` is **only non-null on the turn the user actually typed something**. It resets to `null` after the compose resolver consumes it.

```koi
template: """
`baseInstructions`

@if (userMessage) {
  The user just provided new input. Consider their message carefully
  and adjust your approach accordingly.
}
"""
```

This is different from `args.goal`, which always contains the original delegation task and never changes.

---

## Image Support

Compose prompts can return multimodal content (text + images). This happens automatically when you call `frame_server_state`:

```koi
template: """
`navigationPrompt`

@let screen = callAction('frame_server_state', { precision: 'high' })

@if (screen) {
  ## Current Screen Elements
  {{screen.elements}}

  A screenshot is attached for visual reference.

  `interactionRules`
}
"""
```

When `frame_server_state` returns a screenshot, the transpiler automatically:
1. Extracts `screen.screenshot` and `screen.mimeType`
2. Adds them to the image array
3. Returns `{ text, images }` instead of plain text

The runtime injects these images into the LLM call alongside the system prompt.

---

## Complete Example

Here's a real-world compose prompt from a mobile navigation agent:

```koi
export prompt MainPrompt = """
# Mobile Navigator Agent

You are a mobile navigation agent that interacts with iOS Simulator
and Android Emulator apps. Follow the observe-think-act loop.

## Rules
- Always verify the correct app is active before interacting
- Batch actions aggressively to minimize LLM calls
- Never claim success without visual verification
"""

export prompt InteractionRules = """
## Interaction Rules

Return ONLY valid JSON actions. Do NOT describe or explain.

{ "actionType": "direct", "intent": "mobile_tap", "element": "Calendar" }
"""

export prompt NavigatorPlaybook = compose {
  fragments: {
    mainPrompt: MainPrompt,
    interactionRules: InteractionRules
  }

  template: """
  `mainPrompt`

  Your task: {{args.goal}}

  LAST 15 ACTIONS:

  @let lastActions = callAction('action_history', { count: 15 })

  {{lastActions.summary}}
  Review the action history to detect loops and change strategy if stuck.

  @let frameState = callAction('frame_server_state', { precision: 'high' })
  @if (frameState) {

  ## Current Mobile Elements

  {{frameState.elements}}

  A screenshot of the current screen is attached.

  `interactionRules`

  }
  """
}

agent MobileNavigator : MobileNavigator {
  on navigate(args: Json) {
    playbook NavigatorPlaybook
  }
}
```

This produces a system prompt that:
1. Always includes `MainPrompt`
2. Shows the user's goal from `args.goal`
3. Fetches and displays the last 15 actions
4. Conditionally includes screen elements and interaction rules (only when the frame server is running)
5. Attaches a screenshot image to the LLM call

---

## How It Works

Compose templates are compiled **at transpile time** (not by an LLM) into a deterministic JavaScript resolver function. No cache, no LLM call, no non-determinism.

### Compilation

The Koi transpiler scans the `template` string and generates JavaScript:

| Template | Generated JavaScript |
|----------|---------------------|
| Plain text `"Hello"` | `__parts.push("Hello");` |
| `` `fragment` `` | `__parts.push(fragments.fragment);` |
| `@let x = callAction(...)` | `const x = await callAction(...);` |
| `@if (expr) {` | `if (expr) {` |
| `@else if (expr) {` | `} else if (expr) {` |
| `@else {` | `} else {` |
| `}` | `}` |
| `{{expr}}` | `__parts.push(String(expr ?? ''));` |

### Generated resolver

The transpiler wraps everything into an async resolver function:

```javascript
const MyPlaybook = {
  __isCompose__: true,
  fragments: { instructions: InstructionsPrompt, rules: RulesPrompt },
  resolve: async (fragments, callAction, context) => {
    const { args, state, agentName, userMessage } = context || {};
    const __parts = [];
    const __images = [];
    // ... compiled template segments ...
    const __text = __parts.filter(Boolean).join('\n');
    return __images.length > 0 ? { text: __text, images: __images } : __text;
  }
};
```

### Execution

The resolver runs **before every LLM call** in the reactive loop. This means:
- Task lists are always fresh
- Screen state is always current
- `userMessage` reflects the latest user input
- Conditional sections adapt to runtime state

### No cache dependency

Unlike LLM-generated resolvers, directive-compiled resolvers:
- Work with `--no-cache`
- Produce identical output every time for the same inputs
- Don't require any API key at compile time
- Are visible in the transpiled output for debugging

---

## Best Practices

### ✅ Use optional chaining in `@if` and `@let`

Actions can return `null`. Always guard property access:

```koi
// ✅ Good
@let result = callAction('task_list')
@if (result?.tasks?.length > 0) {

// ❌ Bad — crashes if result is null
@let result = callAction('task_list')
@if (result.tasks.length > 0) {
```

> Inside `{{...}}` interpolations, `.` is automatically converted to `?.` — but in `@if` and `@let` expressions you must write `?.` yourself.

### ✅ Keep fragments focused

Each fragment should be a self-contained block of instructions:

```koi
// ✅ Good — each fragment has one responsibility
export prompt Navigation = """..."""
export prompt Safety = """..."""
export prompt OutputFormat = """..."""
```

### ✅ Use `userMessage` for reactive prompts

```koi
// ✅ Good — adapts to user input
@if (userMessage) {
  The user just said: {{userMessage}}
  Address their input before continuing.
}
```

### ❌ Don't put complex logic in templates

Keep expressions simple. If you need complex data transformations, create a dedicated action:

```koi
// ❌ Avoid — too complex for a template
@let filtered = callAction('task_list')
@if (filtered?.tasks?.filter(t => t.status === 'pending' && !t.blockedBy?.some(id => ...)).length > 0) {

// ✅ Better — let the action handle complexity
@let pending = callAction('pending_unblocked_tasks')
@if (pending?.length > 0) {
```

### ❌ Don't use `@let` for values you won't use

Every `@let` with `callAction` is a runtime call. Only fetch what you need:

```koi
// ❌ Wasteful
@let screen = callAction('frame_server_state', { precision: 'full' })
@let tasks = callAction('task_list')
@let history = callAction('action_history', { count: 50 })

// ✅ Only fetch what you'll use
@let tasks = callAction('task_list')
```

---

## Troubleshooting

### "Resolver error ... falling back to LLM"

This means the compiled resolver threw a runtime error. Common causes:

| Error | Cause | Fix |
|-------|-------|-----|
| `X.some is not a function` | Action returned an object, not an array | Check the action's return type. `task_list` returns `{ tasks: [...] }`, not `[...]`. Use `result.tasks.some(...)`. |
| `Cannot read property of null` | Action returned `null` | Use optional chaining: `result?.property` |
| `X is not a function` | Typo in action name or wrong `callAction` usage | Check action name spelling and parameter format |

Run with `--debug` to see the full stack trace.

### Template not updating

Compose templates compile at transpile time. If you change a `.koi` file, the changes take effect immediately on the next run — no cache clearing needed.

### Fragments showing as empty

Ensure the fragment prompt is declared **before** the compose block in the file (or imported). Fragment names in the `fragments:` block must match the backtick references in `template:` exactly.

### `userMessage` is always `null`

`userMessage` is only set when:
1. It's the first turn (falls back to `args.goal`)
2. The agent called `prompt_user` and the user responded

On autonomous iterations (where the LLM acts without user input), `userMessage` is `null` by design.
