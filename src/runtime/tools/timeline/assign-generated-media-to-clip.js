/**
 * Land a freshly-generated media file (image / video / audio) on a timeline
 * clip the user previously marked as "AI placeholder". The tool swaps the
 * clip's `path` on the persisted timeline JSON AND broadcasts a
 * `clipMediaGenerated` event so the GUI can:
 *
 *   1. Replace the placeholder body (AI Image / AI Video / AI Audio) with
 *      the rendered media.
 *   2. Update the clip's `aiState.lastRenderedPath` so the inspector can
 *      offer an "AI ↔ Rendered" toggle (revert to placeholder, regenerate).
 *   3. Clear the diagonal-stripes "generating" animation overlay.
 *
 * This is the canonical exit of any AI-clip generation flow — when the
 * agent finishes producing the media (whether via generate_image,
 * generate_video, generate_audio, ffmpeg, an MCP tool, etc.) it should
 * call this tool with the produced file's absolute path.
 *
 * Permission: write — same as `update_clip`. The path swap is idempotent
 * (calling twice with the same value is a no-op besides the broadcast).
 */

import fs from 'fs';
import { assignGeneratedMedia, getTimeline } from '../../state/timelines.js';
import { stampScene3dRender } from '../scene3d/_store.js';
import { channel } from '../../io/channel.js';

/** Media duration in ms (ffprobe), or 0 when unknown. */
async function _probeDurationMs(file) {
  if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(file) || !fs.existsSync(file)) return 0;
  let bin = 'ffprobe';
  try {
    const r = await (await import('../../media/ffmpeg-installer.js')).ensureFfmpeg();
    if (r?.ffprobe) bin = r.ffprobe;
  } catch { /* PATH */ }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { stdout } = await promisify(execFile)(
      bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 5000 });
    const sec = parseFloat(String(stdout).trim());
    return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
  } catch {
    return 0;
  }
}

export default {
  type: 'assign_generated_media_to_clip',
  intent: 'assign_generated_media_to_clip',
  description:
    'Place a freshly-generated media file on an AI-placeholder timeline clip. ' +
    'Fields: id (timeline id), clipId (stable clip id, e.g. "clip-a3f9c2"), ' +
    'mediaPath (absolute path to the generated image / video / audio). ' +
    'Optional: chatId (the session that ran the generation, surfaced back to the ' +
    'GUI so the inspector can prefer it for the next regenerate). ' +
    'Returns { success, timeline }. ' +
    'Use this as the LAST step of any generation flow targeted at a clip the ' +
    'user marked AI — it both updates the clip\'s source path AND tells the ' +
    'GUI to clear the generating-stripes overlay and switch to "rendered" mode.',
  thinkingHint: 'Assigning generated media',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Timeline id' },
      clipId: { type: 'string', description: 'Stable clip id (e.g. "clip-a3f9c2")' },
      mediaPath: {
        type: 'string',
        description: 'Absolute path to the generated media file (image / video / audio).',
      },
      chatId: {
        type: 'string',
        description:
          'Optional session id of the chat that ran the generation. The GUI ' +
          'records it onto the clip so future regenerations prefer this chat.',
      },
    },
    required: ['id', 'clipId', 'mediaPath'],
  },

  async execute(params) {
    try {
      const { id, clipId, mediaPath, chatId } = params;
      if (!mediaPath || typeof mediaPath !== 'string') {
        throw new Error('mediaPath must be a non-empty string');
      }
      // A 3D clip's length is protected: the take is windowed to it, so a
      // take shorter than the clip would freeze on its last frame.
      const clip = getTimeline(id)?.clips?.find((c) => c.id === clipId);
      if (clip?.scene3d) {
        const got = await _probeDurationMs(mediaPath);
        if (got > 0 && got + 80 < clip.durationMs) {
          throw new Error(
            `the take is ${(got / 1000).toFixed(2)}s but the 3D clip is ${(clip.durationMs / 1000).toFixed(2)}s and its ` +
            `length is protected — regenerate with duration ≥ ${Math.ceil(clip.durationMs / 1000)}s (never trim the clip).`);
        }
      }
      let tl = assignGeneratedMedia(id, clipId, { mediaPath, chatId });
      if (clip?.scene3d) {
        stampScene3dRender(id, clipId, mediaPath);
        tl = getTimeline(id);
      }
      // Broadcast AFTER the state mutation succeeds so the GUI never sees
      // a "ready" event for a swap that didn't actually persist.
      channel.clipMediaGenerated({ clipId, mediaPath, chatId: chatId ?? null });
      return { success: true, timeline: tl };
    } catch (e) {
      // Tell the GUI the generation failed so it can drop the stripes
      // overlay and let the user retry. Best-effort — if the broadcast
      // itself fails the GUI will eventually time out the animation.
      try {
        if (params?.clipId) {
          channel.clipMediaGenerated({
            clipId: params.clipId,
            error: e?.message || String(e),
          });
        }
      } catch { /* ignore */ }
      return { success: false, error: e.message };
    }
  },
};
