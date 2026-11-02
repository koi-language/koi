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

import base64
import bpy
import bmesh
import json
import math
import sys
import argparse
import struct
import zlib
from mathutils import Vector, Euler, Matrix, Quaternion

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
ap.add_argument("--max-quality", action="store_true", help="encode for a generation reference: visually lossless, slowest preset")
ap.add_argument("--flat-surfaces", action="store_true",
                help="a video-generation reference: every surface but the characters one matte grey (no textures, patches or markings to copy)")
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

def hide_live_windows():
    """macOS clamps --window-geometry back on screen, so the live session's
    window would show up on the user's desktop. Keep it (the viewport draws
    through it) but fully transparent, shadowless and click-through."""
    if sys.platform != "darwin":
        return
    try:
        import ctypes
        import ctypes.util
        objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc"))
        objc.objc_getClass.restype = ctypes.c_void_p
        objc.objc_getClass.argtypes = [ctypes.c_char_p]
        objc.sel_registerName.restype = ctypes.c_void_p
        objc.sel_registerName.argtypes = [ctypes.c_char_p]

        def send(obj, sel, *a, res=ctypes.c_void_p, types=()):
            f = ctypes.CFUNCTYPE(res, ctypes.c_void_p, ctypes.c_void_p, *types)(
                ctypes.cast(objc.objc_msgSend, ctypes.c_void_p).value)
            return f(obj, objc.sel_registerName(sel.encode()), *a)

        app = send(objc.objc_getClass(b"NSApplication"), "sharedApplication")
        wins = send(app, "windows")
        for i in range(send(wins, "count", res=ctypes.c_ulong)):
            w = send(wins, "objectAtIndex:", i, types=(ctypes.c_ulong,))
            send(w, "setAlphaValue:", 0.0, res=None, types=(ctypes.c_double,))
            send(w, "setHasShadow:", False, res=None, types=(ctypes.c_bool,))
            send(w, "setIgnoresMouseEvents:", True, res=None, types=(ctypes.c_bool,))
    except Exception as e:
        print(f"[scene3d] hide window failed: {e}", flush=True)


if args.live:
    hide_live_windows()
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


# ──────────────────────────────────────────────────── modeled assets ──
# Objects and sets modeled with build_model3d (<project>/models3d/<id>/model.glb):
# authored in metres, front at +y, objects centred and standing on z = 0.

import os

def _models_dir():
    """The project's models3d/: a sibling of the scenes3d/ folder the scene
    (or its snapshot) was loaded from. Models belong to the project."""
    p = os.path.dirname(os.path.abspath(args.scene))
    while p and os.path.basename(p) != "scenes3d" and os.path.dirname(p) != p:
        p = os.path.dirname(p)
    if os.path.basename(p) == "scenes3d":
        return os.path.join(os.path.dirname(p), "models3d")
    return os.environ.get("KOI_MODELS_DIR") or os.path.join(os.path.expanduser("~"), ".koi", "models3d")


MODELS_DIR = _models_dir()


def model_glb(ref):
    ref = str(ref or "")
    if not ref:
        return None
    if os.path.isabs(ref):
        return ref if os.path.exists(ref) else None
    p = os.path.join(MODELS_DIR, ref, "model.glb")
    return p if os.path.exists(p) else None


def import_model(ref, name, parent=None):
    """Import a model under a holder empty; returns (holder, min, max) in
    the holder's frame, or None (the caller falls back to its own shape)."""
    path = model_glb(ref)
    if not path:
        print(f"[scene3d] model not found: {ref}", file=sys.stderr)
        return None
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception as e:
        print(f"[scene3d] model import failed ({ref}): {e}", file=sys.stderr)
        return None
    new = [o for o in bpy.data.objects if o not in before]
    holder = empty(name, (0, 0, 0), parent)
    for o in new:
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)
    new = [o for o in bpy.data.objects if o not in before and o is not holder]
    for o in new:
        if o.parent is None or o.parent not in new:
            o.parent = holder
        for sl in getattr(o, "material_slots", []):
            m_ = sl.material
            if m_ and m_.node_tree:  # Workbench shows diffuse_color
                b_ = m_.node_tree.nodes.get("Principled BSDF")
                if b_:
                    m_.diffuse_color = tuple(b_.inputs["Base Color"].default_value)
    bpy.context.view_layer.update()
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    inv = holder.matrix_world.inverted()
    for o in new:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = inv @ (o.matrix_world @ Vector(c))
            mn = Vector((min(mn.x, w.x), min(mn.y, w.y), min(mn.z, w.z)))
            mx = Vector((max(mx.x, w.x), max(mx.y, w.y), max(mx.z, w.z)))
    if mx.x < mn.x:
        mn, mx = Vector((0, 0, 0)), Vector((0, 0, 0))
    return holder, mn, mx


# ─────────────────────────────────────────────────────────────── set ──

SETD = S.get("set") or {}
set_kind = SETD.get("type") or "room"
W, D, H = (list(SETD.get("size") or [8, 8, 3]) + [3])[:3]
floor_col = SETD.get("floorColor") or ("#8a8884" if set_kind != "exterior" else "#7d8a6a")
wall_col = SETD.get("wallColor") or "#d9cdb8"

# A modeled set replaces the procedural shell (floor, walls, ceiling).
SET_MODEL = import_model(SETD.get("model"), "set_model") if SETD.get("model") else None

# Floor (large for exteriors so the horizon never shows an edge).
fw, fd = (W, D) if set_kind == "room" else (max(W, 80), max(D, 80))
if not SET_MODEL:
    mesh_obj("floor", [(-fw / 2, -fd / 2, 0), (fw / 2, -fd / 2, 0), (fw / 2, fd / 2, 0), (-fw / 2, fd / 2, 0)],
             [(0, 1, 2, 3)], material("floor", floor_col, 0.9))

if set_kind == "room" and not SET_MODEL:
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
    "car": [1.8, 4.5, 1.45], "racecar": [2.0, 5.6, 1.0], "van": [2.0, 5.0, 2.2], "truck": [2.5, 7.5, 3.3], "bus": [2.55, 12.0, 3.1],
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


def _mix_hex(a, b, t):
    ca, cb = a.lstrip("#"), b.lstrip("#")
    va = [int(ca[i:i + 2], 16) for i in (0, 2, 4)]
    vb = [int(cb[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(va, vb))


def _lane_fit(keys, vk, dur):
    """A zoom / focus lane inside its shot: keys left past the end (the shot
    was shortened after they were set) fold into one key at the end, holding
    the value the lane had there, so every key sits on the shot and can be
    picked."""
    ks = sorted((dict(x) for x in keys or [] if isinstance(x, dict) and isinstance(x.get(vk), (int, float))),
                key=lambda x: int(x.get("t") or 0))
    inside = [x for x in ks if 0 <= int(x.get("t") or 0) <= dur]
    past = [x for x in ks if int(x.get("t") or 0) > dur]
    for x in ks:
        if int(x.get("t") or 0) < 0:
            x["t"] = 0
            inside.insert(0, x)
    if not past:
        return inside
    after = past[0]
    v = float(after[vk])
    if inside:
        before = inside[-1]
        t0, t1 = int(before.get("t") or 0), int(after.get("t") or 0)
        v = float(before[vk]) + (v - float(before[vk])) * (dur - t0) / max(1, t1 - t0)
    inside = [x for x in inside if int(x.get("t") or 0) != dur]
    return inside + [{**after, "t": dur, vk: round(v, 3)}]


# Props the scene gives no colour: muted mid tones (wood, stone, canvas,
# slate), one per prop and always the same for it. One light default (it was
# #c9c1b4) turned a whole set near-white in full sun — no contrast at all.
PROP_PALETTE = ["#8a6a45", "#9a8f7e", "#a58f74", "#6f7a8a", "#7d7468", "#8a9a7a", "#b39a78", "#6b5a4a"]


def build_prop(p, parent=None):
    kind = (p.get("shape") or p.get("kind") or "box").lower()
    pid = p.get("id") or kind
    col = p.get("color") or PROP_PALETTE[zlib.crc32(str(pid).encode()) % len(PROP_PALETTE)]
    m = material(f"prop_{pid}", col, 0.7)
    root = empty(f"prop_{pid}", (0, 0, 0))
    sz = p.get("size")
    dflt = PROP_SIZES.get(kind, [1, 1, 1])
    sx, sy, sz_ = (list(sz or dflt) + dflt[len(sz or []):])[:3]
    fx, fy, fz = sx / dflt[0], sy / dflt[1], sz_ / dflt[2]
    got = import_model(p.get("model"), f"{pid}_model", root) if p.get("model") else None
    if got:
        # Modeled at its real size; an explicit size scales it uniformly
        # (never distorts it) by its longest given axis.
        holder, mn_, mx_ = got
        ext = mx_ - mn_
        k_ = 1.0
        if sz:
            axes = [(float(v), e) for v, e in zip(list(sz)[:3], (ext.x, ext.y, ext.z)) if e > 1e-6]
            if axes:
                v_, e_ = max(axes, key=lambda a: a[0])
                k_ = v_ / e_
        holder.scale = (k_, k_, k_)
        root.location = v3(p.get("position"))
        root.rotation_euler = _rot3(p.get("rotation"))
        root["h"] = float(ext.z * k_)
        root["kind"] = kind
        return root
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

    def tyres(xs, ys, r, wdt, rim_r=None):
        """Tyre + rim (a lighter disc just proud of the tyre's outer face)."""
        rim = material("rim", "#a9adb3", 0.35)
        for x in xs:
            for y in ys:
                Hcyl("tyre", x, y, r, wdt, r, tyre)
                Hcyl("rim", x, y, r, wdt + 0.02, rim_r or r * 0.62, rim)  # proud of both faces

    def Profile(name, pts, width, top=1.0, mat=m, x=0.0, bevel=0.035):
        """Bodywork from a SIDE PROFILE: the closed outline pts [(y, z)] in
        the prop's default frame, extruded across x to [width], narrowing to
        [top] x the width at its highest point (tumblehome), edges bevelled.
        Reads as a real car body where stacked boxes read as toys."""
        zs = [z for _, z in pts]
        z0, z1 = min(zs), max(zs)
        verts = []
        for side in (-1, 1):
            for (y, z) in pts:
                k = 1.0 + (top - 1.0) * ((z - z0) / max(1e-6, z1 - z0))
                verts.append(((x + side * width * k / 2) * fx, y * fy, z * fz))
        n = len(pts)
        faces = [list(range(n))[::-1], list(range(n, 2 * n))]
        for i in range(n):
            j = (i + 1) % n
            faces.append([i, j, n + j, n + i])
        ob = mesh_obj(f"{pid}_{name}", verts, faces, mat, root)
        try:
            me = ob.data
            import bmesh as _bm
            bm = _bm.new()
            bm.from_mesh(me)
            _bm.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(me)
            bm.free()
            mod = ob.modifiers.new("bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 2
            mod.limit_method = "ANGLE"
            mod.angle_limit = math.radians(40)
            for poly in me.polygons:
                poly.use_smooth = True
            ob.modifiers.new("normals", "WEIGHTED_NORMAL").keep_sharp = True
        except Exception as e_:
            print(f"[scene3d] profile {name}: {e_}", file=sys.stderr)
        return ob

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
        # The top a shade lighter than the body: a fixed pale worktop on a
        # 28 m market counter in full sun read as one white band.
        P("box", "top", 0, 0, dflt[2] - 0.04, dflt[0] + 0.02, dflt[1] + 0.02, 0.04,
          material(f"worktop_{pid}", p.get("topColor") or _mix_hex(col, "#ffffff", 0.3)))
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
        # Sedan built from its side profile: bonnet, raked windscreen, roof,
        # rear window and boot; glass house narrowing over the body; tyres
        # with rims, lights and mirrors. Nose at +y.
        Profile("body", [(-2.3, 0.32), (2.3, 0.32), (2.34, 0.5), (2.28, 0.72), (2.05, 0.85), (0.98, 0.99),
                         (-1.75, 1.01), (-2.2, 0.97), (-2.31, 0.76), (-2.34, 0.5)], 1.8, top=0.96)
        Profile("glasshouse", [(0.99, 0.97), (0.2, 1.39), (-0.98, 1.41), (-1.8, 0.99)], 1.62, top=0.8, mat=glass, bevel=0.03)
        Profile("roof", [(0.25, 1.36), (0.2, 1.42), (-0.98, 1.44), (-1.05, 1.38)], 1.32, top=0.98, bevel=0.02)
        for ix in (-1, 1):
            P("box", "pillar_b", ix * 0.72, -0.38, 1.0, 0.05, 0.12, 0.38)
            P("box", "headlight", ix * 0.6, 2.26, 0.62, 0.42, 0.06, 0.12, light)
            P("box", "taillight", ix * 0.62, -2.3, 0.76, 0.38, 0.05, 0.11, material("taillight", "#b0201a", 0.3, emission="#7a1410"))
            P("box", "mirror", ix * 0.97, 0.82, 0.92, 0.16, 0.1, 0.09)
        P("box", "grille", 0, 2.32, 0.48, 0.7, 0.04, 0.14, dark)
        tyres((-0.79, 0.79), (-1.42, 1.4), 0.34, 0.24)
    elif kind == "racecar":
        # Open-wheel single-seater (Formula 1) from its side profiles: the
        # needle nose rising to the cockpit, the airbox above the driver, the
        # engine cover falling to the rear; sidepods; wings with endplates;
        # halo; exposed wheels on their suspension arms. Nose at +y.
        carbon = material("carbon", "#1e2125", 0.35)
        Profile("chassis", [(2.78, 0.12), (2.7, 0.22), (1.6, 0.33), (0.75, 0.5), (0.45, 0.63), (0.05, 0.6),
                            (-0.28, 0.99), (-0.8, 0.99), (-1.45, 0.72), (-2.1, 0.5), (-2.32, 0.32), (-2.32, 0.1)],
                0.62, top=0.5, bevel=0.03)
        Profile("sidepods", [(0.62, 0.12), (0.56, 0.5), (0.2, 0.57), (-1.2, 0.46), (-1.75, 0.22), (-1.82, 0.1)],
                1.42, top=0.72, bevel=0.04)
        P("box", "cockpit", 0, 0.22, 0.6, 0.36, 0.52, 0.03, carbon)
        P("box", "intake", 0, -0.3, 0.86, 0.2, 0.04, 0.12, carbon)
        P("box", "floor", 0, -0.4, 0.04, 1.5, 3.8, 0.04, carbon)
        P("box", "front_wing", 0, 2.56, 0.06, 1.95, 0.5, 0.035, carbon)
        P("box", "front_flap", 0, 2.44, 0.1, 1.9, 0.24, 0.035)
        P("box", "rear_wing", 0, -2.55, 0.86, 1.0, 0.36, 0.045)
        P("box", "rear_flap", 0, -2.47, 0.94, 0.98, 0.18, 0.035, carbon)
        P("box", "beam_wing", 0, -2.45, 0.38, 0.9, 0.2, 0.03, carbon)
        P("box", "rw_pylon", 0, -2.38, 0.36, 0.05, 0.16, 0.52, carbon)
        P("wedge", "diffuser", 0, -2.1, 0.04, 1.1, 0.5, 0.2, carbon, rot=(0, 0, math.pi))
        P("box", "halo_front", 0, 0.46, 0.6, 0.05, 0.05, 0.24, carbon)
        P("box", "halo_top", 0, 0.16, 0.82, 0.46, 0.08, 0.045, carbon)
        for ix in (-1, 1):
            P("box", "fw_endplate", ix * 0.97, 2.52, 0.03, 0.03, 0.58, 0.26, carbon)
            P("box", "rw_endplate", ix * 0.5, -2.52, 0.4, 0.03, 0.52, 0.56, carbon)
            P("box", "halo_side", ix * 0.22, 0.14, 0.8, 0.05, 0.6, 0.045, carbon)
            P("box", "mirror", ix * 0.5, 0.6, 0.66, 0.15, 0.07, 0.07, carbon)
            for y_, x_ in ((1.7, 0.82), (-1.78, 0.84)):
                P("box", "arm_hi", ix * (0.2 + x_) / 2, y_, 0.38, x_ - 0.2, 0.05, 0.03, carbon)
                P("box", "arm_lo", ix * (0.2 + x_) / 2, y_, 0.2, x_ - 0.2, 0.05, 0.03, carbon)
        tyres((-0.82, 0.82), (1.7,), 0.33, 0.32, rim_r=0.19)
        tyres((-0.84, 0.84), (-1.78,), 0.36, 0.42, rim_r=0.2)
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
    root["kind"] = kind
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
    """Abstract BLOCK FIGURE (default look): a faceted head, a slab trunk,
    block arms and legs. It shows WHERE someone is, where they go, which way
    they face and the exact BODY POSE of the moment (POSES), held still and
    switched in one step. It never performs: no walk cycle, no crouch before a
    jump, no gesture or strike, because the video model copies any limb motion
    it sees. Arms move only to hold, take or hand over an object."""
    cid = c.get("id") or f"char{idx}"
    h = float(c.get("height") or 1.75)
    k = h / 1.75
    tint = c.get("color") or CHAR_PALETTE[idx % len(CHAR_PALETTE)]
    clay = material(f"clay_{cid}", _mix_hex("#d2d0cc", tint, 0.38), 0.6)
    K = lambda *v: tuple(x * k for x in v)
    root = empty(f"char_{cid}", v3(c.get("position")))
    hips = empty(f"{cid}_hips", K(0, 0, 0.95), root)
    instance("box", f"{cid}_torso", K(0, 0, 1.215), K(0.36, 0.2, 0.53), clay, hips)
    instance("facet", f"{cid}_head", K(0, 0.01, 1.625), K(0.105, 0.105, 0.115), clay, hips)
    # Front and back must read at a glance, also lying down: eyes and a pale
    # chest in front, a dark back behind, feet pointing forward.
    dark, pale = material("figure_dark", "#17171a", 0.7), material("figure_pale", "#f2efe8", 0.7)
    instance("box", f"{cid}_chestmark", K(0, 0.104, 1.27), K(0.28, 0.012, 0.32), pale, hips)
    instance("box", f"{cid}_backmark", K(0, -0.104, 1.215), K(0.3, 0.012, 0.46), dark, hips)
    neck = empty(f"{cid}_neck", K(0, 0, 1.49), hips)
    parts = {"root": root, "hips": hips, "neck": neck}
    for side, sx in (("L", -1), ("R", 1)):
        x = sx * 0.225 * k
        instance("box", f"{cid}_eye{side}", K(sx * 0.04, 0.108, 1.645), K(0.04, 0.02, 0.035), dark, hips)
        sh = empty(f"{cid}_shoulder{side}", (x, 0, 1.45 * k), hips)
        el = empty(f"{cid}_elbow{side}", (x, 0, 1.11 * k), sh)
        instance("box", f"{cid}_upperarm{side}", (x, 0, 1.28 * k), K(0.09, 0.1, 0.34), clay, sh)
        instance("box", f"{cid}_forearm{side}", (x, 0, 0.94 * k), K(0.08, 0.09, 0.34), clay, el)
        hp = empty(f"{cid}_hip{side}", (sx * 0.09 * k, 0, 0.95 * k), hips)
        kn = empty(f"{cid}_knee{side}", (sx * 0.09 * k, 0, 0.5 * k), hp)
        instance("box", f"{cid}_thigh{side}", (sx * 0.09 * k, 0, 0.725 * k), K(0.15, 0.18, 0.45), clay, hp)
        instance("box", f"{cid}_shin{side}", (sx * 0.09 * k, 0, 0.25 * k), K(0.15, 0.18, 0.5), clay, kn)
        instance("box", f"{cid}_toe{side}", (sx * 0.09 * k, 0.15 * k, 0.04 * k), K(0.15, 0.13, 0.08), dark, kn)
        parts.update({f"shoulder{side}": sh, f"elbow{side}": el, f"hip{side}": hp, f"knee{side}": kn})
    parts.update(height=h, k=k, idx=idx, id=cid, mask=MASK_PALETTE[idx % len(MASK_PALETTE)], rigid=True,
                 meshes=[o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith(f"{cid}_")])
    CHARS[cid] = parts
    return parts


CHARACTER_STYLE = (S.get("characterStyle") or "block").lower()
for i, c in enumerate(S.get("characters") or []):
    # Always the rigid figure (user rule): any limb on screen gets copied by
    # the video model. The articulated mannequin stays only for reference.
    build_block_figure(c, i)


def body_point(ch, frac):
    """The point at "frac" of the height along the body AS IT IS POSED (the
    hips carry trunk and head): a seated or lying figure is framed where its
    head really is, not where it would be standing."""
    if ch.get("rigid"):
        local = Vector((0, 0, (frac * 1.75 - 0.95) * ch["k"]))
        return ch["hips"].matrix_world @ local
    return ch["root"].matrix_world.translation + Vector((0, 0, frac * ch["height"]))


def char_head(cid):
    ch = CHARS.get(cid)
    if not ch:
        return None
    return body_point(ch, 1.62 / 1.75)


# ─────────────────────────────────────────────────────────── actions ──


def resolve_point(t, default=None):
    """"[x,y]", "[x,y,z]", a character id, "camera" or a prop id."""
    if t is None:
        return default
    if isinstance(t, (list, tuple)):
        return v3(t)
    if isinstance(t, str):
        if t in CHARS:
            return CHARS[t]["root"].matrix_world.translation.copy()
        if t.startswith("char:") and t[5:] in CHARS:
            return CHARS[t[5:]]["root"].matrix_world.translation.copy()
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


# Held body shapes. hips: trunk rotation in degrees (x > 0 leans back,
# 90 = flat on the back; y rolls onto a side). seat: hips height when the
# body rests on a seat (else it is lowered until it touches the ground).
# Joints in degrees, "L"/"R" or both: hip.x > 0 leg forward, knee.x < 0 shin
# back, shoulder.x > 0 arm forward, shoulder.y > 0 arm out to the side
# (mirrored per side), elbow.x > 0 forearm forward.
POSES = {
    "standing": {"hips": (0, 0, 0), "seat": 0.95, "elbow": (6, 0, 0)},
    "sitting": {"hips": (0, 0, 0), "seat": 0.54, "hip": (90, 0, 0), "knee": (-90, 0, 0),
                "shoulder": (20, 0, 0), "elbow": (60, 0, 0)},
    "riding": {"hips": (-18, 0, 0), "seat": 0.54, "hip": (80, 6, 0), "knee": (-100, 0, 0),
               "shoulder": (62, 0, 0), "elbow": (18, 0, 0)},
    "driving": {"hips": (8, 0, 0), "seat": 0.54, "hip": (85, 0, 0), "knee": (-70, 0, 0),
                "shoulder": (55, 0, 0), "elbow": (35, 0, 0)},
    "lying": {"hips": (90, 0, 0), "elbow": (4, 0, 0)},
    "lying_front": {"hips": (-90, 0, 0), "elbow": (4, 0, 0)},
    "lying_side": {"hips": (90, 90, 0), "hip": (30, 0, 0), "knee": (-45, 0, 0),
                   "shoulder": (40, 0, 0), "elbow": (40, 0, 0)},
    "on_elbow": {"hips": (60, 0, 0), "hip": (30, 0, 0),
                 "L": {"shoulder": (-60, 8, 0), "elbow": (90, 0, 0)},
                 "R": {"shoulder": (0, 0, 0), "elbow": (10, 0, 0)}},
    "sitting_ground": {"hips": (10, 0, 0), "hip": (80, 4, 0), "knee": (-20, 0, 0),
                       "shoulder": (-30, 10, 0), "elbow": (0, 0, 0)},
    "kneeling": {"hips": (0, 0, 0), "elbow": (10, 0, 0),
                 "L": {"hip": (90, 0, 0), "knee": (-90, 0, 0)},
                 "R": {"hip": (0, 0, 0), "knee": (-90, 0, 0)}},
    "kneeling_both": {"hips": (0, 0, 0), "knee": (-90, 0, 0), "elbow": (10, 0, 0)},
    "crouching": {"hips": (-30, 0, 0), "hip": (120, 8, 0), "knee": (-140, 0, 0),
                  "shoulder": (45, 0, 0), "elbow": (40, 0, 0)},
    "all_fours": {"hips": (-90, 0, 0), "hip": (90, 0, 0), "knee": (-90, 0, 0), "shoulder": (90, 0, 0)},
}
POSE_ALIASES = {
    "stand": "standing", "sit": "sitting", "seated": "sitting", "ride": "riding",
    "drive": "driving", "lie": "lying", "lying_back": "lying", "supine": "lying",
    "prone": "lying_front", "lying_face_down": "lying_front", "on_side": "lying_side",
    "propped": "on_elbow", "propped_on_elbow": "on_elbow", "kneel": "kneeling",
    "crouch": "crouching", "squat": "crouching", "squatting": "crouching",
    "sit_ground": "sitting_ground", "sitting_on_ground": "sitting_ground",
}


def _pose_name(p):
    p = str(p or "standing").lower().strip().replace(" ", "_").replace("-", "_")
    p = POSE_ALIASES.get(p, p)
    return p if p in POSES else "standing"


def _local_chain(ob, root):
    m = Matrix.Identity(4)
    while ob is not None and ob != root:
        m = ob.matrix_basis @ m
        ob = ob.parent
    return m


def _lowest_z(ch):
    """Lowest point of the figure in its root frame, from the property values
    (no depsgraph: a pose set mid-bake is not evaluated yet)."""
    root, low = ch["root"], None
    for ob in ch["meshes"]:
        m = _local_chain(ob, root)
        for corner in ob.bound_box:
            z = (m @ Vector(corner)).z
            low = z if low is None or z < low else low
    return low or 0.0


def _set_pose(ch, pose, side=None):
    """One held body shape, never a motion (see POSES). side: which arm
    props an "on_elbow" body (default left)."""
    k, hips = ch["k"], ch["hips"]
    name = _pose_name(pose)
    P = POSES[name]
    R = math.radians
    hips.rotation_euler = tuple(R(v) for v in P.get("hips", (0, 0, 0)))
    hips.location.z = P.get("seat", 0.95) * k
    for s in ("L", "R"):
        own = s
        if name == "on_elbow" and str(side or "left").lower().startswith("r"):
            own = "R" if s == "L" else "L"
        per = P.get(own, {})
        mirror = -1 if s == "R" else 1
        for joint, rest in (("hip", (0, 0, 0)), ("knee", (0, 0, 0)), ("shoulder", (0, 0, 0)), ("elbow", (6, 0, 0))):
            v = per.get(joint, P.get(joint, rest))
            ch[f"{joint}{s}"].rotation_euler = (R(v[0]), R(v[1]) * mirror, R(v[2]) * mirror)
    if "seat" not in P:
        hips.location.z += -_lowest_z(ch)
    ch["pose"] = name


def _key_pose(ch, frame):
    key(ch["hips"], "location", frame)
    key(ch["hips"], "rotation_euler", frame)
    for part in JOINTS:
        key(ch[part], "rotation_euler", frame)


def _switch_pose(ch, f0, f1, pose, side=None):
    """The old shape is held until the frame before f1 and the new one is
    there AT f1: a one-frame cut, no in-between motion for the video model
    to copy."""
    _key_pose(ch, max(1, f1 - 1))
    _set_pose(ch, pose, side)
    _key_pose(ch, f1)


def _prop_track(pid):
    """Where a driven prop is at a frame, before its "drive" legs are baked
    (the same legs, waits and steady speed); zero when nobody is aboard."""
    ob = bpy.data.objects.get(f"prop_{pid}") if pid else None
    legs = sorted([d for d in (S.get("actions") or []) if (d.get("type") or "").lower() == "drive"
                   and d.get("prop") == pid and isinstance(d.get("to"), (list, tuple)) and len(d["to"]) >= 2],
                  key=lambda d: int(d.get("startMs") or 0))
    if ob is None or not legs:
        here = ob.location.copy() if ob is not None else Vector((0, 0, 0))
        return lambda fr: here.copy()
    pts = [(ms_to_frame(legs[0].get("startMs") or 0), ob.location.copy())]
    for d in legs:
        f0 = ms_to_frame(d.get("startMs") or 0)
        f1 = max(f0 + 1, ms_to_frame(d.get("endMs") or (int(d.get("startMs") or 0) + 1000)))
        if f0 > pts[-1][0]:
            pts.append((f0, pts[-1][1].copy()))
        to = d["to"]
        pts.append((f1, Vector((float(to[0]), float(to[1]), float(to[2]) if len(to) > 2 else ob.location.z))))

    def at(fr):
        if fr <= pts[0][0]:
            return pts[0][1].copy()
        for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
            if fr <= t1:
                return p0.lerp(p1, (fr - t0) / max(1, t1 - t0))
        return pts[-1][1].copy()
    return at


# Per-character state machine baked as keyframes, sorted by start time.
for i, c in enumerate(S.get("characters") or []):
    cid = c.get("id") or f"char{i}"
    ch = CHARS[cid]
    root, hips = ch["root"], ch["hips"]
    root.rotation_euler = (0, 0, initial_facing(c))
    key(root, "location", 1)
    key(root, "rotation_euler", 1)
    _set_pose(ch, c.get("pose"), c.get("poseSide"))
    _key_pose(ch, 1)

_HELD_SHAPE = ("turn", "face", "pose", "lie", "lie_down", "sit", "sit_down", "stand", "stand_up", "get_up")
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

    # A falling body answers to its fall alone: _physics.js warns about these.
    if typ in _HELD_SHAPE and any((b.get("type") or "").lower() in ("tumble", "impact") and b.get("character") == cid
                                  and ms_to_frame(b.get("startMs")) <= f0
                                  and f1 <= max(ms_to_frame(b.get("startMs")) + 1, ms_to_frame(b.get("endMs") or 0)) for b in acts):
        print(f"[scene3d] ignored {typ} of {cid} at {a.get('startMs')} ms: inside its fall", flush=True)
        continue

    if typ in ("walk", "run", "move"):
        src = root.location.copy()
        dst = resolve_point(a.get("to"), src)
        to = a.get("to")
        dst = Vector((dst.x, dst.y, dst.z if isinstance(to, (list, tuple)) and len(to) > 2 else src.z))
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

    elif typ == "jump":
        # One rigid body on a true ballistic arc from the duration (gravity
        # sets the height); the video model performs take-off and landing.
        src = root.location.copy()
        dst = resolve_point(a.get("to"), src)
        to = a.get("to")
        dst = Vector((dst.x, dst.y, dst.z if isinstance(to, (list, tuple)) and len(to) > 2 else src.z))
        span = f1 - f0
        fa = f0 + max(1, min(int(0.3 * FPS), span // 5))
        fl = f1 - max(1, min(int(0.4 * FPS), span // 4))
        fl = max(fa + 2, fl)
        f1 = max(fl + 1, f1)
        air = (fl - fa) / FPS
        key(root, "location", f0)
        key(root, "location", fa)
        yaw = yaw_to(src, dst)
        if yaw is not None:
            key(root, "rotation_euler", f0)
            cur = root.rotation_euler.z
            root.rotation_euler.z = cur + (yaw - cur + math.pi) % (2 * math.pi) - math.pi
            key(root, "rotation_euler", fa)
        for fr in range(fa + 1, fl + 1):
            u = (fr - fa) / (fl - fa)
            p = src.lerp(dst, u)
            p.z += 0.5 * 9.81 * air * air * u * (1 - u)
            root.location = p
            key(root, "location", fr)

    elif typ == "tumble":
        # A body thrown along a surface: a constant-friction stop (speed dies
        # linearly, none left at f1), turning head over heels (or log-rolling,
        # roll:"side") in step with the distance, the lowest point on the
        # surface. Aboard a vehicle the stop is relative to it.
        src = root.location.copy()
        dst = resolve_point(a.get("to"), src)
        to = a.get("to")
        dst = Vector((dst.x, dst.y, dst.z if isinstance(to, (list, tuple)) and len(to) > 2 else src.z))
        span = f1 - f0
        track = _prop_track(a.get("aboard"))
        at_f0, at_f1 = track(f0), track(f1)
        rel0, rel1 = src - at_f0, dst - at_f1
        path = rel1 - rel0
        yaw = yaw_to((0, 0), path) if path.to_2d().length > 1e-3 else root.rotation_euler.z
        side = str(a.get("roll") or "forward").lower() == "side"
        back = str(a.get("roll") or "forward").lower() == "backward"
        if back:
            yaw += math.pi
        elif side:
            yaw += math.pi / 2
        end = _pose_name(a.get("pose") or "lying_front")
        turns = a.get("turns")
        turns = max(0.5, float(turns)) if isinstance(turns, (int, float)) else max(1, round(path.to_2d().length / (1.4 if side else 2.8)))
        _key_pose(ch, max(1, f0 - 1))
        key(root, "location", max(1, f0 - 1))
        key(root, "rotation_euler", max(1, f0 - 1))
        # A tumble right after another is the same fall going on: the body keeps
        # its shape. Only a leg that really rolls lines the body up across its
        # path; one that does not roll (still in the air, sliding) keeps its
        # heading, since nothing pushes it round, and leans over its whole length.
        chained = abs((ch.get("tumble_end") or -99) - f0) <= 1
        rolls = round(turns) >= 1
        yaw0 = root.rotation_euler.z
        yaw1 = yaw0 + (yaw - yaw0 + math.pi) % (2 * math.pi) - math.pi if rolls else yaw0
        was = {j: ch[j].rotation_euler.to_quaternion() for j in JOINTS}
        was_hips = hips.rotation_euler.to_quaternion()
        if not chained:
            _set_pose(ch, "lying" if side else "crouching")
        limbs = {j: ch[j].rotation_euler.to_quaternion() for j in JOINTS}
        start = hips.rotation_euler.copy()
        goal = POSES[end].get("hips", (0, 0, 0))
        spin0 = start.y if side else start.x
        if side:
            # A log roll keeps the head where it is: face down is half a turn
            # about the long axis, not the head-swapped trunk of the end pose.
            target = math.pi if goal[0] < 0 else math.radians(goal[1])
            spin1 = spin0 + (target - spin0 + math.pi) % (2 * math.pi) - math.pi + 2 * math.pi * round(turns)
        else:
            # Lands on the end pose's own trunk angle, so the last switch barely shows.
            spin1 = (math.radians(goal[1]) + 2 * math.pi * round(turns)) if back else (math.radians(goal[0]) - 2 * math.pi * round(turns))
            if back:
                spin1 += math.radians(goal[0] - goal[1])
        settle = 0 if chained else (float(span) if not rolls else max(1.0, 0.2 * FPS))
        for fr in range(f0, f1):
            u = (fr - f0) / span
            s = 1 - (1 - u) ** 2
            root.location = track(fr) + rel0.lerp(rel1, s)
            key(root, "location", fr)
            w = min(1.0, (fr - f0) / settle) if settle else 1.0
            root.rotation_euler.z = yaw0 + (yaw1 - yaw0) * (u if chained or side else w)
            key(root, "rotation_euler", fr)
            ang = spin0 + (spin1 - spin0) * s
            trunk = (start.x, ang, start.z) if side else (ang, start.y, start.z)
            if w < 1:
                hips.rotation_euler = was_hips.slerp(Euler(trunk, "XYZ").to_quaternion(), w).to_euler("XYZ", hips.rotation_euler)
                for j in JOINTS:
                    ch[j].rotation_euler = was[j].slerp(limbs[j], w).to_euler("XYZ", ch[j].rotation_euler)
            else:
                hips.rotation_euler = trunk
                for j in JOINTS:
                    ch[j].rotation_euler = limbs[j].to_euler("XYZ", ch[j].rotation_euler)
            hips.location.z = 0
            hips.location.z = -_lowest_z(ch)
            _key_pose(ch, fr)
        root.location = dst
        key(root, "location", f1)
        root.rotation_euler.z = yaw1
        key(root, "rotation_euler", f1)
        if side:
            hips.rotation_euler = (start.x, spin1, start.z)
            _set_trunk = hips.rotation_euler.copy()
            _set_pose(ch, end, a.get("side"))
            hips.rotation_euler = _set_trunk
            hips.location.z = 0
            hips.location.z = -_lowest_z(ch)
            _key_pose(ch, f1)
        else:
            _switch_pose(ch, f1, f1, end, a.get("side"))
        ch["tumble_end"] = f1

    elif typ == "impact":
        # A simulated body (_ragdoll-py.js): plays the stored run on the figure.
        # Slow motion only spreads the same run over more frames.
        sim = a.get("sim") or {}
        raw = base64.b64decode(sim.get("data") or "")
        if not raw:
            continue
        vals = struct.unpack("<%df" % (len(raw) // 4), raw)
        width, count, rate = int(sim["width"]), int(sim["n"]), float(sim["fps"])
        slow = max(1.0, float(a.get("slowMotion") or 1))
        order = sim["parts"]
        links = {"upperarmL": ("trunk", "shoulderL"), "forearmL": ("upperarmL", "elbowL"),
                 "upperarmR": ("trunk", "shoulderR"), "forearmR": ("upperarmR", "elbowR"),
                 "thighL": ("trunk", "hipL"), "shinL": ("thighL", "kneeL"),
                 "thighR": ("trunk", "hipR"), "shinR": ("thighR", "kneeR")}

        def _sim_row(i):
            row = vals[i * width:(i + 1) * width]
            return Vector(row[:3]), {n: Quaternion(row[3 + 4 * j:7 + 4 * j]) for j, n in enumerate(order)}

        track = _prop_track(a.get("aboard"))
        src = root.location.copy()
        rel0 = src - track(f0)
        floor_z = a.get("surfaceZ")
        drop = float(floor_z) - src.z if floor_z is not None else 0.0
        f_end = f0 + max(1, int(math.ceil((count - 1) / rate * slow * FPS)))
        yaw_q = Euler((0, 0, root.rotation_euler.z), "XYZ").to_quaternion()
        was = {j: ch[j].rotation_euler.to_quaternion() for _, j in links.values()}
        was["hips"] = hips.rotation_euler.to_quaternion()
        was_z = hips.location.z
        blend = 0.12 * slow * FPS
        _key_pose(ch, max(1, f0 - 1))
        key(root, "location", max(1, f0 - 1))
        for fr in range(f0, f_end + 1):
            pos = min(count - 1.0, (fr - f0) / FPS / slow * rate)
            i = min(count - 2, int(pos)) if count > 1 else 0
            u = pos - i
            p0, q0 = _sim_row(i)
            p1, q1 = _sim_row(min(count - 1, i + 1))
            p = p0.lerp(p1, u)
            q = {n: q0[n].slerp(q1[n], u) for n in order}
            w = min(1.0, (fr - f0) / blend) if blend > 0 else 1.0
            w = w * w * (3 - 2 * w)
            root.location = track(fr) + rel0 + Vector((p.x, p.y, drop * w))
            key(root, "location", fr)
            hq = was["hips"].slerp(yaw_q.inverted() @ q["trunk"], w)
            hips.rotation_euler = hq.to_euler("XYZ", hips.rotation_euler)
            hips.location = (0, 0, was_z + (p.z - was_z) * w)
            for part, (parent, joint) in links.items():
                jq = was[joint].slerp(q[parent].inverted() @ q[part], w)
                ch[joint].rotation_euler = jq.to_euler("XYZ", ch[joint].rotation_euler)
            _key_pose(ch, fr)
        ch["pose"] = _pose_name((a.get("simReport") or {}).get("rest") or "lying")

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
        _switch_pose(ch, f0, f1, "sitting")

    elif typ in ("stand", "stand_up", "get_up"):
        _switch_pose(ch, f0, f1, "standing")

    elif typ in ("lie", "lie_down"):
        _switch_pose(ch, f0, f1, a.get("pose") or "lying", a.get("side"))

    elif typ == "pose":
        _switch_pose(ch, f0, f1, a.get("pose"), a.get("side"))

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
        # No leg swing (the video model performs the kick): only the ball flies.
        mid = (f0 + f1) // 2
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

# ───────────────────────────────────────────────────────── vehicles ──
# "drive": a prop travels to "to" over [startMs, endMs], nose first (heading
# from the path, eased through each waypoint); legs chain. "ride": a character
# sits in a prop and travels with it (the driver of a car, a pilot).
_SEATS = {  # character root in the vehicle's frame (sitting: hips 0.54 m above it)
    "racecar": (0.0, -0.1, -0.4), "car": (-0.37, -0.1, -0.1), "van": (-0.5, 1.3, 0.36),
    "truck": (-0.6, 2.8, 0.95), "bus": (-0.8, 5.2, 0.55), "motorbike": (0.0, -0.25, 0.26),
    "bicycle": (0.0, -0.2, 0.36),
}


def _prop_ob(pid):
    return bpy.data.objects.get(f"prop_{pid}") if pid else None


_legs = {}
for a in acts:
    if (a.get("type") or "").lower() == "drive" and _prop_ob(a.get("prop")) is not None \
            and isinstance(a.get("to"), (list, tuple)) and len(a["to"]) >= 2:
        _legs.setdefault(a["prop"], []).append(a)
for pid, legs in _legs.items():
    ob = _prop_ob(pid)
    z0 = ob.location.z
    pts = [(ms_to_frame(legs[0].get("startMs") or 0), ob.location.copy())]
    for a in legs:
        f0 = ms_to_frame(a.get("startMs") or 0)
        f1 = max(f0 + 1, ms_to_frame(a.get("endMs") or (int(a.get("startMs") or 0) + 1000)))
        if f0 > pts[-1][0]:
            pts.append((f0, pts[-1][1].copy()))  # waits where it is until this leg
        to = a["to"]
        pts.append((f1, Vector((float(to[0]), float(to[1]), float(to[2]) if len(to) > 2 else z0))))
    yaw_prev = ob.rotation_euler.z
    for i, (fr, pt) in enumerate(pts):
        dirs = []
        if i > 0:
            dirs.append((pt - pts[i - 1][1]).to_2d())
        if i + 1 < len(pts):
            dirs.append((pts[i + 1][1] - pt).to_2d())
        dirs = [d.normalized() for d in dirs if d.length > 1e-3]
        yaw = yaw_prev
        if dirs:
            d = sum(dirs, Vector((0.0, 0.0)))
            if d.length > 1e-6:
                yaw = math.atan2(-d.x, d.y)  # nose at +y, like yaw_to
        while yaw - yaw_prev > math.pi:
            yaw -= 2 * math.pi
        while yaw - yaw_prev < -math.pi:
            yaw += 2 * math.pi
        yaw_prev = yaw
        ob.location = pt
        ob.rotation_euler.z = yaw
        ob.keyframe_insert("location", frame=fr)
        ob.keyframe_insert("rotation_euler", frame=fr)
    set_key_interp(ob, "LINEAR")  # a steady speed along each leg

for a in acts:
    if (a.get("type") or "").lower() != "ride":
        continue
    ch, ob = CHARS.get(a.get("character")), _prop_ob(a.get("prop"))
    if not ch or ob is None:
        continue
    seat = Vector([float(v) for v in (a.get("seat") or _SEATS.get(ob.get("kind"), (0.0, 0.0, 0.0)))][:3])
    root = ch["root"]
    kind = str(ob.get("kind") or "")
    shape = a.get("pose") or ("riding" if kind in ("motorbike", "bicycle", "horse", "scooter") else
                              "driving" if kind in ("car", "racecar", "van", "truck", "bus") else "sitting")
    if a.get("startMs") is None:
        _set_pose(ch, shape)
        _key_pose(ch, 1)
    else:
        fa = ms_to_frame(a.get("startMs"))
        _switch_pose(ch, fa, max(2, fa), shape)
    if a.get("endMs") is not None:
        fe = ms_to_frame(a.get("endMs"))
        _switch_pose(ch, fe, fe + 1, "standing")
    if a.get("startMs") is None and a.get("endMs") is None:
        # The whole scene in it: seated in the vehicle, moving with it.
        if root.animation_data:
            root.animation_data_clear()
        root.parent = ob
        root.location = seat
        root.rotation_euler = (0, 0, 0)
    else:
        fa = ms_to_frame(a.get("startMs") or 0)
        fb = ms_to_frame(a.get("endMs")) if a.get("endMs") is not None else scn.frame_end
        for fr in range(fa, fb + 1):
            scn.frame_set(fr)
            mw = ob.matrix_world
            root.location = mw @ seat
            root.rotation_euler = (0, 0, mw.to_euler().z)
            root.keyframe_insert("location", frame=fr)
            root.keyframe_insert("rotation_euler", frame=fr)

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
        return ch["root"].matrix_world.translation.copy(), ch["height"], ch["root"].matrix_world.to_euler().z
    if isinstance(sid, list) and sid:
        pts = [CHARS[x]["root"].matrix_world.translation.copy() for x in sid if x in CHARS]
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
        pts = [CHARS[x]["root"].matrix_world.translation.copy() for x in subj if x in CHARS]
        spread = max((p - q).length for p in pts for q in pts)
        ext = max(ext, spread / aspect * 1.4)
    aim = base + Vector((0, 0, h * AIM_Z.get(size, 0.78)))
    if isinstance(subj, str) and subj in CHARS:
        aim = body_point(CHARS[subj], AIM_Z.get(size, 0.78))
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
    ch = CHARS.get(subj) if isinstance(subj, str) else None
    if ch and ch.get("rigid") and C.get("position") is None:
        m = ch["hips"].matrix_world.to_3x3()
        along = (m @ Vector((0, 0, 1))).normalized()  # towards the head
        if abs(along.z) < 0.5:
            # Lying: "frontal" is above the face. The camera comes from the
            # feet side so the face reads upright; "angle" rolls it round the
            # body, "height" sets how steeply it looks down.
            front = (m @ Vector((0, 1, 0))).normalized()
            front = Quaternion(along, ang) @ front
            tilt = {"overhead": 0.0, "top": 0.0, "high": 0.45, "low": 1.6, "ground": 2.5}.get(height, 1.0) \
                if isinstance(height, str) else 1.0
            v = (front - along * tilt).normalized()
            if v.z < 0.08:
                v = Vector((v.x, v.y, 0.08)).normalized()
            pos = aim + v * dist
    # Over-the-shoulder: slide behind the shoulder of "ots" character.
    if C.get("ots") and C["ots"] in CHARS:
        o = CHARS[C["ots"]]
        op = o["root"].matrix_world.translation
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
    # A shot trimmed on the montage keeps the camera of the window it was
    # staged for (camWindow): its move is solved over that window and the
    # shot only shows its part of it.
    cw = SHOT.get("camWindow")
    w_s, w_e = s_ms, e_ms
    if isinstance(cw, (list, tuple)) and len(cw) == 2:
        w_s, w_e = int(cw[0]), int(cw[0]) + max(200, int(cw[1]))
    f_ws, f_we = ms_to_frame(w_s), ms_to_frame(w_e)

    pos0, aim0 = explicit_or_framed(C, f_ws)
    if C.get("position") is None and FRAMING.get("lens"):
        lens = FRAMING["lens"]


    # Zoom keyed by hand on the stage: lens keys of their own, apart from
    # the pose keys (which then leave the focal length alone).
    LK = [(ms_to_frame(s_ms + int(x.get("t") or 0)), float(x["mm"])) for x in _lane_fit(C.get("lensKeys"), "mm", e_ms - s_ms)
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
        fr = f_ws
        while fr <= f_we:
            p, a = framing_pose(C, fr)
            place(p, a, FRAMING.get("lens", lens), fr)
            fr += step
        p, a = framing_pose(C, f_we)
        place(p, a, FRAMING.get("lens", lens), f_we)
    else:
        place(pos0, aim0, lens, f_ws)
        p1, a1, l1 = pos0.copy(), aim0.copy(), lens
        # Real camera moves have a SPEED, not a destination: "dolly in muy
        # lento" over 3.5 s travels ~25 cm, not a third of the way to the
        # subject. Defaults to "slow"; an explicit "amount" still wins.
        dur_s = max(0.2, (w_e - w_s) / 1000.0)
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
            scn.frame_set(f_ws)
            head_start = char_head(subj_id)
            scn.frame_set(f_we)
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
            scn.frame_set(f_ws)
        if mtype != "static":
            place(p1, a1, l1, f_we)
        if mtype == "handheld" or move.get("handheld"):
            for ob in (cam, tgt):
                if ob.animation_data is None:
                    ob.keyframe_insert("location", frame=f_ws)
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
    for fk in _lane_fit(C.get("focusKeys"), "d", int(SHOT.get("durationMs") or 3000)):  # focus pulled by hand on the stage
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
    if live:
        # The shadow page pool is GPU memory held for the whole session: the
        # default 512 MB made each live Blender ~2 GB (and every open scene
        # runs one). 128 MB keeps the shadows of a previz set (~1.3 GB each).
        try:
            e.shadow_pool_size = "128"
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

if args.flat_surfaces and PASS == "beauty":
    # The video model re-renders whatever surface it sees (a texture, a
    # weathered patch, a painted marking). Its reference carries form, light
    # and placement only: one matte grey on everything but the characters
    # (their tints map them to the cast) and the emitters (lamps, windows).
    flat = material("reference_flat", "#a8a59f", 0.85)
    keep = tuple(f"{cid}_" for cid in CHARS)

    def _emits(m):
        bsdf = m.node_tree.nodes.get("Principled BSDF") if m and m.use_nodes else None
        try:
            return bsdf is not None and bsdf.inputs["Emission Strength"].default_value > 0 \
                and not any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes)
        except Exception:
            return False

    for ob in bpy.data.objects:
        if ob.type != "MESH" or ob.name.startswith(keep):
            continue
        if ob.material_slots and all(_emits(sl.material) for sl in ob.material_slots):
            continue
        if not ob.material_slots:
            ob.data.materials.append(None)
        for slot in ob.material_slots:
            slot.link = "OBJECT"
            slot.material = flat

# ───────────────────────────────────────────────────────────── output ──

if args.live:
    import socket
    import struct
    import time
    import os
    # Live views draw no shadows at all: they add little to a previz and,
    # switched off while the clock ran (~20 ms each per view) and back on when
    # it stopped, they popped in and out = flicker. With none, the shadow page
    # pool (GPU memory held all session) can be the minimum.
    def _live_look():
        try:
            if scn.eevee.use_shadows:
                scn.eevee.use_shadows = False
            if scn.eevee.shadow_pool_size != "16":
                scn.eevee.shadow_pool_size = "16"
        except Exception:
            pass
    _live_look()
    _PERF_ON = bool(os.environ.get("KOI_LIVE_PERF"))
    _PERF = {}
    def _perf(key, t0):
        if _PERF_ON:
            a = _PERF.setdefault(key, [0, 0.0, 0.0])
            d = (time.perf_counter() - t0) * 1000.0
            a[0] += 1
            a[1] += d
            a[2] = max(a[2], d)
    def _perf_dump():
        if not _PERF_ON:
            return
        now_ = time.time()
        if now_ - _PERF.get("_at", now_) < 2.0:
            _PERF.setdefault("_at", now_)
            return
        span = now_ - _PERF.get("_at", now_)
        _PERF["_at"] = now_
        parts = []
        for k_, v_ in sorted(_PERF.items()):
            if k_ == "_at" or not v_[0]:
                continue
            parts.append(f"{k_} {v_[0] / span:.1f}/s avg {v_[1] / v_[0]:.1f} max {v_[2]:.1f}ms")
            _PERF[k_] = [0, 0.0, 0.0]
        print("[live-perf] " + " | ".join(parts), flush=True)
    import gpu
    import blf

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

    def _near_active_cam(who):
        """Who the overview takes into account: those near the active camera.
        Someone very far off (left behind on a train) would shrink everything
        to specks, so they no longer count. A camera far from everyone (a long
        shot) keeps the nearest and whoever is close to them."""
        cam = CAMS.get(LIVE.get("stage_shot"))
        if cam is None or not who:
            return who
        p = cam.matrix_world.translation
        dist = {cid: (CHARS[cid]["root"].matrix_world.translation - p).length for cid in who}
        limit = max(30.0, min(dist.values()) + 10.0)
        return [cid for cid in who if dist[cid] <= limit]

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
            for cid in _near_active_cam(who):
                root = CHARS[cid]["root"].matrix_world.translation
                hgt = float(CHARS[cid].get("height") or 1.7)
                pts += [root.copy(), root + Vector((0, 0, hgt))]
        # The side it looks from is the SCENE's (taken from around the
        # playhead it flipped from one moment to the next): the side the
        # shots are filmed from, so what they frame faces the view instead
        # of the back of a wall. No cameras: across the cast's long axis.
        hs = LIVE.get("home_side")
        if not hs or hs[0] != (S.get("id"), DUR_MS):
            look = Vector((0.0, 0.0, 0.0))
            for sid_, cam_ in CAMS.items():
                tob_ = bpy.data.objects.get(f"cam_target_{sid_}")
                sh_ = _by_id.get(sid_)
                if tob_ is None or sh_ is None:
                    continue
                scn.frame_set(ms_to_frame(int(sh_.get("startMs") or 0) + int(sh_.get("durationMs") or 0) / 2))
                v_ = cam_.matrix_world.translation - tob_.matrix_world.translation
                v_ = Vector((v_.x, v_.y, 0.0))
                if v_.length > 1e-4:
                    look += v_.normalized()
            if look.length > 0.2:
                side = look.normalized()
            else:
                run = []
                for k in range(9):
                    scn.frame_set(ms_to_frame(float(DUR_MS) * k / 8))
                    run += [CHARS[cid]["root"].matrix_world.translation.copy() for cid in who]
                wide = (max(p.x for p in run) - min(p.x for p in run) >= max(p.y for p in run) - min(p.y for p in run)
                        if run else True)
                a = math.radians(35)  # 3/4: 35 deg off square
                sq = Vector((0.0, -1.0, 0.0)) if wide else Vector((-1.0, 0.0, 0.0))
                side = Vector((sq.x * math.cos(a) - sq.y * math.sin(a), sq.x * math.sin(a) + sq.y * math.cos(a), 0))
            hs = LIVE["home_side"] = ((S.get("id"), DUR_MS), side)
        scn.frame_set(keep)
        if not pts:
            pts = [Vector((-3, -3, 0)), Vector((3, 3, 1.8))]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        c = (lo + hi) / 2
        # From that side and 38 deg up: depth readable.
        rot = hs[1]
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

    def _cast_relation(lo, hi):
        """Does anyone stand on this piece, or anyone pass under it, at any
        point of the scene? A deck people cross is ground, never a roof."""
        if "cast_marks" not in LIVE:
            marks = [p_.get("position") for p_ in SETD.get("props") or []]
            for c in S.get("characters") or []:
                here = list(c.get("position") or [0, 0])
                here = here + [0.0] * (3 - len(here))
                marks.append(here)
                for a_ in sorted(S.get("actions") or [], key=lambda a_: int(a_.get("startMs") or 0)):
                    to = a_.get("to")
                    if a_.get("character") != c.get("id") or not isinstance(to, list) or len(to) < 2:
                        continue
                    dst = [to[0], to[1], to[2] if len(to) > 2 else here[2]]
                    marks += [[here[i] + (dst[i] - here[i]) * k / 8.0 for i in range(3)] for k in range(1, 9)]
                    here = dst
            LIVE["cast_marks"] = [m for m in marks if isinstance(m, list) and len(m) >= 3]
        on_top, under = False, False
        for m in LIVE["cast_marks"]:
            if lo.x <= m[0] <= hi.x and lo.y <= m[1] <= hi.y:
                on_top = on_top or abs(m[2] - hi.z) <= 0.3
                under = under or m[2] < lo.z
        return on_top, under

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
                    on_top, under = _cast_relation(lo, hi)
                    if not on_top and (under or set_kind == "room"):
                        want.add(ob.name)
            want |= LIVE.get("occl_hide", set())
        if on:
            LIVE["cut_want"] = want
        _apply_cut(want)

    def _stage_occluders():
        """While the clock runs, nothing may stand between the stage view and
        the action. Rays from the view to the cast, the active camera and the
        view's target: a wall, ceiling, floor, what backs onto them or a tall
        piece mid-room they cross goes (never a table or a chair), whole when it is a slab or reaches the action, otherwise behind the
        stage camera's near clip (a dado merged across four walls, a door).
        Only the stage's own layer and camera: the shots never change."""
        sv = LIVE["stage_view"]
        if not sv:
            return
        pos = sv["pos"]
        fwd = (sv["tgt"] - pos).normalized()
        ortho = bool(sv.get("ortho"))
        pts = [sv["tgt"]]
        for ch in CHARS.values():
            pts.append(ch["hips"].matrix_world.translation.copy())
            pts.append(ch["neck"].matrix_world.translation.copy())
        cam = CAMS.get(LIVE["stage_shot"])
        if cam is not None:
            pts.append(cam.matrix_world.translation.copy())
        reach = math.atan(18.0 / sv["lens"]) * 1.2
        in_view = []
        for p in pts:
            v = p - pos
            if v.dot(fwd) > 0.1 and (ortho or v.angle(fwd, 0.0) <= reach):
                in_view.append(p)
        if not in_view:
            return
        nearest = min((p - pos).dot(fwd) for p in in_view)
        if "occl_boxes" not in LIVE:
            def _moves(ob):
                while ob is not None:
                    if ob.animation_data:
                        return True
                    ob = ob.parent
                return False
            LIVE["occl_boxes"] = [(ob, lo, hi, sorted(hi - lo)) for ob, lo, hi in _stage_boxes()
                                  if max(hi - lo) >= 1.2 and not _moves(ob)
                                  and not (hi.z >= 2.0 and _cast_relation(lo, hi)[0])]
        rays = [(p, False) for p in in_view]
        if set_kind == "room" and (abs(pos.x) > W / 2 or abs(pos.y) > D / 2 or not 0 < pos.z < H):
            # Looking in from outside, also across the frame, at the action's depth: the shell (and the
            # furniture backed against it) may not block the rest of the picture.
            right = fwd.cross(Vector((0, 0, 1))).normalized()
            up = right.cross(fwd)
            depth0 = max((p - pos).dot(fwd) for p in in_view) + 0.5
            half = depth0 * 18.0 / sv["lens"]
            for ix in range(-3, 4):
                for iz in range(-2, 3):
                    g = pos + fwd * depth0 + right * (half * ix / 3.0) + up * (half * 0.56 * iz / 2.0)
                    if abs(g.x) < W / 2 and abs(g.y) < D / 2 and 0.05 < g.z < H:
                        rays.append((g, True))

        def _outside(lo, hi):
            # The shell and what backs onto it, even merged across all its walls.
            return max(abs(lo.x), abs(hi.x)) > W / 2 - 0.6 or max(abs(lo.y), abs(hi.y)) > D / 2 - 0.6 \
                or lo.z > H - 0.3 or hi.z < 0.1

        hide, clip = set(), 0.0
        for p, shell_only in rays:
            o = p - fwd * (p - pos).dot(fwd) if ortho else pos
            d = p - o
            far = d.length - 0.15
            d = d.normalized()
            for ob, lo, hi, sz in LIVE["occl_boxes"]:
                if ob.name in hide or not (_outside(lo, hi) or (not shell_only and hi.z >= 2.0)):
                    continue
                t0, t1 = 0.0, far
                for i in range(3):
                    if abs(d[i]) < 1e-6:
                        if o[i] < lo[i] or o[i] > hi[i]:
                            t1 = -1.0
                            break
                    else:
                        a, b = (lo[i] - o[i]) / d[i], (hi[i] - o[i]) / d[i]
                        t0, t1 = max(t0, min(a, b)), min(t1, max(a, b))
                if t0 > t1:
                    continue
                inv = ob.matrix_world.inverted()
                hit, loc, _n, _i = ob.ray_cast(inv @ o, (inv.to_3x3() @ d).normalized())
                if not hit:
                    continue
                w = ob.matrix_world @ loc
                if (w - o).length >= far:
                    continue
                depth = (w - pos).dot(fwd)
                if (sz[0] <= 0.6 and sz[1] >= 1.5) or depth >= nearest - 0.4:
                    hide.add(ob.name)
                else:
                    clip = max(clip, depth + 0.1)
        if hide != LIVE.get("occl_hide", set()):
            LIVE["occl_hide"] = hide
            LIVE["cut_dirty"] = True
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        # A place in the world, not a distance: a view moving between two
        # passes must not drag the cut through what it hides.
        pt = pos + fwd * clip if clip > 0.0 else None
        if pt != LIVE.get("occl_clip"):
            LIVE["occl_clip"] = pt
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)

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
    _FILL = gpu.shader.from_builtin("UNIFORM_COLOR")

    def _frame_font():
        """A fine monospace with a cursive f-stop sign, once; Blender's own
        monospace where the system has none, its default font as a last resort."""
        fid = LIVE.get("frame_font")
        if fid is None:
            fid = -1
            for path_ in ("/System/Library/Fonts/Menlo.ttc", "C:/Windows/Fonts/consola.ttf",
                          os.path.join(bpy.utils.system_resource("DATAFILES", path="fonts"), "bmonofont-i18n.ttf")):
                if os.path.exists(path_):
                    fid = blf.load(path_)
                    if fid >= 0:
                        break
            fid = LIVE["frame_font"] = fid if fid >= 0 else 0
        return fid

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

    def _cam_model():
        """Wireframe film camera in camera space (looks down -Z, +Y up), the
        lens at the origin: (points, edges). Metres, about 0.7 m long."""
        pts, edges = [], []

        def add(vs, es):
            o_ = len(pts)
            pts.extend(Vector(v) for v in vs)
            edges.extend((a + o_, b + o_) for a, b in es)

        def box(x0, x1, y0, y1, z0, z1):
            vs = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
            es = [(0, 1), (2, 3), (0, 2), (1, 3), (4, 5), (6, 7), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
            add(vs, es)

        # Body behind the lens.
        box(-0.09, 0.09, -0.12, 0.12, 0.14, 0.62)
        # Lens hood: a short truncated pyramid opening forward.
        n_, f_ = (0.045, 0.045), (0.085, 0.065)
        add([(-n_[0], -n_[1], 0.14), (n_[0], -n_[1], 0.14), (n_[0], n_[1], 0.14), (-n_[0], n_[1], 0.14),
             (-f_[0], -f_[1], 0.0), (f_[0], -f_[1], 0.0), (f_[0], f_[1], 0.0), (-f_[0], f_[1], 0.0)],
            [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)])
        # Two reels on top, their axis across the body (X).
        import math as _m
        k_, r_ = 12, 0.13
        for zc in (0.25, 0.51):
            vs = []
            for x in (-0.04, 0.04):
                for i in range(k_):
                    a = 2 * _m.pi * i / k_
                    vs.append((x, 0.12 + r_ + r_ * _m.sin(a), zc + r_ * _m.cos(a)))
            es = [(i, (i + 1) % k_) for i in range(k_)] + [(k_ + i, k_ + (i + 1) % k_) for i in range(k_)]
            es += [(i, k_ + i) for i in range(0, k_, 2)]
            add(vs, es)
        return pts, edges

    _CAM_MODEL = _cam_model()

    def _draw_cams(view, proj, w, h):
        """The active shot camera only, amber (white while selected) with its
        frustum (+ its move as a path); the other cameras stay hidden."""
        active = LIVE["stage_shot"]
        if LIVE.get("stage_noshot"):
            return
        gpu.state.depth_test_set("NONE")
        gpu.state.blend_set("ALPHA")
        with gpu.matrix.push_pop():
            gpu.matrix.load_matrix(view)
            with gpu.matrix.push_pop_projection():
                gpu.matrix.load_projection_matrix(proj)
                for sid in ORDER:
                    if sid != active or LIVE.get("stage_pov"):  # through it: no frame of its own
                        continue
                    cam = CAMS[sid]
                    mw = cam.matrix_world
                    apex = mw.translation
                    # Behind the camera the frame overlay (_draw_frame) stands
                    # for it. Otherwise a film camera (body, two reels, lens
                    # hood) in wireframe, and its field of view.
                    if not LIVE.get("stage_follow"):
                        seg = []
                        for a_, b_ in _CAM_MODEL[1]:
                            seg += [mw @ _CAM_MODEL[0][a_], mw @ _CAM_MODEL[0][b_]]
                        _lines(seg, (1.0, 1.0, 1.0, 1.0) if LIVE.get("stage_sel") else (1.0, 0.62, 0.25, 1.0), 1.8, w, h)
                        fp, _fd = _frame_at(sid)
                        segf, segr = [], []
                        for i in range(4):
                            segf += [apex, fp[i]]
                            segr += [fp[i], fp[(i + 1) % 4]]
                        _lines(segf, (0.92, 0.92, 0.9, 0.55), 1.1, w, h)
                        _lines(segr, (0.92, 0.92, 0.9, 0.8), 1.4, w, h)
                    else:
                        # No camera, but the rays from where it stands to its
                        # frame's corners: which way it points.
                        segf = []
                        for v_ in _frame_at(sid)[0]:
                            segf += [apex, v_]
                        _lines(segf, (1.0, 1.0, 1.0, 0.35), 1.0 / LIVE.get("px", 1.0), w, h)
                    if not LIVE.get("stage_sel"):  # the move shows only on the selected camera
                        continue
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

    def _frame_at(sid):
        """The camera's frame in the world, out to where it focuses (the focus
        distance with depth of field, else its aim point): (top right, bottom
        right, bottom left, top left), distance."""
        cam = CAMS[sid]
        mw = cam.matrix_world
        apex = mw.translation
        cd_ = cam.data
        fwd = -(mw.to_3x3() @ Vector((0, 0, 1)))
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        if cd_.dof.use_dof:
            fo = cd_.dof.focus_object
            fd = (fo.matrix_world.translation - apex).dot(fwd) if fo is not None else float(cd_.dof.focus_distance)
        elif tob is not None:
            fd = (tob.matrix_world.translation - apex).dot(fwd)
        else:
            fd = 5.0
        fd = max(0.3, min(80.0, fd))
        return [mw @ (v * (fd / max(1e-4, -v.z))) for v in cd_.view_frame(scene=scn)], fd

    def _fit_frame(sid, view, proj, w, h):
        """Through the camera: a projection showing its whole frame with room
        around it, whatever the stage's shape, clear of the stage's tool column
        on the right. It only changes what surrounds the frame."""
        m = proj @ view
        xs, ys = [], []
        for v in _frame_at(sid)[0]:
            q = m @ Vector((v.x, v.y, v.z, 1.0))
            if q.w <= 1e-4:
                return proj
            xs.append(q.x / q.w)
            ys.append(q.y / q.w)
        bw, bh = max(xs) - min(xs), max(ys) - min(ys)
        if bw <= 1e-4 or bh <= 1e-4:
            return proj
        px = LIVE.get("px", 1.0)
        pad, tools = 28.0 * px, 96.0 * px
        if w - pad - tools < w * 0.4:  # too narrow to give the tools a column
            tools = pad
        lo_x, hi_x = -1 + 2 * pad / w, 1 - 2 * tools / w
        lo_y, hi_y = -1 + 2 * pad / h, 1 - 2 * pad / h
        s_ = min((hi_x - lo_x) / bw, (hi_y - lo_y) / bh)
        tx = (lo_x + hi_x) / 2 - s_ * (max(xs) + min(xs)) / 2
        ty = (lo_y + hi_y) / 2 - s_ * (max(ys) + min(ys)) / 2
        return Matrix(((s_, 0, 0, tx), (0, s_, 0, ty), (0, 0, 1, 0), (0, 0, 0, 1))) @ proj

    def _draw_frame(sid, view, proj, w, h):
        """What the camera captures, as a viewfinder: outside darkened, rounded
        corners, thirds, centre cross, lens and aperture. Screen space, on the
        stage image, so it never lags behind the frame it marks."""
        fp, fd = _frame_at(sid)
        m = proj @ view

        def ndc(v):
            q = m @ Vector((v.x, v.y, v.z, 1.0))
            return None if q.w <= 1e-4 else (q.x / q.w, q.y / q.w)

        def mix(a, b, u):
            return a + (b - a) * u

        corners = [ndc(v) for v in fp]
        if any(c_ is None for c_ in corners):
            return
        # Where it is on the stage (0..1, y down; top left first, clockwise).
        LIVE["frame_at"] = [round(q_, 4) for c_ in (corners[3], corners[0], corners[1], corners[2])
                            for q_ in ((c_[0] + 1) / 2, (1 - c_[1]) / 2)]
        px = LIVE.get("px", 1.0)
        pix = [Vector(((c_[0] + 1) * w / 2, (c_[1] + 1) * h / 2)) for c_ in corners]
        sides = [(pix[(i + 1) % 4] - pix[i]).length for i in range(4)]
        rad = min(12.0 * px, min(sides) * 0.2)
        ring = []
        for i in range(4):  # each corner, rounded with a quadratic curve
            at = pix[i]
            a_ = at + (pix[i - 1] - at).normalized() * rad
            b_ = at + (pix[(i + 1) % 4] - at).normalized() * rad
            for k_ in range(7):
                u = k_ / 6
                ring.append(a_ * (1 - u) ** 2 + at * (2 * u * (1 - u)) + b_ * (u * u))
        rc = sum(pix, Vector((0.0, 0.0))) / 4
        far = [p_ + (p_ - rc).normalized() * (4.0 * (w + h)) for p_ in ring]

        def to3(p_):
            return (p_.x * 2 / w - 1, p_.y * 2 / h - 1, 0.0)

        tris = []
        n_ = len(ring)
        for i in range(n_):
            j = (i + 1) % n_
            tris += [to3(ring[i]), to3(ring[j]), to3(far[i]), to3(ring[j]), to3(far[j]), to3(far[i])]
        ln_ = []
        for i in range(n_):
            ln_ += [to3(ring[i]), to3(ring[(i + 1) % n_])]
        guides = []
        for u in (1 / 3, 2 / 3):
            for a_, b_ in ((mix(fp[3], fp[0], u), mix(fp[2], fp[1], u)), (mix(fp[3], fp[2], u), mix(fp[0], fp[1], u))):
                qa, qb = ndc(a_), ndc(b_)
                if qa and qb:
                    guides += [(qa[0], qa[1], 0.0), (qb[0], qb[1], 0.0)]
        ctr = ndc(sum(fp, Vector((0.0, 0.0, 0.0))) / 4)
        cross = []
        if ctr:
            cx_, cy_ = 5.0 * px * 2 / w, 5.0 * px * 2 / h
            cross = [(ctr[0] - cx_, ctr[1], 0.0), (ctr[0] + cx_, ctr[1], 0.0), (ctr[0], ctr[1] - cy_, 0.0), (ctr[0], ctr[1] + cy_, 0.0)]
        gpu.state.depth_test_set("NONE")
        gpu.state.blend_set("ALPHA")
        with gpu.matrix.push_pop():
            gpu.matrix.load_identity()
            with gpu.matrix.push_pop_projection():
                gpu.matrix.load_projection_matrix(Matrix.Identity(4))
                _FILL.bind()
                _FILL.uniform_float("color", (0.0, 0.0, 0.0, 0.3))
                batch_for_shader(_FILL, "TRIS", {"pos": tris}).draw(_FILL)
                # Hairlines: one physical pixel, whatever the screen's density.
                _lines(guides, (1.0, 1.0, 1.0, 0.22), 1.0 / px, w, h)
                _lines(cross, (1.0, 1.0, 1.0, 0.9), 1.0 / px, w, h)
                # Hovered or selected (it stands for the camera): brighter.
                lit = LIVE.get("frame_hover") or LIVE.get("stage_sel")
                _lines(ln_, (1.0, 1.0, 1.0, 0.95 if lit else 0.5), (1.6 if lit else 1.0) / px, w, h)
                # The readout, in the frame's top corners, kept on screen.
                gpu.matrix.load_projection_matrix(Matrix(((2 / w, 0, 0, -1), (0, 2 / h, 0, -1), (0, 0, 1, 0), (0, 0, 0, 1))))
                cd_ = CAMS[sid].data
                fid = _frame_font()
                # Sized to the frame: full size on a large frame, smaller on a
                # small one, gone when it would only cover what it frames.
                fw_ = min((pix[0] - pix[3]).length, (pix[1] - pix[2]).length)
                fh_ = min((pix[3] - pix[2]).length, (pix[0] - pix[1]).length)
                k_ = min(1.0, fw_ / (520.0 * px), fh_ / (290.0 * px))
                pad = 10.0 * px * k_
                big_, small_ = 10.5 * px * k_, 8.0 * px * k_

                def text(s_, x_, y_, size, alpha, right=False):
                    blf.size(fid, size)
                    blf.color(fid, 1.0, 1.0, 1.0, alpha)
                    tw = blf.dimensions(fid, s_)[0]
                    x0 = x_ - tw if right else x_
                    blf.position(fid, max(4.0, min(w - tw - 4.0, x0)), max(4.0, min(h - size - 4.0, y_)), 0)
                    blf.draw(fid, s_)

                if k_ < 0.55:
                    gpu.state.blend_set("NONE")
                    return
                blf.enable(fid, blf.SHADOW)
                blf.shadow(fid, 3, 0.0, 0.0, 0.0, 0.45)
                blf.shadow_offset(fid, 1, -1)
                tl, tr_ = pix[3], pix[0]
                text(f"{cd_.lens:.0f}mm", tl.x + pad, tl.y - pad - big_, big_, 1.0)
                text(f"FOV {math.degrees(cd_.angle_x):.0f}" + chr(176), tl.x + pad, tl.y - pad - big_ - small_ - 4 * px * k_, small_, 0.6)
                if cd_.dof.use_dof:
                    text(chr(402) + f"/{cd_.dof.aperture_fstop:g}", tr_.x - pad, tr_.y - pad - big_, big_, 1.0, right=True)
                    text(f"AF {fd:.1f}m", tr_.x - pad, tr_.y - pad - big_ - small_ - 4 * px * k_, small_, 0.6, right=True)
                label = LIVE.get("stage_label")
                if label:  # the take, named by the app (its number and language)
                    text(str(label), pix[1].x - pad, pix[1].y + pad, small_, 0.6, right=True)
                blf.disable(fid, blf.SHADOW)
        gpu.state.blend_set("NONE")

    def _track_cast():
        """What the overview keeps centred: what the home view frames — the
        cast (characters with a sheet; else everyone) — where it is NOW:
        (centre, points). Falls back to the active camera's aim."""
        cast = [c.get("id") for c in S.get("characters") or [] if c.get("characterId") and c.get("id") in CHARS]
        pts = []
        for cid in _near_active_cam(cast or list(CHARS)):
            root = CHARS[cid]["root"].matrix_world.translation
            pts += [root.copy(), root + Vector((0, 0, float(CHARS[cid].get("height") or 1.7)))]
        if not pts:
            tob = bpy.data.objects.get(f"cam_target_{LIVE['stage_shot']}")
            if tob is None:
                return None, []
            pts = [tob.matrix_world.translation.copy()]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        return (lo + hi) / 2, pts

    def _fit_dist(c, pts, d, lens):
        """Distance along view direction d (pointing from the target to the
        lens) at which every point fits — as the home view measures it."""
        right = d.cross(Vector((0, 0, 1)))
        right = right.normalized() if right.length > 1e-5 else Vector((1, 0, 0))
        up = right.cross(d).normalized()
        tan_h = 18.0 / max(1.0, lens)
        tan_v = tan_h * 0.7
        dist = 3.0
        for p in pts:
            q = p - c
            along = q.dot(d)
            dist = max(dist, abs(q.dot(right)) / tan_h + along, abs(q.dot(up)) / tan_v + along)
        return dist * 1.25 + 0.8

    def _track_overview():
        """Centred overview — as if the home button were pressed every frame,
        from one angle: the view keeps its direction (the home one, or the
        user's after orbiting), its target follows the cast, and its distance
        refits the cast (times the user's own zoom), eased so it never pumps."""
        sv = LIVE["stage_view"]
        if sv is None or time.time() - LIVE.get("cam_edit_at", 0.0) < 0.6:
            return  # a camera being dragged: the view holds still under the pointer
        c, pts = _track_cast()
        if c is None:
            return
        tr = LIVE.get("track_off")
        if tr is None:
            v = sv["pos"] - sv["tgt"]
            d = v.normalized() if v.length > 1e-4 else Vector((0, -1, 0.6)).normalized()
            fit = _fit_dist(c, pts, d, sv["lens"])
            if LIVE.pop("track_recentre", False):
                # Just switched on: centred on the cast, fitted, from this angle.
                LIVE["track_off"] = {"d": d, "shift": Vector((0, 0, 0)), "zoom": 1.0, "dist": fit}
            else:
                LIVE["track_off"] = {"d": d, "shift": sv["tgt"] - c, "zoom": max(0.05, v.length / fit), "dist": v.length}
            return
        fit = _fit_dist(c, pts, tr["d"], sv["lens"])
        # Eased while playing (never pumps); paused, exact: the same moment
        # always frames the same, however the playhead got there.
        tr["dist"] += (fit * tr["zoom"] - tr["dist"]) * (0.15 if LIVE.get("playing") else 1.0)
        tgt = c + tr["shift"]
        pos = tgt + tr["d"] * tr["dist"]
        if (pos - sv["pos"]).length < 1e-4 and (tgt - sv["tgt"]).length < 1e-4:
            return
        LIVE["stage_view"] = {"pos": pos, "tgt": tgt, "lens": sv["lens"], "ortho": sv.get("ortho", False)}
        LIVE["cut_dirty"] = True
        LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)

    def _follow_active_cam():
        """Follow mode: the stage view sits behind and a little above the
        active camera, looking where it looks, so its frame and everything it
        sees are in view — as the camera moves, keys change or time runs."""
        sid = LIVE["stage_shot"]
        cam = CAMS.get(sid)
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        if cam is None or tob is None:
            return
        p = cam.matrix_world.translation.copy()
        a = tob.matrix_world.translation.copy()
        fwd = a - p
        dist = max(0.5, fwd.length)
        fwd.normalize()
        flat = Vector((fwd.x, fwd.y, 0.0))
        flat = flat.normalized() if flat.length > 1e-4 else Vector((0.0, 1.0, 0.0))
        back = max(1.8, min(6.0, 1.0 + dist * 0.22))
        pos = p - flat * back + Vector((0.0, 0.0, 0.6 + back * 0.3))
        tgt = p + fwd * min(dist, 12.0) * 0.55  # between the camera and what it frames
        lens = max(14.0, min(40.0, float(cam.data.lens) * 0.75))  # a bit wider than the camera
        key = (tuple(round(v, 3) for v in pos), tuple(round(v, 3) for v in tgt), round(lens, 1))
        if key == LIVE.get("follow_key"):
            return
        LIVE["follow_key"] = key
        LIVE["stage_view"] = {"pos": pos, "tgt": tgt, "lens": lens, "ortho": False}
        LIVE["cut_dirty"] = True
        LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)

    def _stage_proj(view, proj):
        """Where the active camera sits on the stage image (to pick it)."""
        m = proj @ view
        out = []
        for sid in ORDER:
            # Not drawn behind the camera: nothing to pick, no number beside it.
            if sid != LIVE["stage_shot"] or LIVE.get("stage_follow") or LIVE.get("stage_noshot"):
                continue
            cam = CAMS[sid]
            p = cam.matrix_world.translation
            q = m @ Vector((p.x, p.y, p.z, 1.0))
            if q.w <= 1e-4:
                continue
            # The drawn camera's points on screen (the GUI takes their hull),
            # so a click anywhere on the camera picks it, not only its label.
            mw = cam.matrix_world
            poly = []
            for v in [p] + [mw @ c for c in _CAM_MODEL[0]]:
                qq = m @ Vector((v.x, v.y, v.z, 1.0))
                if qq.w > 1e-4:
                    poly += [round((qq.x / qq.w + 1) / 2, 4), round((1 - qq.y / qq.w) / 2, 4)]
            out.append({"shot": sid, "x": (q.x / q.w + 1) / 2, "y": (1 - q.y / q.w) / 2, "frustum": poly})
        return out

    def _same_json(a, b):
        """Same value, numbers within 1e-3, a missing key == None."""
        if isinstance(a, dict) and isinstance(b, dict):
            return all(_same_json(a.get(k_), b.get(k_)) for k_ in set(a) | set(b))
        if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
            return len(a) == len(b) and all(_same_json(x_, y_) for x_, y_ in zip(a, b))
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
            return abs(float(a) - float(b)) < 1e-3
        return a == b

    def _reload(req):
        """Pool: take this Blender over for another scene without a restart.
        Everything this run owns goes (clients, socket, surfaces, offscreens,
        draw handler, the world and its data); then the builder runs again,
        in this process, on the new scene — same port. Compiled shaders stay
        in the process, so the next scene draws in a fraction of a cold start."""
        print(f"[scene3d] live reload -> {req.get('scene')}", flush=True)
        for conn in list(LIVE["clients"]):
            try:
                conn.close()
            except Exception:
                pass
        LIVE["clients"] = []
        try:
            srv.close()
        except Exception:
            pass
        for sf in LIVE["surf"].values():
            if sf.get("s") and _SURF is not None:
                _SURF.bls_release(sf["s"])
        LIVE["surf"] = {}
        for o_ in list(offscreen.values()):
            try:
                o_.free()
            except Exception:
                pass
        offscreen.clear()
        try:
            bpy.types.SpaceView3D.draw_handler_remove(LIVE["draw_h"], "WINDOW")
        except Exception:
            pass
        # The world and everything it made.
        for ob_ in list(bpy.data.objects):
            bpy.data.objects.remove(ob_, do_unlink=True)
        for co_ in list(bpy.data.collections):
            bpy.data.collections.remove(co_)
        for vl_ in list(scn.view_layers)[1:]:
            scn.view_layers.remove(vl_)
        for coll_ in (bpy.data.actions, bpy.data.cameras, bpy.data.lights, bpy.data.meshes, bpy.data.curves,
                      bpy.data.materials, bpy.data.images, bpy.data.node_groups, bpy.data.worlds):
            for id_ in list(coll_):
                try:
                    coll_.remove(id_)
                except Exception:
                    pass
        try:
            bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
        except Exception:
            pass
        argv_ = sys.argv[:]
        i_ = argv_.index("--scene")
        argv_[i_ + 1] = req["scene"]
        script_ = req.get("script") or __file__

        def _again():
            sys.argv = argv_
            try:
                with open(script_, "r", encoding="utf-8") as f_:
                    code_ = compile(f_.read(), script_, "exec")
                exec(code_, {"__name__": "__main__", "__file__": script_})
            except SystemExit:
                print("Traceback: reload exited", flush=True)
            except Exception:
                import traceback
                traceback.print_exc()
                sys.stdout.flush()
            return None

        bpy.app.timers.register(_again, first_interval=0.05)

    def _strip_step(now):
        """One filmstrip frame per tick, only while nothing plays or moves:
        move the scene to that moment and ask _draw for it. The next normal
        tick puts the clock frame back (main_fr is reset)."""
        q = LIVE.get("strip_q")
        if not q or LIVE.get("strip_draw"):
            return False
        if max(LIVE.get("clock_at", 0.0), LIVE.get("moved_at", 0.0), LIVE.get("cmd_at", 0.0)) > now - 0.6:
            return False
        try:  # half-compiled shaders would land in the strip
            if bpy.app.is_job_running("SHADER_COMPILATION"):
                return False
        except Exception:
            pass
        job = q[0]
        if job["conn"] not in LIVE["clients"] or job["shot"] not in CAMS:
            q.pop(0)
            return False
        if job["i"] == 0 and LIVE.get("lit_for") != job["shot"]:
            apply_shot_light(_by_id[job["shot"]])
            LIVE["lit_for"] = job["shot"]
        scn.frame_set(ms_to_frame(job["times"][job["i"]]))
        LIVE["main_fr"] = None
        LIVE["stage_fr"] = None
        LIVE["strip_draw"] = job
        LIVE["draw_req"] = "strip"
        for win in bpy.context.window_manager.windows:
            for area in win.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
        return True

    def _strip_draw(ctx, sp, reg, dg, used):
        job = LIVE.pop("strip_draw", None)
        if job is None:
            return
        cam = CAMS[job["shot"]]
        w, h = job["w"], job["h"]
        o = _offscreen_k(("strip", w, h), w, h, used)
        o.draw_view3d(scn, ctx.view_layer, sp, reg, cam.matrix_world.inverted(),
                      cam.calc_matrix_camera(dg, x=w, y=h), do_color_management=True)
        px = o.texture_color.read()
        px.dimensions = w * h * 4
        with open(job["out"], "ab") as f_:
            mv_ = memoryview(px)
            f_.write(mv_.cast("B") if mv_.format != "B" else mv_)
        job["i"] += 1
        if job["i"] >= len(job["times"]):
            LIVE["strip_q"].remove(job)
            _send_json({"type": "strip_done", "shot": job["shot"], "out": job["out"], "w": w, "h": h,
                        "n": len(job["times"])}, only=job["conn"])
        LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)

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
        # Keys snapped to frames can land a few ms outside the shot (its start
        # is not on a frame): clamp, or the first key sits before the shot and
        # an edit at its start keys a new one instead of changing it.
        dur_ = int(sh.get("durationMs") or 3000)
        inw = lambda t_: max(0, min(dur_, int(round(t_))))
        if keys and all(isinstance(k.get("position"), (list, tuple)) and isinstance(k.get("target"), (list, tuple))
                        for k in keys):
            return [{"t": inw(k.get("t") or k.get("ms") or 0), "position": list(k["position"]),
                     "target": list(k["target"]), "lens": float(k.get("lens") or (sh.get("camera") or {}).get("lens") or 35),
                     **({"focus": float(k["focus"])} if isinstance(k.get("focus"), (int, float)) else {})}
                    for k in keys]
        # A move (dolly, pan, zoom…) only lives in the animation: its keys
        # are where the camera, its aim or its lens are keyed in the shot.
        frames = set()
        tob = bpy.data.objects.get(f"cam_target_{sid}")
        for id_, path_ in ((CAMS[sid], "location"), (tob, "location"), (CAMS[sid].data, "lens")):
            if id_ is None:
                continue
            for fc in _anim_curves(id_):
                if fc.data_path == path_:
                    frames.update(int(round(kp.co[0])) for kp in fc.keyframe_points)
        f0_, f1_ = ms_to_frame(s_ms), ms_to_frame(s_ms + dur_)
        # A move solved over a wider window (a trimmed shot) is keyed past
        # the shot's edges: key it where the shot starts and ends instead.
        edges = ({f0_} if any(f_ < f0_ for f_ in frames) else set()) | ({f1_} if any(f_ > f1_ for f_ in frames) else set())
        frames = {f_ for f_ in frames if f0_ <= f_ <= f1_} | edges
        if not frames:
            frames = {f0_}
        out = []
        for fr in sorted(frames):
            p, a, ln = _cam_pose_at(sid, fr)
            t_ = inw(_frame_ms(fr) - s_ms)
            if out and out[-1]["t"] == t_:
                continue
            out.append({"t": t_, "position": [round(v, 4) for v in p],
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
        LIVE.setdefault("skeys", {}).pop(sid, None)
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
            ks = _lane_fit(cam_c.get(lk), vk, dur0)
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
                ks.sort(key=lambda x: int(x.get("t") or 0))
                first = ks[0] is near[0]
                ks.remove(near[0])
                if first and ks:  # the next key becomes the lane's first: it starts the shot
                    ks[0]["t"] = 0
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
                if i == 0:  # the next key becomes the shot's first: it starts it
                    keys[0]["t"] = 0
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
        # The same keys the edits index (_shot_keys), worked out outside the
        # draw callback (frame_set) — see the stage tick.
        for i, k in enumerate(LIVE.get("skeys", {}).get(sid) or []):
            if isinstance(k.get("position"), (list, tuple)) and isinstance(k.get("target"), (list, tuple)):
                out["keys"].append({"i": i, "ms": s_ms + max(0, min(int(sh.get("durationMs") or 3000), int(k.get("t") or 0))),
                                    "p": [float(v) for v in k["position"]][:3], "t": [float(v) for v in k["target"]][:3],
                                    "lens": float(k.get("lens") or 35),
                                    "focus": float(k["focus"]) if isinstance(k.get("focus"), (int, float)) else None})
        out["s0"], out["dur"] = s_ms, int(sh.get("durationMs") or 3000)
        kit = (sh.get("camera") or {}).get("lensKit")
        out["kit"] = kit if isinstance(kit, dict) else None
        out["fcurve"] = _focus_curve(sid)
        # The keys of each lane, as the stage draws them (scene ms).
        cc = sh.get("camera") or {}
        lk = _lane_fit(cc.get("lensKeys"), "mm", out["dur"])
        out["lensKeys"] = ([[s_ms + int(x.get("t") or 0), float(x.get("mm") or 35)] for x in lk] if lk else
                           [[x["t"], x["mm"]] for x in _runs([{"t": k_["ms"], "mm": k_["lens"]} for k_ in out["keys"]], "mm")])
        fk = _lane_fit(cc.get("focusKeys"), "d", out["dur"])
        out["focusKeys"] = ([s_ms + int(x.get("t") or 0) for x in fk] if fk else list(out["fcurve"]["keys"]))
        if not out["focusKeys"] and CAMS[sid].data.dof.use_dof:
            out["focusKeys"] = [s_ms]  # one focus for the whole shot: its key at the start, like zoom
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
            LIVE["follow_at"] = time.time()
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
                    LIVE["track_off"] = None
                    LIVE["track_recentre"] = True  # tracking from home: on the cast, no offset
                LIVE["cut_dirty"] = True
                LIVE["stage_stale"] = True
            else:
                _stage_cutaway(False)
                v = LIVE["stage_view"]
                _send_json({"type": "stage_home", "pos": list(v["pos"]), "target": list(v["tgt"]), "lens": v["lens"],
                            "shots": [{"id": sid, "startMs": int(_by_id[sid].get("startMs") or 0),
                                       "durationMs": int(_by_id[sid].get("durationMs") or 3000)} for sid in ORDER],
                            "durationMs": DUR_MS})
        elif k == "warm_stage":
            # A preloaded scene (the next one on the timeline) draws its stage
            # once, unseen, at the stage's size: the first real stage frame
            # then takes ~100 ms instead of ~450 (layer, batches, buffers).
            ctl_ = LIVE.get("ctl", set())
            if not any(c_ not in LIVE["views"] and c_ not in ctl_ for c_ in LIVE["clients"]):
                LIVE["warm_req"] = (max(64, int(c.get("w") or 1280)), max(64, int(c.get("h") or 720)))
                LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        elif k == "stage_follow":  # the stage view rides behind the active camera
            LIVE["stage_follow"] = bool(c.get("on"))
            LIVE["follow_key"] = None
            LIVE["track_off"] = None
        elif k == "stage_track":  # the overview slides with the active camera's subject
            LIVE["stage_track"] = bool(c.get("on"))
            LIVE["track_off"] = None
            # Switched on: centre the cast whatever the view looked at. A
            # reconnect ("keep") resumes from the view it sent instead.
            LIVE["track_recentre"] = not c.get("keep") or LIVE.get("track_recentre", False)
        elif k == "stage_pov":  # the stage looks through the active camera, live
            LIVE["stage_pov"] = bool(c.get("on"))
            LIVE["cut_dirty"] = True
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        elif k == "stage_frame_hover":  # the pointer is on the frame's edge
            LIVE["frame_hover"] = bool(c.get("on"))
            LIVE["cut_dirty"] = True
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        elif k == "stage_noshot":  # the playhead is off every 3D clip: no camera drawn
            LIVE["stage_noshot"] = bool(c.get("on"))
            LIVE["cut_dirty"] = True
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        elif k == "stage_label":  # what the frame's corner says about the take
            LIVE["stage_label"] = c.get("text")
            LIVE["cut_dirty"] = True
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        elif k == "stage_sel":  # the active camera is selected: draw its path
            LIVE["stage_sel"] = bool(c.get("on"))
            LIVE["cut_dirty"] = True
            LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
        elif k == "stage_view":
            LIVE["stage_view"] = {"pos": Vector(c["pos"]), "tgt": Vector(c["target"]), "lens": float(c.get("lens") or 24),
                                  "ortho": bool(c.get("ortho"))}
            LIVE["track_off"] = None  # steered by hand: keep tracking from this angle
            LIVE["view_seq"] = c.get("seq")  # echoed in follow: the GUI skips older views
            if time.time() - LIVE.get("time_at", 0.0) >= 0.4:  # the clock is still: only it clears the view
                LIVE["occl_hide"], LIVE["occl_clip"] = set(), None
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
            # ONE owner for the clock: while the timeline preview is being
            # fed, it alone sets the time. The stage sends the same playhead
            # later (throttled), so the two interleaved and the clock went
            # back and forth — frames out of order, the preview stuttered
            # only when both viewers were open.
            if not (LIVE["views"] and time.time() - LIVE.get("follow_at", 0.0) < 0.5):
                LIVE["clock"] = LIVE["stage_ms"]
            if c.get("shot") in _by_id:
                LIVE["stage_shot"] = c.get("shot")
            if before == (ms_to_frame(LIVE["stage_ms"]), ms_to_frame(LIVE["clock"] or 0), LIVE["stage_shot"]):
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
            # Through the camera, the stage shows the shot camera (framed to
            # fit), not the free view: the ray and the outline go through the
            # very matrix it was drawn with.
            pov_m = LIVE.get("stage_m") if LIVE["stage"] and LIVE.get("stage_pov") else None
            if pov_m is not None:
                inv_ = pov_m.inverted()
                n_ = inv_ @ Vector((x, y, -1.0, 1.0))
                f_ = inv_ @ Vector((x, y, 1.0, 1.0))
                o_ = n_.xyz / n_.w
                d = (f_.xyz / f_.w - o_).normalized()
            if LIVE["stage"]:
                # Against what the stage SHOWS: its own layer, walls cut away
                # there only. The main layer's walls stood invisibly in the
                # way — no hover or click on anyone behind one (most sets).
                with bpy.context.temp_override(view_layer=_stage_layer()):
                    dg_ = bpy.context.evaluated_depsgraph_get()
            else:
                dg_ = bpy.context.evaluated_depsgraph_get()
            hit, _loc, _n, _i, ob, _m = scn.ray_cast(dg_, o_, d)
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
                        if pov_m is not None:
                            q_ = pov_m @ (mw @ vx.co).to_4d()
                            if q_.w > 0.05:
                                pts2.append(((q_.x / q_.w + 1) / 2, (1 - q_.y / q_.w) / 2))
                            continue
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
            LIVE["cam_edit_at"] = time.time()
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
        elif k == "load":  # pooled Blender: drop this scene, build another in this process
            LIVE["reload"] = {"scene": c.get("scene"), "script": c.get("script")}
            return False
        elif k == "ping":  # the engine's health check: this loop is alive
            _send_json({"type": "pong"}, only=conn)
            return False
        elif k == "ctl":  # the engine's control link: never a view, never the stage
            LIVE.setdefault("ctl", set()).add(conn)
            return False
        elif k == "strip":  # timeline filmstrip: small frames of a shot, drawn when idle
            sid_ = c.get("shot")
            if sid_ in CAMS:
                # Only when this session shows the shot as saved (a stale one
                # is about to restart and will be asked again).
                exp_ = c.get("expect")
                if exp_ is not None and not _same_json(exp_, {"keyframes": _by_id[sid_].get("keyframes"),
                                                             "camera": _by_id[sid_].get("camera")}):
                    _send_json({"type": "strip_done", "shot": sid_, "out": c.get("out"), "skipped": True}, only=conn)
                    return False
                try:
                    os.remove(c["out"])
                except Exception:
                    pass
                LIVE.setdefault("strip_q", []).append({"conn": conn, "shot": sid_, "out": c["out"], "i": 0,
                                                       "times": [float(t_) for t_ in c.get("times") or []],
                                                       "w": int(c.get("w") or 320), "h": int(c.get("h") or 180)})
            return False
        elif k == "diag":  # diagnostics: heaviest objects (evaluated triangles)
            dg_ = bpy.context.evaluated_depsgraph_get()
            rows = []
            for ob_ in scn.objects:
                if ob_.type == "MESH":
                    ev = ob_.evaluated_get(dg_)
                    rows.append((sum(max(1, len(p_.vertices) - 2) for p_ in ev.data.polygons), ob_.name, ob_.visible_shadow,
                                 bool(ob_.animation_data or (ob_.parent and ob_.parent.animation_data))))
            from collections import Counter
            print("[scene3d] diag types=%s instancers=%s" % (dict(Counter(o_.type for o_ in scn.objects)),
                  [o_.name for o_ in scn.objects if o_.instance_type != "NONE" or any(m_.type == "NODES" for m_ in getattr(o_, "modifiers", []))][:10]), flush=True)
            print("[scene3d] diag instances=%d" % sum(1 for _ in dg_.object_instances), flush=True)
            print("[scene3d] diag eevee=%s" % {p_.identifier: getattr(scn.eevee, p_.identifier) for p_ in scn.eevee.bl_rna.properties if p_.type in ("BOOLEAN", "INT", "FLOAT", "ENUM") and not p_.is_readonly}, flush=True)
            print("[scene3d] diag world=%s" % ([n_.bl_idname for n_ in scn.world.node_tree.nodes] if scn.world and scn.world.use_nodes else None), flush=True)
            rows.sort(reverse=True)
            print("[scene3d] diag tris=%d objs=%d top=%s" % (sum(r[0] for r in rows), len(rows), rows[:12]), flush=True)
        elif k == "light_set":  # diagnostics / tuning: { attr: value } on every light
            for ob_ in scn.objects:
                if ob_.type == "LIGHT" and c.get("only", ob_.data.type) == ob_.data.type:
                    print(f"[scene3d] light {ob_.name} {ob_.data.type} shadow={getattr(ob_.data, 'use_shadow', None)} hide={ob_.hide_render}", flush=True)
                    for attr, val in (c.get("values") or {}).items():
                        try:
                            setattr(ob_.data, attr, val)
                        except Exception as e:
                            print(f"[scene3d] light_set {attr}: {e}", flush=True)
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
                # Every view sends this on connect. Re-applying the settings
                # when nothing changed turned shadows back on — a recompile of
                # every material (seconds without frames: a frozen stage on
                # each scene change). Only a real switch sets them up.
                if not scn.render.engine.startswith("BLENDER_EEVEE"):
                    set_engine("EEVEE")
                    eevee_clean(live=True)
                _live_look()
            else:
                workbench_studio()
        elif k == "shading":
            sp, _r = _view3d()
            if sp:
                try:
                    sp.shading.type = c.get("type") or "RENDERED"
                except Exception:
                    pass

    def _tick_body():
        now = time.time()
        dt = now - LIVE["last"]
        LIVE["last"] = now
        if LIVE.get("reload"):
            _reload(LIVE.pop("reload"))
            return None  # this run's timer ends; the new run registers its own
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
                            LIVE["cmd_at"] = now
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
        ctl = LIVE.get("ctl", set())
        for conn in [c_ for c_ in ctl if c_ not in LIVE["clients"]]:
            ctl.discard(conn)
        if _strip_step(now):
            return 1.0 / 60.0
        if not [c_ for c_ in LIVE["clients"] if c_ not in ctl]:
            return 0.05
        follows = list(LIVE["views"].values())
        stage_on = LIVE["stage"] and any(c_ not in LIVE["views"] and c_ not in ctl for c_ in LIVE["clients"])
        if stage_on or follows:
            # Stage and timeline preview share ONE world and ONE clock; the
            # stage's dollhouse cut lives on its own view layer.
            if stage_on:
                if LIVE["stage_shot"] in _by_id and LIVE["stage_shot"] not in LIVE["paths"]:
                    _cam_path(LIVE["stage_shot"])  # frame_set: never inside the draw callback
                if LIVE["stage_shot"] in _by_id and LIVE["stage_shot"] not in LIVE.setdefault("skeys", {}):
                    LIVE["skeys"][LIVE["stage_shot"]] = _shot_keys(LIVE["stage_shot"])
                _stage_cutaway(True)
            # The scene's light rig is built on first use (it moves the
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
            if LIVE.pop("stage_stale", False):
                LIVE["stage_fr"] = None
                LIVE["main_fr"] = None
            if scn.frame_current != fr or LIVE.get("main_fr") != fr:
                t0_ = time.perf_counter()
                scn.frame_set(fr)
                _perf("frame_set", t0_)
                if LIVE.get("main_fr") is not None:
                    LIVE["time_at"] = now  # the clock itself moved, not a camera edit
                LIVE["main_fr"] = fr
                LIVE["clock_at"] = now
                # Playing: one draw per frame (two only for a lone change).
                LIVE["dirty"] = 1 if now - LIVE.get("moved_at", 0.0) < 0.25 else 2
                LIVE["moved_at"] = now
            # The stage draws every frame too, on its own view layer (its own
            # depsgraph, evaluated here for the frames it draws). It used to
            # be throttled to ~5/s because each stage draw cost ~20 ms — that
            # was its free camera's 100 m far clip (see live_cam), not the
            # stage itself. KOI_STAGE_FPS caps it again if ever needed.
            cap_ = float(os.environ.get("KOI_STAGE_FPS") or 0)
            stage_due = stage_on and (not follows or not LIVE.get("moving") or cap_ <= 0
                                      or now - LIVE.get("stage_drawn", 0.0) >= 1.0 / cap_)
            if stage_due and LIVE.get("stage_fr") != fr:
                # The stage layer has its own depsgraph: evaluate it at the
                # same frame.
                t0_ = time.perf_counter()
                with bpy.context.temp_override(view_layer=_stage_layer()):
                    scn.frame_set(fr)
                _perf("frame_set_stage", t0_)
                LIVE["stage_fr"] = fr
            LIVE["stage_due"] = stage_due
            if LIVE.get("warm_req") and not stage_on:
                # Its depsgraph first (drawing a never-evaluated layer
                # crashes Blender), then the unseen draw (warm_stage).
                with bpy.context.temp_override(view_layer=_stage_layer()):
                    scn.frame_set(fr)
                LIVE["stage_fr"] = fr
                LIVE["warm_stage"] = LIVE.pop("warm_req")
                LIVE["dirty"] = max(LIVE.get("dirty", 0), 1)
            if stage_on and LIVE.get("stage_follow"):
                _follow_active_cam()
            elif stage_on and LIVE.get("stage_track") and not LIVE.get("stage_pov"):
                _track_overview()
            if stage_on and not LIVE.get("stage_pov") and now - LIVE.get("time_at", 0.0) < 0.4 \
                    and now - LIVE.get("occl_at", 0.0) >= 0.1:
                LIVE["occl_at"] = now
                t0_ = time.perf_counter()
                _stage_occluders()
                _perf("stage_occluders", t0_)
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
            _perf_dump()
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

    def _linear_depth(cam, w, h, dg, used, proj=None):
        """Distance to the camera per pixel (metres) in an RGBA32F offscreen;
        through [proj] when the image was drawn with one of its own."""
        zs = _zshader()
        key = ("z", w, h)
        oz = offscreen.get(key)
        if oz is None:
            oz = offscreen[key] = gpu.types.GPUOffScreen(w, h, format="RGBA32F")
        used.add(key)
        view = cam.matrix_world.inverted()
        if proj is None:
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

    def _dof_pass(o, cam, w, h, used, tag="", proj=None):
        """Lens blur over offscreen o when the shot camera has DOF on;
        returns the offscreen to ship (o itself when there is none). [proj]:
        the projection o was drawn with, when not the camera's own (the stage
        through the camera, framed to fit): depth and blur size follow it."""
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
            if proj is not None:  # pixels per sensor mm as this image shows it
                kpx = (f_mm * f_mm / (n_stop * max(S - f_mm, 1.0))) * abs(proj[0][0]) * w / (2.0 * f_mm) * 0.5
            dtex = _linear_depth(cam, w, h, bpy.context.evaluated_depsgraph_get(), used, proj).texture_color
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
            # A client that became a view after this stage frame was queued must
            # not get it: at the stage's size, it replaced the view's own surface
            # and a paused player, never redrawn, kept the wrong aspect.
            is_view_frame = isinstance(key, tuple) and key[0] == "v"
            pconns = [c_ for c_ in pconns if c_ in LIVE["clients"] and (is_view_frame or c_ not in LIVE["views"])]
            if pconns:
                t0_ = time.perf_counter()
                _ship(po, pw, ph, pconns)
                _perf("ship_" + str(key[0] if isinstance(key, tuple) else key), t0_)
        pend.clear()
        if req == "flush":  # nothing new to draw: the last frame went out
            return
        ctx = bpy.context
        sp, reg = ctx.space_data, ctx.region
        dg = ctx.evaluated_depsgraph_get()
        used = set()
        if req == "strip":  # only the filmstrip frame: the views keep their last one
            _strip_draw(ctx, sp, reg, dg, used)
            return
        ctl = LIVE.get("ctl", set())
        legacy = [c_ for c_ in LIVE["clients"] if c_ not in LIVE["views"] and c_ not in ctl]
        if LIVE["views"]:
            for conn, v in list(LIVE["views"].items()):
                cam = CAMS.get(v["shot"])
                if cam is None or conn not in LIVE["clients"]:
                    continue
                w, h = v["w"], v["h"]
                tag = id(conn)
                t0_ = time.perf_counter()
                o = _offscreen_k(("v", tag, w, h), w, h, used)
                o.draw_view3d(scn, ctx.view_layer, sp, reg, cam.matrix_world.inverted(),
                              cam.calc_matrix_camera(dg, x=w, y=h), do_color_management=True)
                pend[("v", tag)] = (_dof_pass(o, cam, w, h, used, tag), w, h, [conn])
                _perf("draw_preview", t0_)
        if LIVE.get("warm_stage") and not legacy:
            ww_, wh_ = LIVE.pop("warm_stage")
            keep_ = (LIVE["stage"], LIVE["w"], LIVE["h"])
            LIVE["stage"], LIVE["w"], LIVE["h"] = True, ww_, wh_
            try:
                if not LIVE["stage_view"]:
                    pos_, tgt_, ln_ = _stage_home()
                    LIVE["stage_view"] = {"pos": pos_, "tgt": tgt_, "lens": ln_}
                _draw_legacy(ctx, sp, reg, dg, used, [])
            except Exception as e:
                print("[scene3d] warm stage failed:", repr(e), flush=True)
            finally:
                LIVE["stage"], LIVE["w"], LIVE["h"] = keep_
                LIVE.get("pend", {}).pop("st", None)
        if legacy:
            # While playing, the stage (a second full render competing for
            # the GPU) refreshes ~5x/s, on the frames the tick evaluated its
            # layer for (stage_due); the preview keeps every frame.
            if not LIVE["stage"] or not LIVE["views"] or LIVE.get("stage_due"):
                LIVE["stage_drawn"] = time.time()
                LIVE["stage_due"] = False
                t0_ = time.perf_counter()
                _draw_legacy(ctx, sp, reg, dg, used, legacy)
                _perf("draw_stage", t0_)
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
        if LIVE["stage"] and LIVE.get("stage_pov"):
            f = None  # through the shot camera itself: its move, zoom and cuts, live
        if f:
            cam_d_live = bpy.data.cameras.get("live_cam") or bpy.data.cameras.new("live_cam")
            live = bpy.data.objects.get("live_cam") or bpy.data.objects.new("live_cam", cam_d_live)
            # Write the free camera ONLY when it changed: every RNA write tags
            # the depsgraph, and EEVEE then re-synced the whole scene on every
            # stage draw (~20 ms, the stage's whole cost while playing).
            near_ = 0.05
            if LIVE.get("occl_clip") is not None and LIVE["stage"]:
                near_ = max(near_, (LIVE["occl_clip"] - f["pos"]).dot((f["tgt"] - f["pos"]).normalized()))
            key = (tuple(f["pos"]), tuple(f["tgt"]), float(f["lens"]), bool(f.get("ortho")), near_)
            if LIVE.get("live_cam_key") != key or live.data is not cam_d_live:
                LIVE["live_cam_key"] = key
                cam_d_live.sensor_fit = "HORIZONTAL"
                cam_d_live.sensor_width = 36.0
                cam_d_live.lens = f["lens"]
                # Orthographic stage view (Blender's numpad-5): same framing width.
                cam_d_live.type = "ORTHO" if f.get("ortho") else "PERSP"
                cam_d_live.ortho_scale = max(0.1, 2.0 * (f["tgt"] - f["pos"]).length * 18.0 / f["lens"])
                cam_d_live.clip_start = near_
                # Same far clip as the shot cameras. Blender's default 100 m
                # made EEVEE's every stage draw ~10x slower (24 ms vs 2.4 ms,
                # measured), whatever the view showed.
                cam_d_live.clip_end = 500.0
                live.location = f["pos"]
                live.rotation_euler = (f["tgt"] - f["pos"]).to_track_quat("-Z", "Y").to_euler()
                live.matrix_world = live.matrix_basis
            cam = live
        view = cam.matrix_world.inverted()
        proj = cam.calc_matrix_camera(dg, x=w, y=h)
        pov_ = LIVE["stage"] and not f and LIVE.get("stage_pov")
        if pov_:
            proj = _fit_frame(sh["id"], view, proj, w, h)
        o = _offscreen_k(("st", w, h), w, h, used)
        t0_ = time.perf_counter()
        o.draw_view3d(scn, _stage_layer() if LIVE["stage"] else ctx.view_layer, sp, reg, view, proj,
                      do_color_management=True)
        _perf("stage_view3d", t0_)
        if pov_:  # through the camera: its focus, as the player's preview shows it
            o = _dof_pass(o, cam, w, h, used, "st", proj)
        if LIVE["stage"]:
            t0_ = time.perf_counter()
            with o.bind():
                _draw_cams(view, proj, w, h)
                fsid = sh["id"] if pov_ else LIVE["stage_shot"]
                LIVE["frame_at"] = None
                LIVE["stage_m"] = (proj @ view).copy() if pov_ else None
                if (pov_ or LIVE.get("stage_follow")) and fsid in CAMS and not LIVE.get("stage_noshot"):
                    _draw_frame(fsid, view, proj, w, h)
            _perf("stage_cams", t0_)
            now = time.time()
            # Throttled only while playing (frames keep coming). Paused, a
            # skipped message was never resent: after switching view the app
            # kept the previous mode's camera and frame (a stray number, no
            # hover on the frame).
            if now - LIVE["proj_at"] > 0.08 or not LIVE.get("playing"):
                LIVE["proj_at"] = now
                msg = {"type": "stage", "ms": LIVE["stage_ms"], "cams": _stage_proj(view, proj),
                       "active": LIVE["stage_shot"], **_cam_handles(LIVE["stage_shot"], proj @ view)}
                if LIVE.get("frame_at"):
                    msg["frame"] = LIVE["frame_at"]  # the frame stands for the camera (behind / through it)
                if (LIVE.get("stage_follow") or LIVE.get("stage_track")) and LIVE["stage_view"]:
                    sv = LIVE["stage_view"]
                    msg["follow"] = {"pos": list(sv["pos"]), "target": list(sv["tgt"]), "lens": sv["lens"],
                                     "seq": LIVE.get("view_seq")}
                for conn in conns:
                    _send_json(msg, only=conn)
        LIVE.setdefault("pend", {})["st"] = (o, w, h, list(conns))

    LIVE["draw_h"] = bpy.types.SpaceView3D.draw_handler_add(_draw, (), "WINDOW", "POST_PIXEL")
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
    def _tick():
        # An exception would unregister the timer for good: the process stays
        # up but deaf (no frames, no commands — a pooled one never loads).
        # Report each distinct error once and keep ticking.
        try:
            return _tick_body()
        except Exception as e:
            seen = LIVE.setdefault("tick_errs", set())
            if repr(e) not in seen:
                seen.add(repr(e))
                import traceback
                print("[scene3d] tick error:", traceback.format_exc(), flush=True)
            return 0.05

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
r.ffmpeg.constant_rate_factor = "PERC_LOSSLESS" if args.max_quality else "MEDIUM"
r.ffmpeg.ffmpeg_preset = "BEST" if args.max_quality else "REALTIME"
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


def _scene_subject():
    """Centre and spread of everything the shots look at (each at its start)."""
    pts = []
    for s_ in _by_id.values():
        t_ = bpy.data.objects.get(f"cam_target_{s_['id']}")
        if t_ is None:
            continue
        scn.frame_set(ms_to_frame(int(s_.get("startMs") or 0)))
        pts.append(t_.matrix_world.translation.copy())
    if not pts:
        return Vector((0, 0, 1.4)), 0.0
    c_ = sum(pts, Vector((0, 0, 0))) / len(pts)
    return c_, max((p_ - c_).length for p_ in pts)


_scene_rig = []


def apply_shot_light(sh):
    """shot.light = { key: "screen_left"|"screen_right"|"back"|"front"|"top"|"left"|"right"|deg,
    quality: "soft"|"hard", intensity?, color?, rim?: bool }. The lighting is
    the SCENE's, built ONCE and fixed in the world (see _scene_key_light):
    cutting to another camera never moves, relights or switches anything.
    SH is only the shot about to be seen; the rig ignores it.
    Workbench gets the shadow direction, EEVEE a key (+ rim) rig."""
    if _scene_rig:
        return
    _scene_rig.append(True)
    key = _scene_key_light()
    if key is None:
        return
    toward, hard, spec, kback = key
    up = Vector((0, 0, 1))
    try:
        scn.display.light_direction = toward
        scn.display.shadow_focus = 0.05 if hard else 0.6
    except Exception:
        pass
    # Lights live INSIDE the set (a sun would be blocked by the room's walls /
    # ceiling), aimed at the centre of all the action with a cone wide
    # enough to cover every shot's subject: soft = big area, hard = spot.
    subj, spread = _scene_subject()
    dist = float(spec.get("distance") or 3.0)
    cone = min(math.radians(160), max(math.radians(70), 2 * math.atan((spread + 1.0) / dist)))
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
        lid = f"scenelight_{name}"
        ob = _shot_lights.get(lid)
        if ob is None:
            # ONE shadow-casting light (the key, a spot — a big soft AREA's
            # shadow is sampled stochastically = grain); fill / rim only shape.
            ld = bpy.data.lights.new(lid, "SPOT" if name == "key" else "AREA")
            ob = bpy.data.objects.new(lid, ld)
            link(ob)
            _shot_lights[lid] = ob
        ob.location = subj + vec * dist
        ob.rotation_euler = (subj - ob.location).to_track_quat("-Z", "Y").to_euler()
        ob.data.energy = energy * float(spec.get("intensity") or 1.0) * (dist / 3.0) ** 2
        ob.data.color = hex_rgba(spec.get("color") or ("#e6edff" if name == "key" else "#ffffff"))[:3]
        if ob.data.type == "AREA":
            ob.data.size = 2.2 if name != "rim" else 1.2
            ob.data.use_shadow = False
        else:
            ob.data.spot_size = cone
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

def body_snaps(f0, f1):
    """Frames where a body's trunk jumps faster than any body can turn (60
    degrees in one frame at 24 fps is 4 turns a second), read from the keys."""
    limit = math.radians(60) * 24.0 / FPS

    def at(ob, fr):
        vals = list(ob.rotation_euler)
        act = ob.animation_data.action if ob.animation_data else None
        for fc in (act.fcurves if act else []):
            if fc.data_path == "rotation_euler":
                vals[fc.array_index] = fc.evaluate(fr)
        return Euler(vals, "XYZ").to_quaternion()

    out = []
    for cid, parts in CHARS.items():
        prev = None
        for fr in range(f0, f1 + 1):
            q = at(parts["root"], fr) @ at(parts["hips"], fr)
            if prev is not None:
                ang = prev.rotation_difference(q).angle
                ang = min(ang, 2 * math.pi - ang)
                if ang > limit:
                    out.append({"character": cid, "ms": int(round((fr - 1) * 1000.0 / FPS)), "degrees": round(math.degrees(ang))})
            prev = q
        # A body swinging round on itself: quicker than a sharp turn on the
        # feet, spread over several frames so no single one shows it.
        win = max(1, int(round(0.2 * FPS)))
        limit_yaw = math.radians(75)
        yaw = [at(parts["root"], fr).to_euler("XYZ").z for fr in range(f0, f1 + 1)]
        peak, peak_fr = 0.0, None
        for i in range(win, len(yaw) + 1):
            turn = 0.0
            if i < len(yaw):
                turn = abs((yaw[i] - yaw[i - win] + math.pi) % (2 * math.pi) - math.pi)
            if turn > limit_yaw and turn > peak:
                peak, peak_fr = turn, f0 + i
            elif turn <= limit_yaw and peak_fr is not None:
                out.append({"character": cid, "ms": int(round((peak_fr - 1) * 1000.0 / FPS)), "degrees": round(math.degrees(peak)), "over": "0.2 s"})
                peak, peak_fr = 0.0, None
    return out


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
    # Second by second (cap 40 samples): who and which moving vehicle is in
    # frame, where (x 0 left .. 1 right) and how far (m) — a long take changes
    # what it shows many times; three samples said nothing about it.
    riders = {a_.get("character"): a_.get("prop") for a_ in (S.get("actions") or [])
              if (a_.get("type") or "").lower() == "ride"}
    # Vehicles only (a driven prop that is a vehicle shape, or carries someone):
    # small parts driven along with them (a steering wheel) are noise.
    _veh = {"car", "racecar", "van", "truck", "bus", "motorbike", "bicycle"}
    _shape = {p_.get("id"): (p_.get("shape") or p_.get("kind") or "") for p_ in (SETD.get("props") or [])}
    movers = sorted({a_.get("prop") for a_ in (S.get("actions") or [])
                     if (a_.get("type") or "").lower() == "drive" and a_.get("prop")
                     and (_shape.get(a_.get("prop")) in _veh or a_.get("prop") in riders.values())})
    step = max(1, int(FPS), (f1 - f0) // 40)
    timeline = []

    def _faces(ob, wpt):
        """Which way something faces as the shot sees it: 'camera' (we see
        its front), 'away' (its back), 'left' / 'right' (profile, facing that
        side of the frame). Characters and vehicles both face local +y."""
        fwd = (ob.matrix_world.to_3x3() @ Vector((0.0, 1.0, 0.0)))
        # A body lying down faces the sky: seen from above its face is its
        # front, so the view is judged in 3D, not on the ground plane.
        flat = abs(fwd.normalized().z) < 0.7 if fwd.length > 1e-6 else True
        if flat:
            fwd.z = 0.0
        if fwd.length < 1e-6:
            return None
        fwd.normalize()
        to_cam = cam.matrix_world.translation - wpt
        if flat:
            to_cam.z = 0.0
        if to_cam.length < 1e-6:
            return None
        to_cam.normalize()
        # The angle between where it faces and where the camera is, and which
        # of ITS sides the camera is on: the way an operator names the view.
        ang = math.degrees(math.acos(max(-1.0, min(1.0, fwd.dot(to_cam)))))
        side_ = "left" if (fwd.x * to_cam.y - fwd.y * to_cam.x) > 0 else "right"
        if ang < 25:
            return "front"
        if ang < 65:
            return f"front-{side_}"
        if ang < 115:
            return f"side-{side_}"
        if ang < 155:
            return f"back-{side_}"
        return "back"

    def _off(qs, wpt):
        """Where something NOT in frame is, from the camera: 'left' / 'right' /
        'above' / 'below' / 'behind', and how far (m) — only when near (< 25 m)."""
        d = (wpt - cam.matrix_world.translation).length
        if d > 25.0:
            return None
        zq = [q for q in qs if q.z > 0]
        if not zq:
            return ("behind", round(d, 1))
        cx = sum(q.x for q in zq) / len(zq)
        cy = sum(q.y for q in zq) / len(zq)
        side_ = "left" if cx < 0 else "right" if cx > 1 else ("below" if cy < 0 else "above")
        return (side_, round(d, 1))
    for fr in range(f0, f1 + 1, step):
        scn.frame_set(fr)
        seen = []
        for cid, parts in CHARS.items():
            root = parts["root"].matrix_world.translation
            hgt = float(parts.get("height") or 1.75)
            qs = [world_to_camera_view(scn, cam, root + Vector((0, 0, hgt * t))) for t in (0.05, 0.5, 0.95)]
            # The head where it really is (seated, in a cockpit, a close-up).
            nk = parts.get("neck")
            if nk is not None:
                qs.append(world_to_camera_view(scn, cam, nk.matrix_world.translation + Vector((0, 0, 0.12 * hgt / 1.75))))
            vis = [q for q in qs if q.z > 0 and -0.02 <= q.x <= 1.02 and -0.02 <= q.y <= 1.02]
            if not vis:
                o_ = _off(qs, root)
                if o_:
                    seen.append({"id": cid, "kind": "character", "off": o_[0], "dist": o_[1],
                                 **({"in": riders[cid]} if cid in riders else {})})
            if vis:
                seen.append({"id": cid, "kind": "character", "x": round(sum(q.x for q in vis) / len(vis), 2),
                             "dist": round(sum(q.z for q in vis) / len(vis), 1),
                             "faces": _faces(parts["hips"], parts["hips"].matrix_world.translation),
                             **({"in": riders[cid]} if cid in riders else {})})
        for pid_ in movers:
            ob = bpy.data.objects.get(f"prop_{pid_}")
            if not ob:
                continue
            # The vehicle's footprint corners + centre: in frame if any is.
            mw = ob.matrix_world
            corners = ([mw @ Vector((dx, dy, 0.4)) for dx in (-0.9, 0.9) for dy in (-2.5, 2.5)]
                       + [mw @ Vector((0.0, dy, 0.55)) for dy in (-1.5, 0.0, 1.5)] + [mw.translation])
            qs = [world_to_camera_view(scn, cam, v) for v in corners]
            vis = [q for q in qs if q.z > 0 and -0.02 <= q.x <= 1.02 and -0.05 <= q.y <= 1.05]
            if not vis:
                o_ = _off(qs, mw.translation)
                if o_:
                    seen.append({"id": pid_, "kind": "vehicle", "off": o_[0], "dist": o_[1]})
            if vis:
                seen.append({"id": pid_, "kind": "vehicle", "x": round(sum(q.x for q in vis) / len(vis), 2),
                             "dist": round(sum(q.z for q in vis) / len(vis), 1),
                             "faces": _faces(ob, mw.translation)})
        timeline.append({"ms": int(round((fr - 1) * 1000.0 / FPS)), "seen": seen})
    return {
        "timeline": timeline,
        "bodySnaps": body_snaps(f0, f1),
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
        full_pct, full_smp = r.resolution_percentage, getattr(scn.eevee, "taa_render_samples", 0)
        for i, ms in enumerate(j["stills"]):
            if j.get("smallFrom") is not None and i == int(j["smallFrom"]):
                # Filmstrip thumbnails: a quarter size, few samples — seconds
                # instead of a minute for a whole shot.
                r.resolution_percentage = max(10, full_pct // 4)
                try:
                    scn.eevee.taa_render_samples = 4
                except Exception:
                    pass
            scn.frame_set(ms_to_frame(ms))
            r.filepath = f"{j['out']}-{i}.png"
            bpy.ops.render.render(write_still=True)
        r.resolution_percentage = full_pct
        try:
            scn.eevee.taa_render_samples = full_smp
        except Exception:
            pass
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
