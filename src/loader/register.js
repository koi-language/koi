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

register('./hooks.js', import.meta.url);
