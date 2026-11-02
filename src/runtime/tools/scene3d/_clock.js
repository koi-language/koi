/**
 * Action and cameras are two separate things and together they are the film.
 * The action (scene.actions) runs on the scene clock and is only changed on
 * purpose. Each shot is a camera over a stretch of that clock, and which stretch
 * follows from the montage: story order + durations, one after the other. So
 * reordering, removing or resizing clips changes what is looked at from where,
 * never what happens, and the film cannot go back in time.
 */

function _inOrder(scene, storyOrder) {
  const all = (scene.shots || []).filter((sh) => sh.inMontage !== false);
  if (!storyOrder.length) return all;
  const rank = new Map(storyOrder.map((id, i) => [id, i]));
  return all.filter((sh) => rank.has(sh.storyboardShotId))
    .sort((a, b) => rank.get(a.storyboardShotId) - rank.get(b.storyboardShotId));
}

/**
 * Put each shot right after the previous one, in place. Keyframes are relative
 * to the shot, so its camera move plays whole. A shot in [frozenIds] (a locked
 * clip) keeps its stretch. Returns the ids of the shots that moved.
 */
export function layoutShots(scene, storyOrder, frozenIds = new Set()) {
  const shots = _inOrder(scene, storyOrder);
  const moved = [];
  let at = shots[0]?.startMs || 0;
  for (const sh of shots) {
    if (!frozenIds.has(sh.id) && sh.startMs !== at) {
      if (Array.isArray(sh.camWindow) && sh.camWindow.length === 2) sh.camWindow = [sh.camWindow[0] + at - sh.startMs, sh.camWindow[1]];
      sh.startMs = at;
      moved.push(sh.id);
    }
    at = sh.startMs + sh.durationMs;
  }
  return moved;
}

/** A hand-keyed camera moving at a displaced vehicle's speed travels with it. */
function _carryCamera(sh, moved, add, shift) {
  const keys = Array.isArray(sh.keyframes) && sh.keyframes.length ? sh.keyframes : sh.camera?.keyframes;
  if (!Array.isArray(keys) || keys.length < 2) return;
  const [a, b] = [keys[0], keys[keys.length - 1]];
  const secs = ((b.t || 0) - (a.t || 0)) / 1000;
  if (!(secs > 0) || !Array.isArray(a.position) || !Array.isArray(b.position)) return;
  for (const d of Object.values(moved)) {
    const speed = d.map((v) => v / (add / 1000));
    const size = Math.hypot(...speed);
    const off = Math.hypot(...speed.map((v, i) => (b.position[i] - a.position[i]) / secs - v));
    if (off > 0.15 * size) continue;
    for (const k of keys) {
      if (Array.isArray(k.position)) k.position = shift(k.position, d);
      if (Array.isArray(k.target)) k.target = shift(k.target, d);
    }
    return;
  }
}

/**
 * Add [ms] to the ACTION at [atMs], in place: a deliberate change of what
 * happens, never a side effect of editing clips. What runs across that moment
 * keeps going: a moving vehicle holds its speed, so it and everything later on
 * it end up further along, and so do hand-keyed cameras travelling with it.
 * Returns { propId: [dx, dy, dz] } for each vehicle displaced.
 */
export function insertSceneTime(scene, atMs, ms) {
  const at = Math.round(atMs), add = Math.round(ms);
  const moved = {};
  if (!(add > 0)) return moved;
  const props = scene.set?.props || [];
  const actions = scene.actions || [];
  for (const pid of new Set(actions.filter((a) => a.type === 'drive').map((a) => a.prop))) {
    const legs = actions.filter((a) => a.type === 'drive' && a.prop === pid)
      .sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    const start = props.find((p) => p.id === pid)?.position;
    let from = Array.isArray(start) ? start : null;
    for (const leg of legs) {
      const end = leg.endMs ?? (leg.startMs || 0) + 1000;
      if ((leg.startMs || 0) <= at && at < end && from && end > (leg.startMs || 0)) {
        const k = add / (end - (leg.startMs || 0));
        const d = [0, 1, 2].map((i) => (leg.to.length > i && from.length > i ? (leg.to[i] - from[i]) * k : 0));
        if (d.some((v) => Math.abs(v) > 1e-3)) moved[pid] = d;
        break;
      }
      from = leg.to;
    }
  }
  const shift = (to, d) => to.map((v, i) => (i < 3 ? Math.round((v + d[i]) * 1000) / 1000 : v));
  for (const a of actions) {
    if (typeof a.startMs !== 'number') continue;
    const end = a.endMs ?? a.startMs;
    if (end <= at && !(a.startMs === at)) continue;
    const d = moved[a.type === 'drive' ? a.prop : a.aboard];
    if (d && Array.isArray(a.to)) a.to = shift(a.to, d);
    if (d && Array.isArray(a.from) && a.startMs >= at) a.from = shift(a.from, d);
    if (a.startMs >= at) a.startMs += add;
    if (typeof a.endMs === 'number') a.endMs += add;
  }
  for (const sh of scene.shots || []) {
    if ((sh.startMs || 0) < at) continue;
    _carryCamera(sh, moved, add, shift);
  }
  return moved;
}
