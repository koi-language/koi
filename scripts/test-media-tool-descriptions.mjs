#!/usr/bin/env node
/**
 * Smoke-test the media tool description rewrite against a live backend.
 *
 * What it does:
 *   1. Loads ~/.koi/.token (or honours $KOI_AUTH_TOKEN) and
 *      $KOI_API_URL (defaults to https://api.braxil.ai).
 *   2. Imports generate-image / generate-video / generate-audio.
 *   3. Awaits each tool's `_descriptionReady` so the catalog refresh
 *      has settled.
 *   4. Prints the resulting descriptions and the schema property keys
 *      with their enums (when present).
 *   5. Verifies the catalog block is present and that key params have
 *      populated enums where the live catalog supports it.
 *
 * Usage:
 *   node koi/scripts/test-media-tool-descriptions.mjs
 *   KOI_API_URL=http://localhost:3000 node koi/scripts/test-media-tool-descriptions.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve auth + base URL from env or ~/.koi/.token, in that order.
if (!process.env.KOI_AUTH_TOKEN) {
  const tokenPath = path.join(os.homedir(), '.koi', '.token');
  if (fs.existsSync(tokenPath)) {
    process.env.KOI_AUTH_TOKEN = fs.readFileSync(tokenPath, 'utf8').trim();
  }
}
if (!process.env.KOI_API_URL) process.env.KOI_API_URL = 'https://api.braxil.ai';

if (!process.env.KOI_AUTH_TOKEN) {
  console.error('ERROR: no KOI_AUTH_TOKEN set and ~/.koi/.token missing.');
  process.exit(2);
}

console.log(`Using KOI_API_URL=${process.env.KOI_API_URL}`);
console.log(`Auth token: ${process.env.KOI_AUTH_TOKEN.slice(0, 8)}…`);

const here = path.dirname(new URL(import.meta.url).pathname);
const toolsDir = path.resolve(here, '..', 'src', 'runtime', 'tools', 'media');

const targets = [
  { name: 'generate_image', file: path.join(toolsDir, 'generate-image.js') },
  { name: 'generate_video', file: path.join(toolsDir, 'generate-video.js') },
  { name: 'generate_audio', file: path.join(toolsDir, 'generate-audio.js') },
];

let failed = 0;

for (const t of targets) {
  console.log('\n============================================================');
  console.log(`>>> ${t.name}`);
  console.log('============================================================');
  const mod = await import(pathToFileURL(t.file).href);
  const action = mod.default;

  if (action._descriptionReady) {
    await Promise.race([
      action._descriptionReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('readiness timeout')), 15000)),
    ]).catch((err) => {
      console.error(`  readiness error: ${err.message}`);
    });
  } else {
    console.warn('  (no _descriptionReady promise exposed — rewrite race possible)');
  }

  // Description.
  console.log('\n--- description ---');
  console.log(action.description);

  // Schema props.
  console.log('\n--- schema.properties keys ---');
  const props = action.schema?.properties || {};
  for (const [key, val] of Object.entries(props)) {
    const enumPart = Array.isArray(val.enum) ? ` enum=[${val.enum.join(', ')}]` : '';
    const minMax = (val.minimum != null || val.maximum != null)
      ? ` range=[${val.minimum ?? '-∞'}..${val.maximum ?? '∞'}]`
      : '';
    console.log(`  ${key}: ${val.type || '?'}${enumPart}${minMax}`);
  }

  // Validators.
  const desc = action.description || '';
  const checks = [];
  if (!desc.includes('Active models in the catalog')) {
    checks.push('FAIL: model catalog block missing from description');
  }
  if (t.name === 'generate_image') {
    if (!Array.isArray(props.aspectRatio?.enum)) checks.push('FAIL: aspectRatio is not an enum');
    if (!Array.isArray(props.resolution?.enum)) checks.push('FAIL: resolution is not an enum');
  }
  if (t.name === 'generate_video') {
    if (!Array.isArray(props.aspectRatio?.enum)) checks.push('FAIL: aspectRatio is not an enum');
    if (!Array.isArray(props.resolution?.enum)) checks.push('FAIL: resolution is not an enum');
  }
  if (t.name === 'generate_audio') {
    if (!Array.isArray(props.mode?.enum)) checks.push('FAIL: mode is not an enum');
  }

  if (checks.length === 0) {
    console.log('\n  ✅ all checks passed');
  } else {
    console.log('\n  ❌ failures:');
    for (const c of checks) console.log(`    ${c}`);
    failed += checks.length;
  }
}

console.log('\n------------------------------------------------------------');
if (failed > 0) {
  console.error(`Done — ${failed} failure(s).`);
  process.exit(1);
} else {
  console.log('Done — all tools advertise populated descriptions.');
}
