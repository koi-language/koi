# Getting Started with Koi

Welcome to Koi! This guide will get you from zero to running your first agent in minutes.

## What You'll Learn

- Installing Koi
- Running your first example
- Creating a Hello World agent
- Understanding the basic workflow

## Prerequisites

- **Node.js 18+** (check with `node --version`)
- **npm** (comes with Node.js)
- A terminal/command line

## Installation

For complete installation instructions, see [Installation Guide](00-installation.md).

**Quick install:**

```bash
curl -fsSL https://raw.githubusercontent.com/koi-language/Koi/main/install.sh | bash
```

After installation, verify it works:

```bash
koi version
```

You should see:

```
🌊 Koi
   Agent-first language. Calm orchestration.

Version: 1.0.0
Node: v20.x.x
Platform: darwin/linux/win32
```

## Setup API Keys

Before creating your first agent, let's configure access to LLMs. Koi agents use **playbooks** (natural language instructions) that are executed by LLMs.

### Step 1: Get an API Key

Choose a provider and get your API key:

- **OpenAI** (recommended for getting started): https://platform.openai.com/api-keys
- **Anthropic**: https://console.anthropic.com/

### Step 2: Configure Environment

Create a `.env` file in your project directory:

```bash
# For OpenAI (recommended)
OPENAI_API_KEY=sk-proj-...your-key-here...

# OR for Anthropic
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
```

**Alternative**: Export as environment variable:

```bash
export OPENAI_API_KEY="sk-proj-...your-key-here..."
```

That's it! Now you're ready to create agents with playbooks.

## Hello World with Playbooks

Let's build your first Koi agent using **natural language**.

### Step 1: Create the File

```bash
touch hello.koi
```

### Step 2: Write Your First Agent

Create `hello.koi` with this content:

```koi
package "my.hello"

role Worker { can execute }

Agent Greeter : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on greet(args: Json) {
    playbook """
    Generate a warm, friendly greeting for {{args.name}}.
    Make it personal and welcoming.

    Return JSON: { "message": "your greeting here" }
    """
  }
}

run Greeter.greet({ name: "World" })
```

### Step 3: Run It

```bash
koi run hello.koi
```

Output:

```
🌊 Koi - Compiling: hello.koi
✓ Compilation successful

🌊 Koi - Running: hello.js

Hello, World!

🌊 Result:
{ message: 'Hello, World!' }
```

**Congratulations!** 🎉 You've written your first Koi program!

## Hello World with Arguments

Let's make it more interactive by using arguments:

```koi
package "my.hello"

role Worker { can execute }

Agent Greeter : Worker {
  on greet(args: Json) {
    const name = args.name || "World"
    console.log("Hello,", name + "!")
    return { message: "Hello, " + name + "!" }
  }
}

run Greeter.greet({ name: "Alice" })
```

Run it:

```bash
koi run hello.koi
```

Output:

```
Hello, Alice!

🌊 Result:
{ message: 'Hello, Alice!' }
```

## Understanding the Workflow

When you run `koi run hello.koi`, here's what happens:

```
1. Parse        ┌─────────────┐
   hello.koi ──→│   Parser    │
                 └──────┬──────┘
                        │
2. Transpile            ↓
                 ┌─────────────┐
                 │ Transpiler  │──→ hello.js (+ source map)
                 └──────┬──────┘
                        │
3. Execute              ↓
                 ┌─────────────┐
                 │   Runtime   │──→ Output
                 └─────────────┘
```

The generated `hello.js` is standard JavaScript that uses Koi's runtime library.

## Next Steps

Now that you have Koi working, you can:

1. **Learn core concepts**: Read [Core Concepts](01-core-concepts.md) to understand Roles, Agents, Teams, and Skills
2. **Explore syntax**: Check [Syntax Basics](02-syntax-basics.md) for variables, control flow, and more
3. **Build real agents**: See [Agents Guide](03-agents.md) for event handlers and state management
4. **Try examples**: Run the examples in the `examples/` directory

## Common Commands

```bash
# Run a Koi program
koi run examples/simple.koi

# Compile without running (generates .js file)
koi compile examples/simple.koi

# Create a new project with templates
koi init my-project

# Show help
koi help

# Show version
koi version
```

## Project Structure

When working with Koi, your project typically looks like this:

```
my-project/
├── .env                  # Environment variables (API keys)
├── package.json          # npm dependencies
├── src/
│   ├── agents/
│   │   ├── greeter.koi
│   │   └── processor.koi
│   ├── skills/
│   │   └── analysis.koi
│   └── main.koi         # Entry point
├── examples/
│   └── demo.koi
└── tests/
    └── greeter.test.ts
```

## Editor Support

### VS Code & Cursor

Get syntax highlighting for `.koi` files:

```bash
cd vscode-koi-extension
ln -s "$(pwd)" ~/.vscode/extensions/koi-lang
# Restart VS Code
```

Features:
- Full syntax highlighting
- Custom "Koi Dark" theme
- Auto-closing brackets
- Playbook highlighting

See [vscode-koi-extension/README.md](../vscode-koi-extension/README.md) for details.

## Debugging

### View Generated JavaScript

To see what JavaScript Koi generates:

```bash
koi compile hello.koi
cat hello.js
```

The generated code uses ES6 modules and Koi's runtime.

### Enable Debug Mode

Run with Node.js inspector:

```bash
node --inspect $(which koi) run hello.koi
```

Then open Chrome DevTools at `chrome://inspect`.

### Check for Errors

Koi provides detailed error messages with source locations:

```
Error in hello.koi:8:10

  6 │ Agent Greeter : Worker {
  7 │   on greet(args: Json) {
> 8 │     const x = undefinedVariable
    │               ^^^^^^^^^^^^^^^^^
  9 │     return { x }
 10 │   }

ReferenceError: undefinedVariable is not defined
```

Source maps ensure errors point to the original `.koi` file, not generated `.js`.

## Troubleshooting

### "koi: command not found"

**Solution**: Install globally or use `node src/cli/koi.js` directly:

```bash
npm install -g .
# or
node src/cli/koi.js run hello.koi
```

### "Parser generation failed"

**Solution**: Run build script:

```bash
npm run build:grammar
```

### "Cannot find module"

**Solution**: Install dependencies:

```bash
npm install
```

## What's Next?

You now have Koi installed and running. Here are suggested next steps:

1. **[Core Concepts](01-core-concepts.md)** - Understand the philosophy behind Roles, Agents, Teams, and Skills
2. **[Syntax Basics](02-syntax-basics.md)** - Learn variables, types, and control flow
3. **[Agents Guide](03-agents.md)** - Deep dive into creating and using agents
4. **[Examples](14-examples.md)** - See complete working examples

---

**Ready to build?** Let's explore [Core Concepts](01-core-concepts.md) next!
