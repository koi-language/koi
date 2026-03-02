# Koi Language Documentation

**Agent-first language. Calm orchestration.** 🌊

Welcome to the complete Koi language documentation. This guide will take you from your first "Hello World" to building complex multi-agent systems.

## Documentation Structure

### Getting Started
- **[00. Installation](00-installation.md)** - Install Koi on your system
- **[00. Editor Setup](00-editor-setup.md)** - VS Code and Cursor extension setup
- **[00. Getting Started](00-getting-started.md)** - Hello World and your first agent
- **[01. Core Concepts](01-core-concepts.md)** - Roles, Agents, Teams, Skills, and the Koi philosophy

### Language Basics
- **[02. Syntax Basics](02-syntax-basics.md)** - Variables, types, control flow, and basic syntax
- **[03. Agents](03-agents.md)** - Creating agents, handlers, state management
- **[04. Roles & Teams](04-roles-and-teams.md)** - Role-based system, team composition, peer communication

### Advanced Features
- **[05. Skills](05-skills.md)** - Reusable capabilities with encapsulated agents
- **[06. LLM Integration](06-llm-integration.md)** - Using real LLMs with playbooks
- **[07. Automatic Routing](07-routing.md)** - Intelligent agent selection and delegation
- **[08. Task Chaining](08-task-chaining.md)** - Automatic output-to-input chaining
- **[09. Planning System](09-planning.md)** - LLM-based automatic planning and decomposition

### Integration & Tools
- **[10. MCP Protocol](10-mcp-integration.md)** - Model Context Protocol: consume and expose MCP servers
- **[11. TypeScript Imports](11-typescript-imports.md)** - Using npm packages and TypeScript modules
- **[12. Testing](12-testing.md)** - Unit testing your Koi code with Jest
- **[13. Caching](13-caching.md)** - Persistent caching for LLM responses

### Reference
- **[14. Complete Examples](14-examples.md)** - Full working examples
- **[15. Advanced Topics](15-advanced.md)** - Source maps, debugging, performance
- **[17. Compose Prompts](17-compose-prompts.md)** - Dynamic prompt assembly with `@let`, `@if`, fragments, and context variables

## Quick Navigation

### By Use Case

**I want to...**
- **...get started quickly** → [Getting Started](00-getting-started.md)
- **...set up my editor** → [Editor Setup](00-editor-setup.md)
- **...understand the philosophy** → [Core Concepts](01-core-concepts.md)
- **...build my first agent** → [Agents Guide](03-agents.md)
- **...use LLMs in my code** → [LLM Integration](06-llm-integration.md)
- **...connect multiple agents** → [Roles & Teams](04-roles-and-teams.md)
- **...build complex workflows** → [Task Chaining](08-task-chaining.md), [Planning System](09-planning.md)
- **...use npm packages** → [TypeScript Imports](11-typescript-imports.md)
- **...test my agents** → [Testing Guide](12-testing.md)
- **...build dynamic prompts with runtime data** → [Compose Prompts](17-compose-prompts.md)
- **...connect remote services** → [MCP Protocol](10-mcp-integration.md)

### By Experience Level

**Beginner** (new to Koi)
1. [Getting Started](00-getting-started.md)
2. [Core Concepts](01-core-concepts.md)
3. [Syntax Basics](02-syntax-basics.md)
4. [Agents](03-agents.md)

**Intermediate** (familiar with basics)
1. [Roles & Teams](04-roles-and-teams.md)
2. [Skills](05-skills.md)
3. [LLM Integration](06-llm-integration.md)
4. [TypeScript Imports](11-typescript-imports.md)

**Advanced** (building complex systems)
1. [Automatic Routing](07-routing.md)
2. [Task Chaining](08-task-chaining.md)
3. [Planning System](09-planning.md)
4. [MCP Protocol](10-mcp-integration.md)
5. [Advanced Topics](15-advanced.md)

## What is Koi?

Koi is a **multi-agent orchestration language** designed for building AI-powered systems that feel natural and maintainable.

### Key Features

- **🤖 Agent-First**: Everything is an agent. No complex classes or inheritance.
- **📝 Natural Language**: Write agent logic in plain language using playbooks.
- **🎭 Role-Based**: Agents have roles (can delegate, can execute), not hard-coded names.
- **🔄 Auto-Routing**: ANY agent can delegate to others. No manual orchestration needed.
- **🤖 Automatic Planning**: Complex tasks decompose into actions automatically.
- **📦 Skills**: Package reusable capabilities with their own internal agents.
- **🔗 Task Chaining**: Outputs automatically chain into inputs.
- **🌐 MCP Support**: Connect to remote agents via Model Context Protocol.
- **⚙️ TypeScript Support**: Use procedural code when needed for technical operations.

### Design Philosophy

1. **Natural Language First**: Describe WHAT you want, not HOW to do it.
2. **Compose, Don't Configure**: Agents compose naturally without boilerplate.
3. **Smart Defaults**: The runtime handles routing, chaining, and delegation automatically.
4. **Fail Gracefully**: Built-in re-planning and fallback strategies.

## Getting Help

- **Examples**: Check the [examples/](../examples/) directory for working code
- **Issues**: Report bugs at [GitHub Issues](https://github.com/anthropics/koi/issues)
- **API Reference**: Each guide includes API documentation for that topic

## Quick Examples

### Hello World

```koi
package "hello.world"

role Worker { can execute }

Agent Greeter : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on greet(args: Json) {
    playbook """
    Generate a friendly greeting for {{args.name}}.
    Be warm and welcoming.
    Return JSON: { "message": "your greeting here" }
    """
  }
}

run Greeter.greet({ name: "World" })
```

### Data Analysis Agent

```koi
Agent Analyzer : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on analyze(args: Json) {
    playbook """
    Data: {{JSON.stringify(args.data)}}

    Analyze this data and identify:
    - Key patterns and trends
    - Anomalies or outliers
    - Important insights
    - Recommendations

    Return structured JSON with your findings.
    """
  }
}

run Analyzer.analyze({ data: [1, 5, 3, 9, 2, 8, 1, 7] })
```

### Multi-Agent Collaboration

```koi
Agent Translator : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on translate(args: Json) {
    playbook """
    Translate '{{args.text}}' to {{args.language}}.
    Return JSON: { "translated": "...", "language": "{{args.language}}" }
    """
  }
}

Agent Assistant : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on help(args: Json) {
    playbook """
    User request: {{args.request}}

    Help accomplish this task.
    If translation is needed, work with the team to get it done.
    """
  }
}

// Assistant automatically discovers and delegates to Translator
run Assistant.help({ request: "Translate 'Hello' to French" })
```

### Agent with Skills

Skills provide technical capabilities that agents can use:

```koi
package "email.assistant"

import "./skills/email-reader.koi"  // Skill for reading emails via IMAP

Agent EmailAssistant : Worker {
  uses Skill EmailReader
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on processInbox(args: Json) {
    playbook """
    Lee los últimos mensajes de correo y contesta aquellos que
    vengan de proveedores automáticamente.

    Para cada email de proveedor:
    - Identifica el remitente y el asunto
    - Analiza el contenido del mensaje
    - Genera una respuesta profesional y apropiada
    - Marca como procesado

    Ignora emails personales o de clientes.

    Return JSON: {
      "processed": number,
      "responses": [{ "to": "...", "subject": "...", "body": "..." }],
      "skipped": number
    }
    """
  }
}

run EmailAssistant.processInbox({
  email: "user@company.com",
  password: "***",
  since: "2024-01-01"
})
```

**Key concept**: Skills handle technical operations (IMAP, databases, APIs), while playbooks describe behavior in natural language.

### Team Collaboration

Multiple agents working together automatically:

```koi
package "dev.team"

import "./skills/github-issues.koi"

role Manager { can delegate, can decide }
role Developer { can code }
role QA { can test, can verify }

Agent ProjectManager : Manager {
  uses Skill GitHubIssues
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on processIssues(args: Json) {
    playbook """
    Lee los issues abiertos del repositorio y selecciona
    el más prioritario para trabajar.

    Analiza el issue y delega el trabajo al equipo.
    """
  }
}

Agent Programmer : Developer {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on implement(args: Json) {
    playbook """
    Issue: {{args.issue}}

    Implementa la funcionalidad solicitada.
    Escribe código limpio y bien documentado.
    """
  }
}

Agent QualityAssurance : QA {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on verify(args: Json) {
    playbook """
    Código: {{args.code}}

    Verifica que el código funciona correctamente:
    - Revisa la lógica
    - Identifica posibles bugs
    - Sugiere mejoras

    Aprueba o rechaza con feedback detallado.
    """
  }
}

Team Development {
  pm = ProjectManager
  dev = Programmer
  qa = QualityAssurance
}

// The PM automatically coordinates with the team
run ProjectManager.processIssues({ repo: "company/project" })
```

**Agents collaborate automatically** - no manual orchestration needed!

## Next Steps

Ready to start? Head to [Getting Started](00-getting-started.md) for installation and your first agent!

---

**Koi**: Agent-first language. Calm orchestration. 🌊
