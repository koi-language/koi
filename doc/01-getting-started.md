# 1. Getting started

## Set up a TypeScript project

In the folder of your project's `package.json`:

```bash
npx @koi-language/koi setup
```

This installs `@koi-language/koi`, creates an `agents/` folder, makes it importable as `#agents/...`, and
configures npm and TypeScript so that a `.koi` file can be imported like any module. You run it once.

```
my-app/
├── agents/
│   └── support.koi       # your agents
├── src/
│   └── main.ts           # your code
└── .env                  # the model keys
```

## Give it a model

Put one key in `.env`, for example:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

`OPENAI_API_KEY`, `GEMINI_API_KEY` or a Koi API key work too: see [Models](09-models.md).

## Write an agent

`agents/support.koi`:

```python
role SupportRole { can execute, can web_access }

export agent SupportAgent : SupportRole {
  on answer(args: { question: string }) {
    affordance "Answer a customer's question about our product"
    playbook """
      A customer asks: {{args.question}}
      Look up what you need on our website (https://example.com/docs),
      then return { answer, sources }.
    """
  }
}
```

- `role` lists what the agent may do. This one may think and act (`execute`) and use the web (`web_access`).
- `export agent` makes the agent importable from TypeScript.
- `on answer(...)` is a handler: something you can ask the agent to do, with typed arguments.
- `playbook` tells the agent, in plain language, what to do. `{{args.question}}` inserts the argument.
- `affordance` is a one-line description of the handler, used by other agents and by your editor.

The agent works in a loop: it decides one step, does it, looks at the result and decides the next one, until
it returns.

## Call it from TypeScript

`src/main.ts`:

```ts
import "dotenv/config";
import { SupportAgent } from "#agents/support.koi";

const reply = await SupportAgent.answer({ question: "Can I export my data to CSV?" });
console.log(reply.answer);
```

```bash
npm install dotenv     # loads .env; or use Node's own: node --env-file=.env
npx tsx src/main.ts
```

The `.koi` file is compiled when it is imported, and its types are written beside it
(`agents/support.d.koi.ts`), so `SupportAgent.answer` is typed: TypeScript rejects
`SupportAgent.answer({ qestion: "..." })`.

## Or run it from the terminal

Add a `run` statement at the end of the file and run it with the `koi` command:

```python
run SupportAgent.answer({ question: "Can I export my data to CSV?" })
```

```bash
npx koi run agents/support.koi
```

`run` is for trying an agent from the terminal; it is ignored when the file is imported from TypeScript.

Next: [Agents and roles](02-agents-and-roles.md).
