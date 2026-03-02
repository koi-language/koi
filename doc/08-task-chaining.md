# Task Chaining

Automatic output-to-input chaining where the result of one task becomes the input to the next.

## How It Works

The LLM plans tasks with references to previous results:

```json
{
  "actions": [
    { "intent": "translate to french", "data": { "text": "hello" } },
    { "intent": "count words", "data": { "text": "{{previousResult.translated}}" } }
  ]
}
```

The runtime:
1. Executes action 1: `{ translated: "bonjour" }`
2. Resolves `{{previousResult.translated}}` → `"bonjour"`
3. Executes action 2 with resolved input

## Example

```koi
Agent Assistant : Worker {
  on help(args: Json) {
    playbook """
    Request: {{args.request}}
    Accomplish this task.
    """
  }
}

run Assistant.help({
  request: "Translate 'hello' to French and count the words"
})
```

Flow:
1. Translate → `{ translated: "bonjour" }`
2. Count words on "bonjour" → `{ wordCount: 1 }`

## Reference Syntax

Access previous results:

```koi
{{previousResult.field}}        // Last result
{{results[0].field}}            // Specific result
{{field}}                       // Shorthand for last result
```

## Benefits

✅ Automatic data flow
✅ Declarative (describe WHAT, not HOW)
✅ Flexible references
✅ Clear logs

For complete details, see [TASK_CHAINING_GUIDE.md](../TASK_CHAINING_GUIDE.md) in the root directory.

---

**Next**: [Planning System](09-planning.md) →
