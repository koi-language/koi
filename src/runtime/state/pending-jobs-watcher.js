/**
 * Pending-jobs recovery watcher (singleton).
 *
 * Started once per engine at boot. Periodically scans
 * `~/.koi/pending-jobs/` for jobs whose poller died (lock missing or
 * stale heartbeat) and finishes them: poll fal until terminal,
 * download the result, assign to the timeline clip if the job carried
 * a clipContext, then mark the job completed (deletes the file).
 *
 * Two coordination invariants:
 *   • A job is only resumed if `acquireLock(jobId, pid)` succeeds —
 *     prevents two engines racing on the same fal request when
 *     multiple koi sessions are alive on the same machine.
 *   • The watcher heartbeats every 10 s while polling, so any
 *     concurrent watcher correctly sees the lock is still alive.
 *
 * The action-driven path (live agent invoking generate_video) writes
 * the SAME files and uses the SAME lock semantics — the watcher only
 * kicks in when the original poller is gone. Happy path: live agent
 * completes the job and removes the file; watcher sees nothing on its
 * next scan.
 *
 * Today this only handles video jobs. Image generation has its own
 * in-process retry loop that's already content-aware (the gateway's
 * `_isRouteableError` retry), and image jobs complete fast enough
 * (10–30 s) that crash recovery is a much smaller concern. If the
 * problem ever surfaces for image too, add a `kind: 'image'` branch
 * mirroring `_resumeVideoJob` below.
 */

import { channel } from '../io/channel.js';
import {
  listPending,
  acquireLock,
  refreshLock,
  releaseLock,
  markCompleted,
  markFailed,
  updateJob,
} from './pending-jobs.js';

let _started = false;
let _scanTimer = null;
const _ownedNow = new Set();

/** How often to scan the pending-jobs dir for new orphans. 30 s is
 *  comfortably above any poll iteration (so we don't waste cycles
 *  scanning during normal operation) yet small enough that a job
 *  whose owner just died is picked up within at most one scan period
 *  + the stale-lock grace window (`LOCK_STALE_MS` in pending-jobs.js,
 *  30 s today). Total worst-case recovery latency: ~60 s. */
const SCAN_INTERVAL_MS = 30_000;

/** Heartbeat cadence for an in-progress resume. Refresh the lock
 *  every 10 s so other watchers (or a newly-booted engine) see
 *  ownership is alive. Must be < `LOCK_STALE_MS` by a comfortable
 *  margin. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** Resume timeout per job. Long enough that fal's worst-case
 *  generation (10-15 s videos with Veo 3.1 + refs) lands well inside.
 *  Beyond this we treat the job as stuck and release the lock so the
 *  next scan can retry. */
const RESUME_TIMEOUT_MS = 10 * 60 * 1000;

/** Idempotent. Safe to call multiple times — only the first
 *  invocation arms the timer. */
export function startPendingJobsWatcher() {
  if (_started) return;
  _started = true;
  // First scan is deferred a tick so callers (e.g. engine bootstrap)
  // can finish wiring everything else first. Subsequent scans are
  // timer-driven.
  setImmediate(_scanOnce);
  _scanTimer = setInterval(_scanOnce, SCAN_INTERVAL_MS);
  // Don't let the timer keep the event loop alive forever — when the
  // engine wants to exit, it should.
  if (typeof _scanTimer.unref === 'function') _scanTimer.unref();
}

/** Stop the watcher. Useful in tests; production code rarely calls
 *  this (the engine exit kills the timer with the process). */
export function stopPendingJobsWatcher() {
  _started = false;
  if (_scanTimer) {
    clearInterval(_scanTimer);
    _scanTimer = null;
  }
}

async function _scanOnce() {
  let entries;
  try {
    entries = listPending();
  } catch (err) {
    channel.log('jobs', `pending-jobs scan failed: ${err.message}`);
    return;
  }
  if (entries.length === 0) return;

  for (const job of entries) {
    if (!job?.jobId) continue;
    if (_ownedNow.has(job.jobId)) continue; // we're already resuming it
    // Don't touch terminal entries — they should have been deleted
    // (completed) or moved to .failed/ (failed). If they're still in
    // the active dir something's odd; leave them for a human to
    // inspect rather than re-poll into a tight loop.
    if (job.status === 'completed' || job.status === 'failed') continue;
    if (!acquireLock(job.jobId, process.pid)) {
      // Owned by a live poller — leave it alone.
      continue;
    }
    _ownedNow.add(job.jobId);
    // Fire-and-forget the resume — one job per tick must NOT block
    // the loop or other jobs in the same scan.
    _resumeJob(job).catch((err) => {
      channel.log('jobs', `resume ${job.jobId} threw: ${err?.message || err}`);
      try { markFailed(job.jobId, `Resume threw: ${err?.message || err}`); } catch { /* ignore */ }
    }).finally(() => {
      _ownedNow.delete(job.jobId);
    });
  }
}

async function _resumeJob(job) {
  channel.log(
    'jobs',
    `Resuming pending job ${job.jobId} (kind=${job.kind}, slug=${job.slug || 'unknown'}, lastStatus=${job.lastSeenStatus || 'unknown'})`,
  );
  if (job.kind === 'video') {
    await _resumeVideoJob(job);
    return;
  }
  // Other kinds aren't recoverable through this path yet. Mark them
  // failed so we don't loop on a job we don't know how to handle —
  // the .failed file preserves enough info for manual recovery.
  markFailed(job.jobId, `Unsupported job kind for watcher resume: ${job.kind}`);
}

async function _resumeVideoJob(job) {
  // Lazy-import everything to avoid pulling the runtime into module
  // load order at startup (this file is imported from bin-entry which
  // runs before lots of state is initialised).
  const { GatewayVideoGen } = await import('../llm/providers/gateway.js');
  const {
    _pollUntilTerminal,
    saveVideoFromUrl,
    _reconcileExtendOutput,
  } = await import('../tools/media/generate-video.js');

  // Heartbeat the lock so other watchers see we're alive. Cleared in
  // the finally block — even on throw — so the lock doesn't stick on
  // a crashed resume.
  const heartbeatTimer = setInterval(() => {
    try {
      const ok = refreshLock(job.jobId, process.pid);
      if (!ok) channel.log('jobs', `lock lost for ${job.jobId} during resume — another poller may have stolen it`);
    } catch { /* observability is best-effort */ }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  try {
    const instance = new GatewayVideoGen(job.slug || 'auto');
    // Synthetic `submitted` shape — what GatewayVideoGen.generate()
    // returns. `id` is the composite jobId (e.g.
    // `bytedance/seedance-2.0/image-to-video|019e17...`) and
    // `_pollUntilTerminal` polls fal's status endpoint with it.
    const submitted = {
      id: job.jobId,
      status: 'pending',
      model: job.slug || null,
    };

    const final = await _pollUntilTerminal(instance, submitted, {
      timeoutMs: RESUME_TIMEOUT_MS,
      pollIntervalMs: 5_000,
      onTick: (latest) => {
        try {
          updateJob(job.jobId, {
            lastSeenStatus: latest?.status || 'unknown',
            lastPolledAt: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
        // Tell the GUI we're still working on this clip — keeps the
        // per-clip watchdog (5 min default) re-armed for the duration
        // of the resume, even though the original session that started
        // the generation is gone.
        try {
          if (job.clipContext?.clipId) {
            channel.clipMediaGenerating({
              clipId: job.clipContext.clipId,
              status: latest?.status || 'pending',
            });
          }
        } catch { /* non-fatal */ }
      },
    });

    if (final.status === 'failed') {
      markFailed(job.jobId, final.error || 'Provider reported failure (no error message).');
      channel.log('jobs', `Resumed job ${job.jobId} → FAILED: ${final.error || 'unspecified'}`);
      _notifyClipFailed(job, final.error || 'Generation failed');
      return;
    }

    if (final.status !== 'completed' || !final.url) {
      // Still pending after RESUME_TIMEOUT_MS. Release the lock so
      // the next scan can pick it up — fal might still be working.
      // We do NOT mark failed — the job is in legitimate limbo.
      releaseLock(job.jobId, process.pid);
      channel.log(
        'jobs',
        `Resumed job ${job.jobId} → still ${final.status} after ${RESUME_TIMEOUT_MS / 1000}s — will retry on next scan`,
      );
      return;
    }

    // ── Completed. Download + assign + mark done ─────────────────
    const saved = await saveVideoFromUrl(final.url, {
      saveTo: job.savePath,
      provider: job.provider,
      model: final.model || job.slug,
      id: job.jobId,
    });
    if (saved.error || !saved.path) {
      markFailed(job.jobId, `Download failed: ${saved.error || 'unknown'}`);
      _notifyClipFailed(job, saved.error || 'Download failed');
      return;
    }

    // ── Extend reconcile ─────────────────────────────────────────
    // If this was a kind='extend' generation, the provider may have
    // returned only the new tail slice (Seedance reference-to-video
    // and friends). Without this step, we'd assign the slice to the
    // clip and silently lose the source — same bug the inline path
    // guards against. Skipped for non-extend kinds.
    let mediaPath = saved.path;
    const _isExtend = job.params?.kind === 'extend';
    const _extendSource = Array.isArray(job.params?.referenceVideoPaths) &&
      job.params.referenceVideoPaths.length > 0
      ? job.params.referenceVideoPaths[0]
      : null;
    if (_isExtend && _extendSource) {
      const reconciled = await _reconcileExtendOutput({
        outputPath: saved.path,
        sourcePath: _extendSource,
        requestedExtensionSec: job.params?.duration,
        modelSlug: final.model || job.slug,
      });
      if (reconciled.error) {
        markFailed(job.jobId, reconciled.error);
        channel.log('jobs', `Resumed job ${job.jobId} → FAILED at extend reconcile: ${reconciled.error}`);
        _notifyClipFailed(job, reconciled.error);
        return;
      }
      mediaPath = reconciled.path;
    }

    // Assign to the clip if the job carried clipContext (i.e. it was
    // originally fired from a timeline placeholder, not a free-form
    // agent generation). Wrapped in try/catch — even if the assign
    // fails, the file is on disk and the user can grab it manually.
    if (job.clipContext?.timelineId && job.clipContext?.clipId) {
      try {
        const { default: assignTool } = await import('../tools/timeline/assign-generated-media-to-clip.js');
        const res = await assignTool.execute({
          id: job.clipContext.timelineId,
          clipId: job.clipContext.clipId,
          mediaPath,
        });
        if (!res?.success) {
          channel.log('jobs', `assign_to_clip(${job.clipContext.clipId}) failed: ${res?.error || 'unknown'}`);
        }
      } catch (err) {
        channel.log('jobs', `assign_to_clip threw for ${job.jobId}: ${err.message}`);
      }
    }

    markCompleted(job.jobId);
    channel.log(
      'jobs',
      `Resumed job ${job.jobId} → COMPLETED, saved to ${mediaPath}` +
      (job.clipContext?.clipId ? ` and assigned to clip ${job.clipContext.clipId}` : ''),
    );
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/** Notify the GUI that a clip's generation failed so the placeholder
 *  drops its "generating" stripes overlay. Best-effort — if the WS
 *  isn't connected the GUI's own 5-minute orphan watchdog will
 *  eventually clear it. */
function _notifyClipFailed(job, error) {
  if (!job.clipContext?.clipId) return;
  try {
    channel.clipMediaGenerated({
      clipId: job.clipContext.clipId,
      error: typeof error === 'string' ? error : (error?.message || String(error)),
    });
  } catch { /* non-fatal */ }
}
