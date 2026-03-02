# Agents Guide

Agents are the workers in Koi. This guide covers creating agents with playbooks (the primary way), and procedural code (only when necessary).

## Table of Contents

- [What is an Agent?](#what-is-an-agent)
- [Playbooks: The Primary Way](#playbooks-the-primary-way)
- [LLM Configuration](#llm-configuration)
- [When to Use Procedural Code](#when-to-use-procedural-code)
- [Event Handlers](#event-handlers)
- [State Management](#state-management)
- [Agent Memory](#agent-memory)
- [Private Handlers](#private-handlers)
- [Exposing Handlers as MCP Tools](#exposing-handlers-as-mcp-tools)
- [Using Skills](#using-skills)
- [Using Teams](#using-teams)
- [Best Practices](#best-practices)

## What is an Agent?

An **Agent** is an autonomous worker that:
- Has a **role** (capabilities)
- Responds to **events** via handlers
- **Primarily uses playbooks** (natural language instructions)
- Can use **procedural code** (only when truly necessary)
- Can maintain **state**
- Can use **skills** (reusable capabilities)
- Can communicate with **peers** (team members)

**Key Philosophy**: Agents should primarily use **playbooks** (natural language) to describe what they do. Only use TypeScript/JavaScript code when you need to perform specific actions like downloading emails, fetching URLs, or other technical operations that can't be expressed naturally.

## Playbooks: The Primary Way

**Playbooks are the heart of Koi agents.** They let you write agent logic in natural language, which is then executed by an LLM.

### Your First Playbook Agent

```koi
Agent Assistant : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on help(args: Json) {
    playbook """
    User question: {{args.question}}

    Answer the question helpfully and concisely.
    Provide practical examples when relevant.
    """
  }
}

run Assistant.help({ question: "What is Koi?" })
```

**This is the recommended way to create agents!**

### Why Playbooks?

Playbooks are powerful because:
- **Natural**: Write in plain language, not code
- **Flexible**: Handle open-ended, creative tasks
- **Intelligent**: Leverage LLM reasoning and knowledge
- **Maintainable**: Easy to understand and modify
- **Composable**: Easily adapt to new requirements

### Playbook Syntax

Use triple-quoted strings with `{{variable}}` interpolation:

```koi
Agent Analyzer : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on analyze(args: Json) {
    playbook """
    Analyze the sentiment of this text: {{args.text}}

    Consider:
    - Overall tone (positive, neutral, negative)
    - Emotional intensity (scale 0-1)
    - Key emotional indicators

    Return JSON with:
    {
      "sentiment": "positive|neutral|negative",
      "score": 0.0-1.0,
      "emotions": ["joy", "sadness", etc],
      "rationale": "brief explanation"
    }
    """
  }
}
```

### Accessing Data in Playbooks

Use `{{...}}` to access arguments and state:

```koi
Agent ContentWriter : Worker {
  state = { style: "professional", audience: "developers" }

  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on writeArticle(args: Json) {
    playbook """
    Topic: {{args.topic}}
    Length: {{args.length}} words
    Style: {{this.state.style}}
    Audience: {{this.state.audience}}

    Write an engaging article on the topic.
    Match the specified style and speak directly to the audience.

    Return JSON:
    {
      "title": "...",
      "body": "article text here",
      "word_count": number,
      "key_points": ["point 1", "point 2", ...]
    }
    """
  }
}
```

### Complex Reasoning with Playbooks

Playbooks excel at tasks requiring judgment, creativity, or complex reasoning:

```koi
Agent ProblemSolver : Worker {
  llm default = { provider: "openai", model: "gpt-4o", temperature: 0.5 }

  on solve(args: Json) {
    playbook """
    Problem: {{args.problem}}

    Break down this problem into steps and solve it systematically:
    1. Identify the core challenge
    2. Consider different approaches
    3. Evaluate trade-offs
    4. Choose the best solution
    5. Explain your reasoning

    Return JSON:
    {
      "analysis": "your analysis of the problem",
      "steps": [
        { "step": 1, "description": "...", "reasoning": "..." },
        { "step": 2, "description": "...", "reasoning": "..." }
      ],
      "solution": "final solution",
      "confidence": 0.0-1.0
    }
    """
  }
}
```

### Automatic Planning and Decomposition

When you give a complex task to an agent, Koi's **automatic planning system** kicks in before execution:

**How it works**:

1. **Receive task**: Agent receives a playbook with a complex request
2. **Planning phase**: Before executing, the LLM analyzes the task and decomposes it into **atomic actions**
3. **Action generation**: Creates a list of concrete, executable actions
4. **Sequential execution**: Executes each action one by one
5. **Result chaining**: Output from each action becomes input for the next

**Example**:

```koi
Agent Assistant : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on help(args: Json) {
    playbook """
    Request: {{args.request}}
    Help accomplish this task.
    """
  }
}

run Assistant.help({
  request: "Analyze the sentiment of user reviews and summarize the findings"
})
```

**What happens internally**:

```
1. Planning Phase:
   LLM receives: "Analyze sentiment and summarize findings"
   LLM generates actions:
   [
     { "intent": "analyze sentiment", "data": { "reviews": "..." } },
     { "intent": "summarize findings", "data": { "sentiments": "{{previousResult}}" } }
   ]

2. Execution Phase:
   Action 1: Routes to SentimentAnalyzer → { sentiment: "mostly positive", scores: [...] }
   Action 2: Uses result from Action 1 → { summary: "Users are satisfied..." }

3. Return final result
```

**Key benefits**:

- **Zero manual orchestration**: You describe WHAT, not HOW
- **Intelligent routing**: Each action finds the right agent automatically
- **Automatic chaining**: Results flow between actions naturally
- **Adaptive**: LLM adjusts the plan based on context

**The planner creates atomic actions** - each action is a single, focused task that can be:
- Handled by the agent itself
- Delegated to a skill
- Routed to another team member

See [Planning System](09-planning.md) for complete details on how planning works.

## LLM Configuration

Configure the LLM that executes your playbooks:

### Default Configuration

Set default LLM for all handlers:

```koi
Agent Assistant : Worker {
  llm default = {
    provider: "openai",        // or "anthropic"
    model: "gpt-4o-mini",      // model name
    temperature: 0.7,          // creativity (0.0-2.0)
    max_tokens: 500            // max response length
  }

  on help(args: Json) {
    playbook """Your playbook here"""
  }
}
```

### Per-Handler Configuration

Override defaults for specific handlers:

```koi
Agent MultiModel : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  // Uses default (gpt-4o-mini)
  on quickTask(args: Json) {
    playbook """Quick task that doesn't need much reasoning"""
  }

  // Override: use gpt-4o for complex reasoning
  on complexTask(args: Json) {
    llm { provider: "openai", model: "gpt-4o", temperature: 0.3 }

    playbook """
    Complex task requiring deep reasoning and analysis.
    Consider multiple perspectives and edge cases.
    """
  }
}
```

### Recommended Models

| Model | Use Case | Cost | Speed |
|-------|----------|------|-------|
| `gpt-4o-mini` | Default choice | Very low | Fast |
| `gpt-4o` | Complex reasoning | Medium | Medium |
| `claude-3-5-haiku-20241022` | Budget option | Low | Very fast |
| `claude-3-5-sonnet-20241022` | High quality | Medium | Fast |

**Recommendation**: Start with `gpt-4o-mini`. It's fast, cheap, and handles most tasks well.

## When to Use Procedural Code

Use procedural code **only when you need to perform specific technical operations** that can't be expressed in natural language:

### ✅ Use Code For:

- **Downloading emails** from IMAP/POP3
- **Fetching URLs** with specific headers/authentication
- **File system operations** (reading, writing, moving files)
- **Database queries** with precise SQL
- **API calls** requiring specific REST/GraphQL formats
- **Data transformations** with exact algorithms
- **Mathematical calculations** that must be precise
- **Performance-critical operations**

### ❌ Don't Use Code For:

- Analysis tasks
- Content generation
- Decision making
- Classification
- Summarization
- Translation
- General reasoning

### Example: Procedural Code When Needed

```koi
Agent EmailFetcher : Worker {
  // Use code for technical email fetching
  on fetchEmails(args: Json) {
    const imap = new IMAP({
      user: args.email,
      password: args.password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true
    })

    const messages = await imap.fetch('INBOX', { since: args.since })
    return { messages: messages, count: messages.length }
  }
}

Agent EmailAnalyzer : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  // Use playbook for analysis
  on analyzeEmails(args: Json) {
    playbook """
    Emails: {{JSON.stringify(args.emails)}}

    Analyze these emails:
    - Categorize by topic
    - Identify urgent messages
    - Summarize key points
    - Suggest responses for important emails

    Return structured analysis.
    """
  }
}
```

### Example: Hybrid Agent

```koi
Agent DataProcessor : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  // Code: Fetch data from API
  on fetchData(args: Json) {
    const response = await fetch(args.url, {
      headers: { 'Authorization': `Bearer ${args.token}` }
    })
    const data = await response.json()
    return { data: data }
  }

  // Playbook: Analyze the data
  on analyzeData(args: Json) {
    playbook """
    Data: {{JSON.stringify(args.data)}}

    Analyze this data and identify:
    - Patterns and trends
    - Anomalies or outliers
    - Key insights
    - Recommendations
    """
  }

  // Code: Save results to database
  on saveResults(args: Json) {
    const db = connectToDatabase()
    await db.insert('results', args.results)
    return { saved: true, timestamp: Date.now() }
  }
}
```

## Event Handlers

Event handlers are functions that respond to events.

### Handler with Playbook

```koi
Agent Reviewer : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on reviewCode(args: Json) {
    playbook """
    Code: {{args.code}}
    Language: {{args.language}}

    Review this code for:
    - Correctness
    - Best practices
    - Potential bugs
    - Performance issues
    - Security concerns

    Provide constructive feedback.
    """
  }
}
```

### Handler with Code

```koi
Agent Calculator : Worker {
  on add(args: Json) {
    return { result: args.a + args.b }
  }

  on multiply(args: Json) {
    return { result: args.a * args.b }
  }
}
```

### Calling Handlers

```koi
// From outside
run Reviewer.reviewCode({ code: "...", language: "typescript" })

// From within agent
Agent Processor : Worker {
  on validate(args: Json) {
    // validation logic
    return { valid: true }
  }

  on process(args: Json) {
    const validation = await this.handle("validate", args)
    if (!validation.valid) {
      return { error: "Invalid input" }
    }
    // process...
  }
}
```

## State Management

Agents can maintain internal state:

```koi
Agent Counter : Worker {
  state = { count: 0, history: [] }

  on increment(args: Json) {
    this.state.count = this.state.count + 1
    this.state.history.push({ action: "increment", timestamp: Date.now() })
    return { count: this.state.count }
  }

  on getHistory(args: Json) {
    return { history: this.state.history }
  }
}
```

State is kept in memory during execution but NOT persisted between runs.

## Agent Memory

Agents automatically remember previous conversations. Each time an agent executes a playbook, the playbook input and the resulting output are stored as conversation history. On subsequent executions, this history is sent to the LLM as multi-turn messages, allowing the agent to recall what it has done before.

### How It Works

1. Agent executes a playbook and produces a result
2. The playbook text (user message) and the result (assistant message) are saved to the agent's memory
3. On the next execution, previous messages are included in the LLM call
4. The LLM can reference previous interactions naturally

```koi
Agent Assistant : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on chat(args: Json) {
    playbook """
    User says: {{args.message}}
    Respond naturally. You remember previous conversations.
    """
  }
}

// First call — no memory yet
run Assistant.chat({ message: "My name is Alice" })
// → "Hello Alice! Nice to meet you."

// Second call — agent remembers the first interaction
run Assistant.chat({ message: "What is my name?" })
// → "Your name is Alice!"
```

### Context Consumption

Memory is sent to the LLM as additional messages in every call. This means:

- **More memory = more tokens per call** — each stored interaction increases the prompt size
- **Cost increases** — longer prompts cost more with pay-per-token providers
- **Context window limits** — very long histories may approach the model's context limit

By default, agents keep up to **50 messages** in memory. When the limit is reached, older messages are discarded. You can configure this with `maxMemory` in the LLM configuration:

```koi
Agent Assistant : Worker {
  llm default = {
    provider: "openai",
    model: "gpt-4o-mini",
    maxMemory: 100          // Keep up to 100 messages
  }
}
```

### The `amnesia` Attribute

Some agents don't need memory — stateless workers, one-shot processors, or agents where each call should be independent. Use `amnesia = true` to disable memory:

```koi
Agent StatelessWorker : Worker {
  amnesia = true
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on process(args: Json) {
    playbook """
    Process this data: {{args.data}}
    Each call is independent — no memory of previous calls.
    """
  }
}
```

With `amnesia = true`:
- No conversation history is saved or sent to the LLM
- Every execution starts fresh with zero context from previous calls
- Token usage remains constant regardless of how many times the agent is called

### When to Use `amnesia`

| Scenario | Memory | Amnesia |
|----------|--------|---------|
| Chatbot / conversational agent | Yes | No |
| Data processor (stateless) | No | Yes |
| Orchestrator coordinating a workflow | Yes | No |
| Simple calculator / formatter | No | Yes |
| Agent that builds on previous results | Yes | No |
| High-throughput worker (cost-sensitive) | No | Yes |

### Memory Limitations

- Memory is **in-process only** — it does not persist between program runs
- Memory is stored per agent instance — different agents have separate memories
- For persistent state across runs, use the [Registry](16-registry.md)

## Private Handlers

By default, all event handlers on an agent are visible to teams, the router, and MCP. Use the `private` modifier to mark a handler as internal — it will still be callable within the agent but excluded from external discovery.

```koi
Agent DataProcessor : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on process(args: Json) {
    // Public handler — discoverable by teams and MCP
    const cleaned = await this.handle("clean", args)
    playbook """
    Process the cleaned data: {{JSON.stringify(cleaned)}}
    """
  }

  private on clean(args: Json) {
    // Private handler — internal only, not exposed externally
    const data = args.data.filter(item => item !== null)
    return { data: data }
  }
}
```

Private handlers:
- **Are not exposed** via `expose mcp` (see below)
- **Are not advertised** to the agent router for automatic delegation
- **Can still be called** internally with `this.handle("name", args)`

## Exposing Handlers as MCP Tools

Agents can expose their handlers as **MCP (Model Context Protocol) tools**, making them callable by external MCP clients like Claude Code, Cursor, or other Koi agents.

### The `expose mcp` Directive

Add `expose mcp` inside an agent body to make all its public handlers available as MCP tools:

```koi
agent CodeReviewer : Reviewer {
  expose mcp

  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on review(args: Json) {
    affordance "Review code for quality, style, and potential bugs"
    playbook """
    Review the following code: {{args.code}}
    Language: {{args.language}}

    Check for correctness, best practices, and security issues.
    """
  }

  on suggest(args: Json) {
    affordance "Suggest improvements for code"
    playbook """
    Suggest improvements for: {{args.code}}
    """
  }

  private on internal_prep(args: Json) {
    // This handler is NOT exposed via MCP
    playbook "Prepare internal analysis context"
  }
}
```

In this example, `review` and `suggest` are exposed as MCP tools, while `internal_prep` is excluded because it's marked `private`.

### Serving an Agent as MCP Server

Use the `koi serve` command to start an agent as a stdio MCP server:

```bash
koi serve path/to/agent.koi
```

This compiles the `.koi` file, finds the agent with `expose mcp`, and starts a JSON-RPC 2.0 server over stdin/stdout. External clients can then discover and call the agent's handlers as MCP tools.

### Using in `.mcp.json`

Any MCP client can connect to a Koi agent by adding it to its MCP configuration:

```json
{
  "mcpServers": {
    "code-reviewer": {
      "command": "koi",
      "args": ["serve", "path/to/code-reviewer.koi"]
    }
  }
}
```

For complete MCP details, see [MCP Protocol](10-mcp-integration.md).

## Using Skills

Skills are reusable capabilities:

```koi
Agent ContentReviewer : Worker {
  uses Skill SentimentAnalysis
  uses Skill LanguageDetection

  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on reviewContent(args: Json) {
    // Use skills for specific tasks
    const sentiment = await this.callSkill('SentimentAnalysis', { text: args.text })
    const language = await this.callSkill('LanguageDetection', { text: args.text })

    // Use playbook for analysis
    playbook """
    Content: {{args.text}}
    Sentiment: {{JSON.stringify(sentiment)}}
    Language: {{language.language}}

    Review this content considering its sentiment and language.
    Provide feedback on tone, clarity, and appropriateness for the audience.
    """
  }
}
```

## Using Teams

Communicate with peer agents:

```koi
Agent Orchestrator : Lead {
  uses Team DataPipeline

  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on process(args: Json) {
    playbook """
    Data: {{JSON.stringify(args.data)}}

    Process this data through the pipeline:
    - Validate the data
    - Transform as needed
    - Load into storage

    Work with the team to accomplish this.
    """
  }
}
```

The agent will automatically discover and delegate to team members.

## Best Practices

### 1. Playbooks First, Code Second

```koi
// ✅ Excellent: Playbook for open-ended task
Agent Analyst : Worker {
  on analyze(args: Json) {
    playbook """Analyze this data: {{args.data}}"""
  }
}

// ❌ Bad: Code for creative task
Agent Analyst : Worker {
  on analyze(args: Json) {
    // 100 lines of if/else trying to analyze data
  }
}
```

### 2. Clear Playbook Instructions

```koi
// ✅ Good: Clear, specific instructions
playbook """
Text: {{args.text}}

Analyze sentiment with these steps:
1. Identify emotional words and phrases
2. Determine overall tone (positive/neutral/negative)
3. Rate intensity on 0-1 scale
4. Explain your reasoning

Return JSON: { sentiment, score, rationale, keywords }
"""

// ❌ Bad: Vague instructions
playbook """Look at this: {{args.text}}"""
```

### 3. Use Code for Technical Operations

```koi
// ✅ Good: Code for API call, playbook for analysis
on processEmail(args: Json) {
  // Code: Fetch email
  const email = await fetchFromIMAP(args.account)

  // Playbook: Analyze
  playbook """
  Email: {{JSON.stringify(email)}}
  Analyze and suggest response.
  """
}

// ❌ Bad: Playbook for technical operation
on processEmail(args: Json) {
  playbook """Connect to IMAP server at {{args.host}} and download emails"""
}
```

### 4. Structured Output

Always request structured JSON in playbooks:

```koi
playbook """
Task: {{args.task}}

Return JSON:
{
  "status": "success|failure",
  "result": "...",
  "confidence": 0.0-1.0,
  "reasoning": "..."
}
"""
```

## Examples

See [Complete Examples](14-examples.md) for full working examples and [LLM Integration](06-llm-integration.md) for detailed LLM configuration.

## What's Next?

- **[LLM Integration](06-llm-integration.md)** - Deep dive into playbooks and LLM configuration
- **[Automatic Routing](07-routing.md)** - How agents discover and delegate to each other
- **[Task Chaining](08-task-chaining.md)** - Automatic multi-step workflows

---

**Next**: [Roles & Teams](04-roles-and-teams.md) →
