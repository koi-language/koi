# Automatic Routing

Koi provides intelligent automatic routing - ANY agent can receive complex tasks and automatically delegate to appropriate team members.

## Key Concept

**No special orchestrator needed!** Any agent can:
1. Decompose complex tasks into sub-tasks
2. Resolve each sub-task through cascading logic
3. Automatically route to appropriate agents

## How It Works

When an agent receives a complex task:
1. **LLM decomposes** it into actions
2. **Each action** tries cascading resolution:
   - Can I handle it myself? (own handlers)
   - Do I have a skill? (local skills)
   - Can I execute directly? (simple tasks)
   - Can a team member handle it? (semantic routing)

## Example

```koi
Agent Assistant : Worker {
  on help(args: Json) {
    playbook """
    User request: {{args.request}}
    Help accomplish this request.
    """
  }
}

run Assistant.help({
  request: "Validate the email user@test.com and translate it to French"
})
```

The Assistant doesn't know about Validator or Translator agents. The system:
1. Decomposes into: `[{ validate email }, { translate to french }]`
2. Routes "validate email" → Validator agent
3. Routes "translate to french" → Translator agent

## Semantic Matching

The router uses:
- **Embeddings** for similarity matching
- **LLM disambiguation** when needed
- **High confidence threshold** for automatic routing

## Benefits

✅ Zero boilerplate
✅ Composable (any agent can delegate)
✅ Intelligent (understands synonyms)
✅ Scalable (adding agents = automatic availability)

For complete details, see the original [AUTO_ROUTING_GUIDE.md](../AUTO_ROUTING_GUIDE.md) in the root directory.

---

**Next**: [Task Chaining](08-task-chaining.md) →
