#!/usr/bin/env node
/**
 * Fetch the pinned ffmpeg/ffprobe pair into a target directory.
 *
 * Used by the GH Actions release workflow to drop the controlled
 * binaries inside the Flutter `.app` (macOS) / app bundle (Linux,
 * Windows) so end-user installs ship with ffmpeg pre-bundled — no
 * runtime download, no first-use latency.
 *
 * Reuses `installPinnedFfmpeg()` from the runtime installer so the
 * version pin + URLs + sha256s live in exactly one place. Bumping
 * the version is a single edit to `ffmpeg-installer.js`.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg-bundle.mjs --out=/path/to/bin
 *
 *   # platform/arch default to process.platform / process.arch (the
 *   # CI runner is already on the target platform). Override when
 *   # building one bundle from a different host, e.g. for testing:
 *   node scripts/fetch-ffmpeg-bundle.mjs --out=/tmp/x --platform=linux --arch=x64
 *
 * Output:
 *   <outDir>/ffmpeg       (or ffmpeg.exe on Windows)
 *   <outDir>/ffprobe      (or ffprobe.exe on Windows)
 *
 * Exit codes:
 *   0  success
 *   1  bad args / install failure (printed to stderr)
 */

import { installPinnedFfmpeg, FFMPEG_VERSION } from '../src/runtime/media/ffmpeg-installer.js';

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) {
      throw new Error(`Unrecognised arg: ${arg} (expected --key=value)`);
    }
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function usageAndExit(code = 1) {
  process.stderr.write(
    `Usage: node scripts/fetch-ffmpeg-bundle.mjs --out=<dir> [--platform=<plat>] [--arch=<arch>]\n` +
    `\n` +
    `  --out       Target directory (created if missing). Required.\n` +
    `  --platform  darwin | linux | win32. Defaults to process.platform.\n` +
    `  --arch      x64 | arm64. Defaults to process.arch.\n`,
  );
  process.exit(code);
}

const args = parseArgs(process.argv);
if (!args.out) usageAndExit(1);

const platformKey = `${args.platform || process.platform}-${args.arch || process.arch}`;

process.stderr.write(`[fetch-ffmpeg-bundle] target=${platformKey} version=${FFMPEG_VERSION} out=${args.out}\n`);

const t0 = Date.now();
let lastPct = -1;
try {
  const result = await installPinnedFfmpeg({
    outDir: args.out,
    platformKey,
    onProgress: (pct, msg) => {
      const p = Math.round(pct * 100);
      if (p === lastPct) return;
      lastPct = p;
      process.stderr.write(`[fetch-ffmpeg-bundle] [${p}%] ${msg}\n`);
    },
  });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`[fetch-ffmpeg-bundle] done in ${took}s\n`);
  process.stdout.write(JSON.stringify({ ...result, platformKey }, null, 2) + '\n');
} catch (err) {
  process.stderr.write(`[fetch-ffmpeg-bundle] FAILED: ${err.message}\n`);
  process.exit(1);
}
