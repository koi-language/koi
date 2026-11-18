# 8. Calling agents from TypeScript

## Setup

```bash
npx @koi-language/koi setup
```

Run once in the folder of your `package.json`. It:

- installs `@koi-language/koi`;
- creates `agents/` and maps it as `#agents/*` in `package.json` (`"imports"`), so any file imports
  `#agents/x.koi` the same way;
- adds the Koi loader to `.npmrc` (`node-options=--import=@koi-language/koi/register`), so everything started
  with npm or npx can import `.koi` files;
- sets `"allowArbitraryExtensions": true` in `tsconfig.json`, so TypeScript reads the types of `.koi` files.

## Export, import, call

```python
// agents/orders.koi
export agent OrderClerk : OrderDesk {
  on processInbox(args: { since: string, approvalLimit: number }) { ... }
  private on retry(args: Json) { ... }
}
```

```ts
import { OrderClerk } from "#agents/orders.koi";

const orders = await OrderClerk.processInbox({ since: "2026-11-17", approvalLimit: 5000 });
```

- Only agents marked `export agent` are exported; each public handler is an async method.
- The file is compiled when it is imported. Agents imported by that file from other `.koi` files work too.
- Each call is independent: the same agent can be called several times at once.

## Options

The second argument of every method:

```ts
const orders = await OrderClerk.processInbox(
  { since: "2026-11-17", approvalLimit: 5000 },
  {
    timeoutMs: 10 * 60_000,
    maxSteps: 150,
    signal: controller.signal,
    autoApprove: false,
    onEvent: (e) => log.info(e.type, e),
    onQuestion: async (q) => (q.kind === "text" ? "Use the EUR price list." : null),
  },
);
```

| Option | Meaning |
|---|---|
| `timeoutMs` | stop the agent and reject after this long |
| `maxSteps` | cap the steps of the agent's reasoning loop (each agent it delegates to has the same cap) |
| `signal` | an `AbortSignal`: abort it to stop the agent |
| `autoApprove` | approve shell commands, file writes and paid media without asking; by default they are denied |
| `onEvent` | everything the agent does: `progress`, `action`, `output`, `status`, `question`, `answer`, `log` |
| `onQuestion` | answer the agent's questions; return `null` to let it decide on its own |

A call never prints to the terminal and never waits for a user. When the agent asks something and there is no
`onQuestion` (or it returns `null`), the agent is told to decide with sensible defaults and say what it assumed.
A permission request without `autoApprove` is denied, and the agent continues without that action.

## Errors

A call rejects with an error that has a `code`:

| `code` | Cause |
|---|---|
| `KOI_TIMEOUT` | `timeoutMs` passed |
| `KOI_ABORTED` | the `signal` was aborted |
| `KOI_MAX_STEPS` | the agent reached `maxSteps` without finishing |
| `KOI_AGENT_FAILED` | the agent gave up (repeated errors); the message says why |
| `KOI_NO_PROVIDER` | no model key is configured (see [Models](09-models.md)) |

```ts
try {
  await OrderClerk.processInbox({ since, approvalLimit });
} catch (err: any) {
  if (err.code === "KOI_TIMEOUT") retryLater();
  else throw err;
}
```

## Types

When a `.koi` file is imported, its types are written beside it (`agents/orders.d.koi.ts`): the argument types
of every handler, its `affordance` as documentation, and the options above. `koi types` writes them for every
`.koi` file without running anything; run it before `tsc` in CI:

```json
{ "scripts": { "check": "koi types && tsc --noEmit" } }
```

Commit the `.d.koi.ts` files or generate them in CI, as you prefer.

## Running

- Anything started with npm or npx loads the Koi loader: `npm run dev`, `npm test`, `npx tsx src/main.ts`.
- Started directly, Node needs the loader: `node --import @koi-language/koi/register dist/main.js`.
- If you compile your TypeScript to `dist/` with `tsc`, copy the `agents/` folder next to it, or run the
  TypeScript with `tsx` in production too: `.koi` files are not copied by `tsc`.

## Shipping agents as a package

To publish agents as their own npm package, for other projects to install:

```bash
koi build agents/orders.koi -o dist/orders --name @acme/order-agents
```

It writes `package.json`, `index.js` and `index.d.ts`; the package depends on `@koi-language/koi`.

## Low level

Each exported object has the `Agent` behind it in `$agent`, and the package exports `callAgent(agent, handler,
args, options)` for agents built in code.

Next: [Models](09-models.md).
