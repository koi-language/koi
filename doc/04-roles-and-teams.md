# Roles & Teams

Learn how to use Roles and Teams to build composable multi-agent systems.

## Roles

Roles define abstract capabilities:

```koi
role Worker { can execute, can process }
role Reviewer { can critique, can approve }
role Lead { can delegate, can decide }
```

Agents implement roles:

```koi
Agent DataProcessor : Worker {
  on process(args: Json) {
    return { result: "processed" }
  }
}
```

## Teams

Teams group related agents:

```koi
Team DataPipeline {
  validator = Validator
  transformer = Transformer
  loader = Loader
}
```

## Using Teams

```koi
Agent Orchestrator : Lead {
  uses Team DataPipeline

  on process(args: Json) {
    // Send to any Worker in team
    const result = await send peers.event("validate").role(Worker).any()(args)
    return result
  }
}
```

**Key concept**: `peers` refers to team members.

## Peer Syntax

```koi
send peers.event("eventName").role(RoleName).any()(data) timeout 30s
```

- `.event("name")` - Event to send
- `.role(Role)` - Filter by role
- `.any()` - Pick any matching agent
- `(data)` - Arguments
- `timeout 30s` - Optional timeout

## Why Roles?

Roles enable **flexible routing**:

```koi
// ✅ Flexible: works with ANY Worker
await send peers.event("process").role(Worker).any()(data)

// ❌ Brittle: tied to specific agent
await SpecificAgent.handle("process", data)
```

## Best Practices

1. **Single responsibility roles**: Each role represents one capability
2. **Descriptive capabilities**: Use clear names like "can execute", "can validate"
3. **Role-based routing**: Route by role, not by agent name
4. **Team composition**: Group related agents into teams

## See Also

- **[Core Concepts](01-core-concepts.md)** - Philosophy behind roles and teams
- **[Agents Guide](03-agents.md)** - Creating agents with roles
- **[Automatic Routing](07-routing.md)** - Intelligent agent selection

---

**Next**: [Skills Guide](05-skills.md) →
