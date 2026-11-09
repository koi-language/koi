/**
 * Blender-side 3D modeler, embedded as a string like the scene builder.
 * Runs a modeling script written by the agent, normalises and exports the
 * result as .glb, and renders the review the agent checks it with:
 * a turnaround sheet and, per reference photo, the model seen from that
 * photo's camera next to the photo and blended over it.
 *
 * NOTE: plain Python inside String.raw — never use backticks or ${ in it.
 */
export const BUILD_MODEL_PY = String.raw`
"""
Braxil 3D modeler — Blender side.

  blender -b --factory-startup -P build_model.py -- \
      --script build.py --out <dir> [--kind object|set] [--refs refs.json]

Conventions (metres): x right, y forward (an object's FRONT faces +y,
vehicles' nose at +y), z up. An object is centred on x/y with its bottom
at z = 0 (re-centred here). A set is authored in scene coordinates.
"""

import bpy
import json
import math
import os
import sys
import argparse
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--script", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--kind", default="object")
ap.add_argument("--refs", default=None)
ap.add_argument("--size", type=int, default=640)
args = ap.parse_args(argv)

KIND = "set" if args.kind == "set" else "object"
OUT = args.out
os.makedirs(os.path.join(OUT, "review"), exist_ok=True)
scn = bpy.context.scene

for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
scn.unit_settings.system = "METRIC"


def hex_rgba(c, a=1.0):
    if isinstance(c, (list, tuple)):
        v = list(c) + [a]
        return tuple(float(x) for x in v[:4])
    s = str(c or "#888888").lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    srgb = [int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in srgb]
    return (lin[0], lin[1], lin[2], a)


def _set_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return


def pbr(name, color="#888888", rough=0.5, metal=0.0, coat=0.0, transmission=0.0, ior=1.45,
        emission=None, emission_strength=3.0, alpha=1.0):
    """Principled material with only scalar inputs, so it survives the glTF
    export exactly (clearcoat, transmission and emission included)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    col = hex_rgba(color)
    b.inputs["Base Color"].default_value = col
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    _set_input(b, ("Coat Weight", "Clearcoat"), coat)
    _set_input(b, ("Transmission Weight", "Transmission"), transmission)
    _set_input(b, ("IOR",), ior)
    if emission is not None:
        _set_input(b, ("Emission Color", "Emission"), hex_rgba(emission))
        _set_input(b, ("Emission Strength",), emission_strength)
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            m.blend_method = "BLEND"
    m.diffuse_color = col
    m.roughness = rough
    m.metallic = metal
    return m


_PHOTOS = {}


def photo_material(name, photo, corners, size=512):
    """A material that shows a piece of a reference photo — for flat printed
    things (a poster, a framed picture, a screen, a rug's pattern, a book
    cover). corners: the thing's four corners in the photo, 0..1 with y
    DOWN, in order top-left, top-right, bottom-right, bottom-left: the crop
    is un-warped to a straight rectangle, so a poster seen at an angle comes
    out flat. Put it on a plane (primitive_plane_add: UVs 0..1) sized and
    turned like the real thing. The image travels inside the model."""
    import numpy as np
    if photo not in _PHOTOS:
        src = bpy.data.images.load(photo, check_existing=True)
        w_, h_ = src.size
        px = np.array(src.pixels[:], dtype=np.float32).reshape(h_, w_, 4)[::-1]  # rows top-down
        _PHOTOS[photo] = px
    px = _PHOTOS[photo]
    H_, W_ = px.shape[:2]
    pts = [(float(x) * (W_ - 1), float(y) * (H_ - 1)) for x, y in corners]
    # Homography from the unit square to the four photo points.
    A, bv = [], []
    for (u, v), (x, y) in zip([(0, 0), (1, 0), (1, 1), (0, 1)], pts):
        A.append([u, v, 1, 0, 0, 0, -u * x, -v * x]); bv.append(x)
        A.append([0, 0, 0, u, v, 1, -u * y, -v * y]); bv.append(y)
    h = np.linalg.solve(np.array(A, dtype=np.float64), np.array(bv, dtype=np.float64))
    Hm = np.array([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]])
    # Output keeps the crop's own proportions.
    top = math.dist(pts[0], pts[1]); side = math.dist(pts[0], pts[3])
    ow = max(8, int(size if top >= side else size * top / max(side, 1e-6)))
    oh = max(8, int(size if side >= top else size * side / max(top, 1e-6)))
    uu, vv = np.meshgrid((np.arange(ow) + 0.5) / ow, (np.arange(oh) + 0.5) / oh)
    q = Hm @ np.stack([uu.ravel(), vv.ravel(), np.ones(uu.size)])
    xs = np.clip(q[0] / q[2], 0, W_ - 1).astype(np.int32)
    ys = np.clip(q[1] / q[2], 0, H_ - 1).astype(np.int32)
    out = px[ys, xs].reshape(oh, ow, 4)[::-1].copy()  # back to Blender's bottom-up rows
    out[..., 3] = 1.0
    img = bpy.data.images.new(f"{name}_img", ow, oh, alpha=False)
    img.pixels.foreach_set(out.ravel())
    img.pack()
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 1.0
    mean = out[..., :3].reshape(-1, 3).mean(axis=0)
    m.diffuse_color = (float(mean[0]), float(mean[1]), float(mean[2]), 1.0)
    return m


def assign(obj, mat):
    """Give a mesh object exactly one material."""
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


# Reference photos with the camera each one was taken from (estimated by
# the agent). The review renders the model from these cameras.
REFS = []
if args.refs and os.path.exists(args.refs):
    with open(args.refs, "r", encoding="utf-8") as f:
        REFS = json.load(f) or []

REF_CAMS = []
for i, r in enumerate(REFS):
    try:
        img = bpy.data.images.load(r["image"], check_existing=True)
        w, h = img.size
    except Exception as e:
        print(f"[model3d] reference {i} unreadable: {e}", file=sys.stderr)
        continue
    c = r.get("camera") or {}
    cd = bpy.data.cameras.new(f"ref_cam_{i}")
    cd.lens = float(c.get("lens") or 35)
    cd.sensor_fit = "HORIZONTAL" if w >= h else "VERTICAL"
    cd.sensor_width = cd.sensor_height = float(c.get("sensor") or 36)
    cd.clip_end = 2000
    ob = bpy.data.objects.new(f"ref_cam_{i}", cd)
    scn.collection.objects.link(ob)
    pos = Vector(c.get("position") or (0, 8, 1.6))
    tgt = Vector(c.get("target") or (0, 0, 0.8))
    ob.location = pos
    ob.rotation_euler = (tgt - pos).to_track_quat("-Z", "Y").to_euler()
    if c.get("roll"):
        ob.rotation_euler.rotate_axis("Z", math.radians(float(c["roll"])))
    REF_CAMS.append({"obj": ob, "image": img, "path": r["image"], "w": w, "h": h})

_wrapper_objs = set(bpy.data.objects)

# ─────────────────────────────────────────────── the agent's script ──

with open(args.script, "r", encoding="utf-8") as f:
    _src = f.read()
_ns = {
    "__name__": "__braxil_model__", "bpy": bpy, "math": math, "Vector": Vector, "Matrix": Matrix,
    "pbr": pbr, "assign": assign, "hex_rgba": hex_rgba, "KIND": KIND, "REF_CAMS": REF_CAMS,
    "photo_material": photo_material,
}
import bmesh  # noqa: E402
_ns["bmesh"] = bmesh
exec(compile(_src, args.script, "exec"), _ns)
bpy.context.view_layer.update()

model = [o for o in bpy.data.objects if o not in _wrapper_objs and o.type in ("MESH", "CURVE", "EMPTY", "FONT", "SURFACE", "META")]
meshes = [o for o in model if o.type != "EMPTY"]
if not meshes:
    raise RuntimeError("the script built no geometry")
for o in bpy.data.objects:
    if o not in _wrapper_objs and o not in model:
        bpy.data.objects.remove(o, do_unlink=True)


def bbox(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        ev = o.evaluated_get(dg)
        for c in ev.bound_box:
            w = ev.matrix_world @ Vector(c)
            mn = Vector((min(mn.x, w.x), min(mn.y, w.y), min(mn.z, w.z)))
            mx = Vector((max(mx.x, w.x), max(mx.y, w.y), max(mx.z, w.z)))
    return mn, mx


mn, mx = bbox(meshes)
offset = Vector((0, 0, 0))
if KIND == "object":
    # Centred on x/y, standing on z = 0: the scene places it by its footprint.
    offset = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
    if offset.length > 1e-4:
        for o in model:
            if o.parent is None or o.parent not in model:
                o.location += offset
        for rc in REF_CAMS:
            rc["obj"].location += offset
        bpy.context.view_layer.update()
        mn, mx = mn + offset, mx + offset
dims = mx - mn

# ───────────────────────────────────────────────────────────── export ──

for o in bpy.data.objects:
    o.select_set(o in model)
bpy.context.view_layer.objects.active = meshes[0]
glb = os.path.join(OUT, "model.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_apply=True,
                          export_cameras=False, export_lights=False, export_yup=True)

dg = bpy.context.evaluated_depsgraph_get()
tris = 0
mats = set()
for o in meshes:
    ev = o.evaluated_get(dg)
    try:
        me = ev.to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        ev.to_mesh_clear()
    except Exception:
        pass
    for s in o.material_slots:
        if s.material:
            mats.add(s.material.name)

# ──────────────────────────────────────────────────────────── review ──
# Rendered from the EXPORTED file, re-imported: what the agent looks at is
# exactly what the scenes will get.

for o in list(bpy.data.objects):
    if o not in _wrapper_objs:
        bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.materials):
    if m.users == 0:
        bpy.data.materials.remove(m)
bpy.ops.import_scene.gltf(filepath=glb)
bpy.context.view_layer.update()

r = scn.render
for n in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        r.engine = n
        break
    except TypeError:
        continue
try:
    scn.eevee.taa_render_samples = 32
except Exception:
    pass
try:
    scn.view_settings.view_transform = "AgX"
except Exception:
    pass
r.image_settings.file_format = "PNG"
r.film_transparent = False

world = bpy.data.worlds.new("review") if not scn.world else scn.world
scn.world = world
world.use_nodes = True
wn = world.node_tree
bgn = wn.nodes.get("Background")
bgn.inputs["Color"].default_value = (0.62, 0.66, 0.72, 1)
bgn.inputs["Strength"].default_value = 0.9
sun_d = bpy.data.lights.new("review_sun", "SUN")
sun_d.energy = 3.2
sun_d.angle = math.radians(4)
sun = bpy.data.objects.new("review_sun", sun_d)
scn.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))

# Sets frame what stands on the ground, not the (huge) ground itself.
fmn, fmx = mn, mx
if KIND == "set":
    tall = []
    for o in bpy.data.objects:
        if o.type == "MESH" and o not in _wrapper_objs:
            a, b = bbox([o])
            if b.z - a.z > 0.3:
                tall.append(o)
    if tall:
        fmn, fmx = bbox(tall)
fd = fmx - fmn
span = max(fd.x, fd.y, fd.z, 0.1)
if KIND == "object":
    g = bpy.data.meshes.new("review_ground")
    s_ = span * 6
    g.from_pydata([(-s_, -s_, 0), (s_, -s_, 0), (s_, s_, 0), (-s_, s_, 0)], [], [(0, 1, 2, 3)])
    go = bpy.data.objects.new("review_ground", g)
    go.data.materials.append(pbr("review_ground", "#8d8d8d", 0.9))
    scn.collection.objects.link(go)

center = (fmn + fmx) / 2


def look_cam(name, pos, tgt, lens=50):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_end = 5000
    ob = bpy.data.objects.new(name, cd)
    scn.collection.objects.link(ob)
    ob.location = pos
    ob.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
    return ob


def render_to(cam, w, h, path):
    scn.camera = cam
    r.resolution_x, r.resolution_y = int(w), int(h)
    r.resolution_percentage = 100
    r.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def pixels(path, w=None, h=None):
    img = bpy.data.images.load(path, check_existing=False)
    if w and h and (img.size[0] != w or img.size[1] != h):
        img.scale(int(w), int(h))
    W, H = img.size
    px = list(img.pixels[:])
    bpy.data.images.remove(img)
    return W, H, px


def save_canvas(path, W, H, px):
    img = bpy.data.images.new("canvas", W, H, alpha=True)
    img.pixels[:] = px
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def tile(parts, cols, cell_w, cell_h, gap=6):
    """parts: [(W, H, px)] each cell_w x cell_h (bottom-up rows, Blender order)."""
    rows = (len(parts) + cols - 1) // cols
    W = cols * cell_w + (cols - 1) * gap
    H = rows * cell_h + (rows - 1) * gap
    out = [0.08, 0.08, 0.08, 1.0] * (W * H)
    for k, (_w, _h, px) in enumerate(parts):
        cx = (k % cols) * (cell_w + gap)
        cy = (rows - 1 - k // cols) * (cell_h + gap)
        for y in range(cell_h):
            src = y * cell_w * 4
            dst = ((cy + y) * W + cx) * 4
            out[dst:dst + cell_w * 4] = px[src:src + cell_w * 4]
    return W, H, out


review = {"turnaround": None, "references": []}
S = args.size
CW, CH = S, int(S * 0.75)
# A long lens keeps the review views close to orthographic: proportions
# read without perspective distortion.
LENS = 85
fov = 2 * math.atan(36 / (2 * LENS))
dist = (span * 0.62) / math.tan(fov / 2) + span * 0.5
if KIND == "object":
    h_ = center.z

    def fit(a, b):
        """Distance that frames extents a (across) x b (up) in a 4:3 cell."""
        need = max(a, b * 4 / 3, 0.1) * 0.62
        return need / math.tan(fov / 2) + max(dims.x, dims.y) * 0.5

    df, ds = fit(dims.x, dims.z), fit(dims.y, dims.z)
    views = [
        ("front", (0, df, h_ + dims.z * 0.15)),
        ("side", (ds, 0, h_ + dims.z * 0.15)),
        ("back", (0, -df, h_ + dims.z * 0.15)),
        ("three_quarter", (-dist * 0.72, dist * 0.72, h_ + dist * 0.45)),
    ]
else:
    up = max(fd.z, span * 0.35)
    views = [
        ("corner_a", (center.x - dist * 0.7, center.y - dist * 0.7, up + dist * 0.4)),
        ("corner_b", (center.x + dist * 0.7, center.y - dist * 0.7, up + dist * 0.4)),
        ("corner_c", (center.x + dist * 0.7, center.y + dist * 0.7, up + dist * 0.4)),
        ("top", (center.x, center.y - 0.01, up + dist * 1.1)),
    ]
cells = []
for name, pos in views:
    cam = look_cam(f"review_{name}", Vector(pos), center, LENS)
    p = render_to(cam, CW, CH, os.path.join(OUT, "review", f"view-{name}.png"))
    cells.append(pixels(p))
W_, H_, px_ = tile(cells, 2, CW, CH)
review["turnaround"] = os.path.join(OUT, "review", "turnaround.png")
save_canvas(review["turnaround"], W_, H_, px_)

for i, rc in enumerate(REF_CAMS):
    w, h = rc["w"], rc["h"]
    k = S / max(w, h)
    cw, ch = max(2, int(w * k)), max(2, int(h * k))
    p = render_to(rc["obj"], cw, ch, os.path.join(OUT, "review", f"ref-{i}-render.png"))
    _, _, rpx = pixels(p)
    _, _, ppx = pixels(rc["path"], cw, ch)
    over = [ppx[j] * 0.5 + rpx[j] * 0.5 for j in range(len(rpx))]
    for j in range(3, len(over), 4):
        over[j] = 1.0
        ppx[j] = 1.0
    W2, H2, px2 = tile([(cw, ch, ppx), (cw, ch, rpx), (cw, ch, over)], 3, cw, ch)
    out = os.path.join(OUT, "review", f"ref-{i}.png")
    save_canvas(out, W2, H2, px2)
    review["references"].append({"index": i, "image": rc["path"], "compare": out})

stats = {
    "kind": KIND,
    "dims": [round(dims.x, 3), round(dims.y, 3), round(dims.z, 3)],
    "bboxMin": [round(mn.x, 3), round(mn.y, 3), round(mn.z, 3)],
    "recentredBy": [round(offset.x, 3), round(offset.y, 3), round(offset.z, 3)],
    "objects": len(meshes),
    "materials": sorted(mats),
    "triangles": tris,
    "review": review,
}
with open(os.path.join(OUT, "stats.json"), "w", encoding="utf-8") as f:
    json.dump(stats, f)
print("[model3d] done", json.dumps({"dims": stats["dims"], "triangles": tris}))
`;
