/**
 * Node module hooks: `import { Agent } from "./agents.koi"` compiles the .koi
 * file in memory (src/compiler/compile-module.js) and loads it as an ES module.
 * Registered by ./register.js.
 */

import { fileURLToPath } from 'url';

let _compile = null;

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !new URL(url).pathname.endsWith('.koi')) {
    return nextLoad(url, context);
  }
  if (!_compile) {
    ({ compileKoiModule: _compile } = await import('../compiler/compile-module.js'));
  }
  const { code } = await _compile(fileURLToPath(url));
  return { format: 'module', source: code, shortCircuit: true };
}
