/**
 * Impacts of the 3D previz: a body that loses its footing is simulated, never
 * animated by hand. resolveImpacts() solves each { type:"impact" } action and
 * stores the chosen run on it (`sim`), so the builder only plays it back.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runBuilder, ragdollScriptPath } from './_blender.js';

const _isImpact = (a) => String(a?.type || '').toLowerCase() === 'impact' && a.character;

/** Where a driven prop is over time: [[ms, x, y], …] in world metres. */
function _track(scene, pid) {
  if (!pid) return [];
  const prop = ((scene.set && scene.set.props) || []).find((p) => p?.id === pid);
  if (!prop) return [];
  const legs = (scene.actions || [])
    .filter((a) => String(a.type || '').toLowerCase() === 'drive' && a.prop === pid && Array.isArray(a.to))
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  let at = [prop.position?.[0] || 0, prop.position?.[1] || 0];
  const pts = [[legs[0]?.startMs || 0, ...at]];
  for (const leg of legs) {
    if ((leg.startMs || 0) > pts[pts.length - 1][0]) pts.push([leg.startMs, ...at]);
    at = [leg.to[0], leg.to[1]];
    pts.push([leg.endMs ?? (leg.startMs || 0) + 1000, ...at]);
  }
  return pts;
}

function _trackAt(pts) {
  return (ms) => {
    if (!pts.length) return [0, 0];
    if (ms <= pts[0][0]) return pts[0].slice(1, 3);
    for (let i = 1; i < pts.length; i++) {
      if (ms <= pts[i][0]) {
        const u = (ms - pts[i - 1][0]) / Math.max(1, pts[i][0] - pts[i - 1][0]);
        return [0, 1].map((k) => pts[i - 1][k + 1] + (pts[i][k + 1] - pts[i - 1][k + 1]) * u);
      }
    }
    return pts[pts.length - 1].slice(1, 3);
  };
}

/** Where a character stands when `upTo` starts. */
function _whereBefore(scene, upTo) {
  const c = (scene.characters || []).find((x) => x.id === upTo.character);
  let here = [c?.position?.[0] || 0, c?.position?.[1] || 0, c?.position?.[2] || 0];
  const earlier = (scene.actions || [])
    .filter((a) => a.character === upTo.character && a !== upTo && (a.startMs || 0) < (upTo.startMs || 0))
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  for (const a of earlier) {
    if (a.simReport?.restsAt) { here = a.simReport.restsAt; continue; }
    if (!Array.isArray(a.to)) continue;
    here = [a.to[0], a.to[1], a.to.length > 2 ? a.to[2] : here[2]];
  }
  return here;
}

function _input(scene, a) {
  const c = (scene.characters || []).find((x) => x.id === a.character);
  return {
    height: c?.height,
    startMs: a.startMs || 0,
    from: Array.isArray(a.from) ? a.from : _whereBefore(scene, a),
    to: Array.isArray(a.to) ? a.to : null,
    offset: Array.isArray(a.offset) ? a.offset : null,
    track: _track(scene, a.aboard),
    speed: a.speed,
    heading: a.heading,
    fallSpeed: a.fallSpeed,
    contact: a.contact,
    facing: a.facing,
    friction: a.friction,
    tolerance: a.tolerance,
    restPose: a.restPose,
    slowMotion: a.slowMotion,
    maxRuns: a.maxRuns,
    surfaceZ: a.surfaceZ,
  };
}

// Bump when the solver changes what it computes: stored runs are then re-solved.
const SOLVER_VERSION = 2;
const _hash = (input) => crypto.createHash('sha1').update(JSON.stringify({ SOLVER_VERSION, input })).digest('hex').slice(0, 16);

/**
 * Solve every impact whose inputs changed. A chosen run is kept while its
 * inputs stand, also when a caller re-sends the action without it.
 */
export async function resolveImpacts(scene, existing = null) {
  const known = new Map();
  for (const a of [...(existing?.actions || []), ...(scene.actions || [])]) {
    if (_isImpact(a) && a.sim && a.simHash) known.set(a.simHash, a);
  }
  const impacts = (scene.actions || []).filter(_isImpact).sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  for (const a of impacts) {
    if (a.surfaceZ == null && Array.isArray(a.to) && a.to.length > 2) a.surfaceZ = a.to[2];
    const input = _input(scene, a);
    const hash = _hash(input);
    const kept = known.get(hash);
    if (kept) {
      a.sim = kept.sim;
      a.simHash = hash;
      a.simReport = kept.simReport;
      a.endMs = kept.endMs;
      continue;
    }
    delete a.sim;
    a.simHash = hash;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-impact-'));
    try {
      const inFile = path.join(dir, 'in.json');
      const outFile = path.join(dir, 'out.json');
      fs.writeFileSync(inFile, JSON.stringify(input));
      await runBuilder([inFile, outFile], { script: ragdollScriptPath(), timeoutMs: 3 * 60 * 1000 });
      const { report, ...sim } = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      a.sim = sim;
      a.simReport = report;
      a.from = input.from;
      a.endMs = Math.round((a.startMs || 0) + report.stopS * Math.max(1, Number(a.slowMotion) || 1) * 1000);
      const at = _trackAt(input.track);
      const [s0, s1] = [at(a.startMs || 0), at(a.endMs)];
      report.restsAt = [input.from[0] + report.end[0] + s1[0] - s0[0], input.from[1] + report.end[1] + s1[1] - s0[1], a.surfaceZ ?? input.from[2] ?? 0]
        .map((v) => Math.round(v * 100) / 100);
    } catch (e) {
      a.simReport = { error: String(e.message || e).slice(0, 400) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return scene;
}

/** The scene as agents read it: a run's frames are data for the builder only. */
export function withoutSimFrames(scene) {
  if (!(scene?.actions || []).some((a) => a.sim)) return scene;
  return {
    ...scene,
    actions: scene.actions.map((a) => {
      if (!a.sim) return a;
      const { sim, ...rest } = a;
      return rest;
    }),
  };
}
