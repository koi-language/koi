/**
 * Lets Node (and tsx) import .koi files:
 *
 *   node --import @koi-language/koi/register app.js
 *   tsx  --import @koi-language/koi/register app.ts
 *
 *   import { MyAgent } from "./my-agent.koi";     // the agents that file marks `export agent`
 *   const result = await MyAgent.someHandler({ ... });
 */

import { register } from 'node:module';

// Koi embedded in a backend (this loader is how a backend imports .koi files; the koi CLI never loads it): no .env
// loading, no project .md injected into prompts, no Braxil job watcher (23/11/2026). Set before anything of Koi runs.
process.env.KOI_EMBEDDED ??= '1';

register('./hooks.js', import.meta.url);
