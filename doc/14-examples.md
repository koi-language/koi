# Complete Examples

This guide showcases complete, working Koi programs demonstrating various features.

## Available Examples

All examples are in the `examples/` directory. You can run them with:

```bash
koi run examples/example-name.koi
```

## Basic Examples

### Simple Agent Communication

**File**: `examples/simple.koi`

Minimal example showing agent-to-agent communication.

```bash
koi run examples/simple.koi
```

**Key concepts**: Basic agents, event handlers, return values

### Calculator

**File**: `examples/calculator.koi`

Calculator with multiple operations demonstrating pure procedural code.

```bash
koi run examples/calculator.koi
```

**Key concepts**: Multiple handlers, arithmetic operations, error handling

### Counter

**File**: `examples/counter.koi`

Stateful agent maintaining a counter.

```bash
koi run examples/counter.koi
```

**Key concepts**: State management, increment/decrement operations

## LLM Examples

### Hello World with LLM

**File**: `examples/hello-world.koi`

Uses an LLM to generate personalized greetings.

```bash
koi run examples/hello-world.koi
```

**Key concepts**: LLM configuration, playbooks, natural language execution

**Requirements**: Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`

### Sentiment Analysis Skill

**File**: `examples/sentiment.koi`

Complete skill with internal agents for analyzing text sentiment.

```bash
koi run examples/sentiment.koi
```

**Key concepts**: Skills, internal teams, LLM-based analysis

## Advanced Examples

### Pipeline Processing

**File**: `examples/pipeline.koi`

Multi-stage data processing pipeline.

```bash
koi run examples/pipeline.koi
```

**Key concepts**: Sequential processing, data transformation

### Automatic Routing Demo

**File**: `examples/auto-routing-demo.koi`

Demonstrates automatic intelligent routing between agents.

```bash
koi run examples/auto-routing-demo.koi
```

**Key concepts**: Semantic routing, automatic delegation, no manual orchestration

### Task Chaining Demo

**File**: `examples/task-chaining-demo.koi`

Shows automatic output-to-input chaining across tasks.

```bash
koi run examples/task-chaining-demo.koi
```

**Key concepts**: Task decomposition, result chaining, `{{previousResult}}` syntax

### Planning Demo

**File**: `examples/planning-demo.koi`

LLM-based automatic planning and decomposition.

```bash
koi run examples/planning-demo.koi
```

**Key concepts**: Automatic planning, step execution, re-planning on failure

## Integration Examples

### MCP Integration

**File**: `examples/mcp-example.koi`

Demonstrates Model Context Protocol for remote agents.

```bash
koi run examples/mcp-example.koi
```

**Key concepts**: MCP addresses, remote agents, connection management

### TypeScript Import Demo

**File**: `examples/test-typescript-import.koi`

Using TypeScript modules in Koi agents.

```bash
koi run examples/test-typescript-import.koi
```

**Key concepts**: TypeScript imports, classes, functions, constants

### Crypto/SHA256 Demo

**File**: `examples/test-crypto-sha256.koi`

Using the crypto-js npm package for hashing.

```bash
koi run examples/test-crypto-sha256.koi
```

**Key concepts**: npm package imports, method chaining, hash generation

## Testing Examples

### Unit Testing with Jest

**File**: `examples/utils/calculator.test.ts`

Complete Jest test suite for TypeScript module.

```bash
npm test examples/utils/calculator.test.ts
```

**Key concepts**: Jest setup, test organization, assertions

## Example Templates

### Basic Agent Template

```koi
package "my.app"

role Worker { can execute }

Agent MyAgent : Worker {
  on doSomething(args: Json) {
    // Your logic here
    return { result: "success" }
  }
}

run MyAgent.doSomething({})
```

### LLM Agent Template

```koi
package "my.app"

role Worker { can execute }

Agent LLMAgent : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on process(args: Json) {
    playbook """
    Task: {{args.task}}
    Process this task and return results.
    """
  }
}

run LLMAgent.process({ task: "analyze data" })
```

### Multi-Agent Template

```koi
package "my.app"

role Worker { can execute }

Agent AgentA : Worker {
  on taskA(args: Json) {
    return { result: "A processed" }
  }
}

Agent AgentB : Worker {
  on taskB(args: Json) {
    return { result: "B processed" }
  }
}

Team MyTeam {
  a = AgentA
  b = AgentB
}

Agent Orchestrator : Worker {
  uses Team MyTeam

  on process(args: Json) {
    const resultA = await send peers.event("taskA").role(Worker).any()(args)
    const resultB = await send peers.event("taskB").role(Worker).any()(args)
    return { a: resultA, b: resultB }
  }
}

run Orchestrator.process({})
```

## Running Examples

### Compile Only

```bash
koi compile examples/simple.koi
# Generated: examples/simple.js
```

### Run Directly

```bash
koi run examples/simple.koi
```

### Run with Environment Variables

```bash
OPENAI_API_KEY=sk-... koi run examples/hello-world.koi
```

### Debug Mode

```bash
node --inspect $(which koi) run examples/simple.koi
```

Then open Chrome DevTools at `chrome://inspect`.

## Creating Your Own Examples

1. **Create file**: `my-example.koi`
2. **Define package**: `package "my.example"`
3. **Add role**: `role Worker { can execute }`
4. **Create agent**: Define handlers
5. **Run it**: `run AgentName.handler({})`
6. **Test it**: `koi run my-example.koi`

## Exploring Examples

The best way to learn Koi is to:

1. **Read** the example code
2. **Run** the example
3. **Modify** it to test your understanding
4. **Build** your own variation

Start with `simple.koi` and work your way up to more complex examples!

## What's Next?

- **[Advanced Topics](15-advanced.md)** - Source maps, debugging, performance optimization

---

**Back to**: [Documentation Index](README.md)
