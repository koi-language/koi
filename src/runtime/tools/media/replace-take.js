/**
 * replace_take — surgical TAKE replacement inside a rendered clip, with a
 * per-clip version HISTORY and restore.
 *
 * Why: re-rolling a whole multi-shot clip because ONE take came out wrong
 * wastes money and risks regressing the takes that were already good. This
 * tool splices a re-generated take INTO the existing clip — in place, same
 * file path, so every reference to the clip (timeline clips, chat messages,
 * storyboard links) keeps working — and snapshots the previous version first
 * so any earlier state can be restored.
 *
 * DETERMINISTIC BY DESIGN: this tool never generates anything and never
 * calls a model. The agent produces the replacement take with
 * `generate_video` (single-shot render, same references/model contract) and
 * hands the FILE here. Tools are contract; generation stays where the model
 * contract lives.
 *
 * Operations (default `replace`):
 *   • replace — { video, fromMs, toMs, replacement, note?, matchDuration? }
 *       Snapshot `video` → history, then rebuild it as
 *       [0..fromMs) + replacement + (toMs..end], re-encoded uniformly.
 *       `matchDuration` (default true) trims a LONGER replacement to the
 *       segment's length; a shorter one is spliced as-is (the clip
 *       shortens — `durationDeltaMs` reports it).
 *   • history — { video } → the version list (newest first).
 *   • restore — { video, version, note? } → snapshot the current state,
 *       then copy that version's file back over `video`.
 *
 * Storage: `<dir>/.takes/<basename>/vNNN.mp4` + `manifest.json`. Snapshots
 * are FULL CLIPS (not segments): restore is a byte-exact copy, immune to
 * boundary drift, at the cost of a few MB per operation.
 *
 * Output codecs are pinned (h264 yuv420p + aac 48k) so a spliced clip stays
 * playable everywhere the original was, regardless of what the replacement
 * take was encoded with.
 */

import { lockedClips } from '../../state/timelines.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureFfmpeg } from '../../media/ffmpeg-installer.js';
import { channel } from '../../io/channel.js';
import { readDocJson, stringifyDocJson } from '../../state/project-paths.js';

const _VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);

function _run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e?.message || e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function _probe(ffprobe, file) {
  const { code, out, err } = await _run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path.basename(file)}: ${err.slice(0, 300)}`);
  const json = JSON.parse(out);
  const v = (json.streams || []).find((s) => s.codec_type === 'video');
  const a = (json.streams || []).find((s) => s.codec_type === 'audio');
  const durationMs = Math.round(parseFloat(json.format?.duration || '0') * 1000);
  if (!v) throw new Error(`${path.basename(file)} has no video stream`);
  return {
    durationMs,
    width: v.width,
    height: v.height,
    // Raw rational ("30000/1001") — the fps filter takes it verbatim.
    fps: v.r_frame_rate && v.r_frame_rate !== '0/0' ? v.r_frame_rate : '30',
    hasAudio: !!a,
  };
}

function _takesDir(videoPath) {
  const base = path.basename(videoPath, path.extname(videoPath));
  return path.join(path.dirname(videoPath), '.takes', base);
}

function _loadManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return { versions: [] };
  try { return readDocJson(p); } catch { return { versions: [] }; }
}

function _saveManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'manifest.json');
  fs.writeFileSync(fp, stringifyDocJson(manifest, fp));
}

/** Copy the CURRENT clip into the history as the next vNNN and append the
 *  manifest entry describing why. Returns the new version number. */
function _snapshot(videoPath, { action, note, fromMs, toMs, durationMs }) {
  const dir = _takesDir(videoPath);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = _loadManifest(dir);
  const version = (manifest.versions.reduce((m, v) => Math.max(m, v.version), 0)) + 1;
  const snapPath = path.join(dir, `v${String(version).padStart(3, '0')}${path.extname(videoPath)}`);
  fs.copyFileSync(videoPath, snapPath);
  manifest.versions.push({
    version,
    path: snapPath,
    at: new Date().toISOString(),
    action,
    note: note || null,
    fromMs: fromMs ?? null,
    toMs: toMs ?? null,
    durationMs: durationMs ?? null,
  });
  _saveManifest(dir, manifest);
  return { version, manifest };
}

export default {
  type: 'replace_take',
  intent: 'replace_take',
  description:
    'Surgically REPLACE one take (a shot segment [fromMs,toMs]) inside a rendered video with another clip, IN PLACE (same file path — timelines and references keep working), snapshotting the previous version first. ' +
    'The replacement is a video file YOU already generated (e.g. a single-shot re-render of just the broken take via generate_video); this tool only does the deterministic splice + history. ' +
    'operation:"replace" (default) needs { video, fromMs, toMs, replacement }; a replacement LONGER than the segment is trimmed to fit (matchDuration:false disables), a shorter one shortens the clip (durationDeltaMs reports it). ' +
    'operation:"history" lists the version history; operation:"restore" ({ video, version }) brings any previous version back (the current state is snapshotted first, so restore is always reversible). ' +
    'Returns { success, savedTo, version, durationMs, durationDeltaMs, history }. ffmpeg auto-installed on first use.',
  thinkingHint: 'Splicing take',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      operation:     { type: 'string', enum: ['replace', 'history', 'restore'], description: 'Default "replace".' },
      video:         { type: 'string', description: 'Absolute path to the clip being edited (the file that will be rewritten in place).' },
      fromMs:        { type: 'number', description: 'replace: take start (ms) in the CURRENT clip.' },
      toMs:          { type: 'number', description: 'replace: take end (ms) in the CURRENT clip.' },
      replacement:   { type: 'string', description: 'replace: absolute path to the new take video (already generated).' },
      matchDuration: { type: 'boolean', description: 'replace: trim a longer replacement to the segment length (default true).' },
      version:       { type: 'number', description: 'restore: the version number (from operation:"history") to bring back.' },
      note:          { type: 'string', description: 'Optional short note stored in the history entry (e.g. "take 4 re-rolled: mirrored positions fixed").' },
    },
    required: ['video'],
  },

  examples: [
    { intent: 'replace_take', video: '/Users/me/.koi/videos/clip2.mp4', fromMs: 6732, toMs: 8857, replacement: '/Users/me/.koi/videos/retake-shot4.mp4', note: 'take 4: positions were mirrored' },
    { intent: 'replace_take', operation: 'history', video: '/Users/me/.koi/videos/clip2.mp4' },
    { intent: 'replace_take', operation: 'restore', video: '/Users/me/.koi/videos/clip2.mp4', version: 1 },
  ],

  async execute(action) {
    const op = action.operation || 'replace';
    const videoPath = action.video ? path.resolve(action.video) : null;
    if (!videoPath) return { success: false, error: 'replace_take: "video" is required' };
    if (!fs.existsSync(videoPath)) return { success: false, error: `Video not found: ${action.video}` };
    if (!_VIDEO_EXTS.has(path.extname(videoPath).toLowerCase())) {
      return { success: false, error: `replace_take: "video" must be a video file, got "${path.basename(videoPath)}"` };
    }
    if (op !== 'history' && lockedClips().some(({ clip }) => clip.path === videoPath)) {
      return { success: false, error: 'replace_take: this video plays on a clip the user locked on the timeline. Ask the user to unlock it.' };
    }

    const dir = _takesDir(videoPath);

    if (op === 'history') {
      const manifest = _loadManifest(dir);
      return {
        success: true,
        video: videoPath,
        history: manifest.versions.slice().reverse(),
        count: manifest.versions.length,
      };
    }

    const { ffmpeg, ffprobe } = await ensureFfmpeg();

    if (op === 'restore') {
      const version = Number(action.version);
      if (!Number.isFinite(version)) return { success: false, error: 'restore: "version" is required (see operation:"history")' };
      const manifest = _loadManifest(dir);
      const entry = manifest.versions.find((v) => v.version === version);
      if (!entry) return { success: false, error: `restore: version ${version} not found (${manifest.versions.length} version(s) recorded)` };
      if (!fs.existsSync(entry.path)) return { success: false, error: `restore: snapshot file missing on disk: ${entry.path}` };
      const cur = await _probe(ffprobe, videoPath).catch(() => null);
      _snapshot(videoPath, {
        action: 'pre-restore',
        note: action.note || `state before restoring v${version}`,
        durationMs: cur?.durationMs,
      });
      // Copy to a temp sibling first, then atomically rename over the clip.
      const tmp = path.join(path.dirname(videoPath), `.restore-${Date.now()}${path.extname(videoPath)}`);
      fs.copyFileSync(entry.path, tmp);
      fs.renameSync(tmp, videoPath);
      const after = await _probe(ffprobe, videoPath).catch(() => null);
      channel.log('video', `replace_take: restored v${version} over ${path.basename(videoPath)}`);
      return {
        success: true,
        savedTo: videoPath,
        restoredVersion: version,
        durationMs: after?.durationMs ?? null,
        history: _loadManifest(dir).versions.slice().reverse(),
      };
    }

    // ── replace ──────────────────────────────────────────────────────────
    const fromMs = Number(action.fromMs);
    const toMs = Number(action.toMs);
    const replPath = action.replacement ? path.resolve(action.replacement) : null;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return { success: false, error: 'replace: valid "fromMs" < "toMs" are required (the take\'s bounds in the current clip)' };
    }
    if (!replPath) return { success: false, error: 'replace: "replacement" is required (the new take\'s video file)' };
    if (!fs.existsSync(replPath)) return { success: false, error: `Replacement not found: ${action.replacement}` };
    if (path.resolve(replPath) === videoPath) return { success: false, error: 'replace: "replacement" must be a different file from "video"' };

    let src;
    let repl;
    try {
      src = await _probe(ffprobe, videoPath);
      repl = await _probe(ffprobe, replPath);
    } catch (err) {
      return { success: false, error: `replace_take: ${err.message}` };
    }
    // 300 ms tolerance absorbs container-duration rounding at the clip tail.
    if (toMs > src.durationMs + 300) {
      return { success: false, error: `replace: toMs=${toMs} is past the clip's end (${src.durationMs} ms)` };
    }
    const effToMs = Math.min(toMs, src.durationMs);
    const segMs = effToMs - fromMs;
    const matchDuration = action.matchDuration !== false;
    const useReplMs = matchDuration ? Math.min(repl.durationMs, segMs) : repl.durationMs;
    const deltaMs = useReplMs - segMs;
    if (deltaMs < -250) {
      channel.log('video', `replace_take: replacement is ${-deltaMs}ms SHORTER than the take — the clip will shorten`);
    }

    // Snapshot the current state BEFORE touching anything.
    const { version } = _snapshot(videoPath, {
      action: 'replace',
      note: action.note || null,
      fromMs,
      toMs: effToMs,
      durationMs: src.durationMs,
    });

    // Build the splice filtergraph: pre [0..from) + replacement + post (to..end].
    // The replacement is normalized to the source's geometry/rate so concat
    // never mismatches; audio follows the SOURCE's shape (silence fills a
    // silent replacement so the bed never truncates mid-clip).
    const from = (fromMs / 1000).toFixed(3);
    const to = (effToMs / 1000).toFixed(3);
    const replTo = (useReplMs / 1000).toFixed(3);
    const hasPre = fromMs > 10;
    const hasPost = effToMs < src.durationMs - 10;
    const parts = [];
    const vLabels = [];
    const aLabels = [];
    if (hasPre) {
      parts.push(`[0:v]trim=0:${from},setpts=PTS-STARTPTS[v_pre]`);
      vLabels.push('[v_pre]');
      if (src.hasAudio) { parts.push(`[0:a]atrim=0:${from},asetpts=PTS-STARTPTS[a_pre]`); aLabels.push('[a_pre]'); }
    }
    parts.push(`[1:v]trim=0:${replTo},setpts=PTS-STARTPTS,scale=${src.width}:${src.height},fps=${src.fps},setsar=1[v_new]`);
    vLabels.push('[v_new]');
    if (src.hasAudio) {
      if (repl.hasAudio) {
        parts.push(`[1:a]atrim=0:${replTo},asetpts=PTS-STARTPTS,aresample=48000[a_new]`);
      } else {
        parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${replTo},asetpts=PTS-STARTPTS[a_new]`);
      }
      aLabels.push('[a_new]');
    }
    if (hasPost) {
      parts.push(`[0:v]trim=${to}:,setpts=PTS-STARTPTS[v_post]`);
      vLabels.push('[v_post]');
      if (src.hasAudio) { parts.push(`[0:a]atrim=${to}:,asetpts=PTS-STARTPTS[a_post]`); aLabels.push('[a_post]'); }
    }
    const n = vLabels.length;
    const interleaved = src.hasAudio
      ? vLabels.map((v, i) => v + aLabels[i]).join('')
      : vLabels.join('');
    parts.push(`${interleaved}concat=n=${n}:v=1:a=${src.hasAudio ? 1 : 0}[vout]${src.hasAudio ? '[aout]' : ''}`);

    const tmp = path.join(path.dirname(videoPath), `.splice-${Date.now()}.mp4`);
    const args = [
      '-y', '-v', 'error',
      '-i', videoPath,
      '-i', replPath,
      '-filter_complex', parts.join(';'),
      '-map', '[vout]',
      ...(src.hasAudio ? ['-map', '[aout]'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      ...(src.hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
      '-movflags', '+faststart',
      tmp,
    ];
    const res = await _run(ffmpeg, args);
    if (res.code !== 0 || !fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* */ }
      return { success: false, error: `replace_take: ffmpeg splice failed: ${res.err.slice(-500)}` };
    }
    fs.renameSync(tmp, videoPath);
    const after = await _probe(ffprobe, videoPath).catch(() => null);
    channel.log(
      'video',
      `replace_take: spliced [${fromMs}–${effToMs}ms] of ${path.basename(videoPath)} with ${path.basename(replPath)} ` +
      `(snapshot v${version}; ${after ? `now ${after.durationMs}ms` : 'probe failed'})`,
    );
    return {
      success: true,
      savedTo: videoPath,
      previousVersion: version,
      fromMs,
      toMs: effToMs,
      replacedDurationMs: segMs,
      newTakeDurationMs: useReplMs,
      durationDeltaMs: (after?.durationMs ?? (src.durationMs + deltaMs)) - src.durationMs,
      durationMs: after?.durationMs ?? null,
      history: _loadManifest(dir).versions.slice().reverse(),
    };
  },
};
