/**
 * assign_scene3d_take — land ONE generated take on the 3D clips it was made
 * for (prepare_scene3d_video's `takes[].clipIds`, in order).
 *
 * Each clip windows its own stretch of the take. The model rarely cuts on
 * the exact frame the previz did, so every boundary snaps to the take's REAL
 * cut (ffmpeg scene detection) when one lies near the expected time. A clip
 * runs from its cut to the next one, and the timeline boundary between them
 * moves with the cut: a window of the previz's length would leak frames of
 * the neighbouring shot. The whole take keeps its place and its total length.
 * The 3D stays as each clip's placeholder.
 */

import fs from 'fs';
import { spawn } from 'child_process';
import { assignGeneratedMedia, getTimeline, updateTimeline } from '../../state/timelines.js';
import { stampScene3dRender } from './_store.js';
import { resolveTimelineId } from '../timeline/_resolve-timeline-id.js';
import { channel } from '../../io/channel.js';

const SNAP_MS = 700;

async function _bins() {
  try {
    const r = await (await import('../../media/ffmpeg-installer.js')).ensureFfmpeg();
    return { ffmpeg: r?.ffmpeg || 'ffmpeg', ffprobe: r?.ffprobe || 'ffprobe' };
  } catch {
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  }
}

function _out(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
  });
}

async function _probe(file, bins) {
  const out = await _out(bins.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
  try {
    const j = JSON.parse(out);
    return {
      durationMs: Math.round(parseFloat(j.format?.duration) * 1000) || 0,
      hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    };
  } catch {
    return { durationMs: 0, hasAudio: undefined };
  }
}

/** Cut candidates in the take: [{ ms, score }] (frame-to-frame change). */
async function _cuts(file, bins) {
  const out = await _out(bins.ffmpeg, ['-hide_banner', '-i', file, '-an',
    '-vf', "select='gt(scene,0.05)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-']);
  const cuts = [];
  let t = null;
  for (const line of out.split('\n')) {
    const pt = /pts_time:([\d.]+)/.exec(line);
    // Rounded up: a window opening a hair before the frame shows the old shot.
    if (pt) t = Math.ceil(parseFloat(pt[1]) * 1000);
    const sc = /scene_score=([\d.]+)/.exec(line);
    if (sc && t != null) cuts.push({ ms: t, score: parseFloat(sc[1]) });
  }
  return cuts;
}

export default {
  type: 'assign_scene3d_take',
  intent: 'assign_scene3d_take',
  description:
    'Land ONE generated take on the 3D clips it was made for (prepare_scene3d_video `takes[].clipIds`, in order): each clip ' +
    'shows its own stretch of the take, cut to cut at the take\'s real cuts, the boundaries between the clips moving to them while the take keeps its place and total length. A single clip works ' +
    'too. The 3D stays as each clip\'s source (clip menu: "Ver 3D" / "Ver render"). Returns { success, clips:[{ clipId, sourceInMs, snapped }] }.',
  thinkingHint: 'Placing the take on the clips',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      timelineId: { type: 'string' },
      clipIds: { type: 'array', items: { type: 'string' }, description: 'The take\'s clips, in order' },
      mediaPath: { type: 'string', description: 'Absolute path of the generated take' },
      chatId: { type: 'string' },
    },
    required: ['clipIds', 'mediaPath'],
  },

  async execute(params) {
    const { mediaPath, chatId } = params;
    const ids = Array.isArray(params.clipIds) ? params.clipIds : [];
    try {
      if (!ids.length) throw new Error('clipIds is empty');
      if (typeof mediaPath !== 'string' || !fs.existsSync(mediaPath)) throw new Error(`no take at ${mediaPath}`);
      let timelineId = params.timelineId ? String(params.timelineId) : await resolveTimelineId({});
      // A GUI tab handle ("tab-0") is not a timeline id: the active timeline is.
      if (timelineId && !getTimeline(timelineId)) timelineId = await resolveTimelineId({});
      const tl = timelineId ? getTimeline(timelineId) : null;
      if (!tl) throw new Error('no timeline — pass `timelineId`');
      const clips = ids.map((id) => tl.clips.find((c) => c.id === id));
      const missing = ids.filter((_, i) => !clips[i]);
      if (missing.length) throw new Error(`clips not on ${timelineId}: ${missing.join(', ')}`);
      const locked = clips.filter((c) => c.locked === true).map((c) => c.id);
      if (locked.length) throw new Error(`the user locked these clips: ${locked.join(', ')}`);

      const bins = await _bins();
      const { durationMs: takeMs, hasAudio } = await _probe(mediaPath, bins);
      const total = clips.reduce((n, c) => n + c.durationMs, 0);
      if (takeMs > 0 && takeMs + 80 < total) {
        throw new Error(
          `the take is ${(takeMs / 1000).toFixed(2)}s but its clips add up to ${(total / 1000).toFixed(2)}s and their ` +
          `length is protected — regenerate with duration ≥ ${Math.ceil(total / 1000)}s (never trim the clips).`);
      }
      const cuts = clips.length > 1 ? await _cuts(mediaPath, bins) : [];

      // Expected start of each clip in the take; snap to a real cut nearby.
      const placed = [];
      let expected = 0;
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        let start = expected;
        let snapped = false;
        if (i > 0) {
          // The strongest change near where the previz cuts is the take's cut.
          const near = cuts.filter((x) => Math.abs(x.ms - expected) <= SNAP_MS)
            .sort((a, b) => b.score - a.score)[0];
          if (near) { start = near.ms; snapped = true; }
        }
        // Never before the previous clip's start, never past the take's end.
        if (i > 0) start = Math.max(start, placed[i - 1].sourceInMs + 1);
        if (i > 0) start = Math.min(start, placed[0].sourceInMs + total - (clips.length - i));
        else if (takeMs > 0) start = Math.min(start, takeMs - total);
        start = Math.max(0, Math.round(start));
        placed.push({ clipId: c.id, sourceInMs: start, snapped, expectedMs: Math.round(expected) });
        expected += c.durationMs;
      }

      // Cut to cut. Clips apart on the timeline only lose what would leak.
      const joined = clips.every((c, i) => i === 0 || Math.abs(clips[i - 1].startMs + clips[i - 1].durationMs - c.startMs) <= 2);
      placed.forEach((p, i) => {
        const end = i + 1 < placed.length ? placed[i + 1].sourceInMs : placed[0].sourceInMs + total;
        const c = clips[i];
        p.startMs = joined ? clips[0].startMs + p.sourceInMs - placed[0].sourceInMs : c.startMs;
        p.durationMs = joined ? end - p.sourceInMs : Math.min(c.durationMs, end - p.sourceInMs);
      });
      // Before any audio is linked: a clip's sound must not meet its neighbour's old place.
      for (const p of placed) {
        const c = tl.clips.find((x) => x.id === p.clipId);
        const linked = c.linkId ? tl.clips.filter((x) => x.linkId === c.linkId) : [c];
        for (const x of linked) Object.assign(x, { startMs: p.startMs, durationMs: p.durationMs });
      }
      updateTimeline(timelineId, tl);

      for (const p of placed) {
        assignGeneratedMedia(timelineId, p.clipId, {
          mediaPath, chatId, sourceInMs: p.sourceInMs, ...(typeof hasAudio === 'boolean' ? { hasAudio } : {}),
        });
        stampScene3dRender(timelineId, p.clipId, mediaPath);
        channel.clipMediaGenerated({ clipId: p.clipId, mediaPath, chatId: chatId ?? null, sourceInMs: p.sourceInMs, startMs: p.startMs, durationMs: p.durationMs });
      }
      return { success: true, timelineId, takeSec: takeMs / 1000, cutsSec: placed.filter((p) => p.snapped).map((p) => p.sourceInMs / 1000), clips: placed };
    } catch (e) {
      for (const id of ids) {
        try { channel.clipMediaGenerated({ clipId: id, error: e?.message || String(e) }); } catch { /* ignore */ }
      }
      return { success: false, error: `assign_scene3d_take: ${e.message}` };
    }
  },
};
