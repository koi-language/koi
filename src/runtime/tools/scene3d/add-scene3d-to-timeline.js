/**
 * add_scene3d_to_timeline — lay a 3D previz scene's shots onto a timeline
 * as LIVE clips: Blender interprets each one in the preview, nothing is
 * pre-rendered (exports bake the windows they need).
 *
 * Each clip: path = `scene3d:<scene>/<shot>`, sourceInMs = shot start on the
 * scene clock, durationMs = shot length, sourceTotalMs = scene length, and
 * `scene3d: { sceneId, shotId }`. Trim / slip / move work like on any clip.
 */

import { readScene, cleanId, livePath } from './_store.js';
import { addClip, createTimeline, getTimeline, setTimelineSettings } from '../../state/timelines.js';
import { resolveTimelineId } from '../timeline/_resolve-timeline-id.js';

export default {
  type: 'add_scene3d_to_timeline',
  intent: 'add_scene3d_to_timeline',
  description:
    'Place the shots of a 3D previz scene on a timeline as video clips (an animatic you can edit: trim, slip, move, ' +
    'reorder like any clip; they play the 3D live, so scene edits show at once). `timelineId` omitted → the active ' +
    'timeline, or a NEW timeline when none is open (`createIfMissing`, default true). `shots` picks + orders shot ids ' +
    '(default: scene order). Clips go end-to-end on `track` (default "V1") from `startMs` (default: end of that track). ' +
    'Returns { success, timelineId, clips:[{ clipId, shotId, startMs, durationMs }] }.',
  thinkingHint: 'Placing 3D shots on the timeline',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string' },
      timelineId: { type: 'string' },
      shots: { type: 'array', items: { type: 'string' } },
      track: { type: 'string', description: '"V1", "V2", …' },
      startMs: { type: 'number' },
      createIfMissing: { type: 'boolean' },
      name: { type: 'string', description: 'Name for a newly created timeline' },
    },
    required: ['sceneId'],
  },

  async execute(params) {
    const scene = readScene(cleanId(params?.sceneId || params?.id));
    if (!scene) return { success: false, error: `add_scene3d_to_timeline: no scene "${params?.sceneId}".` };
    const track = typeof params.track === 'string' && /^V[1-9]\d*$/.test(params.track) ? params.track : 'V1';

    const ids = Array.isArray(params.shots) && params.shots.length ? params.shots : scene.shots.map((s) => s.id);
    const byId = new Map(scene.shots.map((s) => [s.id, s]));
    const missing = ids.filter((x) => !byId.has(x));
    if (missing.length) return { success: false, error: `add_scene3d_to_timeline: unknown shot(s) ${missing.join(', ')}` };

    const shots = ids.map((x) => scene.shots.find((s) => s.id === x));

    let timelineId = params.timelineId ? String(params.timelineId) : await resolveTimelineId({});
    if (timelineId && !getTimeline(timelineId)) timelineId = null;
    if (!timelineId) {
      if (params.createIfMissing === false) {
        return { success: false, error: 'add_scene3d_to_timeline: no timeline open — pass `timelineId` or allow createIfMissing.' };
      }
      const tl = createTimeline({
        name: params.name || `${scene.name} — previz`,
        storyboardId: scene.storyboard?.id,
        summary: `3D previz animatic of "${scene.name}"`,
      });
      timelineId = tl.id;
    }

    const tl = getTimeline(timelineId);
    const trackNum = Number(track.slice(1));
    if ((tl.settings?.videoTracks || 1) < trackNum) setTimelineSettings(timelineId, { videoTracks: trackNum });
    const { width, height } = scene.resolution || {};
    if (!(tl.clips || []).some((c) => /^V/.test(c.track)) && width && height) {
      // First video on the timeline sets its canvas, like a dropped clip.
      // Canvas at delivery size (the live view renders to fit it).
      const k = 1920 / Math.max(width, height);
      const even = (v) => Math.round((v * k) / 2) * 2;
      setTimelineSettings(timelineId, { fps: scene.fps, width: even(width), height: even(height) });
    }
    let at = Number.isFinite(params.startMs)
      ? Math.max(0, Math.round(params.startMs))
      : (tl.clips || []).filter((c) => c.track === track).reduce((m, c) => Math.max(m, c.startMs + c.durationMs), 0);

    const placed = [];
    for (const sh of shots) {
      const { clip } = addClip(timelineId, {
        track,
        path: livePath(scene.id, sh.id),
        startMs: at,
        durationMs: sh.durationMs,
        sourceInMs: sh.startMs,
        sourceTotalMs: scene.durationMs,
        hasAudio: false,
        sourceWidthPx: width,
        sourceHeightPx: height,
        scene3d: { sceneId: scene.id, shotId: sh.id, poster: sh.preview?.poster || null },
      });
      placed.push({ clipId: clip.id, shotId: sh.id, startMs: at, durationMs: sh.durationMs });
      at += sh.durationMs;
    }
    return { success: true, timelineId, clips: placed };
  },
};
