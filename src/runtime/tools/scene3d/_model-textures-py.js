/**
 * MATERIAL TEXTURES for the modeler, made here (no AI model, no photo pixels):
 * wood, planks, brick, tiles, plaster, stone, cobble, metal, fabric, earth,
 * grass, leaves, roof tiles. Each is a seamless image generated with numpy in
 * the colour the agent MEASURED on the photo (photo_color), repeated over the
 * surface at its real size. Antonio, 19/11/2026: projecting the photo pasted
 * the chair onto the table; the 3D is first all shapes, then materials made
 * by looking at the photo.
 *
 * A material asks for one with pbr(..., texture="planks"); a kit piece given a
 * plain colour uses its own kind (a table: wood, a room's walls: plaster).
 * _texture_pass() runs after the script, only on the MATERIALS pass.
 *
 * Inserted into BUILD_MODEL_PY. Plain Python: never backticks or ${ in it.
 */
export const MODEL_TEXTURES_PY = String.raw`
# ─────────────────────────────────────── generated material textures ──

# kind -> metres one repeat of the image covers, how strongly it varies
TEXTURE_KINDS = {
    "wood": (1.0, 0.22), "planks": (1.2, 0.25), "brick": (0.9, 0.22), "tiles": (0.6, 0.16),
    "plaster": (2.0, 0.07), "stone": (1.6, 0.2), "cobble": (1.0, 0.28), "metal": (0.5, 0.08),
    "fabric": (0.25, 0.12), "earth": (3.0, 0.18), "grass": (2.0, 0.25), "leaves": (1.5, 0.35),
    "roof_tiles": (1.2, 0.22),
}
_TEX_CACHE = {}


def _tex_kind_of(m):
    try:
        k = m.get("tex_kind") if m is not None else None
    except Exception:
        k = None
    return k if k in TEXTURE_KINDS else None


def _pnoise(rng, n, fx, fy=None):
    """Seamless (periodic) smooth noise, -1..1: white noise low-passed in
    Fourier space keeps the image's period, so its edges meet."""
    import numpy as np
    fy = fx if fy is None else fy
    w = rng.standard_normal((n, n))
    ky = np.fft.fftfreq(n)[:, None] * n
    kx = np.fft.fftfreq(n)[None, :] * n
    filt = np.exp(-((kx / max(fx, 1e-3)) ** 2 + (ky / max(fy, 1e-3)) ** 2))
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * filt))
    out -= out.mean()
    s = np.abs(out).max()
    return out / s if s > 0 else out


def _cells(n, rows, cols, stagger=0.5, gap=0.04):
    """A grid of cells (bricks, tiles, planks): per pixel the cell id and
    a 0..1 mask that is 0 in the joints."""
    import numpy as np
    yy, xx = np.mgrid[0:n, 0:n] / float(n)
    r = np.floor(yy * rows)
    xs = xx * cols + (r % 2) * stagger
    c = np.floor(xs) % cols
    fy = yy * rows - r
    fx = xs - np.floor(xs)
    gy, gx = gap * rows / max(rows, cols) * 2, gap
    joint = np.minimum(np.minimum(fy, 1 - fy) / max(gy, 1e-3), np.minimum(fx, 1 - fx) / max(gx, 1e-3))
    return r * 1000 + c, np.clip(joint, 0, 1)


def _gen_texture(kind, base, n=512, seed=7):
    """The kind's pattern in colour 'base' (linear RGB): an n x n float
    image, linear RGB, seamless. Value 0 everywhere = base exactly."""
    import numpy as np
    rng = np.random.default_rng(seed + sum(ord(ch) for ch in kind))
    base = np.array(base[:3], dtype=np.float64)
    amp = TEXTURE_KINDS[kind][1]
    t = np.zeros((n, n))
    tint = np.zeros((n, n, 3))
    if kind in ("wood", "planks"):
        # grain runs along u (x): stretched noise and rings
        warp = _pnoise(rng, n, 2, 8)
        rings = np.sin(2 * np.pi * (np.mgrid[0:n, 0:n][0] / n * 24 + warp * 2.5))
        fibre = _pnoise(rng, n, 6, 90)
        t = 0.45 * rings + 0.55 * fibre
        if kind == "planks":
            yy =np.mgrid[0:n, 0:n][0] / n * 5
            fy = yy - np.floor(yy)
            seam = np.clip(np.minimum(fy, 1 - fy) / 0.012, 0, 1)
            # plank ends staggered along the grain
            xx = np.mgrid[0:n, 0:n][1] / n
            row = np.floor(yy)
            end = (xx + (row * 0.37) % 1.0) % 1.0
            seam = seam * np.clip(np.minimum(end, 1 - end) / 0.004, 0, 1)
            tone = (np.sin((row + 1) * 12.9898) * 43758.5453) % 1.0 - 0.5
            t = t * 0.8 + tone * 0.9
            t = t * seam - (1 - seam) * 2.2
    elif kind in ("brick", "tiles", "cobble", "roof_tiles"):
        rows, cols, stagger, gap = {"brick": (12, 4, 0.5, 0.035), "tiles": (2, 2, 0.0, 0.025),
                                    "cobble": (6, 6, 0.5, 0.09), "roof_tiles": (8, 6, 0.5, 0.05)}[kind]
        ids, joint = _cells(n, rows, cols, stagger, gap)
        tone = (np.sin(ids * 12.9898) * 43758.5453) % 1.0 - 0.5
        grain = _pnoise(rng, n, 40)
        cell = tone * 1.1 + grain * 0.5
        if kind == "cobble":
            joint = np.clip(joint * 1.6, 0, 1) ** 0.7
        mortar = -1.6 if kind in ("cobble", "roof_tiles") else 0.9
        t = cell * joint + mortar * (1 - joint)
        if kind == "brick":
            # mortar is grey-white, not a lighter brick
            tint = (1 - joint)[..., None] * (np.array([0.55, 0.52, 0.48]) - base)[None, None, :] * 0.6
    elif kind == "plaster":
        t = 0.6 * _pnoise(rng, n, 3) + 0.3 * _pnoise(rng, n, 20) + 0.25 * _pnoise(rng, n, 120)
    elif kind == "stone":
        t = 0.5 * _pnoise(rng, n, 4) + 0.35 * _pnoise(rng, n, 25) + 0.3 * _pnoise(rng, n, 140)
    elif kind == "metal":
        t = 0.5 * _pnoise(rng, n, 2) + 0.5 * _pnoise(rng, n, 200, 3)
    elif kind == "fabric":
        yy, xx = np.mgrid[0:n, 0:n] / float(n)
        t = 0.5 * np.sin(2 * np.pi * xx * 64) * np.sin(2 * np.pi * yy * 64) + 0.4 * _pnoise(rng, n, 30)
    elif kind in ("earth", "grass", "leaves"):
        f = {"earth": (5, 60), "grass": (8, 160), "leaves": (14, 90)}[kind]
        t = 0.55 * _pnoise(rng, n, f[0]) + 0.6 * _pnoise(rng, n, f[1])
    t = np.clip(t, -2.5, 2.5)
    img = base[None, None, :] * (1.0 + amp * t[..., None]) + tint
    if kind == "grass":
        img[..., 1] *= 1.0 + 0.08 * _pnoise(rng, n, 30)
    return np.clip(img, 0.0, 1.0)


def _to_srgb(lin):
    import numpy as np
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.maximum(lin, 0), 1 / 2.4) - 0.055)


def _texture_material(m):
    """Give material m its generated texture, in its own colour, read on the
    UV map "tex" (world-sized, made by _texture_uvs)."""
    import numpy as np
    kind = _tex_kind_of(m)
    if kind is None or not m.use_nodes:
        return False
    b = m.node_tree.nodes.get("Principled BSDF")
    if b is None or b.inputs["Base Color"].is_linked:
        return False
    col = tuple(b.inputs["Base Color"].default_value)[:3]
    key = (kind, tuple(round(c, 3) for c in col))
    img = _TEX_CACHE.get(key)
    if img is None:
        n = 512
        px = _to_srgb(_gen_texture(kind, col, n))
        rgba = np.concatenate([px, np.ones((n, n, 1))], axis=2).astype(np.float32)
        img = bpy.data.images.new("tex_%s_%d" % (kind, len(_TEX_CACHE)), n, n, alpha=False)
        img.pixels.foreach_set(rgba.ravel())
        img.pack()
        _TEX_CACHE[key] = img
    nt = m.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "REPEAT"
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "tex"
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    return True


def _texture_uvs(ob, kinds):
    """UV map "tex" on ob: each face mapped flat on its dominant plane, in
    metres / the kind's repeat size, so the pattern keeps its real size on
    every piece. The grain (u) follows the object's longest side."""
    me = ob.data
    if me.uv_layers.get("tex") is None:
        if len(me.uv_layers) >= 8:
            return
        me.uv_layers.new(name="tex")
    uvl = me.uv_layers["tex"]
    mw = ob.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    dims = ob.dimensions
    longest = max(range(3), key=lambda i: dims[i])
    axes = (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    for poly in me.polygons:
        m = me.materials[poly.material_index] if poly.material_index < len(me.materials) else None
        k = _tex_kind_of(m)
        size = TEXTURE_KINDS[k][0] if k else 1.0
        n = (nmat @ poly.normal).normalized()
        dom = max(range(3), key=lambda i: abs(n[i]))
        a = [i for i in range(3) if i != dom]
        if longest in a and a[0] != longest:
            a = [a[1], a[0]]
        # walls and doors: the vertical axis is v, so bricks and boards lie flat
        if dom != 2 and a[0] == 2 and longest != 2:
            a = [a[1], a[0]]
        u_ax, v_ax = axes[a[0]], axes[a[1]]
        for li in poly.loop_indices:
            w = mw @ me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (w.dot(u_ax) / size, w.dot(v_ax) / size)


def _texture_pass(objs):
    """Every material that asked for a texture gets it; the meshes using
    them get their world-sized UVs. Returns how many materials."""
    done = set()
    for ob in objs:
        if ob.type != "MESH" or not ob.data.polygons:
            continue
        kinds = [_tex_kind_of(m) for m in ob.data.materials]
        if not any(kinds):
            continue
        _texture_uvs(ob, kinds)
        for m in ob.data.materials:
            if m is not None and m.name not in done and _tex_kind_of(m):
                done.add(m.name)
                _texture_material(m)
    return len(done)


_CLAY = []


def _clay_pass(objs):
    """Shapes passes: every surface one plain clay grey (no colour, no
    texture), so the review shows only the forms. Lights and glass stay."""
    if not _CLAY:
        _CLAY.append(pbr("clay", "#8a8580", rough=0.9))
    clay = _CLAY[0]
    for ob in objs:
        if ob.type != "MESH" or ob.get("sky"):
            continue
        ms = ob.data.materials
        for i, m in enumerate(ms):
            if m is None or not m.use_nodes:
                ms[i] = clay
                continue
            b = m.node_tree.nodes.get("Principled BSDF")
            if b is None:
                ms[i] = clay
                continue
            es = b.inputs.get("Emission Strength")
            tr = b.inputs.get("Transmission Weight") or b.inputs.get("Transmission")
            if (es is not None and float(es.default_value) > 0.5) or (tr is not None and float(tr.default_value) > 0.5):
                continue
            ms[i] = clay
        if not ms:
            ms.append(clay)



def _clay_shade():
    """Review renders of a clay build: each face shaded by its own direction
    (a key light from above and the front left), whatever the set's light; in
    a dim interior a flat grey hid every form. Only on the re-imported model
    (the node maths would not survive the glTF)."""
    for m in bpy.data.materials:
        if not m.name.startswith("clay") or not m.use_nodes:
            continue
        nt = m.node_tree
        b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        em = (b.inputs.get("Emission Color") or b.inputs.get("Emission")) if b else None
        if em is None or em.is_linked:
            continue
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        dot = nt.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.inputs[1].default_value = (-0.35, -0.5, 0.79)
        rng_ = nt.nodes.new("ShaderNodeMapRange")
        rng_.inputs["From Min"].default_value = -1.0
        rng_.inputs["From Max"].default_value = 1.0
        rng_.inputs["To Min"].default_value = 0.02
        rng_.inputs["To Max"].default_value = 0.3
        nt.links.new(geo.outputs["Normal"], dot.inputs[0])
        nt.links.new(dot.outputs["Value"], rng_.inputs["Value"])
        nt.links.new(rng_.outputs["Result"], em)
        _set_input(b, ("Emission Strength",), 1.0)
        b.inputs["Base Color"].default_value = (0.12, 0.115, 0.11, 1)
`;
