/**
 * Blender sidecar for 3D previz.
 *
 * Braxil drives an UNMODIFIED Blender as a separate headless process
 * (`blender -b --factory-startup -P build_scene.py -- …`). Nothing of
 * Blender is linked into the engine, so the engine and Blender stay two
 * programs talking through files.
 *
 * Blender SHIPS INSIDE Braxil (one product): the release build drops the
 * pinned LTS into the app bundle (scripts/fetch-blender-bundle.mjs) and the
 * GUI exports its path as KOI_BLENDER_PATH. Resolution order:
 *   1. KOI_BLENDER_PATH                  (the copy inside Braxil)
 *   2. next to the engine binary         (same bundle, engine started alone)
 *   3. ~/.koi/blender/<pinned install>   (dev only: downloaded on demand)
 *   4. a system install (/Applications/Blender.app, `blender` on PATH)
 *
 * The pinned build is an LTS so the bpy API the script targets stays put.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { takeSlot } from './_blender-pool.js';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { BUILD_SCENE_PY } from './_build-scene-py.js';
import { BUILD_MODEL_PY } from './_build-model-py.js';
import { RAGDOLL_PY } from './_ragdoll-py.js';
import { LIVE_SURFACE_C } from './_live-surface-c.js';

export const BLENDER_VERSION = '4.5.15';
const _SERIES = 'Blender4.5';
const _BASE = `https://download.blender.org/release/${_SERIES}`;

// sha256 from https://download.blender.org/release/Blender4.5/blender-4.5.15.sha256
const _RECIPES = {
  'darwin-arm64': {
    file: `blender-${BLENDER_VERSION}-macos-arm64.dmg`,
    sha256: 'bfbc0bda099d1ab7aef0992a584f872f58bed9bb491210ad45f9ca071aa2e688',
    bin: 'Blender.app/Contents/MacOS/Blender',
  },
  'darwin-x64': {
    file: `blender-${BLENDER_VERSION}-macos-x64.dmg`,
    sha256: '3801a97619292a012ede0e855ee705ae872a680474845297b777254f7f21ed78',
    bin: 'Blender.app/Contents/MacOS/Blender',
  },
  'linux-x64': {
    file: `blender-${BLENDER_VERSION}-linux-x64.tar.xz`,
    sha256: '0d2b8bb2efe97e6c8eb57de6b7322f8800e1984e3125b60decca5f6771e4773e',
    bin: `blender-${BLENDER_VERSION}-linux-x64/blender`,
  },
  'win32-x64': {
    file: `blender-${BLENDER_VERSION}-windows-x64.zip`,
    sha256: '52dd02fd74877fa08e74b67d7854cf32468a232c02aaa19b6844c91285574f8d',
    bin: `blender-${BLENDER_VERSION}-windows-x64/blender.exe`,
  },
  'win32-arm64': {
    file: `blender-${BLENDER_VERSION}-windows-arm64.zip`,
    sha256: 'a095662a0c0063ccfb3d50760462d4a3cc74e6ee20880e85f639c28bc323db93',
    bin: `blender-${BLENDER_VERSION}-windows-arm64/blender.exe`,
  },
};

function _home() {
  return process.env.HOME || os.homedir();
}

export function blenderDir() {
  return path.join(_home(), '.koi', 'blender');
}

let _cached = null;
let _installing = null;

function _versionOf(bin) {
  try {
    // Generous timeout: Gatekeeper verifies a freshly downloaded app once.
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) return null;
    const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout || '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function _systemCandidates() {
  const out = [];
  if (process.platform === 'darwin') {
    out.push('/Applications/Blender.app/Contents/MacOS/Blender');
    out.push(path.join(_home(), 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  } else if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const base = path.join(pf, 'Blender Foundation');
    try {
      for (const d of fs.readdirSync(base)) out.push(path.join(base, d, 'blender.exe'));
    } catch { /* not installed */ }
  } else {
    out.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, ['blender'], { encoding: 'utf8' });
  if (r.status === 0) {
    const line = (r.stdout || '').split(/\r?\n/).find((s) => s.trim());
    if (line) out.push(line.trim());
  }
  return out;
}

function _major(v) {
  return Number(String(v || '0').split('.')[0]) || 0;
}

/** Blender inside the Braxil bundle, located from the engine binary. */
function _bundledCandidates() {
  const exeDir = path.dirname(process.execPath);
  const recipe = _RECIPES[`${process.platform}-${process.arch}`];
  if (process.platform === 'darwin') {
    // Engine at <app>/Contents/Resources/braxil → <app>/Contents/Helpers.
    return [path.join(exeDir, '..', 'Helpers', 'Blender.app', 'Contents', 'MacOS', 'Blender')];
  }
  return recipe ? [path.join(exeDir, 'blender', recipe.bin)] : [];
}

/** Returns `{ bin, version }` without installing anything, or null. */
export function findBlender() {
  if (_cached && fs.existsSync(_cached.bin)) return _cached;
  const env = process.env.KOI_BLENDER_PATH;
  if (env && fs.existsSync(env)) {
    const v = _versionOf(env);
    if (v) return (_cached = { bin: env, version: v, source: 'env' });
  }
  for (const b of _bundledCandidates()) {
    if (!fs.existsSync(b)) continue;
    const v = _versionOf(b);
    if (v) return (_cached = { bin: b, version: v, source: 'bundled' });
  }
  const recipe = _RECIPES[`${process.platform}-${process.arch}`];
  if (recipe) {
    const pinned = path.join(blenderDir(), recipe.bin);
    if (fs.existsSync(pinned)) {
      const v = _versionOf(pinned);
      if (v) return (_cached = { bin: pinned, version: v, source: 'pinned' });
    }
  }
  for (const c of _systemCandidates()) {
    if (!fs.existsSync(c)) continue;
    const v = _versionOf(c);
    // The script targets the 4.x LTS bpy API; 5.x is handled where the
    // API moved, older than 4.2 lacks EEVEE Next and is rejected.
    if (v && (_major(v) >= 5 || (_major(v) === 4 && Number(v.split('.')[1]) >= 2))) {
      return (_cached = { bin: c, version: v, source: 'system' });
    }
  }
  return null;
}

async function _sha256(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function _download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastTick = 0;
  const rd = Readable.fromWeb(res.body);
  rd.on('data', (chunk) => {
    got += chunk.length;
    const now = Date.now();
    if (onProgress && total && now - lastTick > 400) {
      lastTick = now;
      onProgress(0.9 * (got / total), `Downloading Blender ${BLENDER_VERSION}… ${Math.round(got / 1e6)}/${Math.round(total / 1e6)} MB`);
    }
  });
  await pipeline(rd, fs.createWriteStream(dest));
}

function _run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

// Parts of the Blender distribution a headless previz renderer never
// touches (UI translations ≈ 66 MB). Dropped from bundled copies.
const _TRIM = [path.join('datafiles', 'locale')];

function _trim(dir, recipe) {
  const root = path.join(dir, recipe.bin.startsWith('Blender.app')
    ? path.join('Blender.app', 'Contents', 'Resources')
    : path.dirname(recipe.bin));
  const series = BLENDER_VERSION.split('.').slice(0, 2).join('.');
  for (const rel of _TRIM) fs.rmSync(path.join(root, series, rel), { recursive: true, force: true });
}

/**
 * Download + verify + unpack the pinned Blender into `outDir` (default:
 * ~/.koi/blender). Used at run time in dev and by the release build to put
 * Blender inside the app bundle.
 */
export async function installPinnedBlender({ outDir, platformKey, onProgress, trim = false } = {}) {
  return _install(onProgress, { dir: outDir, key: platformKey, trim });
}

async function _install(onProgress, { dir: outDir, key: platformKey, trim = false } = {}) {
  const key = platformKey || `${process.platform}-${process.arch}`;
  const recipe = _RECIPES[key];
  if (!recipe) throw new Error(`No Blender build for ${key}. Install Blender ≥ 4.2 and set KOI_BLENDER_PATH.`);
  const dir = outDir || blenderDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `${recipe.file}.part`);
  onProgress?.(0, `Downloading Blender ${BLENDER_VERSION}…`);
  await _download(`${_BASE}/${recipe.file}`, archive, onProgress);
  const sum = await _sha256(archive);
  if (sum !== recipe.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`Blender download checksum mismatch (${sum.slice(0, 12)}…)`);
  }
  onProgress?.(0.92, 'Installing Blender…');
  try {
    if (recipe.file.endsWith('.dmg')) {
      const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'braxil-blender-'));
      await _run('hdiutil', ['attach', '-nobrowse', '-readonly', '-quiet', '-mountpoint', mnt, archive]);
      try {
        fs.rmSync(path.join(dir, 'Blender.app'), { recursive: true, force: true });
        // ditto keeps the code signature + extended attributes intact.
        await _run('ditto', [path.join(mnt, 'Blender.app'), path.join(dir, 'Blender.app')]);
      } finally {
        await _run('hdiutil', ['detach', '-quiet', mnt]).catch(() => {});
      }
    } else if (recipe.file.endsWith('.tar.xz')) {
      await _run('tar', ['-xJf', archive, '-C', dir]);
    } else {
      await _run('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`]);
    }
  } finally {
    fs.rmSync(archive, { force: true });
  }
  if (trim) _trim(dir, recipe);
  if (outDir) {
    onProgress?.(1, `Blender ${BLENDER_VERSION} unpacked`);
    return { bin: path.join(dir, recipe.bin), version: BLENDER_VERSION, source: 'bundle' };
  }
  _cached = null;
  const found = findBlender();
  if (!found) throw new Error('Blender installed but is not runnable.');
  onProgress?.(1, `Blender ${found.version} ready`);
  return found;
}

/** Resolve Blender, downloading the pinned LTS (~400 MB) the first time. */
export async function ensureBlender({ onProgress } = {}) {
  const have = findBlender();
  if (have) return _background(have);
  if (!_installing) {
    _installing = _install(onProgress).finally(() => { _installing = null; });
  }
  return _background(await _installing);
}

/**
 * macOS: Blender as a background app — no Dock icon, no bouncing at every
 * start (the live sessions are invisible helpers). That is `LSUIElement`
 * in its Info.plist, which breaks Blender's own seal, so it is done on an
 * APFS clone of the pinned Blender.app (instant, no extra disk) re-signed
 * ad hoc; the original stays untouched (running sessions keep working) and
 * any failure falls back to it. The release bundle sets it at signing time.
 */
let _agentJob = null;
function _background(found) {
  if (process.platform !== 'darwin' || found?.source !== 'pinned') return found;
  _agentJob ??= (async () => {
    const src = path.resolve(path.dirname(found.bin), '..', '..');
    const root = path.join(blenderDir(), 'agent');
    const app = path.join(root, 'Blender.app');
    const bin = path.join(app, 'Contents', 'MacOS', 'Blender');
    const stamp = path.join(root, `.ready-${found.version}`);
    if (fs.existsSync(stamp) && fs.existsSync(bin)) return { ...found, bin };
    try {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      await _run('cp', ['-cR', src, app]); // clone only: never a 1 GB copy
      const plist = path.join(app, 'Contents', 'Info.plist');
      await _run('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plist])
        .catch(() => _run('/usr/libexec/PlistBuddy', ['-c', 'Set :LSUIElement true', plist]));
      // Only the app's own seal changes (nested libraries keep Blender's).
      await _run('codesign', ['--force', '--sign', '-', app]);
      if (!_versionOf(bin)) throw new Error('re-signed Blender does not run');
      fs.writeFileSync(stamp, '');
      return { ...found, bin };
    } catch {
      fs.rmSync(root, { recursive: true, force: true });
      return found;
    }
  })();
  return _agentJob;
}

export const LIVE_SURFACE_LIB = 'braxil_live_surface.dylib';

/** clang args that build the live-surface library (release + dev). */
export function liveSurfaceBuildArgs(src, out) {
  return ['-dynamiclib', '-O2', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0',
    '-framework', 'IOSurface', '-framework', 'CoreFoundation', '-framework', 'Accelerate',
    '-o', out, src];
}

let _surfaceLib;

/**
 * The live viewport's shared-memory library (macOS only), or null — the
 * live session then falls back to streaming pixels over its socket.
 * Resolution: KOI_LIVE_SURFACE_LIB → beside the bundled Blender.app →
 * compiled once into ~/.koi/blender/native (dev, needs clang).
 */
export function liveSurfaceLib() {
  if (_surfaceLib !== undefined) return _surfaceLib;
  _surfaceLib = null;
  if (process.platform !== 'darwin') return null;
  const cands = [process.env.KOI_LIVE_SURFACE_LIB];
  const blender = findBlender();
  if (blender) {
    // <…>/Blender.app/Contents/MacOS/Blender → <…>/braxil_live_surface.dylib
    cands.push(path.join(path.dirname(blender.bin), '..', '..', '..', LIVE_SURFACE_LIB));
  }
  cands.push(path.join(path.dirname(process.execPath), '..', 'Helpers', LIVE_SURFACE_LIB));
  for (const c of cands) if (c && fs.existsSync(c)) return (_surfaceLib = c);
  try {
    const src = LIVE_SURFACE_C;
    const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
    const dir = path.join(blenderDir(), 'native');
    const out = path.join(dir, `braxil_live_surface-${hash}.dylib`);
    if (!fs.existsSync(out)) {
      fs.mkdirSync(dir, { recursive: true });
      const cfile = path.join(dir, `live_surface-${hash}.c`);
      fs.writeFileSync(cfile, src, 'utf8');
      const r = spawnSync('clang', liveSurfaceBuildArgs(cfile, `${out}.tmp`), { encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) return null;
      fs.renameSync(`${out}.tmp`, out);
    }
    _surfaceLib = out;
  } catch { /* no compiler: socket fallback */ }
  return _surfaceLib;
}

function _materialise(name, src) {
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const dir = path.join(blenderDir(), 'scripts');
  const file = path.join(dir, `${name}-${hash}.py`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, src, 'utf8');
    fs.renameSync(tmp, file);
  }
  return file;
}

/** The builder script, materialised once per content hash. */
export function builderScriptPath() {
  return _materialise('build_scene', BUILD_SCENE_PY);
}

/** The modeler script (build_model3d), materialised the same way. */
export function modelerScriptPath() {
  return _materialise('build_model', BUILD_MODEL_PY);
}

/** The impact solver, materialised the same way. */
export function ragdollScriptPath() {
  return _materialise('ragdoll', RAGDOLL_PY);
}

// Previz renders are short and mostly Blender start-up + scene build, but
// each render Blender holds ~2 GB (EEVEE): memory, not cores, sets how many
// run at once — one on a 16 GB Mac (four at once ran it out of memory next
// to the live viewers), more only with RAM to spare.
const _MAX_PARALLEL = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3),
  Math.floor((os.totalmem() / 2 ** 30 - 12) / 4)));
let _active = 0;
const _waiters = [];

let _heavyTail = Promise.resolve();
/** One heavy render at a time: resolves with its release once it is its turn. */
function _heavySlot() {
  let release;
  const held = new Promise((r) => { release = r; });
  const prev = _heavyTail;
  _heavyTail = prev.then(() => held);
  return prev.then(() => release);
}

async function _slot() {
  if (_active < _MAX_PARALLEL) { _active += 1; return; }
  await new Promise((r) => _waiters.push(r));
  _active += 1;
}

function _release() {
  _active -= 1;
  const next = _waiters.shift();
  if (next) next();
}

/**
 * Run one builder invocation. `args` are the script's own flags
 * (`--scene`, `--shot`, `--out`, …). Resolves with the tail of the log;
 * rejects with the Python traceback when the script fails.
 */
export async function runBuilder(args, { onProgress, onShotDone, timeoutMs = 15 * 60 * 1000, heavy = false, script = null, pool = 'render' } = {}) {
  const { bin } = await ensureBlender({ onProgress });
  script ??= builderScriptPath();
  // Long renders (video bakes) go one at a time: several Blenders rendering
  // whole clips at once saturate the GPU the live previz and the app's own
  // UI draw on, and everything froze for half a minute.
  const releaseHeavy = heavy ? await _heavySlot() : null;
  // Model builds have their own pool slots and skip the renders' queue.
  const local = pool !== 'model';
  if (local) await _slot();
  // A slot of THE Blender pool (live + renders never pass its cap).
  let releasePool = null;
  try {
    releasePool = await takeSlot(pool === 'model' ? 'model' : 'render');
    return await new Promise((resolve, reject) => {
      const argv = ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '-P', script, '--', ...args];
      // macOS: utility QoS — the scheduler (CPU, I/O, GPU queue) serves the
      // interactive app first; a plain nice only lowers CPU priority.
      // Model builds are what an agent (and the user) is waiting on, short and
      // light: normal priority. Throttled to utility QoS a 40 s build took 4 min.
      const bg = pool !== 'model' && process.platform === 'darwin' && fs.existsSync('/usr/sbin/taskpolicy');
      const p = spawn(bg ? '/usr/sbin/taskpolicy' : bin, bg ? ['-c', 'utility', bin, ...argv] : argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      releasePool.launched();
      // Renders run behind the live previz: never steal its time slices.
      if (pool !== 'model') { try { os.setPriority(p.pid, 10); } catch { /* not permitted */ } }
      let log = '';
      let pending = '';
      const onData = (d) => {
        log += d;
        // "[scene3d] done <shot> …" — one per finished camera, so callers can
        // publish each shot the moment it lands instead of after the batch.
        if (onShotDone) {
          pending += d;
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const ln of lines) {
            const m = /^\[scene3d\] done (\S+) /.exec(ln);
            if (m) onShotDone(m[1]);
          }
        }
        if (log.length > 64000) log = log.slice(-32000);
        // "Fra:12 …" lines → coarse progress for long renders.
        const m = /Fra:(\d+)/g;
        let last = null;
        let mm;
        while ((mm = m.exec(String(d)))) last = mm[1];
        if (last && onProgress) onProgress(null, `frame ${last}`);
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      const t = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        clearTimeout(t);
        // Blender exits 0 even when the -P script raises, so the
        // traceback in the log is the real failure signal.
        const tb = log.lastIndexOf('Traceback (most recent call last)');
        if (code !== 0 || tb >= 0) {
          const detail = tb >= 0 ? log.slice(tb, tb + 1500) : log.slice(-1500);
          reject(new Error(`Blender failed (exit ${code}): ${detail}`));
        } else {
          resolve(log.slice(-2000));
        }
      });
    });
  } finally {
    releasePool?.();
    if (local) _release();
    releaseHeavy?.();
  }
}
