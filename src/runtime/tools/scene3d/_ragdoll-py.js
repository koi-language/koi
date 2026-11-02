/**
 * Blender-side impact solver for the 3D previz: the block figure as nine rigid
 * pieces (the joints the rig really has), thrown on a surface and simulated by
 * Bullet. With a destination it repeats, adjusting the arrival within what the
 * action declares, until the body comes to rest there. The chosen run's frames
 * are stored: a simulation is chaotic and never replayed.
 *
 * NOTE: plain Python inside String.raw — never use backticks or ${ in it.
 */
export const RAGDOLL_PY = String.raw`
import base64
import json
import math
import random
import struct
import sys
import time

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

_argv = sys.argv[sys.argv.index("--") + 1:]
IN = json.load(open(_argv[0], encoding="utf-8"))
OUT_PATH = _argv[1]

SIM_FPS = 96
RELEASE = 5
MAX_S = 8.0
G = 9.81
SLOW = max(1.0, float(IN.get("slowMotion") or 1))
STEP = 1 if SLOW >= 2 else 2
K = float(IN.get("height") or 1.75) / 1.75
MASS = 80.0 * K ** 3

# name: parent, pivot, centre, size, mass %. Same pivots as the block figure.
PARTS = {
    "trunk": (None, (0, 0, 0.95), (0, 0, 1.345), (0.36, 0.2, 0.79), 54),
    "upperarmL": ("trunk", (-0.225, 0, 1.45), (-0.225, 0, 1.28), (0.09, 0.1, 0.34), 4),
    "forearmL": ("upperarmL", (-0.225, 0, 1.11), (-0.225, 0, 0.94), (0.08, 0.09, 0.34), 3),
    "upperarmR": ("trunk", (0.225, 0, 1.45), (0.225, 0, 1.28), (0.09, 0.1, 0.34), 4),
    "forearmR": ("upperarmR", (0.225, 0, 1.11), (0.225, 0, 0.94), (0.08, 0.09, 0.34), 3),
    "thighL": ("trunk", (-0.09, 0, 0.95), (-0.09, 0, 0.725), (0.15, 0.18, 0.45), 10),
    "shinL": ("thighL", (-0.09, 0, 0.5), (-0.09, 0, 0.25), (0.15, 0.18, 0.5), 6),
    "thighR": ("trunk", (0.09, 0, 0.95), (0.09, 0, 0.725), (0.15, 0.18, 0.45), 10),
    "shinR": ("thighR", (0.09, 0, 0.5), (0.09, 0, 0.25), (0.15, 0.18, 0.5), 6),
}
ORDER = list(PARTS)
V = lambda t: Vector(t) * K

scn = bpy.context.scene
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)
scn.render.fps = SIM_FPS
scn.frame_start = 1
scn.frame_end = RELEASE + int(MAX_S * SIM_FPS) + 2


def box(name, size):
    x, y, z = (v / 2 for v in size)
    verts = [(a * x, b * y, c * z) for a in (-1, 1) for b in (-1, 1) for c in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    ob = bpy.data.objects.new(name, me)
    scn.collection.objects.link(ob)
    return ob


ground = box("ground", (2000, 2000, 2))
ground.location = (0, 0, -1)
bpy.ops.rigidbody.world_add()
rbw = scn.rigidbody_world
rbw.collection = bpy.data.collections.new("RB")
rbw.constraints = bpy.data.collections.new("RBC")
rbw.substeps_per_frame = 10
rbw.solver_iterations = 60
rbw.point_cache.frame_start = 1
rbw.point_cache.frame_end = scn.frame_end


def rigid(ob, kind):
    rbw.collection.objects.link(ob)
    bpy.context.view_layer.update()
    ob.rigid_body.type = kind
    ob.rigid_body.collision_shape = "BOX"


rigid(ground, "PASSIVE")
ground.rigid_body.restitution = 0.05

BODY = {}
for name, (_, _, _, size, pct) in PARTS.items():
    ob = box(name, [v * K for v in size])
    rigid(ob, "ACTIVE")
    r = ob.rigid_body
    r.mass = MASS * pct / 100
    r.friction = 1.0
    r.restitution = 0.05
    r.use_margin = True
    r.collision_margin = 0.01
    r.linear_damping = 0.02
    r.angular_damping = 0.3
    r.use_deactivation = False
    ob.rotation_mode = "QUATERNION"
    BODY[name] = ob


def limits(name):
    left = name.endswith("L")
    if name.startswith("shin"):
        return ((-140, 0), (0, 0), (0, 0))
    if name.startswith("forearm"):
        return ((0, 145), (0, 0), (0, 0))
    if name.startswith("thigh"):
        return ((-25, 120), (-40, 15) if left else (-15, 40), (-30, 30))
    # The middle axis of a generic joint is only valid within +-90 degrees.
    return ((-60, 170), (-85, 20) if left else (-20, 85), (-40, 40))


JOINT = {}
for name, (par, piv, _, _, _) in PARTS.items():
    if not par:
        continue
    e = bpy.data.objects.new("j_" + name, None)
    scn.collection.objects.link(e)
    e.rotation_mode = "QUATERNION"
    rbw.constraints.objects.link(e)
    bpy.context.view_layer.update()
    c = e.rigid_body_constraint
    c.type = "GENERIC"
    c.object1 = BODY[par]
    c.object2 = BODY[name]
    c.disable_collisions = True
    for ax in "xyz":
        setattr(c, "use_limit_lin_" + ax, True)
        setattr(c, "limit_lin_%s_lower" % ax, 0)
        setattr(c, "limit_lin_%s_upper" % ax, 0)
    # limits() are angles of the child in its parent's frame; Bullet measures the
    # constraint the other way round, so they go in mirrored. Unmirrored, knees
    # and elbows bend backwards.
    for ax, (lo, hi) in zip("xyz", limits(name)):
        setattr(c, "use_limit_ang_" + ax, True)
        setattr(c, "limit_ang_%s_lower" % ax, math.radians(-hi))
        setattr(c, "limit_ang_%s_upper" % ax, math.radians(-lo))
    JOINT[name] = e

_mass = sum(p[4] for p in PARTS.values())
COM = sum((V(p[2]) * p[4] for p in PARTS.values()), Vector()) / _mass


def lowest(q):
    low = 1e9
    for _, _, c, size, _ in PARTS.values():
        for a in (-1, 1):
            for b in (-1, 1):
                for d in (-1, 1):
                    corner = V(c) + Vector((a * size[0], b * size[1], d * size[2])) * K / 2 - COM
                    low = min(low, (q @ corner).z)
    return low


def basis(x, y, z):
    return Matrix((x, y, z)).transposed().to_quaternion()


def contact_quat(contact, travel, facing):
    """How the body arrives. Body axes: +Y front, +Z head, -X its left."""
    up = Vector((0, 0, 1))
    d = Vector((travel.x, travel.y, 0)).normalized()
    side = up.cross(d).normalized()
    if contact == "feet":
        if isinstance(facing, (int, float)):
            a = math.radians(float(facing))
            y = Vector((math.cos(a), math.sin(a), 0))
        else:
            y = -d if facing == "away" else d
        tilt = -math.radians(6)
        return Quaternion(y.cross(up).normalized(), tilt) @ basis(y.cross(up).normalized(), y, up)
    if contact in ("left_side", "right_side"):
        s = 1 if contact == "left_side" else -1
        z = side.copy()
        x = up * s
        tilt = Quaternion(d, math.radians(-12 * s))
        return tilt @ basis(x, z.cross(x), z)
    if contact == "back":
        y, z = up, -d
    elif contact == "front":
        y, z = -up, d
    elif contact == "head":
        z = (d - up).normalized()
        y = (-d - up).normalized()
    else:
        raise ValueError("unknown contact: " + str(contact))
    return basis(y.cross(z).normalized(), y, z)


def prepare(q0, vel, spin, friction):
    w = Vector(spin)
    v = Vector(vel)
    release = Vector((0, 0, 0.02 - lowest(q0)))
    dt = 1.0 / SIM_FPS
    ground.rigid_body.friction = friction
    for name, ob in BODY.items():
        ob.animation_data_clear()
        c = V(PARTS[name][2]) - COM
        for fr in range(1, RELEASE + 1):
            t = (fr - RELEASE) * dt
            q = (Quaternion(w.normalized(), w.length * t) if w.length > 1e-6 else Quaternion()) @ q0
            ob.location = release + v * t + q @ c
            ob.rotation_quaternion = q
            ob.keyframe_insert("location", frame=fr)
            ob.keyframe_insert("rotation_quaternion", frame=fr)
            ob.rigid_body.kinematic = True
            ob.keyframe_insert("rigid_body.kinematic", frame=fr)
        ob.rigid_body.kinematic = False
        ob.keyframe_insert("rigid_body.kinematic", frame=RELEASE + 1)
        for fc in ob.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "CONSTANT" if fc.data_path == "rigid_body.kinematic" else "LINEAR"
    # A joint's frame is read when the world is rebuilt, at the first frame.
    t = (1 - RELEASE) * dt
    q = (Quaternion(w.normalized(), w.length * t) if w.length > 1e-6 else Quaternion()) @ q0
    for name, e in JOINT.items():
        e.location = release + v * t + q @ (V(PARTS[name][1]) - COM)
        e.rotation_quaternion = q
    scn.frame_set(1)
    bpy.context.view_layer.update()
    rbw.enabled = False
    rbw.enabled = True
    scn.frame_set(1)


PIVOT_LOCAL = V(PARTS["trunk"][1]) - V(PARTS["trunk"][2])


def run(q0, vel, spin, friction):
    prepare(q0, vel, spin, friction)
    frames = []
    prev = None
    still = 0
    stop = None
    rev_long = rev_cross = peak = 0.0
    gap = 0.0
    origin = None
    last = RELEASE + int(MAX_S * SIM_FPS)
    for fr in range(1, last + 1):
        scn.frame_set(fr)
        if fr < RELEASE:
            continue
        dg = bpy.context.evaluated_depsgraph_get()
        mats = {n: BODY[n].evaluated_get(dg).matrix_world.copy() for n in ORDER}
        m = mats["trunk"]
        p, q = m.translation.copy(), m.to_quaternion()
        pivot = m @ PIVOT_LOCAL
        if origin is None:
            origin = pivot.copy()
        if (fr - RELEASE) % STEP == 0:
            row = [pivot.x - origin.x, pivot.y - origin.y, pivot.z]
            for n in ORDER:
                row.extend(mats[n].to_quaternion())
            frames.append(row)
        for n, (par, piv, c, _, _) in PARTS.items():
            if par:
                a = mats[n] @ (V(piv) - V(c))
                b = mats[par] @ (V(piv) - V(PARTS[par][2]))
                gap = max(gap, (a - b).length)
        if prev is not None:
            ax, ang = (prev[1].inverted() @ q).to_axis_angle()
            if ang > math.pi:
                ang = 2 * math.pi - ang
            rate = ang * SIM_FPS / (2 * math.pi)
            peak = max(peak, rate)
            along = abs(ax.z)
            rev_long += ang * along / (2 * math.pi)
            rev_cross += ang * math.sqrt(max(0.0, 1 - along * along)) / (2 * math.pi)
            # Still only when every piece is: a trunk at rest with a leg falling is not.
            speed = max((mats[n].translation - prev[2][n]).length for n in ORDER) * SIM_FPS
            still = still + 1 if speed < 0.15 and rate < 0.12 else 0
            if still == 1:
                stop = fr
            elif still == 0:
                stop = None
            if still > SIM_FPS // 3:
                break
        prev = (p, q, {n: mats[n].translation.copy() for n in ORDER})
    stop = stop or fr
    keep = (stop - RELEASE) // STEP + 2
    y, z = q @ Vector((0, 1, 0)), q @ Vector((0, 0, 1))
    # Limbs have no muscle here: a leaning trunk sits on a locked arm, raised legs are jammed.
    legs_up = any(abs((mats[n].to_quaternion() @ Vector((0, 0, 1))).z) > 0.5 for n in ("thighL", "thighR"))
    if abs(z.z) > 0.35 or legs_up:
        rest = "propped"
    elif y.z > 0.5:
        rest = "lying"
    elif y.z < -0.5:
        rest = "lying_front"
    else:
        rest = "lying_side"
    return {
        "frames": frames[:keep],
        "stopS": (stop - RELEASE) / SIM_FPS,
        "end": (pivot - origin).to_2d(),
        "revLong": rev_long,
        "revCross": rev_cross,
        "peakRevS": peak,
        "rest": rest,
        "jointGap": gap,
    }


def track(ms):
    pts = IN.get("track") or []
    if not pts:
        return Vector((0, 0))
    if ms <= pts[0][0]:
        return Vector(pts[0][1:3])
    for a, b in zip(pts, pts[1:]):
        if ms <= b[0]:
            u = (ms - a[0]) / max(1.0, b[0] - a[0])
            return Vector(a[1:3]).lerp(Vector(b[1:3]), u)
    return Vector(pts[-1][1:3])


START = float(IN.get("startMs") or 0)
FROM = Vector(IN["from"][:2])
OFFSET = Vector(IN["offset"][:2]) if IN.get("offset") else None
TO = Vector(IN["to"][:2]) if IN.get("to") else None
WANT_REST = IN.get("restPose")
TOL = float(IN.get("tolerance") or 0.3)
MAX_RUNS = int(IN.get("maxRuns") or 200)
MU = float(IN.get("friction") or 0.65)
FALL = float(IN.get("fallSpeed") if IN.get("fallSpeed") is not None else 2.5)
CONTACT = IN.get("contact") or "feet"
FACING = IN.get("facing") or "travel"


def wanted(stop_s):
    """Displacement on the surface to the destination: the vehicle's own travel
    during the stop is not the body's."""
    if OFFSET is not None:
        return OFFSET
    end_ms = START + stop_s * SLOW * 1000.0
    return TO - FROM - (track(end_ms) - track(START))


HAS_GOAL = TO is not None or OFFSET is not None
if IN.get("heading") is not None:
    H0 = math.radians(float(IN["heading"]))
elif HAS_GOAL:
    guess = wanted(2.0)
    H0 = math.atan2(guess.y, guess.x)
else:
    H0 = 0.0
if IN.get("speed") is not None:
    SPEED = float(IN["speed"])
elif HAS_GOAL:
    SPEED = math.sqrt(2 * MU * G * max(0.5, wanted(2.0).length)) / 0.85
else:
    raise ValueError("an impact needs speed or to")

#          heading  speed  orientation x,y,z   spin x,y,z   friction
MAX_DEV = [15.0, 0.12, 20.0, 20.0, 20.0, 4.0, 4.0, 4.0, 0.2]
STD0 = [7.0, 0.06, 10.0, 10.0, 10.0, 1.5, 1.5, 1.5, 0.1]


def evaluate(x):
    h = H0 + math.radians(x[0])
    d = Vector((math.cos(h), math.sin(h), 0))
    jitter = Euler([math.radians(a) for a in x[2:5]], "XYZ").to_quaternion()
    q0 = jitter @ contact_quat(CONTACT, d, FACING)
    speed = SPEED * (1 + x[1])
    vel = d * speed + Vector((0, 0, -FALL))
    r = run(q0, vel, x[5:8], MU * (1 + x[8]))
    r["speed"], r["heading"], r["friction"] = speed, math.degrees(h), MU * (1 + x[8])
    r["miss"] = (r["end"] - wanted(r["stopS"])).length if HAS_GOAL else 0.0
    bad_rest = r["rest"] == "propped" or (bool(WANT_REST) and r["rest"] != WANT_REST)
    r["badRest"] = bad_rest
    r["score"] = r["miss"] + (0.6 if bad_rest else 0.0) + 0.4 * max(0.0, r["peakRevS"] - 3.0)
    return r


def done(r):
    return r["miss"] <= TOL and not r["badRest"] and r["peakRevS"] <= 4.0


random.seed(json.dumps(IN, sort_keys=True))
t0 = time.time()
mean = [0.0] * len(MAX_DEV)
std = list(STD0)
best = evaluate(mean)
best["x"] = mean
runs = 1
elite = []
while runs < MAX_RUNS and not done(best):
    batch = []
    for _ in range(24):
        if runs >= MAX_RUNS:
            break
        x = [max(-m, min(m, random.gauss(a, s))) for a, s, m in zip(mean, std, MAX_DEV)]
        r = evaluate(x)
        r["x"] = x
        runs += 1
        batch.append(r)
        if r["score"] < best["score"]:
            best = r
        if done(best):
            break
    elite = sorted(elite + [{"score": r["score"], "x": r["x"]} for r in batch], key=lambda e: e["score"])[:6]
    mean = [sum(e["x"][i] for e in elite) / len(elite) for i in range(len(mean))]
    std = [max(0.15 * s0, 0.5 * s + 0.5 * math.sqrt(sum((e["x"][i] - mean[i]) ** 2 for e in elite) / len(elite)))
           for i, s, s0 in zip(range(len(mean)), std, STD0)]

W = 3 + 4 * len(ORDER)
flat = [v for row in best["frames"] for v in row]
report = {
    "runs": runs,
    "wallS": round(time.time() - t0, 2),
    "reached": (best["miss"] <= TOL) if HAS_GOAL else None,
    "missM": round(best["miss"], 2),
    "stopS": round(best["stopS"], 2),
    "speed": round(best["speed"], 2),
    "heading": round(best["heading"], 1),
    "friction": round(best["friction"], 2),
    "travelM": round(best["end"].length, 2),
    "end": [round(best["end"].x, 3), round(best["end"].y, 3)],
    "revLongAxis": round(best["revLong"], 2),
    "revHeadOverHeels": round(best["revCross"], 2),
    "peakRevS": round(best["peakRevS"], 2),
    "rest": best["rest"],
    "restMatches": not best["badRest"],
    "jointGapM": round(best["jointGap"], 3),
    "contact": CONTACT,
}
with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump({
        "fps": SIM_FPS / STEP,
        "n": len(best["frames"]),
        "width": W,
        "parts": ORDER,
        "data": base64.b64encode(struct.pack("<%df" % len(flat), *flat)).decode("ascii"),
        "report": report,
    }, f)
print("[ragdoll] " + json.dumps(report), flush=True)
`;
