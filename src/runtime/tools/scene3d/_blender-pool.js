/**
 * THE pool of Blenders: a fixed number of slots for every Blender the app
 * runs (live 3D sessions, parked ones, renders, model builds). Nothing starts
 * a Blender without a slot, so there are never more than MAX_BLENDERS of them
 * — a 16 GB Mac ran out of memory with 14 GB in Blenders when live sessions
 * piled up next to the agents' renders.
 *
 * Slots are split so neither side starves the other: renders (and model
 * builds) have their own RENDER_SLOTS; the live 3D gets the rest
 * (LIVE_SLOTS, live + parked). A live start with every live slot taken gets
 * one back by evicting a parked Blender, else the live session started
 * longest ago (its views reconnect when they show it again). A render with
 * every render slot taken waits its turn.
 *
 * On top of that, a Blender is only launched while the Blenders actually
 * running on the machine (`ps`, any process: another engine, a stuck one)
 * are under MAX_BLENDERS: the cap holds even across processes.
 */

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const _gb = os.totalmem() / 2 ** 30;
/** ~1.3 GB per live Blender, ~2 GB per render: 2 on 8 GB, 4 on 16 GB, 6 from 24 GB. */
export const MAX_BLENDERS = Math.max(2, Math.min(6, Math.floor(_gb / 4)));
export const RENDER_SLOTS = Math.max(1, Math.min(2, Math.floor((_gb - 8) / 8)));
export const LIVE_SLOTS = Math.max(1, MAX_BLENDERS - RENDER_SLOTS);
/** Model builds (build_model3d): short (~30-60 s) and light, and several
 *  modeling agents work on the pieces of one set at once. Their own slots,
 *  never taken from the renders, allowed this far over the machine cap. */
export const MODEL_SLOTS = Math.max(1, Math.min(4, Math.floor(_gb / 8)));

const _waiters = { live: [], render: [], model: [] };
const _used = { live: 0, render: 0, model: 0 };
let _launching = 0;

/** Wakes the first waiter of [kind] (or of any kind: a machine-wide slot freed). */
function _wake(kind) {
  const w = _waiters[kind][0];
  if (w) w();
}

/** Blender processes running on this machine right now. */
export function runningBlenders() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'comm='], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(0); // unknown: the in-process count still holds
      let n = 0;
      for (const line of String(out).split('\n')) {
        const b = path.basename(line.trim()).toLowerCase();
        if (b === 'blender') n += 1;
      }
      resolve(n);
    });
  });
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Frees the slots nobody uses: our live Blenders whose app is gone (parent
 * pid 1: the engine that started them crashed, quit or restarted). They kept
 * running for hours and filled the machine's cap, so no model build or render
 * could start (19/11/2026). Only OUR Blenders (the app's own copy under
 * ~/.koi/blender, in --live mode) are touched. Returns how many were stopped.
 */
export function reapOrphans() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(0);
      let n = 0;
      for (const line of String(out).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m || m[2] !== '1') continue;
        const cmd = m[3];
        if (!/\/\.koi\/blender\//.test(cmd) || !/Blender/.test(cmd) || !/\s--live\s/.test(cmd)) continue;
        try { process.kill(Number(m[1]), 'SIGTERM'); n += 1; } catch { /* gone */ }
      }
      if (n) console.error(`[blender-pool] stopped ${n} orphan live Blender(s)`);
      resolve(n);
    });
  });
}

/**
 * Take a slot of [kind] ('live' | 'render'). [evict]: called (live only)
 * when every live slot is taken — it must stop a parked / old live Blender
 * and resolve once its slot is released; resolves false when there is
 * nothing to evict. Returns the release function (call it when the
 * Blender process has exited; extra calls are ignored), with
 * `release.launched()` to call right after spawning it.
 */
export async function takeSlot(kind, { evict = null } = {}) {
  const cap = kind === 'live' ? LIVE_SLOTS : kind === 'model' ? MODEL_SLOTS : RENDER_SLOTS;
  const machineCap = kind === 'model' ? MAX_BLENDERS + MODEL_SLOTS : MAX_BLENDERS;
  // In this process: wait (or evict) until a slot of this kind is free.
  while (_used[kind] >= cap) {
    if (evict && (await evict())) continue;
    await new Promise((r) => {
      const q = _waiters[kind];
      let done = false;
      const w = () => {
        if (done) return;
        done = true;
        const i = q.indexOf(w);
        if (i >= 0) q.splice(i, 1);
        r();
      };
      q.push(w);
      // Re-check now and then: a slot freed without a wake never strands us.
      setTimeout(w, 2000).unref?.();
    });
  }
  _used[kind] += 1;
  // On the machine: never launch past MAX_BLENDERS running Blenders (counts
  // every one, so the one being started needs running < MAX).
  // _launching: Blenders this process is about to start that `ps` may not
  // list yet (two starts at once would both see room for one).
  for (let tries = 0; ; tries++) {
    const running = (await runningBlenders()) + _launching;
    if (running < machineCap) break;
    // Slots held by nobody first: orphans of a dead app.
    if (tries % 10 === 0 && (await reapOrphans())) { await _sleep(1500); continue; }
    if (kind === 'live' && evict && (await evict({ machine: true }))) continue;
    if (tries === 0) console.error(`[blender-pool] ${running} Blenders running (max ${machineCap}): ${kind} waits`);
    await _sleep(1000);
  }
  // Counted as launching until the caller has spawned it (then `ps` lists
  // it); a slot never spawned (an error before) stops counting on release.
  _launching += 1;
  let launching = true;
  const launched = () => {
    if (!launching) return;
    launching = false;
    _launching -= 1;
  };
  let released = false;
  const release = () => {
    launched();
    if (released) return;
    released = true;
    _used[kind] -= 1;
    _wake(kind);
  };
  /** Call right after spawn(): the process is now on `ps`. */
  release.launched = launched;
  return release;
}

/** For logs / diagnostics. */
export function poolState() {
  return { max: MAX_BLENDERS, liveSlots: LIVE_SLOTS, renderSlots: RENDER_SLOTS, modelSlots: MODEL_SLOTS, used: { ..._used } };
}
