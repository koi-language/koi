/**
 * ffmpeg / ffprobe locator — controlled-binary edition.
 *
 * `ensureFfmpeg()` returns `{ ffmpeg, ffprobe }` (absolute paths). The
 * controlled binary ships as an npm dependency so it lands in
 * `node_modules/` at install time — no runtime download, identical
 * version across every machine that ran `npm install` against the
 * same `package.json`.
 *
 * Versions (PINNED — bump deliberately in package.json):
 *   - `ffmpeg-static@5.3.0`               → ffmpeg 6.0
 *   - `@ffprobe-installer/ffprobe@2.1.2`  → ffprobe 4.4.1
 *
 * Both packages use npm `optionalDependencies` keyed on the current
 * platform/arch, so `npm install` only fetches the binary for the
 * host (≈80 MB, not 240 MB). Re-running `npm install` on a
 * different OS pulls that OS's binary into the same lockfile.
 *
 * Resolution order:
 *   1. `KOI_FFMPEG_PATH` / `KOI_FFPROBE_PATH` env vars — Flutter GUI
 *      sets these to the path of the binaries it ships inside its
 *      own `.app` bundle (see `BundledBinaries` on the Dart side).
 *      Honoured ONLY when both point at files that exist; a stray
 *      `KOI_FFMPEG_PATH=ffmpeg` (bare command name) is ignored.
 *   2. The npm-shipped binary from `ffmpeg-static` /
 *      `@ffprobe-installer/ffprobe`. This is the canonical path —
 *      guaranteed to exist post-`npm install`, identical on every
 *      machine running the same lockfile.
 *   3. PATH lookup — LAST resort, only for the edge case where
 *      node_modules was nuked or the binary inside it got corrupted.
 *      Logs a warning because the version is then host-dependent
 *      and we've already been burned by that (brew ffmpeg 7.x
 *      removed `-movflags -use_edts` while older brew ffmpegs
 *      still accept it — same code, different result).
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const _isWin = process.platform === 'win32';
const _exe = _isWin ? '.exe' : '';

let _cached = null;

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
    const r = spawnSync(p, ['-version'], { timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Resolve the path the `ffmpeg-static` npm dep ships. The package's
 *  default export IS the absolute path on the host's platform — or
 *  null when the platform's optional-dep wasn't installable. */
async function _ffmpegStaticPath() {
  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default || mod;
    return typeof p === 'string' && p ? p : null;
  } catch {
    return null;
  }
}

/** Resolve the path `@ffprobe-installer/ffprobe` exposes. Same idea
 *  as above; the package returns `{ path, version }`. */
async function _ffprobeInstallerPath() {
  try {
    const mod = await import('@ffprobe-installer/ffprobe');
    const p = mod?.default?.path || mod?.path;
    return typeof p === 'string' && p ? p : null;
  } catch {
    return null;
  }
}

/** Public: get the binary paths. Idempotent.
 *
 * `onProgress` is accepted for backward compatibility with the old
 * downloader-based API but is never invoked — the npm-bundled binary
 * has nothing to download at runtime.
 */
export async function ensureFfmpeg({ onProgress } = {}) {  /* eslint-disable-line no-unused-vars */
  if (_cached) return _cached;

  // 1. Env-var override (Flutter bundle). Only respected when it
  //    points at a real file — a bare "ffmpeg" string (the dart-side
  //    BundledBinaries fallback when no bundled binary is found) is
  //    rejected so we still hit the npm dep below.
  const envFf = process.env.KOI_FFMPEG_PATH;
  const envFp = process.env.KOI_FFPROBE_PATH;
  const envFfOk = envFf && fs.existsSync(envFf) && _looksRunnable(envFf);
  const envFpOk = envFp && fs.existsSync(envFp) && _looksRunnable(envFp);
  if (envFfOk && envFpOk) {
    _cached = { ffmpeg: envFf, ffprobe: envFp };
    return _cached;
  }

  // 2. Controlled binary from the pinned npm deps. This is the
  //    canonical path. Either side may fall back to the env-var
  //    value when only one of the two is set.
  const npmFf = await _ffmpegStaticPath();
  const npmFp = await _ffprobeInstallerPath();
  const ff = envFfOk ? envFf : (_looksRunnable(npmFf) ? npmFf : null);
  const fp = envFpOk ? envFp : (_looksRunnable(npmFp) ? npmFp : null);
  if (ff && fp) {
    _cached = { ffmpeg: ff, ffprobe: fp };
    return _cached;
  }

  // 3. PATH fallback — only here because a corrupted or missing
  //    node_modules shouldn't brick every media tool entirely.
  //    Logged so we know we're outside the supported path.
  const pathFf = ff || _which(`ffmpeg${_exe}`);
  const pathFp = fp || _which(`ffprobe${_exe}`);
  if (_looksRunnable(pathFf) && _looksRunnable(pathFp)) {
    console.warn(
      `[ffmpeg-installer] Using system ffmpeg from PATH (${pathFf}, ${pathFp}). ` +
      `The pinned npm binary (ffmpeg-static / @ffprobe-installer/ffprobe) was not ` +
      `found in node_modules — re-run \`npm install\` to restore the controlled version. ` +
      `Host-installed ffmpegs vary across machines and have caused non-reproducible failures.`,
    );
    _cached = { ffmpeg: pathFf, ffprobe: pathFp };
    return _cached;
  }

  throw new Error(
    'ffmpeg / ffprobe unavailable. Run `npm install` to fetch the pinned binaries ' +
    '(ffmpeg-static + @ffprobe-installer/ffprobe), or set KOI_FFMPEG_PATH / ' +
    'KOI_FFPROBE_PATH to absolute paths of existing binaries.',
  );
}
