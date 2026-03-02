# LLM Integration

Learn how to integrate real LLMs (OpenAI, Anthropic) into your Koi agents using playbooks.

## Table of Contents

- [Overview](#overview)
- [Setup](#setup)
- [Playbooks](#playbooks)
- [Prompts](#prompts)
- [LLM Configuration](#llm-configuration)
- [Supported Models](#supported-models)
- [Best Practices](#best-practices)
- [Debugging](#debugging)
- [Cost Optimization](#cost-optimization)

## Overview

Koi supports **real LLM execution** for playbook-based agents. Write natural language instructions, and the LLM executes them as code.

### How It Works

```
 Playbook (Natural Language)
           ↓
    LLM Provider (OpenAI/Anthropic)
           ↓
   Structured JSON Response
           ↓
    Return to Agent
```

## Setup

### Step 1: Get API Key

Choose a provider:
- **OpenAI**: https://platform.openai.com/api-keys
- **Anthropic**: https://console.anthropic.com/

### Step 2: Configure Environment

Create `.env` file in project root:

```bash
# For OpenAI
OPENAI_API_KEY=sk-proj-...your-key...

# OR for Anthropic
ANTHROPIC_API_KEY=sk-ant-...your-key...
```

### Step 3: Test It

```bash
koi run examples/hello-world.koi
```

If you see an LLM response, it's working!

## Playbooks

Playbooks are natural language instructions that the LLM executes.

### Basic Playbook

```koi
Agent Greeter : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on greet(args: Json) {
    playbook """
    Generate a friendly greeting for {{args.name}}.
    Return JSON: { "greeting": "...", "style": "formal|casual" }
    """
  }
}
```

### Playbook Syntax

Playbooks use triple-quoted strings with interpolation:

```koi
playbook """
Your instructions here.
Use {{variable}} for interpolation.
"""
```

### String Interpolation

Access args and state:

```koi
Agent Assistant : Worker {
  state = { mode: "helpful" }

  on help(args: Json) {
    playbook """
    User question: {{args.question}}
    Mode: {{this.state.mode}}

    Answer the question.
    """
  }
}
```

### Structured Output

Always specify the expected output format:

```koi
playbook """
Analyze sentiment of: {{args.text}}

Return JSON with:
- sentiment: "positive", "neutral", or "negative"
- score: 0.0 to 1.0
- rationale: brief explanation
"""
```

The LLM will return:

```json
{
  "sentiment": "positive",
  "score": 0.85,
  "rationale": "The text expresses happiness and satisfaction"
}
```

## Prompts

Prompts are **first-class citizens** in Koi. You can declare reusable prompt fragments, compose them, and pass them as values — separate from the agents that use them.

### Simple Prompt (Constant)

A prompt with no parameters is a reusable text constant:

```koi
export prompt FormalTone = """
Always respond in a formal and professional tone. Use clear and structured language.
"""
```

Use it in a playbook by referencing its name:

```koi
agent Greeter : Worker {
  on greet(args: Json) {
    playbook FormalTone + """
    Greet the user and introduce yourself.
    Return: { "greeting": "<your greeting>" }
    """
  }
}
```

### Parameterized Prompt

Prompts can accept parameters to generate dynamic text:

```koi
export prompt Persona(name: String, role: String) = """
You are {{name}}, an expert {{role}} with many years of experience.
"""
```

Call it like a function when composing playbooks:

```koi
agent Assistant : Worker {
  on respond(args: Json) {
    playbook Persona(args.name, args.role) + """
    Answer briefly: {{args.question}}
    Return: { "answer": "<your answer>" }
    """
  }
}
```

### Prompt Composition

Combine multiple prompts and inline strings with `+`:

```koi
export prompt FormalTone = """
Always respond in a formal and professional tone.
"""

export prompt Persona(name: String, role: String) = """
You are {{name}}, an expert {{role}} with many years of experience.
"""

agent Expert : Worker {
  on answer(args: Json) {
    playbook FormalTone + Persona(args.name, args.role) + """
    Answer the question briefly: {{args.question}}
    Return: { "answer": "<your answer>" }
    """
  }
}

run Expert.answer({
  "name": "Claude",
  "role": "AI assistant",
  "question": "What is your specialty?"
})
```

The prompts are concatenated in order before being sent to the LLM.

### Inline Playbook (No Prompt Reference)

You can also write the full playbook inline without defining a named prompt:

```koi
agent Greeter : Worker {
  on greet(args: Json) {
    playbook """
    Greet {{args.name}} in a friendly way.
    Return: { "greeting": "<greeting>" }
    """
  }
}
```

### Exporting Prompts

Use `export` to make a prompt available to other files:

```koi
// prompts.koi
export prompt FormalTone = """
Always respond in a formal and professional tone.
"""

export prompt Persona(name: String, role: String) = """
You are {{name}}, an expert {{role}}.
"""
```

Import and use them in another file:

```koi
import { FormalTone, Persona } from "./prompts.koi"

agent MyAgent : Worker {
  on run(args: Json) {
    playbook FormalTone + Persona(args.name, args.role) + """
    Complete the task: {{args.task}}
    Return: { "result": "<result>" }
    """
  }
}
```

### Summary

| Feature | Syntax |
|---------|--------|
| Constant prompt | `prompt Name = """..."""` |
| Parameterized prompt | `prompt Name(p: Type) = """...{{p}}..."""` |
| Compose prompts | `playbook A + B + """..."""` |
| Export | `export prompt Name = ...` |
| Inline playbook | `playbook """..."""` |
| Compose with directives | `prompt Name = compose { fragments: {...}, template: """...""" }` |

### Compose Prompts (Dynamic Assembly)

For prompts that need runtime data, conditional sections, or image attachments, use **compose prompts** with template directives (`@let`, `@if`, `@else`, `{{expr}}`):

```koi
export prompt MyPlaybook = compose {
  fragments: {
    instructions: InstructionsPrompt,
    rules: RulesPrompt
  }

  template: """
  `instructions`

  @let taskResult = callAction('task_list')

  @if (taskResult?.tasks?.some(t => t.status === 'pending')) {
    You have pending tasks to complete.
  }
  @else {
    All tasks are done. Ask the user what to do next.
  }

  `rules`
  """
}
```

Compose templates compile directly to JavaScript at transpile time — no LLM involved, fully deterministic. Built-in context variables (`args`, `state`, `agentName`, `userMessage`) are available automatically.

> **Full guide:** See **[17. Compose Prompts](17-compose-prompts.md)** for complete syntax reference, all available directives, context variables, image support, and best practices.

## LLM Configuration

### Default Configuration

Set default LLM for all handlers:

```koi
Agent Assistant : Worker {
  llm default = {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 500
  }

  on help(args: Json) {
    playbook """Answer: {{args.question}}"""
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
    playbook """Quick task"""
  }

  // Override: use gpt-4o for complex tasks
  on complexTask(args: Json) {
    llm { provider: "openai", model: "gpt-4o", temperature: 0.3 }
    playbook """Complex reasoning"""
  }
}
```

### Configuration Options

```koi
llm default = {
  provider: "openai",        // or "anthropic"
  model: "gpt-4o-mini",      // model name
  temperature: 0.7,          // 0.0 to 2.0 (creativity)
  max_tokens: 500,           // max response length
  top_p: 1.0,                // nucleus sampling (optional)
  frequency_penalty: 0.0,    // reduce repetition (optional)
  presence_penalty: 0.0      // encourage novelty (optional)
}
```

## Supported Models

### OpenAI Models

| Model | Use Case | Cost | Speed |
|-------|----------|------|-------|
| `gpt-4o-mini` | Default, fast | ~$0.15/1M tokens | Fast |
| `gpt-4o` | Complex tasks | ~$2.50/1M tokens | Medium |
| `gpt-4-turbo` | High quality | ~$10/1M tokens | Slower |
| `gpt-3.5-turbo` | Budget option | ~$0.50/1M tokens | Fast |

**Recommended**: `gpt-4o-mini` for most tasks.

### Anthropic Models

| Model | Use Case | Cost | Speed |
|-------|----------|------|-------|
| `claude-3-5-haiku-20241022` | Fast, cheap | ~$0.80/1M tokens | Very fast |
| `claude-3-5-sonnet-20241022` | Default | ~$3.00/1M tokens | Fast |
| `claude-3-opus-20240229` | Highest quality | ~$15/1M tokens | Slower |

**Recommended**: `claude-3-5-haiku-20241022` for testing, `claude-3-5-sonnet-20241022` for production.

### Choosing a Model

**Use gpt-4o-mini or claude-3-5-haiku when**:
- Task is straightforward
- Cost is a concern
- Speed matters
- Testing/development

**Use gpt-4o or claude-3-5-sonnet when**:
- Task requires complex reasoning
- Quality is critical
- Production workloads

**Use gpt-4-turbo or claude-3-opus when**:
- Maximum quality needed
- Complex multi-step reasoning
- Critical decisions

## Best Practices

### 1. Clear Instructions

```koi
// ✅ Good: Clear, specific
playbook """
Analyze the sentiment of this product review: {{args.review}}

Return JSON with:
- sentiment: "positive", "neutral", or "negative"
- confidence: 0.0 to 1.0
- key_phrases: array of notable phrases
"""

// ❌ Bad: Vague
playbook """
Look at this: {{args.review}}
"""
```

### 2. Specify Output Format

```koi
// ✅ Good: Structured output
playbook """
Generate 3 suggestions for improving this code: {{args.code}}

Return JSON:
{
  "suggestions": [
    { "issue": "...", "improvement": "...", "priority": "high|medium|low" }
  ]
}
"""

// ❌ Bad: Unstructured
playbook """Generate suggestions for: {{args.code}}"""
```

### 3. Use Low Temperature for Consistency

```koi
// ✅ Good: Consistent for structured tasks
llm { provider: "openai", model: "gpt-4o-mini", temperature: 0.3 }

playbook """Extract entities from: {{args.text}}"""

// ✅ Good: Creative for content generation
llm { provider: "openai", model: "gpt-4o-mini", temperature: 0.9 }

playbook """Write a creative story about: {{args.topic}}"""
```

### 4. Provide Examples in Prompts

```koi
playbook """
Classify this email as spam or not spam.

Examples:
- "Win free money!" → spam
- "Meeting at 3pm" → not spam

Return JSON: { "classification": "spam|not_spam", "confidence": 0-1 }
"""
```

### 5. Use Code for Deterministic Tasks

```koi
// ❌ Bad: LLM for simple math
on add(args: Json) {
  playbook """Calculate {{args.a}} + {{args.b}}"""
}

// ✅ Good: Code for math
on add(args: Json) {
  return { result: args.a + args.b }
}
```

## Debugging

### Enable Verbose Logging

```bash
DEBUG=llm koi run examples/hello-world.koi
```

Output:

```
[LLM] Executing playbook with provider: openai
[LLM] Model: gpt-4o-mini
[LLM] Prompt: Generate a greeting for Alice...
[LLM] Response: { "greeting": "Hello Alice!", "style": "casual" }
```

### View Generated JavaScript

```bash
koi compile examples/hello-world.koi
cat examples/hello-world.js
```

### Check API Key

```bash
echo $OPENAI_API_KEY
echo $ANTHROPIC_API_KEY
```

### Test API Connection

```koi
Agent APITest : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on test(args: Json) {
    playbook """Return JSON: { "status": "working" }"""
  }
}

run APITest.test({})
```

## Cost Optimization

### 1. Use Cheaper Models

```koi
// Development/testing
llm default = { provider: "openai", model: "gpt-4o-mini" }

// Production (only if needed)
llm default = { provider: "openai", model: "gpt-4o" }
```

### 2. Reduce max_tokens

```koi
// ✅ Good: Appropriate limit
llm { max_tokens: 200 }
playbook """Summarize in one paragraph: {{args.text}}"""

// ❌ Bad: Unnecessarily high
llm { max_tokens: 4000 }
playbook """Return "yes" or "no": {{args.question}}"""
```

### 3. Cache Responses

For repeated queries, cache results in your code:

```koi
Agent CachedAnalyzer : Worker {
  state = { cache: {} }

  on analyze(args: Json) {
    const key = args.text

    if (this.state.cache[key] != null) {
      return this.state.cache[key]
    }

    playbook """Analyze: {{args.text}}"""

    // Cache the result (note: simplified, actual caching happens in runtime)
    this.state.cache[key] = result
    return result
  }
}
```

See [Caching Guide](13-caching.md) for automatic LLM response caching.

### 4. Use Code When Possible

```koi
Agent Hybrid : Worker {
  // Use code for deterministic tasks
  on validate(args: Json) {
    return { valid: args.email.includes("@") }
  }

  // Use LLM only when necessary
  on analyzeComplexText(args: Json) {
    playbook """Analyze: {{args.text}}"""
  }
}
```

## Examples

### Example 1: Sentiment Analysis

```koi
Agent SentimentAnalyzer : Worker {
  llm default = {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.3
  }

  on analyze(args: Json) {
    playbook """
    Analyze the sentiment of this text: {{args.text}}

    Return JSON:
    {
      "sentiment": "positive|neutral|negative",
      "score": 0.0-1.0,
      "emotions": ["happy", "sad", "angry", etc],
      "summary": "one sentence summary"
    }
    """
  }
}

run SentimentAnalyzer.analyze({ text: "I love this product! It's amazing!" })
```

### Example 2: Multi-Step Reasoning

```koi
Agent ProblemSolver : Worker {
  llm default = {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.5
  }

  on solve(args: Json) {
    playbook """
    Problem: {{args.problem}}

    Break down the problem into steps and solve it.

    Return JSON:
    {
      "steps": [
        { "step": 1, "description": "...", "result": "..." },
        { "step": 2, "description": "...", "result": "..." }
      ],
      "final_answer": "...",
      "confidence": 0.0-1.0
    }
    """
  }
}
```

### Example 3: Content Generation

```koi
Agent ContentWriter : Worker {
  llm default = {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.8
  }

  on writeArticle(args: Json) {
    playbook """
    Write a {{args.length}} article about: {{args.topic}}

    Tone: {{args.tone}}
    Audience: {{args.audience}}

    Return JSON:
    {
      "title": "...",
      "body": "...",
      "word_count": number,
      "key_points": ["...", "..."]
    }
    """
  }
}

run ContentWriter.writeArticle({
  topic: "AI in healthcare",
  length: "500 words",
  tone: "professional",
  audience: "healthcare professionals"
})
```

## Troubleshooting

### "API key not found"

**Solution**: Set environment variable:

```bash
export OPENAI_API_KEY="sk-..."
# or
echo "OPENAI_API_KEY=sk-..." > .env
```

### "Rate limit exceeded"

**Solution**: Wait and retry, or upgrade API plan.

### "Invalid JSON response"

LLM sometimes returns markdown. Koi extracts JSON automatically, but if it fails:

**Solution**:
- Be more explicit in prompt: "Return ONLY JSON, no markdown"
- Increase `max_tokens`
- Use lower `temperature`

### "Model not found"

**Solution**: Check model name spelling. Verify you have access in your API account.

## What's Next?

- **[Automatic Routing](07-routing.md)** - Let agents discover and delegate to each other
- **[Task Chaining](08-task-chaining.md)** - Automatic output-to-input chaining
- **[Planning System](09-planning.md)** - LLM-based task decomposition

---

**Next**: [Automatic Routing](07-routing.md) →
