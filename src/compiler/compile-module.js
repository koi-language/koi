/**
 * Compile one .koi file into an ES module, in memory, for `import ... from "./x.koi"`.
 *
 * Used by the Node loader (src/loader/) and by `koi types`. The module exports
 * the agents the file marks `export agent`, each as an object with one async
 * method per public handler (see runtime/library.js), and imports the runtime
 * from THIS Koi installation, so it needs nothing in the importer's node_modules.
 *
 * Beside the source it writes `<name>.d.koi.ts`, the declaration TypeScript
 * reads for `./<name>.koi` (with "allowArbitraryExtensions": true).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import ts from 'typescript';
import { KoiTranspiler } from './transpiler.js';
import { describeAgents, generateDts } from './package-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_INDEX = pathToFileURL(path.resolve(__dirname, '../runtime/index.js')).href;

/** Where TypeScript looks for the types of `./<name>.koi`. */
export function typesPathFor(sourcePath) {
  const dir = path.dirname(sourcePath);
  return path.join(dir, `${path.basename(sourcePath, '.koi')}.d.koi.ts`);
}

function _located(err, file) {
  const loc = err.location?.start;
  const where = loc ? `${file}:${loc.line}:${loc.column}` : file;
  const e = new Error(`Koi: ${where}: ${err.message}`);
  e.cause = err;
  return e;
}

/**
 * @param {string} sourcePath absolute path of the .koi file
 * @param {{ writeTypes?: boolean }} [options]
 * @returns {Promise<{ code: string, dts: string, exported: string[] }>}
 */
export async function compileKoiModule(sourcePath, { writeTypes = true } = {}) {
  const { parse } = await import('./parser.js');
  const source = fs.readFileSync(sourcePath, 'utf8');

  let ast;
  try {
    ast = parse(source);
  } catch (err) {
    throw _located(err, sourcePath);
  }

  // Only what THIS file exports: imported .koi files are merged into the AST below.
  const exported = (ast.declarations || [])
    .filter((d) => d.type === 'AgentDecl' && d.exported)
    .map((d) => d.name.name);

  const { ImportResolver } = await import('./import-resolver.js');
  const resolver = new ImportResolver(parse);
  try {
    ast = await resolver.resolveImports(ast, sourcePath);
  } catch (err) {
    throw _located(err, err.sourceFile || sourcePath);
  }

  const transpiler = new KoiTranspiler(path.basename(sourcePath), {
    outputPath: sourcePath + '.mjs', // virtual: relative imports resolve from the .koi's folder
    externalImports: resolver.externalImports,
    library: true,
    runtimeSpecifier: RUNTIME_INDEX,
    exportNames: exported,
  });
  let tsCode;
  try {
    ({ code: tsCode } = transpiler.transpile(ast));
  } catch (err) {
    throw _located(err, sourcePath);
  }

  // Handler bodies may carry TypeScript syntax: strip it.
  const { outputText: code } = ts.transpileModule(tsCode, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: path.basename(sourcePath) + '.ts',
  });

  const agents = describeAgents(ast).filter((a) => exported.includes(a.name));
  const dts = generateDts(agents);
  if (writeTypes) {
    const typesPath = typesPathFor(sourcePath);
    let current = null;
    try { current = fs.readFileSync(typesPath, 'utf8'); } catch { /* not there yet */ }
    if (current !== dts) {
      try { fs.writeFileSync(typesPath, dts); } catch { /* read-only tree: types are optional */ }
    }
  }

  return { code, dts, exported };
}
