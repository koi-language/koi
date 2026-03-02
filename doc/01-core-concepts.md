# Core Concepts

Understanding Koi's core concepts will help you design elegant multi-agent systems. This guide explains the fundamental building blocks and the philosophy behind them.

## Table of Contents

- [Philosophy](#philosophy)
- [Roles](#roles)
- [Agents](#agents)
- [Teams](#teams)
- [Skills](#skills)
- [Orchestration](#orchestration)
- [Design Patterns](#design-patterns)

## Philosophy

Koi is built on several key principles:

### 1. Agent-First

Everything is an agent. No complex class hierarchies, just agents that do AI-powered work:

```koi
Agent DataAnalyzer : WorkerRole {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on analyze(args: Json) {
    playbook """
    Analyze the following data and extract key insights:
    {{args.data}}

    Provide:
    1. Summary of main findings
    2. Any anomalies or patterns detected
    3. Recommendations

    Return as JSON: { summary, anomalies, recommendations }
    """
  }
}
```

The agent uses natural language to describe what to do - the AI figures out how.

### 2. Role-Based, Not Name-Based

You route by WHAT an agent can do (role), not WHO they are (name):

```koi
// ✅ Good: Route by role
await send peers.event("process").role(Worker).any()(data)

// ❌ Bad: Hardcode agent names
await send SpecificAgent.process(data)
```

This makes systems flexible and maintainable.

### 3. Compose, Don't Configure

Agents compose naturally without verbose configuration:

```koi
Team DataPipeline {
  validator = Validator
  transformer = Transformer
  loader = Loader
}
```

No dependency injection frameworks, no XML configs. Just composition.

### 4. Natural Language = Code

Playbooks let you write logic in natural language:

```koi
Agent Analyst : Worker {
  on analyze(args: Json) {
    playbook """
    Analyze the sentiment of: {{args.text}}
    Return JSON: { sentiment: "positive|neutral|negative", score: 0-1 }
    """
  }
}
```

The LLM executes this as if it were code.

## Roles

**Roles** define abstract capabilities, not implementations.

### Defining a Role

```koi
role Worker { can execute, can process }
role Reviewer { can critique, can approve }
role Lead { can delegate, can decide }
```

Capabilities are just strings. They're documentation for humans and routing hints for the system.

### Why Roles?

Roles enable **polymorphism without inheritance**:

```koi
// Any agent with Worker role can handle this
await send peers.event("process").role(Worker).any()(data)
```

Multiple agents can satisfy the request:
- `DataProcessor : Worker` - processes data
- `FileHandler : Worker` - processes files
- `APIAgent : Worker` - processes API calls

The system picks one based on availability and semantic matching.

### Role Composition

Agents can have multiple roles (not currently supported, roadmap feature):

```koi
// Future feature
Agent LeadProcessor : Lead, Worker {
  // Can both delegate AND execute
}
```

## Agents

**Agents** are the workers. They have:
- A **role** (what they can do)
- **Handlers** (event processors)
- **State** (optional)
- **Skills** (reusable capabilities)
- **Team** (peers to delegate to)

### Basic Agent

```koi
Agent Counter : Worker {
  on increment(args: Json) {
    return { count: 1 }
  }
}
```

### Agent with State

```koi
Agent StatefulCounter : Worker {
  state = { count: 0 }

  on increment(args: Json) {
    this.state.count = this.state.count + 1
    return { count: this.state.count }
  }

  on get(args: Json) {
    return { count: this.state.count }
  }
}
```

### Agent with Playbook

```koi
Agent Assistant : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on help(args: Json) {
    playbook """
    User question: {{args.question}}
    Answer helpfully and concisely.
    """
  }
}
```

See [Agents Guide](03-agents.md) for full details.

## Teams

**Teams** are collections of agents that can work together.

### Defining a Team

```koi
Team DataPipeline {
  validator = Validator
  transformer = Transformer
  loader = Loader
}
```

### Using a Team

```koi
Agent Orchestrator : Lead {
  uses Team DataPipeline

  on process(args: Json) {
    // Send to any Worker in the team
    const result = await send peers.event("validate").role(Worker).any()(args)
    return result
  }
}
```

The keyword `peers` refers to the team members.

### Team vs Direct Reference

```koi
// ❌ Tightly coupled
const result = await Validator.handle("validate", args)

// ✅ Loosely coupled
const result = await send peers.event("validate").role(Worker).any()(args)
```

The second approach:
- Works with ANY agent that can validate
- Doesn't break if you swap implementations
- Supports automatic routing

See [Roles & Teams](04-roles-and-teams.md) for more.

## Skills

**Skills** are reusable capabilities with encapsulated logic and internal agents.

### Why Skills?

Skills let you package functionality that can be reused across agents:

```koi
Skill SentimentAnalysis {
  affordance """
  Analyzes text sentiment and returns positive/neutral/negative.
  """

  Agent Analyst : Worker {
    on analyze(args: Json) {
      playbook """
      Analyze sentiment of: {{args.text}}
      Return { sentiment, score, rationale }
      """
    }
  }

  Team Internal {
    analyst = Analyst
  }

  export async function run(input: any): Promise<any> {
    const result = await send Internal.event("analyze").role(Worker).any()(input)
    return result
  }
}
```

### Using a Skill

```koi
Agent ReviewAgent : Worker {
  uses Skill SentimentAnalysis

  on analyzeReview(args: Json) {
    const sentiment = await this.callSkill('SentimentAnalysis', { text: args.review })
    return sentiment
  }
}
```

Skills can contain:
- Multiple agents
- Internal teams
- Complex logic
- Their own state

See [Skills Guide](05-skills.md) for details.

## Orchestration

Koi provides **automatic orchestration** - you don't need to manually route messages.

### Traditional Approach (Manual)

```koi
Agent ManualOrchestrator : Lead {
  on process(args: Json) {
    // I need to know all the agents and their methods
    const validated = await Validator.handle("validate", args)
    const transformed = await Transformer.handle("transform", validated)
    const loaded = await Loader.handle("load", transformed)
    return loaded
  }
}
```

Problems:
- Hardcoded agent names
- Breaks when you change agents
- Not reusable

### Koi Approach (Automatic)

```koi
Agent Assistant : Worker {
  on help(args: Json) {
    playbook """
    Request: {{args.request}}
    Accomplish this task.
    """
  }
}

run Assistant.help({ request: "Validate and transform data" })
```

What happens:
1. LLM reads the request
2. LLM decomposes into actions: `[{ validate }, { transform }]`
3. System routes each action to appropriate agent
4. Results chain automatically

See [Automatic Routing](07-routing.md) and [Task Chaining](08-task-chaining.md).

## Design Patterns

### Pattern 1: Single-Purpose Agents

Keep agents focused:

```koi
// ✅ Good: Each agent does one thing well
Agent Validator : Worker {
  on validate(args: Json) { /* ... */ }
}

Agent Transformer : Worker {
  on transform(args: Json) { /* ... */ }
}

// ❌ Bad: God agent doing everything
Agent Processor : Worker {
  on validate(args: Json) { /* ... */ }
  on transform(args: Json) { /* ... */ }
  on load(args: Json) { /* ... */ }
  on analyze(args: Json) { /* ... */ }
  on report(args: Json) { /* ... */ }
}
```

### Pattern 2: Role-Based Routing

Route by capability, not identity:

```koi
// ✅ Good: Flexible routing
await send peers.event("process").role(Worker).any()(data)

// ❌ Bad: Brittle routing
await SpecificWorker.handle("process", data)
```

### Pattern 3: Playbooks for Complex Logic

Use playbooks when logic is hard to express in code:

```koi
Agent Analyst : Worker {
  // ✅ Good: Natural language for open-ended tasks
  on analyze(args: Json) {
    playbook """
    Analyze this data and identify patterns: {{args.data}}
    Focus on anomalies and trends.
    """
  }

  // ✅ Good: Code for deterministic tasks
  on calculateSum(args: Json) {
    const sum = args.numbers.reduce((a, b) => a + b, 0)
    return { sum: sum }
  }
}
```

### Pattern 4: Skills for Reusability

Package related functionality into skills:

```koi
// ✅ Good: Reusable skill
Skill DataValidation {
  Agent Validator { /* ... */ }
  Agent Sanitizer { /* ... */ }
  export async function run(input) { /* ... */ }
}

// Use across multiple agents
Agent A {
  uses Skill DataValidation
}

Agent B {
  uses Skill DataValidation
}
```

### Pattern 5: Teams for Collaboration

Group related agents:

```koi
Team Analytics {
  sentiment = SentimentAnalyzer
  topic = TopicExtractor
  summary = Summarizer
}

Agent AnalyticsOrchestrator : Lead {
  uses Team Analytics

  on analyze(args: Json) {
    // All analytics agents are available via peers
  }
}
```

## Comparison: Koi vs Traditional

| Aspect | Traditional OOP | Koi |
|--------|----------------|-----|
| Building Block | Class | Agent |
| Composition | Inheritance | Role + Team |
| Communication | Method calls | Event handlers |
| Routing | Hardcoded | Automatic |
| Logic | Code | Code OR Playbook |
| Reusability | Abstract classes | Skills |
| Testing | Mocking | Agent substitution |

## Mental Model

Think of Koi programs as **organizations of workers**:

```
Organization (Program)
│
├── Roles (Job descriptions)
│   ├── Worker
│   ├── Reviewer
│   └── Lead
│
├── Agents (People)
│   ├── Alice (Worker)
│   ├── Bob (Reviewer)
│   └── Carol (Lead)
│
├── Teams (Departments)
│   ├── Development { Alice, Bob }
│   └── Management { Carol }
│
└── Skills (Training programs)
    ├── DataAnalysis
    └── ProjectManagement
```

- **Roles** = Job descriptions ("can execute", "can review")
- **Agents** = People who fill those roles
- **Teams** = Departments where people collaborate
- **Skills** = Specialized training/capabilities

When you need something done, you ask "Who can [do this]?" not "Is Alice available?"

## Key Takeaways

1. **Roles** define capabilities abstractly
2. **Agents** implement those capabilities concretely
3. **Teams** enable collaboration without tight coupling
4. **Skills** package reusable functionality
5. **Orchestration** happens automatically via routing and planning
6. **Playbooks** turn natural language into executable logic

## What's Next?

Now that you understand the concepts, explore the specifics:

- **[Syntax Basics](02-syntax-basics.md)** - Variables, types, control flow
- **[Agents Guide](03-agents.md)** - Creating and using agents
- **[Roles & Teams](04-roles-and-teams.md)** - Deep dive into role-based systems
- **[Skills Guide](05-skills.md)** - Building reusable capabilities

---

**Next**: [Syntax Basics](02-syntax-basics.md) →
