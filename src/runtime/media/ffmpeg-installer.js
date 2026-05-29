/**
 * ffmpeg / ffprobe locator — pinned-release edition.
 *
 * `ensureFfmpeg()` returns `{ ffmpeg, ffprobe }` (absolute paths)
 * pointing at a SPECIFIC, version-locked ffmpeg/ffprobe pair that
 * is byte-identical on every machine. There is no "latest" — bumping
 * the version is a deliberate edit of the ASSETS table below.
 *
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  Pinned version: ffmpeg 8.1.1 (released 2025-11)              ║
 * ║  macOS:    evermeet.cx versioned archives                      ║
 * ║  Linux:    BtbN/FFmpeg-Builds release autobuild-2026-05-29-14-08 ║
 * ║  Windows:  same BtbN release                                   ║
 * ║  All assets pinned by URL AND verified by sha256 post-download. ║
 * ║  Any drift on either side → integrity check fails → install     ║
 * ║  aborts loudly (we don't silently fall back to a "best effort"  ║
 * ║  version that could behave differently).                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Resolution order:
 *   1. `KOI_FFMPEG_PATH` / `KOI_FFPROBE_PATH` env vars — Flutter GUI
 *      sets these when it ships its own bundled binaries inside the
 *      `.app`. Honoured only when both point at existing files; a
 *      bare `KOI_FFMPEG_PATH=ffmpeg` (Dart-side fallback when no
 *      bundle is found) is rejected so we still hit the pinned path.
 *   2. Pinned cache at `~/.koi/bin/ffmpeg-<version>/{ffmpeg,ffprobe}`.
 *      Global (not per-project) so 5 koi projects share one ~80 MB
 *      install instead of 5×80.
 *   3. Download + verify + extract → populate the cache, then return.
 *   4. PATH fallback — last-resort emergency lever, logs a warning.
 *      A system ffmpeg's version varies host-to-host (we've been
 *      bitten: brew ffmpeg 7.x removed `-movflags -use_edts` mid-
 *      encode, while older brew ffmpegs still accept it). Only used
 *      when the controlled install fails AND PATH has a runnable pair.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ── Pinned version + asset table ─────────────────────────────────────

/** Pinned ffmpeg version. Bump via a coordinated edit of this constant
 *  + the ASSETS table (URLs + sha256). Old cached versions sit alongside
 *  on disk and aren't auto-cleaned — `rm -rf ~/.koi/bin/ffmpeg-*` if
 *  you care about disk. */
const PINNED_VERSION = '8.1.1';

/** BtbN release tag. Heads-up: BtbN creates a NEW `autobuild-YYYY-MM-DD-HH-MM`
 *  release on every build and PRUNES old ones — a pinned dated tag 404s within
 *  a couple of weeks. When that happens, repin: list the current releases via
 *  `gh api repos/BtbN/FFmpeg-Builds/releases` (or the GitHub releases API),
 *  grab the newest `autobuild-*` tag + its `ffmpeg-n8.1.1-<N>-g<hash>` stem,
 *  download the 4 `*-gpl-8.1.*` assets, recompute their sha256, and update the
 *  table below. Linux + Windows assets resolve against this tag. */
const BTBN_TAG = 'autobuild-2026-05-29-14-08';
const BTBN_FILE_STEM = 'ffmpeg-n8.1.1-9-g58d4114d36';

const BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;

/** Per-platform/arch download recipe. Each entry is processed by
 *  `_fetchAndExtract()` below. Keys are `<platform>-<arch>`. */
const ASSETS = {
  // ── macOS — evermeet ships one binary per zip (universal x64+arm64). ──
  'darwin-x64': {
    parts: [
      {
        kind: 'binary-zip',
        url: `https://evermeet.cx/ffmpeg/ffmpeg-${PINNED_VERSION}.zip`,
        sha256: '4610988e2f54c243c50da73a09e4e2c36d9bb77546f9aa6c84cb328dcb1a98c1',
        binaryName: 'ffmpeg',
      },
      {
        kind: 'binary-zip',
        url: `https://evermeet.cx/ffmpeg/ffprobe-${PINNED_VERSION}.zip`,
        sha256: 'aeade29dee3c3844e9bcc974f4ae4b29cc4f87994177d77003a8589fa531009e',
        binaryName: 'ffprobe',
      },
    ],
  },
  'darwin-arm64': null, // populated below — same as darwin-x64 (universal).

  // ── Linux — BtbN tarball contains bin/{ffmpeg,ffprobe}. ──
  'linux-x64': {
    parts: [
      {
        kind: 'tar-xz',
        url: `${BTBN_BASE}/${BTBN_FILE_STEM}-linux64-gpl-8.1.tar.xz`,
        sha256: '1ae376a8a603ff68e0b5917796b0b9005e1d588cad88c99b32fb7de0b73db7c6',
        binariesIn: 'bin', // <archive-stem>/bin/{ffmpeg,ffprobe}
      },
    ],
  },
  'linux-arm64': {
    parts: [
      {
        kind: 'tar-xz',
        url: `${BTBN_BASE}/${BTBN_FILE_STEM}-linuxarm64-gpl-8.1.tar.xz`,
        sha256: '6bdf78a620f060924f4fb8f5f82cd2ad78d501875055ade864246f61b9c83122',
        binariesIn: 'bin',
      },
    ],
  },

  // ── Windows — BtbN zip with bin/{ffmpeg,ffprobe}.exe. ──
  'win32-x64': {
    parts: [
      {
        kind: 'zip-binaries',
        url: `${BTBN_BASE}/${BTBN_FILE_STEM}-win64-gpl-8.1.zip`,
        sha256: 'efe11c1e305371896c7887fd02275d9664794371537683373d574bb7acbb30e7',
        binariesIn: 'bin',
      },
    ],
  },
  'win32-arm64': {
    parts: [
      {
        kind: 'zip-binaries',
        url: `${BTBN_BASE}/${BTBN_FILE_STEM}-winarm64-gpl-8.1.zip`,
        sha256: 'ed81ff67784c92f012db7f94099a3e60d00e3fa6c41151a4fcc647bea173195f',
        binariesIn: 'bin',
      },
    ],
  },
};
ASSETS['darwin-arm64'] = ASSETS['darwin-x64']; // evermeet's mac builds are universal

// ── Internals ────────────────────────────────────────────────────────

const _isWin = process.platform === 'win32';
const _exe = _isWin ? '.exe' : '';

let _cached = null;
let _installing = null;

function _platformKey() {
  return `${process.platform}-${process.arch}`;
}

function _cacheDir() {
  // Global, not per-project — one ~80 MB install shared across all
  // koi projects on this user account.
  return path.join(os.homedir(), '.koi', 'bin', `ffmpeg-${PINNED_VERSION}`);
}

function _which(cmd) {
  const probe = _isWin ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const line = (r.stdout || '').split(/\r?\n/).find((s) => s.trim());
  return line ? line.trim() : null;
}

function _looksRunnable(p) {
  if (!p) return false;
  if (!fs.existsSync(p)) return false;
  try {
    // 30 s, not 5 — macOS Gatekeeper runs a one-time notarization
    // check the very first time a downloaded binary executes, which
    // routinely takes 5-8 s on the evermeet builds. Subsequent runs
    // cache the verdict and are ~30 ms. A short timeout here
    // false-positives "not runnable" on every fresh install.
    const r = spawnSync(p, ['-version'], { timeout: 30000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function _sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function _downloadFile(url, dest, onProgress, fromPct = 0, toPct = 1) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const out = fs.createWriteStream(dest);
  const reader = Readable.fromWeb(res.body);
  reader.on('data', (chunk) => {
    received += chunk.length;
    if (total && onProgress) {
      const pct = fromPct + (toPct - fromPct) * (received / total);
      onProgress(pct, `Downloading ffmpeg ${PINNED_VERSION}… ${Math.round(received / 1e6)}/${Math.round(total / 1e6)} MB`);
    }
  });
  await pipeline(reader, out);
}

function _runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Extract a single named binary out of an evermeet-style zip whose
 *  contents are just the binary at the root. */
async function _extractMacZipBinary(zipPath, outPath) {
  const dir = path.dirname(outPath);
  // `unzip -p` streams a single file to stdout; we pipe it to disk so
  // we don't depend on extracting + finding the right entry. The mac
  // evermeet archive contains exactly one entry whose name matches the
  // binary (e.g., "ffmpeg" or "ffprobe").
  const child = spawn('unzip', ['-p', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(outPath);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    child.stdout.pipe(out);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`unzip ${path.basename(zipPath)} exited ${code}: ${stderr.slice(-300)}`));
    });
  });
  fs.chmodSync(outPath, 0o755);
  // Verify the extracted binary actually starts with a Mach-O magic — a
  // partial-stream or wrong-entry extraction would produce garbage that
  // _looksRunnable would catch later anyway, but failing here makes the
  // error pinpoint the bad asset.
  const head = fs.readFileSync(outPath, { length: 4 });
  const magic = head.readUInt32BE(0);
  // Mach-O 64-bit (universal & single-arch) magics
  const ok = [0xFEEDFACF, 0xCFFAEDFE, 0xCAFEBABE, 0xBEBAFECA].includes(magic);
  if (!ok) throw new Error(`extracted ${path.basename(outPath)} has wrong magic 0x${magic.toString(16)} — archive layout changed?`);
}

/** Extract bin/{ffmpeg,ffprobe} from a BtbN-style tar.xz. */
async function _extractTarXzBinaries(tarPath, outDir, binariesIn) {
  // System tar on macOS/Linux handles .tar.xz natively. Extract into
  // a temp staging dir so we can pluck just the binaries we want.
  const stage = path.join(outDir, `.stage-${path.basename(tarPath, '.tar.xz')}`);
  fs.mkdirSync(stage, { recursive: true });
  try {
    await _runChild('tar', ['-xJf', tarPath, '-C', stage]);
    // Find the single top-level dir.
    const top = fs.readdirSync(stage).find((n) => fs.statSync(path.join(stage, n)).isDirectory());
    if (!top) throw new Error(`tar layout unexpected — no top-level dir in ${path.basename(tarPath)}`);
    for (const name of ['ffmpeg', 'ffprobe']) {
      const src = path.join(stage, top, binariesIn, name);
      const dst = path.join(outDir, name);
      if (!fs.existsSync(src)) throw new Error(`expected ${binariesIn}/${name} not found in ${path.basename(tarPath)}`);
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Extract bin/{ffmpeg,ffprobe}.exe from a BtbN-style Windows zip. */
async function _extractZipBinaries(zipPath, outDir, binariesIn) {
  const stage = path.join(outDir, `.stage-${path.basename(zipPath, '.zip')}`);
  fs.mkdirSync(stage, { recursive: true });
  try {
    if (_isWin) {
      // Windows 10/11 ship `tar` (libarchive) that handles zip too —
      // saves us a PowerShell process spin-up.
      await _runChild('tar', ['-xf', zipPath, '-C', stage]);
    } else {
      await _runChild('unzip', ['-q', zipPath, '-d', stage]);
    }
    const top = fs.readdirSync(stage).find((n) => fs.statSync(path.join(stage, n)).isDirectory());
    if (!top) throw new Error(`zip layout unexpected — no top-level dir in ${path.basename(zipPath)}`);
    for (const name of [`ffmpeg${_exe}`, `ffprobe${_exe}`]) {
      const src = path.join(stage, top, binariesIn, name);
      const dst = path.join(outDir, name);
      if (!fs.existsSync(src)) throw new Error(`expected ${binariesIn}/${name} not found in ${path.basename(zipPath)}`);
      fs.copyFileSync(src, dst);
      if (!_isWin) fs.chmodSync(dst, 0o755);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function _fetchAndExtract(recipe, cacheDir, onProgress, fromPct, toPct) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = path.join(cacheDir, `.download-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await _downloadFile(recipe.url, tmp, onProgress, fromPct, fromPct + (toPct - fromPct) * 0.85);
    const got = await _sha256File(tmp);
    if (got !== recipe.sha256) {
      throw new Error(
        `sha256 mismatch for ${path.basename(recipe.url)}\n` +
        `  expected: ${recipe.sha256}\n  got:      ${got}\n` +
        `Refusing to use a binary that doesn't match the pinned hash.`,
      );
    }
    onProgress?.(fromPct + (toPct - fromPct) * 0.9, `Verifying ${path.basename(recipe.url)}…`);
    if (recipe.kind === 'binary-zip') {
      const outName = recipe.binaryName + _exe;
      await _extractMacZipBinary(tmp, path.join(cacheDir, outName));
    } else if (recipe.kind === 'tar-xz') {
      await _extractTarXzBinaries(tmp, cacheDir, recipe.binariesIn);
    } else if (recipe.kind === 'zip-binaries') {
      await _extractZipBinaries(tmp, cacheDir, recipe.binariesIn);
    } else {
      throw new Error(`unknown recipe kind: ${recipe.kind}`);
    }
    onProgress?.(toPct, 'Installed');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** The pinned ffmpeg version this installer targets. Exported so build
 *  scripts (e.g. the GH Actions step that bundles ffmpeg into the
 *  Flutter .app) can stamp the version into manifests / file names. */
export const FFMPEG_VERSION = PINNED_VERSION;

/** Install the pinned ffmpeg/ffprobe pair into an arbitrary directory.
 *  Used by `ensureFfmpeg()` for the cache, and by the bundle script in
 *  CI to drop the binaries inside the Flutter `.app` before signing.
 *
 *  @param {{
 *    outDir: string,
 *    platformKey?: string,       // defaults to `<process.platform>-<process.arch>`
 *    onProgress?: (pct: number, msg: string) => void,
 *  }} opts
 *  @returns {Promise<{ ffmpeg: string, ffprobe: string, version: string }>}
 */
export async function installPinnedFfmpeg({ outDir, platformKey, onProgress } = {}) {
  if (!outDir) throw new Error('installPinnedFfmpeg: outDir is required');
  const key = platformKey || _platformKey();
  const recipe = ASSETS[key];
  if (!recipe) throw new Error(`No pinned ffmpeg recipe for platform "${key}". Supported: ${Object.keys(ASSETS).join(', ')}.`);
  fs.mkdirSync(outDir, { recursive: true });
  onProgress?.(0, `Resolving ffmpeg ${PINNED_VERSION} for ${key}…`);
  const n = recipe.parts.length;
  for (let i = 0; i < n; i++) {
    await _fetchAndExtract(recipe.parts[i], outDir, onProgress, i / n, (i + 1) / n);
  }
  const ff = path.join(outDir, `ffmpeg${_exe}`);
  const fp = path.join(outDir, `ffprobe${_exe}`);
  if (!fs.existsSync(ff) || !fs.existsSync(fp)) {
    throw new Error(`ffmpeg install to ${outDir} produced an unexpected layout (missing ffmpeg or ffprobe).`);
  }
  return { ffmpeg: ff, ffprobe: fp, version: PINNED_VERSION };
}

/** Get the controlled ffmpeg/ffprobe binary paths. Idempotent.
 *  Downloads + installs the pinned version on first call; subsequent
 *  calls return cached paths in O(1). Concurrent first calls dedupe
 *  on a shared promise so we don't trigger N parallel downloads. */
export async function ensureFfmpeg({ onProgress } = {}) {
  if (_cached) return _cached;
  if (_installing) return _installing;

  // 1. Env-var override (Flutter bundle).
  const envFf = process.env.KOI_FFMPEG_PATH;
  const envFp = process.env.KOI_FFPROBE_PATH;
  if (envFf && envFp && _looksRunnable(envFf) && _looksRunnable(envFp)) {
    _cached = { ffmpeg: envFf, ffprobe: envFp };
    return _cached;
  }

  // 2. Pinned cache.
  const cacheDir = _cacheDir();
  const cacheFf = path.join(cacheDir, `ffmpeg${_exe}`);
  const cacheFp = path.join(cacheDir, `ffprobe${_exe}`);
  if (_looksRunnable(cacheFf) && _looksRunnable(cacheFp)) {
    _cached = { ffmpeg: cacheFf, ffprobe: cacheFp };
    return _cached;
  }

  // 3. Fresh install with sha256 verification.
  _installing = (async () => {
    try {
      // Reuse the same install path the CI bundle step uses (single
      // source of truth for download + verify + extract). Skips the
      // post-install _looksRunnable check on macOS — first execution
      // of an evermeet binary triggers a 6-10 s Gatekeeper notarization
      // lookup that would false-trip the timeout. sha256 + magic-byte
      // verification inside _fetchAndExtract is sufficient.
      const { ffmpeg, ffprobe } = await installPinnedFfmpeg({
        outDir: cacheDir,
        onProgress,
      });
      _cached = { ffmpeg, ffprobe };
      _installing = null;
      return _cached;
    } catch (installErr) {
      // 4. PATH fallback — only when the controlled install fails AND
      //    a runnable system pair exists. Warn loudly so the divergence
      //    is visible in the logs.
      const pathFf = _which(`ffmpeg${_exe}`);
      const pathFp = _which(`ffprobe${_exe}`);
      if (_looksRunnable(pathFf) && _looksRunnable(pathFp)) {
        console.warn(
          `[ffmpeg-installer] Controlled install of ffmpeg ${PINNED_VERSION} failed (${installErr.message}). ` +
          `Falling back to system ffmpeg on PATH (${pathFf}). ` +
          `Version may differ from the pinned build; results are not reproducible. ` +
          `Restore: ensure network access, then \`rm -rf ${cacheDir}\` and rerun.`,
        );
        _cached = { ffmpeg: pathFf, ffprobe: pathFp };
        _installing = null;
        return _cached;
      }
      _installing = null;
      throw new Error(
        `ffmpeg unavailable: pinned install failed (${installErr.message}) ` +
        `and no system ffmpeg on PATH. Check network access or set ` +
        `KOI_FFMPEG_PATH / KOI_FFPROBE_PATH to existing binaries.`,
      );
    }
  })();
  return _installing;
}
