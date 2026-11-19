/**
 * Blender-side 3D modeler, embedded as a string like the scene builder.
 * Runs a modeling script written by the agent, normalises and exports the
 * result as .glb, and renders the review the agent checks it with:
 * a turnaround sheet; per reference photo, the model seen from that
 * photo's camera next to the photo, blended over it and where they differ
 * (with a match score); a set seen from inside; and a close-up
 * [photo | model] of each checklist item.
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
ap.add_argument("--checklist", default=None)
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
    turned like the real thing. The image travels inside the model.
    Only for a surface the photo sees well (facing it): a crop of a floor,
    road or roof seen almost edge-on un-warps into streaks and blocks from
    every other point of view (the build lists them as stretchedTextures).
    For those, cut a clean patch and REPEAT it at its real size."""
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


def _photo_px(photo):
    import numpy as np
    if photo not in _PHOTOS:
        src = bpy.data.images.load(photo, check_existing=True)
        w_, h_ = src.size
        _PHOTOS[photo] = np.array(src.pixels[:], dtype=np.float32).reshape(h_, w_, 4)[::-1]
    return _PHOTOS[photo]


def photo_color(photo, points, radius=0.012):
    """The colour of ONE surface as the photo shows it, as "#hex" for pbr():
    the median of small patches around each point (x, y in 0..1, y DOWN)
    picked ON that surface (several points spread over it, avoiding edges,
    highlights and objects in front). Measure every surface, never guess:
    two neighbouring surfaces (a brick arch and the floor) get their own."""
    import numpy as np
    px = _photo_px(photo)
    H_, W_ = px.shape[:2]
    if points and isinstance(points[0], (int, float)):
        points = [points]
    r = max(1, int(radius * max(W_, H_)))
    samples = []
    for x, y in points:
        cx, cy = int(float(x) * (W_ - 1)), int(float(y) * (H_ - 1))
        patch = px[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1, :3]
        samples.append(patch.reshape(-1, 3))
    med = np.median(np.concatenate(samples), axis=0)
    return "#%02x%02x%02x" % tuple(int(max(0, min(1, v)) * 255 + 0.5) for v in med)


_PROJ_MATS = {}


def _subdivide_world(ob, max_len):
    """Split ob's faces until no edge is longer than max_len metres (world),
    so the photo projection follows the perspective (UVs are interpolated
    linearly inside a face) and occlusion is judged per small piece."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    mw = ob.matrix_world
    for _ in range(8):
        long_ = [e for e in bm.edges if ((mw @ e.verts[0].co) - (mw @ e.verts[1].co)).length > max_len]
        if not long_ or len(bm.faces) > 60000:
            break
        bmesh.ops.subdivide_edges(bm, edges=long_, cuts=1, use_grid_fill=True)
    bm.to_mesh(me)
    bm.free()


def _unwarp(px, corners, ow, oh):
    """The photo quad 'corners' (x, y in 0..1, y DOWN; order: the output's
    top-left, top-right, bottom-right, bottom-left) un-warped to an ow x oh
    straight image, rows bottom-up (Blender order)."""
    import numpy as np
    H_, W_ = px.shape[:2]
    pts = [(float(x) * (W_ - 1), float(y) * (H_ - 1)) for x, y in corners]
    A, bv = [], []
    for (u, v), (x, y) in zip([(0, 0), (1, 0), (1, 1), (0, 1)], pts):
        A.append([u, v, 1, 0, 0, 0, -u * x, -v * x]); bv.append(x)
        A.append([0, 0, 0, u, v, 1, -u * y, -v * y]); bv.append(y)
    h = np.linalg.solve(np.array(A, dtype=np.float64), np.array(bv, dtype=np.float64))
    Hm = np.array([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]])
    uu, vv = np.meshgrid((np.arange(ow) + 0.5) / ow, (np.arange(oh) + 0.5) / oh)
    q = Hm @ np.stack([uu.ravel(), vv.ravel(), np.ones(uu.size)])
    xs = np.clip(q[0] / q[2], 0, W_ - 1).astype(np.int32)
    ys = np.clip(q[1] / q[2], 0, H_ - 1).astype(np.int32)
    out = px[ys, xs].reshape(oh, ow, 4)[::-1].copy()
    out[..., 3] = 1.0
    return out


def _box_axes(n):
    """Two world axes a face is mapped on, by its dominant normal axis."""
    ax = (abs(n.x), abs(n.y), abs(n.z))
    if ax[2] >= ax[0] and ax[2] >= ax[1]:
        return Vector((1, 0, 0)), Vector((0, 1, 0))
    if ax[0] >= ax[1]:
        return Vector((0, 1, 0)), Vector((0, 0, 1))
    return Vector((1, 0, 0)), Vector((0, 0, 1))


def photo_project(objs, ref=0, fallback=None, max_px=2048, piece=0.25, max_angle=60, min_px=60, shiny=False):
    """Paint objects with the reference photo itself, projected from the
    camera it was taken from (REF_CAMS[ref]). A face takes the photo's own
    pixels only where the photo shows it WELL: facing the camera (within
    max_angle, at most 60), wholly visible (nothing in front of any corner)
    and inside the frame. Seen from elsewhere those pixels would stretch
    (a table top or a stair tread the photo saw edge-on smears when seen
    from above) or carry what stood in front (a table leg on the floor).
    Every other face of the object gets the object's OWN texture: a piece of
    it the photo shows well, cut out straight and repeated at its real size
    (the floor's tiles, the wall's plaster, the table's planks), so the set
    holds up from every side. Only an object the photo never shows well
    keeps 'fallback' (a pbr() material, e.g. with photo_color). Call it at
    the END of the script, once every object exists, on every surface the
    photo shows: walls, arch, floor, ceiling and beams, stairs, doors,
    furniture. Get that reference's camera right first.
    Only BIG flat surfaces take the photo's pixels: a flat region of the
    object narrower than min_px photo pixels (a stair's tread or riser, a
    beam's side, a table leg, a baluster) holds a sliver of the photo with
    its neighbours' edges and shadows in it, which falls apart up close. Such
    a region gets the object's own repeated texture instead (its material,
    not its picture), like the faces the photo does not see.
    shiny=True for a surface with a highlight in the photo (a polished table
    top, a wet road, glazed tiles): the photo's pixels carry that highlight
    painted in, and it would stay put as the camera moves (a stain, not a
    shine). Then every face takes the repeated patch, and the shine comes
    from the material (lower roughness) as a real highlight that moves.
    Cut the patch where the photo shows no highlight."""
    from bpy_extras.object_utils import world_to_camera_view
    import numpy as np
    if not REF_CAMS:
        return
    max_angle = min(float(max_angle), 60.0)
    rc = REF_CAMS[ref]
    cam = rc["obj"]
    if ref not in _PROJ_MATS:
        src = rc["image"]
        w_, h_ = src.size
        img = src
        if max(w_, h_) > max_px:
            img = src.copy()
            k = max_px / max(w_, h_)
            img.scale(max(8, int(w_ * k)), max(8, int(h_ * k)))
        img.pack()
        m = bpy.data.materials.new(f"photo_proj_{ref}")
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.extension = "EXTEND"
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "proj"
        nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.85
        px = np.array(src.pixels[:], dtype=np.float32).reshape(-1, 4)[:, :3].mean(axis=0)
        m.diffuse_color = (float(px[0]), float(px[1]), float(px[2]), 1.0)
        _PROJ_MATS[ref] = m
    pm = _PROJ_MATS[ref]
    photo = _photo_px(rc["path"])
    # world_to_camera_view frames by the render size: use the photo's own.
    r_ = scn.render
    old_res = (r_.resolution_x, r_.resolution_y, r_.pixel_aspect_x, r_.pixel_aspect_y)
    r_.resolution_x, r_.resolution_y = int(rc["w"]), int(rc["h"])
    r_.pixel_aspect_x = r_.pixel_aspect_y = 1.0
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    cpos = cam.matrix_world.translation
    cos_max = math.cos(math.radians(max_angle))

    def in_frame(q, m_=0.002):
        return q.z > 0 and -m_ <= q.x <= 1 + m_ and -m_ <= q.y <= 1 + m_

    def sees(ob, p, tol=0.03):
        """The photo camera sees point p of ob (nothing in front)."""
        d = p - cpos
        dist = d.length
        if dist < 1e-4:
            return False
        hit, loc, _n, _i, hob, _m = scn.ray_cast(dg, cpos, d.normalized(), distance=dist + 0.05)
        if not hit:
            return True
        if hob is not None and hob.original == ob:
            return (loc - cpos).length >= dist - tol
        return (loc - cpos).length >= dist - tol

    def patch_material(ob, polys, mw, nmat):
        """A straight piece of ob's own surface out of the photo, as a
        repeating material, and its size in metres; None if the photo shows
        no piece of it well."""
        cands = []
        for poly in polys:
            c = mw @ poly.center
            n = (nmat @ poly.normal).normalized()
            to_cam = (cpos - c)
            facing = n.dot(to_cam.normalized())
            if facing < 0.12:
                continue
            q = world_to_camera_view(scn, cam, c)
            if not in_frame(q, -0.02):
                continue
            cands.append((facing / max(to_cam.length, 0.2), c, n))
        cands.sort(key=lambda t: -t[0])
        for L in (0.9, 0.6, 0.4, 0.25):
            for _score, c, n in cands[:60]:
                a1, a2 = _box_axes(n)
                t1 = (a1 - n * a1.dot(n))
                if t1.length < 1e-3:
                    continue
                t1.normalize()
                t2 = n.cross(t1).normalized()
                c_ = c + n * 0.002
                quad = [c_ - t1 * L / 2 + t2 * L / 2, c_ + t1 * L / 2 + t2 * L / 2,
                        c_ + t1 * L / 2 - t2 * L / 2, c_ - t1 * L / 2 - t2 * L / 2]
                probe = quad + [c_ + t1 * L / 2, c_ - t1 * L / 2, c_ + t2 * L / 2, c_ - t2 * L / 2]
                ok_ = True
                for pt in probe:
                    # on the surface: a short ray back along the normal meets ob
                    hit, loc, hn, _i, hob, _m = scn.ray_cast(dg, pt + n * 0.05, -n, distance=0.12)
                    # on THE SAME flat surface: a patch over a step's edge
                    # would repeat that edge all over the object
                    if (not hit or hob is None or hob.original != ob
                            or abs((loc - c_).dot(n)) > 0.006 or hn.dot(n) < 0.995):
                        ok_ = False
                        break
                    q = world_to_camera_view(scn, cam, pt)
                    if not in_frame(q, -0.005) or not sees(ob, pt, 0.05):
                        ok_ = False
                        break
                if not ok_:
                    continue
                corners = []
                for pt in quad:
                    q = world_to_camera_view(scn, cam, pt)
                    corners.append((q.x, 1.0 - q.y))
                size = 384
                out = _unwarp(photo, corners, size, size)
                img = bpy.data.images.new(f"{ob.name}_patch", size, size, alpha=False)
                img.pixels.foreach_set(out.ravel())
                img.pack()
                m = bpy.data.materials.new(f"{ob.name}_patch")
                m.use_nodes = True
                nt = m.node_tree
                b = nt.nodes.get("Principled BSDF")
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                tex.extension = "MIRROR"
                uvn = nt.nodes.new("ShaderNodeUVMap")
                uvn.uv_map = "proj"
                nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
                nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
                b.inputs["Roughness"].default_value = 0.85
                mean = out[..., :3].reshape(-1, 3).mean(axis=0)
                m.diffuse_color = (float(mean[0]), float(mean[1]), float(mean[2]), 1.0)
                return m, L
        return None

    for ob in (objs if isinstance(objs, (list, tuple)) else [objs]):
        if ob is None or ob.type != "MESH":
            continue
        _subdivide_world(ob, piece)
        me = ob.data
        for uv in list(me.uv_layers):
            me.uv_layers.remove(uv)
        uvl = me.uv_layers.new(name="proj")
        mats = [mm for mm in me.materials if mm is not None]
        fb = fallback or (mats[0] if mats else pbr(f"{ob.name}_fb", "#808080"))
        mw = ob.matrix_world
        nmat = mw.to_3x3().inverted().transposed()
        patch = patch_material(ob, me.polygons, mw, nmat)
        # Surfaces (connected faces with no sharp edge between them) too
        # narrow in the photo never take its pixels.
        PW, PH = float(rc["w"]), float(rc["h"])
        nrm = [(nmat @ p_.normal).normalized() for p_ in me.polygons]
        by_edge = {}
        for p_ in me.polygons:
            for ek in p_.edge_keys:
                by_edge.setdefault(ek, []).append(p_.index)
        region = [-1] * len(me.polygons)
        narrow = set()
        for p0 in me.polygons:
            if region[p0.index] >= 0:
                continue
            rid = p0.index
            stack, members = [p0.index], []
            region[p0.index] = rid
            while stack:
                k = stack.pop()
                members.append(k)
                for ek in me.polygons[k].edge_keys:
                    for j in by_edge.get(ek, ()):
                        # one SURFACE: across a gentle bend (a barrel's staves,
                        # a turned leg) yes, across a step's edge (90 deg) no
                        if region[j] < 0 and nrm[j].dot(nrm[k]) > 0.9:
                            region[j] = rid
                            stack.append(j)
            pts2, area2 = [], 0.0
            for k in members:
                qq = [world_to_camera_view(scn, cam, mw @ me.vertices[v].co) for v in me.polygons[k].vertices]
                if any(q_.z <= 0 for q_ in qq):
                    continue
                xy = [(q_.x * PW, q_.y * PH) for q_ in qq]
                pts2 += xy
                area2 += abs(sum(xy[i][0] * xy[i - 1][1] - xy[i - 1][0] * xy[i][1] for i in range(len(xy)))) / 2
            if len(pts2) < 3:
                continue
            # Width = area / length, the length being the longest span in the photo.
            span2 = 0.0
            hull = pts2 if len(pts2) < 400 else pts2[::max(1, len(pts2) // 400)]
            for i_ in range(len(hull)):
                for j_ in range(i_ + 1, len(hull)):
                    d_ = (hull[i_][0] - hull[j_][0]) ** 2 + (hull[i_][1] - hull[j_][1]) ** 2
                    if d_ > span2:
                        span2 = d_
            if span2 <= 0 or area2 / math.sqrt(span2) < float(min_px):
                narrow.update(members)
        me.materials.clear()
        me.materials.append(pm)
        me.materials.append(patch[0] if patch else fb)
        L = patch[1] if patch else 1.0
        for poly in me.polygons:
            c = mw @ poly.center
            n = (nmat @ poly.normal).normalized()
            uvs = None
            if not shiny and poly.index not in narrow and n.dot((cpos - c).normalized()) > cos_max:
                pts = [c] + [mw @ me.vertices[me.loops[li].vertex_index].co for li in poly.loop_indices]
                qs = [world_to_camera_view(scn, cam, p_) for p_ in pts]
                if all(in_frame(q_) for q_ in qs) and all(sees(ob, p_) for p_ in pts):
                    uvs = [(q_.x, q_.y) for q_ in qs[1:]]
            if uvs:
                for li, uv in zip(poly.loop_indices, uvs):
                    uvl.data[li].uv = uv
                poly.material_index = 0
            else:
                # the object's own texture, at its real size
                a1, a2 = _box_axes(n)
                for li in poly.loop_indices:
                    w = mw @ me.vertices[me.loops[li].vertex_index].co
                    uvl.data[li].uv = (w.dot(a1) / L, w.dot(a2) / L)
                poly.material_index = 1
    r_.resolution_x, r_.resolution_y, r_.pixel_aspect_x, r_.pixel_aspect_y = old_res
    return pm


def assign(obj, mat):
    """Give a mesh object exactly one material."""
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def photo_sky(ref=0, clear=0.35, radius=None):
    """The photo's SKY round the whole set, as its background: a big dome
    centred on the photo camera that shows the photo's own sky (clouds,
    light, colour) in every direction, lit by itself. From the photo camera
    it matches the photo; turning round, the same sky continues (mirrored)
    instead of black. clear = the photo's lowest line (0..1, y DOWN) that is
    clean sky across the whole width (above roofs, trees, hills); below it
    the dome repeats that line down to the horizon. Only for a photo that
    shows sky (an exterior); never inside a room. Call it once."""
    import numpy as np
    if not REF_CAMS:
        return None
    rc = REF_CAMS[ref]
    cam = rc["obj"]
    w_, h_ = rc["w"], rc["h"]
    cd = cam.data
    if w_ >= h_:
        fov_h = 2 * math.atan(18.0 / cd.lens)
        fov_v = 2 * math.atan(math.tan(fov_h / 2) * h_ / w_)
    else:
        fov_v = 2 * math.atan(18.0 / cd.lens)
        fov_h = 2 * math.atan(math.tan(fov_v / 2) * w_ / h_)
    fwd = (cam.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()
    yaw0 = math.atan2(fwd.y, fwd.x)
    pitch0 = math.asin(max(-1.0, min(1.0, fwd.z)))
    # 360 degrees = an even number of photo widths: the mirrored sky closes
    # round with no seam.
    n_ = max(2, int(round(2 * math.pi / fov_h / 2)) * 2)
    unit = 2 * math.pi / n_
    v_clear = 1.0 - max(0.0, min(0.95, float(clear)))
    R = float(radius or 300.0)
    # The sky part of the photo, small: it is only a background.
    src = rc["image"]
    img = src.copy()
    k_ = min(1.0, 2048 / max(w_, h_))
    if k_ < 1.0:
        img.scale(max(8, int(w_ * k_)), max(8, int(h_ * k_)))
    img.name = "sky_photo"
    img.pack()
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=R)
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])  # seen from inside
    uvl = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        az0 = None
        for l in f.loops:
            d = l.vert.co.normalized()
            a = math.atan2(d.y, d.x) - yaw0
            a = (a + math.pi) % (2 * math.pi) - math.pi
            if az0 is None:
                az0 = a
            else:  # one face never straddles the wrap
                while a - az0 > math.pi:
                    a -= 2 * math.pi
                while a - az0 < -math.pi:
                    a += 2 * math.pi
            e = math.asin(max(-1.0, min(1.0, d.z)))
            # left of the view = left of the photo (azimuth grows to the left)
            u = 0.5 - a / unit
            v = 0.5 + (e - pitch0) / fov_v
            l[uvl].uv = (u, max(v, v_clear))
    me = bpy.data.meshes.new("sky_dome")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("sky_dome", me)
    scn.collection.objects.link(ob)
    ob.location = cam.matrix_world.translation.copy()
    ob["sky"] = True
    m = bpy.data.materials.new("sky_dome")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "MIRROR"
    b.inputs["Base Color"].default_value = (0, 0, 0, 1)
    b.inputs["Roughness"].default_value = 1.0
    for k in ("Specular IOR Level", "Specular"):
        if k in b.inputs:
            b.inputs[k].default_value = 0.0
    em = b.inputs.get("Emission Color") or b.inputs.get("Emission")
    nt.links.new(tex.outputs["Color"], em)
    if "Emission Strength" in b.inputs:
        b.inputs["Emission Strength"].default_value = 1.0
    px = np.array(src.pixels[:], dtype=np.float32).reshape(-1, 4)[:, :3].mean(axis=0)
    m.diffuse_color = (float(px[0]), float(px[1]), float(px[2]), 1.0)
    me.materials.append(m)
    try:
        ob.visible_shadow = False
    except Exception:
        pass
    return ob


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
    "photo_material": photo_material, "photo_color": photo_color, "photo_project": photo_project,
    "photo_sky": photo_sky,
}
import bmesh  # noqa: E402
_ns["bmesh"] = bmesh
exec(compile(_src, args.script, "exec"), _ns)
bpy.context.view_layer.update()

model = [o for o in bpy.data.objects if o not in _wrapper_objs and o.type in ("MESH", "CURVE", "EMPTY", "FONT", "SURFACE", "META")]
meshes_all = [o for o in model if o.type != "EMPTY"]
# The sky dome is background: never part of the model's size, framing or checks.
meshes = [o for o in meshes_all if not o.get("sky")]
del meshes_all
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

def _z_fighting(objs, tol=0.003, min_area=0.0004, cap=12):
    """Faces of DIFFERENT objects lying on the same plane, facing the same
    way and overlapping: the renderer cannot tell which is in front, so they
    flicker in stripes as the camera moves. Returns the worst overlaps."""
    dg_ = bpy.context.evaluated_depsgraph_get()
    buckets = {}
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg_)
        me = ev.to_mesh()
        try:
            mw = ev.matrix_world
            nm = mw.to_3x3().inverted_safe().transposed()
            for poly in me.polygons:
                if poly.area < 1e-6:
                    continue
                n = (nm @ poly.normal).normalized()
                pts = [mw @ me.vertices[v].co for v in poly.vertices]
                d = n.dot(pts[0])
                key = (round(n.x, 2) + 0.0, round(n.y, 2) + 0.0, round(n.z, 2) + 0.0, round(d / tol))
                ax = max(range(3), key=lambda i: abs(n[i]))
                u_, v_ = [i for i in range(3) if i != ax]
                p2 = [(p[u_], p[v_]) for p in pts]
                if (p2[1][0] - p2[0][0]) * (p2[2][1] - p2[0][1]) - (p2[1][1] - p2[0][1]) * (p2[2][0] - p2[0][0]) < 0:
                    p2.reverse()
                xs, ys = [q[0] for q in p2], [q[1] for q in p2]
                buckets.setdefault(key, []).append((o.name, p2, (min(xs), min(ys), max(xs), max(ys)), n, d, ax))
        finally:
            ev.to_mesh_clear()

    def clip(subj, clipper):
        out = subj
        for i in range(len(clipper)):
            a, b = clipper[i], clipper[(i + 1) % len(clipper)]
            inp, out = out, []
            if not inp:
                break
            side = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
            for j in range(len(inp)):
                cur, prv = inp[j], inp[j - 1]
                sc, sp = side(cur), side(prv)
                if sc >= 0:
                    if sp < 0:
                        t = sp / (sp - sc)
                        out.append((prv[0] + t * (cur[0] - prv[0]), prv[1] + t * (cur[1] - prv[1])))
                    out.append(cur)
                elif sp >= 0:
                    t = sp / (sp - sc)
                    out.append((prv[0] + t * (cur[0] - prv[0]), prv[1] + t * (cur[1] - prv[1])))
        return out

    def area(poly):
        return abs(sum(poly[i][0] * poly[i - 1][1] - poly[i - 1][0] * poly[i][1] for i in range(len(poly)))) / 2

    found = {}
    keys = list(buckets.keys())
    for key in keys:
        # The neighbouring plane bucket too: two faces 1 mm apart straddle a boundary.
        near = buckets[key] + buckets.get(key[:3] + (key[3] + 1,), [])
        names = {f[0] for f in near}
        if len(names) < 2:
            continue
        near.sort(key=lambda f: f[2][0])
        for i, fa in enumerate(near):
            for fb in near[i + 1:]:
                if fb[2][0] >= fa[2][2]:
                    break
                if fa[0] == fb[0] or fa[5] != fb[5] or abs(fa[4] - fb[4]) > tol:
                    continue
                if fb[2][1] >= fa[2][3] or fa[2][1] >= fb[2][3]:
                    continue
                a_ = area(clip(fa[1], fb[1]))
                if a_ < 1e-6:
                    continue
                pair = tuple(sorted((fa[0], fb[0])))
                cx = sum(q[0] for q in fa[1]) / len(fa[1])
                cy = sum(q[1] for q in fa[1]) / len(fa[1])
                rec = found.setdefault((pair, key), {"area": 0.0, "at": None, "normal": fa[3], "key": key})
                rec["area"] += a_
                if rec["at"] is None:
                    ax = fa[5]
                    u_, v_ = [k for k in range(3) if k != ax]
                    p3 = [0.0, 0.0, 0.0]
                    p3[u_], p3[v_] = cx, cy
                    n = fa[3]
                    p3[ax] = (fa[4] - n[u_] * cx - n[v_] * cy) / n[ax]
                    rec["at"] = p3
    def covered(key, at, names):
        """A third object's face on the same plane, facing the other way and
        under [at] (a frame's foot on the floor): never seen, never flickers."""
        nk = (-key[0] + 0.0, -key[1] + 0.0, -key[2] + 0.0)
        for dk in (-1, 0, 1):
            for f in buckets.get(nk + (-key[3] + dk,), []):
                if f[0] in names:
                    continue
                u_, v_ = [k for k in range(3) if k != f[5]]
                q = (at[u_], at[v_])
                pg = f[1]
                if all((pg[i][0] - pg[i - 1][0]) * (q[1] - pg[i - 1][1]) - (pg[i][1] - pg[i - 1][1]) * (q[0] - pg[i - 1][0]) >= -1e-9
                       for i in range(len(pg))):
                    return True
        return False
    out = [{"a": k[0][0], "b": k[0][1], "areaM2": round(v["area"], 4), "at": [round(c, 3) for c in v["at"]],
            "facing": [round(c, 2) for c in v["normal"]]}
           for k, v in found.items() if v["area"] >= min_area and not covered(v["key"], v["at"], k[0])]
    out.sort(key=lambda r: -r["areaM2"])
    return out[:cap]


def _stretched_textures(objs, ratio=3.0, min_area=0.05, cap=12):
    """Faces whose image texture is stretched: one way it gets many times
    more image pixels per metre than the other (a photo laid on a floor or a
    roof the photo saw almost edge-on). From the photo's own point it looks
    right; from anywhere else it is streaks and blocks. Per object and
    material: the stretched area and the worst stretch."""
    import numpy as np
    dg_ = bpy.context.evaluated_depsgraph_get()

    def tex_of(mat):
        """(image, uv map name or None) feeding the material's colour."""
        if not mat or not mat.use_nodes or not mat.node_tree:
            return None
        for n_ in mat.node_tree.nodes:
            if n_.type == "TEX_IMAGE" and n_.image is not None and n_.image.size[0] > 1:
                uvn = None
                for l_ in n_.inputs["Vector"].links:
                    if l_.from_node.type == "UVMAP":
                        uvn = l_.from_node.uv_map or None
                return n_.image, uvn
        return None

    found = {}
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg_)
        me = ev.to_mesh()
        try:
            if not me.uv_layers:
                continue
            me.calc_loop_triangles()
            mw = ev.matrix_world
            slots = [tex_of(sl.material) for sl in ev.material_slots] or [None]
            for tri in me.loop_triangles:
                t_ = slots[tri.material_index] if tri.material_index < len(slots) else None
                if not t_:
                    continue
                img, uvname = t_
                uvl = me.uv_layers.get(uvname) if uvname else me.uv_layers.active
                if uvl is None:
                    continue
                p = [mw @ me.vertices[v].co for v in tri.vertices]
                e1, e2 = p[1] - p[0], p[2] - p[0]
                n = e1.cross(e2)
                area = n.length / 2
                if area < 1e-5:
                    continue
                ax = e1.normalized()
                ay = n.normalized().cross(ax)
                A = np.array([[e1.dot(ax), e2.dot(ax)], [e1.dot(ay), e2.dot(ay)]])
                w_, h_ = img.size
                u = [uvl.data[li].uv for li in tri.loops]
                B = np.array([[(u[1].x - u[0].x) * w_, (u[2].x - u[0].x) * w_],
                              [(u[1].y - u[0].y) * h_, (u[2].y - u[0].y) * h_]])
                try:
                    J = B @ np.linalg.inv(A)  # image pixels per metre, in the face's plane
                except np.linalg.LinAlgError:
                    continue
                sv = np.linalg.svd(J, compute_uv=False)
                if sv[1] < 1e-9:
                    r_ = 1e9
                else:
                    r_ = float(sv[0] / sv[1])
                if r_ < ratio:
                    continue
                key = (o.name, (ev.material_slots[tri.material_index].material.name
                                if tri.material_index < len(ev.material_slots) and ev.material_slots[tri.material_index].material else ""))
                rec = found.setdefault(key, {"area": 0.0, "worst": 0.0})
                rec["area"] += area
                rec["worst"] = max(rec["worst"], min(r_, 99.0))
        finally:
            ev.to_mesh_clear()
    out = [{"object": k[0], "material": k[1], "areaM2": round(v["area"], 2), "stretch": round(v["worst"], 1)}
           for k, v in found.items() if v["area"] >= min_area]
    out.sort(key=lambda r: -r["areaM2"])
    return out[:cap]


try:
    STRETCHED = _stretched_textures(meshes)
except Exception as e_:
    print(f"[model3d] stretched-texture check failed: {e_}", file=sys.stderr)
    STRETCHED = []

try:
    Z_FIGHT = _z_fighting(meshes)
except Exception as e_:
    print(f"[model3d] z-fighting check failed: {e_}", file=sys.stderr)
    Z_FIGHT = []

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
        if o.type == "MESH" and o not in _wrapper_objs and not o.get("sky"):
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
# The overview cameras stand outside the sky dome: hide it there.
_sky = [o for o in bpy.data.objects if o.type == "MESH" and o.get("sky")]
for o in _sky:
    o.hide_render = True
for name, pos in views:
    cam = look_cam(f"review_{name}", Vector(pos), center, LENS)
    p = render_to(cam, CW, CH, os.path.join(OUT, "review", f"view-{name}.png"))
    cells.append(pixels(p))
for o in _sky:
    o.hide_render = False
W_, H_, px_ = tile(cells, 2, CW, CH)
review["turnaround"] = os.path.join(OUT, "review", "turnaround.png")
save_canvas(review["turnaround"], W_, H_, px_)

import numpy as np  # noqa: E402


def load_np(path, w, h):
    """An image as float rows bottom-up (Blender order), w x h, RGBA."""
    img = bpy.data.images.load(path, check_existing=False)
    if img.size[0] != w or img.size[1] != h:
        img.scale(int(w), int(h))
    W, H = img.size
    a = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(H, W, 4)


def save_np(path, a):
    H, W = a.shape[:2]
    a = a.copy()
    a[..., 3] = 1.0
    save_canvas(path, W, H, a.ravel())


def resize_np(a, w, h):
    """Bilinear resize of an H x W x 4 array."""
    H, W = a.shape[:2]
    ys = np.clip((np.arange(h) + 0.5) * H / h - 0.5, 0, H - 1)
    xs = np.clip((np.arange(w) + 0.5) * W / w - 0.5, 0, W - 1)
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, H - 1); x1 = np.minimum(x0 + 1, W - 1)
    fy = (ys - y0)[:, None, None]; fx = (xs - x0)[None, :, None]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def hstack_np(parts, gap=6):
    H = max(p.shape[0] for p in parts)
    out = []
    for k, p in enumerate(parts):
        if p.shape[0] != H:
            p = np.concatenate([np.full((H - p.shape[0], p.shape[1], 4), 0.08, np.float32), p], axis=0)
        out.append(p)
        if k < len(parts) - 1:
            out.append(np.full((H, gap, 4), 0.08, np.float32))
    return np.concatenate(out, axis=1)


def blur_np(a, r):
    """Box blur of an H x W x C array (summed-area table)."""
    if r < 1:
        return a
    H, W = a.shape[:2]
    c = np.pad(a, ((1, 0), (1, 0), (0, 0))).cumsum(0).cumsum(1)
    ys0 = np.clip(np.arange(H) - r, 0, H); ys1 = np.clip(np.arange(H) + r + 1, 0, H)
    xs0 = np.clip(np.arange(W) - r, 0, W); xs1 = np.clip(np.arange(W) + r + 1, 0, W)
    s_ = c[ys1][:, xs1] - c[ys0][:, xs1] - c[ys1][:, xs0] + c[ys0][:, xs0]
    n = ((ys1 - ys0)[:, None] * (xs1 - xs0)[None, :])[..., None]
    return s_ / n


# Per photo: [photo | model from the photo camera | blend | where they differ]
# plus a match score: the photo must look the same in 3D, that is the goal.
GRID_C, GRID_R = 4, 3
ref_hi = {}
for i, rc in enumerate(REF_CAMS):
    w, h = rc["w"], rc["h"]
    k = max(S, 960) / max(w, h)
    cw, ch = max(2, int(w * k)), max(2, int(h * k))
    p = render_to(rc["obj"], cw, ch, os.path.join(OUT, "review", f"ref-{i}-render.png"))
    rnd = load_np(p, cw, ch)
    pho = load_np(rc["path"], cw, ch)
    ref_hi[i] = (rnd, pho)
    over = pho * 0.5 + rnd * 0.5
    rad = max(1, int(max(cw, ch) / 160))
    d = np.abs(blur_np(pho[..., :3], rad) - blur_np(rnd[..., :3], rad)).mean(axis=2)
    grey = pho[..., :3].mean(axis=2, keepdims=True) * 0.45
    heat = np.clip(d / 0.25, 0, 1)[..., None]
    diff = np.concatenate([grey * (1 - heat) + np.array([1.0, 0.1, 0.05]) * heat, np.ones((ch, cw, 1), np.float32)], axis=2)
    out = os.path.join(OUT, "review", f"ref-{i}.png")
    save_np(out, hstack_np([pho, rnd, over, diff.astype(np.float32)]))
    match = float(max(0.0, 1.0 - d.mean() / 0.25))
    cells = []
    for gy in range(GRID_R):
        for gx in range(GRID_C):
            # rows are bottom-up: grid row 0 = the TOP of the photo
            ya, yb = int(ch * (1 - (gy + 1) / GRID_R)), int(ch * (1 - gy / GRID_R))
            xa, xb = int(cw * gx / GRID_C), int(cw * (gx + 1) / GRID_C)
            v = float(max(0.0, 1.0 - d[ya:yb, xa:xb].mean() / 0.25))
            cells.append({"box": [round(gx / GRID_C, 3), round(gy / GRID_R, 3), round((gx + 1) / GRID_C, 3), round((gy + 1) / GRID_R, 3)], "match": round(v, 3)})
    cells.sort(key=lambda c_: c_["match"])
    review["references"].append({"index": i, "image": rc["path"], "compare": out,
                                 "match": round(match, 3), "worstAreas": cells[:4]})

# A set seen from INSIDE, from where the first photo was taken: wider than
# the photo, then turned left, right, back, down and up. Everything the
# photo's frame does not show (the floor at the feet, the ceiling, the
# sides) is checked here: the user walks round it in the card.
if KIND == "set" and REF_CAMS:
    c0 = REF_CAMS[0]["obj"]
    P = c0.matrix_world.translation.copy()
    fwd = (c0.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()
    yaw0 = math.atan2(fwd.y, fwd.x)
    pitch0 = math.asin(max(-1.0, min(1.0, fwd.z)))

    def dir_(yaw, pitch):
        return Vector((math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), math.sin(pitch)))

    inside = [
        ("wide", dir_(yaw0, pitch0)),
        ("left", dir_(yaw0 + math.radians(75), 0)),
        ("right", dir_(yaw0 - math.radians(75), 0)),
        ("back", dir_(yaw0 + math.pi, 0)),
        ("down", dir_(yaw0, math.radians(-55))),
        ("up", dir_(yaw0, math.radians(55))),
    ]
    cells_ = []
    for name, dv in inside:
        cam = look_cam(f"inside_{name}", P, P + dv, 14)
        cells_.append(pixels(render_to(cam, CW, CH, os.path.join(OUT, "review", f"inside-{name}.png"))))
    W3, H3, px3 = tile(cells_, 3, CW, CH)
    review["inside"] = os.path.join(OUT, "review", "inside.png")
    save_canvas(review["inside"], W3, H3, px3)

# Turning round what each photo looks at. From the photo's own point the
# projected photo hides depth errors (a wall too near, a flat chair, a
# floor at the wrong height all still "look right"); a few degrees away
# they show. [the photo | left 35 | left 15 / right 15 | right 35 | higher /
# from above | above left | above right].
review["orbit"] = []
for i, rc in enumerate(REF_CAMS[:3]):
    cam0 = rc["obj"]
    P = cam0.matrix_world.translation.copy()
    fwd = (cam0.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()
    c_ = (REFS[i].get("camera") or {}) if i < len(REFS) else {}
    try:
        d0 = (Vector(c_.get("target")) - Vector(c_.get("position"))).length
    except Exception:
        d0 = 0
    if d0 < 0.3:
        d0 = max(1.0, span * 0.4)
    T = P + fwd * d0
    lens = cam0.data.lens
    cells_ = [pixels(rc["path"], CW, CH)]
    # Far round and from above too: a texture laid for the photo's point of
    # view (a floor, a roof, a road seen almost edge-on) smears into streaks
    # from anywhere else, above all from above.
    for name, yaw, pitch in (("l35", 35, 0), ("l15", 15, 0), ("r15", -15, 0), ("r35", -35, 0), ("up", 0, 25),
                             ("high", 0, 60), ("high_l", 60, 45), ("high_r", -60, 45)):
        v = P - T
        v = Matrix.Rotation(math.radians(yaw), 3, "Z") @ v
        if pitch:
            side = v.cross(Vector((0, 0, 1)))
            if side.length > 1e-6:
                v = Matrix.Rotation(math.radians(pitch), 3, side.normalized()) @ v
        # Never through a wall or the ceiling: stop just before what is in the way.
        dg_ = bpy.context.evaluated_depsgraph_get()
        hit, loc, _n, _i, _o, _m = scn.ray_cast(dg_, T, v.normalized(), distance=v.length)
        if hit:
            v = v.normalized() * max(0.3, (loc - T).length - 0.25)
        cam = look_cam(f"orbit_{i}_{name}", T + v, T, lens)
        cells_.append(pixels(render_to(cam, CW, CH, os.path.join(OUT, "review", f"orbit-{i}-{name}.png"))))
    W4, H4, px4 = tile(cells_, 3, CW, CH)
    out = os.path.join(OUT, "review", f"orbit-{i}.png")
    save_canvas(out, W4, H4, px4)
    review["orbit"].append(out)

# The checklist: each thing the photo shows, close up, [photo | model] from
# the photo camera, so each one is judged on its own (shape, carving,
# texture, colour), not lost in the whole frame.
CHECK = []
if args.checklist and os.path.exists(args.checklist):
    with open(args.checklist, "r", encoding="utf-8") as f:
        CHECK = json.load(f) or []
review["checklist"] = []
for n_, it in enumerate(CHECK):
    ri = int(it.get("ref") or 0)
    bx = it.get("box") or []
    if ri not in ref_hi or len(bx) != 4:
        continue
    rnd, pho = ref_hi[ri]
    H, W = rnd.shape[:2]
    x0, y0, x1, y1 = [max(0.0, min(1.0, float(v))) for v in bx]
    if x1 - x0 < 0.01 or y1 - y0 < 0.01:
        continue
    # 10 % margin round the box; y is DOWN in the box, rows are bottom-up.
    mx_, my_ = (x1 - x0) * 0.1, (y1 - y0) * 0.1
    x0, x1 = max(0.0, x0 - mx_), min(1.0, x1 + mx_)
    y0, y1 = max(0.0, y0 - my_), min(1.0, y1 + my_)
    ra, rb = int(H * (1 - y1)), max(int(H * (1 - y0)), int(H * (1 - y1)) + 2)
    ca, cb = int(W * x0), max(int(W * x1), int(W * x0) + 2)
    cp, cr = pho[ra:rb, ca:cb], rnd[ra:rb, ca:cb]
    th = 420
    tw = max(8, int(th * cp.shape[1] / max(cp.shape[0], 1)))
    if tw > 700:
        tw, th = 700, max(8, int(700 * cp.shape[0] / max(cp.shape[1], 1)))
    parts_ = [resize_np(cp, tw, th), resize_np(cr, tw, th)]
    # The same item turned round: 25 degrees left and right of the photo's
    # view, about the item itself (where the box's centre ray meets it). A
    # stair whose treads sit under its stringer, a flat chair, a table too
    # thin: right from the photo's point, wrong from a step aside.
    cam0 = REF_CAMS[ri]["obj"]
    cd0 = cam0.data
    rw_, rh_ = REF_CAMS[ri]["w"], REF_CAMS[ri]["h"]
    if rw_ >= rh_:
        tanH = 18.0 / cd0.lens; tanV = tanH * rh_ / rw_
    else:
        tanV = 18.0 / cd0.lens; tanH = tanV * rw_ / rh_
    ox0, oy0, ox1, oy1 = [max(0.0, min(1.0, float(v))) for v in bx]
    u_, v_ = (ox0 + ox1) / 2, (oy0 + oy1) / 2
    rot_ = cam0.matrix_world.to_3x3()
    P0 = cam0.matrix_world.translation.copy()
    ray_ = (rot_ @ Vector(((u_ - 0.5) * 2 * tanH, (0.5 - v_) * 2 * tanV, -1.0))).normalized()
    dg_ = bpy.context.evaluated_depsgraph_get()
    hit, Hc, _n, _i, _o, _m = scn.ray_cast(dg_, P0, ray_, distance=500)
    if hit:
        half = max((ox1 - ox0) * tanH, (oy1 - oy0) * tanV * tw / max(th, 1)) * 0.75
        lens_ = max(10.0, min(300.0, 18.0 / max(half, 1e-3)))
        for yaw in (25, -25):
            v = Matrix.Rotation(math.radians(yaw), 3, "Z") @ (P0 - Hc)
            h2, l2, _n, _i, _o, _m = scn.ray_cast(dg_, Hc + v.normalized() * 0.05, v.normalized(), distance=v.length)
            if h2:
                v = v.normalized() * max(0.3, (l2 - Hc).length - 0.15)
            cam = look_cam(f"check_{n_}_{yaw}", Hc + v, Hc, lens_)
            pth = render_to(cam, tw, th, os.path.join(OUT, "review", f"check-{n_}-{'l' if yaw > 0 else 'r'}.png"))
            parts_.append(load_np(pth, tw, th))
    out = os.path.join(OUT, "review", f"check-{n_}.png")
    save_np(out, hstack_np(parts_))
    review["checklist"].append({"item": it.get("item"), "ref": ri, "box": bx, "compare": out})

stats = {
    "kind": KIND,
    "dims": [round(dims.x, 3), round(dims.y, 3), round(dims.z, 3)],
    "bboxMin": [round(mn.x, 3), round(mn.y, 3), round(mn.z, 3)],
    "recentredBy": [round(offset.x, 3), round(offset.y, 3), round(offset.z, 3)],
    "objects": len(meshes),
    "materials": sorted(mats),
    "triangles": tris,
    "zFighting": Z_FIGHT,
    "stretchedTextures": STRETCHED,
    "review": review,
}
with open(os.path.join(OUT, "stats.json"), "w", encoding="utf-8") as f:
    json.dump(stats, f)
print("[model3d] done", json.dumps({"dims": stats["dims"], "triangles": tris}))
`;
