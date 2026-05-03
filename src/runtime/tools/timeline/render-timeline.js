/**
 * Render a timeline to a video file using ffmpeg.
 *
 * Async by default — returns a `jobId` immediately and ffmpeg runs in
 * the background. The agent then calls `await_job` (blocks until done)
 * or `get_job_status` (snapshot) to retrieve the final output. Pass
 * `wait: true` to make this call block internally and return the
 * finished job state in one shot — convenient for short renders.
 *
 * If ffmpeg isn't on PATH a static build is downloaded into the
 * project's `.koi/bin/` cache the first time. Subsequent renders reuse
 * it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getTimeline } from '../../state/timelines.js';
import { startJob, awaitJob, getJob } from '../../state/jobs.js';
import { ensureFfmpeg } from '../../media/ffmpeg-installer.js';
import { compileTimeline } from '../../media/timeline-renderer.js';
import { resolveTimelineId } from './_resolve-timeline-id.js';

export default {
  type: 'render_timeline',
  intent: 'render_timeline',
  description:
    'Render a timeline to a video file. ASYNC by default — returns { success, jobId, outputPath } immediately; ' +
    'use await_job(jobId) to wait for completion, or get_job_status(jobId) for a snapshot. Pass wait=true to block ' +
    'internally and return the finished result in one call. ' +
    'Output params: format (mp4|mov|webm|mkv|gif, default mp4), width/height (default 1920x1080), fps (default 30), ' +
    'videoCodec (h264|h265|vp9|prores), audioCodec (aac|mp3|opus|none), crf (lower=better quality), audioBitrate ' +
    '(default "192k"), rangeMs ({startMs, endMs}) to render only a slice, outputPath (defaults to ' +
    '<project>/.koi/renders/<timelineId>-<timestamp>.<ext>). ' +
    'Composites all video tracks DaVinci-style (V2 over V1, …) and mixes ALL audible streams (covered clips keep ' +
    'their sound). ffmpeg is auto-installed on first use.',
  thinkingHint: 'Rendering timeline',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      format: { type: 'string', description: 'mp4 | mov | webm | mkv | gif (default mp4)' },
      width: { type: 'number', description: 'Output width in pixels (default 1920)' },
      height: { type: 'number', description: 'Output height in pixels (default 1080)' },
      fps: { type: 'number', description: 'Frames per second (default 30)' },
      videoCodec: { type: 'string', description: 'h264 | h265 | vp9 | prores (default per format)' },
      audioCodec: { type: 'string', description: 'aac | mp3 | opus | none (default per format; "none" disables audio)' },
      crf: { type: 'number', description: 'Constant Rate Factor — lower is better quality (default 23 for h264, 28 for h265, 32 for vp9)' },
      audioBitrate: { type: 'string', description: 'Audio bitrate, e.g. "192k", "320k" (default "192k")' },
      rangeMs: { type: 'object', description: 'Optional { startMs, endMs } to render only a slice of the timeline' },
      outputPath: { type: 'string', description: 'Output file path. Defaults to .koi/renders/<timelineId>-<timestamp>.<ext>' },
      wait: { type: 'boolean', description: 'Block until the render finishes and return the result inline. Default false (async).' },
    },
    required: ['id'],
  },

  async execute(action, agent) {
    const id = await resolveTimelineId(action);
    if (!id) {
      return { success: false, error: 'render_timeline: pass `id` (or have a timeline as the active document).' };
    }
    const tl = getTimeline(id);
    if (!tl) return { success: false, error: `Timeline ${id} not found` };

    let plan;
    try {
      plan = compileTimeline(tl, action);
    } catch (e) {
      return { success: false, error: e.message };
    }

    // Make sure the output directory exists before we hand off to ffmpeg.
    fs.mkdirSync(path.dirname(plan.outputPath), { recursive: true });

    const job = startJob({
      type: 'render_timeline',
      params: {
        timelineId: tl.id,
        outputPath: plan.outputPath,
        durationMs: plan.durationMs,
        format: plan.settings.format,
        width: plan.settings.width,
        height: plan.settings.height,
        fps: plan.settings.fps,
        videoCodec: plan.settings.videoCodec,
        audioCodec: plan.settings.audioCodec,
      },
      runner: async ({ signal, reportProgress }) => {
        reportProgress(0, 'Resolving ffmpeg…');
        const { ffmpeg } = await ensureFfmpeg({
          onProgress: (p, msg) => reportProgress(p * 0.05, msg),
        });
        if (signal.aborted) throw new Error('aborted');

        const totalDurUs = plan.durationMs * 1000;
        return await new Promise((resolve, reject) => {
          const child = spawn(ffmpeg, plan.argv, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stderrTail = '';
          let lastProgressMs = 0;
          // -progress emits a stream of "key=value" lines. We watch
          // out_time_us to drive the 0..1 progress bar.
          let pendingLine = '';
          child.stdout.on('data', (buf) => {
            pendingLine += buf.toString('utf8');
            const lines = pendingLine.split('\n');
            pendingLine = lines.pop() || '';
            for (const line of lines) {
              const eq = line.indexOf('=');
              if (eq < 0) continue;
              const key = line.slice(0, eq).trim();
              const val = line.slice(eq + 1).trim();
              if (key === 'out_time_us') {
                const us = Number(val);
                if (Number.isFinite(us) && us > 0) {
                  lastProgressMs = us / 1000;
                  // Reserve 0..0.05 for ffmpeg install, 0.05..0.95 for
                  // encoding, last 5% for finalise/atomic move.
                  const pct = totalDurUs > 0 ? Math.min(1, us / totalDurUs) : 0;
                  reportProgress(0.05 + 0.9 * pct, `Encoding ${(lastProgressMs / 1000).toFixed(1)}s / ${(plan.durationMs / 1000).toFixed(1)}s`);
                }
              } else if (key === 'progress' && val === 'end') {
                reportProgress(0.97, 'Finalising…');
              }
            }
          });
          child.stderr.on('data', (buf) => {
            // Keep the last ~8 KB so we can surface a useful tail on failure.
            stderrTail = (stderrTail + buf.toString('utf8')).slice(-8192);
          });
          child.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
          child.on('exit', (code, sig) => {
            if (signal.aborted) {
              // Cooperator already SIGKILL'd us — surface as cancellation.
              return reject(new Error('aborted'));
            }
            if (code === 0) {
              reportProgress(1, 'Done');
              return resolve({
                outputPath: plan.outputPath,
                durationMs: plan.durationMs,
                format: plan.settings.format,
                width: plan.settings.width,
                height: plan.settings.height,
                fps: plan.settings.fps,
              });
            }
            const tail = stderrTail.split('\n').filter(Boolean).slice(-12).join('\n');
            return reject(new Error(`ffmpeg exited ${code}${sig ? ` (${sig})` : ''}\n${tail}`));
          });
          // Cancellation: SIGTERM first, escalate to SIGKILL after 2s.
          signal.addEventListener('abort', () => {
            try { child.kill('SIGTERM'); } catch { /* */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2000);
          }, { once: true });
        });
      },
    });

    if (action.wait) {
      const final = await awaitJob(job.id, { signal: agent?.abortSignal });
      if (!final) return { success: false, jobId: job.id, error: 'Job vanished' };
      return {
        success: final.status === 'succeeded',
        jobId: final.id,
        status: final.status,
        outputPath: final.result?.outputPath || plan.outputPath,
        result: final.result,
        error: final.error,
      };
    }

    return {
      success: true,
      jobId: job.id,
      outputPath: plan.outputPath,
      message: 'Render started. Call await_job with this jobId to retrieve the result.',
    };
  },
};
