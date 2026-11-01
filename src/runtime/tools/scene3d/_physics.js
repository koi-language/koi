/**
 * Physical plausibility of a scene's motion: people walk, run and jump like
 * people, vehicles drive like vehicles, things fall under gravity. Pure
 * numbers from the actions (the same jump arc the builder bakes): the agent
 * gets a list of what no real body or object could do, with the numbers to
 * fix it. Warnings, not errors: a script may ask for the superhuman.
 */

const G = 9.81;

// Speeds in m/s. Walk: 1.2-1.8 typical. Run: 3-6 jog to hard run, ~10 is a
// world-class sprinter at full speed.
const WALK_MAX = 2.5;
const RUN_HARD = 7;
const RUN_MAX = 10.5;
// Jumps: a fit adult's centre of mass rises ~0.5-0.9 m; ~1.2 m is elite.
// A running jump covers 2-4 m; ~8.9 m is the world record.
const JUMP_RISE_HARD = 0.9;
const JUMP_RISE_MAX = 1.3;
const JUMP_LONG_HARD = 5;
const JUMP_LONG_MAX = 8.5;
const DROP_HURTS = 4;
const DROP_DEADLY = 10;
// Top speeds by vehicle shape (m/s).
const VEHICLE_MAX = {
  bicycle: 16, scooter: 28, horse: 20, motorbike: 60, car: 70, racecar: 100, van: 50,
  truck: 40, bus: 35, train: 90, boat: 35,
};
const KICK_MAX = 35;
// Cadence: a walk takes ~2 steps a second (~0.5 s each), a run ~3.
const WALK_CADENCE = 2;
const RUN_CADENCE = 3;
// The shortest a body really takes to change pose (ms), on screen.
// lying: a fall or being knocked down (~0.5 s); lying down on purpose is ~1 s.
const POSE_MIN = { standing: 800, sitting: 700, lying: 450, kneeling: 600, crouching: 500 };
const POSE_FROM_LYING_TO_STANDING = 1500;
// A body off its feet coasts: what its path may do between two stretches
// with nothing acting on it (degrees, speed ratio, ignored below 0.3 m/s).
const COAST_TURN = 25;
const COAST_GAIN = 1.25;
const COAST_SPIN = 30;
// A tumble stops by friction (m/s²): rough roof or asphalt about 0.5 g, ice
// about 0.1 g; above ~1.2 g something must be stopping it.
const TUMBLE_DECEL_MAX = 12;
const TUMBLE_DECEL_MIN = 1;
// Landing speed against the surface (m/s) a person cannot just stand up from.
const IMPACT_HARD = 7;
// Hardest believable change of speed (m/s²) by vehicle, between legs.
const VEHICLE_ACCEL = { train: 1.5, bus: 4, truck: 4, van: 8, bicycle: 5, horse: 6, boat: 4 };
const VEHICLE_ACCEL_DEFAULT = 8;
const _poseOf = (type, a) => (type === 'sit' || type === 'sit_down' ? 'sitting'
  : type === 'stand' || type === 'stand_up' || type === 'get_up' ? 'standing'
    : type === 'lie' || type === 'lie_down' ? (a.pose || 'lying') : type === 'pose' ? String(a.pose || 'standing') : null);

const _xyz = (v, z = 0) => [Number(v?.[0]) || 0, Number(v?.[1]) || 0, v?.length > 2 ? Number(v[2]) || 0 : z];
const _h = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const _r = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

/** Where each driven prop is at scene ms (linear legs, waits between them). */
function _vehicleTracks(scene) {
  const props = new Map(((scene.set && scene.set.props) || []).map((p) => [p.id, p]));
  const tracks = new Map();
  for (const a of scene.actions || []) {
    if (String(a.type || '').toLowerCase() !== 'drive' || !props.has(a.prop) || !Array.isArray(a.to)) continue;
    if (!tracks.has(a.prop)) tracks.set(a.prop, []);
    tracks.get(a.prop).push(a);
  }
  const at = new Map();
  for (const [pid, legs] of tracks) {
    legs.sort((x, y) => (x.startMs || 0) - (y.startMs || 0));
    const p0 = _xyz(props.get(pid).position);
    const pts = [[legs[0].startMs || 0, p0]];
    for (const l of legs) {
      const s = l.startMs || 0, e = Math.max(s + 1, l.endMs ?? s + 1000);
      const last = pts[pts.length - 1];
      if (s > last[0]) pts.push([s, last[1]]);
      pts.push([e, _xyz(l.to, last[1][2])]);
    }
    at.set(pid, { pts, legs, prop: props.get(pid) });
  }
  const pos = (pid, ms) => {
    const t = at.get(pid);
    if (!t) return null;
    const { pts } = t;
    if (ms <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (ms <= pts[i][0]) {
        const [t0, a] = pts[i - 1], [t1, b] = pts[i];
        const f = (ms - t0) / Math.max(1, t1 - t0);
        return a.map((v, k) => v + (b[k] - v) * f);
      }
    }
    return pts[pts.length - 1][1];
  };
  return { at, pos };
}

/** @returns {string[]} one line per implausible motion (empty = all real). */
export function physicsWarnings(scene) {
  return _analyse(scene).warnings;
}

function _analyse(scene) {
  const out = [];
  const motion = [];
  const heldMove = new Map();
  const heldMoves = [];
  const coasting = new Map();
  const coastBreaks = [];
  const pose = new Map((scene.characters || []).map((c) => [c.id, String(c.pose || 'standing')]));
  const cuts = (scene.shots || []).map((sh) => sh.startMs || 0);
  const veh = _vehicleTracks(scene);
  const acts = (scene.actions || []).filter((a) => a && typeof a === 'object')
    .map((a, i) => ({ a, i })).sort((x, y) => (x.a.startMs || 0) - (y.a.startMs || 0));
  const where = new Map((scene.characters || []).map((c) => [c.id, _xyz(c.position)]));
  const riding = new Set();
  const impacts = [];
  const pendingImpact = new Map();

  // Displacement of the vehicle someone stands on, over [s, e]: their own
  // effort is what is left once it is taken off.
  const shift = (pid, s, e) => {
    const p0 = veh.pos(pid, s), p1 = veh.pos(pid, e);
    return p0 && p1 ? p1.map((v, k) => v - p0[k]) : null;
  };
  // `aboard`, or found: someone up off the ground (a roof, a deck) whose
  // path follows a moving vehicle is carried by it.
  const vehicleUnder = (a, from, dst, s, e) => {
    if (a.aboard) return veh.at.has(a.aboard) ? a.aboard : null;
    if (from[2] < 0.5) return null;
    const mv = [dst[0] - from[0], dst[1] - from[1]];
    const m = Math.hypot(...mv);
    let best = null, bestLeft = m;
    for (const pid of veh.at.keys()) {
      const d = shift(pid, s, e);
      const vd = d && Math.hypot(d[0], d[1]);
      if (!vd || vd / ((e - s) / 1000) < 2 || (mv[0] * d[0] + mv[1] * d[1]) / (m * vd || 1) < 0.5) continue;
      // Under them: on its line of travel (a long train is far ahead of its
      // origin, never beside it) and below their feet.
      const p = veh.pos(pid, s);
      const off = [from[0] - p[0], from[1] - p[1]];
      const lateral = Math.abs(off[0] * d[1] - off[1] * d[0]) / vd;
      if (lateral > 2.5 || p[2] > from[2] - 0.3) continue;
      const left = Math.hypot(mv[0] - d[0], mv[1] - d[1]);
      if (left < bestLeft) { best = pid; bestLeft = left; }
    }
    return best;
  };

  for (const { a, i } of acts) {
    const type = String(a.type || '').toLowerCase();
    const tag = `actions[${i}] (${type}${a.character ? ` ${a.character}` : a.prop ? ` ${a.prop}` : ''}, ${_r((a.startMs || 0) / 1000)}s)`;
    if (type === 'ride') { riding.add(a.character); continue; }
    const s = a.startMs || 0;
    const e = Math.max(s + 1, a.endMs ?? s + 1500);
    const secs = (e - s) / 1000;

    const impact = a.character && pendingImpact.get(a.character);
    if (impact && s - impact.e > 400) {
      impacts.push(impact);
      pendingImpact.delete(a.character);
    }
    if (type === 'tumble' && a.character) {
      const from = where.get(a.character);
      const dst = Array.isArray(a.to) ? _xyz(a.to, from ? from[2] : 0) : from;
      if (dst) where.set(a.character, dst);
      pose.set(a.character, String(a.pose || 'lying_front'));
      coasting.delete(a.character);
      if (!from || !dst) continue;
      const on = vehicleUnder(a, from, dst, s, e);
      const c = (on && shift(on, s, e)) || [0, 0, 0];
      const d = Math.hypot(dst[0] - from[0] - c[0], dst[1] - from[1] - c[1]);
      const rel = on ? ` relative to ${on}` : '';
      // Constant friction down to zero: starts at twice the average speed.
      const v0 = 2 * d / secs, dec = v0 / secs;
      motion.push(`${a.character} tumble ${_r(s / 1000, 2)}-${_r(e / 1000, 2)} s: ${_r(d)} m${rel}, from ${_r(v0)} m/s to a stop (${_r(dec)} m/s²)`);
      if (dec > TUMBLE_DECEL_MAX) out.push(`${tag}: stops ${_r(v0)} m/s in ${_r(secs, 2)} s (${_r(dec)} m/s²), harder than friction can (rough surface ~5, at most ~${TUMBLE_DECEL_MAX}). Give it more distance and time, or show what stops it.`);
      else if (d > 0.5 && dec < TUMBLE_DECEL_MIN) out.push(`${tag}: slows at only ${_r(dec)} m/s², as on ice; on an ordinary surface ~5 m/s². Shorten the duration.`);
      if (impact && s - impact.e <= 400) {
        const expected = impact.v * impact.v / (2 * 5);
        if (v0 < impact.v * 0.5) out.push(`${tag}: starts at ${_r(v0)} m/s but the impact gave ${_r(impact.v)} m/s${impact.rel}: at ~5 m/s² that is ~${_r(expected, 0)} m over ~${_r(impact.v / 5)} s. Give the tumble that distance and time, or stage what stops it (a hand gripping, an obstacle).`);
        pendingImpact.delete(a.character);
      }
      continue;
    }

    const next = a.character && _poseOf(type, a);
    if (next) {
      const prev = pose.get(a.character) || 'standing';
      pose.set(a.character, next);
      const base = next.startsWith('ly') ? 'lying' : next.startsWith('kneel') ? 'kneeling' : next;
      const min = prev.startsWith('ly') && base === 'standing' ? POSE_FROM_LYING_TO_STANDING : POSE_MIN[base] ?? 600;
      const onCut = cuts.some((c) => Math.abs(c - e) <= 120);
      motion.push(`${a.character} ${prev} → ${next} at ${_r(e / 1000, 2)} s (${onCut ? 'on a cut' : `over ${_r(secs, 2)} s on screen`})`);
      if (prev !== next && !onCut && e - s < min) {
        out.push(`${tag}: ${a.character} goes from ${prev} to ${next} in ${_r(secs, 2)} s on screen; a body needs ~${_r(min / 1000)} s for that${base === 'lying' ? ' even falling (lying down on purpose: ~1 s)' : ''}. Give the action that long (startMs earlier), or put the switch on a cut.`);
      }
      continue;
    }

    if (['walk', 'run', 'move', 'jump'].includes(type) && a.character) {
      const from = where.get(a.character);
      let dst = null;
      if (Array.isArray(a.to)) dst = _xyz(a.to, from ? from[2] : 0);
      else if (typeof a.to === 'string' && where.has(a.to)) dst = where.get(a.to);
      if (dst) where.set(a.character, dst);
      if (!from || !dst || riding.has(a.character)) continue;
      const on = vehicleUnder(a, from, dst, s, e);
      const c = (on && shift(on, s, e)) || [0, 0, 0];
      const own = [dst[0] - from[0] - c[0], dst[1] - from[1] - c[1]];
      const d = Math.hypot(own[0], own[1]);
      const dz = dst[2] - from[2] - c[2];
      const rel = on ? ` relative to ${on}` : '';
      const held = pose.get(a.character) || 'standing';
      if (type !== 'jump' && held !== 'standing') {
        const v = d / secs;
        const prev = coasting.get(a.character);
        if (prev && Math.abs(prev.e - s) <= 30) {
          const cos = v > 0.3 && prev.v > 0.3 ? (own[0] * prev.own[0] + own[1] * prev.own[1]) / (d * prev.d) : 1;
          const turn = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
          const spin = Number.isFinite(a.face) && Number.isFinite(prev.face)
            ? Math.abs(((a.face - prev.face + 540) % 360) - 180) : 0;
          const gain = v > 0.3 && prev.v > 0.3 && v > prev.v * COAST_GAIN;
          if (turn > COAST_TURN || spin > COAST_SPIN || gain) {
            const last = coastBreaks[coastBreaks.length - 1];
            if (last && last.who === a.character && s - last.e <= 500) {
              last.e = e; last.n += 1; last.turn = Math.max(last.turn, turn); last.spin = Math.max(last.spin, spin); last.gain ||= gain;
            } else {
              coastBreaks.push({ who: a.character, held, s, e, n: 1, turn, spin, gain, rel, tag });
            }
          }
        }
        coasting.set(a.character, { e, v, d, own, face: a.face });
      } else if (a.character) {
        coasting.delete(a.character);
      }
      if (type !== 'jump' && held !== 'standing' && d / secs > 0.3) {
        // One line per stretch, not per chunk of it.
        const g = heldMove.get(a.character);
        if (g && Math.abs(g.e - s) <= 30) { g.e = e; g.d += d; } else {
          const n = { who: a.character, held, s, e, d, rel, tag };
          heldMove.set(a.character, n);
          heldMoves.push(n);
        }
      }
      if (type !== 'jump') {
        const last = motion[motion.length - 1];
        if (last && typeof last === 'object' && last.who === a.character && last.type === type && Math.abs(last.e - s) <= 30 && last.on === on) {
          last.e = e; last.d += d;
        } else {
          motion.push({ who: a.character, type, s, e, d, on });
        }
      } else {
        motion.push(`${a.character} jump ${_r(s / 1000, 2)}-${_r(e / 1000, 2)} s: ${_r(d)} m${rel}, ${dz >= 0 ? 'up' : 'down'} ${_r(Math.abs(dz))} m`);
      }

      if (type === 'jump') {
        const fa = Math.min(300, (e - s) / 5), fl = Math.min(400, (e - s) / 4);
        const air = Math.max(0.05, (e - s - fa - fl) / 1000);
        let rise = 0;
        for (let u = 0; u <= 1.0001; u += 0.02) rise = Math.max(rise, dz * u + 0.5 * G * air * air * u * (1 - u));
        const vh = d / air;
        if (rise > JUMP_RISE_MAX) out.push(`${tag}: the body rises ${_r(rise)} m above the take-off (a person: 0.5-0.9 m, never above ${JUMP_RISE_MAX}). The arc comes from the duration: shorten it (air time ~0.5-0.7 s → duration ~1.1-1.3 s).`);
        else if (rise > JUMP_RISE_HARD) out.push(`${tag}: rises ${_r(rise)} m, an elite athlete's jump; an ordinary person gets 0.5-0.9 m (shorten the duration).`);
        if (d > JUMP_LONG_MAX) out.push(`${tag}: ${_r(d)} m${rel} in one jump, beyond the world record (8.9 m). Bring the take-off and the landing closer (a running jump: 2-4 m).`);
        else if (d > JUMP_LONG_HARD) out.push(`${tag}: ${_r(d)} m${rel} in one jump, only an athlete with a long run-up; a running jump is 2-4 m.`);
        if (vh > RUN_MAX) out.push(`${tag}: flies at ${_r(vh)} m/s${rel}, faster than any sprinter (10 m/s).`);
        if (-dz > DROP_DEADLY) out.push(`${tag}: lands ${_r(-dz)} m lower, a deadly fall.`);
        else if (-dz > DROP_HURTS) out.push(`${tag}: lands ${_r(-dz)} m lower: a person gets hurt from that height (keep drops under ~${DROP_HURTS} m unless the script wants the injury).`);
        // What the landing surface does to the body: its speed against the
        // surface, a moving vehicle's included.
        let hit = a.aboard && veh.at.has(a.aboard) ? a.aboard : null;
        if (!hit && dst[2] > 0.5) {
          for (const pid of veh.at.keys()) {
            const p = veh.pos(pid, e), m = shift(pid, e - 200, e);
            const vd = m && Math.hypot(m[0], m[1]);
            if (!vd) continue;
            const off = [dst[0] - p[0], dst[1] - p[1]];
            if (Math.abs(off[0] * m[1] - off[1] * m[0]) / vd <= 2.5 && p[2] <= dst[2]) { hit = pid; break; }
          }
        }
        const m = hit && shift(hit, e - 200, e);
        const vs = m ? [m[0] / 0.2, m[1] / 0.2] : [0, 0];
        const vRel = Math.hypot((dst[0] - from[0]) / air - vs[0], (dst[1] - from[1]) / air - vs[1]);
        if (Math.max(vRel, Math.sqrt(2 * G * Math.max(0, -dz))) >= IMPACT_HARD) {
          pendingImpact.set(a.character, { who: a.character, e, v: Math.max(vRel, 3), rel: hit ? ` against ${hit}` : '', tag });
        }
        continue;
      }
      const v = d / secs;
      if (type === 'walk' && v > WALK_MAX) {
        out.push(`${tag}: walks at ${_r(v)} m/s${rel} (a walk is 1.2-1.8 m/s). Give it more time, a shorter path, or make it a run.`);
      } else if (v > RUN_MAX) {
        out.push(`${tag}: ${_r(v)} m/s${rel}, faster than a world-class sprinter (10 m/s). Give it more time or a shorter path${on ? '' : ' (on a moving vehicle, add aboard:<propId> so its speed is not counted as the runner\'s)'}.`);
      } else if (v > RUN_HARD) {
        out.push(`${tag}: ${_r(v)} m/s${rel}, an all-out sprint; a tired or ordinary person runs 3-6 m/s${on ? '' : ' (on a moving vehicle, add aboard:<propId>)'}.`);
      }
      continue;
    }

    if (type === 'kick' && a.prop && Array.isArray(a.to)) {
      const p = ((scene.set && scene.set.props) || []).find((x) => x.id === a.prop);
      if (!p) continue;
      const d = Math.hypot(..._xyz(a.to).map((v, k) => v - _xyz(p.position)[k]));
      const v = d / Math.max(0.05, secs / 2);
      if (v > KICK_MAX) out.push(`${tag}: the ${a.prop} flies at ${_r(v)} m/s (a hard kick: ~30 m/s).`);
    }
  }

  for (const h of heldMoves) {
    out.push(`${h.tag}: ${h.who} is ${h.held} yet travels ${_r(h.d)} m of their own${h.rel} over ${_r((h.e - h.s) / 1000, 2)} s (until ${_r(h.e / 1000, 2)} s). A body that is not on its feet only does that sliding or rolling off momentum (slowing down) or crawling: the script must say exactly that, or switch the pose first, or keep them still.`);
  }
  for (const b of coastBreaks) {
    const what = [
      b.turn > COAST_TURN ? `its path turns up to ${_r(b.turn, 0)}°${b.rel}` : '',
      b.spin > COAST_SPIN ? `its heading jumps up to ${_r(b.spin, 0)}°` : '',
      b.gain ? `it speeds up${b.rel}` : '',
    ].filter(Boolean).join(', ');
    out.push(`${b.tag}: ${b.who} is ${b.held} and coasting, yet ${what}, ${b.n} time${b.n > 1 ? 's' : ''} between ${_r(b.s / 1000, 2)} and ${_r(b.e / 1000, 2)} s. A sliding, rolling or falling body keeps its direction and only slows down until something acts on it: make the path one straight, steadily slowing line and the heading one slow turn, and let it change only at an event the script states and shows (a blow, an obstacle, a hand gripping). Never weave a body to fake "swinging" or "tumbling".`);
  }
  impacts.push(...pendingImpact.values());
  for (const h of impacts) {
    out.push(`${h.tag}: ${h.who} lands at ${_r(h.v)} m/s${h.rel}, yet no tumble follows: a body that hits that hard does not just land. Follow it within 0.4 s with { type:"tumble", to, startMs, endMs } (at ~5 m/s² that is ~${_r(h.v * h.v / 10, 0)} m over ~${_r(h.v / 5)} s), or stage what stops it, and say so in the script.`);
  }
  const motionLines = motion.map((m) => {
    if (typeof m === 'string') return m;
    const secs = (m.e - m.s) / 1000;
    const v = m.d / Math.max(0.001, secs);
    const steps = secs * (v > WALK_MAX ? RUN_CADENCE : WALK_CADENCE);
    const n = steps < 0.75 ? 'under one step' : `~${Math.max(1, Math.round(steps))} step${Math.round(steps) > 1 ? 's' : ''}`;
    if (m.d < 0.15) return `${m.who} ${m.type} ${_r(m.s / 1000, 2)}-${_r(m.e / 1000, 2)} s: no motion of their own${m.on ? ` (carried by ${m.on})` : ''}`;
    return `${m.who} ${m.type} ${_r(m.s / 1000, 2)}-${_r(m.e / 1000, 2)} s: ${_r(m.d)} m${m.on ? ` relative to ${m.on}` : ''} = ${_r(v)} m/s, ${n} at a natural pace (${v > WALK_MAX ? 'a run ~3 steps/s' : 'a walk ~2 steps/s, ~0.5 s each'})`;
  });

  // Vehicles and things that fall.
  for (const [pid, t] of veh.at) {
    const kind = String(t.prop.shape || t.prop.kind || '').toLowerCase();
    const max = VEHICLE_MAX[kind] ?? (kind.includes('train') ? VEHICLE_MAX.train : null);
    const accelMax = VEHICLE_ACCEL[kind] ?? (kind.includes('train') ? VEHICLE_ACCEL.train : VEHICLE_ACCEL_DEFAULT);
    let before = null;
    for (let j = 1; j < t.pts.length; j++) {
      const [t0, a] = t.pts[j - 1], [t1, b] = t.pts[j];
      if (t1 - t0 < 1) continue;
      const secs = (t1 - t0) / 1000;
      const d = _h(a, b), dz = b[2] - a[2];
      const tag = `${pid} (${_r(t0 / 1000)}-${_r(t1 / 1000)}s)`;
      if (before) {
        // Each leg holds one speed, so the change happens at the join: at
        // best it reads as spread over about a second.
        const dv = Math.abs(d / secs - before.v), acc = dv / Math.min(1, (secs + before.secs) / 2);
        if (acc > accelMax) out.push(`${tag}: ${kind || 'it'} changes speed from ${_r(before.v)} to ${_r(d / secs)} m/s at once (${_r(acc)} m/s², its real limit ~${accelMax}). Keep one speed, or spread the change over ~${_r(dv / accelMax)} s of legs. Slow motion slows everything in the shot, never the vehicle alone.`);
      }
      before = { v: d / secs, secs };
      if (max && d / secs > max) {
        out.push(`${tag}: a ${kind} at ${_r(d / secs)} m/s (${_r(d / secs * 3.6, 0)} km/h); its real top is ~${max} m/s.`);
      }
      // A fall: mostly down, not a vehicle on a slope.
      if (!max && dz < -1 && d < -dz * 1.5) {
        const free = Math.sqrt((2 * -dz) / G);
        if (secs < free * 0.75) out.push(`${tag}: drops ${_r(-dz)} m in ${_r(secs, 2)} s, faster than gravity (free fall takes ${_r(free, 2)} s).`);
        else if (secs > free * 2 + 0.5) out.push(`${tag}: drops ${_r(-dz)} m in ${_r(secs, 2)} s, floating; a free fall takes ${_r(free, 2)} s (only a light or braked thing falls that slowly).`);
      }
    }
  }
  return { warnings: out, motion: motionLines };
}

/** The tool-result field: nothing when every motion is humanly real. */
export function physicsReport(scene) {
  const { warnings, motion } = _analyse(scene);
  if (!warnings.length && !motion.length) return {};
  return {
    physics: {
      ...(warnings.length ? { warnings } : {}),
      motion,
      rule: 'People, animals, vehicles and objects must move as they really can (gravity, human speed and strength, inertia: ' +
        'with no footing a body keeps its direction and only slows down until a stated event acts on it; a hard impact gets a reaction). ' +
        'Fix every warning with update_scene3d before delivering, unless the script explicitly asks for that exact ' +
        'superhuman feat; then say so to the user. Then reconcile `motion` (each movement\'s distance, time, speed, ' +
        'natural step count; each pose change and how long it takes) with what the story script SAYS for those ' +
        'moments: counted steps or strides, "slowly", "in one leap", how long getting up or sitting down takes. They ' +
        'must match exactly. Fix it yourself: re-time the 3D (update_scene3d) when the script is right, or rewrite ' +
        'the script wording with the cinematic-video-prompt-engineer skill when the 3D timing is right. Ask the user ' +
        'only when the fix would change something they decided (a shot length, a cut, an action they asked for).',
    },
  };
}
