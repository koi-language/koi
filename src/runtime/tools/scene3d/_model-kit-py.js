/**
 * The modeler's KIT: ready-made parametric pieces (a room with its openings,
 * a wall with doors / windows / arches, stairs with a railing, a table, a
 * chair, a barrel, a house with its roof, ground, a road…) so a modeling
 * script PLACES pieces at their real sizes instead of building every face by
 * hand. A set that took ~600 lines and 10 minutes of writing is ~60 lines
 * (Antonio, 19/11/2026: "las técnicas que usa no son las más rápidas").
 *
 * Every piece: metres, `at` = its bottom centre (x, y, z), `rot` = degrees
 * about Z (counter-clockwise seen from above), `mat` = a material from pbr()
 * or a colour "#hex" (e.g. from photo_color). The front of a piece faces +y.
 * Pieces never leave two faces on one plane (no z-fighting).
 *
 * Inserted into BUILD_MODEL_PY. Plain Python: never backticks or ${ in it.
 */
export const MODEL_KIT_PY = String.raw`
# ─────────────────────────────────────────────── the kit ──

import bmesh as _bm

_KIT_MATS = {}
_KIT_N = [0]


class Parts(list):
    """A list of objects with named groups as attributes (room.walls, house.roof…)."""
    pass


def _kname(name, base):
    if name:
        return name
    _KIT_N[0] += 1
    return "%s_%d" % (base, _KIT_N[0])


def _mat(m, default="#8a8580", rough=0.85):
    if m is None:
        m = default
    if isinstance(m, (str, list, tuple)):
        key = (str(m), rough)
        if key not in _KIT_MATS:
            _KIT_MATS[key] = pbr("kit_%d" % len(_KIT_MATS), m, rough=rough)
        return _KIT_MATS[key]
    return m


def _frame(at=(0, 0, 0), rot=0):
    a = list(at) + [0, 0, 0]
    return Matrix.Translation(Vector((float(a[0]), float(a[1]), float(a[2])))) @ Matrix.Rotation(math.radians(rot), 4, "Z")


def _obj(name, bm, mat, M):
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(_mat(mat))
    ob.matrix_world = M
    return ob


def _join(objs, name):
    """One object out of several pieces of the same material (a wall and the
    bits round its openings): it reads, hides and takes the photo as ONE wall."""
    objs = [o for o in objs if o is not None]
    if len(objs) <= 1:
        return objs[0] if objs else None
    M = objs[0].matrix_world.copy()
    Mi = M.inverted()
    bm = _bm.new()
    for o in objs:
        n0 = len(bm.verts)
        bm.from_mesh(o.data)
        bm.verts.ensure_lookup_table()
        _bm.ops.transform(bm, matrix=Mi @ o.matrix_world, verts=[bm.verts[i] for i in range(n0, len(bm.verts))])
    mat = objs[0].data.materials[0] if objs[0].data.materials else None
    for o in objs:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.meshes.remove(me)
    return _obj(name, bm, mat, M)


def _cube(name, size, centre, mat, M, local=None):
    bm = _bm.new()
    _bm.ops.create_cube(bm, size=1.0)
    sx, sy, sz = [max(1e-4, float(v)) for v in size]
    for v in bm.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    L = Matrix.Translation(Vector(centre))
    if local is not None:
        L = L @ local
    return _obj(name, bm, mat, M @ L)


def _prism_bm(pts, depth):
    """Profile pts [(u, z)…] in the local x/z plane, extruded along y (centred)."""
    bm = _bm.new()
    d = float(depth) / 2
    f = [bm.verts.new((float(u), -d, float(z))) for u, z in pts]
    g = [bm.verts.new((float(u), d, float(z))) for u, z in pts]
    n = len(pts)
    caps = [bm.faces.new(f), bm.faces.new(g[::-1])]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((f[i], g[i], g[j], f[j]))
    _bm.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # Concave outlines (round an arch) as real triangles: later splitting
    # (photo_project) would otherwise fill the hollow of the curve.
    if n > 4:
        _bm.ops.triangulate(bm, faces=caps, quad_method="BEAUTY", ngon_method="EAR_CLIP")
    return bm


def _arc(cx, cz, r, a0, a1, n=12):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / n)),
             cz + r * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]


def box(size, at=(0, 0, 0), rot=0, mat=None, name=None):
    """A box (width x, depth y, height z) standing on 'at'."""
    return _cube(_kname(name, "box"), size, (0, 0, float(size[2]) / 2), mat, _frame(at, rot))


def cylinder(radius, height, at=(0, 0, 0), mat=None, sides=24, radius_top=None, name=None):
    """An upright cylinder (or a cone / frustum with radius_top) standing on 'at'."""
    bm = _bm.new()
    rt = radius if radius_top is None else radius_top
    _bm.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=int(sides),
                        radius1=float(radius), radius2=float(rt), depth=float(height))
    return _obj(_kname(name, "cyl"), bm, mat, _frame(at, 0) @ Matrix.Translation(Vector((0, 0, float(height) / 2))))


def sphere(radius, at=(0, 0, 0), mat=None, name=None):
    """A sphere centred ON 'at' (not standing on it)."""
    bm = _bm.new()
    _bm.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=float(radius))
    return _obj(_kname(name, "sphere"), bm, mat, _frame(at, 0))


def extrude(profile, depth, at=(0, 0, 0), rot=0, mat=None, name=None):
    """Any outline [(x, z)…] (a plain polygon, x across, z up) extruded 'depth' along y, centred on 'at'."""
    return _obj(_kname(name, "shape"), _prism_bm(profile, depth), mat, _frame(at, rot))


def lamp(at, color="#ffb35a", radius=0.07, strength=8.0, name=None):
    """A glowing bulb / flame / lantern glass centred on 'at' (an emitter)."""
    m = pbr(_kname(None, "lamp_glow"), color, rough=0.4, emission=color, emission_strength=strength)
    return sphere(radius, at=at, mat=m, name=_kname(name, "lamp"))


def _wall_local(length, height, thickness, mat, M, openings, base):
    """A wall along local x (centred), from z 0 to height, thickness along y.
    openings: [{x, w, h, sill=0, arch=False, ring=None}]: x = the centre along
    the wall, h = the TOP of the opening (the crown for an arch)."""
    L, H, t = float(length), float(height), float(thickness)
    out = Parts()
    rings = Parts()
    ops = sorted([dict(o) for o in (openings or [])], key=lambda o: float(o.get("x", 0)))
    cur = -L / 2
    k = [0]

    def piece(u0, u1, z0, z1):
        if u1 - u0 < 1e-3 or z1 - z0 < 1e-3:
            return
        k[0] += 1
        out.append(_cube("%s_%d" % (base, k[0]), (u1 - u0, t, z1 - z0), ((u0 + u1) / 2, 0, (z0 + z1) / 2), mat, M))

    for o in ops:
        x, w = float(o.get("x", 0)), float(o["w"])
        top = float(o["h"])
        sill = float(o.get("sill", 0) or 0)
        a, b = x - w / 2, x + w / 2
        if a < cur - 1e-3 or b > L / 2 + 1e-3:
            raise ValueError("%s: opening at x=%.2f (w %.2f) overlaps another one or the wall's end" % (base, x, w))
        piece(cur, a, 0, H)
        piece(a, b, 0, sill)
        if o.get("arch"):
            r = w / 2
            spring = top - r
            if spring < sill:
                raise ValueError("%s: arch at x=%.2f: its crown h must be at least sill + w/2" % (base, x))
            if H - top < 0.02:
                raise ValueError("%s: the wall must rise at least 2 cm above the arch crown (h)" % base)
            left = [(a, spring)] + _arc(x, spring, r, 180, 90)[1:] + [(x, H), (a, H)]
            right = [(x, spring + r)] + _arc(x, spring, r, 90, 0)[1:] + [(b, H), (x, H)]
            for side, pts in (("l", left), ("r", right)):
                k[0] += 1
                out.append(_obj("%s_%d%s" % (base, k[0], side), _prism_bm(pts, t), mat, M))
            ring = o.get("ring")
            if ring:
                rt = float(ring.get("width", 0.25)) if isinstance(ring, dict) else 0.25
                rm = ring.get("mat") if isinstance(ring, dict) else ring
                ri = r - 0.008
                for side, a0, a1 in (("l", 180, 90), ("r", 90, 0)):
                    pts = _arc(x, spring, ri, a0, a1) + _arc(x, spring, r + rt, a1, a0)
                    k[0] += 1
                    rings.append(_obj("%s_ring%d%s" % (base, k[0], side), _prism_bm(pts, t + 0.02), rm, M))
        else:
            piece(a, b, top, H)
        cur = b
    piece(cur, L / 2, 0, H)
    one = Parts([_join(list(out), base)])
    one.extend(rings)
    return one


def wall(length, height, at=(0, 0, 0), rot=0, thickness=0.25, mat=None, openings=None, name=None):
    """A straight wall with its openings cut out (doors, windows, arches).
    'at' = the bottom centre of the wall; it runs along x (rot 0), its +y face
    is the outside. openings: [{x, w, h, sill=0, arch=False, ring=None,
    door={…door() args}, window={…window() args}}], x = the opening's centre
    along the wall, h = its top (an arch's crown). door / window fill it."""
    base = _kname(name, "wall")
    M = _frame(at, rot)
    out = _wall_local(length, height, thickness, mat, M, openings, base)
    for o in openings or []:
        _fill(o, M, thickness, base, out)
    return out


def _fill(o, M, thickness, base, out):
    x, w, top = float(o.get("x", 0)), float(o["w"]), float(o["h"])
    sill = float(o.get("sill", 0) or 0)
    if o.get("door") is not None:
        d = dict(o["door"]) if isinstance(o["door"], dict) else {}
        out.extend(_door_local(w, top - sill, M @ Matrix.Translation(Vector((x, 0, sill))), arch=bool(o.get("arch")),
                               name=base + "_door", **d))
    if o.get("window") is not None:
        d = dict(o["window"]) if isinstance(o["window"], dict) else {}
        d.setdefault("depth", min(0.08, float(thickness) * 0.6))
        out.extend(_window_local(w, top - sill, M @ Matrix.Translation(Vector((x, 0, sill))), name=base + "_win", **d))


def _door_local(w, h, M, mat="#4a2f1f", open=0, leaves=1, thickness=0.05, arch=False, name="door"):
    out = Parts()
    w, h = float(w) - 0.016, float(h) - 0.014
    lw = w / max(1, int(leaves))
    for i in range(max(1, int(leaves))):
        sign = -1 if i == 0 else 1          # leaf 0 hinged on the left, leaf 1 on the right
        hinge = Vector((sign * w / 2, 0, 0.007))
        if arch:
            r = w / 2
            spring = h - r
            if int(leaves) == 1:
                prof = [(-r, 0), (r, 0)] + _arc(0, spring, r, 0, 180)[0:]
                prof = [(u + r, z) for u, z in prof]          # hinge edge at u 0
            else:
                prof = [(0, 0), (r, 0), (r, spring + r)] + _arc(r, spring, r, 90, 180)[1:]
            prof = [(u if sign < 0 else -u, z) for u, z in prof]
            bm = _prism_bm(prof, thickness)
        else:
            bm = _bm.new()
            _bm.ops.create_cube(bm, size=1.0)
            for v in bm.verts:
                v.co = Vector(((v.co.x + 0.5) * lw * (-sign), v.co.y * thickness, (v.co.z + 0.5) * h))
            _bm.ops.recalc_face_normals(bm, faces=bm.faces[:])
        ang = math.radians(float(open)) * (1 if sign < 0 else -1)
        out.append(_obj("%s_%d" % (name, i), bm, mat, M @ Matrix.Translation(hinge) @ Matrix.Rotation(ang, 4, "Z")))
    return out


def door(width, height, at=(0, 0, 0), rot=0, mat="#4a2f1f", open=0, leaves=1, thickness=0.05, arch=False, name=None):
    """Door leaf / leaves filling an opening: 'at' = the bottom centre of the
    opening (on the wall's centre line). open = degrees each leaf swings
    (leaves 1 or 2), arch=True for a round-topped door."""
    return _door_local(width, height, _frame(at, rot), mat=mat, open=open, leaves=leaves, thickness=thickness,
                       arch=arch, name=_kname(name, "door"))


def _window_local(w, h, M, frame_mat="#3b2a1e", glass="#1d2328", bars=0, bar_mat="#232323", frame=0.06,
                  depth=0.08, panes=1, name="win"):
    out = Parts()
    w, h, f, dp = float(w) - 0.014, float(h) - 0.014, float(frame), float(depth)
    c = _cube
    out.append(c(name + "_l", (f, dp, h), (-w / 2 + f / 2, 0, 0.007 + h / 2), frame_mat, M))
    out.append(c(name + "_r", (f, dp, h), (w / 2 - f / 2, 0, 0.007 + h / 2), frame_mat, M))
    out.append(c(name + "_b", (w - 2 * f, dp, f), (0, 0, 0.007 + f / 2), frame_mat, M))
    out.append(c(name + "_t", (w - 2 * f, dp, f), (0, 0, 0.007 + h - f / 2), frame_mat, M))
    for k in range(1, int(panes)):
        u = -w / 2 + f + (w - 2 * f) * k / int(panes)
        out.append(c(name + "_m%d" % k, (f * 0.6, dp * 0.8, h - 2 * f), (u, 0, 0.007 + h / 2), frame_mat, M))
    gm = pbr(_kname(None, "glass"), glass, rough=0.08, metal=0.0) if isinstance(glass, str) else glass
    out.append(c(name + "_glass", (w - 2 * f, 0.008, h - 2 * f), (0, 0, 0.007 + h / 2), gm, M))
    nb = int(bars)
    if nb > 0:
        for k in range(nb):
            u = -w / 2 + f + (w - 2 * f) * (k + 1) / (nb + 1)
            out.append(_cube(name + "_bar%d" % k, (0.018, 0.018, h - 2 * f), (u, dp / 2 + 0.03, 0.007 + h / 2), bar_mat, M))
        out.append(_cube(name + "_barx", (w - 2 * f, 0.012, 0.022), (0, dp / 2 + 0.05, 0.007 + h * 0.66), bar_mat, M))
        out.append(_cube(name + "_bary", (w - 2 * f, 0.012, 0.022), (0, dp / 2 + 0.05, 0.007 + h * 0.33), bar_mat, M))
    return out


def window(width, height, at=(0, 0, 0), rot=0, frame_mat="#3b2a1e", glass="#1d2328", bars=0, panes=1, depth=0.08, name=None):
    """A window filling an opening: frame, glass, optional bars (outside, +y). 'at' = the bottom centre (the sill)."""
    return _window_local(width, height, _frame(at, rot), frame_mat=frame_mat, glass=glass, bars=bars, panes=panes,
                         depth=depth, name=_kname(name, "win"))


def _four_walls(W, D, H, t, mat, M, openings, base, out_side_y):
    """Walls round a W x D rectangle. Openings per side: 'front' (+y), 'back'
    (-y), 'left' (-x), 'right' (+x); x = along the wall, in the piece's own
    axes (front / back: x; left / right: y)."""
    openings = openings or {}
    walls = Parts()
    specs = (
        ("front", (0, D / 2 + t / 2, 0), 0, W + 2 * t, 1),
        ("back", (0, -D / 2 - t / 2, 0), 180, W + 2 * t, -1),
        ("left", (-W / 2 - t / 2, 0, 0), 90, D, 1),
        ("right", (W / 2 + t / 2, 0, 0), -90, D, -1),
    )
    for side, pos, r, length, flip in specs:
        if side in (openings.get("skip") or []):
            continue
        ops = [dict(o, x=float(o.get("x", 0)) * flip) for o in openings.get(side, [])]
        Mw = M @ _frame(pos, r)
        b = "%s_%s" % (base, side)
        part = _wall_local(length, H, t, mat, Mw, ops, b)
        for o in ops:
            _fill(o, Mw, t, b, part)
        setattr(walls, side, part)
        walls.extend(part)
    return walls


def room(width, depth, height, at=(0, 0, 0), rot=0, thickness=0.25, floor="#6b5a4a", walls="#cfc2ad",
         ceiling="#d9d2c4", openings=None, beams=0, beam_mat="#3a2a1e", beam_size=(0.16, 0.2), name=None):
    """A room: floor (top at z 0), four walls with their openings, a ceiling
    (ceiling=None: open to the sky) and optional beams across it. width
    along x, depth along y, measured INSIDE. openings = {"front": [...],
    "back": [...], "left": [...], "right": [...], "skip": ["back"]} with the
    wall() opening fields; front = the +y wall. Returns Parts with .floor,
    .walls (and .walls.front …), .ceiling, .beams."""
    base = _kname(name, "room")
    M = _frame(at, rot)
    W, D, H, t = float(width), float(depth), float(height), float(thickness)
    out = Parts()
    out.floor = _cube(base + "_floor", (W + 2 * t, D + 2 * t, 0.1), (0, 0, -0.05), floor, M)
    out.append(out.floor)
    out.walls = _four_walls(W, D, H, t, walls, M, openings, base, 1)
    out.extend(out.walls)
    out.ceiling = None
    out.beams = Parts()
    if ceiling is not None:
        out.ceiling = _cube(base + "_ceiling", (W + 2 * t, D + 2 * t, 0.12), (0, 0, H + 0.06), ceiling, M)
        out.append(out.ceiling)
        n = int(beams)
        bw, bh = beam_size
        for k in range(n):
            x = -W / 2 + W * (k + 0.5) / n
            out.beams.append(_cube("%s_beam%d" % (base, k), (bw, D - 0.004, bh), (x, 0, H - bh / 2), beam_mat, M))
        out.extend(out.beams)
    return out


def gable_roof(width, depth, pitch=30, at=(0, 0, 0), rot=0, mat="#7a4a36", overhang=0.3, thickness=0.12,
               gable_mat=None, name=None):
    """A two-slope roof over a width (x) x depth (y) footprint; the ridge runs
    along x. 'at' = the centre of the footprint at the TOP of the walls.
    gable_mat (the walls' material) fills the triangular ends."""
    base = _kname(name, "roof")
    M = _frame(at, rot)
    W, D, o, t = float(width), float(depth), float(overhang), float(thickness)
    tn = math.tan(math.radians(float(pitch)))
    zr = D / 2 * tn
    z0 = -o * tn
    tv = t / math.cos(math.radians(float(pitch)))
    out = Parts()
    R = Matrix.Rotation(math.radians(90), 4, "Z")      # profile in (y, z), extruded along x
    for side, s in (("a", 1), ("b", -1)):
        prof = [(s * (D / 2 + o), z0), (0, zr), (0, zr + tv), (s * (D / 2 + o), z0 + tv)]
        out.append(_obj("%s_%s" % (base, side), _prism_bm(prof, W + 2 * o), mat, M @ R))
    if gable_mat is not None:
        out.append(_obj(base + "_gable", _prism_bm([(-D / 2, 0), (D / 2, 0), (0, zr)], W), gable_mat, M @ R))
    return out


def hip_roof(width, depth, pitch=30, at=(0, 0, 0), rot=0, mat="#7a4a36", overhang=0.3, name=None):
    """A four-slope (hipped) roof over a width (x) x depth (y) footprint.
    'at' = the centre of the footprint at the TOP of the walls."""
    base = _kname(name, "roof")
    M = _frame(at, rot)
    W, D, o = float(width) + 2 * float(overhang), float(depth) + 2 * float(overhang), float(overhang)
    tn = math.tan(math.radians(float(pitch)))
    z0 = -o * tn
    swap = D > W
    if swap:
        W, D = D, W
    zr = z0 + D / 2 * tn
    rl = (W - D) / 2
    bm = _bm.new()
    v = [bm.verts.new(p) for p in ((-W / 2, -D / 2, z0), (W / 2, -D / 2, z0), (W / 2, D / 2, z0), (-W / 2, D / 2, z0))]
    if rl > 1e-3:
        r0, r1 = bm.verts.new((-rl, 0, zr)), bm.verts.new((rl, 0, zr))
        faces = [(v[3], v[2], v[1], v[0]), (v[0], v[1], r1, r0), (v[2], v[3], r0, r1), (v[1], v[2], r1), (v[3], v[0], r0)]
    else:
        r0 = bm.verts.new((0, 0, zr))
        faces = [(v[3], v[2], v[1], v[0]), (v[0], v[1], r0), (v[1], v[2], r0), (v[2], v[3], r0), (v[3], v[0], r0)]
    for f in faces:
        bm.faces.new(f)
    _bm.ops.recalc_face_normals(bm, faces=bm.faces[:])
    Mr = M @ (Matrix.Rotation(math.radians(90), 4, "Z") if swap else Matrix.Identity(4))
    return Parts([_obj(base, bm, mat, Mr)])


def house(width, depth, height, at=(0, 0, 0), rot=0, thickness=0.45, walls="#b59a7a", roof="hip",
          roof_mat="#7a4a36", pitch=28, overhang=0.35, openings=None, chimney=None, name=None):
    """A building block seen from outside: four walls with their openings
    (front = +y; same openings dict as room()) and its roof ("hip",
    "gable" or None). chimney = (x, y, w, h) on the roof, in the house's
    axes. Returns Parts with .walls, .roof."""
    base = _kname(name, "house")
    M = _frame(at, rot)
    W, D, H, t = float(width), float(depth), float(height), float(thickness)
    out = Parts()
    out.walls = _four_walls(W - 2 * t, D - 2 * t, H, t, walls, M, openings, base, 1)
    out.extend(out.walls)
    out.roof = Parts()
    if roof == "gable":
        out.roof = gable_roof(W, D, pitch, at=(0, 0, 0), mat=roof_mat, overhang=overhang, gable_mat=walls, name=base + "_roof")
    elif roof == "hip":
        out.roof = hip_roof(W, D, pitch, at=(0, 0, 0), mat=roof_mat, overhang=overhang, name=base + "_roof")
    for ob in out.roof:
        ob.matrix_world = M @ Matrix.Translation(Vector((0, 0, H))) @ ob.matrix_world
    out.extend(out.roof)
    if chimney:
        cx, cy, cw, ch = [float(v) for v in chimney]
        out.append(_cube(base + "_chimney", (cw, cw, ch), (cx, cy, H + ch / 2), walls, M))
    return out


def stairs(width, height, run, at=(0, 0, 0), rot=0, steps=None, mat="#5a3d2b", railing=None, rail_mat="#3e2a1d",
           balusters=True, rail_height=0.9, name=None):
    """A straight solid stair climbing towards +y: the first riser at y 0,
    the top at (y run, z height). railing = "left", "right" or "both":
    posts, a sloped handrail and balusters. Returns Parts with .steps, .railing."""
    base = _kname(name, "stairs")
    M = _frame(at, rot)
    W, Hh, R = float(width), float(height), float(run)
    n = int(steps) if steps else max(2, int(round(Hh / 0.18)))
    rise, dep = Hh / n, R / n
    out = Parts()
    out.steps = Parts()
    for i in range(n):
        out.steps.append(_cube("%s_s%d" % (base, i), (W, dep, rise * (i + 1)), (0, dep * (i + 0.5), rise * (i + 1) / 2), mat, M))
    out.extend(out.steps)
    out.railing = Parts()
    sides = {"left": [-1], "right": [1], "both": [-1, 1]}.get(railing or "", [])
    ang = math.atan2(Hh, R)
    ln = math.hypot(Hh, R)
    for s in sides:
        x = s * (W / 2 - 0.06)
        out.railing.append(_cube("%s_post0%s" % (base, s), (0.1, 0.1, rail_height + rise + 0.1), (x, dep / 2, 0.003 + (rail_height + rise + 0.1) / 2), rail_mat, M))
        out.railing.append(_cube("%s_post1%s" % (base, s), (0.1, 0.1, rail_height + 0.1), (x, R - dep / 2, Hh + (rail_height + 0.1) / 2), rail_mat, M))
        out.railing.append(_cube("%s_hand%s" % (base, s), (0.07, ln, 0.06), (x, R / 2, Hh / 2 + rise / 2 + rail_height),
                                 rail_mat, M, local=Matrix.Rotation(ang, 4, "X")))
        if balusters:
            k = 0
            for i in range(n):
                for frac in (0.3, 0.75):
                    y = dep * (i + frac)
                    if y < dep or y > R - dep:
                        continue
                    z0 = rise * (i + 1)
                    zt = y * Hh / R + rise / 2 + rail_height
                    k += 1
                    out.railing.append(_cube("%s_bal%s_%d" % (base, s, k), (0.035, 0.035, zt - z0), (x, y, z0 + (zt - z0) / 2), rail_mat, M))
    out.extend(out.railing)
    return out


def table(width, depth, height=0.76, at=(0, 0, 0), rot=0, mat="#5a3b26", top=0.05, leg=0.07, turned=False, name=None):
    """A table: top + four legs (turned=True: round legs)."""
    base = _kname(name, "table")
    M = _frame(at, rot)
    W, D, H = float(width), float(depth), float(height)
    out = Parts([_cube(base + "_top", (W, D, top), (0, 0, H - top / 2), mat, M)])
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        x, y = sx * (W / 2 - 0.06 - leg / 2), sy * (D / 2 - 0.06 - leg / 2)
        if turned:
            p = M @ Vector((x, y, 0))
            out.append(cylinder(leg / 2, H - top, at=(p.x, p.y, p.z), mat=mat, sides=12, name="%s_leg%d" % (base, i)))
        else:
            out.append(_cube("%s_leg%d" % (base, i), (leg, leg, H - top), (x, y, (H - top) / 2), mat, M))
    out.append(_cube(base + "_apron", (W - 0.14, D - 0.14, 0.09), (0, 0, H - top - 0.045), mat, M))
    return out


def chair(at=(0, 0, 0), rot=0, mat="#4f3423", seat_mat=None, seat_h=0.45, width=0.44, depth=0.42, back_h=0.95,
          slats=3, name=None):
    """A chair facing +y: legs, seat (seat_mat: rush, cushion…), a back of slats."""
    base = _kname(name, "chair")
    M = _frame(at, rot)
    W, D, S, B = float(width), float(depth), float(seat_h), float(back_h)
    lg = 0.04
    out = Parts()
    for i, (sx, sy) in enumerate(((-1, 1), (1, 1))):
        out.append(_cube("%s_fl%d" % (base, i), (lg, lg, S - 0.04), (sx * (W / 2 - 0.03), sy * (D / 2 - 0.03), (S - 0.04) / 2), mat, M))
    for i, sx in enumerate((-1, 1)):
        out.append(_cube("%s_bl%d" % (base, i), (lg, lg, B), (sx * (W / 2 - 0.03), -(D / 2 - 0.03), B / 2), mat, M))
    out.append(_cube(base + "_seat", (W - 0.004, D, 0.04), (0, 0.002, S - 0.02), seat_mat or mat, M))
    n = max(1, int(slats))
    for k in range(n):
        z = S + 0.12 + (B - S - 0.2) * (k + 0.5) / n
        out.append(_cube("%s_slat%d" % (base, k), (W - 0.06 - lg, 0.02, 0.06), (0, -(D / 2 - 0.03), z), mat, M))
    return out


def bench(length, at=(0, 0, 0), rot=0, mat="#5a3b26", height=0.45, depth=0.32, name=None):
    """A plain bench along x."""
    base = _kname(name, "bench")
    M = _frame(at, rot)
    L = float(length)
    out = Parts([_cube(base + "_top", (L, depth, 0.05), (0, 0, height - 0.025), mat, M)])
    for i, sx in enumerate((-1, 1)):
        out.append(_cube("%s_leg%d" % (base, i), (0.06, depth - 0.06, height - 0.05), (sx * (L / 2 - 0.12), 0, (height - 0.05) / 2), mat, M))
    return out


def barrel(radius=0.3, height=0.85, at=(0, 0, 0), mat="#6b4a2e", hoop_mat="#2b2622", name=None):
    """An upright barrel with its bulge and three hoops."""
    base = _kname(name, "barrel")
    r, h = float(radius), float(height)
    a = list(at) + [0, 0, 0]
    out = Parts()
    for i, (r1, r2, z) in enumerate(((r * 0.86, r, 0), (r, r * 0.86, h / 2))):
        bm = _bm.new()
        _bm.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=24, radius1=r1, radius2=r2, depth=h / 2)
        out.append(_obj("%s_%d" % (base, i), bm, mat, _frame((a[0], a[1], a[2] + z + h / 4), 0)))
    for i, f in enumerate((0.12, 0.5, 0.88)):
        rr = r * (0.86 + 0.14 * (1 - abs(f - 0.5) * 2)) + 0.008
        out.append(cylinder(rr, 0.035, at=(a[0], a[1], a[2] + f * h - 0.0175), mat=hoop_mat, sides=24, name="%s_hoop%d" % (base, i)))
    return out


def ground(width, depth, at=(0, 0, 0), mat="#6a5c4c", name=None):
    """A ground slab whose TOP is at 'at' (z): width along x, depth along y."""
    a = list(at) + [0, 0, 0]
    return _cube(_kname(name, "ground"), (width, depth, 0.2), (0, 0, -0.1), mat, _frame(a, 0))


def road(points, width, mat="#5b5048", z=0.0, lift=0.012, name=None):
    """A flat strip (a road, a path, a track, a river) along a polyline
    [(x, y)…], 'lift' above the ground at height z."""
    pts = [Vector((float(p[0]), float(p[1]), 0)) for p in points]
    if len(pts) < 2:
        raise ValueError("road: at least two points")
    bm = _bm.new()
    left, right = [], []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        d = (b - a).normalized()
        nrm = Vector((-d.y, d.x, 0)) * (float(width) / 2)
        left.append(bm.verts.new((p.x + nrm.x, p.y + nrm.y, float(z) + lift)))
        right.append(bm.verts.new((p.x - nrm.x, p.y - nrm.y, float(z) + lift)))
    for i in range(len(pts) - 1):
        f = bm.faces.new((right[i], right[i + 1], left[i + 1], left[i]))
        if f.normal.z < 0:
            f.normal_flip()
    return _obj(_kname(name, "road"), bm, mat, Matrix.Identity(4))


def disc(rx, ry, at=(0, 0, 0), mat="#4a5560", lift=0.015, rot=0, name=None):
    """A flat ellipse lying 'lift' above 'at' (a puddle, a rug, a patch of different ground)."""
    bm = _bm.new()
    vs = [bm.verts.new((float(rx) * math.cos(2 * math.pi * k / 32), float(ry) * math.sin(2 * math.pi * k / 32), float(lift))) for k in range(32)]
    bm.faces.new(vs)
    return _obj(_kname(name, "disc"), bm, mat, _frame(at, rot))


def stone_cross(at=(0, 0, 0), rot=0, height=3.2, mat="#8c8478", name=None):
    """A wayside stone cross on a stepped base."""
    base = _kname(name, "cross")
    M = _frame(at, rot)
    H = float(height)
    out = Parts([
        _cube(base + "_step0", (1.4, 1.4, 0.25), (0, 0, 0.125), mat, M),
        _cube(base + "_step1", (0.9, 0.9, 0.25), (0, 0, 0.375), mat, M),
        _cube(base + "_shaft", (0.22, 0.22, H - 0.5), (0, 0, 0.5 + (H - 0.5) / 2), mat, M),
        _cube(base + "_arm", (0.8, 0.18, 0.18), (0, 0, H - 0.45), mat, M),
    ])
    return out


def tree(at=(0, 0, 0), height=5.0, crown=1.6, trunk_mat="#4a3a2a", leaf_mat="#4b5a32", name=None):
    """A simple tree: trunk + round crown."""
    base = _kname(name, "tree")
    a = list(at) + [0, 0, 0]
    H, c = float(height), float(crown)
    out = Parts([cylinder(0.12 + H * 0.01, H - c, at=a, mat=trunk_mat, sides=10, name=base + "_trunk")])
    bm = _bm.new()
    _bm.ops.create_icosphere(bm, subdivisions=2, radius=c)
    out.append(_obj(base + "_crown", bm, leaf_mat, _frame((a[0], a[1], a[2] + H - c * 0.9), 0)))
    return out


PIECES = []


def place_model(model_id, at=(0, 0, 0), rot=0, fit=None, scale=None, name=None):
    """ASSEMBLY: put a piece modeled on its own (build_model3d kind "object",
    e.g. "zaguan-escalera") into this set, where its BLOCK was. 'at' = the
    bottom centre of the block, 'rot' = its turn (the piece's front, +y,
    turned like the block). fit=(w, d, h) = the block's size: the piece is
    scaled UNIFORMLY to sit in it (never stretched), and how far it still
    differs per axis is reported in stats.pieces (look at it: more than ~5 %
    means the piece or the block is wrong, fix that one). scale= a plain
    uniform scale instead. The piece keeps its own materials (the auto
    photo dressing leaves it alone). Returns its objects."""
    import os as _os
    mdir = args.models_dir or ""
    path = _os.path.join(mdir, str(model_id), "model.glb")
    if not mdir or not _os.path.exists(path):
        raise ValueError("place_model: piece %r is not built yet (no %s): build it first, or keep its block for now" % (model_id, path))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None or o.parent not in new]
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    bpy.context.view_layer.update()
    for o in new:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector((min(mn.x, w.x), min(mn.y, w.y), min(mn.z, w.z)))
            mx = Vector((max(mx.x, w.x), max(mx.y, w.y), max(mx.z, w.z)))
    size = mx - mn
    k = 1.0
    off = {}
    if fit:
        fw, fd, fh = [float(v) for v in fit]
        ratios = [fw / max(size.x, 1e-4), fd / max(size.y, 1e-4), fh / max(size.z, 1e-4)]
        k = sorted(ratios)[1]  # the median: one odd axis never decides
        off = {"x": round(size.x * k / fw - 1, 3), "y": round(size.y * k / fd - 1, 3), "z": round(size.z * k / fh - 1, 3)}
    elif scale:
        k = float(scale)
    # Bottom centre of the piece onto 'at'.
    base = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    M = _frame(at, rot) @ Matrix.Scale(k, 4) @ Matrix.Translation(-base)
    for o in roots:
        o.matrix_world = M @ o.matrix_world
    for o in new:
        o["piece"] = str(model_id)
        if name and o.type == "MESH":
            o.name = "%s_%s" % (name, o.name)
    bpy.context.view_layer.update()
    PIECES.append({"id": str(model_id), "at": [round(float(v), 3) for v in list(at)[:3]], "rot": rot,
                   "scale": round(k, 4), "size": [round(size.x * k, 3), round(size.y * k, 3), round(size.z * k, 3)],
                   **({"fitOff": off} if off else {})})
    return Parts([o for o in new if o.type == "MESH"])


def _kinded(fn, kinds):
    """fn with its material params given a texture kind when the script
    passes a plain colour or a material without one (a table is wood, a
    room's walls plaster): the materials pass then generates that pattern
    in the colour given. A material made with pbr(texture=...) keeps its own."""
    import inspect
    sig = inspect.signature(fn)

    def wrapped(*a, **kw):
        ba = sig.bind_partial(*a, **kw)
        for p_, kind in kinds.items():
            v = ba.arguments.get(p_, sig.parameters[p_].default)
            if v is None or (isinstance(v, str) and p_ == "roof" and v in ("hip", "gable")):
                continue
            m = _mat(v)
            try:
                if not m.get("tex_kind"):
                    m["tex_kind"] = kind
            except Exception:
                pass
            ba.arguments[p_] = m
        return fn(*ba.args, **ba.kwargs)
    wrapped.__doc__ = fn.__doc__
    wrapped.__name__ = fn.__name__
    return wrapped


_KINDS = {
    "wall": {"mat": "plaster"}, "door": {"mat": "planks"}, "window": {"frame_mat": "wood"},
    "room": {"floor": "tiles", "walls": "plaster", "ceiling": "plaster", "beam_mat": "wood"},
    "house": {"walls": "plaster", "roof_mat": "roof_tiles"}, "gable_roof": {"mat": "roof_tiles"},
    "hip_roof": {"mat": "roof_tiles"}, "stairs": {"mat": "wood", "rail_mat": "wood"},
    "table": {"mat": "wood"}, "chair": {"mat": "wood"}, "bench": {"mat": "wood"},
    "barrel": {"mat": "planks", "hoop_mat": "metal"}, "ground": {"mat": "earth"}, "road": {"mat": "cobble"},
    "stone_cross": {"mat": "stone"}, "tree": {"trunk_mat": "wood", "leaf_mat": "leaves"},
}
for _k, _v in _KINDS.items():
    globals()[_k] = _kinded(globals()[_k], _v)

KIT = {
    "place_model": place_model,
    "Parts": Parts, "box": box, "cylinder": cylinder, "sphere": sphere, "extrude": extrude, "lamp": lamp,
    "wall": wall, "door": door, "window": window, "room": room, "house": house, "gable_roof": gable_roof,
    "hip_roof": hip_roof, "stairs": stairs, "table": table, "chair": chair, "bench": bench, "barrel": barrel,
    "ground": ground, "road": road, "disc": disc, "stone_cross": stone_cross, "tree": tree,
}
`;
