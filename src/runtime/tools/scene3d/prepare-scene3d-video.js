/**
 * prepare_scene3d_video — everything the REAL video of one or more 3D
 * timeline clips is generated from. The 3D is the SOURCE of the real take:
 *
 *   - each clip's exact window on the scene clock (trim / slip included) is
 *     baked to an mp4 → the motion reference (camera + blocking);
 *   - the pictures of what is in it: the characters' turnaround sheets /
 *     photos, the place's plates and the storyboard's reference images;
 *   - the storyboard shot it plays (look, light, action, dialogue).
 *
 * ONE TAKE over several small ones: consecutive clips of the same 3D set
 * (same track, end to end) form a GROUP — their windows are joined into one
 * reference and generated as ONE multi-shot take (same light, wardrobe,
 * props and sound bed across the cuts), which assign_scene3d_take then
 * splits back over the clips at its real cuts.
 *
 * The clips' LENGTHS are protected: the reference covers at least the clips
 * (rounded up to whole seconds, continuing on the scene clock), the take is
 * generated at least that long, and each clip windows its own stretch — the
 * 3D stays as every clip's placeholder, one toggle away.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { readScene, bakeWindow, bakeInFrame, isLivePath, storyboardPath, renderDir } from './_store.js';
import { sceneSpatialRefs } from './_previz-sync.js';
import { getTimeline } from '../../state/timelines.js';
import { readCharacter } from '../../state/character-registry.js';
import { readObject, objectVideoImages, objectVideoDetails } from '../../state/object-registry.js';
import { resolveTimelineId } from '../timeline/_resolve-timeline-id.js';
import { channel } from '../../io/channel.js';
import { notePendingTake } from './_pending-takes.js';
import { readModel } from './_models.js';
import { clipShotIds } from './_story-timeline.js';
import { physicsReport } from './_physics.js';
import { readDocJson } from '../../state/project-paths.js';

/** The model 3D clips are generated with (user decision: Seedance 2.5). */
export const SCENE3D_VIDEO_MODEL = 'bytedance/seedance-2.5/us/reference-to-video';
// A take's reference is always baked at the model's top resolution (short side,
// Seedance 2.5: 1080p) and top quality, whatever the take's output: a soft
// reference makes a soft take. generate_video scales it down to the output.
const REFERENCE_SHORT_SIDE = 1080;
// Seedance 2.5 reference-to-video: 4–30 s per generation.
const MIN_TAKE_MS = 4000;
const MAX_TAKE_MS = 30000;

const _IMG = /\.(png|jpe?g|webp)$/i;
const _file = (p) => typeof p === 'string' && path.isAbsolute(p) && _IMG.test(p) && fs.existsSync(p);

function _readJson(fp) {
  try { return readDocJson(fp); } catch { return null; }
}

/** Scene-clock ms where the clip's window starts, whichever side it shows. */
export function scene3dWindowStart(clip, shot) {
  if (isLivePath(clip.path)) return Math.round(clip.sourceInMs || 0);
  const ai = clip.aiState;
  if (ai && isLivePath(ai.placeholderPath) && Number.isFinite(ai.placeholderSourceInMs)) {
    return Math.round(ai.placeholderSourceInMs);
  }
  return shot.startMs;
}

function _characterRefs(scene, shot, sb) {
  const seen = shot.preview?.inFrame?.characters;
  const ids = Array.isArray(seen) && seen.length ? new Set(seen.map((c) => c.id)) : null;
  const cast = Array.isArray(sb?.characters) ? sb.characters : [];
  const out = [];
  for (const c of scene.characters || []) {
    if (ids && !ids.has(c.id)) continue;
    const name = String(c.name || '').toLowerCase();
    const cardId = c.characterId
      || cast.find((x) => x?.characterId && name && String(x.name || '').toLowerCase() === name)?.characterId;
    const card = cardId ? readCharacter(cardId) : null;
    if (!card) continue;
    const imgs = [card.sheet, ...(Array.isArray(card.photos) ? card.photos : [])].filter(_file);
    if (imgs.length) out.push({ character: card.name || c.name, images: imgs.slice(0, 2) });
  }
  return out;
}

// The previz tints when a character has no colour of its own (same order as
// the builder's CHAR_PALETTE).
const _PALETTE = ['#c0694a', '#4a7cc0', '#6aa05a', '#b58a3c', '#8a5ab0', '#4aa6a0'];

/** A coarse colour word for a previz tint (the grey figures differ only by it). */
function _colourWord(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 'grey';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.08) return l > 0.6 ? 'white' : l < 0.3 ? 'dark grey' : 'grey';
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 20 || h >= 330) return 'red-pink';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

/** How each character looks in the grey previz: its tint and height. */
function _castKey(scene) {
  return (scene.characters || []).map((c, i) => ({
    id: c.id,
    name: c.name || c.id,
    previz: `${_colourWord(c.color || _PALETTE[i % _PALETTE.length])} figure, ${Number(c.height || 1.75).toFixed(2)} m tall`,
  }));
}

/**
 * The story's objects the take shows (a train, a motorbike): the props in
 * frame that are tied to a storyboard `objects` entry (prop `object`) or to a
 * modeled asset (prop `model`), with their reference images, so the real take
 * keeps their look and the prompt can tie each grey shape to its object.
 */
function _objectRefs(scene, bakes, sb) {
  const props = new Map(((scene.set && scene.set.props) || []).map((p) => [p.id, p]));
  const seen = new Set();
  for (const b of bakes) {
    for (const smp of bakeInFrame(b)?.timeline || []) {
      for (const e of smp.seen || []) {
        if (e.off) continue;
        if (props.has(e.id)) seen.add(e.id);
        if (e.in && props.has(e.in)) seen.add(e.in);
      }
    }
  }
  const roster = Array.isArray(sb?.objects) ? sb.objects : [];
  const isImg = (f) => typeof f === 'string' && path.isAbsolute(f) && fs.existsSync(f);
  const out = [];
  for (const id of seen) {
    const p = props.get(id);
    const entry = p.object
      ? roster.find((o) => String(o?.name || '').toLowerCase() === String(p.object).toLowerCase())
      : null;
    // A roster entry linked to a saved object card: the card's sheet (one slot
    // carrying its three views) or views, + photos, are the object's images, and
    // its 3D model stands in when the prop has none.
    const card = entry?.objectId ? readObject(entry.objectId) : null;
    const modelId = p.model || card?.model || null;
    const model = modelId ? readModel(modelId) : null;
    const images = [];
    if (card) for (const f of objectVideoImages(card)) if (isImg(f)) images.push(f);
    if (!images.length && isImg(entry?.image)) images.push(entry.image);
    if (!card) for (const r of model?.references || []) if (isImg(r?.image) && images.length < 2) images.push(r.image);
    if (!entry && !model) continue;
    const description = entry?.description || card?.description || model?.description;
    // The card's story-critical details (close-ups, "Interior: ..." views),
    // named by label so the prompt can point at them; their images are in
    // `images` right after the sheet.
    const details = card ? objectVideoDetails(card).filter((d) => isImg(d.path)) : [];
    out.push({
      id,
      name: entry?.name || model?.name || p.object || id,
      ...(description ? { description } : {}),
      previz: `grey ${p.shape || 'shape'}`,
      images,
      ...(details.length ? { details } : {}),
    });
  }
  return out;
}

/** Who the reference shows in a shot and where, read off its bake. */
function _onScreen(bake, key) {
  const inf = bake ? bakeInFrame(bake) : null;
  if (!Array.isArray(inf?.characters)) return undefined;
  // Near a border the figure is only partly in frame: say so, or the prompt
  // turns "right foreground" into someone filling half the shot (it hid the
  // children in a take).
  const side = (x) => (x < 0.1 ? 'left edge, partly out of frame' : x > 0.9 ? 'right edge, partly out of frame'
    : x < 0.36 ? 'left' : x > 0.64 ? 'right' : 'centre');
  return inf.characters
    .filter((c) => c.frames > 0 && c.share >= 0.05)
    .sort((a, b) => a.x - b.x)
    .map((c) => {
      const xs = Array.isArray(c.xs) ? c.xs : [c.x];
      const moves = side(xs[0]) !== side(xs[xs.length - 1]);
      return {
        name: c.name,
        previz: key.find((k) => k.id === c.id)?.previz,
        screen: moves ? `${side(xs[0])} → ${side(xs[xs.length - 1])}` : side(c.x),
        x: c.x,
        ...(Number.isFinite(c.dist)
          ? { depth: c.dist < 1.6 ? 'foreground' : c.dist < 4 ? 'midground' : 'background', distM: c.dist }
          : { size: c.share >= 0.6 ? 'fills the frame height' : c.share >= 0.3 ? 'large' : 'small / far' }),
      };
    });
}

/** What the reference shows second by second, as stretches of the take:
 *  [{ fromSec, toSec, inFrame: ["HERMANA (left, close)", "silver racecar driven by PILOTO_B (centre, 6 m)"] }]
 *  or [{ …, inFrame: [] }] when nobody / no vehicle is in view. */
function _inFrameTimeline(bake, scene, key, takeOffsetMs, fromMs, lenMs) {
  const tl = bakeInFrame(bake)?.timeline;
  if (!Array.isArray(tl) || !tl.length) return undefined;
  const props = new Map(((scene.set && scene.set.props) || []).map((p) => [p.id, p]));
  const name = (id) => key.find((k) => k.id === id)?.name || id;
  const riderOf = new Map((scene.actions || []).filter((a) => String(a.type).toLowerCase() === 'ride').map((a) => [a.prop, a.character]));
  const side = (x) => (x < 0.1 ? 'left edge' : x > 0.9 ? 'right edge' : x < 0.36 ? 'left' : x > 0.64 ? 'right' : 'centre');
  const near = (d) => (d < 2 ? 'close' : d < 8 ? `${Math.round(d)} m` : 'far');
  // Which way it faces as the shot sees it (front / back / profile): a
  // "medium close-up of his helmet" written frontal while the reference shows
  // the back of his head made the model CUT to a frontal shot mid-take.
  const facing = (f) => ({
    front: 'seen from the front', back: 'seen from directly behind',
    'front-left': 'three-quarter front, its left side', 'front-right': 'three-quarter front, its right side',
    'side-left': 'its left side (profile)', 'side-right': 'its right side (profile)',
    'back-left': 'three-quarter from behind, its left side', 'back-right': 'three-quarter from behind, its right side',
  })[f];
  const where = (e) => [side(e.x), near(e.dist), facing(e.faces)].filter(Boolean).join(', ');
  const label = (e) => {
    if (e.kind === 'vehicle') {
      const p = props.get(e.id) || {};
      const who = riderOf.get(e.id);
      return `${_colourWord(p.color)} ${p.shape || 'vehicle'}${who ? ` driven by ${name(who)}` : ''} (${where(e)})`;
    }
    return `${name(e.id)} (${where(e)})`;
  };
  const out = [];
  for (const smp of tl) {
    const t = smp.ms - fromMs;
    if (t < -50 || t > lenMs + 50) continue;
    // In frame vs nearby but OUT of frame (an event can happen there: the
    // prompt must say it happens AND that it stays out of shot).
    const all = smp.seen || [];
    const fold = (list, offFrame) => {
      // A rider whose vehicle is listed is said by the vehicle; on its own
      // (a close-up on the driver) it is said as the driver in it.
      const veh = new Set(list.filter((e) => e.kind === 'vehicle').map((e) => e.id));
      return list
        .filter((e) => !(e.in && veh.has(e.in)))
        .map((e) => {
          const what = e.in
            ? `${name(e.id)} in the ${_colourWord(props.get(e.in)?.color)} ${props.get(e.in)?.shape || 'vehicle'}`
            : null;
          if (offFrame) {
            const base = what || label({ ...e, x: 0.5 }).replace(/ \(.*\)$/, '');
            return `${base} (off-frame ${e.off}, ${near(e.dist)})`;
          }
          return what ? `${what} (${where(e)})` : label(e);
        })
        .filter(Boolean)
        .sort();
    };
    // A driver and their vehicle are one thing on screen: if either is in
    // frame, the other is not listed as "off frame".
    const inIds = new Set();
    for (const e of all) {
      if (e.off) continue;
      inIds.add(e.id);
      if (e.in) inIds.add(e.in);
      if (e.kind === 'vehicle' && riderOf.get(e.id)) inIds.add(riderOf.get(e.id));
    }
    const seen = fold(all.filter((e) => !e.off), false);
    const offFrame = fold(all.filter((e) => e.off && !inIds.has(e.id) && !(e.in && inIds.has(e.in))), true);
    const strip = (x) => x.replace(/, (close|\d+ m|far)(?=[,)])/, ''); // distance alone is no change
    const sig = [...seen.map(strip), '/', ...offFrame.map(strip)].join('|');
    const sec = Math.round(takeOffsetMs + Math.max(0, Math.min(lenMs, t))) / 1000;
    const last = out[out.length - 1];
    if (last && last.sig === sig) { last.toSec = sec; continue; }
    if (last) last.toSec = sec;
    out.push({ fromSec: sec, toSec: sec, inFrame: seen, ...(offFrame.length ? { offFrame } : {}), sig });
  }
  if (out.length) out[out.length - 1].toSec = Math.round(takeOffsetMs + lenMs) / 1000;
  return out.map(({ sig, ...r }) => r);
}

function _script(sbScene, sbShot) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    location: pick(sbScene?.location),
    shot: pick(sbShot?.shot),
    camera: pick(sbShot?.camera || sbShot?.movement),
    composition: pick(sbShot?.composition),
    lighting: pick(sbShot?.lighting),
    action: pick(sbShot?.action),
    dialogue: sbShot?.dialogue || undefined,
    sound: pick(sbShot?.sfx || sbShot?.sound),
  };
}

async function _ffmpeg() {
  try {
    const r = await (await import('../../media/ffmpeg-installer.js')).ensureFfmpeg();
    return r?.ffmpeg || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

function _run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

/** Join baked windows end to end into one reference (cached by content). */
export async function _join(sceneId, parts) {
  if (parts.length === 1) return parts[0];
  const key = crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 10);
  const out = path.join(renderDir(sceneId), `take-${key}.mp4`);
  if (fs.existsSync(out)) return out;
  const list = `${out}.txt`;
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  try {
    await _run(await _ffmpeg(), ['-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-crf', '12', '-an', `${out}.part.mp4`]);
    fs.renameSync(`${out}.part.mp4`, out);
    return out;
  } finally {
    fs.rmSync(list, { force: true });
  }
}

/** Consecutive clips of one 3D set, end to end on one track, ≤ MAX_TAKE_MS. */
function _groups(items, oneTake) {
  const out = [];
  for (const it of items) {
    const g = out[out.length - 1];
    const last = g?.[g.length - 1];
    const total = g ? g.reduce((n, x) => n + x.clip.durationMs, 0) : 0;
    const joins = oneTake && last
      && last.clip.track === it.clip.track
      && last.scene.id === it.scene.id
      && Math.abs(last.clip.startMs + last.clip.durationMs - it.clip.startMs) <= 50
      && Math.ceil((total + it.clip.durationMs) / 1000) * 1000 <= MAX_TAKE_MS;
    if (joins) g.push(it); else out.push([it]);
  }
  return out;
}

export default {
  type: 'prepare_scene3d_video',
  intent: 'prepare_scene3d_video',
  description:
    'FIRST STEP to turn 3D previz timeline clips into REAL video ("pásalo a vídeo", "genera el vídeo de este/estos clips"). ' +
    'Call it ONLY when the user asks for video in their latest request, never as the next step after changing the 3D. ' +
    'Consecutive clips of the same 3D set are joined into ONE take (better continuity than separate clips): per take it ' +
    'bakes the clips\' exact 3D windows end to end into one mp4 (the reference for camera + where the characters stand, travel and face + the ' +
    'cuts; NOT for their body motion, which is a crude placeholder the model must never copy), and collects the pictures of what is in it (character sheets/photos, the place\'s plates, storyboard refs) plus ' +
    'each shot\'s script and where it falls in the take. `clipIds` omitted → every 3D clip of the timeline still showing its ' +
    'previz. Then per take: generate_video with the returned `model`, `referenceVideos: [referenceVideo]`, `referenceImages`, ' +
    '`duration: durationSec`, and finally assign_scene3d_take — the take keeps its place and total length and the 3D stays one toggle away.',
  thinkingHint: 'Preparing 3D references',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      timelineId: { type: 'string', description: 'Timeline id (default: the active one)' },
      clipIds: { type: 'array', items: { type: 'string' }, description: '3D clips to turn into video (default: all still in 3D)' },
      oneTake: { type: 'boolean', description: 'Join consecutive clips of one set into one take (default true). false only when the user asks for separate takes.' },
    },
  },

  async execute(params) {
    let timelineId = params?.timelineId ? String(params.timelineId) : await resolveTimelineId({});
    // A GUI tab handle ("tab-0") is not a timeline id: the active timeline is.
    if (timelineId && !getTimeline(timelineId)) timelineId = await resolveTimelineId({});
    const tl = timelineId ? getTimeline(timelineId) : null;
    if (!tl) return { success: false, error: 'prepare_scene3d_video: no timeline — pass `timelineId`.' };
    const all = (tl.clips || []).filter((c) => c?.scene3d?.sceneId && c.scene3d?.shotId);
    let clips;
    if (Array.isArray(params.clipIds) && params.clipIds.length) {
      const byId = new Map(all.map((c) => [c.id, c]));
      const missing = params.clipIds.filter((id) => !byId.has(id));
      if (missing.length) {
        return { success: false, error: `prepare_scene3d_video: not 3D clips of ${timelineId}: ${missing.join(', ')}` };
      }
      clips = params.clipIds.map((id) => byId.get(id));
      const locked = clips.filter((c) => c.locked === true).map((c) => c.id);
      if (locked.length) {
        return { success: false, error: `prepare_scene3d_video: the user locked these clips: ${locked.join(', ')}. Leave them out, or ask the user to unlock them.` };
      }
    } else {
      clips = all.filter((c) => isLivePath(c.path) && c.locked !== true);
    }
    if (!clips.length) return { success: false, error: 'prepare_scene3d_video: no 3D clips to turn into video on this timeline.' };
    clips.sort((a, b) => String(a.track).localeCompare(String(b.track)) || a.startMs - b.startMs);

    const sbCache = new Map();
    const storyboard = (id) => {
      if (!id) return null;
      if (!sbCache.has(id)) sbCache.set(id, _readJson(storyboardPath(id)));
      return sbCache.get(id);
    };

    const failed = [];
    const items = [];
    for (const c of clips) {
      const scene = readScene(c.scene3d.sceneId);
      const shot = scene?.shots?.find((s) => s.id === c.scene3d.shotId);
      if (!shot) { failed.push({ clipId: c.id, error: `no 3D shot ${c.scene3d.sceneId}/${c.scene3d.shotId}` }); continue; }
      const sb = storyboard(scene.storyboard?.id);
      const sbScene = sb?.scenes?.find((x) => x?.id === (c.scene3d.storyboardSceneId || scene.storyboard?.sceneId));
      const from = scene3dWindowStart(c, shot);
      // A continuous take (one clip over several shots): one stretch per
      // shot, each baked through its own camera, told as one unbroken take.
      const shots = clipShotIds(c).map((id) => scene.shots.find((s) => s.id === id)).filter(Boolean);
      const end = from + c.durationMs;
      shots.forEach((sh, j) => {
        const a = j ? Math.max(from, sh.startMs) : from;
        const b = j < shots.length - 1 ? Math.min(end, shots[j + 1].startMs) : end;
        if (b - a < 1) return;
        const sbShot = sbScene?.shots?.find((x) => x?.id === ((j ? null : c.scene3d.storyboardShotId) || sh.storyboardShotId));
        items.push({ clip: shots.length > 1 ? { ...c, startMs: c.startMs + a - from, durationMs: b - a } : c,
          scene, shot: sh, sb, sbScene, sbShot, from: a, continues: j > 0 });
      });
    }

    /** The reference's size: the canvas' shape (else the scene's) at the top resolution. */
    const referenceSize = (scene) => {
      const w = tl.settings?.width || scene.resolution?.width || 16;
      const h = tl.settings?.height || scene.resolution?.height || 9;
      const k = REFERENCE_SHORT_SIDE / Math.min(w, h);
      return { width: Math.round(w * k), height: Math.round(h * k) };
    };
    const takes = [];
    await Promise.all(_groups(items, params.oneTake !== false).map(async (g) => {
      const total = g.reduce((n, x) => n + x.clip.durationMs, 0);
      const takeMs = Math.min(MAX_TAKE_MS, Math.max(MIN_TAKE_MS, Math.ceil(total / 1000) * 1000));
      const { scene } = g[0];
      let parts;
      try {
        parts = await Promise.all(g.map((x, i) => {
          // The last window runs on past its clip (same camera, scene clock)
          // so the reference is the whole take: the take never ends early.
          const len = i === g.length - 1
            ? Math.max(x.clip.durationMs, Math.min(x.clip.durationMs + takeMs - total, scene.durationMs - x.from))
            : x.clip.durationMs;
          return bakeWindow(scene.id, x.shot.id, x.from, x.from + len, { ...referenceSize(scene), maxQuality: true, flatSurfaces: true });
        }));
      } catch (e) {
        for (const x of g) failed.push({ clipId: x.clip.id, error: `3D bake failed: ${e.message}` });
        return;
      }
      let referenceVideo;
      try {
        referenceVideo = await _join(scene.id, parts);
      } catch (e) {
        for (const x of g) failed.push({ clipId: x.clip.id, error: `joining the 3D windows failed: ${e.message}` });
        return;
      }
      const characters = [];
      const images = [];
      const addImg = (p) => { if (!images.includes(p)) images.push(p); };
      for (const x of g) {
        for (const ch of _characterRefs(x.scene, x.shot, x.sb)) {
          if (!characters.some((y) => y.character === ch.character)) characters.push(ch);
        }
      }
      for (const ch of characters) ch.images.forEach(addImg);
      const place = g[0].sbScene ? sceneSpatialRefs(g[0].sb, g[0].sbScene).slice(0, 4) : [];
      place.forEach(addImg);
      const objects = _objectRefs(scene, parts, g[0].sb);
      for (const o of objects) o.images.forEach(addImg);
      let at = 0;
      const castKey = _castKey(scene);
      const shots = g.map((x, i) => {
        const onScreen = _onScreen(parts[i], castKey);
        const inFrameTimeline = _inFrameTimeline(parts[i], scene, castKey, at, x.from, x.clip.durationMs);
        const s = {
          n: i + 1,
          clipId: x.clip.id,
          shotId: x.shot.id,
          storyboardShotId: x.sbShot?.id || x.shot.storyboardShotId || null,
          ...(x.continues ? { continuesWithoutCut: true } : {}),
          fromSec: Math.round(at) / 1000,
          toSec: Math.round(at + x.clip.durationMs) / 1000,
          // What the reference ACTUALLY shows: wins over the script's words.
          ...(onScreen ? { onScreen } : {}),
          ...(inFrameTimeline ? { inFrameTimeline } : {}),
          script: x.sbShot ? _script(x.sbScene, x.sbShot) : null,
          ...(!isLivePath(x.clip.path) ? { currentRealVideo: x.clip.path } : {}),
        };
        at += x.clip.durationMs;
        return s;
      });
      const first = g[0].clip;
      const prev = (tl.clips || [])
        .filter((x) => x.track === first.track && x.startMs + x.durationMs <= first.startMs + 1)
        .sort((a, b) => b.startMs - a.startMs)[0];
      const clipIds = [...new Set(g.map((x) => x.clip.id))];
      notePendingTake(referenceVideo, timelineId, clipIds);
      takes.push({
        startMs: first.startMs,
        clipIds,
        sceneId: scene.id,
        model: SCENE3D_VIDEO_MODEL,
        referenceVideo,
        durationSec: takeMs / 1000,
        clipsSec: Math.round(total) / 1000,
        aspectRatio: scene.aspect,
        shots,
        castKey,
        characters,
        ...(objects.length ? { objects } : {}),
        place,
        referenceImages: images,
        style: g[0].sb?.style || g[0].sb?.look || undefined,
        ...(prev && !isLivePath(prev.path) ? { previousClip: { clipId: prev.id, path: prev.path } } : {}),
      });
    }));
    takes.sort((a, b) => a.startMs - b.startMs);
    if (failed.length) channel.log('scene3d', `prepare_scene3d_video: ${failed.map((f) => `${f.clipId}: ${f.error}`).join('; ')}`);

    // The scene's motion in numbers: the take's script must say exactly that.
    const physics = takes.length ? physicsReport(readScene(takes[0].sceneId)).physics : null;
    return {
      success: takes.length > 0,
      timelineId,
      takes,
      ...(physics ? { physics } : {}),
      ...(failed.length ? { failed } : {}),
      next:
        'For EACH take (several → start them all with wait:false, then await): generate_video with `model` (always Seedance ' +
        '2.5 reference-to-video), `referenceVideos: [referenceVideo]` (a grey 3D previz: keep its camera moves, composition, ' +
        'where every character stands, travels and faces, the timing, and its CUTS exactly, re-render it photographically; ' +
        'its figures\' BODY MOTION is a crude placeholder, never copied), ALL its ' +
        '`referenceImages` (who and where — never drop them), `duration: durationSec`, `aspectRatio`, and ONE prompt ' +
        'written SHOT BY SHOT: one block per entry of `shots` ("Shot 1 (0–3.2 s): …"), and between two blocks the words ' +
        '"HARD CUT" (but before a block whose entry has `continuesWithoutCut`, write "NO CUT: the same take keeps rolling" ' +
        'instead: the camera flows on from the previous block in one unbroken move). Inside a block NO times at all (no "0–6 s", no "around 6 s": time marks read as more shots and the ' +
        'model cuts there): one paragraph that says this shot follows the reference video\'s camera EXACTLY as ONE ' +
        'continuous move, then tells in order what happens — what the camera does (its moves, zoom, focus pulls, ' +
        'framing), who is who and what they look like, what they do and feel (acting, gestures, lines), what happens ' +
        'out of shot, light and sound — chained with "then", "as", "while", never with times. Say once, plainly: "Cut ONLY at HARD CUT; never anywhere else." Keep light, wardrobe, props and ' +
        'sound continuous across the cuts. SOUND: no music in the take, even in the background or from a source in the ' +
        'scene (no score, song, humming or instrument sound); a band, radio or TV shown makes NO sound of its own; only ' +
        'sound effects, ambience and voices. Say so explicitly at the end of the prompt, unless the user asked for music ' +
        'in the clip. PICTURE QUALITY: the grey reference only carries motion and framing, never its ' +
        'look. Ask for the sharpest image the model can give: crisp focus on the subject, fine detail in skin, hair and ' +
        'fabric, clean high-resolution picture. Never ask for softness or degradation (no soft focus, soft contrast, haze, ' +
        'heavy film grain, low-res, VHS) unless the user asked for that look. Same framing as the reference: nothing tighter, ' +
        'nothing wider, the headroom it has. THE REFERENCE IS THE MASTER FOR CAMERA AND PLACEMENT ONLY: open the prompt ' +
        'by saying the attached video\'s camera, framing, what is in and out of frame, positions, paths, sides and timing override ' +
        'anything in the text, and right after that the grey figures are crude placeholders: take only where each one ' +
        'is, moves to and faces, and their body pose (standing, seated, riding, lying, kneeling...). Say that each figure\'s two dark eyes, ' +
        'pale chest panel, dark back panel and dark toes only mark which way the body faces (front or back, face up or face down), must be obeyed for that, and are NOT rendered. Do NOT copy their ' +
        'stiff block shapes, limb movement or gestures; every person moves and acts ' +
        'naturally, like a real actor, as the text says. The figures are abstract on purpose; a take that mimics the ' +
        'mannequin\'s pose or movement is a failed take. Say also that the reference\'s SURFACES carry no information: its flat grey ' +
        'materials and any shape or pattern on the ground, walls or objects are NOT rendered; the look of every surface ' +
        'comes ONLY from the reference images and the text (the 3D is for focus, framing and placement, never for what ' +
        'things look like). Describe each moment with what `inFrameTimeline` says: `inFrame` is what the shot SHOWS, ' +
        '`offFrame` is what is near but OUT of shot (side, distance). Something that happens off frame IS said — and said ' +
        'as off frame: "A\'s car overtakes on his right, entirely out of frame: we never see it, only its roar, the wash of ' +
        'its passing and B\'s eyes following it". Never write it as seen while the reference does not show it (the model ' +
        'invents it to obey the text), and never leave it unsaid when the story needs it. If the user wants it ON screen, ' +
        'tell them the 3D camera must frame it first. Say each figure\'s view EXACTLY as `inFrameTimeline` gives it (front / ' +
        'three-quarter front / side / three-quarter from behind / behind, and which of its sides): asking for a view the ' +
        'reference\'s camera does not have (e.g. "his face, sun full on it" while it shows the back of his head) makes the ' +
        'model CUT to get it. Write every change of framing inside a shot as the camera MOVING there, never as a new shot. Spend the words on WHO and WHAT things look like (cast, cars, place, light, sound) and on the ACTING: per shot, ' +
        'body language, gestures, expression and the manner of each movement, invented from the script and the beat\'s ' +
        'emotion, never read off the grey figure; do not re-describe the camera or paths the video already carries. SCREEN POSITIONS come from each shot\'s ' +
        '`onScreen` (read off the 3D: who is left / centre / right), NEVER from the script\'s words when they disagree — ' +
        'a prompt that puts someone on the other side than the reference makes the model follow the text and mirror the ' +
        'shot. Name every character with its previz look from `castKey` ("the boy — the small blue figure in the ' +
        'reference — …") so the model maps each grey figure to its character sheet, and every entry of `objects` the ' +
        'same way ("the steam train — the long grey shape in the reference — matches its reference image"). When an `objects` entry has `details` ([{label, path}], its story-critical close-ups and "Interior:" views, already among its images), name each one by its label in the prompt of the shots that show it; an insert or close-up of that part, or a shot inside the object, uses that detail as its reference. Review the take, then assign_scene3d_take ' +
        '{ timelineId, clipIds, mediaPath } — it splits the take over the clips at its real cuts (generate_video already does ' +
        'this on its own when the take used this referenceVideo: its result says `scene3dTake`; only call it yourself to ' +
        'put a DIFFERENT take on the clips). Only that landing moves ' +
        'the boundaries between the take\'s clips, to its real cuts: never trim, stretch or move a clip yourself, and never generate shorter than durationSec.',
    };
  },
};
