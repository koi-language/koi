# 9. Models

## Keys

Koi reads the keys from the environment (a `.env` file in your project). Two ways:

**Your providers' own keys**, for chat:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
```

**The Koi API**: one key for every model (chat, embeddings, image, video, audio), through a gateway that
speaks the Koi API. braxil.ai is the default; any server that speaks the same API works.

```bash
KOI_API_URL=https://api.braxil.ai   # optional: this is the default
KOI_API_KEY=...
```

With `KOI_API_KEY` set, every model call goes through it. Without it, chat uses the provider keys above.
**Image, video and audio are only generated through the Koi API**: an agent with `can generate_image` and no
`KOI_API_KEY` gets an error saying so.

## Which model an agent uses

By default Koi chooses the model **per step**, among the models your keys give access to: each model has a
score for code and one for reasoning, and each step needs a level of both. The agent's phase sets that need
(`reasoning: high`, `code: low`, see [Phases](07-phases-and-transitions.md)), and transitions can raise it
(`bump(reasoning, +20)`). Simple steps go to fast, cheap models; hard ones to the strongest.

To pin a model for an agent:

```python
agent Auditor : Clerk {
  llm default = { provider: "anthropic", model: "<model id>" }
  ...
}
```

`provider` is `anthropic`, `openai`, `gemini` or `auto`; `model` a model id of that provider, or `auto`.

## Costs and limits

Every step is a model call, so a task costs as many calls as steps. To keep it bounded from code, pass
`maxSteps` and `timeoutMs` on each call (see [TypeScript](08-typescript.md)); use phases with low `reasoning`
for the routine stages and keep `high` for the ones that need it.
