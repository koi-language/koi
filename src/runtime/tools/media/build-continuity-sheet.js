/**
 * Build Continuity Sheet — compose the FIRST and LAST frame of every take
 * of a clip into ONE ordered grid image, to be used as the spatial
 * continuity anchor for the NEXT clip of the same film.
 *
 * Why this exists
 * ---------------
 * Multi-clip films drift: clip K+1 re-invents where each character stands
 * (the reported "the boy was on her right, next clip on her left" bug).
 * The documented chaining mechanism — attach clip K as a `referenceVideos`
 * reference — is DEAD for photoreal-face films: raw, Seedance's likeness
 * filter rejects the whole render; blurred (the card's workaround), it
 * preserves "motion, pacing, palette and audio" but destroys exactly the
 * positional detail the next clip needs.
 *
 * A still grid solves it: it carries the screen positions precisely, and
 * — unlike a video reference — it can be run through the SAME Seedream
 * re-description laundering that already clears the likeness filter for
 * character turnarounds. So the pipeline is:
 *
 *   build_continuity_sheet(clip K)  →  Seedream 1:1 clone  →  attach as a
 *   reference image on clip K+1, explained by `promptHint`.
 *
 * Layout: 2 columns × N rows. One row per take, in order; left cell = that
 * take's FIRST frame, right cell = its LAST frame. Black gutters, no burned
 * text — labels are NEVER drawn into the sheet (the video model would
 * happily render them, and the Seedream clone would mangle them). The
 * layout is explained to the model in prose instead; `promptHint` returns
 * exactly that sentence so the description can never drift from the image.
 *
 * Take boundaries come from the CALLER (`cuts`), not from shot detection:
 * the storyboard already knows each shot's duration, so the cut points are
 * exact by construction. Omit `cuts` and the whole clip is one take.
 *
 * Permission: 'write' (creates a local image file).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureFfmpeg } from '../../media/ffmpeg-installer.js';
import { channel } from '../../io/channel.js';

/** Seek this far INSIDE each boundary before grabbing the frame. Exactly
 *  on a cut the decoded frame can already belong to the neighbouring
 *  shot, which would put the wrong staging in the cell. */
const _EDGE_EPSILON_S = 0.08;
const _GUTTER = 16;
const _DEFAULT_CELL_W = 640;

function _projectRoot() {
  return process.env.KOI_PROJECT_ROOT || process.cwd();
}

function _formatTimestamp(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

async function _resolveFfprobe() {
  try {
    const r = await ensureFfmpeg();
    if (r?.ffprobe) return r.ffprobe;
  } catch { /* fall back to PATH */ }
  return 'ffprobe';
}

async function _probeDurationSec(filePath) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const ffprobe = await _resolveFfprobe();
    const { stdout } = await run(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { timeout: 5000 },
    );
    const sec = Number(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch { return null; }
}

function _runFfmpeg(ffmpeg, argv) {
  return new Promise((resolve, reject) => {
    let tail = '';
    const child = spawn(ffmpeg, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (b) => { tail = (tail + b.toString('utf8')).slice(-4096); });
    child.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    child.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited ${code}: ${tail.trim() || '(no stderr)'}`))));
  });
}

/** Grab one frame at `atSec`, backing off when the seek lands past the
 *  last decodable frame. ffprobe's container duration routinely runs a
 *  few tens of ms beyond the final video PTS, so the END frame of the
 *  LAST take — the single most load-bearing cell of the sheet, the one
 *  the next clip continues from — is exactly where a naive seek silently
 *  yields nothing. We walk backwards, then fall back to ffmpeg's own
 *  EOF-relative seek (which re-writes the output for every frame in the
 *  trailing window, leaving the last one on disk).
 *  Returns the seconds actually grabbed. */
async function _grabFrame(ffmpeg, video, atSec, outPath, floorSec = 0) {
  const base = ['-hide_banner', '-loglevel', 'error'];
  for (const back of [0, 0.15, 0.4, 0.8]) {
    const t = atSec - back;
    if (t < floorSec) break;
    try {
      await _runFfmpeg(ffmpeg, [
        ...base, '-ss', _formatTimestamp(t), '-i', video,
        '-frames:v', '1', '-an', '-y', outPath,
      ]);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return t;
    } catch { /* try an earlier offset */ }
  }
  // Last resort: EOF-relative seek over the trailing second.
  try {
    await _runFfmpeg(ffmpeg, [
      ...base, '-sseof', '-1', '-i', video, '-update', '1', '-an', '-y', outPath,
    ]);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return atSec;
  } catch { /* fall through to the caller's error */ }
  return null;
}

export default {
  type: 'build_continuity_sheet',
  intent: 'build_continuity_sheet',
  description:
    'Compose the FIRST and LAST frame of every take of a clip into ONE ordered grid image — the spatial continuity anchor for the NEXT clip of the same film. ' +
    'This is the chaining mechanism on EVERY video model: run it on clip K and attach the sheet to clip K+1 so characters keep their screen positions across clips. ' +
    'Required: "video" (absolute path to the clip). Optional: "cuts" — the INTERIOR shot boundaries in seconds (cumulative shot durations from the storyboard, e.g. [3.5, 6.5, 9.5, 12.5] for a 5-shot clip); omit for a single-take clip. Optional: "saveTo", "cellWidth". ' +
    'Layout: 2 columns x N rows — one row per take in order, left cell = its first frame, right cell = its last frame. No text is drawn into the sheet. ' +
    'Returns { success, savedTo, takes, rows, width, height, promptHint } — paste `promptHint` into the next clip\'s prompt so the description matches the actual grid. ' +
    'Attach it as-is on every model EXCEPT one with a likeness filter (Seedance): there, run the sheet through the Seedream 1:1 re-description clone first, exactly like a character turnaround.',
  thinkingHint: 'Building continuity sheet',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      video:     { type: 'string', description: 'Absolute path to the clip whose takes are sheeted (the PREVIOUS clip of the film).' },
      cuts:      { type: 'array', items: { type: 'number' }, description: 'INTERIOR shot boundaries in seconds, ascending — the cumulative shot durations of the clip minus its total (e.g. shots of 3.5/3/3/3/2.5s → [3.5, 6.5, 9.5, 12.5]). Omit when the clip is a single continuous take.' },
      saveTo:    { type: 'string', description: 'Destination .png path. Defaults to "<projectRoot>/.koi/frames/<clipName>-continuity.png".' },
      cellWidth: { type: 'number', description: `Width in px of each cell (default ${_DEFAULT_CELL_W}). Cell height follows the source aspect.` },
    },
    required: ['video'],
  },

  examples: [
    { intent: 'build_continuity_sheet', video: '/Users/me/.koi/videos/clip1.mp4', cuts: [3.5, 6.5, 9.5, 12.5] },
    { intent: 'build_continuity_sheet', video: '/tmp/clip2.mp4' },
  ],

  async execute(action) {
    const videoPath = action.video;
    if (!videoPath) return { success: false, error: 'build_continuity_sheet: "video" is required' };
    const video = path.resolve(videoPath);
    if (!fs.existsSync(video)) return { success: false, error: `Video not found: ${videoPath}` };

    const _videoExts = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
    const ext = path.extname(video).toLowerCase();
    if (!_videoExts.has(ext)) {
      return {
        success: false,
        error: `build_continuity_sheet: "video" must be a VIDEO file (${[..._videoExts].join(', ')}). Got "${ext || '(no extension)'}".`,
      };
    }

    let sharp;
    try { sharp = (await import('sharp')).default; }
    catch (e) { return { success: false, error: `build_continuity_sheet: sharp unavailable: ${e.message}` }; }

    const durationSec = await _probeDurationSec(video);
    if (!durationSec) {
      return { success: false, error: `build_continuity_sheet: could not probe the duration of ${path.basename(video)} — is it a readable video?` };
    }

    // Take bounds = [0, ...interior cuts, duration]. Cuts outside the clip
    // are dropped rather than clamped: a cut past the end means the caller
    // summed the storyboard wrong, and silently folding it into the last
    // take would emit a sheet whose rows don't match the shots.
    const rawCuts = Array.isArray(action.cuts) ? action.cuts : [];
    const cuts = rawCuts
      .map(Number)
      .filter((c) => Number.isFinite(c) && c > _EDGE_EPSILON_S && c < durationSec - _EDGE_EPSILON_S)
      .sort((a, b) => a - b);
    const droppedCuts = rawCuts.length - cuts.length;
    if (droppedCuts > 0) {
      channel.log(
        'media',
        `build_continuity_sheet: ignored ${droppedCuts} cut(s) outside 0–${durationSec.toFixed(2)}s ` +
        `(clip is ${durationSec.toFixed(2)}s; check the shot durations you summed).`,
      );
    }
    const bounds = [0, ...cuts, durationSec];
    const takes = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      takes.push({ take: i + 1, fromSeconds: bounds[i], toSeconds: bounds[i + 1] });
    }

    const savePath = action.saveTo
      ? path.resolve(action.saveTo)
      : path.join(_projectRoot(), '.koi', 'frames', `${path.basename(video, ext)}-continuity.png`);
    if (path.extname(savePath).toLowerCase() !== '.png') {
      return { success: false, error: `build_continuity_sheet: "saveTo" must end in .png (got "${path.extname(savePath) || '(none)'}").` };
    }
    fs.mkdirSync(path.dirname(savePath), { recursive: true });

    const { ffmpeg } = await ensureFfmpeg();
    const tmpDir = fs.mkdtempSync(path.join(_projectRoot(), '.koi', 'frames', 'cont-'));

    try {
      channel.log(
        'media',
        `build_continuity_sheet: ${path.basename(video)} (${durationSec.toFixed(2)}s) → ${takes.length} take(s), ${takes.length * 2} frames`,
      );

      // Grab both edges of every take. Sequential on purpose: ffmpeg
      // single-frame seeks are fast, and a fan-out of N*2 spawns on a
      // machine already rendering video buys nothing.
      const cells = [];
      for (const t of takes) {
        const at = [
          Math.min(t.fromSeconds + _EDGE_EPSILON_S, t.toSeconds - 0.01),
          Math.max(t.toSeconds - _EDGE_EPSILON_S, t.fromSeconds + 0.01),
        ];
        for (let k = 0; k < 2; k++) {
          const out = path.join(tmpDir, `t${t.take}-${k === 0 ? 'in' : 'out'}.png`);
          const got = await _grabFrame(ffmpeg, video, at[k], out, t.fromSeconds);
          if (got == null) {
            return { success: false, error: `build_continuity_sheet: ffmpeg produced no frame at ${at[k].toFixed(2)}s (take ${t.take}, ${k === 0 ? 'first' : 'last'} frame).` };
          }
          cells.push(out);
        }
      }

      // Uniform cells: every frame comes from the same video, so one probe
      // sets the cell height for all of them.
      const cellW = Math.max(160, Math.round(Number(action.cellWidth) || _DEFAULT_CELL_W));
      const first = await sharp(cells[0]).metadata();
      if (!first?.width || !first?.height) {
        return { success: false, error: 'build_continuity_sheet: could not read the extracted frames\' dimensions.' };
      }
      const cellH = Math.max(1, Math.round(cellW * (first.height / first.width)));

      const cols = 2;
      const rows = takes.length;
      const sheetW = cols * cellW + (cols + 1) * _GUTTER;
      const sheetH = rows * cellH + (rows + 1) * _GUTTER;

      const composites = [];
      for (let i = 0; i < cells.length; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const buf = await sharp(cells[i]).resize(cellW, cellH, { fit: 'fill' }).png().toBuffer();
        composites.push({
          input: buf,
          left: _GUTTER + c * (cellW + _GUTTER),
          top: _GUTTER + r * (cellH + _GUTTER),
        });
      }

      await sharp({
        create: { width: sheetW, height: sheetH, channels: 3, background: { r: 0, g: 0, b: 0 } },
      }).composite(composites).png().toFile(savePath);

      // The description the model must be given. Returned (not burned into
      // the pixels) so the prose can never contradict the actual grid.
      const promptHint = rows === 1
        ? 'This image is NOT a frame to render: it is a 2-cell continuity strip from the PREVIOUS clip of this same film — left cell is its first frame, right cell is its last frame. Read it ONLY to keep every character on the SAME screen side, in the same wardrobe, set and lighting. This clip continues from the RIGHT cell. Never reproduce the grid, the black gutters or the split layout in the video.'
        : `This image is NOT a frame to render: it is a ${rows}x2 continuity grid from the PREVIOUS clip of this same film. Each ROW is one shot of that clip, in order (top row = its first shot); in each row the LEFT cell is that shot's first frame and the RIGHT cell its last frame. Read it ONLY to keep every character on the SAME screen side, in the same wardrobe, set and lighting. This clip continues from the BOTTOM-RIGHT cell. Never reproduce the grid, the black gutters or the split layout in the video.`;

      const stat = fs.statSync(savePath);
      return {
        success: true,
        savedTo: savePath,
        sourceVideo: video,
        durationSeconds: Number(durationSec.toFixed(3)),
        takes: takes.map((t) => ({
          take: t.take,
          fromSeconds: Number(t.fromSeconds.toFixed(3)),
          toSeconds: Number(t.toSeconds.toFixed(3)),
        })),
        rows,
        columns: cols,
        width: sheetW,
        height: sheetH,
        fileSize: stat.size,
        promptHint,
      };
    } catch (err) {
      return { success: false, error: `build_continuity_sheet: ${err.message}` };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  },
};
