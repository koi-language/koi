/**
 * Blender-side previz builder, embedded as a string so the bundled engine
 * binary ships it without loose files. Written to ~/.koi/blender/scripts/
 * at run time (content-hashed) and executed with
 * `blender -b --factory-startup -P <file> -- …`.
 *
 * NOTE: plain Python inside String.raw — never use backticks or ${ in it.
 */
export const BUILD_SCENE_PY = String.raw`
"""
Braxil 3D previz — Blender side.

Builds a previz scene from a Braxil scene3d JSON and renders one camera
(shot) over the FULL scene duration to a video proxy, plus optional
structure passes (depth / mask) used later to drive video-to-video
generation.

Run (headless):
  blender -b --factory-startup -P build_scene.py -- \
      --scene /path/scene.json --shot <shotId> --out /path/out.mp4 \
      [--pass beauty|depth|mask] [--style clay|sketch|lit] \
      [--width 960 --height 540] [--still <ms> --out frame.png]

Coordinate system (metres): x → right, y → into the set (towards the back
wall), z → up. Floor at z = 0. Scene time is in milliseconds; a shot is a
camera + a window [startMs, startMs + durationMs] on the scene clock. The
proxy covers the whole scene so the timeline can trim / slip a shot without
re-rendering: outside its window the camera simply holds.
"""

import bpy
import bmesh
import json
import math
import sys
import argparse
from mathutils import Vector, Euler, Matrix

# ─────────────────────────────────────────────────────────────── args ──

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--scene", required=True)
ap.add_argument("--shot", default=None)
ap.add_argument("--out", default=None)
ap.add_argument("--jobs", default=None,
                help="JSON file: [{shot, out, fromMs?, toMs?}] — build the world ONCE, render every camera")
ap.add_argument("--pass", dest="render_pass", default="beauty")
ap.add_argument("--style", default=None)
ap.add_argument("--width", type=int, default=0)
ap.add_argument("--height", type=int, default=0)
ap.add_argument("--still", type=int, default=-1, help="render a single PNG at this scene ms")
ap.add_argument("--from-ms", type=int, default=-1, help="render only from this scene ms")
ap.add_argument("--to-ms", type=int, default=-1, help="render only up to this scene ms")
ap.add_argument("--samples", type=int, default=0, help="EEVEE render samples (lit style); 0 = default")
ap.add_argument("--grade", default=None, help="tuning only: view_transform:look:exposure")
ap.add_argument("--live", type=int, default=0,
                help="LIVE viewport: keep Blender open and stream its real viewport (EEVEE/Workbench) to 127.0.0.1:<port>")
ap.add_argument("--surface-lib", default=None,
                help="LIVE: native library that puts frames into a shared IOSurface (macOS)")
ap.add_argument("--export-glb", default=None,
                help="export the animated world as .glb (+ <file>.json: cameras per shot, cast) for the live viewer")
args = ap.parse_args(argv)

with open(args.scene, "r", encoding="utf-8") as f:
    S = json.load(f)

FPS = int(S.get("fps") or 24)
STYLE = args.style or S.get("style") or "clay"
PASS = args.render_pass

shots = S.get("shots") or []
# One invocation renders N cameras over the SAME world: the set, the cast
# and their blocking are built once; only the camera changes per job.
if args.jobs:
    with open(args.jobs, "r", encoding="utf-8") as f:
        JOBS = json.load(f)
elif args.export_glb or args.live:
    JOBS = [{"shot": s.get("id")} for s in shots]
else:
    JOBS = [{"shot": args.shot, "out": args.out,
             "fromMs": args.from_ms if args.from_ms >= 0 else None,
             "toMs": args.to_ms if args.to_ms >= 0 else None}]
_by_id = {s.get("id"): s for s in shots}
for j in JOBS:
    if j.get("shot") not in _by_id:
        print(f"[scene3d] shot not found: {j.get('shot')}", file=sys.stderr)
        sys.exit(2)
# "facing: camera" resolves against the first job's camera.
SHOT = _by_id[JOBS[0]["shot"]]


def ms_to_frame(ms):
    return 1 + int(round((ms or 0) * FPS / 1000.0))


def scene_duration_ms():
    d = int(S.get("durationMs") or 0)
    for s in shots:
        d = max(d, int(s.get("startMs") or 0) + int(s.get("durationMs") or 0))
    for a in S.get("actions") or []:
        d = max(d, int(a.get("endMs") or a.get("startMs") or 0))
    return max(d, 1000)


DUR_MS = scene_duration_ms()

# ──────────────────────────────────────────────────────── reset scene ──

if args.live:
    # UI session (the viewport needs a window): clear the startup scene by
    # data API — reloading factory settings mid-startup would tear the UI down.
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.render.fps = FPS
scn.frame_start = 1
scn.frame_end = ms_to_frame(DUR_MS)

# ─────────────────────────────────────────────────────────── helpers ──


def v3(p, default_z=0.0):
    p = list(p or [0, 0])
    if len(p) == 2:
        p.append(default_z)
    return Vector((float(p[0]), float(p[1]), float(p[2])))


def hex_rgba(h, alpha=1.0):
    if isinstance(h, (list, tuple)):
        c = list(h) + [alpha] * (4 - len(h))
        return tuple(float(x) for x in c[:4])
    h = (h or "#b8b8b8").lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    # sRGB → linear so the colour the author wrote is what they see.
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), alpha)


_mat_cache = {}


def material(name, color="#b8b8b8", rough=0.65, emission=None, cull=False, image=None):
    key = (name, str(color), rough, str(emission), cull, image)
    if key in _mat_cache:
        return _mat_cache[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if STYLE == "sketch" and image is None and emission is None:
        color = "#f4f1ea"
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = rough
    if image:
        try:
            img = bpy.data.images.load(image, check_existing=True)
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 0.6
        except Exception as e:  # missing plate → keep flat colour
            print(f"[scene3d] backdrop load failed: {e}", file=sys.stderr)
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(emission)
        bsdf.inputs["Emission Strength"].default_value = 4.0
    m.use_backface_culling = cull
    m.diffuse_color = hex_rgba(color)
    _mat_cache[key] = m
    return m


def link(obj, coll=None):
    (coll or scn.collection).objects.link(obj)
    return obj


def mesh_obj(name, verts, faces, mat=None, parent=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    link(ob)
    if mat:
        ob.data.materials.append(mat)
    if parent:
        ob.parent = parent
    return ob


# Shared unit meshes. Every primitive in a scene is an OBJECT instancing one
# of these (scale = its size, material linked per object): no bpy.ops, no
# per-object geometry — building a 10-character set takes well under a
# second instead of ~10 s of operator calls.
_unit_meshes = {}


def _unit_mesh(kind, taper=None):
    key = (kind, None if taper is None else round(float(taper), 3))
    me = _unit_meshes.get(key)
    if me is not None:
        return me
    bm = bmesh.new()
    smooth = True
    if kind in ("box", "wedge"):
        bmesh.ops.create_cube(bm, size=1.0)
        smooth = False
        if kind == "wedge":  # full height at -y sloping to nothing at +y
            for v in bm.verts:
                if v.co.z > 0 and v.co.y > 0:
                    v.co.z = -0.5
    elif kind == "facet":  # low-poly faceted ball (block-figure head), radius 1
        bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=7, radius=1.0)
        smooth = False
    elif kind in ("sphere", "dome", "ball", "egg"):
        r = 1.0 if kind in ("ball", "egg") else 0.5
        bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=r)
        if kind == "dome":
            for v in bm.verts:
                v.co.z = max(0.0, v.co.z) * 2 - 0.5
        elif kind == "egg":  # narrower, slightly forward chin (unit size)
            for v in bm.verts:
                x, y, z = v.co
                t = max(0.0, -z)
                tp = 1.0 - 0.28 * t
                v.co = Vector((x * tp, y * tp + 0.22 * t, z))
    elif kind == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.5, radius2=0.0, depth=1.0)
    else:  # cylinder (optionally tapered)
        r2 = 0.5 * (float(taper) if taper is not None else 1.0)
        bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.5, radius2=r2, depth=1.0)
    for f in bm.faces:
        f.smooth = smooth
    me = bpy.data.meshes.new(f"unit_{kind}_{key[1]}")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(None)
    _unit_meshes[key] = me
    return me


def instance(kind, name, loc, scale, mat=None, parent=None, rot=(0, 0, 0), taper=None):
    ob = bpy.data.objects.new(name, _unit_mesh(kind, taper))
    link(ob)
    ob.scale = scale
    ob.rotation_euler = rot
    if mat:
        ob.material_slots[0].link = "OBJECT"
        ob.material_slots[0].material = mat
    if parent:
        ob.parent = parent
        ob.location = Vector(loc) - _origin.get(parent.name, Vector((0, 0, 0)))
    else:
        ob.location = loc
    return ob


def prim(kind, name, loc, size, mat=None, parent=None, rot=(0, 0, 0), taper=None):
    """box / cylinder / sphere / cone / wedge / dome primitive; "size" = full
    extents. wedge: full height at -y sloping to nothing at +y (windscreens,
    ramps, roofs). dome: upper half-sphere. taper: cylinder whose top radius
    is taper × the bottom one."""
    if kind not in ("box", "wedge", "sphere", "dome", "cone", "cylinder"):
        kind = "box"
    return instance(kind, name, loc, tuple(size), mat, parent, rot, taper if kind == "cylinder" else None)


# Root-space origin of every pivot empty. Rigs are authored in "root
# space" (the root at 0,0,0, no rotation), so a child's local offset is
# simply its root-space point minus its parent pivot's root-space point.
_origin = {}


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    link(e)
    if parent:
        e.parent = parent
        base = _origin.get(parent.name, Vector((0, 0, 0)))
        _origin[name] = Vector(loc)
        e.location = Vector(loc) - base
    else:
        _origin[name] = Vector((0, 0, 0))
        e.location = loc
    return e


def set_key_interp(obj, interp="BEZIER"):
    ad = obj.animation_data
    if not ad or not ad.action:
        return
    try:
        curves = ad.action.fcurves
    except AttributeError:  # Blender 5 layered actions
        curves = []
        for layer in ad.action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    curves.extend(bag.fcurves)
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = interp


# ─────────────────────────────────────────────────────────────── set ──

SETD = S.get("set") or {}
set_kind = SETD.get("type") or "room"
W, D, H = (list(SETD.get("size") or [8, 8, 3]) + [3])[:3]
floor_col = SETD.get("floorColor") or ("#8a8884" if set_kind != "exterior" else "#7d8a6a")
wall_col = SETD.get("wallColor") or "#d9cdb8"

# Floor (large for exteriors so the horizon never shows an edge).
fw, fd = (W, D) if set_kind == "room" else (max(W, 80), max(D, 80))
mesh_obj("floor", [(-fw / 2, -fd / 2, 0), (fw / 2, -fd / 2, 0), (fw / 2, fd / 2, 0), (-fw / 2, fd / 2, 0)],
         [(0, 1, 2, 3)], material("floor", floor_col, 0.9))

if set_kind == "room":
    wm = material("wall", wall_col, 0.85, cull=True)
    hw, hd = W / 2, D / 2
    # Normals point INTO the room; back-face culling makes a wall vanish
    # when the camera sits behind it, so reverse angles always work.
    walls = {
        "back":  [(-hw, hd, 0), (-hw, hd, H), (hw, hd, H), (hw, hd, 0)],
        "front": [(hw, -hd, 0), (hw, -hd, H), (-hw, -hd, H), (-hw, -hd, 0)],
        "left":  [(-hw, -hd, 0), (-hw, -hd, H), (-hw, hd, H), (-hw, hd, 0)],
        "right": [(hw, hd, 0), (hw, hd, H), (hw, -hd, H), (hw, -hd, 0)],
    }
    omit = set(SETD.get("openWalls") or [])
    for wname, vs in walls.items():
        if wname in omit:
            continue
        mesh_obj(f"wall_{wname}", vs, [(3, 2, 1, 0)], wm)
    if SETD.get("ceiling", True):  # culled from above, so overhead shots still see in
        mesh_obj("ceiling", [(-hw, -hd, H), (-hw, hd, H), (hw, hd, H), (hw, -hd, H)], [(0, 1, 2, 3)],
                 material("ceiling", "#d8d4cc", 0.9, cull=True))

backdrop = SETD.get("backdropImage")
if backdrop:
    bw, bh = (W, H) if set_kind == "room" else (max(W, 30), max(H, 12))
    by = D / 2 - 0.02
    mesh_obj("backdrop", [(-bw / 2, by, 0), (-bw / 2, by, bh), (bw / 2, by, bh), (bw / 2, by, 0)],
             [(0, 1, 2, 3)], material("backdrop", "#ffffff", 1.0, image=backdrop))
    me = bpy.data.objects["backdrop"].data
    uv = me.uv_layers.new()
    for i, c in enumerate([(0, 0), (0, 1), (1, 1), (1, 0)]):
        uv.data[i].uv = c

# ───────────────────────────────────────────────────────────── props ──


# Real-world default sizes [width x, depth y, height z] in metres. Vehicles
# point their nose at +y. A prop's "size" scales its whole silhouette.
PROP_SIZES = {
    "car": [1.8, 4.5, 1.45], "van": [2.0, 5.0, 2.2], "truck": [2.5, 7.5, 3.3], "bus": [2.55, 12.0, 3.1],
    "motorbike": [0.8, 2.1, 1.15], "bicycle": [0.6, 1.75, 1.05], "bench": [1.8, 0.6, 0.85],
    "stool": [0.4, 0.4, 0.75], "wardrobe": [1.2, 0.6, 2.0], "fridge": [0.7, 0.7, 1.85],
    "tv": [1.25, 0.25, 1.2], "monitor": [0.55, 0.2, 0.45], "laptop": [0.34, 0.24, 0.24],
    "bookshelf": [1.0, 0.32, 1.9], "stairs": [1.1, 3.0, 2.7], "streetlight": [0.4, 1.4, 4.8],
    "stall": [2.4, 1.6, 2.4], "umbrella": [2.4, 2.4, 2.3], "fence": [3.0, 0.08, 1.1],
    "wall": [3.0, 0.15, 2.6], "column": [0.4, 0.4, 3.0], "crate": [0.6, 0.6, 0.6],
    "barrel": [0.6, 0.6, 0.9], "bathtub": [1.7, 0.75, 0.6], "toilet": [0.4, 0.7, 0.8],
    "sink": [0.6, 0.5, 0.9], "counter": [2.0, 0.6, 0.92], "desk": [1.4, 0.7, 0.75],
    "shelf": [1.0, 0.35, 1.9], "cabinet": [0.8, 0.45, 0.9], "table": [1.6, 0.9, 0.75],
    "chair": [0.45, 0.45, 0.9], "sofa": [2.0, 0.9, 0.85], "bed": [1.6, 2.0, 0.55],
    "door": [0.9, 0.08, 2.05], "window": [1.4, 0.05, 1.2], "building": [8, 8, 12], "tree": [2.5, 2.5, 5],
}
PRIMS = ("box", "cylinder", "sphere", "cone", "wedge", "dome")


def _rot3(r):
    if isinstance(r, (list, tuple)):
        r = (list(r) + [0, 0, 0])[:3]
        return tuple(math.radians(float(x)) for x in r)
    return (0, 0, math.radians(float(r or 0)))


def build_prop(p, parent=None):
    kind = (p.get("shape") or p.get("kind") or "box").lower()
    pid = p.get("id") or kind
    col = p.get("color") or "#c9c1b4"
    m = material(f"prop_{pid}", col, 0.7)
    root = empty(f"prop_{pid}", (0, 0, 0))
    sz = p.get("size")
    dflt = PROP_SIZES.get(kind, [1, 1, 1])
    sx, sy, sz_ = (list(sz or dflt) + dflt[len(sz or []):])[:3]
    fx, fy, fz = sx / dflt[0], sy / dflt[1], sz_ / dflt[2]
    glass = material("glass", "#2b3238", 0.1)
    tyre = material("tyre", "#1d1d1d", 0.9)
    dark = material("darkmetal", "#3a3d42", 0.4)
    light = material("lightglow", "#fff2cc", 0.3, emission="#fff2cc")

    def P(kind_, name, x, y, z, w, d, h, mat=m, rot=(0, 0, 0), taper=None):
        """Part with its BOTTOM at z, in the prop's unscaled default frame."""
        prim(kind_, f"{pid}_{name}", (x * fx, y * fy, (z + h / 2) * fz), (w * fx, d * fy, h * fz), mat, root, rot, taper)

    def Hcyl(name, x, y, zc, length, r, mat, axis="x"):
        """Horizontal cylinder centred at (x, y, zc): wheels, bars."""
        rot = (0, math.pi / 2, 0) if axis == "x" else (math.pi / 2, 0, 0)
        prim("cylinder", f"{pid}_{name}", (x * fx, y * fy, zc * fz), (r * 2 * fz, r * 2 * fz, length * (fx if axis == "x" else fy)),
             mat, root, rot)

    def wheels(xs, ys, r, wdt):
        for x in xs:
            for y in ys:
                Hcyl("wheel", x, y, r, wdt, r, tyre)

    if kind in PRIMS:
        prim(kind, pid, (0, 0, sz_ / 2), (sx, sy, sz_), m, root, taper=p.get("taper"))
    elif kind == "group":
        # Anything the library lacks: composed from parts in the prop's own
        # frame (metres, z = bottom of the part), so its real dimensions and
        # rough silhouette read right.
        for i, part in enumerate(p.get("parts") or []):
            q = dict(part)
            q.setdefault("id", f"{pid}_p{i}")
            q.setdefault("color", col)
            pk = (q.get("shape") or "box").lower()
            pos = v3(q.get("position"))
            if pk in PRIMS:
                psz = (list(q.get("size") or [0.5, 0.5, 0.5]) + [0.5, 0.5, 0.5])[:3]
                prim(pk, q["id"], (pos.x, pos.y, pos.z + psz[2] / 2), psz,
                     material(f"prop_{q['id']}", q["color"], 0.7), root, _rot3(q.get("rotation")), q.get("taper"))
            else:
                sub = build_prop({**q, "position": [0, 0]})
                sub.parent = root
                sub.location = pos
                sub.rotation_euler = _rot3(q.get("rotation"))
    elif kind == "plane":
        prim("box", pid, (0, 0, 0.005), (sx, sy, 0.01), m, root)
    elif kind == "table":
        P("box", "top", 0, 0, 0.70, 1.6, 0.9, 0.05)
        for ix in (-1, 1):
            for iy in (-1, 1):
                P("box", "leg", ix * 0.74, iy * 0.39, 0, 0.05, 0.05, 0.70)
    elif kind == "chair":
        P("box", "seat", 0, 0, 0.43, 0.45, 0.45, 0.05)
        P("box", "back", 0, 0.2, 0.48, 0.45, 0.05, 0.42)
        for ix in (-1, 1):
            for iy in (-1, 1):
                P("box", "leg", ix * 0.2, iy * 0.2, 0, 0.04, 0.04, 0.43)
    elif kind == "sofa":
        P("box", "base", 0, 0, 0.1, 2.0, 0.9, 0.34)
        P("box", "back", 0, 0.35, 0.1, 2.0, 0.2, 0.75)
        for ix in (-1, 1):
            P("box", "arm", ix * 0.9, 0, 0.1, 0.2, 0.9, 0.55)
    elif kind == "bed":
        P("box", "base", 0, 0, 0, 1.6, 2.0, 0.5)
        P("box", "head", 0, 0.96, 0, 1.6, 0.08, 1.05)
        P("box", "pillow", 0, 0.7, 0.5, 1.3, 0.4, 0.12, material("pillow", "#e8e4dc"))
        P("box", "duvet", 0, -0.25, 0.5, 1.62, 1.4, 0.06, material("duvet", "#cfc6b8"))
    elif kind in ("counter", "cabinet"):
        P("box", "body", 0, 0, 0, dflt[0], dflt[1], dflt[2] - 0.04)
        P("box", "top", 0, 0, dflt[2] - 0.04, dflt[0] + 0.02, dflt[1] + 0.02, 0.04, material("worktop", "#d8d4cc"))
    elif kind == "desk":
        P("box", "top", 0, 0, 0.71, 1.4, 0.7, 0.04)
        for ix in (-1, 1):
            P("box", "side", ix * 0.68, 0, 0, 0.04, 0.68, 0.71)
    elif kind in ("shelf", "bookshelf"):
        w, d, h = dflt
        for ix in (-1, 1):
            P("box", "side", ix * (w / 2 - 0.01), 0, 0, 0.02, d, h)
        P("box", "back", 0, d / 2 - 0.01, 0, w, 0.02, h)
        for i in range(6):
            P("box", "board", 0, 0, i * (h - 0.02) / 5, w, d, 0.02)
        if kind == "bookshelf":
            book_cols = ["#7a3b2e", "#2e4a7a", "#4a6b3a", "#b08a3c", "#5a4a6b"]
            for i in range(5):
                x = -w / 2 + 0.06
                j = 0
                while x < w / 2 - 0.1:
                    bw = 0.03 + 0.015 * ((i + j) % 3)
                    bh = 0.22 + 0.04 * ((i * 3 + j) % 3)
                    P("box", "book", x + bw / 2, 0, i * (h - 0.02) / 5 + 0.02, bw, d * 0.8, bh,
                      material(f"book{(i + j) % 5}", book_cols[(i + j) % 5]))
                    x += bw + 0.004
                    j += 1
    elif kind == "door":
        P("box", "frame", 0, 0, 0, 1.0, 0.1, 2.12, material("doorframe", "#d8d2c6"))
        P("box", "leaf", 0, -0.02, 0, 0.9, 0.06, 2.05, material(f"door_{pid}", p.get("color") or "#6b5340"))
        P("sphere", "knob", 0.36, -0.07, 1.0, 0.06, 0.06, 0.06, dark)
    elif kind == "window":
        sill = float(p.get("sill") or 0.9)
        P("box", "glass", 0, 0, sill, 1.4, 0.04, 1.2, material(f"win_{pid}", "#dfe8f0", 0.2, emission=p.get("glow") or "#cfdcea"))
        frame = material("winframe", "#e8e4dc")
        for z in (sill - 0.03, sill + 1.2 - 0.03):
            P("box", "rail", 0, 0, z, 1.46, 0.08, 0.06, frame)
        for x in (-0.7, 0, 0.7):
            P("box", "stile", x, 0, sill, 0.06, 0.08, 1.2, frame)
    elif kind == "lamp":
        P("cylinder", "base", 0, 0, 0, 0.3, 0.3, 0.03, dark)
        P("cylinder", "pole", 0, 0, 0, 0.04, 0.04, 1.5, dark)
        P("cylinder", "shade", 0, 0, 1.4, 0.42, 0.42, 0.3, material("shade", "#efe6d0", emission="#ffd9a0"), taper=0.6)
    elif kind == "plant":
        P("cylinder", "pot", 0, 0, 0, 0.35, 0.35, 0.4, material("pot", "#8a5a3c"), taper=1.2)
        P("sphere", "leaves", 0, 0, 0.35, 0.7, 0.7, 0.9, material("leaves", "#4f6b3a"))
    elif kind == "tree":
        P("cylinder", "trunk", 0, 0, 0, 0.3, 0.3, 3.0, material("trunk", "#5a4636"), taper=0.7)
        P("sphere", "crown", 0, 0, 2.0, 2.5, 2.5, 3.0, material("crown", "#4a6338"))
    elif kind == "car":
        # Sedan: body, bonnet/boot, cabin with raked screens, four wheels.
        P("box", "body", 0, 0, 0.18, 1.8, 4.5, 0.62)
        P("box", "cabin", 0, -0.2, 0.8, 1.56, 1.6, 0.6, glass)
        P("wedge", "screen", 0, 0.85, 0.8, 1.56, 0.5, 0.6, glass)
        P("wedge", "rear", 0, -1.25, 0.8, 1.56, 0.5, 0.6, glass, rot=(0, 0, math.pi))
        P("box", "roof", 0, -0.2, 1.38, 1.5, 1.5, 0.07)
        for ix in (-1, 1):
            P("box", "headlight", ix * 0.62, 2.24, 0.55, 0.32, 0.04, 0.12, light)
        wheels((-0.8, 0.8), (-1.4, 1.38), 0.33, 0.22)
    elif kind == "van":
        P("box", "body", 0, -0.35, 0.2, 2.0, 4.3, 1.95)
        P("box", "hood", 0, 2.1, 0.2, 2.0, 0.8, 0.85)
        P("wedge", "screen", 0, 1.95, 1.05, 1.9, 0.5, 1.0, glass)
        for ix in (-1, 1):
            P("box", "sidewin", ix * 1.0, 1.45, 1.15, 0.03, 0.6, 0.6, glass)
        wheels((-0.9, 0.9), (-1.7, 1.75), 0.35, 0.24)
    elif kind == "truck":
        P("box", "cab", 0, 2.85, 0.35, 2.4, 1.8, 2.5)
        P("box", "screen", 0, 3.73, 1.6, 2.2, 0.04, 0.9, glass)
        P("box", "cargo", 0, -0.9, 0.9, 2.5, 5.6, 2.4, material(f"cargo_{pid}", "#c9c5bc"))
        P("box", "chassis", 0, 0, 0.35, 2.2, 7.4, 0.55, dark)
        wheels((-1.05, 1.05), (-2.6, -1.5, 2.7), 0.5, 0.35)
    elif kind == "bus":
        P("box", "body", 0, 0, 0.3, 2.55, 12.0, 2.8)
        P("box", "windows", 0, 0.3, 1.35, 2.57, 10.8, 1.05, glass)
        P("box", "screen", 0, 5.99, 1.0, 2.3, 0.04, 1.6, glass)
        wheels((-1.15, 1.15), (-3.8, 4.1), 0.5, 0.3)
    elif kind == "motorbike":
        for y in (-0.72, 0.72):
            Hcyl("wheel", 0, y, 0.31, 0.12, 0.31, tyre)
        P("box", "engine", 0, 0, 0.3, 0.32, 0.6, 0.35, dark)
        P("box", "tank", 0, 0.2, 0.62, 0.3, 0.5, 0.22)
        P("box", "seat", 0, -0.3, 0.72, 0.28, 0.6, 0.1, material("seat", "#222222"))
        P("box", "fork", 0, 0.72, 0.3, 0.06, 0.06, 0.7, dark, rot=(math.radians(-20), 0, 0))
        Hcyl("bar", 0, 0.62, 1.02, 0.72, 0.016, dark)
        P("sphere", "headlight", 0, 0.82, 0.85, 0.16, 0.1, 0.16, light)
    elif kind == "bicycle":
        for y in (-0.53, 0.53):
            Hcyl("wheel", 0, y, 0.34, 0.04, 0.34, tyre)
        P("box", "frame", 0, 0, 0.34, 0.04, 0.95, 0.04, dark, rot=(math.radians(-25), 0, 0))
        P("box", "seatpost", 0, -0.2, 0.34, 0.03, 0.03, 0.55, dark)
        P("box", "saddle", 0, -0.2, 0.88, 0.14, 0.26, 0.05, material("seat", "#222222"))
        P("box", "stem", 0, 0.45, 0.34, 0.03, 0.03, 0.66, dark)
        Hcyl("bar", 0, 0.45, 1.0, 0.56, 0.013, dark)
    elif kind == "bench":
        P("box", "seat", 0, 0, 0.42, 1.8, 0.45, 0.05)
        P("box", "back", 0, 0.24, 0.5, 1.8, 0.05, 0.35, rot=(math.radians(-10), 0, 0))
        for ix in (-0.8, 0.8):
            P("box", "leg", ix, 0, 0, 0.06, 0.5, 0.42, dark)
    elif kind == "stool":
        P("cylinder", "seat", 0, 0, 0.7, 0.38, 0.38, 0.05)
        P("cylinder", "pole", 0, 0, 0.05, 0.05, 0.05, 0.65, dark)
        P("cylinder", "foot", 0, 0, 0, 0.36, 0.36, 0.05, dark)
    elif kind == "wardrobe":
        P("box", "body", 0, 0, 0, 1.2, 0.6, 2.0)
        P("box", "seam", 0, -0.301, 0.05, 0.01, 0.01, 1.9, dark)
        for ix in (-0.04, 0.04):
            P("box", "handle", ix, -0.31, 1.0, 0.02, 0.02, 0.2, dark)
    elif kind == "fridge":
        P("box", "body", 0, 0, 0, 0.7, 0.7, 1.85, material(f"fridge_{pid}", p.get("color") or "#e9e9e6"))
        P("box", "gap", 0, -0.351, 1.18, 0.7, 0.01, 0.015, dark)
        P("box", "handle", 0.28, -0.37, 1.3, 0.03, 0.03, 0.35, dark)
    elif kind == "tv":
        P("box", "screen", 0, 0, 0.72, 1.25, 0.05, 0.72, material("screen", "#15171a", 0.15))
        P("box", "stand", 0, 0, 0, 0.9, 0.4, 0.5, m)
    elif kind == "monitor":
        P("box", "screen", 0, 0, 0.12, 0.55, 0.03, 0.33, material("screen", "#15171a", 0.15))
        P("box", "neck", 0, 0.03, 0, 0.05, 0.04, 0.14, dark)
        P("box", "foot", 0, 0.02, 0, 0.22, 0.18, 0.015, dark)
    elif kind == "laptop":
        P("box", "base", 0, 0, 0, 0.34, 0.24, 0.018, dark)
        P("box", "lid", 0, 0.11, 0.018, 0.34, 0.012, 0.22, material("screen", "#15171a", 0.15),
          rot=(math.radians(-12), 0, 0))
    elif kind == "stairs":
        w, run, h = sx, sy, sz_
        n = max(2, round(h / 0.18))
        for i in range(n):
            prim("box", f"{pid}_step", (0, -run / 2 + run * (i + 0.5) / n, h * (i + 1) / n / 2),
                 (w, run / n, h * (i + 1) / n), m, root)
    elif kind == "streetlight":
        P("cylinder", "pole", 0, 0, 0, 0.14, 0.14, 4.6, dark, taper=0.6)
        P("box", "arm", 0, 0.5, 4.5, 0.06, 1.1, 0.06, dark)
        P("box", "head", 0, 1.0, 4.4, 0.25, 0.4, 0.12, light)
    elif kind == "stall":
        P("box", "counter", 0, -0.3, 0, 2.4, 0.9, 0.9)
        for ix in (-1.15, 1.15):
            for iy in (-0.75, 0.75):
                P("cylinder", "pole", ix, iy, 0, 0.05, 0.05, 2.2, dark)
        P("wedge", "awning", 0, 0, 2.2, 2.5, 1.7, 0.25, material(f"awning_{pid}", p.get("awningColor") or "#b5543c"),
          rot=(0, 0, math.pi))
    elif kind == "umbrella":
        P("cylinder", "pole", 0, 0, 0, 0.05, 0.05, 2.2, dark)
        P("cone", "canopy", 0, 0, 1.9, 2.4, 2.4, 0.4, material(f"canopy_{pid}", p.get("color") or "#c8b28a"))
    elif kind == "fence":
        n = max(2, round(sx / 1.0) + 1)
        for i in range(n):
            prim("box", f"{pid}_post", (-sx / 2 + sx * i / (n - 1), 0, sz_ / 2), (0.08, 0.08, sz_), m, root)
        for z in (0.35, 0.85):
            prim("box", f"{pid}_rail", (0, 0, z * sz_ / 1.1), (sx, 0.04, 0.06), m, root)
    elif kind in ("wall", "column", "crate", "building"):
        prim("box" if kind != "column" else "cylinder", pid, (0, 0, sz_ / 2), (sx, sy, sz_), m, root)
    elif kind == "barrel":
        P("cylinder", "body", 0, 0, 0, 0.6, 0.6, 0.9, material(f"barrel_{pid}", p.get("color") or "#6b4a30"))
        for z in (0.12, 0.76):
            P("cylinder", "hoop", 0, 0, z, 0.62, 0.62, 0.03, dark)
    elif kind == "bathtub":
        P("box", "tub", 0, 0, 0, 1.7, 0.75, 0.6, material(f"tub_{pid}", "#eeeeea"))
        P("box", "inside", 0, 0, 0.5, 1.5, 0.58, 0.11, material("tubshade", "#bfc3c6"))
    elif kind == "toilet":
        P("cylinder", "bowl", 0, -0.08, 0, 0.36, 0.5, 0.42, material("porcelain", "#f0f0ec"), taper=1.15)
        P("box", "tank", 0, 0.27, 0.35, 0.4, 0.16, 0.42, material("porcelain", "#f0f0ec"))
    elif kind == "sink":
        P("box", "cabinet", 0, 0, 0, 0.6, 0.5, 0.82)
        P("box", "basin", 0, 0, 0.82, 0.62, 0.52, 0.08, material("porcelain", "#f0f0ec"))
        P("cylinder", "tap", 0, 0.18, 0.9, 0.03, 0.03, 0.18, dark)
    else:
        prim("box", pid, (0, 0, sz_ / 2), (sx, sy, sz_), m, root)

    root.location = v3(p.get("position"))
    root.rotation_euler = _rot3(p.get("rotation"))
    root["h"] = float(sz_)
    return root


for p in SETD.get("props") or S.get("props") or []:
    build_prop(p)

# ─────────────────────────────────────────────────────── characters ──
#
# An artist's WOODEN MANNEQUIN: egg head (chin forward so gaze reads with
# no face), carved chest / pelvis blocks, a ball at every joint, tapered
# limbs, mitten hands. Pivots are empties so poses are plain rotations:
#   root (position + yaw) → hips → neck, shoulder → elbow, hip → knee.
# Rotation conventions (character faces local +y):
#   hip.x  > 0 → leg forward      knee.x  < 0 → shin bends back
#   shoulder.x > 0 → arm forward  elbow.x > 0 → forearm bends forward

CHAR_PALETTE = ["#c0694a", "#4a7cc0", "#6aa05a", "#b58a3c", "#8a5ab0", "#4aa6a0"]
MASK_PALETTE = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"]
WOOD = "#d9bf96"
CHARS = {}


def yaw_to(src, dst):
    d = Vector((dst[0] - src[0], dst[1] - src[1]))
    if d.length < 1e-4:
        return None
    # yaw 0 = facing +y; positive = counter-clockwise.
    return math.atan2(-d.x, d.y)


def _mix_hex(a, b, t):
    ca, cb = a.lstrip("#"), b.lstrip("#")
    va = [int(ca[i:i + 2], 16) for i in (0, 2, 4)]
    vb = [int(cb[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(va, vb))


def wood_material(name, tint):
    """Light birch, faintly tinted per character so the cast stays
    distinguishable. Workbench shows the flat colour; EEVEE ("lit") gets a
    procedural grain."""
    col = _mix_hex(WOOD, tint, 0.22) if tint else WOOD
    m = material(name, col, 0.55)
    if STYLE == "lit":
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tc = nt.nodes.new("ShaderNodeTexCoord")
        wave = nt.nodes.new("ShaderNodeTexWave")
        wave.wave_type = "BANDS"
        wave.inputs["Scale"].default_value = 3.0
        wave.inputs["Distortion"].default_value = 6.0
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].color = hex_rgba(_mix_hex(col, "#8a6a3e", 0.45))
        ramp.color_ramp.elements[1].color = hex_rgba(col)
        nt.links.new(tc.outputs["Object"], wave.inputs["Vector"])
        nt.links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def ball(name, loc, r, mat, parent):
    """Joint ball of radius r (shared unit sphere, radius 1)."""
    return instance("ball", name, loc, (r, r, r), mat, parent)


def limb(name, x, y, z_top, z_bot, r_top, r_bot, mat, parent):
    """Tapered round segment between two heights (upper arm, shin…)."""
    return instance("cylinder", name, (x, y, (z_top + z_bot) / 2),
                    (r_bot * 2, r_bot * 2, z_top - z_bot), mat, parent, taper=round(r_top / r_bot, 2))


def block(name, z_bot, z_top, w_bot, d_bot, w_top, d_top, mat, parent, bevel=0.012):
    """Carved frustum (chest wider on top, pelvis wider below), bevelled."""
    vs = [(-w_bot / 2, -d_bot / 2, z_bot), (w_bot / 2, -d_bot / 2, z_bot),
          (w_bot / 2, d_bot / 2, z_bot), (-w_bot / 2, d_bot / 2, z_bot),
          (-w_top / 2, -d_top / 2, z_top), (w_top / 2, -d_top / 2, z_top),
          (w_top / 2, d_top / 2, z_top), (-w_top / 2, d_top / 2, z_top)]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(vs, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    link(ob)
    ob.data.materials.append(mat)
    mod = ob.modifiers.new("bevel", "BEVEL")
    mod.width = bevel
    mod.segments = 3
    for poly in me.polygons:
        poly.use_smooth = True
    if parent:
        ob.parent = parent
        ob.location = -_origin.get(parent.name, Vector((0, 0, 0)))
    return ob


def egg_head(name, center, k, mat, parent):
    """Egg: narrower, slightly forward chin — the facing reads at a glance."""
    return instance("egg", name, center, (0.095 * k, 0.11 * k, 0.135 * k), mat, parent)


def build_character(c, idx):
    cid = c.get("id") or f"char{idx}"
    h = float(c.get("height") or 1.75)
    k = h / 1.75
    tint = c.get("color") or CHAR_PALETTE[idx % len(CHAR_PALETTE)]
    wood = wood_material(f"wood_{cid}", tint)
    joint = wood_material(f"joint_{cid}", _mix_hex(tint, "#000000", 0.25))
    K = lambda *v: tuple(x * k for x in v)

    root = empty(f"char_{cid}", v3(c.get("position")))
    hips = empty(f"{cid}_hips", K(0, 0, 0.95), root)
    # Torso
    block(f"{cid}_pelvis", 0.84 * k, 1.03 * k, 0.33 * k, 0.19 * k, 0.26 * k, 0.16 * k, wood, hips)
    ball(f"{cid}_waist", K(0, 0, 1.075), 0.085 * k, joint, hips).scale = K(0.106, 0.081, 0.064)
    block(f"{cid}_chest", 1.11 * k, 1.42 * k, 0.25 * k, 0.16 * k, 0.37 * k, 0.21 * k, wood, hips)
    neck = empty(f"{cid}_neck", K(0, 0, 1.45), hips)
    ball(f"{cid}_neckball", K(0, 0, 1.475), 0.048 * k, joint, neck)
    egg_head(f"{cid}_head", K(0, 0.005, 1.635), k, wood, neck)
    parts = {"root": root, "hips": hips, "neck": neck}
    for side, sx in (("L", -1), ("R", 1)):
        x = sx * 0.225 * k
        sh = empty(f"{cid}_shoulder{side}", (x, 0, 1.39 * k), hips)
        ball(f"{cid}_shoulderball{side}", (x, 0, 1.39 * k), 0.062 * k, joint, sh)
        limb(f"{cid}_upperarm{side}", x, 0, 1.35 * k, 1.09 * k, 0.046 * k, 0.038 * k, wood, sh)
        el = empty(f"{cid}_elbow{side}", (x, 0, 1.065 * k), sh)
        ball(f"{cid}_elbowball{side}", (x, 0, 1.065 * k), 0.036 * k, joint, el)
        limb(f"{cid}_forearm{side}", x, 0, 1.04 * k, 0.81 * k, 0.036 * k, 0.028 * k, wood, el)
        ball(f"{cid}_wrist{side}", (x, 0, 0.795 * k), 0.025 * k, joint, el)
        hand = ball(f"{cid}_hand{side}", (x, 0.008 * k, 0.715 * k), 1.0, wood, el)
        hand.scale = K(0.032, 0.05, 0.075)
        hp = empty(f"{cid}_hip{side}", (sx * 0.085 * k, 0, 0.875 * k), hips)
        ball(f"{cid}_hipball{side}", (sx * 0.085 * k, 0, 0.875 * k), 0.06 * k, joint, hp)
        limb(f"{cid}_thigh{side}", sx * 0.085 * k, 0, 0.84 * k, 0.5 * k, 0.066 * k, 0.05 * k, wood, hp)
        kn = empty(f"{cid}_knee{side}", (sx * 0.085 * k, 0, 0.475 * k), hp)
        ball(f"{cid}_kneeball{side}", (sx * 0.085 * k, 0, 0.475 * k), 0.046 * k, joint, kn)
        limb(f"{cid}_shin{side}", sx * 0.085 * k, 0, 0.45 * k, 0.1 * k, 0.047 * k, 0.034 * k, wood, kn)
        ball(f"{cid}_ankle{side}", (sx * 0.085 * k, 0, 0.083 * k), 0.03 * k, joint, kn)
        foot = ball(f"{cid}_foot{side}", (sx * 0.085 * k, 0.045 * k, 0.036 * k), 1.0, wood, kn)
        foot.scale = K(0.045, 0.11, 0.036)
        parts.update({f"shoulder{side}": sh, f"elbow{side}": el, f"hip{side}": hp, f"knee{side}": kn})
        # Relaxed stance: a touch of bend, never ramrod straight.
        el.rotation_euler.x = math.radians(8)
    parts.update(height=h, k=k, idx=idx, id=cid, mask=MASK_PALETTE[idx % len(MASK_PALETTE)])
    CHARS[cid] = parts
    return parts


def build_block_figure(c, idx):
    """Abstract BLOCK FIGURE (default look): a faceted ball head floating over
    a slab torso, slab arms and block legs — flat grey clay, like a
    Blender layout pass. Same pivots as the mannequin, so every action
    (walk, sit, gestures) drives it unchanged."""
    cid = c.get("id") or f"char{idx}"
    h = float(c.get("height") or 1.75)
    k = h / 1.75
    tint = c.get("color") or CHAR_PALETTE[idx % len(CHAR_PALETTE)]
    clay = material(f"clay_{cid}", _mix_hex("#d2d0cc", tint, 0.38), 0.6)
    K = lambda *v: tuple(x * k for x in v)
    root = empty(f"char_{cid}", v3(c.get("position")))
    hips = empty(f"{cid}_hips", K(0, 0, 0.95), root)
    instance("box", f"{cid}_torso", K(0, 0, 1.215), K(0.36, 0.2, 0.53), clay, hips)
    neck = empty(f"{cid}_neck", K(0, 0, 1.49), hips)
    instance("facet", f"{cid}_head", K(0, 0.01, 1.625), K(0.105, 0.105, 0.115), clay, neck)
    parts = {"root": root, "hips": hips, "neck": neck}
    for side, sx in (("L", -1), ("R", 1)):
        x = sx * 0.225 * k
        sh = empty(f"{cid}_shoulder{side}", (x, 0, 1.45 * k), hips)
        instance("box", f"{cid}_upperarm{side}", (x, 0, 1.275 * k), K(0.07, 0.11, 0.33), clay, sh)
        el = empty(f"{cid}_elbow{side}", (x, 0, 1.11 * k), sh)
        instance("box", f"{cid}_forearm{side}", (x, 0, 0.935 * k), K(0.065, 0.1, 0.33), clay, el)
        hp = empty(f"{cid}_hip{side}", (sx * 0.085 * k, 0, 0.93 * k), hips)
        instance("box", f"{cid}_thigh{side}", (sx * 0.085 * k, 0, 0.715 * k), K(0.15, 0.18, 0.43), clay, hp)
        kn = empty(f"{cid}_knee{side}", (sx * 0.085 * k, 0, 0.5 * k), hp)
        instance("box", f"{cid}_shin{side}", (sx * 0.085 * k, 0.0, 0.25 * k), K(0.14, 0.17, 0.5), clay, kn)
        parts.update({f"shoulder{side}": sh, f"elbow{side}": el, f"hip{side}": hp, f"knee{side}": kn})
        el.rotation_euler.x = math.radians(6)
    parts.update(height=h, k=k, idx=idx, id=cid, mask=MASK_PALETTE[idx % len(MASK_PALETTE)])
    CHARS[cid] = parts
    return parts


CHARACTER_STYLE = (S.get("characterStyle") or "block").lower()
for i, c in enumerate(S.get("characters") or []):
    (build_character if CHARACTER_STYLE == "mannequin" else build_block_figure)(c, i)


def char_head(cid):
    ch = CHARS.get(cid)
    if not ch:
        return None
    return ch["root"].location + Vector((0, 0, 1.62 * ch["k"]))


# ─────────────────────────────────────────────────────────── actions ──


def resolve_point(t, default=None):
    """"[x,y]", "[x,y,z]", a character id, "camera" or a prop id."""
    if t is None:
        return default
    if isinstance(t, (list, tuple)):
        return v3(t)
    if isinstance(t, str):
        if t in CHARS:
            return CHARS[t]["root"].location.copy()
        if t.startswith("char:") and t[5:] in CHARS:
            return CHARS[t[5:]]["root"].location.copy()
        ob = bpy.data.objects.get(f"prop_{t}")
        if ob:
            return ob.location.copy()
    return default


def key(obj, path, frame):
    obj.keyframe_insert(data_path=path, frame=frame)


def initial_facing(c):
    f = c.get("facing")
    pos = v3(c.get("position"))
    if isinstance(f, (int, float)):
        return math.radians(float(f))
    tgt = resolve_point(f) if f not in (None, "camera") else None
    if f == "camera":
        cam0 = (SHOT.get("camera") or {}).get("position")
        tgt = v3(cam0) if cam0 else Vector((0, -D / 2, 0))
    if tgt is not None:
        y = yaw_to(pos, tgt)
        if y is not None:
            return y
    return math.pi  # default: face the front of the set (towards -y)


JOINTS = ("hipL", "hipR", "kneeL", "kneeR", "shoulderL", "shoulderR", "elbowL", "elbowR", "neck")


def _sit_pose(ch, on=True):
    """Seat height ≈ knee height: hips drop, thighs forward, shins down."""
    k = ch["k"]
    ch["hips"].location.z = (0.95 - 0.41) * k if on else 0.95 * k
    for s in ("L", "R"):
        ch[f"hip{s}"].rotation_euler.x = math.pi / 2 if on else 0
        ch[f"knee{s}"].rotation_euler.x = -math.pi / 2 if on else 0
        ch[f"elbow{s}"].rotation_euler.x = math.radians(55 if on else 8)
        ch[f"shoulder{s}"].rotation_euler.x = math.radians(18 if on else 0)


def _key_pose(ch, frame):
    key(ch["hips"], "location", frame)
    for part in JOINTS:
        key(ch[part], "rotation_euler", frame)


# Per-character state machine baked as keyframes, sorted by start time.
for i, c in enumerate(S.get("characters") or []):
    cid = c.get("id") or f"char{i}"
    ch = CHARS[cid]
    root, hips = ch["root"], ch["hips"]
    root.rotation_euler = (0, 0, initial_facing(c))
    key(root, "location", 1)
    key(root, "rotation_euler", 1)
    if c.get("pose") == "sitting":
        _sit_pose(ch)
    for part in JOINTS:
        key(ch[part], "rotation_euler", 1)
    key(hips, "location", 1)

acts = sorted(S.get("actions") or [], key=lambda a: int(a.get("startMs") or 0))
for a in acts:
    cid = a.get("character")
    ch = CHARS.get(cid)
    if not ch:
        continue
    root, hips, k = ch["root"], ch["hips"], ch["k"]
    typ = (a.get("type") or "").lower()
    f0 = ms_to_frame(a.get("startMs"))
    f1 = max(f0 + 1, ms_to_frame(a.get("endMs") or (int(a.get("startMs") or 0) + 1500)))
    scn.frame_set(f0)

    if typ in ("walk", "run", "move"):
        src = root.location.copy()
        dst = resolve_point(a.get("to"), src)
        dst = Vector((dst.x, dst.y, 0))
        yaw = yaw_to(src, dst)
        key(root, "location", f0)
        if yaw is not None:
            # Turn in place over the first ~0.3 s, then walk.
            turn_f = min(f1, f0 + max(1, int(0.3 * FPS)))
            key(root, "rotation_euler", f0)
            cur = root.rotation_euler.z
            dz = (yaw - cur + math.pi) % (2 * math.pi) - math.pi
            root.rotation_euler.z = cur + dz
            key(root, "rotation_euler", turn_f)
        root.location = dst
        key(root, "location", f1)
        # Characters are POSITION MARKERS, not actors: they glide — the
        # video model performs the walk. No leg / arm cycle on purpose.
        if a.get("face") is not None:
            tgt = resolve_point(a.get("face"))
            y2 = yaw_to(dst, tgt) if tgt is not None else None
            if y2 is not None:
                key(root, "rotation_euler", f1)
                cur = root.rotation_euler.z
                root.rotation_euler.z = cur + (y2 - cur + math.pi) % (2 * math.pi) - math.pi
                key(root, "rotation_euler", f1 + max(1, int(0.3 * FPS)))

    elif typ in ("turn", "face", "look_at", "look"):
        tgt = a.get("target") if a.get("target") is not None else a.get("facing")
        if isinstance(tgt, (int, float)):
            yaw = math.radians(float(tgt))
        else:
            if tgt == "camera":
                cp = (SHOT.get("camera") or {}).get("position")
                tp = v3(cp) if cp else Vector((0, -D / 2, 0))
            else:
                tp = resolve_point(tgt)
            yaw = yaw_to(root.location, tp) if tp is not None else None
        if yaw is None:
            continue
        if typ in ("look_at", "look"):
            # Head only (clamped), body keeps its yaw.
            neck = ch["neck"]
            key(neck, "rotation_euler", f0)
            rel = (yaw - root.rotation_euler.z + math.pi) % (2 * math.pi) - math.pi
            neck.rotation_euler.z = max(-1.2, min(1.2, rel))
            key(neck, "rotation_euler", f1)
        else:
            key(root, "rotation_euler", f0)
            cur = root.rotation_euler.z
            root.rotation_euler.z = cur + (yaw - cur + math.pi) % (2 * math.pi) - math.pi
            key(root, "rotation_euler", f1)

    elif typ in ("sit", "sit_down"):
        _key_pose(ch, f0)
        _sit_pose(ch, True)
        _key_pose(ch, f1)

    elif typ in ("stand", "stand_up"):
        _key_pose(ch, f0)
        _sit_pose(ch, False)
        _key_pose(ch, f1)

    elif typ in ("gesture", "wave", "point", "raise_arm", "nod", "shake_head"):
        continue  # retired: markers don't act; the video model performs it
    elif False:
        side = "R" if (a.get("hand") or "right").lower().startswith("r") else "L"
        sh = ch[f"shoulder{side}"]
        key(sh, "rotation_euler", f0)
        el = ch[f"elbow{side}"]
        key(el, "rotation_euler", f0)
        if typ == "point":
            sh.rotation_euler.x = math.radians(85)
            el.rotation_euler.x = 0
        else:
            sh.rotation_euler.y = math.radians(150 if side == "L" else -150)
            el.rotation_euler.x = math.radians(25 if typ == "wave" else 10)
        key(el, "rotation_euler", min(f1, f0 + int(0.35 * FPS)))
        mid = (f0 + f1) // 2
        key(sh, "rotation_euler", min(f1, f0 + int(0.35 * FPS)))
        if typ == "wave":
            for j, fr in enumerate(range(f0 + int(0.35 * FPS), mid, max(3, int(0.2 * FPS)))):
                sh.rotation_euler.y = math.radians((150 if side == "L" else -150) + (15 if j % 2 else -15))
                key(sh, "rotation_euler", fr)
        key(sh, "rotation_euler", max(f0 + 1, f1 - int(0.35 * FPS)))
        key(el, "rotation_euler", max(f0 + 1, f1 - int(0.35 * FPS)))
        sh.rotation_euler = (0, 0, 0)
        el.rotation_euler = (math.radians(8), 0, 0)
        key(sh, "rotation_euler", f1)
        key(el, "rotation_euler", f1)

# ── interactions that change the picture: hold / grab / give / put / kick ──
#
# Only what the viewer must READ (who has the ball, the kick) moves a limb.
# Arms reach with a small 2-bone IK; held props follow the hand every frame.

HAND_AT = {  # hand targets in the character's own frame (faces +y), metres for 1.75 m
    "chest": (0.0, 0.3, 1.25), "chin": (0.0, 0.24, 1.47), "face": (0.0, 0.26, 1.58),
    "head": (0.0, 0.15, 1.85), "waist": (0.0, 0.3, 1.0), "navel": (0.0, 0.3, 1.0),
    "low": (0.0, 0.32, 0.82), "front": (0.0, 0.55, 1.3), "out": (0.0, 0.6, 1.2),
}
ARM = {"L1": 0.34, "L2": 0.34}


def _hand_world(ch, side):
    fa = bpy.data.objects.get(f"{ch['id']}_forearm{side}")
    if fa is None:
        return ch[f"elbow{side}"].matrix_world.translation.copy()
    return fa.matrix_world @ Vector((0, 0, -0.5))


def _arm_ik(ch, side, target_world, frame):
    """Pose shoulder (x, y) + elbow (x) so the hand lands on target_world."""
    scn.frame_set(frame)
    k = ch["k"]
    L1, L2 = ARM["L1"] * k, ARM["L2"] * k
    sh, el = ch[f"shoulder{side}"], ch[f"elbow{side}"]
    S = sh.matrix_world.translation
    parent_rot = sh.parent.matrix_world.to_3x3().inverted() if sh.parent else Matrix.Identity(3)
    T = parent_rot @ (Vector(target_world) - S)
    d = max(0.05, min(L1 + L2 - 1e-3, T.length))
    theta = math.pi - math.acos(max(-1.0, min(1.0, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))))

    def fk(a, b):
        rx = Matrix.Rotation(a, 3, "X")
        ry = Matrix.Rotation(b, 3, "Y")
        local = Vector((0, 0, -L1)) + Matrix.Rotation(theta, 3, "X") @ Vector((0, 0, -L2))
        return ry @ rx @ local

    want = T.normalized() * d
    a, b = 0.6, 0.0
    for _ in range(40):  # tiny Gauss-Newton on the two shoulder angles
        e = fk(a, b) - want
        if e.length < 1e-3:
            break
        h = 1e-3
        ja = (fk(a + h, b) - fk(a, b)) / h
        jb = (fk(a, b + h) - fk(a, b)) / h
        jtj = [[ja.dot(ja), ja.dot(jb)], [ja.dot(jb), jb.dot(jb)]]
        g = [ja.dot(e), jb.dot(e)]
        det = jtj[0][0] * jtj[1][1] - jtj[0][1] ** 2
        if abs(det) < 1e-9:
            break
        a -= (jtj[1][1] * g[0] - jtj[0][1] * g[1]) / det
        b -= (-jtj[0][1] * g[0] + jtj[0][0] * g[1]) / det
        b = max(-1.7, min(1.7, b))  # no flip to the far solution
    sh.rotation_euler = (a, b, 0)
    el.rotation_euler = (theta, 0, 0)
    key(sh, "rotation_euler", frame)
    key(el, "rotation_euler", frame)


def _rest_arm(ch, side, frame):
    ch[f"shoulder{side}"].rotation_euler = (0, 0, 0)
    ch[f"elbow{side}"].rotation_euler = (math.radians(6), 0, 0)
    key(ch[f"shoulder{side}"], "rotation_euler", frame)
    key(ch[f"elbow{side}"], "rotation_euler", frame)


def _local_to_world(ch, p, frame):
    scn.frame_set(frame)
    k = ch["k"]
    return ch["root"].matrix_world @ Vector((p[0] * k, p[1] * k, p[2] * k))


def _hand_target(ch, at, side, frame):
    if isinstance(at, (list, tuple)) and len(at) == 3 and not isinstance(at[0], str):
        return _local_to_world(ch, at, frame)
    base = HAND_AT.get(str(at or "chest"), HAND_AT["chest"])
    x = base[0] + (0.09 if side == "R" else -0.09)  # two hands side by side
    return _local_to_world(ch, (x, base[1], base[2]), frame)


HOLDS = []  # (prop root, character, sides, from frame, to frame, at)
_ramp = max(2, int(0.3 * FPS))
for a in acts:
    typ = (a.get("type") or "").lower()
    if typ not in ("hold", "grab", "give", "put", "drop", "kick", "carry"):
        continue
    ch = CHARS.get(a.get("character"))
    if not ch:
        continue
    f0 = ms_to_frame(a.get("startMs"))
    f1 = max(f0 + 1, ms_to_frame(a.get("endMs") or (int(a.get("startMs") or 0) + 1000)))
    hands = (a.get("hands") or a.get("hand") or "both").lower()
    sides = ["L", "R"] if hands.startswith("both") else (["R"] if hands.startswith("r") else ["L"])
    prop = bpy.data.objects.get(f"prop_{a.get('prop')}") if a.get("prop") else None
    # Freeze every arm/leg where it is at the start of this beat, so the
    # new pose blends from THAT and not from some far-away earlier key.
    scn.frame_set(f0)
    for who in [ch] + ([CHARS[a["to"]]] if typ == "give" and CHARS.get(a.get("to")) else []):
        for part in ("shoulderL", "shoulderR", "elbowL", "elbowR", "hipL", "hipR", "kneeL", "kneeR"):
            key(who[part], "rotation_euler", f0)
    if typ in ("hold", "carry"):
        end = ms_to_frame(a["endMs"]) if a.get("endMs") else scn.frame_end
        for sd in sides:
            _rest_arm(ch, sd, f0)
            _arm_ik(ch, sd, _hand_target(ch, a.get("at"), sd, f0 + _ramp), f0 + _ramp)
            # Re-solve along the hold so the hands follow the body (walks, turns).
            fr = f0 + _ramp + max(4, FPS // 2)
            while fr < end:
                _arm_ik(ch, sd, _hand_target(ch, a.get("at"), sd, fr), fr)
                fr += max(4, FPS // 2)
            if a.get("endMs"):
                _rest_arm(ch, sd, end + _ramp)
        if prop:
            HOLDS.append((prop, ch, sides, f0 + _ramp, end, a.get("at")))
    elif typ == "grab" and prop:
        scn.frame_set(f1)
        for sd in sides:
            _rest_arm(ch, sd, f0)
            _arm_ik(ch, sd, prop.matrix_world.translation, f1)
        HOLDS.append((prop, ch, sides, f1, scn.frame_end, a.get("at") or "chest"))
        for sd in sides:  # bring it in to the body
            _arm_ik(ch, sd, _hand_target(ch, a.get("at") or "chest", sd, f1 + _ramp), f1 + _ramp)
    elif typ == "give" and prop and CHARS.get(a.get("to")):
        rc = CHARS[a["to"]]
        scn.frame_set(f1)
        mid = (ch["root"].matrix_world.translation + rc["root"].matrix_world.translation) / 2
        mid.z = 1.2 * ch["k"]
        for sd in sides:
            _arm_ik(ch, sd, mid, f1)
            _rest_arm(ch, sd, f1 + _ramp)
        for sd in ("L", "R"):
            _rest_arm(rc, sd, f0)
            _arm_ik(rc, sd, mid, f1)
            _arm_ik(rc, sd, _hand_target(rc, "chest", sd, f1 + _ramp), f1 + _ramp)
        # Cut the giver's hold at the hand-over; the receiver holds from there.
        HOLDS[:] = [(p, c, s_, a_, (min(b_, f1) if p == prop and a_ < f1 else b_), at_) for (p, c, s_, a_, b_, at_) in HOLDS]
        HOLDS.append((prop, rc, ["L", "R"], f1, scn.frame_end, "chest"))
    elif typ in ("put", "drop") and prop:
        HOLDS[:] = [(p, c, s_, a_, (min(b_, f0) if p == prop and a_ < f0 else b_), at_) for (p, c, s_, a_, b_, at_) in HOLDS]
        dest = resolve_point(a.get("on") or a.get("to"), None)
        for sd in sides:
            _rest_arm(ch, sd, f1)
        if dest is not None:
            prop.keyframe_insert("location", frame=f0)
            prop.location = dest
            prop.keyframe_insert("location", frame=f1)
    elif typ == "kick":
        side = "R" if not hands.startswith("l") else "L"
        hp, kn = ch[f"hip{side}"], ch[f"knee{side}"]
        mid = (f0 + f1) // 2
        key(hp, "rotation_euler", f0)
        key(kn, "rotation_euler", f0)
        hp.rotation_euler.x = math.radians(-25)
        kn.rotation_euler.x = math.radians(-60)
        key(hp, "rotation_euler", max(f0 + 1, mid - _ramp))
        key(kn, "rotation_euler", max(f0 + 1, mid - _ramp))
        hp.rotation_euler.x = math.radians(70)
        kn.rotation_euler.x = 0
        key(hp, "rotation_euler", mid)
        key(kn, "rotation_euler", mid)
        hp.rotation_euler.x = 0
        key(hp, "rotation_euler", f1)
        key(kn, "rotation_euler", f1)
        if prop and a.get("to") is not None:
            dest = resolve_point(a.get("to"), None)
            if dest is not None:
                prop.keyframe_insert("location", frame=mid)
                prop.location = dest
                prop.keyframe_insert("location", frame=f1)

for ch in CHARS.values():
    for part in ("root", "hips") + JOINTS:
        set_key_interp(ch[part], "BEZIER")

# Held props ride the hands (baked every frame of each hold).
for prop, ch, sides, fa, fb, _at in HOLDS:
    if fb <= fa:
        continue
    prop.keyframe_insert("location", frame=max(1, fa - 1))
    for fr in range(fa, fb + 1):
        scn.frame_set(fr)
        pts = [_hand_world(ch, sd) for sd in sides]
        c = sum(pts, Vector((0, 0, 0))) / len(pts)
        # The prop's origin is its base: lift it so its centre sits in the hands.
        hgt = (prop.get("h") or 0.2)
        prop.location = c - Vector((0, 0, hgt / 2))
        prop.keyframe_insert("location", frame=fr)
    set_key_interp(prop, "LINEAR")

# ──────────────────────────────────────────────────────────── camera ──

SHOT_SIZES = {  # vertical framing extent in metres for a 1.75 m subject
    "extreme_wide": 10.0, "wide": 3.6, "full": 2.3, "medium_full": 1.6, "american": 1.6,
    "medium": 1.05, "medium_close": 0.7, "close_up": 0.42, "close": 0.42, "extreme_close_up": 0.2,
}
AIM_Z = {  # aim height as a fraction of subject height
    "extreme_wide": 0.5, "wide": 0.5, "full": 0.52, "medium_full": 0.68, "american": 0.68,
    "medium": 0.78, "medium_close": 0.86, "close_up": 0.92, "close": 0.92, "extreme_close_up": 0.93,
}

res = S.get("resolution") or {}
RW = args.width or int(res.get("width") or 960)
RH = args.height or int(res.get("height") or 540)
aspect = RW / RH


def subject_info(sid):
    if isinstance(sid, str) and sid in CHARS:
        ch = CHARS[sid]
        return ch["root"].location.copy(), ch["height"], ch["root"].rotation_euler.z
    if isinstance(sid, list) and sid:
        pts = [CHARS[x]["root"].location for x in sid if x in CHARS]
        if pts:
            c = sum(pts, Vector((0, 0, 0))) / len(pts)
            return c, max(CHARS[x]["height"] for x in sid if x in CHARS), None
    return Vector((0, 0, 0)), 1.75, None


def framing_pose(C, at_frame):
    """Camera position + aim from a declarative description."""
    scn.frame_set(at_frame)
    subj = C.get("subject")
    if isinstance(subj, str) and subj.startswith("char:"):
        subj = subj[5:]
    base, h, yaw = subject_info(subj)
    size = (C.get("shotSize") or C.get("size") or "medium").lower().replace("-", "_").replace(" ", "_")
    ext = SHOT_SIZES.get(size, 1.05) * (h / 1.75)
    if isinstance(subj, list) and len(subj) > 1:  # two-shot: widen to fit both
        pts = [CHARS[x]["root"].location for x in subj if x in CHARS]
        spread = max((p - q).length for p in pts for q in pts)
        ext = max(ext, spread / aspect * 1.4)
    aim = base + Vector((0, 0, h * AIM_Z.get(size, 0.78)))
    if C.get("target") is not None:
        aim = resolve_point(C["target"], aim)
        if isinstance(C["target"], str) and C["target"] in CHARS:
            aim = char_head(C["target"])
    vfov = 2 * math.atan((36.0 / aspect) / (2 * float(C.get("lens") or 35)))
    dist = (ext / 2) / math.tan(vfov / 2)
    ang = math.radians(float(C.get("angle") or 0))  # 0 frontal, 90 profile (subject's left), 180 back
    face = yaw if yaw is not None else math.pi
    heading = face + ang
    # Direction the subject looks: yaw 0 = +y → (−sin, cos).
    dirv = Vector((-math.sin(heading), math.cos(heading), 0))
    height = (C.get("height") or "eye").lower() if isinstance(C.get("height"), str) else C.get("height")
    pos = aim + dirv * dist
    if isinstance(height, (int, float)):
        pos.z = float(height)
    elif height == "low":
        pos.z = max(0.3, aim.z - dist * 0.35)
    elif height == "high":
        pos.z = aim.z + dist * 0.45
    elif height in ("overhead", "top"):
        pos = aim + Vector((0, 0.01, max(3.0, dist)))
    elif height == "ground":
        pos.z = 0.15
    # Over-the-shoulder: slide behind the shoulder of "ots" character.
    if C.get("ots") and C["ots"] in CHARS:
        o = CHARS[C["ots"]]
        op = o["root"].location
        towards = (aim - op)
        towards.z = 0
        towards.normalize()
        side = Vector((towards.y, -towards.x, 0)) * (0.5 if (C.get("otsSide") or "right") == "right" else -0.5)
        pos = op - towards * 1.5 + side + Vector((0, 0, 1.68 * o["k"]))
    pos = _keep_inside(pos, aim, C)
    # Framing an OBJECT (a prop id / a point) means it is meant to fill the
    # frame — only a character subject gets obstacles cleared.
    tgt = C.get("target")
    if tgt is None or (isinstance(tgt, str) and tgt in CHARS):
        pos = _clear_view(pos, aim, C)
    return pos, aim


FRAMING = {}


def _char_of(ob):
    for cid in CHARS:
        if ob.name.startswith(f"{cid}_") or ob.name == f"char_{cid}":
            return cid
    return None


def _clear_view(pos, aim, C=None):
    """A solved camera must SEE its subject: if a prop / wall sits between the
    aim point and the camera, move the camera in front of the first
    obstacle and widen the lens by the same ratio (framing kept, like a DP
    stepping round a desk). Characters never count — an over-the-shoulder
    foreground is intended."""
    dg = bpy.context.evaluated_depsgraph_get()
    d = pos - aim
    dist = d.length
    if dist < 0.4:
        return pos
    dirv = d.normalized()
    # Start just outside the subject so its own head never blocks the ray.
    start = 0.3
    nearest = None
    origin = aim + dirv * start
    travelled = start
    for _ in range(8):
        hit, loc, _n, _i, ob, _m = scn.ray_cast(dg, origin, dirv, distance=dist - travelled)
        if not hit:
            break
        step = (loc - origin).length
        who = _char_of(ob)
        # A character in front of the subject blocks it too — unless it is
        # the shoulder we shoot over or a foreground the shot asks for.
        allowed = set(((C or {}).get("foreground") or [])) | {(C or {}).get("ots"), (C or {}).get("subject")}
        if who is not None and who in allowed:
            pass
        elif not ob.name.startswith("wall_") and ob.name not in ("floor", "ceiling", "backdrop"):
            nearest = travelled + step
            break
        travelled += step + 0.01
        origin = loc + dirv * 0.01
    if nearest is None:
        return pos
    t = max(0.08, (nearest - 0.15) / dist)
    FRAMING["lens"] = max(12.0, FRAMING.get("lens", 35.0) * t)
    return aim + d * t


def _keep_inside(pos, aim, C):
    """In a room, a solved camera must stay inside the walls. Pull it in
    along the aim line and widen the lens by the same ratio, so the
    framing the author asked for survives (what a DP does in a tight set)."""
    base_lens = float(C.get("lens") or 35)
    FRAMING["lens"] = base_lens
    if set_kind != "room":
        return pos
    m = 0.3
    lo_x, hi_x, lo_y, hi_y = -W / 2 + m, W / 2 - m, -D / 2 + m, D / 2 - m
    d = pos - aim
    t = 1.0
    for comp, lo, hi in ((0, lo_x, hi_x), (1, lo_y, hi_y)):
        a, dv = aim[comp], d[comp]
        if abs(dv) < 1e-6:
            continue
        if aim[comp] + dv * t > hi:
            t = min(t, (hi - a) / dv)
        if aim[comp] + dv * t < lo:
            t = min(t, (lo - a) / dv)
    t = max(0.05, t)
    if t < 0.999:
        pos = aim + d * t
        pos.z = max(0.15, min(H - 0.15, pos.z))
        FRAMING["lens"] = max(12.0, base_lens * t)
    return pos


def _compose(pos, aim, C):
    """frame.at = [x, y] (0..1, y down): put the subject (the aim point) at
    that point of the frame instead of dead centre — thirds, lead room."""
    fr = C.get("frame") or {}
    at = fr.get("at") if isinstance(fr, dict) else None
    if not (isinstance(at, (list, tuple)) and len(at) == 2):
        return aim
    lens_mm = FRAMING.get("lens") or float(C.get("lens") or 35)
    tx = 18.0 / lens_mm
    ty = tx / aspect
    hx = (float(at[0]) - 0.5) * 2 * tx
    vy = (0.5 - float(at[1])) * 2 * ty
    d = aim - pos
    dist = d.length
    if dist < 1e-4:
        return aim
    yaw = math.atan2(d.y, d.x) + math.atan(hx)
    pitch = math.asin(max(-1.0, min(1.0, d.z / dist))) - math.atan(vy)
    f = Vector((math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), math.sin(pitch)))
    return pos + f * dist


def explicit_or_framed(C, at_frame):
    if C.get("position") is not None:
        FRAMING["lens"] = float(C.get("lens") or 35)
        pos = v3(C["position"], 1.6)
        aim = resolve_point(C.get("target"), None)
        if isinstance(C.get("target"), str) and C.get("target") in CHARS:
            aim = char_head(C["target"])
        if aim is None:
            aim = pos + Vector((0, 4, 0))
        return pos, _compose(pos, aim, C)
    pos, aim = framing_pose(C, at_frame)
    return pos, _compose(pos, aim, C)



def build_camera(SHOT):
    """One camera (+ aim target) animated for SHOT's window."""
    cam_d = bpy.data.cameras.new(f"cam_{SHOT['id']}")
    cam = bpy.data.objects.new(f"cam_{SHOT['id']}", cam_d)
    link(cam)
    cam_d.sensor_fit = "HORIZONTAL"
    cam_d.sensor_width = 36.0
    cam_d.clip_start = 0.05
    cam_d.clip_end = 500
    tgt = empty(f"cam_target_{SHOT['id']}")
    trk = cam.constraints.new("TRACK_TO")
    trk.target = tgt
    trk.track_axis = "TRACK_NEGATIVE_Z"
    trk.up_axis = "UP_Y"

    C = SHOT.get("camera") or {}
    lens = float(C.get("lens") or 35)
    cam_d.lens = lens

    s_ms = int(SHOT.get("startMs") or 0)
    e_ms = s_ms + int(SHOT.get("durationMs") or 3000)
    f_s, f_e = ms_to_frame(s_ms), ms_to_frame(e_ms)

    pos0, aim0 = explicit_or_framed(C, f_s)
    if C.get("position") is None and FRAMING.get("lens"):
        lens = FRAMING["lens"]


    # Zoom keyed by hand on the stage: lens keys of their own, apart from
    # the pose keys (which then leave the focal length alone).
    LK = [(ms_to_frame(s_ms + int(x.get("t") or 0)), float(x["mm"])) for x in (C.get("lensKeys") or [])
          if isinstance(x, dict) and isinstance(x.get("mm"), (int, float)) and x["mm"] > 0]

    def place(p, a, lens_mm, frame):
        cam.location = p
        tgt.location = a
        cam.keyframe_insert("location", frame=frame)
        tgt.keyframe_insert("location", frame=frame)
        if not LK:
            cam_d.lens = lens_mm
            cam_d.keyframe_insert("lens", frame=frame)


    # Follow mode re-frames on the subject every few frames (tracking shot).
    move = SHOT.get("move") or C.get("move") or {}
    if isinstance(move, str):
        move = {"type": move}
    mtype = (move.get("type") or "static").lower().replace("-", "_")
    amount = move.get("amount")
    keys = SHOT.get("keyframes") or C.get("keyframes")

    kfocus = []  # (frame, metres): focus pulled by hand on the stage
    if keys:
        # Fully explicit camera path (ms relative to the shot start).
        for kf in keys:
            fr = ms_to_frame(s_ms + int(kf.get("t") or kf.get("ms") or 0))
            p, a = explicit_or_framed({**C, **kf}, fr)
            place(p, a, float(kf.get("lens") or lens), fr)
            if isinstance(kf.get("focus"), (int, float)) and kf["focus"] > 0:
                kfocus.append((fr, float(kf["focus"])))
    elif mtype in ("follow", "track", "tracking"):
        step = max(2, int(FPS / 4))
        fr = f_s
        while fr <= f_e:
            p, a = framing_pose(C, fr)
            place(p, a, FRAMING.get("lens", lens), fr)
            fr += step
        p, a = framing_pose(C, f_e)
        place(p, a, FRAMING.get("lens", lens), f_e)
    else:
        place(pos0, aim0, lens, f_s)
        p1, a1, l1 = pos0.copy(), aim0.copy(), lens
        # Real camera moves have a SPEED, not a destination: "dolly in muy
        # lento" over 3.5 s travels ~25 cm, not a third of the way to the
        # subject. Defaults to "slow"; an explicit "amount" still wins.
        dur_s = max(0.2, (e_ms - s_ms) / 1000.0)
        spd = str(move.get("speed") or "slow").lower().replace("-", "_").replace(" ", "_")
        M_PER_S = {"very_slow": 0.07, "muy_lento": 0.07, "slow": 0.18, "lento": 0.18,
                   "medium": 0.4, "medio": 0.4, "fast": 0.9, "rapido": 0.9, "rápido": 0.9}
        DEG_PER_S = {"very_slow": 2.5, "muy_lento": 2.5, "slow": 6.0, "lento": 6.0,
                     "medium": 14.0, "medio": 14.0, "fast": 30.0, "rapido": 30.0, "rápido": 30.0}
        # ...and a dolly's travel scales with how close we already are: a "slow"
        # push on a medium shot is ~20% of the distance, not 70 cm.
        FRAC = {"very_slow": 0.1, "muy_lento": 0.1, "slow": 0.2, "lento": 0.2,
                "medium": 0.35, "medio": 0.35, "fast": 0.55, "rapido": 0.55, "rápido": 0.55}
        travel = min(M_PER_S.get(spd, 0.18) * dur_s, (aim0 - pos0).length * FRAC.get(spd, 0.2))
        turn = DEG_PER_S.get(spd, 6.0) * dur_s
        fwd = (aim0 - pos0)
        dist = fwd.length
        fwd_n = fwd.normalized()
        right = Vector((fwd_n.y, -fwd_n.x, 0)).normalized()
        if mtype in ("dolly_in", "push_in"):
            p1 = pos0 + fwd_n * (float(amount) if amount else min(travel, dist * 0.6))
        elif mtype in ("dolly_out", "pull_out", "pull_back"):
            p1 = pos0 - fwd_n * (float(amount) if amount else travel)
        elif mtype in ("truck_left", "truck_right"):
            d = float(amount or travel) * (-1 if mtype == "truck_left" else 1)
            p1 , a1 = pos0 + right * d, aim0 + right * d
        elif mtype in ("pan_left", "pan_right", "tilt_up", "tilt_down"):
            ang = math.radians(float(amount or (turn if mtype.startswith("pan") else turn * 0.6)))
            rel = aim0 - pos0
            if mtype.startswith("pan"):
                rel.rotate(Euler((0, 0, ang if mtype == "pan_left" else -ang)))
                a1 = pos0 + rel
            else:
                a1 = aim0 + Vector((0, 0, math.tan(ang) * dist * (1 if mtype == "tilt_up" else -1)))
        elif mtype in ("crane_up", "crane_down", "pedestal_up", "pedestal_down"):
            d = float(amount or travel) * (1 if mtype.endswith("up") else -1)
            p1 = pos0 + Vector((0, 0, d))
            p1.z = max(0.2, p1.z)
        elif mtype in ("orbit_left", "orbit_right", "arc_left", "arc_right"):
            ang = math.radians(float(amount or turn)) * (1 if mtype.endswith("left") else -1)
            rel = pos0 - aim0
            rel.rotate(Euler((0, 0, ang)))
            p1 = aim0 + rel
        elif mtype in ("zoom_in", "zoom_out"):
            zf = float(amount or (1.0 + travel / max(0.5, dist)))
            l1 = lens * (zf if mtype == "zoom_in" else 1 / zf)
        # Never drive into the subject: it may walk towards camera while we
        # dolly in. Keep at least half the opening distance to where it ENDS.
        subj_id = C.get("subject") if isinstance(C.get("subject"), str) else None
        if subj_id in CHARS and mtype in ("dolly_in", "push_in", "truck_left", "truck_right", "crane_up", "crane_down"):
            scn.frame_set(f_s)
            head_start = char_head(subj_id)
            scn.frame_set(f_e)
            head_end = char_head(subj_id)
            # The subject moved during the shot: the aim travels with it.
            a1 = a1 + (head_end - head_start)
            min_d = max(0.6, 0.5 * dist)
            gap = p1 - head_end
            gap.z = 0
            if gap.length < min_d:
                back_dir = (pos0 - head_end)
                back_dir.z = 0
                back_dir = back_dir.normalized() if back_dir.length > 1e-4 else -fwd_n
                p1 = Vector((head_end.x, head_end.y, p1.z)) + back_dir * min_d
            scn.frame_set(f_s)
        if mtype != "static":
            place(p1, a1, l1, f_e)
        if mtype == "handheld" or move.get("handheld"):
            for ob in (cam, tgt):
                if ob.animation_data is None:
                    ob.keyframe_insert("location", frame=f_s)
            try:
                for fc in tgt.animation_data.action.fcurves:
                    mod = fc.modifiers.new("NOISE")
                    mod.scale = 18
                    mod.strength = 0.06
            except Exception:
                pass

    for fr_, mm_ in LK:
        cam_d.lens = mm_
        cam_d.keyframe_insert("lens", frame=fr_)

    # Constant speed like a dolly on rails; "ease": true for a soft start/stop.
    interp = "BEZIER" if (move.get("ease") or keys or mtype in ("follow", "track", "tracking")) else "LINEAR"
    set_key_interp(cam, interp)
    set_key_interp(tgt, interp)
    try:
        set_key_interp(cam_d, interp)
    except Exception:
        pass

    # Depth of field (focus on the subject / target).
    focus = C.get("focus")
    fdist = C.get("focusDistance")
    for fk in C.get("focusKeys") or []:  # focus pulled by hand on the stage
        if isinstance(fk, dict) and isinstance(fk.get("d"), (int, float)) and fk["d"] > 0:
            kfocus.append((ms_to_frame(s_ms + int(fk.get("t") or 0)), float(fk["d"])))
    if C.get("dof") or (move.get("dof")) or focus or fdist or kfocus:
        cam_d.dof.use_dof = True
        cam_d.dof.aperture_fstop = float(C.get("fstop") or 2.0)
        if kfocus:
            # Keyed on the camera's keyframes: a focus pull in metres.
            for fr_, d_ in kfocus:
                cam_d.dof.focus_distance = max(0.1, d_)
                cam_d.dof.keyframe_insert("focus_distance", frame=fr_)
        elif isinstance(fdist, (int, float)) and fdist > 0 and not (isinstance(focus, list) and focus):
            # Set by hand on the stage: a fixed distance in metres.
            cam_d.dof.focus_distance = max(0.1, float(fdist))
        elif isinstance(focus, list) and focus:
            # Rack focus: [{t: ms from shot start, target: char | prop | [x,y,z]}]
            for fk in focus:
                fr_ = ms_to_frame(s_ms + int(fk.get("t") or 0))
                scn.frame_set(fr_)
                tp = fk.get("target")
                pt = char_head(tp) if isinstance(tp, str) and tp in CHARS else resolve_point(tp, None)
                if pt is None:
                    continue
                cam_d.dof.focus_distance = max(0.1, (pt - cam.matrix_world.translation).length)
                cam_d.dof.keyframe_insert("focus_distance", frame=fr_)
        else:
            # "focus" may also name ONE target ("hermana", "basket"): same as focusOn.
            ft = C.get("focusOn") or (focus if isinstance(focus, str) else None)
            if isinstance(ft, str) and ft in CHARS:
                fo = CHARS[ft]["neck"]
            elif isinstance(ft, str) and bpy.data.objects.get(f"prop_{ft}"):
                fo = bpy.data.objects.get(f"prop_{ft}")
            else:
                fo = tgt
            cam_d.dof.focus_object = fo
    return cam


CAMS = {j["shot"]: build_camera(_by_id[j["shot"]]) for j in JOBS}
scn.camera = CAMS[JOBS[0]["shot"]]

# ───────────────────────────────────────────────────────── lighting ──

L = S.get("lighting") or {}
if isinstance(L, str):
    L = {"preset": L}
preset = (L.get("preset") or "day").lower()
PRESETS = {
    #            sun energy, sun colour, elev°, azim°, world colour, world strength
    "day":          (3.5, "#fff4e6", 55, 30, "#a9c0d8", 0.8),
    "overcast":     (1.0, "#e8ecf0", 70, 0, "#c4c9ce", 1.2),
    "golden_hour":  (3.0, "#ffb06a", 12, 60, "#e8b48a", 0.6),
    "sunset":       (2.5, "#ff8a4a", 6, 75, "#d0806a", 0.5),
    "night":        (0.25, "#8aa0d0", 40, -40, "#101828", 0.15),
    "interior_warm": (0.8, "#ffd9a8", 40, 20, "#4a3c30", 0.35),
    "interior_cool": (0.8, "#d8e6ff", 40, 20, "#30384a", 0.35),
    "rembrandt":    (2.5, "#ffe2c0", 40, 45, "#1a1612", 0.08),
    "noir":         (3.0, "#e8e8e8", 25, 80, "#050505", 0.03),
    "studio":       (2.0, "#ffffff", 50, 35, "#808080", 0.6),
}
se, sc, elev, azim, wc, ws = PRESETS.get(preset, PRESETS["day"])
if L.get("azimuth") is not None:
    azim = float(L["azimuth"])
if L.get("elevation") is not None:
    elev = float(L["elevation"])
sun_d = bpy.data.lights.new("sun", "SUN")
sun_d.energy = se * float(L.get("intensity") or 1.0)
sun_d.color = hex_rgba(L.get("color") or sc)[:3]
sun_d.angle = math.radians(2.0 if preset not in ("overcast",) else 25)
sun = bpy.data.objects.new("sun", sun_d)
link(sun)
sun.rotation_euler = Euler((math.radians(90 - elev), 0, math.radians(azim)))

world = bpy.data.worlds.new("world")
scn.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = hex_rgba(L.get("sky") or wc)
bg.inputs["Strength"].default_value = ws
# Daylight = a PHYSICAL sky (Nishita) + the sun at the matching elevation, so
# ambient and key come from the same believable day — not a flat colour.
DAYLIGHT = {"day", "overcast", "golden_hour", "sunset", "studio"}
SKY = None
hdri = L.get("hdri") or SETD.get("hdri")
if preset in DAYLIGHT and not hdri:
    try:
        SKY = world.node_tree.nodes.new("ShaderNodeTexSky")
        SKY.sky_type = "NISHITA"
        SKY.sun_disc = False
        SKY.sun_elevation = math.radians(max(2.0, elev))
        SKY.sun_rotation = math.radians(azim)
        SKY.air_density = 1.0
        SKY.dust_density = 1.5 if preset in ("golden_hour", "sunset") else 0.8
        SKY.ozone_density = 1.0
        world.node_tree.links.new(SKY.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = {"overcast": 0.5, "golden_hour": 0.3, "sunset": 0.25}.get(preset, 0.26)
        sun_d.energy = {"overcast": 0.9, "golden_hour": 3.6, "sunset": 3.0}.get(preset, 5.0) * float(L.get("intensity") or 1.0)
        if preset not in ("golden_hour", "sunset"):
            sun_d.color = hex_rgba("#fff1dc")[:3]  # warm direct sun vs the cool sky fill
        if set_kind == "room":
            # Indoors only a fraction of the sky reaches in (through the
            # windows) — without GI nothing else would block it.
            bg.inputs["Strength"].default_value *= 0.35
            sun_d.energy *= 0.6
        sun_d.angle = math.radians(1.2)
        try:
            sun_d.shadow_filter_radius = 8.0 if preset == "overcast" else 4.0
            sun_d.use_shadow_jitter = False
        except Exception:
            pass
    except Exception as e:
        SKY = None
        print(f"[scene3d] sky: {e}", file=sys.stderr)
if hdri:
    try:
        env = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(hdri, check_existing=True)
        world.node_tree.links.new(env.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = float(L.get("hdriStrength") or 1.0)
    except Exception as e:
        print(f"[scene3d] hdri load failed: {e}", file=sys.stderr)

if preset.startswith("interior") or set_kind == "room":
    # Soft fill from the ceiling so interiors are never pitch black.
    area_d = bpy.data.lights.new("fill", "AREA")
    area_d.energy = 120 * (0.4 if preset in ("night", "noir", "rembrandt") else 1.0)
    area_d.size = max(W, D) * 0.6
    area_d.color = hex_rgba(sc)[:3]
    area_d.use_shadow = False  # fill light: shapes, never a (noisy, huge-area) shadow
    area = bpy.data.objects.new("fill", area_d)
    link(area)
    area.location = (0, 0, H - 0.05)

for i, extra in enumerate(L.get("lights") or []):
    ld = bpy.data.lights.new(f"light{i}", (extra.get("type") or "POINT").upper())
    ld.energy = float(extra.get("energy") or 200)
    ld.color = hex_rgba(extra.get("color") or "#ffffff")[:3]
    lo = bpy.data.objects.new(f"light{i}", ld)
    link(lo)
    lo.location = v3(extra.get("position"), 2.5)
    if extra.get("target") is not None:
        t = resolve_point(extra["target"])
        if t is not None:
            c = lo.constraints.new("TRACK_TO")
            te = empty(f"light{i}_t", t)
            c.target = te
            c.track_axis = "TRACK_NEGATIVE_Z"
            c.up_axis = "UP_Y"

# ─────────────────────────────────────────────────── render settings ──

r = scn.render
r.resolution_x = RW
r.resolution_y = RH
r.resolution_percentage = 100
r.film_transparent = False


def eevee_clean(live=False):
    """EEVEE without stochastic noise: no shadow jitter, no fast-GI / ray-traced
    passes (they need hundreds of accumulated samples, which an always-moving
    viewport never gets), temporal reprojection on, soft shadows by FILTERING.
    Reads as a clean, softly lit 3D scene at real-time rates."""
    e = scn.eevee
    for attr, val in (("use_shadow_jitter_viewport", False), ("use_fast_gi", False), ("use_raytracing", False),
                      ("use_bokeh_jittered", False), ("use_taa_reprojection", True), ("use_shadows", True),
                      ("shadow_ray_count", 1), ("shadow_step_count", 16), ("shadow_resolution_scale", 1.0),
                      ("clamp_surface_indirect", 10.0), ("gi_diffuse_bounces", 2)):
        try:
            setattr(e, attr, val)
        except Exception:
            pass
    try:
        e.taa_samples = 8 if live else 16
        e.taa_render_samples = args.samples or 32
    except Exception:
        pass
    for ld in bpy.data.lights:
        # Small physical penumbra (traced = noisy) + wide FILTER (smooth).
        for attr, val in (("use_shadow_jitter", False),):
            try:
                setattr(ld, attr, val)
            except Exception:
                pass
    # Directional, contrasty light like a lit set: low ambient, a strong key,
    # and the room shell (walls / ceiling) lets the key in instead of
    # throwing the whole interior into one flat shadow.
    try:
        bgn = scn.world.node_tree.nodes.get("Background")
        if bgn and SKY is None:  # a flat-colour world: keep it as a low ambient
            bgn.inputs["Strength"].default_value = min(bgn.inputs["Strength"].default_value, 1.0) * 0.35
    except Exception:
        pass
    for ob in bpy.data.objects:
        if ob.name.startswith("wall_") or ob.name in ("ceiling", "backdrop"):
            try:
                ob.visible_shadow = False
            except Exception:
                pass
    try:
        sun_ob = bpy.data.objects.get("sun")
        if sun_ob:
            sun_ob.data.energy = max(sun_ob.data.energy, 4.5)
            sun_ob.data.angle = min(sun_ob.data.angle, math.radians(1.2))
    except Exception:
        pass
    vt, lk, ex = "AgX", "AgX - Medium High Contrast", (-0.1 if SKY is None else 0.0)
    if args.grade:
        g = (args.grade.split(":") + ["", "", ""])[:3]
        vt, lk, ex = g[0] or vt, g[1] or "None", float(g[2] or 0)
    try:
        scn.view_settings.view_transform = vt
        scn.view_settings.look = lk
        scn.view_settings.exposure = ex
    except Exception as e:
        print(f"[scene3d] grade: {e}", flush=True)


def workbench_studio():
    """The clean "Blender previz" look: Solid/Workbench with studio light,
    specular highlights, cavity edges, soft shadows that the room shell
    (walls / ceiling) does NOT cast, light true colours. Real-time fast."""
    set_engine("BLENDER_WORKBENCH")
    sh = scn.display.shading
    sh.light = "STUDIO"
    try:
        sh.studio_light = "Default"
    except Exception:
        pass
    sh.color_type = "MATERIAL"
    sh.show_backface_culling = True
    sh.show_specular_highlight = True
    sh.show_shadows = True
    sh.shadow_intensity = 0.25
    sh.show_cavity = True
    sh.cavity_type = "BOTH"
    sh.cavity_ridge_factor = 0.9
    sh.cavity_valley_factor = 1.1
    try:
        sh.curvature_ridge_factor = 0.6
        sh.curvature_valley_factor = 0.8
    except Exception:
        pass
    sh.background_type = "VIEWPORT"
    sh.background_color = (0.08, 0.08, 0.09)
    try:
        scn.display.shadow_focus = 0.35
        scn.display.light_direction = Vector((-0.45, -0.55, 0.7)).normalized()
        scn.display.render_aa = "16"
        scn.display.viewport_aa = "8"
    except Exception:
        pass
    # The room shell must not throw the whole interior into shadow.
    for ob in bpy.data.objects:
        if ob.name.startswith("wall_") or ob.name in ("ceiling", "floor", "backdrop"):
            try:
                ob.visible_shadow = False
            except Exception:
                pass
    scn.view_settings.view_transform = "Standard"
    scn.view_settings.look = "None"
    scn.view_settings.exposure = 0.45
    scn.view_settings.gamma = 1.05


def set_engine(name):
    for n in ([name] if name != "EEVEE" else ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"]):
        try:
            r.engine = n
            return n
        except TypeError:
            continue
    return r.engine


def override_material(mat):
    # EEVEE Next ignores ViewLayer.material_override in background renders,
    # so swap every slot explicitly.
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        if not ob.material_slots:
            ob.data.materials.append(None)
        # Object-level links: instanced unit meshes share their mesh data.
        for slot in ob.material_slots:
            slot.link = "OBJECT"
            slot.material = mat


if PASS == "depth":
    # View-space distance → white (near) … black (far), the convention
    # depth-conditioned video models expect.
    set_engine("EEVEE")
    m = bpy.data.materials.new("depth")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emi = nt.nodes.new("ShaderNodeEmission")
    camd = nt.nodes.new("ShaderNodeCameraData")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.3
    mr.inputs["From Max"].default_value = float(S.get("depthFar") or (max(W, D) * 1.15 if set_kind == "room" else 40.0))
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.0
    nt.links.new(camd.outputs["View Z Depth"], mr.inputs["Value"])
    # Undo the sRGB encode so the written grey is linear in depth.
    pw = nt.nodes.new("ShaderNodeMath")
    pw.operation = "POWER"
    pw.inputs[1].default_value = 2.2
    nt.links.new(mr.outputs["Result"], pw.inputs[0])
    nt.links.new(pw.outputs["Value"], emi.inputs["Color"])
    nt.links.new(emi.outputs["Emission"], out.inputs["Surface"])
    m.use_backface_culling = True  # culled walls must stay invisible
    override_material(m)
    try:  # flat emission: one sample is exact and ~50× faster
        scn.eevee.taa_render_samples = 1
        scn.eevee.use_shadows = False
        scn.eevee.use_raytracing = False
    except Exception:
        pass
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    bg.inputs["Strength"].default_value = 0
    scn.view_settings.view_transform = "Standard"
elif PASS == "mask":
    # Flat ID colours: each character its own primary, everything else black.
    set_engine("BLENDER_WORKBENCH")
    sh = scn.display.shading
    sh.light = "FLAT"
    sh.show_backface_culling = True
    sh.color_type = "OBJECT"
    sh.background_type = "VIEWPORT"
    sh.background_color = (0, 0, 0)
    for ob in bpy.data.objects:
        if ob.type == "MESH":
            ob.color = (0, 0, 0, 1)
    for ch in CHARS.values():
        col = hex_rgba(ch["mask"])
        for ob in bpy.data.objects:
            if ob.type == "MESH" and ob.name.startswith(f"{ch['id']}_"):
                ob.color = col
    scn.view_settings.view_transform = "Standard"
elif STYLE == "sketch":
    # Pencil-sketch look matching the storyboard panels: paper-white
    # surfaces + Freestyle ink lines.
    set_engine("BLENDER_WORKBENCH")
    sh = scn.display.shading
    sh.light = "STUDIO"
    sh.show_backface_culling = True
    sh.color_type = "SINGLE"
    sh.single_color = (0.93, 0.92, 0.89)
    sh.show_shadows = True
    sh.shadow_intensity = 0.35
    sh.show_cavity = True
    sh.background_type = "VIEWPORT"
    sh.background_color = (0.96, 0.95, 0.92)
    r.use_freestyle = True
    r.line_thickness_mode = "ABSOLUTE"
    r.line_thickness = 1.3
    fs = scn.view_layers[0].freestyle_settings
    lset = fs.linesets[0] if len(fs.linesets) else fs.linesets.new("ink")
    if lset.linestyle is None:
        lset.linestyle = bpy.data.linestyles.new("ink")
    lset.linestyle.color = (0.18, 0.17, 0.16)
    lset.linestyle.thickness = 1.3
    lset.select_by_visibility = True
    lset.select_silhouette = True
    lset.select_border = True
    lset.select_crease = True
    scn.view_settings.view_transform = "Standard"
elif STYLE == "lit":
    set_engine("EEVEE")
    eevee_clean(live=bool(args.live))  # samples come from --samples (cards use few: no noise left to average)
else:  # clay = Blender's Solid viewport look, tuned (fast + clean)
    workbench_studio()

# ───────────────────────────────────────────────────────────── output ──

if args.live:
    import socket
    import struct
    import time
    import gpu

    LIVE = {"w": 960, "h": 540, "shot": JOBS[0]["shot"], "ms": 0.0, "playing": True, "seq": False,
            "free": None, "clients": [], "buf": {}, "last": time.time(), "frames": 0, "t0": time.time(),
            "state_at": 0.0,
            # STAGE: the whole set seen from a free orbit camera, every shot
            # camera drawn where it is; the GUI drives the scene clock.
            "stage": False, "stage_view": None, "stage_ms": 0.0, "stage_shot": None,
            "paths": {}, "proj_at": 0.0,
            # FOLLOW clients (the timeline preview): each one sees ONE shot
            # camera at the scene time it sends, at its own size — the shot
            # interpreted live instead of a pre-rendered video.
            "views": {}, "clock": None, "surf": {}}
    import ctypes
    _SURF = None
    if args.surface_lib:
        try:
            _SURF = ctypes.CDLL(args.surface_lib)
            _SURF.bls_create.restype = ctypes.c_void_p
            _SURF.bls_create.argtypes = [ctypes.c_int, ctypes.c_int]
            _SURF.bls_id.restype = ctypes.c_uint32
            _SURF.bls_id.argtypes = [ctypes.c_void_p]
            _SURF.bls_write_rgba.restype = ctypes.c_int
            _SURF.bls_write_rgba.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
            _SURF.bls_release.argtypes = [ctypes.c_void_p]
        except Exception as e:
            print(f"[scene3d] live surface: {e}", flush=True)
            _SURF = None
    ORDER = [j["shot"] for j in JOBS]
    from gpu_extras.batch import batch_for_shader

    def _stage_home():
        """The stage's opening view: framed on the ACTION, not the whole set
        (an exterior set is tens of metres — framing it left everything
        tiny). Holds the CAST (characters with a sheet; extras crossing the
        street would blow the frame up) around the playhead, seen 3/4 from the
        side, across the axis the action spreads along, as close as fits."""
        cast = [c.get("id") for c in S.get("characters") or [] if c.get("characterId") and c.get("id") in CHARS]
        who = cast or list(CHARS)
        pts = []
        keep = scn.frame_current
        # Around NOW (the playhead), not the whole scene: a cast walking
        # down a street covers tens of metres over the scene.
        now_ms = float(LIVE.get("stage_ms") or 0)
        for k in range(5):
            scn.frame_set(ms_to_frame(min(max(0.0, now_ms - 1500 + 750 * k), float(DUR_MS))))
            for cid in who:
                root = CHARS[cid]["root"].matrix_world.translation
                hgt = float(CHARS[cid].get("height") or 1.7)
                pts += [root.copy(), root + Vector((0, 0, hgt))]
        scn.frame_set(keep)
        if not pts:
            pts = [Vector((-3, -3, 0)), Vector((3, 3, 1.8))]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        c = (lo + hi) / 2
        # Look across the long axis (its whole length faces the lens), from
        # 35 deg off square and 38 deg up: a 3/4 view, depth readable.
        side = Vector((0.0, -1.0, 0.0)) if hi.x - lo.x >= hi.y - lo.y else Vector((-1.0, 0.0, 0.0))
        a = math.radians(35)
        rot = Vector((side.x * math.cos(a) - side.y * math.sin(a), side.x * math.sin(a) + side.y * math.cos(a), 0))
        el = math.radians(38)
        d = Vector((rot.x * math.cos(el), rot.y * math.cos(el), math.sin(el))).normalized()
        right = d.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(d).normalized()
        lens = 24.0
        tan_h = 18.0 / lens               # 36 mm sensor, horizontal
        tan_v = tan_h * 0.7               # the panel is about 10:7
        # Distance at which every point fits, measured in the view itself
        # (a point nearer the lens needs more room than the centre).
        dist = 3.0
        for p in pts:
            q = p - c
            along = q.dot(d)
            dist = max(dist, abs(q.dot(right)) / tan_h + along, abs(q.dot(up)) / tan_v + along)
        dist = dist * 1.25 + 0.8          # a little air around the cast
        return c + d * dist, c, lens

    def _stage_boxes():
        """World bounds of every set mesh (cached: the set does not move)."""
        if "boxes" in LIVE:
            return LIVE["boxes"]
        out = []
        for ob in scn.objects:
            if ob.type != "MESH" or ob.name in ("floor",) or any(ob.name.startswith(f"{cid}_") for cid in CHARS):
                continue
            vs = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
            lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
            hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
            out.append((ob, lo, hi))
        LIVE["boxes"] = out
        return out

    def _stage_cutaway(on):
        """Dollhouse cut: hide the walls between the stage camera and the set
        and whatever roofs it from above (awnings, ceilings) — never in a shot."""
        if on and LIVE.get("cut_want") is not None and not LIVE.get("cut_dirty"):
            _apply_cut(LIVE["cut_want"])
            return
        LIVE.pop("cut_dirty", None)
        want = set()
        if on and LIVE["stage_view"]:
            pos, tgt = LIVE["stage_view"]["pos"], LIVE["stage_view"]["tgt"]
            for ob, lo, hi in _stage_boxes():
                d = hi - lo
                c = (lo + hi) / 2
                thin_x, thin_y = d.x <= 1.2 and d.y >= 3.0, d.y <= 1.2 and d.x >= 3.0
                if d.z >= 2.2 and (thin_x or thin_y):  # a wall / facade slab
                    if thin_x and (pos.x - c.x) * (c.x - tgt.x) > 0 and abs(pos.x - tgt.x) > 0.5:
                        want.add(ob.name)
                    if thin_y and (pos.y - c.y) * (c.y - tgt.y) > 0 and abs(pos.y - tgt.y) > 0.5:
                        want.add(ob.name)
                elif lo.z >= 2.0 and d.z <= 0.6 and max(d.x, d.y) >= 1.5 and pos.z > hi.z:  # a roof
                    want.add(ob.name)
        if on:
            LIVE["cut_want"] = want
        _apply_cut(want)

    def _stage_layer():
        """The stage draws through its OWN view layer: the dollhouse cut hides
        walls there only, so the shot views (main layer) never lose them and
        both can draw every frame without toggling visibility."""
        vl = scn.view_layers.get("stage")
        if vl is None:
            vl = scn.view_layers.new("stage")
        return vl

    def _apply_cut(want):
        hidden = LIVE.setdefault("cut", set())
        vl = _stage_layer()
        for name in hidden - want:
            ob = scn.objects.get(name)
            if ob:
                ob.hide_set(False, view_layer=vl)
        for name in want - hidden:
            ob = scn.objects.get(name)
            if ob:
                ob.hide_set(True, view_layer=vl)
        LIVE["cut"] = want

    def _cam_path(sid):
        """The shot camera's positions over its own window (drawn as a path)."""
        if sid in LIVE["paths"]:
            return LIVE["paths"][sid]
        sh = _by_id[sid]
        cam = CAMS[sid]
        f0 = ms_to_frame(int(sh.get("startMs") or 0))
        f1 = ms_to_frame(int(sh.get("startMs") or 0) + int(sh.get("durationMs") or 3000))
        keep = scn.frame_current
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        pts, aims = [], []
        for fr in list(range(f0, f1 + 1, max(1, FPS // 8))) + [f1]:
            scn.frame_set(fr)
            pts.append(cam.matrix_world.translation.copy())
            if tob is not None:
                aims.append(tob.matrix_world.translation.copy())
        scn.frame_set(keep)
        moved = max((p - pts[0]).length for p in pts) > 0.05
        LIVE["paths"][sid] = pts if moved else []
        # Where it looks over the shot: drawn too, so a pan reads as a path.
        LIVE.setdefault("aim_paths", {})[sid] = aims if aims and max((a - aims[0]).length for a in aims) > 0.05 else []
        return LIVE["paths"][sid]

    def _shot_at(ms):
        hits = [sid for sid in ORDER
                if int(_by_id[sid].get("startMs") or 0) <= ms < int(_by_id[sid].get("startMs") or 0) + int(_by_id[sid].get("durationMs") or 3000)]
        return hits

    _POLY = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")

    def _hull2d(pts):
        """Convex hull of 2D points (monotone chain), counter-clockwise."""
        pts = sorted(set(pts))
        if len(pts) < 3:
            return pts
        cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        lo, hi = [], []
        for p_ in pts:
            while len(lo) >= 2 and cross(lo[-2], lo[-1], p_) <= 0:
                lo.pop()
            lo.append(p_)
        for p_ in reversed(pts):
            while len(hi) >= 2 and cross(hi[-2], hi[-1], p_) <= 0:
                hi.pop()
            hi.append(p_)
        return lo[:-1] + hi[:-1]

    def _lines(coords, color, width, w, h):
        if not coords:
            return
        _POLY.bind()
        _POLY.uniform_float("viewportSize", (w, h))
        _POLY.uniform_float("lineWidth", width * LIVE.get("px", 1.0))  # stage drawn at screen pixels
        _POLY.uniform_float("color", color)
        batch_for_shader(_POLY, "LINES", {"pos": coords}).draw(_POLY)

    def _draw_cams(view, proj, w, h):
        """The active shot camera only, as an amber frustum (+ its move as a
        path); the other cameras stay hidden."""
        active = LIVE["stage_shot"]
        gpu.state.depth_test_set("NONE")
        gpu.state.blend_set("ALPHA")
        with gpu.matrix.push_pop():
            gpu.matrix.load_matrix(view)
            with gpu.matrix.push_pop_projection():
                gpu.matrix.load_projection_matrix(proj)
                for sid in ORDER:
                    if sid != active:
                        continue
                    cam = CAMS[sid]
                    mw = cam.matrix_world
                    sc_ = 0.55 / max(cam.data.display_size, 1e-3)
                    fr = [mw @ (v * sc_) for v in cam.data.view_frame(scene=scn)]
                    apex = mw.translation
                    seg = []
                    for i in range(4):
                        seg += [apex, fr[i], fr[i], fr[(i + 1) % 4]]
                    _lines(seg, (1.0, 0.62, 0.25, 1.0), 2.4, w, h)
                    cd_ = cam.data
                    if cd_.dof.use_dof:
                        # Where it is in focus: the frame at the focus distance,
                        # in grey (the camera's own frame stays amber).
                        fo = cd_.dof.focus_object
                        if fo is not None:
                            fwd = -(mw.to_3x3() @ Vector((0, 0, 1)))
                            fd = (fo.matrix_world.translation - apex).dot(fwd)
                        else:
                            fd = float(cd_.dof.focus_distance)
                        fd = max(0.1, min(60.0, fd))
                        loc = [v * (fd / max(1e-4, -v.z)) for v in cd_.view_frame(scene=scn)]
                        fp = [mw @ v for v in loc]
                        segf = []
                        for i in range(4):
                            segf += [fp[i], fp[(i + 1) % 4]]
                        _lines(segf, (0.78, 0.78, 0.76, 0.85), 1.6, w, h)
                    pts = LIVE["paths"].get(sid) or []
                    segp = []
                    for a, b in zip(pts, pts[1:]):
                        segp += [a, b]
                    _lines(segp, (1.0, 0.62, 0.25, 0.7), 1.4, w, h)
                    aims = LIVE.get("aim_paths", {}).get(sid) or []
                    sega = []
                    for a, b in zip(aims, aims[1:]):
                        sega += [a, b]
                    _lines(sega, (0.92, 0.92, 0.9, 0.55), 1.2, w, h)
                    tob = bpy.data.objects.get(f"cam_target_{sid}")
                    if tob is not None:  # the line of sight, now
                        _lines([apex, tob.matrix_world.translation.copy()], (1.0, 0.62, 0.25, 0.35), 1.0, w, h)
        gpu.state.blend_set("NONE")

    def _stage_proj(view, proj):
        """Where the active camera sits on the stage image (for its label)."""
        m = proj @ view
        out = []
        for sid in ORDER:
            if sid != LIVE["stage_shot"]:
                continue
            cam = CAMS[sid]
            p = cam.matrix_world.translation
            q = m @ Vector((p.x, p.y, p.z, 1.0))
            if q.w <= 1e-4:
                continue
            # The drawn frustum (apex + frame corners) on screen, so a click
            # anywhere on the camera picks it, not only on its label.
            mw = cam.matrix_world
            sc_ = 0.55 / max(cam.data.display_size, 1e-3)
            poly = []
            for v in [p] + [mw @ (c * sc_) for c in cam.data.view_frame(scene=scn)]:
                qq = m @ Vector((v.x, v.y, v.z, 1.0))
                if qq.w > 1e-4:
                    poly += [round((qq.x / qq.w + 1) / 2, 4), round((1 - qq.y / qq.w) / 2, 4)]
            out.append({"shot": sid, "x": (q.x / q.w + 1) / 2, "y": (1 - q.y / q.w) / 2, "frustum": poly})
        return out

    def _send_json(obj, only=None):
        data = json.dumps(obj).encode()
        head = struct.pack("<4sIII", b"BRXJ", 0, 0, len(data))
        for conn in ([only] if only else list(LIVE["clients"])):
            try:
                conn.setblocking(True)
                conn.sendall(head + data)
                conn.setblocking(False)
            except Exception:
                if conn in LIVE["clients"]:
                    LIVE["clients"].remove(conn)

    def _seq_locate(t):
        """Scene mode: absolute sequence time → (shot id, ms inside it)."""
        acc = 0.0
        for sid in ORDER:
            d = int(_by_id[sid].get("durationMs") or 3000)
            if t < acc + d:
                return sid, t - acc
            acc += d
        last = ORDER[-1]
        return last, float(int(_by_id[last].get("durationMs") or 3000))

    def _seq_total():
        return float(sum(int(_by_id[sid].get("durationMs") or 3000) for sid in ORDER))

    def _active():
        """Current (shot id, ms inside the shot)."""
        return _seq_locate(LIVE["ms"]) if LIVE["seq"] else (LIVE["shot"], LIVE["ms"])

    def _cam_now():
        sid, _ms = _active()
        f = LIVE["stage_view"] if LIVE["stage"] else LIVE["free"]
        if f:
            return f["pos"], f["tgt"], f["lens"]
        cam = CAMS[sid]
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        return cam.matrix_world.translation.copy(), (tob.matrix_world.translation.copy() if tob else Vector((0, 4, 1))), cam.data.lens
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", args.live))
    srv.listen(4)
    srv.setblocking(False)
    offscreen = {}  # (w, h) → GPUOffScreen, one per size in use

    def _view3d():
        for win in bpy.context.window_manager.windows:
            for area in win.screen.areas:
                if area.type == "VIEW_3D":
                    for reg in area.regions:
                        if reg.type == "WINDOW":
                            return area.spaces.active, reg
        return None, None

    # ── camera editing from the stage (live) ───────────────────────────
    # Every edit lands on a KEYFRAME of the shot camera at the scene time it
    # is made: a key already there is changed, otherwise one is inserted
    # from the camera as it is at that moment — so changing anything at
    # another time animates the camera. A shot without explicit keyframes
    # is first baked into them from its built move (same path on screen).
    def _anim_curves(obj):
        ad = obj.animation_data
        if not ad or not ad.action:
            return []
        act = ad.action
        layers = getattr(act, "layers", None)
        if not layers:
            return list(act.fcurves)
        # Blender 5 layered actions: the camera object and its data (lens,
        # focus) can share ONE action in separate slots — read this ID's slot
        # only (the legacy "fcurves" gives the first slot, i.e. the object's).
        slot = getattr(ad, "action_slot", None)
        out = []
        for layer in layers:
            for strip in layer.strips:
                if slot is not None:
                    try:
                        bag = strip.channelbag(slot)
                    except Exception:
                        bag = None
                    if bag is not None:
                        out.extend(bag.fcurves)
                else:
                    for bag in strip.channelbags:
                        out.extend(bag.fcurves)
        return out

    def _cam_pose_at(sid, frame):
        keep = scn.frame_current
        scn.frame_set(int(frame))
        cam = CAMS[sid]
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        pose = (cam.matrix_world.translation.copy(),
                tob.matrix_world.translation.copy() if tob else cam.matrix_world.translation + Vector((0, 4, 0)),
                float(cam.data.lens))
        scn.frame_set(keep)
        return pose

    def _frame_ms(frame):
        return (frame - 1) * 1000.0 / FPS

    def _shot_keys(sid):
        """The shot camera as explicit keyframes [{t, position, target, lens}]
        (t = ms from the shot start)."""
        sh = _by_id[sid]
        keys = sh.get("keyframes") or (sh.get("camera") or {}).get("keyframes")
        s_ms = int(sh.get("startMs") or 0)
        if keys and all(isinstance(k.get("position"), (list, tuple)) and isinstance(k.get("target"), (list, tuple))
                        for k in keys):
            return [{"t": int(k.get("t") or k.get("ms") or 0), "position": list(k["position"]),
                     "target": list(k["target"]), "lens": float(k.get("lens") or (sh.get("camera") or {}).get("lens") or 35),
                     **({"focus": float(k["focus"])} if isinstance(k.get("focus"), (int, float)) else {})}
                    for k in keys]
        frames = set()
        for fc in _anim_curves(CAMS[sid]):
            if fc.data_path == "location":
                frames.update(int(round(kp.co[0])) for kp in fc.keyframe_points)
        if not frames:
            frames = {ms_to_frame(s_ms)}
        out = []
        for fr in sorted(frames):
            p, a, ln = _cam_pose_at(sid, fr)
            out.append({"t": int(round(_frame_ms(fr) - s_ms)), "position": [round(v, 4) for v in p],
                        "target": [round(v, 4) for v in a], "lens": round(ln, 2)})
        return out

    def _rebuild_cam(sid):
        for name in (f"cam_{sid}", f"cam_target_{sid}"):
            ob = bpy.data.objects.get(name)
            if ob is not None:
                data = ob.data
                bpy.data.objects.remove(ob, do_unlink=True)
                if data is not None and data.users == 0:
                    bpy.data.cameras.remove(data)
        was_scene_cam = scn.camera is None
        CAMS[sid] = build_camera(_by_id[sid])
        LIVE.setdefault("fcurves", {}).pop(sid, None)
        if was_scene_cam:
            scn.camera = CAMS[sid]
        LIVE["paths"].pop(sid, None)
        LIVE["stage_stale"] = True  # re-evaluate the frame with the new camera

    def _screen_ray(x, y):
        """Ray from the stage camera through (x, y) of its image (0..1, y down)
        → (origin, direction, tan of half the vertical view)."""
        f = LIVE["stage_view"]
        pos, tgt, ln = f["pos"], f["tgt"], f["lens"]
        fwd = (tgt - pos).normalized()
        right = fwd.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(fwd).normalized()
        half_w = 18.0 / ln
        half_h = half_w * LIVE["h"] / LIVE["w"]
        sx, sy = (x * 2 - 1), (1 - y * 2)
        if f.get("ortho"):  # parallel rays from the image plane
            dist = (tgt - pos).length
            return pos + right * (sx * half_w * dist) + up * (sy * half_h * dist), fwd, half_h
        d = (fwd + right * (sx * half_w) + up * (sy * half_h)).normalized()
        return pos, d, half_h

    def _drag_delta(point, drag, vertical):
        """World motion of POINT dragged on screen from (x0, y0) to (x1, y1):
        on the horizontal plane through it, or straight up / down."""
        o, d0, half_h = _screen_ray(drag[0], drag[1])
        _o, d1, _h = _screen_ray(drag[2], drag[3])
        if vertical:
            dist = (point - o).length
            return Vector((0, 0, (drag[1] - drag[3]) * 2 * half_h * dist))
        hits = []
        for d in (d0, d1):
            if abs(d.z) < 1e-4:
                return Vector((0, 0, 0))
            t = (point.z - o.z) / d.z
            if t <= 0:
                return Vector((0, 0, 0))
            hits.append(o + d * t)
        out = hits[1] - hits[0]
        # A grazing view would fling the point to the horizon.
        lim = max(0.5, (point - o).length * 0.5)
        return out if out.length <= lim else out.normalized() * lim

    def _cam_state(sid):
        sh = _by_id[sid]
        cp = lambda v: json.loads(json.dumps(v)) if v is not None else None
        return {"shot": sid, "keyframes": cp(sh.get("keyframes")), "move": cp(sh.get("move")), "camera": cp(sh.get("camera"))}

    # Camera settings the stage edits besides the keyframes (saved with them).
    CAM_FIELDS = ("dof", "fstop", "focusDistance", "focusOn", "focus", "focusKeys", "lensKeys", "lensKit")

    def _cam_edit(c, conn):
        sid = c.get("shot")
        if sid not in _by_id or not LIVE["stage_view"]:
            return False
        sh = _by_id[sid]
        op = c.get("op")
        if op == "focus" and c.get("key"):
            op = "focus_key"  # the focus distance keyed at the playhead
        if op == "focus" and c.get("unkey"):
            op = "focus_unkey"  # that focus key removed
        if op == "lens":
            op, c = "lane", {**c, "lane": "lens", "act": "key", "value": c.get("lens")}
        elif op in ("focus_key", "focus_unkey"):
            op, c = "lane", {**c, "lane": "focus", "act": "key" if op == "focus_key" else "unkey",
                             "value": c.get("distance")}
        if op == "lane":
            # Zoom and focus keys live apart from the camera's pose keys, each
            # on its lane: keyed at the playhead, slid in time, removed —
            # nothing else moves.
            lane = c.get("lane")
            fld = {"lens": ("lensKeys", "mm"), "focus": ("focusKeys", "d")}.get(lane)
            if not fld:
                return False
            lk, vk = fld
            cam_c = dict(sh.get("camera") or {})
            s0, dur0 = int(sh.get("startMs") or 0), int(sh.get("durationMs") or 3000)
            half_ = 500.0 / FPS
            relof = lambda ms_: int(round(max(0.0, min(float(dur0), float(ms_) - s0))))
            ks = [dict(x) for x in cam_c.get(lk) or [] if isinstance(x, dict)]
            if not ks:
                # First touch: keep what the shot had (the zoom on its pose keys;
                # a rack focus from the script, a character it follows) as keys,
                # or the edit would replace it wholesale.
                ks = _lane_bake(sid, lane)
            act = c.get("act")
            rel = relof(c.get("ms", c.get("t", s0)))
            if act == "key":
                v = float(c.get("value") or 0)
                if lane == "lens":
                    kit = cam_c.get("lensKit") if isinstance(cam_c.get("lensKit"), dict) else None
                    lo, hi = (float(kit.get("min") or 8), float(kit.get("max") or 300)) if kit else (8.0, 300.0)
                    v = round(max(lo, min(hi, v or 35.0)), 2)
                else:
                    v = round(max(0.1, min(500.0, v or 3.0)), 3)
                    cam_c["dof"] = True
                    cam_c.setdefault("fstop", 2.8)
                    for f_ in ("focusDistance", "focusOn", "focus"):
                        cam_c.pop(f_, None)
                ks = [x for x in ks if abs(int(x.get("t") or 0) - rel) > half_] + [{"t": rel, vk: v}]
            elif act == "unkey":
                near = [x for x in ks if abs(int(x.get("t") or 0) - rel) <= half_ + 1]
                if not near or (lane == "lens" and len(ks) <= 1):
                    return False
                ks.remove(near[0])
            elif act == "retime":
                to = relof(c.get("to", s0))
                near = [x for x in ks if abs(int(x.get("t") or 0) - rel) <= half_ + 1]
                if not near or any(x is not near[0] and abs(int(x.get("t") or 0) - to) <= half_ for x in ks):
                    return False
                near[0]["t"] = to
            else:
                return False
            ks.sort(key=lambda x: int(x.get("t") or 0))
            if ks:
                cam_c[lk] = ks
            else:
                cam_c.pop(lk, None)
            sh["camera"] = cam_c
            _rebuild_cam(sid)
            _send_json({"type": "cam_edited", "shot": sid, "op": "focus", "keyframes": sh.get("keyframes"),
                        "camera": {f_: cam_c.get(f_) for f_ in CAM_FIELDS}}, only=conn)
            return True
        if op == "focus":  # depth of field: aperture / focus distance, whole shot
            cam_c = dict(sh.get("camera") or {})
            if c.get("off"):
                for f_ in ("dof", "fstop", "focusDistance", "focusOn", "focus", "focusKeys"):
                    cam_c.pop(f_, None)
            else:
                cam_c["dof"] = True
                if c.get("fstop") is not None:
                    cam_c["fstop"] = round(max(0.7, min(32.0, float(c["fstop"]))), 2)
                if c.get("distance") is not None:
                    cam_c["focusDistance"] = round(max(0.1, min(500.0, float(c["distance"]))), 3)
                    cam_c.pop("focusOn", None)
                    cam_c.pop("focus", None)
            sh["camera"] = cam_c
            _rebuild_cam(sid)
            _send_json({"type": "cam_edited", "shot": sid, "op": "focus", "keyframes": sh.get("keyframes"),
                        "camera": {f_: cam_c.get(f_) for f_ in CAM_FIELDS}},
                       only=conn)
            return True
        s_ms = int(sh.get("startMs") or 0)
        dur = int(sh.get("durationMs") or 3000)
        keys = _shot_keys(sid)
        half = 500.0 / FPS
        cam_c = dict(sh.get("camera") or {})
        kit = cam_c.get("lensKit") if isinstance(cam_c.get("lensKit"), dict) else None
        def fit(mm):  # a focal length the shot's lens can reach
            lo, hi = (float(kit.get("min") or 8), float(kit.get("max") or 300)) if kit else (8.0, 300.0)
            return max(lo, min(hi, float(mm)))
        if op == "kit":
            # The lens on the camera (objetivo) is one for the whole shot: a
            # prime fixes the focal length, a zoom bounds it.
            k_ = c.get("kit")
            if isinstance(k_, dict) and k_.get("min"):
                kit = {"name": str(k_.get("name") or ""), "min": float(k_["min"]), "max": float(k_.get("max") or k_["min"])}
                cam_c["lensKit"] = kit
            else:
                kit = None
                cam_c.pop("lensKit", None)
            for k_ in keys:
                k_["lens"] = round(fit(k_["lens"]), 2)
            if isinstance(cam_c.get("lensKeys"), list):
                cam_c["lensKeys"] = [{**x, "mm": round(fit(x.get("mm") or 35), 2)} for x in cam_c["lensKeys"]
                                     if isinstance(x, dict)]
            i = None
        elif op in ("move", "aim", "pose", "rotate"):
            rel = max(0.0, min(float(dur), float(c.get("ms", s_ms)) - s_ms))
            i = next((j for j, k in enumerate(keys) if abs(k["t"] - rel) <= half), None)
            if i is None:
                p, a, ln = _cam_pose_at(sid, ms_to_frame(s_ms + rel))
                keys.append({"t": int(round(rel)), "position": list(p), "target": list(a), "lens": ln})
                keys.sort(key=lambda k: k["t"])
                i = next(j for j, k in enumerate(keys) if k["t"] == int(round(rel)))
        else:
            i = int(c.get("index", -1))
            if not 0 <= i < len(keys):
                return False
        if op == "retime":  # a keyframe slid along the shot
            t_ = int(round(max(0.0, min(float(dur), float(c.get("t") or 0)))))
            if any(j != i and abs(k_["t"] - t_) <= half for j, k_ in enumerate(keys)):
                return False
            keys[i]["t"] = t_
            keys.sort(key=lambda k_: k_["t"])
            i = None
        k = keys[i] if i is not None else None
        P, A = (Vector(k["position"]), Vector(k["target"])) if k else (None, None)
        def motion(pt):
            if c.get("delta") is not None:  # along a gizmo axis, world metres
                return Vector([float(v) for v in c["delta"]][:3])
            return _drag_delta(pt, c.get("drag") or [0, 0, 0, 0], bool(c.get("vertical")))
        if op in ("move", "key"):
            dv = motion(P)
            P = P + dv
            if c.get("truck"):  # the aim travels with the camera
                A = A + dv
            P.z = max(0.05, P.z)
        elif op in ("aim", "akey"):
            A = A + motion(A)
        elif op in ("rotate", "krotate"):
            # Turn the camera about an axis through it: its aim swings round.
            ax = Vector([float(v) for v in (c.get("axis") or [0, 0, 1])][:3])
            if ax.length > 1e-6:
                A = P + Matrix.Rotation(float(c.get("angle") or 0.0), 3, ax.normalized()) @ (A - P)
        elif op == "pose":  # the stage's own view becomes the camera here
            f = LIVE["stage_view"]
            P, A = f["pos"].copy(), f["tgt"].copy()
            k["lens"] = fit(c.get("lens") or f["lens"])
        elif op == "delete_key":
            if len(keys) > 1:
                keys.pop(i)
        if k is not None and op != "delete_key":
            k["position"] = [round(v, 4) for v in P]
            k["target"] = [round(v, 4) for v in A]
        sh["keyframes"] = keys
        sh.pop("move", None)
        cam_c.pop("frame", None)  # baked aims are already composed
        cam_c.pop("keyframes", None)
        cam_c.pop("move", None)
        sh["camera"] = cam_c
        _rebuild_cam(sid)
        _send_json({"type": "cam_edited", "shot": sid, "keyframes": keys,
                    "camera": {f_: cam_c.get(f_) for f_ in CAM_FIELDS}}, only=conn)
        return True

    def _lane_bake(sid, lane):
        """The zoom / focus a shot has now, as keys of its lane [{t, mm|d}]."""
        sh = _by_id[sid]
        s0 = int(sh.get("startMs") or 0)
        if lane == "lens":
            return _runs([{"t": k["t"], "mm": round(float(k["lens"]), 2)} for k in _shot_keys(sid)], "mm")
        fc_ = _focus_curve(sid)
        times = [m_ - s0 for m_ in fc_["keys"]] or (
            [p_[0] - s0 for p_ in fc_["pts"]] if CAMS[sid].data.dof.focus_object is not None else [])
        out = []
        for t_ in times:
            d_ = _focus_at(sid, s0 + t_)
            if d_ is not None:
                out.append({"t": int(t_), "d": round(d_, 3)})
        return _runs(out, "d")

    def _runs(ks, vk):
        """Keys without repeats: a held value keeps only where it starts and,
        when it changes after, where it ends (the hold before a change)."""
        out = []
        for j, k_ in enumerate(ks):
            prev = ks[j - 1][vk] if j else None
            nxt = ks[j + 1][vk] if j + 1 < len(ks) else None
            same = lambda a_, b_: a_ is not None and b_ is not None and abs(a_ - b_) < 1e-3
            if j == 0 or not same(prev, k_[vk]) or (nxt is not None and not same(nxt, k_[vk])):
                out.append(k_)
        return out

    def _focus_at(sid, ms):
        """Focus distance of the shot camera at scene time MS (None: no DOF)."""
        cam = CAMS[sid]
        cd = cam.data
        if not cd.dof.use_dof:
            return None
        keep = scn.frame_current
        scn.frame_set(ms_to_frame(ms))
        fo = cd.dof.focus_object
        if fo is not None:
            fwd = -(cam.matrix_world.to_3x3() @ Vector((0, 0, 1)))
            d = (fo.matrix_world.translation - cam.matrix_world.translation).dot(fwd)
        else:
            d = float(cd.dof.focus_distance)
        scn.frame_set(keep)
        return max(0.1, d)

    def _focus_curve(sid):
        """The focus distance over the shot, for the stage's lane: points
        [ms, metres] and the moments it is keyed (rack focus from the script
        or pulled by hand). Cached until the camera is rebuilt."""
        cache = LIVE.setdefault("fcurves", {})
        if sid in cache:
            return cache[sid]
        cam = CAMS[sid]
        cd = cam.data
        sh = _by_id[sid]
        s_ms = int(sh.get("startMs") or 0)
        dur = int(sh.get("durationMs") or 3000)
        out = {"pts": [], "keys": []}
        if cd.dof.use_dof:
            fr_of = lambda ms: 1 + ms * FPS / 1000.0
            fc = next((f for f in _anim_curves(cd) if f.data_path == "dof.focus_distance"), None)
            if fc is not None:
                for i in range(25):
                    ms = s_ms + dur * i / 24.0
                    out["pts"].append([int(ms), round(max(0.1, fc.evaluate(fr_of(ms))), 3)])
                for kp in fc.keyframe_points:
                    ms = _frame_ms(kp.co[0])
                    if s_ms - 1 <= ms <= s_ms + dur + 1:
                        out["keys"].append(int(round(ms)))
            elif cd.dof.focus_object is not None:
                # On a character / prop: the distance changes as they move.
                keep = scn.frame_current
                fo = cd.dof.focus_object
                for i in range(13):
                    ms = s_ms + dur * i / 12.0
                    scn.frame_set(ms_to_frame(ms))
                    fwd = -(cam.matrix_world.to_3x3() @ Vector((0, 0, 1)))
                    d = (fo.matrix_world.translation - cam.matrix_world.translation).dot(fwd)
                    out["pts"].append([int(ms), round(max(0.1, d), 3)])
                scn.frame_set(keep)
            else:
                d = round(float(cd.dof.focus_distance), 3)
                out["pts"] = [[s_ms, d], [s_ms + dur, d]]
        cache[sid] = out
        return out

    def _cam_handles(sid, m):
        """What the stage needs to draw and drag the selected camera: its
        keyframes (camera point + aim point), where it is and looks now, and
        the view-projection to put world points on screen."""
        out = {"vp": [round(v, 6) for row in m for v in row], "keys": [], "cam": None, "aim": None, "lens": None,
               "fstop": None, "focus": None, "kit": None, "s0": None, "dur": None}
        if sid not in _by_id:
            return out
        sh = _by_id[sid]
        s_ms = int(sh.get("startMs") or 0)
        for i, k in enumerate(sh.get("keyframes") or []):
            if isinstance(k.get("position"), (list, tuple)) and isinstance(k.get("target"), (list, tuple)):
                out["keys"].append({"i": i, "ms": s_ms + int(k.get("t") or 0),
                                    "p": [float(v) for v in k["position"]][:3], "t": [float(v) for v in k["target"]][:3],
                                    "lens": float(k.get("lens") or 35),
                                    "focus": float(k["focus"]) if isinstance(k.get("focus"), (int, float)) else None})
        out["s0"], out["dur"] = s_ms, int(sh.get("durationMs") or 3000)
        kit = (sh.get("camera") or {}).get("lensKit")
        out["kit"] = kit if isinstance(kit, dict) else None
        out["fcurve"] = _focus_curve(sid)
        # The keys of each lane, as the stage draws them (scene ms).
        cc = sh.get("camera") or {}
        lk = [x for x in cc.get("lensKeys") or [] if isinstance(x, dict)]
        out["lensKeys"] = ([[s_ms + int(x.get("t") or 0), float(x.get("mm") or 35)] for x in lk] if lk else
                           [[x["t"], x["mm"]] for x in _runs([{"t": k_["ms"], "mm": k_["lens"]} for k_ in out["keys"]], "mm")])
        fk = [x for x in cc.get("focusKeys") or [] if isinstance(x, dict)]
        out["focusKeys"] = ([s_ms + int(x.get("t") or 0) for x in fk] if fk else list(out["fcurve"]["keys"]))
        cam = CAMS[sid]
        out["lens"] = round(float(cam.data.lens), 1)
        cd = cam.data
        if cd.dof.use_dof:  # aperture + focus distance now (rack focus included)
            out["fstop"] = round(float(cd.dof.aperture_fstop), 2)
            fo = cd.dof.focus_object
            if fo is not None:
                fwd = -(cam.matrix_world.to_3x3() @ Vector((0, 0, 1)))
                out["focus"] = round(max(0.1, (fo.matrix_world.translation - cam.matrix_world.translation).dot(fwd)), 2)
            else:
                out["focus"] = round(float(cd.dof.focus_distance), 2)
        out["cam"] = [round(v, 4) for v in cam.matrix_world.translation]
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        if tob is not None:
            out["aim"] = [round(v, 4) for v in tob.matrix_world.translation]
        return out

    def _cmd(c, conn=None):
        k = c.get("cmd")
        if k == "surface":  # frames through shared memory instead of the socket
            if _SURF is None:
                _send_json({"type": "surface", "error": "unavailable"}, only=conn)
            elif c.get("on", True):
                LIVE["surf"].setdefault(conn, {"s": None, "size": None})
            else:
                sf = LIVE["surf"].pop(conn, None)
                if sf and sf["s"]:
                    _SURF.bls_release(sf["s"])
        elif k == "follow":  # timeline preview: this shot's camera at scene ms
            pw, ph = LIVE.setdefault("early_size", {}).pop(conn, (960, 540))
            fresh = conn not in LIVE["views"]
            v = LIVE["views"].setdefault(conn, {"shot": ORDER[0], "ms": 0.0, "w": pw, "h": ph})
            before = (v["shot"], ms_to_frame(v["ms"]), ms_to_frame(LIVE["clock"] or 0))
            new_ms = max(0.0, min(float(c.get("ms") or 0), float(DUR_MS)))
            # A paused player re-composes with a ±1/600 s nudge that comes
            # back here as a "new" time; on a frame boundary it flipped the
            # frame forever (endless redraws, never the still-frame quality).
            if (not fresh and c.get("shot", v["shot"]) == v["shot"] and abs(new_ms - v["ms"]) < 4.0
                    and abs(new_ms - (LIVE["clock"] or 0)) < 4.0):
                return False
            if c.get("shot") in _by_id:
                v["shot"] = c.get("shot")
            v["ms"] = max(0.0, min(float(c.get("ms") or 0), float(DUR_MS)))
            LIVE["clock"] = v["ms"]
            if not fresh and before == (v["shot"], ms_to_frame(v["ms"]), ms_to_frame(v["ms"])):
                return False
        elif k == "size" and conn in LIVE["views"]:
            LIVE["views"][conn]["w"] = max(64, int(c.get("w") or 960))
            LIVE["views"][conn]["h"] = max(64, int(c.get("h") or 540))
        elif k == "shot":
            LIVE["shot"] = c.get("id") or LIVE["shot"]
            LIVE["ms"] = 0.0
            LIVE["free"] = None
            LIVE["seq"] = False
        elif k == "sequence":  # scene mode: every shot in order, cut to cut
            LIVE["seq"] = True
            LIVE["free"] = None
            sid = c.get("from")
            LIVE["ms"] = 0.0
            if sid in ORDER:
                LIVE["ms"] = float(sum(int(_by_id[x].get("durationMs") or 3000) for x in ORDER[:ORDER.index(sid)]))
        elif k == "stage":
            LIVE["stage"] = bool(c.get("on", True))
            if c.get("ms") is not None:  # the home view frames the cast around now
                LIVE["stage_ms"] = max(0.0, min(float(c["ms"]), float(DUR_MS)))
            if LIVE["stage"]:
                LIVE["playing"] = False
                if c.get("shot") in _by_id:
                    LIVE["stage_shot"] = c.get("shot")
                pos, tgt, ln = _stage_home()
                if not LIVE["stage_view"] or c.get("home"):
                    LIVE["stage_view"] = {"pos": pos, "tgt": tgt, "lens": ln}
                LIVE["cut_dirty"] = True
                LIVE["stage_stale"] = True
            else:
                _stage_cutaway(False)
                v = LIVE["stage_view"]
                _send_json({"type": "stage_home", "pos": list(v["pos"]), "target": list(v["tgt"]), "lens": v["lens"],
                            "shots": [{"id": sid, "startMs": int(_by_id[sid].get("startMs") or 0),
                                       "durationMs": int(_by_id[sid].get("durationMs") or 3000)} for sid in ORDER],
                            "durationMs": DUR_MS})
        elif k == "stage_view":
            LIVE["stage_view"] = {"pos": Vector(c["pos"]), "tgt": Vector(c["target"]), "lens": float(c.get("lens") or 24),
                                  "ortho": bool(c.get("ortho"))}
            LIVE["cut_dirty"] = True
            # Orbiting draws fast (1 sample, like playback); the full-quality
            # frame lands a beat after it stops.
            LIVE["moved_at"] = time.time()
        elif k == "stage_time":  # scene clock (ms), + the shot the editor is on
            before = (ms_to_frame(LIVE["stage_ms"]), ms_to_frame(LIVE["clock"] or 0), LIVE["stage_shot"])
            new_ms = max(0.0, min(float(c.get("ms") or 0), float(DUR_MS)))
            if (c.get("shot", LIVE["stage_shot"]) == LIVE["stage_shot"] and abs(new_ms - LIVE["stage_ms"]) < 4.0
                    and abs(new_ms - (LIVE["clock"] or 0)) < 4.0):
                return False  # sub-frame jitter (see follow)
            LIVE["stage_ms"] = new_ms
            LIVE["clock"] = LIVE["stage_ms"]
            if c.get("shot") in _by_id:
                LIVE["stage_shot"] = c.get("shot")
            if before == (ms_to_frame(LIVE["stage_ms"]), ms_to_frame(LIVE["stage_ms"]), LIVE["stage_shot"]):
                return False
        elif k == "free_off":
            LIVE["free"] = None
        elif k == "camstate":
            pos, tgt, ln = _cam_now()
            _send_json({"type": "cam", "pos": list(pos), "target": list(tgt), "lens": ln})
        elif k == "pick":
            pos, tgt, ln = _cam_now()
            fwd = (tgt - pos).normalized()
            right = fwd.cross(Vector((0, 0, 1))).normalized()
            up = right.cross(fwd).normalized()
            half_w = 18.0 / ln  # sensor 36 mm wide → tan(hfov/2)
            half_h = half_w * LIVE["h"] / LIVE["w"]
            x = float(c.get("x", 0.5)) * 2 - 1
            y = 1 - float(c.get("y", 0.5)) * 2
            d = (fwd + right * (x * half_w) + up * (y * half_h)).normalized()
            ortho = LIVE["stage"] and LIVE["stage_view"] and LIVE["stage_view"].get("ortho")
            o_ = pos
            if ortho:
                o_, d, _hh = _screen_ray(float(c.get("x", 0.5)), float(c.get("y", 0.5)))
            hit, _loc, _n, _i, ob, _m = scn.ray_cast(bpy.context.evaluated_depsgraph_get(), o_, d)
            found = None
            if hit and ob:
                for cid in CHARS:
                    if ob.name.startswith(f"{cid}_"):
                        found = cid
                        break
            if not c.get("hover"):
                _send_json({"type": "pick", "character": found}, only=conn)
                return False
            # Hover: where the character sits on screen (0..1 box), so the
            # stage can mark it and float its mini card over it.
            # ...and its silhouette: every body part's outline on screen (the
            # 2D hull of its vertices), which the stage unites into the
            # figure's shape as it stands now.
            box = None
            parts = []
            if found:
                xs, ys = [], []
                for o2 in scn.objects:
                    if o2.type != "MESH" or not o2.name.startswith(f"{found}_") or not o2.visible_get():
                        continue
                    mw = o2.matrix_world
                    pts2 = []
                    for vx in o2.data.vertices:
                        v = mw @ vx.co - pos
                        z = v.dot(fwd)
                        if z <= 0.05:
                            continue
                        if ortho:
                            z = (tgt - pos).length
                        pts2.append(((v.dot(right) / z / half_w + 1) / 2, (1 - v.dot(up) / z / half_h) / 2))
                    if len(pts2) < 3:
                        continue
                    hull = _hull2d(pts2)
                    parts.append([round(q, 4) for pt in hull for q in pt])
                    xs += [pt[0] for pt in hull]
                    ys += [pt[1] for pt in hull]
                if xs:
                    box = [min(xs), min(ys), max(xs), max(ys)]
            _send_json({"type": "pick", "hover": True, "character": found, "box": box, "parts": parts}, only=conn)
            return False
        elif k == "cam_edit":
            return _cam_edit(c, conn)
        elif k == "cam_begin":  # one undo step per gesture (drag, slider, delete…)
            sid = c.get("shot")
            if sid in _by_id:
                h = LIVE.setdefault("cam_undo", [])
                h.append(_cam_state(sid))
                del h[:-100]
                LIVE["cam_redo"] = []
            return False
        elif k in ("cam_undo", "cam_redo"):
            src = LIVE.setdefault(k, [])
            dst = LIVE.setdefault("cam_redo" if k == "cam_undo" else "cam_undo", [])
            if not src:
                _send_json({"type": "cam_history_empty", "which": k}, only=conn)
                return False
            st = src.pop()
            sid = st["shot"]
            dst.append(_cam_state(sid))
            sh = _by_id[sid]
            for f in ("keyframes", "move", "camera"):
                if st[f] is None:
                    sh.pop(f, None)
                else:
                    sh[f] = json.loads(json.dumps(st[f]))
            _rebuild_cam(sid)
            _send_json({"type": "cam_restored", "shot": sid, "keyframes": st["keyframes"], "move": st["move"],
                        "camera": st["camera"]}, only=conn)
            return True
        elif k == "cam_keys":
            sid = c.get("shot")
            if sid in _by_id:
                _send_json({"type": "cam_keys", "shot": sid, "keyframes": _shot_keys(sid)}, only=conn)
            return False
        elif k == "seek":
            LIVE["ms"] = float(c.get("ms") or 0)
        elif k == "play":
            LIVE["playing"] = bool(c.get("on", True))
        elif k == "size":
            LIVE["w"] = max(64, int(c.get("w") or 960))
            LIVE["h"] = max(64, int(c.get("h") or 540))
            LIVE["px"] = max(1.0, min(3.0, float(c.get("px") or 1.0)))  # image pixels per screen point
            # A timeline preview may send its size before its first follow:
            # keep it for the view that follow creates.
            LIVE.setdefault("early_size", {})[conn] = (LIVE["w"], LIVE["h"])
        elif k == "view":  # free camera, Blender coords
            LIVE["free"] = {"pos": Vector(c["pos"]), "tgt": Vector(c["target"]), "lens": float(c.get("lens") or 35)}
        elif k == "eevee_set":  # diagnostics / tuning: { attr: value } on scene.eevee
            for attr, val in (c.get("values") or {}).items():
                try:
                    setattr(scn.eevee, attr, val)
                except Exception as e:
                    print(f"[scene3d] eevee_set {attr}: {e}", flush=True)
        elif k == "lights_off":  # diagnostics: hide every light but the world
            for ob in bpy.data.objects:
                if ob.type == "LIGHT":
                    ob.hide_viewport = bool(c.get("on", True))
        elif k == "engine":  # "workbench" (clay, fastest) | "eevee" (lit, real light)
            if c.get("name") == "eevee":
                set_engine("EEVEE")
                eevee_clean(live=True)
            else:
                workbench_studio()
        elif k == "shading":
            sp, _r = _view3d()
            if sp:
                try:
                    sp.shading.type = c.get("type") or "RENDERED"
                except Exception:
                    pass

    def _tick():
        now = time.time()
        dt = now - LIVE["last"]
        LIVE["last"] = now
        try:
            while True:
                conn, _a = srv.accept()
                conn.setblocking(False)
                LIVE["clients"].append(conn)
                LIVE["dirty"] = 2
        except BlockingIOError:
            pass
        for conn in list(LIVE["clients"]):
            try:
                data = conn.recv(65536)
                if not data:
                    raise ConnectionError()
                b = LIVE["buf"].get(conn, b"") + data
                while b"\n" in b:
                    line, b = b.split(b"\n", 1)
                    if line.strip():
                        # A command that changes nothing on screen (the
                        # same frame / shot again) must not redraw: paused,
                        # every redraw makes the player re-seek by a hair,
                        # which re-sends the time — a loop that never ends.
                        if _cmd(json.loads(line), conn) is not False:
                            LIVE["dirty"] = 2
                LIVE["buf"][conn] = b
            except BlockingIOError:
                pass
            except Exception:
                LIVE["clients"].remove(conn)
                continue
        for conn in [c_ for c_ in LIVE["views"] if c_ not in LIVE["clients"]]:
            del LIVE["views"][conn]
        for conn in [c_ for c_ in LIVE["surf"] if c_ not in LIVE["clients"]]:
            sf = LIVE["surf"].pop(conn)
            if sf["s"]:
                _SURF.bls_release(sf["s"])
        if not LIVE["clients"]:
            return 0.05
        follows = list(LIVE["views"].values())
        stage_on = LIVE["stage"] and any(c_ not in LIVE["views"] for c_ in LIVE["clients"])
        if stage_on or follows:
            # Stage and timeline preview share ONE world and ONE clock; the
            # stage's dollhouse cut lives on its own view layer.
            if stage_on:
                if LIVE["stage_shot"] in _by_id and LIVE["stage_shot"] not in LIVE["paths"]:
                    _cam_path(LIVE["stage_shot"])  # frame_set: never inside the draw callback
                _stage_cutaway(True)
            # Light follows the shot on screen (apply_shot_light moves the
            # frame, so it runs here, before the clock frame is set).
            if follows:
                lit = follows[-1]["shot"]
            else:
                hits = _shot_at(LIVE["stage_ms"])
                lit = LIVE["stage_shot"] if LIVE["stage_shot"] in _by_id else (hits[0] if hits else ORDER[0])
            if LIVE.get("lit_for") != lit:
                LIVE["lit_for"] = lit
                apply_shot_light(_by_id[lit])
            ms = LIVE["clock"] if LIVE["clock"] is not None else LIVE["stage_ms"]
            fr = ms_to_frame(ms)
            if scn.frame_current != fr or LIVE.pop("stage_stale", False):
                scn.frame_set(fr)
                # Playing: one draw per frame (two only for a lone change).
                LIVE["dirty"] = 1 if now - LIVE.get("moved_at", 0.0) < 0.25 else 2
                LIVE["moved_at"] = now
                if stage_on:
                    # The stage layer has its own depsgraph: evaluate it at
                    # the same frame.
                    with bpy.context.temp_override(view_layer=_stage_layer()):
                        scn.frame_set(fr)
            # Playback renders 1 EEVEE sample per frame (the offscreen draw
            # renders ALL taa_samples every time: 8 cost ~8x and broke real
            # time); a beat after it stops, one full-quality redraw.
            moving = now - LIVE.get("moved_at", 0.0) < 0.25
            want = 1 if moving else 8
            if scn.eevee.taa_samples != want:
                scn.eevee.taa_samples = want
                LIVE["moving"] = moving
                if not moving:
                    LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
            # Redraw only when something changed: an idle scene costs
            # nothing, and a paused timeline sees a new frame (surface seed)
            # only when there is one. Shaders still compiling keep it going
            # so the first frames never freeze half-shaded.
            try:
                if bpy.app.is_job_running("SHADER_COMPILATION"):
                    LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
            except Exception:
                pass
            flush = not LIVE.get("dirty", 0) and bool(LIVE.get("pend"))
            if LIVE.get("dirty", 0) > 0 or flush:
                if flush:
                    LIVE["draw_req"] = LIVE.get("draw_req") or "flush"
                else:
                    LIVE["dirty"] -= 1
                    LIVE["draw_req"] = True
                for win in bpy.context.window_manager.windows:
                    for area in win.screen.areas:
                        if area.type == "VIEW_3D":
                            area.tag_redraw()
            return 1.0 / 60.0
        total = _seq_total() if LIVE["seq"] else float(int((_by_id.get(LIVE["shot"]) or {}).get("durationMs") or 3000))
        if LIVE["playing"]:
            LIVE["ms"] += dt * 1000.0
            if LIVE["ms"] >= total:
                LIVE["ms"] = 0.0 if not LIVE["seq"] else total
                if LIVE["seq"]:
                    LIVE["playing"] = False
        sid, local = _active()
        sh = _by_id[sid]
        fr = ms_to_frame(int(sh.get("startMs") or 0) + local)
        if scn.frame_current != fr:
            scn.frame_set(fr)
        if now - LIVE["state_at"] > 0.1:
            LIVE["state_at"] = now
            _send_json({"type": "state", "shot": sid, "ms": LIVE["ms"], "total": total,
                        "playing": LIVE["playing"], "seq": LIVE["seq"]})
        # The offscreen draw needs Blender's GPU context, which only exists
        # inside its draw loop: ask the viewport to redraw; _draw does the rest.
        LIVE["draw_req"] = True
        for win in bpy.context.window_manager.windows:
            for area in win.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
        return 1.0 / 60.0

    # ── Depth of field for the live views ──────────────────────────────
    # draw_view3d with a camera's matrices is never "looking through the
    # camera", so EEVEE skips the lens blur the final render has. Redo it
    # here from the depth buffer and the camera's real optics (lens, f-stop,
    # focus distance AT THIS FRAME — rack focus included).
    _DOF = {}

    def _dof_shader():
        if "shader" in _DOF:
            return _DOF["shader"], _DOF["batch"]
        info = gpu.types.GPUShaderCreateInfo()
        info.push_constant("FLOAT", "focus")
        info.push_constant("FLOAT", "kpx")
        info.push_constant("FLOAT", "maxr")
        info.push_constant("FLOAT", "rsk")
        info.push_constant("VEC2", "texel")
        info.sampler(0, "FLOAT_2D", "color")
        info.sampler(1, "FLOAT_2D", "depth")
        iface = gpu.types.GPUStageInterfaceInfo("brx_dof_iface")
        iface.smooth("VEC2", "uv")
        info.vertex_in(0, "VEC2", "pos")
        info.vertex_out(iface)
        info.fragment_out(0, "VEC4", "fragColor")
        info.vertex_source("void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }")
        info.fragment_source("""
// Scatter-as-gather lens blur (a dense golden-angle spiral). A nearer
// sample spreads its full circle of confusion over what lies behind it
// (out-of-focus foreground veils the subject, like a real lens); a farther
// one only reaches as far as this pixel's own blur, so a sharp subject never
// smears into the background. Averaged in linear light: highlights bloom
// into bokeh instead of greying out.
float coc(float D) { return min(maxr, kpx * abs(D - focus) / max(D, 1e-3)); }
vec3 lin3(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
void main() {
    float d0 = texture(depth, uv).r;
    float c0 = coc(d0);
    vec3 acc = lin3(texture(color, uv).rgb);
    float tot = 1.0;
    const float GA = 2.39996323;
    float rs = max(1.0, maxr * maxr / 400.0) * rsk;  // ~200 taps (fewer while playing)
    float rad = rs;
    float ang = 0.0;
    for (int i = 0; i < 512; i++) {
        if (rad >= maxr) break;
        vec2 q = uv + vec2(cos(ang), sin(ang)) * rad * texel;
        float dq = texture(depth, q).r;
        float cq = coc(dq);
        if (dq > d0) cq = min(cq, c0 * 2.0);
        float m = smoothstep(rad - 0.5 * rs, rad + 0.5 * rs, cq);
        acc += mix(acc / tot, lin3(texture(color, q).rgb), m);
        tot += 1.0;
        ang += GA;
        rad += rs / rad;
    }
    fragColor = vec4(pow(acc / tot, vec3(1.0 / 2.2)), 1.0);
}
""")
        sh = gpu.shader.create_from_info(info)
        _DOF["shader"] = sh
        _DOF["batch"] = batch_for_shader(sh, "TRI_FAN", {"pos": [(-1, -1), (1, -1), (1, 1), (-1, 1)]})
        return _DOF["shader"], _DOF["batch"]

    def _zshader():
        if "z" in _DOF:
            return _DOF["z"]
        info = gpu.types.GPUShaderCreateInfo()
        info.push_constant("MAT4", "mv")
        info.push_constant("MAT4", "proj")
        iface = gpu.types.GPUStageInterfaceInfo("brx_z_iface")
        iface.smooth("FLOAT", "vd")
        info.vertex_in(0, "VEC3", "pos")
        info.vertex_out(iface)
        info.fragment_out(0, "VEC4", "fragColor")
        info.vertex_source("void main() { vec4 v = mv * vec4(pos, 1.0); vd = -v.z; gl_Position = proj * v; }")
        info.fragment_source("void main() { fragColor = vec4(vd, 0.0, 0.0, 1.0); }")
        _DOF["z"] = gpu.shader.create_from_info(info)
        return _DOF["z"]

    def _mesh_batch(ob, sh):
        """Triangles of a mesh object, cached per mesh datablock (the set is
        built from a few shared unit meshes)."""
        me = ob.data
        b = _DOF.setdefault("batches", {}).get(me.name)
        if b is None:
            me.calc_loop_triangles()
            co = [v.co[:] for v in me.vertices]
            idx = [t.vertices[:] for t in me.loop_triangles]
            b = batch_for_shader(sh, "TRIS", {"pos": co}, indices=idx) if idx else False
            _DOF["batches"][me.name] = b
        return b

    def _linear_depth(cam, w, h, dg, used):
        """Distance to the camera per pixel (metres) in an RGBA32F offscreen."""
        zs = _zshader()
        key = ("z", w, h)
        oz = offscreen.get(key)
        if oz is None:
            oz = offscreen[key] = gpu.types.GPUOffScreen(w, h, format="RGBA32F")
        used.add(key)
        view = cam.matrix_world.inverted()
        proj = cam.calc_matrix_camera(dg, x=w, y=h)
        with oz.bind():
            fb = gpu.state.active_framebuffer_get()
            fb.clear(color=(1.0e5, 0.0, 0.0, 1.0), depth=1.0)
            gpu.state.depth_test_set("LESS_EQUAL")
            gpu.state.depth_mask_set(True)
            gpu.state.blend_set("NONE")
            zs.bind()
            zs.uniform_float("proj", proj)
            for ob in scn.objects:
                if ob.type != "MESH" or not ob.visible_get():
                    continue
                b = _mesh_batch(ob, zs)
                if not b:
                    continue
                zs.uniform_float("mv", view @ ob.evaluated_get(dg).matrix_world)
                b.draw(zs)
            gpu.state.depth_test_set("NONE")
            gpu.state.depth_mask_set(False)
        return oz

    def _dof_pass(o, cam, w, h, used, tag=""):
        """Lens blur over offscreen o when the shot camera has DOF on;
        returns the offscreen to ship (o itself when there is none)."""
        cd = cam.data
        if not cd.dof.use_dof:
            return o
        try:
            fo = cd.dof.focus_object
            if fo is not None:
                fwd = -(cam.matrix_world.to_3x3() @ Vector((0, 0, 1)))
                focus = max(0.1, (fo.matrix_world.translation - cam.matrix_world.translation).dot(fwd))
            else:
                focus = max(0.1, float(cd.dof.focus_distance))
            f_mm, n_stop, sensor = float(cd.lens), max(0.5, float(cd.dof.aperture_fstop)), float(cd.sensor_width or 36.0)
            S = focus * 1000.0
            # Circle of confusion: (f^2 / (N (S - f))) * |D - S| / D, in mm on
            # the sensor -> pixels; the shader multiplies by |D - S| / D.
            kpx = (f_mm * f_mm / (n_stop * max(S - f_mm, 1.0))) / sensor * w * 0.5
            dtex = _linear_depth(cam, w, h, bpy.context.evaluated_depsgraph_get(), used).texture_color
            sh, batch = _dof_shader()
            o2 = _offscreen_k(("dof", tag, w, h), w, h, used)
            with o2.bind():
                gpu.state.depth_test_set("NONE")
                gpu.state.blend_set("NONE")
                sh.bind()
                sh.uniform_float("focus", focus)
                sh.uniform_float("kpx", kpx)
                sh.uniform_float("maxr", max(4.0, w * 0.025))
                sh.uniform_float("rsk", 2.0 if LIVE.get("moving") else 1.0)
                sh.uniform_float("texel", (1.0 / w, 1.0 / h))
                sh.uniform_sampler("color", o.texture_color)
                sh.uniform_sampler("depth", dtex)
                batch.draw(sh)
            return o2
        except Exception as e:
            if not _DOF.get("warned"):
                _DOF["warned"] = True
                print(f"[scene3d] live DOF off: {e}", flush=True)
            return o

    def _offscreen_k(key, w, h, used):
        o = offscreen.get(key)
        if o is None:
            o = offscreen[key] = gpu.types.GPUOffScreen(w, h)
        used.add(key)
        return o

    def _offscreen(w, h, used):
        o = offscreen.get((w, h))
        if o is None:
            o = offscreen[(w, h)] = gpu.types.GPUOffScreen(w, h)
        used.add((w, h))
        return o

    def _ship(o, w, h, conns):
        px = o.texture_color.read()
        px.dimensions = w * h * 4
        # Shared-memory clients: the frame goes into their IOSurface, the GUI
        # shows it as a native texture — no pixels on the socket.
        rest = []
        for conn in conns:
            sf = LIVE["surf"].get(conn)
            if sf is None:
                rest.append(conn)
                continue
            if sf["size"] != (w, h):
                if sf["s"]:
                    _SURF.bls_release(sf["s"])
                sf["s"] = _SURF.bls_create(w, h)
                sf["size"] = (w, h)
                _send_json({"type": "surface", "id": int(_SURF.bls_id(sf["s"])), "w": w, "h": h}, only=conn)
            if sf["s"]:
                _SURF.bls_write_rgba(sf["s"], (ctypes.c_ubyte * (w * h * 4)).from_buffer(px), w, h)
        if not rest:
            return
        payload = bytes(memoryview(px).cast("B")) if memoryview(px).format != "B" else bytes(memoryview(px))
        head = struct.pack("<4sIII", b"BRXF", w, h, len(payload))
        for conn in rest:
            try:
                conn.setblocking(True)
                conn.sendall(head + payload)
                conn.setblocking(False)
            except Exception:
                if conn in LIVE["clients"]:
                    LIVE["clients"].remove(conn)

    def _draw():
        # Only the redraws the tick asked for: EEVEE also redraws on its own
        # (progressive samples), and with two views (stage + preview) its
        # accumulation restarts every draw — it never converges, so it would
        # rewrite every surface forever and the paused player would re-seek
        # non-stop (black preview, play swallowed).
        req = LIVE.pop("draw_req", False)
        if not req or not LIVE["clients"]:
            return
        # Pipelined like a game engine: each view first ships the frame it
        # drew LAST time (the GPU has finished it by now, so the read does
        # not stall), then queues the next one. Reading right after drawing
        # waited ~17 ms per frame for the GPU, serialising everything.
        pend = LIVE.setdefault("pend", {})
        for key, (po, pw, ph, pconns) in list(pend.items()):
            pconns = [c_ for c_ in pconns if c_ in LIVE["clients"]]
            if pconns:
                _ship(po, pw, ph, pconns)
        pend.clear()
        if req == "flush":  # nothing new to draw: the last frame went out
            return
        ctx = bpy.context
        sp, reg = ctx.space_data, ctx.region
        dg = ctx.evaluated_depsgraph_get()
        used = set()
        legacy = [c_ for c_ in LIVE["clients"] if c_ not in LIVE["views"]]
        if LIVE["views"]:
            for conn, v in list(LIVE["views"].items()):
                cam = CAMS.get(v["shot"])
                if cam is None or conn not in LIVE["clients"]:
                    continue
                w, h = v["w"], v["h"]
                tag = id(conn)
                o = _offscreen_k(("v", tag, w, h), w, h, used)
                o.draw_view3d(scn, ctx.view_layer, sp, reg, cam.matrix_world.inverted(),
                              cam.calc_matrix_camera(dg, x=w, y=h), do_color_management=True)
                pend[("v", tag)] = (_dof_pass(o, cam, w, h, used, tag), w, h, [conn])
        if legacy:
            # While playing, the stage (a second full render competing for
            # the GPU) refreshes ~5x/s; the preview keeps every frame.
            now_ = time.time()
            if not LIVE.get("moving") or now_ - LIVE.get("stage_drawn", 0.0) >= 0.2 or not LIVE["views"]:
                LIVE["stage_drawn"] = now_
                _draw_legacy(ctx, sp, reg, dg, used, legacy)
            else:
                used.update(k for k in offscreen if k[0] == "st")
        for k in [k for k in offscreen if k not in used]:
            offscreen.pop(k).free()
        LIVE["frames"] += 1

    def _draw_legacy(ctx, sp, reg, dg, used, conns):
        """The stage (free orbit + every camera) or the single-shot viewer."""
        if LIVE["stage"]:
            hits = _shot_at(LIVE["stage_ms"])
            sid = LIVE["stage_shot"] if LIVE["stage_shot"] in _by_id else (hits[0] if hits else ORDER[0])
            sh = _by_id[sid]
        else:
            sh = _by_id[_active()[0]]
            if LIVE.get("lit_for") != sh["id"]:
                LIVE["lit_for"] = sh["id"]
                apply_shot_light(sh)
        w, h = LIVE["w"], LIVE["h"]
        cam = CAMS.get(sh["id"])
        f = LIVE["stage_view"] if LIVE["stage"] else LIVE["free"]
        if f:
            cam_d_live = bpy.data.cameras.get("live_cam") or bpy.data.cameras.new("live_cam")
            live = bpy.data.objects.get("live_cam") or bpy.data.objects.new("live_cam", cam_d_live)
            cam_d_live.sensor_fit = "HORIZONTAL"
            cam_d_live.sensor_width = 36.0
            cam_d_live.lens = f["lens"]
            # Orthographic stage view (Blender's numpad-5): same framing width.
            cam_d_live.type = "ORTHO" if f.get("ortho") else "PERSP"
            cam_d_live.ortho_scale = max(0.1, 2.0 * (f["tgt"] - f["pos"]).length * 18.0 / f["lens"])
            cam_d_live.clip_start = 0.05
            live.location = f["pos"]
            live.rotation_euler = (f["tgt"] - f["pos"]).to_track_quat("-Z", "Y").to_euler()
            live.matrix_world = live.matrix_basis
            cam = live
        view = cam.matrix_world.inverted()
        proj = cam.calc_matrix_camera(dg, x=w, y=h)
        o = _offscreen_k(("st", w, h), w, h, used)
        o.draw_view3d(scn, _stage_layer() if LIVE["stage"] else ctx.view_layer, sp, reg, view, proj,
                      do_color_management=True)
        if LIVE["stage"]:
            with o.bind():
                _draw_cams(view, proj, w, h)
            now = time.time()
            if now - LIVE["proj_at"] > 0.08:
                LIVE["proj_at"] = now
                msg = {"type": "stage", "ms": LIVE["stage_ms"], "cams": _stage_proj(view, proj),
                       "active": LIVE["stage_shot"], **_cam_handles(LIVE["stage_shot"], proj @ view)}
                for conn in conns:
                    _send_json(msg, only=conn)
        LIVE.setdefault("pend", {})["st"] = (o, w, h, list(conns))

    bpy.types.SpaceView3D.draw_handler_add(_draw, (), "WINDOW", "POST_PIXEL")
    def _stealth():
        """Keep the UI session invisible: no splash, no Dock icon, app hidden
        (like Cmd-H) — through the Objective-C runtime, no permissions."""
        try:
            bpy.context.preferences.view.show_splash = False
        except Exception:
            pass
        for win in bpy.context.window_manager.windows:  # close the splash if it is up
            try:
                with bpy.context.temp_override(window=win):
                    bpy.ops.wm.splash_close()
            except Exception:
                pass
        if sys.platform != "darwin":
            return None
        try:
            import ctypes
            import ctypes.util
            objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc"))
            objc.objc_getClass.restype = ctypes.c_void_p
            objc.sel_registerName.restype = ctypes.c_void_p
            send = objc.objc_msgSend
            send.restype = ctypes.c_void_p
            send.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            app = send(objc.objc_getClass(b"NSApplication"), objc.sel_registerName(b"sharedApplication"))
            set_policy = ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long)(
                ctypes.cast(objc.objc_msgSend, ctypes.c_void_p).value)
            set_policy(app, objc.sel_registerName(b"setActivationPolicy:"), 1)  # accessory: no Dock icon
            # Hiding the app (Cmd-H) stops macOS from drawing it — and the
            # viewport with it. Instead the window stays "on screen" for the
            # system but fully transparent, click-through, behind everything.
            fn = lambda res, *args: ctypes.CFUNCTYPE(res, ctypes.c_void_p, ctypes.c_void_p, *args)(
                ctypes.cast(objc.objc_msgSend, ctypes.c_void_p).value)
            sel = objc.sel_registerName
            windows = fn(ctypes.c_void_p)(app, sel(b"windows"))
            count = fn(ctypes.c_ulong)(windows, sel(b"count"))
            for i in range(count):
                w = fn(ctypes.c_void_p, ctypes.c_ulong)(windows, sel(b"objectAtIndex:"), i)
                fn(None, ctypes.c_double)(w, sel(b"setAlphaValue:"), 0.0)
                fn(None, ctypes.c_bool)(w, sel(b"setIgnoresMouseEvents:"), True)
                fn(None, ctypes.c_long)(w, sel(b"setLevel:"), -2147483623)  # desktop level
            # An invisible background app is what App Nap throttles (timers
            # coalesced, lower CPU / GPU priority): opt out, latency critical.
            info = fn(ctypes.c_void_p)(objc.objc_getClass(b"NSProcessInfo"), sel(b"processInfo"))
            why = fn(ctypes.c_void_p, ctypes.c_char_p)(objc.objc_getClass(b"NSString"), sel(b"stringWithUTF8String:"),
                                                      b"Braxil live 3D previz")
            tok = fn(ctypes.c_void_p, ctypes.c_uint64, ctypes.c_void_p)(
                info, sel(b"beginActivityWithOptions:reason:"), 0x00FFFFFF | 0xFF00000000, why)
            LIVE["activity"] = fn(ctypes.c_void_p)(tok, sel(b"retain")) if tok else None
        except Exception as e:
            print(f"[scene3d] live stealth: {e}", flush=True)
        return None

    bpy.app.timers.register(_stealth, first_interval=0.05)
    bpy.app.timers.register(_tick, first_interval=0.2, persistent=True)
    # Viewport look = the scene's own render engine (Workbench clay/sketch or
    # EEVEE when lit), drawn live; no overlays / gizmos.
    _sp, _r = _view3d()
    if _sp:
        try:
            _sp.shading.type = "RENDERED"
            _sp.overlay.show_overlays = False
            _sp.show_gizmo = False
        except Exception as e:
            print(f"[scene3d] live shading: {e}", flush=True)
    print(f"[scene3d] live on 127.0.0.1:{args.live}", flush=True)

elif args.export_glb:
    # Live viewer: the SAME world (set, props, mannequins + their whole
    # animation) as glTF, plus every shot's camera sampled over its window.
    # glTF is +Y up: Blender (x, y, z) → glTF (x, z, -y).
    def gl(v):
        return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]

    meta = {"fps": FPS, "durationMs": DUR_MS, "aspect": RW / RH, "sensorWidth": 36.0,
            "characters": [], "props": [], "shots": []}
    for c in S.get("characters") or []:
        cid = c.get("id")
        if cid in CHARS:
            meta["characters"].append({"id": cid, "name": c.get("name") or cid,
                                       "characterId": c.get("characterId"), "node": f"char_{cid}"})
    for p_ in SETD.get("props") or []:
        meta["props"].append({"id": p_.get("id"), "shape": p_.get("shape"), "node": f"prop_{p_.get('id')}"})
    step = max(1, FPS // 12)
    for j in JOBS:
        sh = _by_id[j["shot"]]
        cam = CAMS[j["shot"]]
        tgt_ob = bpy.data.objects.get(f"cam_target_{sh['id']}")
        s0 = int(sh.get("startMs") or 0)
        s1 = s0 + int(sh.get("durationMs") or 3000)
        samples = []
        fr = ms_to_frame(s0)
        while True:
            scn.frame_set(fr)
            ms = int(round((fr - 1) * 1000.0 / FPS))
            samples.append([max(0, ms - s0)] + gl(cam.matrix_world.translation)
                           + gl(tgt_ob.matrix_world.translation) + [round(cam.data.lens, 2)])
            if ms >= s1:
                break
            fr = min(fr + step, ms_to_frame(s1))
        meta["shots"].append({"id": sh["id"], "name": sh.get("name"), "storyboardShotId": sh.get("storyboardShotId"),
                              "startMs": s0, "durationMs": s1 - s0, "camera": samples})
    for ob in bpy.data.objects:
        ob.select_set(ob.type in ("MESH", "EMPTY") and not ob.name.startswith("cam") and ob.name not in ("sun", "fill"))
    scn.frame_set(1)
    bpy.ops.export_scene.gltf(
        filepath=args.export_glb, export_format="GLB", use_selection=True,
        export_cameras=False, export_lights=False, export_yup=True, export_apply=True,
        export_animations=True, export_animation_mode="SCENE", export_force_sampling=True,
        export_frame_range=True, export_optimize_animation_size=True)
    with open(args.export_glb + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f)
    print(f"[scene3d] exported {args.export_glb}")
    sys.exit(0)

# Stills render below, once the per-shot lights exist.
_STILL_PENDING = args.still >= 0 and not args.live

im = r.image_settings
if hasattr(im, "media_type"):  # Blender 5.x
    im.media_type = "VIDEO"
im.file_format = "FFMPEG"
r.ffmpeg.format = "MPEG4"
r.ffmpeg.codec = "H264"
r.ffmpeg.constant_rate_factor = "MEDIUM"
r.ffmpeg.ffmpeg_preset = "REALTIME"
r.ffmpeg.gopsize = max(1, FPS // 2)  # short GOP → snappy scrubbing
r.ffmpeg.audio_codec = "NONE"
r.use_file_extension = False

full_start, full_end = scn.frame_start, scn.frame_end
_shot_lights = {}


def _light_spec(sh):
    spec = sh.get("light") or sh.get("lighting")
    return spec if isinstance(spec, dict) else None


_scene_key = []  # [(toward, hard, spec)] once worked out


def _scene_key_light():
    """The scene's KEY light, fixed in the WORLD: the sun / window does not
    move when the film cuts to another camera. Worked out once, from the
    first shot (in story order) whose light says where it comes from — its
    direction is read against THAT shot's frame. None = no shot has a light."""
    if _scene_key:
        return _scene_key[0]
    _scene_key.append(None)
    for sh in sorted(_by_id.values(), key=lambda x: int(x.get("startMs") or 0)):
        spec = _light_spec(sh)
        cam = CAMS.get(sh["id"])
        if spec is None or cam is None:
            continue
        scn.frame_set(ms_to_frame(int(sh.get("startMs") or 0)))
        m = cam.matrix_world.to_3x3()
        _scene_key[0] = (_key_dir(spec, m.col[0].normalized(), m.col[2].normalized()),
                         str(spec.get("quality") or "soft").lower() == "hard", spec,
                         m.col[2].normalized())
        break
    return _scene_key[0]


def _key_dir(spec, right, back):
    up = Vector((0, 0, 1))
    k = spec.get("key", "screen_left")
    if isinstance(k, (int, float)):
        a = math.radians(float(k))  # 0 = from camera, 90 = frame right, 180 = behind subject
        toward = back * math.cos(a) + right * math.sin(a)
    else:
        toward = {
            "screen_left": -right + back * 0.35, "left": -right + back * 0.35,
            "screen_right": right + back * 0.35, "right": right + back * 0.35,
            "back": -back, "backlight": -back, "contraluz": -back,
            "front": back, "top": Vector((0, 0, 0)),
        }.get(str(k).lower(), -right + back * 0.35)
    elev = float(spec.get("elevation") or (75 if str(k).lower() == "top" else 30))
    toward = Vector((toward.x, toward.y, 0))
    if toward.length < 1e-4:
        return Vector((0, 0, 1))
    return toward.normalized() * math.cos(math.radians(elev)) + up * math.sin(math.radians(elev))


def apply_shot_light(sh):
    """shot.light = { key: "screen_left"|"screen_right"|"back"|"front"|"top"|"left"|"right"|deg,
    quality: "soft"|"hard", intensity?, color?, rim?: bool }. The KEY (where
    the light comes from, its quality, colour, strength) is the SCENE's,
    fixed in the world (see _scene_key_light) — cutting never relights the
    set, nothing switches on or off between shots (rim included).
    Workbench gets the shadow direction, EEVEE a key (+ rim) sun."""
    for ob in _shot_lights.values():
        ob.hide_render = True
        ob.hide_viewport = True
    key = _scene_key_light()
    cam = CAMS.get(sh["id"])
    if key is None or cam is None:
        return
    toward, hard, spec, kback = key
    scn.frame_set(ms_to_frame(int(sh.get("startMs") or 0)))
    m = cam.matrix_world.to_3x3()
    up, back = Vector((0, 0, 1)), m.col[2].normalized()  # back = towards camera
    try:
        scn.display.light_direction = toward
        scn.display.shadow_focus = 0.05 if hard else 0.6
    except Exception:
        pass
    # Lights live INSIDE the set, placed around the subject (a sun would be
    # blocked by the room's walls / ceiling): soft = big area, hard = spot.
    tgt_ob = bpy.data.objects.get(f"cam_target_{sh['id']}")
    subj = tgt_ob.matrix_world.translation.copy() if tgt_ob else Vector((0, 0, 1.4))
    if preset in DAYLIGHT:
        # Daylight: the SUN is the key — the shot only says where it comes
        # from (window on frame-left, backlight…). Never a studio spot.
        sun.hide_render = False
        sun.hide_viewport = False
        sun.rotation_euler = toward.to_track_quat("Z", "Y").to_euler()
        # A small sun disc (a wide one samples its penumbra = grain); softness
        # comes from shadow FILTERING instead.
        sun.data.angle = math.radians(0.5 if hard else 1.2)
        try:
            sun.data.shadow_filter_radius = 1.5 if hard else 5.0
            sun.data.use_shadow_jitter = False
        except Exception:
            pass
        rig = []
    else:
        sun.hide_render = True
        sun.hide_viewport = True
        fill = bpy.data.objects.get("fill")
        if fill:
            fill.data.energy = 35
        rig = [("key", toward, 450.0)]
    if spec.get("rim"):
        rig.append(("rim", (-kback * 0.9 + up * 0.6).normalized(), 300.0))
    if spec.get("fill", True) and preset not in DAYLIGHT:
        rig.append(("fillside", (-Vector((toward.x, toward.y, 0)) + kback * 0.6 + up * 0.3).normalized(), 70.0))
    for name, vec, energy in rig:
        lid = f"shotlight_{sh['id']}_{name}"
        ob = _shot_lights.get(lid)
        if ob is None:
            # ONE shadow-casting light (the key, a spot — a big soft AREA's
            # shadow is sampled stochastically = grain); fill / rim only shape.
            ld = bpy.data.lights.new(lid, "SPOT" if name == "key" else "AREA")
            ob = bpy.data.objects.new(lid, ld)
            link(ob)
            _shot_lights[lid] = ob
        dist = float(spec.get("distance") or 3.0)
        ob.location = subj + vec * dist
        ob.rotation_euler = (subj - ob.location).to_track_quat("-Z", "Y").to_euler()
        ob.data.energy = energy * float(spec.get("intensity") or 1.0) * (dist / 3.0) ** 2
        ob.data.color = hex_rgba(spec.get("color") or ("#e6edff" if name == "key" else "#ffffff"))[:3]
        if ob.data.type == "AREA":
            ob.data.size = 2.2 if name != "rim" else 1.2
            ob.data.use_shadow = False
        else:
            ob.data.spot_size = math.radians(70)
            ob.data.spot_blend = 0.6
            ob.data.shadow_soft_size = 0.01 if hard else 0.05
            ob.data.use_shadow = True
            try:
                ob.data.shadow_filter_radius = 2.0 if hard else 6.0
                ob.data.use_shadow_jitter = False
            except Exception:
                pass
        ob.hide_render = False
        ob.hide_viewport = False


if _STILL_PENDING:
    apply_shot_light(_by_id[JOBS[0]["shot"]])
    scn.camera = CAMS[JOBS[0]["shot"]]
    scn.frame_set(ms_to_frame(args.still))
    r.image_settings.file_format = "PNG"
    r.filepath = JOBS[0]["out"]
    bpy.ops.render.render(write_still=True)
    print(f"[scene3d] still → {JOBS[0]['out']}")
    sys.exit(0)

def in_frame(cam, f0, f1):
    """Who and what this camera actually SEES over [f0, f1] — the per-shot
    continuity (which references a generation needs), derived from the 3D
    instead of kept by hand. A character counts when part of the body is
    in frame; share = rough fraction of the frame height it fills."""
    from bpy_extras.object_utils import world_to_camera_view
    frames = sorted({f0, (f0 + f1) // 2, f1})
    chars, props = {}, {}
    for fr in frames:
        scn.frame_set(fr)
        for cid, parts in CHARS.items():
            root = parts["root"].matrix_world.translation
            hgt = float(parts.get("height") or 1.75)
            pts = [world_to_camera_view(scn, cam, root + Vector((0, 0, hgt * t))) for t in (0.05, 0.5, 0.95)]
            vis = [q for q in pts if q.z > 0 and -0.02 <= q.x <= 1.02 and -0.02 <= q.y <= 1.02]
            if vis:
                ys = [min(max(q.y, 0.0), 1.0) for q in pts if q.z > 0]
                share = (max(ys) - min(ys)) if ys else 0.0
                c = chars.setdefault(cid, {"frames": 0, "share": 0.0, "xs": [], "zs": []})
                c["zs"].append(sum(q.z for q in vis) / len(vis))
                c["frames"] += 1
                c["share"] = max(c["share"], round(share, 2))
                c["xs"].append(min(1.0, max(0.0, sum(q.x for q in vis) / len(vis))))
        for p_ in SETD.get("props") or []:
            ob = bpy.data.objects.get(f"prop_{p_.get('id')}")
            if not ob:
                continue
            q = world_to_camera_view(scn, cam, ob.matrix_world.translation)
            if q.z > 0 and 0 <= q.x <= 1 and 0 <= q.y <= 1:
                props[p_.get("id")] = True
    names = {c.get("id"): c for c in (S.get("characters") or [])}
    return {
        "characters": [{"id": cid, "name": (names.get(cid) or {}).get("name") or cid,
                        "characterId": (names.get(cid) or {}).get("characterId"),
                        "share": v["share"], "x": round(sum(v["xs"]) / len(v["xs"]), 2),
                        "xs": [round(x_, 2) for x_ in v["xs"]], "dist": round(sum(v["zs"]) / len(v["zs"]), 2),
                        "frames": v["frames"], "of": len(frames)}
                       for cid, v in chars.items()],
        "props": sorted(props),
    }


for j in ([] if args.live else JOBS):  # live: Blender stays open, timers drive it
    apply_shot_light(_by_id[j["shot"]])
    scn.camera = CAMS[j["shot"]]
    scn.frame_start = ms_to_frame(j["fromMs"]) if j.get("fromMs") is not None else full_start
    scn.frame_end = (max(scn.frame_start, ms_to_frame(j["toMs"]))
                     if j.get("toMs") is not None else full_end)
    if args.render_pass == "beauty":
        try:
            with open(j["out"].replace(".part.mp4", "").replace(".stills", "") + ".inframe.json", "w", encoding="utf-8") as fh:
                json.dump(in_frame(CAMS[j["shot"]], scn.frame_start, scn.frame_end), fh)
        except Exception as e:
            print(f"[scene3d] inframe {j['shot']}: {e}", file=sys.stderr)
    if j.get("stills"):
        # Stills only (card poster + review sheet): a few frames, no video.
        if hasattr(im, "media_type"):  # Blender 5.x
            im.media_type = "IMAGE"
        im.file_format = "PNG"
        for i, ms in enumerate(j["stills"]):
            scn.frame_set(ms_to_frame(ms))
            r.filepath = f"{j['out']}-{i}.png"
            bpy.ops.render.render(write_still=True)
        print(f"[scene3d] done {j['shot']} {len(j['stills'])} stills → {j['out']}", flush=True)
        continue
    if hasattr(im, "media_type"):  # Blender 5.x
        im.media_type = "VIDEO"
    im.file_format = "FFMPEG"
    r.filepath = j["out"]
    bpy.ops.render.render(animation=True)
    # One line per finished job: the engine picks each file up as it lands.
    print(f"[scene3d] done {j['shot']} {scn.frame_end - scn.frame_start + 1} frames → {j['out']}", flush=True)
`;
