#!/usr/bin/env node
/**
 * Fetch the pinned Blender LTS into a target directory, for bundling it
 * INSIDE the Braxil app (3D previz renders) — no runtime download.
 *
 * Reuses `installPinnedBlender()` from the runtime so the version pin +
 * URLs + sha256s live in exactly one place (tools/scene3d/_blender.js).
 * UI translations are trimmed: the bundled copy only ever runs headless.
 *
 * Usage:
 *   node scripts/fetch-blender-bundle.mjs --out=<dir> [--platform=<plat>] [--arch=<arch>]
 *
 * Output:
 *   macOS:          <out>/Blender.app                 (→ Braxil.app/Contents/Helpers)
 *                   <out>/braxil_live_surface.dylib   (live viewport → shared IOSurface)
 *   Linux/Windows:  <out>/blender-<ver>-<plat>/blender[.exe]  (→ <bundle>/blender)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { installPinnedBlender, BLENDER_VERSION, LIVE_SURFACE_LIB, liveSurfaceBuildArgs } from '../src/runtime/tools/scene3d/_blender.js';
import { LIVE_SURFACE_C } from '../src/runtime/tools/scene3d/_live-surface-c.js';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) { process.stderr.write(`Unrecognised arg: ${a}\n`); process.exit(1); }
  args[m[1]] = m[2] === undefined ? true : m[2];
}
if (!args.out) {
  process.stderr.write('Usage: node scripts/fetch-blender-bundle.mjs --out=<dir> [--platform=darwin|linux|win32] [--arch=x64|arm64]\n');
  process.exit(1);
}
const platformKey = `${args.platform || process.platform}-${args.arch || process.arch}`;
let last = -1;
try {
  const r = await installPinnedBlender({
    outDir: args.out,
    platformKey,
    trim: true,
    onProgress: (p, label) => {
      const pct = Math.round((p || 0) * 100);
      if (pct !== last && pct % 10 === 0) { last = pct; process.stdout.write(`${label}\n`); }
    },
  });
  process.stdout.write(`Blender ${BLENDER_VERSION} (${platformKey}) → ${r.bin}\n`);
  if (platformKey.startsWith('darwin-')) {
    // The live viewport's shared-memory library sits next to Blender.app.
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'braxil-surface-')), 'live_surface.c');
    fs.writeFileSync(src, LIVE_SURFACE_C, 'utf8');
    const out = path.join(args.out, LIVE_SURFACE_LIB);
    const cc = spawnSync('clang', liveSurfaceBuildArgs(src, out), { encoding: 'utf8' });
    if (cc.status !== 0) throw new Error(`clang ${LIVE_SURFACE_LIB}: ${cc.stderr}`);
    process.stdout.write(`Live surface library → ${out}\n`);
  }
} catch (e) {
  process.stderr.write(`fetch-blender-bundle: ${e.message}\n`);
  process.exit(1);
}
