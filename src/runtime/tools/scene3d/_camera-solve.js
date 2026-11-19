/**
 * Camera solve (matchmoving) for a reference photo: from anchors, points of
 * the model whose place in the photo is known, find the camera the photo was
 * taken from (position, aim, roll, lens) instead of guessing it.
 *
 *   anchors: [{ label, px: [x, y] (0..1 of the photo, y DOWN), world: [x, y, z] }]
 *
 * Same camera as the modeler's review (Blender): looks from `position` at
 * `target`, up = +Z, rolled about its axis by `roll` degrees; the lens runs
 * along the photo's long side over a 36 mm sensor.
 *
 * Levenberg-Marquardt on 7 numbers (position, yaw, pitch, roll, lens),
 * started from the agent's estimate. The residual of each anchor afterwards
 * says what does not fit: spread over every anchor = the photo is not this
 * camera; on a few = those parts of the model are not where the photo has them.
 */

const DEG = Math.PI / 180;

function _sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function _norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return l < 1e-12 ? a : [a[0] / l, a[1] / l, a[2] / l]; }

/** Camera basis from yaw / pitch (of the view direction) and roll. */
function _basis(yaw, pitch, roll) {
  const f = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  let r = _cross(f, [0, 0, 1]);
  r = Math.hypot(...r) < 1e-9 ? [1, 0, 0] : _norm(r);
  let u = _cross(r, f);
  const c = Math.cos(roll), s = Math.sin(roll);
  const r2 = [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s];
  const u2 = [u[0] * c - r[0] * s, u[1] * c - r[1] * s, u[2] * c - r[2] * s];
  return { f, r: r2, u: u2 };
}

/** Where [p] falls in the photo (0..1, y down), or null behind the camera. */
function _project(x, p, aspect) {
  const [px, py, pz, yaw, pitch, roll, lens] = x;
  const { f, r, u } = _basis(yaw, pitch, roll);
  const d = _sub(p, [px, py, pz]);
  const zc = _dot(d, f);
  if (zc <= 1e-4) return null;
  // Focal length in units of the photo's long side.
  const k = lens / 36;
  const long = aspect >= 1 ? 'w' : 'h';
  const kx = long === 'w' ? k : k / aspect; // in widths
  const ky = long === 'w' ? k * aspect : k; // in heights
  return [0.5 + kx * _dot(d, r) / zc, 0.5 - ky * _dot(d, u) / zc];
}

function _residuals(x, anchors, aspect) {
  const out = [];
  for (const a of anchors) {
    const q = _project(x, a.world, aspect);
    if (!q) { out.push(1, 1); continue; }
    // In units of the photo's height on both axes (square pixels).
    out.push((q[0] - a.px[0]) * aspect, q[1] - a.px[1]);
  }
  return out;
}

function _solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const k = M[i][c] / M[c][c];
      for (let j = c; j <= n; j++) M[i][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * @param {object} o
 * @param {Array} o.anchors   [{ label, px:[x,y], world:[x,y,z] }], at least 6
 * @param {object} o.camera   the agent's estimate { position, target, lens, roll? } (the start)
 * @param {number} o.aspect   photo width / height
 * @param {boolean} [o.fixLens] keep the lens as given
 * @returns {{ camera, rmsPx, residuals, note } | { error }}
 */
export function solveCamera({ anchors, camera, aspect, fixLens = false, heightPx = 1000 }) {
  const pts = (anchors || []).filter((a) => Array.isArray(a?.px) && a.px.length >= 2 && Array.isArray(a?.world) && a.world.length >= 3
    && [...a.px.slice(0, 2), ...a.world.slice(0, 3)].every((v) => Number.isFinite(Number(v))))
    .map((a, i) => ({ label: String(a.label || `anchor ${i + 1}`), px: a.px.slice(0, 2).map(Number), world: a.world.slice(0, 3).map(Number) }));
  if (pts.length < 6) return { error: `camera solve needs at least 6 anchors (got ${pts.length}).` };
  const P = (camera?.position || [0, -5, 1.6]).map(Number);
  const T = (camera?.target || [0, 0, 1]).map(Number);
  const f0 = _norm(_sub(T, P));
  const dist = Math.max(0.5, Math.hypot(...(_sub(T, P))));
  let x = [P[0], P[1], P[2], Math.atan2(f0[1], f0[0]), Math.asin(Math.max(-1, Math.min(1, f0[2]))),
    (Number(camera?.roll) || 0) * DEG, Number(camera?.lens) || 35];
  const free = fixLens ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
  const cost = (v) => _residuals(v, pts, aspect).reduce((s, e) => s + e * e, 0);
  let c = cost(x);
  let lambda = 1e-3;
  for (let it = 0; it < 200; it++) {
    const r0 = _residuals(x, pts, aspect);
    const J = r0.map(() => new Array(free.length).fill(0));
    free.forEach((pi, j) => {
      const h = pi === 6 ? 1e-3 * Math.max(1, x[6]) : (pi < 3 ? 1e-4 * Math.max(1, dist) : 1e-5);
      const xp = x.slice(); xp[pi] += h;
      const rp = _residuals(xp, pts, aspect);
      for (let i = 0; i < r0.length; i++) J[i][j] = (rp[i] - r0[i]) / h;
    });
    const n = free.length;
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const Jtr = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * r0[i], 0));
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const step = _solveLinear(A, Jtr.map((v) => -v));
      if (!step) { lambda *= 10; continue; }
      const xn = x.slice();
      free.forEach((pi, j) => { xn[pi] += step[j]; });
      xn[6] = Math.max(4, Math.min(600, xn[6]));
      xn[4] = Math.max(-1.55, Math.min(1.55, xn[4]));
      const cn = cost(xn);
      if (cn < c) {
        const gain = c - cn;
        x = xn; c = cn; lambda = Math.max(1e-9, lambda / 3); improved = true;
        if (gain < 1e-12) it = 1e9;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const { f } = _basis(x[3], x[4], x[5]);
  const pos = [x[0], x[1], x[2]];
  const round = (v, k = 1000) => Math.round(v * k) / k;
  const res = _residuals(x, pts, aspect);
  const residuals = pts.map((a, i) => {
    const e = Math.hypot(res[2 * i], res[2 * i + 1]) * heightPx;
    return { label: a.label, errPx: Math.round(e), dx: Math.round(res[2 * i] * heightPx), dy: Math.round(res[2 * i + 1] * heightPx) };
  }).sort((a, b) => b.errPx - a.errPx);
  const rmsPx = Math.round(Math.sqrt(c / pts.length) * heightPx);
  const solved = {
    position: pos.map((v) => round(v)),
    target: [0, 1, 2].map((i) => round(pos[i] + f[i] * dist)),
    lens: round(x[6], 100),
    ...(Math.abs(x[5]) > 0.2 * DEG ? { roll: round(x[5] / DEG, 100) } : {}),
  };
  return { camera: solved, rmsPx, residuals };
}
