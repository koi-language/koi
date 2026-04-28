/**
 * ffmpeg / ffprobe locator + auto-installer.
 *
 * `ensureFfmpeg()` returns `{ ffmpeg, ffprobe }` (absolute paths) using
 * the first source that works:
 *
 *   1. PATH lookup — system install (brew, apt, choco, …). Fastest path.
 *   2. Cached static build under `<projectRoot>/.koi/bin/`.
 *   3. Fresh download of a static build for the current OS+arch.
 *
 * Static builds are vendored from well-known mirrors:
 *   - macOS x64/arm64 → evermeet.cx (single universal binary per tool)
 *   - Linux x64/arm64 → johnvansickle.com (release-static tarballs)
 *   - Windows x64     → gyan.dev (release-essentials zip)
 *
 * The cache lives in the project's `.koi/bin/` so installs survive
 * across sessions and multiple koi projects don't fight over `/usr/local`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

function _cacheDir() {
  return path.join(_projectRoot(), '.koi', 'bin');
}

const _isWin = process.platform === 'win32';
const _exe = _isWin ? '.exe' : '';

let _cached = null;       // { ffmpeg, ffprobe }
let _installing = null;   // Promise — dedupe concurrent installers

function _which(cmd) {
  // Synchronous PATH probe. spawnSync('which'/'where') beats parsing
  // PATH ourselves since the OS resolver respects PATHEXT/aliases.
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
    const r = spawnSync(p, ['-version'], { timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Public: get binaries, installing if needed. Idempotent / dedupes concurrent calls. */
export async function ensureFfmpeg({ onProgress } = {}) {
  if (_cached) return _cached;
  if (_installing) return _installing;

  // 1. PATH lookup.
  const pathFf = _which(`ffmpeg${_exe}`);
  const pathFp = _which(`ffprobe${_exe}`);
  if (_looksRunnable(pathFf) && _looksRunnable(pathFp)) {
    _cached = { ffmpeg: pathFf, ffprobe: pathFp };
    return _cached;
  }

  // 2. Cached download.
  const cacheDir = _cacheDir();
  const cacheFf = path.join(cacheDir, `ffmpeg${_exe}`);
  const cacheFp = path.join(cacheDir, `ffprobe${_exe}`);
  if (_looksRunnable(cacheFf) && _looksRunnable(cacheFp)) {
    _cached = { ffmpeg: cacheFf, ffprobe: cacheFp };
    return _cached;
  }

  // 3. Fresh install.
  _installing = (async () => {
    onProgress?.(0, 'Resolving ffmpeg download…');
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      await _installForCurrentPlatform(cacheDir, onProgress);
    } catch (err) {
      _installing = null;
      throw new Error(`Failed to install ffmpeg: ${err.message}`);
    }
    if (!_looksRunnable(cacheFf) || !_looksRunnable(cacheFp)) {
      _installing = null;
      throw new Error('ffmpeg installed but binaries are not runnable — see .koi/bin/');
    }
    _cached = { ffmpeg: cacheFf, ffprobe: cacheFp };
    _installing = null;
    return _cached;
  })();
  return _installing;
}

// ── Platform-specific install logic ──────────────────────────────────

async function _installForCurrentPlatform(cacheDir, onProgress) {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return _installMac(cacheDir, onProgress);
  if (platform === 'linux') return _installLinux(cacheDir, arch, onProgress);
  if (platform === 'win32') return _installWindows(cacheDir, onProgress);
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

async function _installMac(cacheDir, onProgress) {
  // evermeet.cx serves universal (x64+arm64) static builds, one binary
  // per tool, downloaded as zip.
  await _downloadAndExtractZip(
    'https://evermeet.cx/ffmpeg/getrelease/zip',
    cacheDir,
    'ffmpeg',
    onProgress,
    0.0, 0.5,
  );
  await _downloadAndExtractZip(
    'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
    cacheDir,
    'ffprobe',
    onProgress,
    0.5, 1.0,
  );
  fs.chmodSync(path.join(cacheDir, 'ffmpeg'), 0o755);
  fs.chmodSync(path.join(cacheDir, 'ffprobe'), 0o755);
}

async function _installLinux(cacheDir, arch, onProgress) {
  // johnvansickle.com hosts static gpl builds for amd64 and arm64.
  const slug = arch === 'arm64' ? 'arm64' : (arch === 'arm' ? 'armhf' : 'amd64');
  const url = `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${slug}-static.tar.xz`;
  const tmpFile = path.join(cacheDir, `ffmpeg-${slug}.tar.xz`);
  await _downloadFile(url, tmpFile, onProgress, 0.0, 0.7);
  onProgress?.(0.75, 'Extracting…');
  // Use system tar — universally present on Linux distros.
  const r = spawnSync('tar', ['-xJf', tmpFile, '-C', cacheDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar extraction failed');
  // Move the two binaries up out of the versioned subdir, drop the rest.
  const subdirs = fs.readdirSync(cacheDir).filter((n) =>
    n.startsWith('ffmpeg-') && fs.statSync(path.join(cacheDir, n)).isDirectory());
  if (subdirs.length === 0) throw new Error('ffmpeg archive layout unexpected');
  const subdir = path.join(cacheDir, subdirs[0]);
  fs.renameSync(path.join(subdir, 'ffmpeg'), path.join(cacheDir, 'ffmpeg'));
  fs.renameSync(path.join(subdir, 'ffprobe'), path.join(cacheDir, 'ffprobe'));
  fs.rmSync(subdir, { recursive: true, force: true });
  fs.unlinkSync(tmpFile);
  fs.chmodSync(path.join(cacheDir, 'ffmpeg'), 0o755);
  fs.chmodSync(path.join(cacheDir, 'ffprobe'), 0o755);
  onProgress?.(1.0, 'Installed');
}

async function _installWindows(cacheDir, onProgress) {
  // gyan.dev's "release essentials" zip contains ffmpeg.exe + ffprobe.exe
  // (essentials drops ffplay and a few rarely-used codecs — half the
  // size of the full build, all we need for our pipeline).
  const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const tmpFile = path.join(cacheDir, 'ffmpeg-windows.zip');
  await _downloadFile(url, tmpFile, onProgress, 0.0, 0.7);
  onProgress?.(0.75, 'Extracting…');
  await _extractZipNative(tmpFile, cacheDir);
  // The zip extracts to ffmpeg-N.N.N-essentials_build/bin/{ffmpeg,ffprobe}.exe.
  const subdirs = fs.readdirSync(cacheDir).filter((n) =>
    n.startsWith('ffmpeg-') && fs.statSync(path.join(cacheDir, n)).isDirectory());
  if (subdirs.length === 0) throw new Error('ffmpeg archive layout unexpected');
  const subdir = path.join(cacheDir, subdirs[0]);
  const binDir = path.join(subdir, 'bin');
  fs.renameSync(path.join(binDir, 'ffmpeg.exe'), path.join(cacheDir, 'ffmpeg.exe'));
  fs.renameSync(path.join(binDir, 'ffprobe.exe'), path.join(cacheDir, 'ffprobe.exe'));
  fs.rmSync(subdir, { recursive: true, force: true });
  fs.unlinkSync(tmpFile);
  onProgress?.(1.0, 'Installed');
}

// ── Download / extraction helpers ────────────────────────────────────

async function _downloadFile(url, dest, onProgress, fromPct = 0, toPct = 1) {
  // Follow redirects (evermeet, johnvansickle, gyan all 302 to mirrors).
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const out = fs.createWriteStream(dest);
  const reader = Readable.fromWeb(res.body);
  reader.on('data', (chunk) => {
    received += chunk.length;
    if (total && onProgress) {
      const local = received / total;
      onProgress(fromPct + (toPct - fromPct) * local,
        `Downloading ffmpeg ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    }
  });
  await pipeline(reader, out);
}

async function _downloadAndExtractZip(url, cacheDir, expectedName, onProgress, fromPct, toPct) {
  const tmp = path.join(cacheDir, `${expectedName}.zip`);
  await _downloadFile(url, tmp, onProgress, fromPct, fromPct + (toPct - fromPct) * 0.7);
  onProgress?.(fromPct + (toPct - fromPct) * 0.8, `Extracting ${expectedName}…`);
  await _extractZipNative(tmp, cacheDir);
  fs.unlinkSync(tmp);
}

async function _extractZipNative(zipPath, destDir) {
  // Prefer system unzip (everywhere except minimal Windows containers).
  // Fallback to PowerShell Expand-Archive on Windows.
  if (_isWin) {
    return new Promise((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
        { stdio: 'inherit' },
      );
      ps.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`)));
      ps.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const cp = spawn('unzip', ['-oq', zipPath, '-d', destDir], { stdio: 'inherit' });
    cp.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`)));
    cp.on('error', reject);
  });
}
