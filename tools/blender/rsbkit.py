# rsbkit — the shared hard-surface modelling kit for RED STARBASE's Blender heroes.
#
# Why this exists: hand-typing an accessory's position as `center + (0,-0.14,0.11)`
# is how the first astronaut ended up with lamps, brims and knee caps floating in
# mid air. Every part that belongs on a curved body is now placed by *boolean*
# geometry against that body (shell_patch cuts a real rim, band hugs a real
# cylinder), so a part cannot be off-surface unless its radius is wrong.
#
# Import from a builder:  from rsbkit import *
import bpy, bmesh, math, os
from mathutils import Vector

TAU = math.tau
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "public", "assets"))


# ────────────────────────────── materials ──────────────────────────────
def set_in(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val
        return True
    return False


def mat(name, color, rough=0.4, metal=0.0, emis=None, estr=0.0, alpha=None):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    set_in(b, "Base Color", (*color, 1))
    set_in(b, "Roughness", rough)
    set_in(b, "Metallic", metal)
    if emis:
        set_in(b, "Emission Color", (*emis, 1))
        set_in(b, "Emission Strength", estr)
    if alpha is not None:
        set_in(b, "Alpha", alpha)
        m.blend_method = 'BLEND'
        try:
            m.show_transparent_back = False
        except Exception:
            pass
    return m


_IMAGES = {}


def img(path, noncolor=False):
    """One datablock per file, so three materials sharing a normal map export one image."""
    if path in _IMAGES:
        return _IMAGES[path]
    im = bpy.data.images.load(path, check_existing=True)
    if noncolor:
        im.colorspace_settings.name = 'Non-Color'
    _IMAGES[path] = im
    return im


def mat_pbr(name, maps, rough=0.5, metal=0.0):
    """A material driven by the maps rsbtex forges: a base colour, a roughness field, and
    a tangent-space normal. The mesh has to carry UVs authored in the same metre scale the
    map was rasterised at — these maps hold physical detail (a 1.25 m weld pitch, a 300 mm
    tile) that only reads correctly if the UV says so. Each input is a straight image link,
    because a multiply chain is not something the glTF exporter will carry."""
    m = mat(name, (1, 1, 1), rough, metal)
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    for i, (key, slot) in enumerate((("basecolor", "Base Color"), ("rough", "Roughness"),
                                     ("normal", "Normal"))):
        if key not in maps:
            continue
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img(maps[key], noncolor=key != "basecolor")
        n.location = (b.location.x - 620, b.location.y + 200 - 300 * i)
        if key == "normal":
            nm = nt.nodes.new('ShaderNodeNormalMap')
            nm.location = (b.location.x - 260, b.location.y - 200)
            nt.links.new(n.outputs['Color'], nm.inputs['Color'])
            nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
        else:
            nt.links.new(n.outputs['Color'], b.inputs[slot])
    return m


def mat_decal(name, maps, rough=0.45, metal=0.0):
    """Paint laid over whatever is under it: one RGBA texture whose alpha is the mask, so a
    wordmark is lettering rather than a panel. This is the baseColorTexture-with-alpha form
    the glTF exporter carries as alphaMode BLEND — the only transparent material that
    survives the round trip intact."""
    m = mat(name, (1, 1, 1), rough, metal, alpha=0.0)
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    n = nt.nodes.new('ShaderNodeTexImage')
    n.image = img(maps["decal"])
    n.location = (b.location.x - 620, b.location.y)
    nt.links.new(n.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(n.outputs['Alpha'], b.inputs['Alpha'])
    return m


MANIFEST = "/tmp/rsb_tex/manifest.json"


def textures():
    """What `python3 tools/blender/rsbtex.py` forged: {key: {"maps": {slot: png}, "u_m": m,
    "v_m": m}}. Read rather than imported because Blender's bundled interpreter has no
    Pillow — and the repeat sizes are what let a builder author UVs in metres."""
    if not os.path.exists(MANIFEST):
        raise SystemExit("no forged maps: run `python3 tools/blender/rsbtex.py` first")
    import json
    with open(MANIFEST) as f:
        return json.load(f)


# ────────────────────────────── object ops ──────────────────────────────
def act(o):
    bpy.context.view_layer.objects.active = o
    return o


def link(o):
    bpy.context.collection.objects.link(o)
    return o


def apply_mods(o):
    act(o)
    bpy.context.view_layer.update()
    for md in list(o.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=md.name)
        except Exception:
            o.modifiers.remove(md)
    return o


def bevel(o, width, segs=3, min_angle=28):
    """Angle-limited bevel: rounds creases and boundaries, never coplanar
    triangulation edges (beveling those on a cylinder cap blows up)."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    edges = []
    for e in bm.edges:
        if not e.verts:
            continue
        if len(e.link_faces) < 2:
            edges.append(e)
        else:
            try:
                if e.calc_face_angle() > math.radians(min_angle):
                    edges.append(e)
            except Exception:
                pass
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=width, segments=segs,
                        profile=0.72, affect='EDGES', clamp_overlap=True)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return o


def smooth_angle(o, deg=40):
    act(o)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(deg))
    except Exception:
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            o.data.shade_flat()
    return o


def mesh_obj(name, bm, m=None, shade=40):
    me = bpy.data.meshes.new(name)
    try:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    except Exception:
        pass
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    if m:
        me.materials.append(m)
    return smooth_angle(o, shade)


def solidify(o, thick, offset=1.0):
    md = o.modifiers.new("sol", 'SOLIDIFY')
    md.thickness = thick
    md.offset = offset
    md.use_even_offset = True
    return apply_mods(o)


def compact_materials(o):
    """A boolean inherits its cutter's material slots, and an unmaterialised cutter
    contributes an empty one — which lands in slot 0 of a fresh mesh, so every face
    points at nothing and the glTF exporter silently drops the part's material.
    Rebuild the slot list from what the faces actually reference."""
    me = o.data
    keep, remap = [], {}
    for i in sorted({p.material_index for p in me.polygons}):
        m = me.materials[i] if i < len(me.materials) else None
        if m is None:
            continue
        if m not in keep:
            keep.append(m)
        remap[i] = keep.index(m)
    me.materials.clear()
    for m in keep:
        me.materials.append(m)
    for p in me.polygons:
        p.material_index = remap.get(p.material_index, 0)
    return o


def bool_op(target, cutter, op='DIFFERENCE', keep_cutter=False):
    """Exact-solver boolean. This is what gives a cut edge a real rim instead of a
    staircase of dropped quads."""
    md = target.modifiers.new("bs", 'BOOLEAN')
    md.operation = op
    md.solver = 'EXACT'
    md.object = cutter
    apply_mods(target)
    if not keep_cutter:
        cut = cutter.data
        bpy.data.objects.remove(cutter, do_unlink=True)
        if cut.users == 0:
            bpy.data.meshes.remove(cut)
    return compact_materials(target)


def join(objs, name=None):
    keep = objs[0]
    act(keep)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    act(keep)
    try:
        bpy.ops.object.join()
    except Exception:
        pass
    bpy.ops.object.select_all(action='DESELECT')
    if name:
        keep.name = name
    return keep


# ────────────────────────────── primitives ──────────────────────────────
def apply_scale(o):
    """Blender 5.2's transform_apply defaults location/rotation to True, which bakes
    the placement into the mesh and leaves the origin at world zero — every later
    rotation of that object then swings it across the scene. Name the flags."""
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def rbox(name, sx, sy, sz, loc, m=None, bevel_r=None, segs=3, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (sx, sy, sz)
    apply_scale(o)
    bevel(o, bevel_r if bevel_r is not None else min(sx, sy, sz) * 0.24, segs)
    smooth_angle(o)
    if m:
        o.data.materials.append(m)
    return o


def ball(name, r, loc, m=None, segs=32, rings=None, scale=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=segs,
                                         ring_count=rings or segs // 2 + 2)
    o = act(bpy.context.object)
    o.name = name
    if scale:
        o.scale = scale
        apply_scale(o)
    bpy.ops.object.shade_smooth()
    if m:
        o.data.materials.append(m)
    return o


def cyl(name, r, d, loc, m=None, rot=(0, 0, 0), verts=32, br=None, bsegs=2):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, rotation=rot,
                                        vertices=verts)
    o = act(bpy.context.object)
    o.name = name
    if br is None:
        br = r * 0.3
    if br > 0:
        bevel(o, br, bsegs)
    smooth_angle(o)
    if m:
        o.data.materials.append(m)
    return o


def cone(name, r1, r2, d, loc, m=None, rot=(0, 0, 0), verts=40, br=0.0):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=d, location=loc,
                                    rotation=rot, vertices=verts)
    o = act(bpy.context.object)
    o.name = name
    if br > 0:
        bevel(o, br, 2)
    smooth_angle(o, 46)
    if m:
        o.data.materials.append(m)
    return o


def torus(name, c, axis, ref, R, r, m=None, maj=28, mino=8):
    a = Vector(axis).normalized()
    u = Vector(ref).normalized().cross(a)
    if u.length < 1e-6:
        u = Vector((1, 0, 0)) if abs(a.z) < 0.9 else Vector((0, 1, 0))
    u.normalize()
    v = a.cross(u).normalized()
    c = Vector(c)
    bm = bmesh.new()
    grid = []
    for i in range(maj):
        ang = i / maj * TAU
        ctr = c + u * (R * math.cos(ang)) + v * (R * math.sin(ang))
        nu = u * math.cos(ang) + v * math.sin(ang)
        grid.append([bm.verts.new(ctr + nu * (r * math.cos(b)) + a * (r * math.sin(b)))
                     for b in [k / mino * TAU for k in range(mino)]])
    for i in range(maj):
        for j in range(mino):
            bm.faces.new((grid[i][j], grid[i][(j + 1) % mino],
                          grid[(i + 1) % maj][(j + 1) % mino], grid[(i + 1) % maj][j]))
    return mesh_obj(name, bm, m)


def empty(name, loc=(0, 0, 0)):
    bpy.ops.object.empty_add(location=loc)
    o = act(bpy.context.object)
    o.name = name
    return o


def parent(c, p):
    c.parent = p
    c.matrix_parent_inverse = p.matrix_world.inverted()
    return c


def purge():
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def export(root, fname):
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for o in root.children_recursive:
        if o.type in {'MESH', 'EMPTY'}:
            o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, fname), export_format='GLB',
                              use_selection=True, export_yup=True, export_apply=True)
    print("EXPORTED", fname, os.path.getsize(os.path.join(OUT, fname)))


# ────────────────────── surface-conforming detail ──────────────────────
def shell(name, center, R, m=None, thick=0.008, segs=48, rings=26, squash=None,
          cut=(), keepcap=None):
    """A hollow sphere with real rims cut into it. `cut` is a list of
    (location, radius) cutter spheres — a cutter placed in front of the helmet
    leaves a clean circular face window instead of a staircased hole."""
    o = ball(name, R, center, None, segs=segs, rings=rings, scale=squash)
    if thick:
        solidify(o, thick)
    for loc, r in cut:
        bool_op(o, ball("cuttmp", r, loc, None, segs=28, rings=16))
    if keepcap:
        bool_op(o, keepcap)
    if m:
        o.data.materials.append(m)
    return smooth_angle(o, 50)


def band(name, c, axis, ref, R, height, thick, m=None, arc=TAU, nseg=48, a0=0.0,
         center_dir=None):
    """A partial cylindrical shell that hugs a body of radius R — armor plates,
    knee guards, shoulder cowls, helmet brims. Off-surface is impossible: the
    plate's inner radius *is* the body radius. `center_dir` rotates the arc so it
    faces wherever the armor actually belongs."""
    a = Vector(axis).normalized()
    u = Vector(ref).normalized().cross(a)
    if u.length < 1e-6:
        u = Vector((1, 0, 0)) if abs(a.z) < 0.9 else Vector((0, 1, 0))
    u.normalize()
    v = a.cross(u).normalized()
    if center_dir is not None:
        cd = Vector(center_dir).normalized()
        a0 = math.atan2(cd.dot(v), cd.dot(u)) - arc / 2
    c = Vector(c)
    n = max(3, int(round(nseg * arc / TAU)))
    bm = bmesh.new()
    rows = []
    for j in range(2):
        z = height * (j - 0.5)
        rows.append([bm.verts.new(c + (u * math.cos(a0 + arc * i / n)
                                       + v * math.sin(a0 + arc * i / n)) * R + a * z)
                     for i in range(n + 1)])
    for i in range(n):
        bm.faces.new([rows[0][i], rows[0][i + 1], rows[1][i + 1], rows[1][i]])
    o = mesh_obj(name, bm, m)
    return solidify(o, thick)


# ─────────────────────────── soft goods ───────────────────────────
def lobes(n, amp):
    return lambda t: 1.0 + amp * math.sin((t * n) % 1.0 * math.pi) ** 2


def folds(n, amp):
    return lambda t: 1.0 + amp * (0.5 + 0.5 * math.cos(t * n * TAU))


def ramp(t, a, b, lo=0.0, hi=1.0):
    if b <= a:
        return hi if t >= b else lo
    u = min(1.0, max(0.0, (t - a) / (b - a)))
    return lo + (hi - lo) * u


def chain(*fns):
    return lambda t: math.prod(f(t) for f in fns)


def _walk(pts, steps):
    p = [Vector(v) for v in pts]
    out = []
    for i in range(len(p) - 1):
        for k in range(steps):
            out.append(p[i].lerp(p[i + 1], k / steps))
    out.append(p[-1])
    fr = []
    for j, c in enumerate(out):
        t = out[min(j + 1, len(out) - 1)] - out[max(j - 1, 0)]
        if t.length < 1e-7:
            t = Vector((0, 0, 1))
        t.normalize()
        up = Vector((0, 1, 0)) if abs(t.z) > 0.95 else Vector((0, 0, 1))
        u = up.cross(t).normalized()
        v = t.cross(u).normalized()
        fr.append((c, t, u, v))
    return fr


def _lerp_scalars(vals, steps):
    out = []
    for i in range(len(vals) - 1):
        for k in range(steps):
            out.append(vals[i] + (vals[i + 1] - vals[i]) * k / steps)
    out.append(vals[-1])
    return out


def limb(name, pts, rx, ry=None, m=None, steps=12, verts=24, mod=None, cap=True,
         shade=44):
    """A lofted sweep whose radius is modulated along its length — pressurised
    soft goods gather into lobes between bearings and deep folds at each joint."""
    fr = _walk(pts, steps)
    np = len(pts)
    RX = _lerp_scalars(rx if isinstance(rx, list) else [rx] * np, steps)
    RY = RX if ry is None else _lerp_scalars(ry if isinstance(ry, list) else [ry] * np, steps)
    bm = bmesh.new()
    rings = []
    n = len(fr)
    for j, (c, t, u, v) in enumerate(fr):
        k = mod(j / (n - 1)) if mod else 1.0
        rings.append([bm.verts.new(c + u * (RX[j] * k * math.cos(i / verts * TAU))
                                   + v * (RY[j] * k * math.sin(i / verts * TAU)))
                      for i in range(verts)])
    for j in range(len(rings) - 1):
        for i in range(verts):
            bm.faces.new((rings[j][i], rings[j][(i + 1) % verts],
                          rings[j + 1][(i + 1) % verts], rings[j + 1][i]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    return mesh_obj(name, bm, m, shade)


def ring_set(name, pts, stations, R, r, m, axis_ref=None, maj=26, mino=7):
    """Constraint rings at fractional stations along a limb path — the bearings a
    pressure suit needs to bend at all."""
    fr = _walk(pts, 40)
    j = int(round(stations * (len(fr) - 1))) if isinstance(stations, float) else stations
    c, t, u, v = fr[min(j, len(fr) - 1)]
    return torus(name, c, t, axis_ref or u, R, r, m, maj, mino)
