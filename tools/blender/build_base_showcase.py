# ============================================================================
# RED STARBASE — BASE-STRUCTURE showcase builder (Blender 5.2 LTS, headless)
#
# The "other half" of the showcase pass: everything that makes the base read
# as one built place — starship, habitat dome, greenhouse, launch tower, cryo
# tank, lander, road lamp, collectible crystal.  House style matches the hero
# pass (tools/blender/build_showcase.py): real hard-surface detail — plate
# panels with recessed seams + bolt rows, lattice trusses, fluted columns,
# bolted flanges, valve wheels, conduit runs, handrails, readable interiors.
#
# Run:   blender --background --python tools/blender/build_base_showcase.py
# Dev:   blender --background --python tools/blender/build_base_showcase.py -- --only starship,lamp --no-render
# Out:   /tmp/rsb_stage2/<name>.glb  +  /tmp/rsb_stage2/render_<name>.png
#
# RUNTIME CONTRACT (src/world/props.js) — DO NOT BREAK:
#   - root node name == asset name, origin at the old asset origin.
#   - world-space bounding box must match the shipped public/assets/<name>.glb
#     (targets baked into TARGETS below from a measured pass).
#   - every emissive surface uses a material name the art-direction pass in
#     props.js drives per-frame: light_cyan / light_amber / light_warm /
#     light_magenta / plant / crystal_mat.  Any other emissive name would blow
#     out to a white disc under bloom.
#   - non-emissive names keep whatever the shipped file already used.
#   - <= ~8 materials per asset, Y-up glTF, transforms applied, GLB only.
# ============================================================================
import bpy, bmesh, math, os, re, sys, time
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ORIG_DIR = os.path.join(REPO, "public", "assets")
OUT = "/tmp/rsb_stage2"
os.makedirs(OUT, exist_ok=True)

TAU = math.tau

# Locked-down footprint (Blender Z-up world AABB) measured from the shipped
# GLBs on 2026-09-20 — every export is re-imported and checked against these.
# (minx, miny, minz, maxx, maxy, maxz)
TARGETS = {
    "starship":      (-3.050, -4.423, -4.200, 3.263, 4.423, 43.500),
    "habitat_dome":  (-6.150, -6.150, -5.100, 8.275, 6.150, 5.152),
    "greenhouse":    (-4.600, -4.600, -3.718, 4.600, 4.600, 4.918),
    "launch_tower":  (-2.950, -3.175, 0.000, 12.500, 2.950, 49.400),
    "cryo_tank":     (-2.150, -2.096, -0.100, 3.200, 2.096, 10.100),
    "lander":        (-2.390, -2.515, -0.150, 2.850, 2.515, 5.350),
    "lamp":          (-0.350, -0.990, 0.000, 1.816, 0.990, 5.064),
    "crystal":       (-0.723, -1.026, -0.088, 1.156, 1.057, 2.600),
}
# per-asset tolerance (m): the bounding box is matched by construction — the
# extreme features (nose tip, footpads, mast head) sit on the same coordinates
# as the shipped assets; this tolerance only catches float/import jitter.
TOL = 0.10

# ------------------------------------------------------------------ argparse
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def flag(name):
    return name in ARGS
def opt(name, default=None):
    for i, a in enumerate(ARGS):
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
        if a == name and i + 1 < len(ARGS):
            return ARGS[i + 1]
    return default
ONLY = [s for s in (opt("--only") or "").split(",") if s]

bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------- utilities
def set_in(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val
        return True
    return False

def mat(name, color, rough=0.4, metal=0.0, emis=None, estr=0.0, alpha=None,
        coat=None):
    """Create (or fetch) a principled material — mirrors the hero-pass maker."""
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
    if coat is not None:
        set_in(b, "Coat Weight", coat)
    if alpha is not None:
        set_in(b, "Alpha", alpha)
        m.blend_method = 'BLEND'
        try:
            m.show_transparent_back = False
        except Exception:
            pass
    return m

# ---------------------------------------------------- palette (art direction)
# Non-emissive names are exactly those the shipped GLBs already carry, so any
# runtime code keying on material names keeps working.  Emissive members obey
# the props.js whitelist.
def _mk_palette():
    return {
        "hull":    mat("hull_white",   (0.870, 0.848, 0.812), rough=0.34),
        "hull2":   mat("hull_warm",    (0.760, 0.700, 0.610), rough=0.46),
        "steel":   mat("steel",        (0.560, 0.570, 0.600), rough=0.26, metal=1.0),
        "dark":    mat("dark_panel",   (0.070, 0.072, 0.085), rough=0.44, metal=0.80),
        "rust":    mat("rust_orange",  (0.620, 0.270, 0.110), rough=0.62),
        "red":     mat("acc_red",      (0.660, 0.110, 0.090), rough=0.48),
        "glass":   mat("glass_green",  (0.420, 0.760, 0.600), rough=0.08, alpha=0.30),
        "gold":    mat("ml_gold",      (0.850, 0.650, 0.220), rough=0.28, metal=1.0),
        "amber":   mat("light_amber",  (1.000, 0.720, 0.300), rough=0.24,
                       emis=(1.0, 0.58, 0.16), estr=4.0),
        "warm":    mat("light_warm",   (1.000, 0.900, 0.720), rough=0.28,
                       emis=(1.0, 0.78, 0.44), estr=2.6),
        "cyan":    mat("light_cyan",   (0.550, 0.920, 1.000), rough=0.20,
                       emis=(0.22, 0.82, 1.0), estr=3.2),
        "mag":     mat("light_magenta",(1.000, 0.450, 0.850), rough=0.24,
                       emis=(1.0, 0.15, 0.7), estr=4.2),
        "plant":   mat("plant",        (0.200, 0.620, 0.300), rough=0.62,
                       emis=(0.20, 0.90, 0.30), estr=1.0),
        "crystal": mat("crystal_mat",  (0.620, 0.920, 1.000), rough=0.08,
                       emis=(0.40, 0.90, 1.0), estr=2.6, alpha=0.72),
    }

P = _mk_palette()
PALETTE_NAMES = {m.name for m in P.values()}

def _strip_dup(n):
    return re.sub(r"\.\d{3}$", "", n)

# ------------------------------------------------------------ scene plumbing
def act(o):
    bpy.context.view_layer.objects.active = o
    return o

def _only(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    act(o)

def purge():
    """Full clean slate: objects + orphan datablocks (materials included),
    then rebuild the shared palette so P never holds freed StructRNA refs."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.materials, bpy.data.meshes, bpy.data.curves,
                 bpy.data.lights, bpy.data.cameras, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)
    globals()['P'] = _mk_palette()

def link(o):
    if o.name not in bpy.context.collection.objects:
        bpy.context.collection.objects.link(o)
    return o

def empty(name, loc=(0, 0, 0), par=None):
    bpy.ops.object.empty_add(location=loc)
    o = act(bpy.context.object)
    o.name = name
    parent(o, par)
    return o

def parent(c, p):
    if p is None:
        return c
    c.parent = p
    c.matrix_parent_inverse = p.matrix_world.inverted()
    return c

def smooth_angle(o, deg=38):
    _only(o)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(deg))
    except Exception:
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            o.data.shade_flat()

def bevel(o, width, segs=2, min_angle=28):
    """Angle-limited bmesh bevel — crease/boundary edges only, clamped so
    overlapping bevels simply shrink instead of exploding."""
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
        bmesh.ops.bevel(bm, geom=edges, offset=width, segments=max(segs, 1),
                        profile=0.72, affect='EDGES', clamp_overlap=True)
    bm.to_mesh(o.data)
    bm.free()

def tri_of(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

# ---------------------------------------------------------- primitive maker
def rbox(name, sx, sy, sz, loc, m, bevel_r=None, segs=2, rot=(0, 0, 0), par=None,
         smooth=38, minang=28):
    """Bevelled box — every edge that catches light gets a chamfer."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (max(sx, 1e-4), max(sy, 1e-4), max(sz, 1e-4))
    _only(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel_r is None:
        bevel_r = min(sx, sy, sz) * 0.22
    if bevel_r > 0:
        bevel(o, bevel_r, segs, minang)
        smooth_angle(o, smooth)
    o.data.materials.append(m)
    parent(o, par)
    return o

def pbox(name, sx, sy, sz, loc, m, rot=(0, 0, 0), par=None):
    """Sharp 12-tri box — seams, slats, glyphs, hazard stripes."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (max(sx, 1e-4), max(sy, 1e-4), max(sz, 1e-4))
    _only(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(m)
    parent(o, par)
    return o

def rod(name, r, d, loc, m, rot=(0, 0, 0), verts=14, br=None, segs=1, par=None,
        smooth=38):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc,
                                        rotation=rot, vertices=verts)
    o = act(bpy.context.object)
    o.name = name
    bevel(o, br if br is not None else r * 0.30, segs)
    smooth_angle(o, smooth)
    o.data.materials.append(m)
    parent(o, par)
    return o

def cone(name, r1, r2, d, loc, m, rot=(0, 0, 0), verts=14, par=None, br=0.0,
         smooth=38):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=d,
                                    location=loc, rotation=rot, vertices=verts)
    o = act(bpy.context.object)
    o.name = name
    if br > 0:
        bevel(o, br, 1)
    smooth_angle(o, smooth)
    o.data.materials.append(m)
    parent(o, par)
    return o

def ball(name, r, loc, m, segs=18, par=None, flat=False):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=segs,
                                         ring_count=max(4, segs // 2 + 2))
    o = act(bpy.context.object)
    o.name = name
    if flat:
        o.data.shade_flat()
    else:
        bpy.ops.object.shade_smooth()
    o.data.materials.append(m)
    parent(o, par)
    return o

def ring(name, R, r, loc, m, maj=32, mino=8, rot=(0, 0, 0), par=None):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc,
                                     rotation=rot, major_segments=maj,
                                     minor_segments=mino)
    o = act(bpy.context.object)
    o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(m)
    parent(o, par)
    return o

def hexn(name, r, h, loc, m, rot=(0, 0, 0), par=None):
    """Hex nut / bolt head."""
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc,
                                        rotation=rot, vertices=6)
    o = act(bpy.context.object)
    o.name = name
    bevel(o, r * 0.22, 1)
    smooth_angle(o, 35)
    o.data.materials.append(m)
    parent(o, par)
    return o

# ------------------------------------------------------------ mesh builders
def join(objs, name):
    objs = [o for o in objs if o]
    if not objs:
        return None
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    act(objs[0])
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    return o

def boolean_diff(o, cutters):
    for c in cutters:
        md = o.modifiers.new("bs", 'BOOLEAN')
        md.operation = 'DIFFERENCE'
        md.object = c
        md.solver = 'EXACT'
        _only(o)
        bpy.ops.object.modifier_apply(modifier=md.name)
        bpy.data.objects.remove(c, do_unlink=True)
    return o

def tube(name, pts, radius, m, res=1, par=None, closed=False):
    """Swept round tube through poly points — conduits, cables, guard wires."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for k, p in enumerate(pts):
        sp.points[k].co = (p[0], p[1], p[2], 1)
    sp.use_cyclic_u = closed
    cu.bevel_depth = radius
    cu.bevel_resolution = res
    cu.use_fill_caps = True
    o = bpy.data.objects.new(name, cu)
    link(o)
    o.data.materials.append(m)
    _only(o)
    bpy.ops.object.convert(target='MESH')
    o = act(bpy.context.object)
    o.name = name
    smooth_angle(o, 50)
    parent(o, par)
    return o

def spring(name, r, h, turns, wire, loc, m, rot=(0, 0, 0), par=None, ppt=10):
    """Coil spring with modelled windings — shock pistons, valve stems."""
    n = max(8, int(turns * ppt))
    pts = []
    for k in range(n + 1):
        t = k / float(n)
        a = t * turns * TAU
        pts.append((r * math.cos(a), r * math.sin(a), t * h - h / 2.0))
    o = tube(name, pts, wire, m, res=1, par=par)
    o.location = (loc[0], loc[1], loc[2])
    o.rotation_euler = rot
    _only(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    return o

def lathe(name, profile, m, loc, segs=24, rot=(0, 0, 0), par=None, smooth=45):
    """Spin a (r,z) polyline profile about Z → shell of revolution."""
    bm = bmesh.new()
    verts = [bm.verts.new((max(r, 1e-4), 0, z)) for r, z in profile]
    edges = [bm.edges.new((verts[k], verts[k + 1])) for k in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1),
                   angle=TAU, steps=segs, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o)
    o.location = loc
    o.rotation_euler = rot
    o.data.materials.append(m)
    smooth_angle(o, smooth)
    parent(o, par)
    return o

def ibeam(name, length, w, h, t, loc, m, rot=(0, 0, 0), par=None):
    """Extruded I-beam section along Y, centred — structural members."""
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, -h / 2 + t),
           (t / 2, -h / 2 + t), (t / 2, h / 2 - t), (w / 2, h / 2 - t),
           (w / 2, h / 2), (-w / 2, h / 2), (-w / 2, h / 2 - t),
           (-t / 2, h / 2 - t), (-t / 2, -h / 2 + t), (-w / 2, -h / 2 + t)]
    bm = bmesh.new()
    vs = [bm.verts.new((x, -length / 2, y)) for x, y in pts]
    f = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    up = [g for g in r['geom'] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=up, vec=(0, length, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o)
    o.location = loc
    o.rotation_euler = rot
    o.data.materials.append(m)
    smooth_angle(o, 40)
    parent(o, par)
    return o

def fluted(name, r, h, loc, m, par=None, flutes=13, depth=0.05, segs=96,
           taper=0.93):
    """Column with modelled vertical flutes (radius-modulated loft)."""
    bm = bmesh.new()
    bot = []
    top = []
    for i in range(segs):
        th = i / segs * TAU
        rr = r - depth * max(0.0, math.cos(flutes * th)) ** 0.85
        bot.append(bm.verts.new((rr * math.cos(th), rr * math.sin(th), 0)))
        top.append(bm.verts.new((rr * taper * math.cos(th), rr * taper * math.sin(th), h)))
    for i in range(segs):
        a = bot[i]; b = bot[(i + 1) % segs]
        c = top[(i + 1) % segs]; d = top[i]
        bm.faces.new((a, b, c, d))
    bm.faces.new(list(reversed(bot)))
    bm.faces.new(top)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o)
    o.location = loc
    o.data.materials.append(m)
    smooth_angle(o, 55)
    parent(o, par)
    return o

# bolt helpers --------------------------------------------------------------
def _q(axis):
    return Vector(axis).to_track_quat('Z', 'Y')

def boltring(name, center, axis, radius, n, m, br=0.022, bh=0.02, phase=0.0,
             par=None):
    """Ring of hex bolt heads around center along an axis; joined to 1 mesh."""
    objs = []
    q = _q(axis)
    eul = q.to_euler()
    for k in range(n):
        a = phase + k / n * TAU
        local = Vector((radius * math.cos(a), radius * math.sin(a), 0))
        p = Vector(center) + q @ local
        bpy.ops.mesh.primitive_cylinder_add(radius=br, depth=bh, location=p,
                                            vertices=6)
        o = bpy.context.object
        o.rotation_euler = eul
        o.data.materials.append(m)
        objs.append(o)
    j = join(objs, name)
    if j is not None and par is not None:
        parent(j, par)
    return j

def boltrow(name, p0, p1, n, m, br=0.02, bh=0.018, normal=(0, 0, 1), par=None):
    """Row of fasteners along a line (panel edges, hatch corners)."""
    objs = []
    q = _q(Vector(normal))
    eul = q.to_euler()
    for k in range(n):
        t = k / (n - 1.0) if n > 1 else 0.5
        p = Vector(p0).lerp(Vector(p1), t)
        bpy.ops.mesh.primitive_cylinder_add(radius=br, depth=bh, location=p,
                                            vertices=6)
        o = bpy.context.object
        o.rotation_euler = eul
        o.data.materials.append(m)
        objs.append(o)
    j = join(objs, name)
    if j is not None and par is not None:
        parent(j, par)
    return j

# ------------------------------------------------------- detail vocabulary
def seam(name, center, normal, u, w, m, length=None, depth=0.012, par=None):
    """Recessed panel-line strip laid on a surface — plate construction."""
    u = Vector(u).normalized()
    n = Vector(normal).normalized()
    t = n.cross(u).normalized()
    L = length if length else w
    return pbox(name, L, depth, w, center, m,
                rot=(0, 0, math.atan2(u.y, u.x)), par=par)

def hatch(name, center, normal, u, R, m_rim, m_in, m_bolt, par=None, sq=False,
          size=0.5, bolts=8):
    """Access hatch: raised rim + inset door + fastener ring. `u` = x axis."""
    u = Vector(u).normalized()
    n = Vector(normal).normalized()
    t = n.cross(u).normalized()
    q = Matrix((u, t, n)).transposed().to_4x4()
    eul = q.to_euler()
    parts = []
    if sq:
        b = rbox(name + "_rim", size * 2.3, size * 2.3, 0.05, (0, 0, 0), m_rim,
                 bevel_r=0.02, segs=1)
        i = pbox(name + "_in", size * 1.9, size * 1.9, 0.06, (0, 0, 0.015), m_in)
    else:
        parts.append(rod(name + "_rim", R * 1.25, 0.05, (0, 0, 0), m_rim,
                         verts=18, br=0.014, par=None))
        parts.append(rod(name + "_in", R, 0.07, (0, 0, 0.012), m_in, verts=18,
                         br=0.0, par=None))
    if sq:
        for p in (b, i):
            p.location = (0, 0, 0)
            parts.append(p)
    j = join(parts, name)
    j.location = center
    j.rotation_euler = eul
    _only(j)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    parent(j, par)
    # fastener ring around the hatch
    bp = Vector(center) + n * 0.045
    boltring(name + "_bolts", bp, n, R * 1.25 + 0.02 if not sq else size * 1.45,
             bolts, m_bolt, br=0.02, bh=0.016, par=par)
    # latch dog on one edge
    lp = Vector(center) + u * (R * 1.35 if not sq else size * 1.7)
    dog = pbox(name + "_latch", 0.06, 0.16, 0.05, lp + n * 0.03, m_rim,
               rot=eul, par=par)
    return j

def grille(name, center, w, h, n_slats, m_frame, m_bar, rot=(0, 0, 0), par=None):
    """Vented grille: recess + horizontal slats (join owns the rotation)."""
    parts = []
    c = tuple(center)
    parts.append(pbox(name + "_bg", w, 0.02, h, c, m_frame))
    for k in range(n_slats):
        off = -h / 2 + (k + 0.5) * h / n_slats
        parts.append(pbox(name + "_s%d" % k, w * 0.94, 0.03, h / n_slats * 0.42,
                          (c[0], c[1] + 0.012, c[2] + off), m_bar))
    j = join(parts, name)
    j.rotation_euler = rot
    parent(j, par)
    return j

def handrail(name, p0, p1, h, m, posts=5, par=None, r=0.02):
    """Top rail + mid rail + stanchions between two ground points."""
    a = Vector(p0); b = Vector(p1)
    d = (b - a).normalized()
    objs = []
    objs.append(tube(name + "_top", [a + Vector((0, 0, h)), b + Vector((0, 0, h))],
                     r, m))
    objs.append(tube(name + "_mid", [a + Vector((0, 0, h * 0.55)),
                                     b + Vector((0, 0, h * 0.55))], r * 0.75, m))
    for k in range(posts):
        t = k / (posts - 1.0)
        p = a.lerp(b, t)
        objs.append(rod(name + "_st%d" % k, r * 1.15, h, p + Vector((0, 0, h / 2)),
                        m, verts=8, br=0.006, par=None))
        objs.append(ring(name + "_foot%d" % k, r * 2.2, r * 0.9, p + Vector((0, 0, 0.012)),
                         m, maj=8, mino=4))
    j = join(objs, name)
    parent(j, par)
    return j

def ladder(name, base, h, w, m, steps=None, par=None, cage=False, dir_u=(1, 0, 0),
           normal=(0, -1, 0), rails=0.026):
    """Ship ladder: rails, steps, safety cage hoops + vertical strap."""
    base = Vector(base)
    u = Vector(dir_u).normalized()
    n = Vector(normal).normalized()
    objs = []
    for s in (-1, 1):
        off = u * (s * w / 2)
        objs.append(tube(name + "_rail%d" % s, [base + off, base + off + Vector((0, 0, h))],
                         rails, m))
    ns = steps or max(2, int(h / 0.30))
    for k in range(ns + 1):
        z = base + Vector((0, 0, k * h / ns))
        objs.append(tube(name + "_st%d" % k, [z - u * w / 2, z + u * w / 2],
                         rails * 0.8, m))
    if cage:
        for k in range(int(h / 0.75)):
            zc = 0.9 + k * 0.75
            if zc > h - 0.4:
                break
            c = base + Vector((0, 0, zc)) + n * 0.16
            objs.append(ring(name + "_cage%d" % k, w * 0.78, 0.018, c, m,
                             maj=12, mino=4, rot=(math.pi / 2, 0, math.atan2(u.y, u.x))))
        objs.append(tube(name + "_cagebar",
                         [base + Vector((0, 0, h - 0.2)) + n * 0.16,
                          base + Vector((0, 0, 0.9)) + n * 0.16], 0.02, m))
    j = join(objs, name)
    parent(j, par)
    return j

def truss_seg(name, p0, p1, chord_r, br_r, m, node_m=None, par=None, panel_diag=True):
    """One lattice bay: 4 corner legs, horizontal ring, X diagonals on all
    four faces, gusset nodes at the corners."""
    a = Vector(p0); b = Vector(p1)
    objs = []
    leg = [(a.x, a.y), (b.x, a.y), (b.x, b.y), (a.x, b.y)]
    za = a.z; zb = b.z
    for (x, y) in leg:
        objs.append(rod(name + "_leg%.2f%.2f" % (x, y), chord_r, zb - za,
                        (x, y, (za + zb) / 2), m, verts=8, br=chord_r * 0.35, par=None))
    # horizontal frame at top z
    for k in range(4):
        x1, y1 = leg[k]; x2, y2 = leg[(k + 1) % 4]
        objs.append(tube(name + "_h%d" % k,
                         [(x1, y1, zb), (x2, y2, zb)], br_r, m))
    # diagonals: X on each of the four side faces (mid-height crossing)
    zmid = (za + zb) / 2
    for k in range(4):
        x1, y1 = leg[k]; x2, y2 = leg[(k + 1) % 4]
        objs.append(tube(name + "_d1_%d" % k,
                         [(x1, y1, za), (x2, y2, zb)], br_r * 0.75, m))
        objs.append(tube(name + "_d2_%d" % k,
                         [(x2, y2, za), (x1, y1, zb)], br_r * 0.75, m))
    # bolted joint nodes on every leg corner (plates + bolt ring)
    for (x, y) in leg:
        objs.append(rod(name + "_node%.2f%.2f" % (x, y), chord_r * 1.9, 0.05,
                        (x, y, zmid), node_m or m, verts=8, br=0.008, par=None))
    j = join(objs, name)
    parent(j, par)
    return j

def hazard(name, center, u, n, length, w, m_a, m_b, stripes=6, rot=(0, 0, 0),
           par=None):
    """Chevron hazard band expressed as geometry — alternating thin plates."""
    u = Vector(u).normalized()
    strip = []
    for k in range(stripes):
        t = (k + 0.5) / stripes
        c = Vector(center) + u * (t - 0.5) * length
        col = m_a if k % 2 == 0 else m_b
        strip.append(pbox(name + "_%d" % k, length / stripes * 0.92, 0.015, w,
                          tuple(c), col))
    j = join(strip, name)
    j.rotation_euler = rot
    parent(j, par)
    return j

def pipe_run(name, pts, r, m, par=None, elbow=True):
    """Pipe with elbow fittings at every interior vertex + end flange rings."""
    t = tube(name, pts, r, m, res=1, par=par)
    objs = [t]
    if elbow:
        for k in range(1, len(pts) - 1):
            objs.append(ball(name + "_el%d" % k, r * 1.28, pts[k], m, segs=10, par=None))
    for k in (0, len(pts) - 1):
        d = Vector(pts[k]) - Vector(pts[k + 1 if k == 0 else -2])
        objs.append(ring(name + "_fl%d" % k, r * 1.25, r * 0.32, pts[k], m,
                         maj=12, mino=4, rot=_q(d.normalized()).to_euler()))
    return join(objs, name + "_asm") if len(objs) > 1 else t

def valve(name, center, axis, r, m_body, m_wheel, par=None):
    """Inline valve: body + bonnet + stem + spoked handwheel."""
    q = _q(Vector(axis))
    eul = q.to_euler()
    objs = []
    objs.append(rod(name + "_body", r * 1.5, r * 1.8, (0, 0, 0), m_body,
                    verts=10, br=r * 0.3, par=None))
    objs.append(rod(name + "_bonnet", r * 0.85, r * 1.2, (0, 0, r), m_body,
                    verts=10, br=r * 0.15, par=None))
    objs.append(rod(name + "_stem", r * 0.16, r * 1.6, (0, 0, r * 2.1), m_wheel,
                    verts=6, br=0, par=None))
    objs.append(ring(name + "_wheel", r * 0.85, r * 0.12, (0, 0, r * 2.6),
                     m_wheel, maj=14, mino=4, par=None))
    for k in range(4):
        a = k / 4 * TAU
        objs.append(tube(name + "_spoke%d" % k,
                         [(-r * 0.85 * math.cos(a), -r * 0.85 * math.sin(a), r * 2.6),
                          (r * 0.85 * math.cos(a), r * 0.85 * math.sin(a), r * 2.6)],
                         r * 0.09, m_wheel))
    j = join(objs, name)
    j.location = center
    j.rotation_euler = eul
    _only(j)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    parent(j, par)
    return j

AX = Vector((1, 0, 0)); AY = Vector((0, 1, 0)); AZ = Vector((0, 0, 1))
RX90 = (0, math.pi / 2, 0)
RY90 = (math.pi / 2, 0, 0)

# ------------------------------------------------------------------- export
def export(root, name):
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for o in root.children_recursive:
        if o.type in {'MESH', 'EMPTY'}:
            o.select_set(True)
    path = os.path.join(OUT, name + ".glb")
    rc = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                                   use_selection=True, export_yup=True,
                                   export_apply=True)
    # A cancelled exporter does NOT raise — it returns {'CANCELLED'} and leaves the
    # previous file, or nothing, on disk. Before this check the "EXPORTED" line
    # below was therefore decoration on a build that had written no asset at all
    # (audit 2026-09-26, task #95/3). Both the operator status and the file that
    # is actually on disk have to agree before anything downstream gets to print.
    size = os.path.getsize(path) if os.path.isfile(path) else -1
    if rc != {'FINISHED'} or size <= 0:
        print("SHOWCASE_EXPORT_FAILED asset=%r exporter rc=%s file=%s bytes=%d"
              % (name, sorted(rc) if isinstance(rc, (set, frozenset)) else rc,
                 path, size))
        sys.exit(1)
    tris = sum(tri_of(o) for o in root.children_recursive if o.type == 'MESH')
    print("EXPORTED %s.glb tris=%d bytes=%d" % (name, tris, size))
    return tris

# ============================================================ small helpers
def strut(name, p0, p1, r, m, verts=10, br=None, par=None):
    """Rod between two world points (rounded ends via bevel)."""
    a = Vector(p0); b = Vector(p1); d = b - a
    return rod(name, r, d.length, tuple((a + b) / 2), m,
               rot=_q(d).to_euler(), verts=verts,
               br=br if br is not None else r * 0.25, par=par)

def ellipse_pts(rz, rx, z0, th0, th1, n):
    out = []
    for k in range(n):
        t = th0 + (th1 - th0) * k / (n - 1.0)
        out.append((rx * math.cos(t), z0 + rz * math.sin(t)))
    return out

def digit(name, x, cy, cz, ch, seg, m, par=None, dx=0.05):
    """One 7-segment hull digit, raised geometry, upright on the +x face."""
    H = ch; W = ch * 0.62; t = ch * 0.17
    mapS = {'a': (0, H, W * 2, t), 'b': (W, H / 2, t, H), 'c': (W, -H / 2, t, H),
            'd': (0, -H, W * 2, t), 'e': (-W, -H / 2, t, H),
            'f': (-W, H / 2, t, H), 'g': (0, 0, W * 2, t)}
    for s in seg:
        u, v, su, sv = mapS[s]
        pbox(name + "_" + s, dx, su, sv, (x, cy + u, cz + v), m, par=par)

def digitrow(name, x, y0, z, ch, text, m, par=None, gap=2.05, dx=0.05):
    for k, c in enumerate(text):
        if c != ' ':
            digit(name + "_%d" % k, x, y0 + k * ch * gap, z, ch,
                  {'0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd',
                   '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc',
                   '8': 'abcdefg', '9': 'abcfgd', 'R': 'abgefc',
                   'S': 'afgcd'}[c], m, par=par, dx=dx)

# ###########################################################################
#  STARSHIP  — footprint lock: x[-3.05,3.263] y[-4.423,4.423] z[-4.2,43.5]
#  materials: hull_white hull_warm dark_panel steel light_amber light_cyan
#             light_magenta
# ###########################################################################
def build_starship():
    purge()
    root = empty("starship", (0, 0, 0))
    HULL = P["hull"]; H2 = P["hull2"]; DARK = P["dark"]; STEEL = P["steel"]
    AMB = P["amber"]; CYN = P["cyan"]; MAG = P["mag"]
    H = 36.0

    # ---- hull: three courses as stepped lathe with interstage constrictions
    prof = [(0.0, 1.18), (2.78, 1.18), (2.90, 1.24), (3.00, 1.34),
            (3.00, 12.55), (2.94, 12.75), (2.94, 13.25), (3.00, 13.45),
            (3.00, 23.95), (2.94, 24.15), (2.94, 24.65), (3.00, 24.85),
            (3.00, 35.60), (3.03, 35.72), (3.03, 36.00), (2.30, 36.12), (0.0, 36.12)]
    lathe("hull", prof, HULL, (0, 0, 0), segs=32, par=root, smooth=35)
    # course seam rings (max radius 3.05 = old shield radius, keeps -x extent)
    for k, zc in enumerate((1.30, 13.30, 24.70, 35.68)):
        R = 3.00 if zc < 35 else 3.03
        ring("csring_%d" % k, R, 0.05, (0, 0, zc), STEEL, maj=36, mino=6, par=root)
        boltring("csbolt_%d" % k, (0, 0, zc + 0.06), (0, 0, 1), 2.88, 14, DARK,
                 br=0.026, bh=0.02, par=root)
    # vertical panel seams + bolted longerons on every course
    for k in range(8):
        a = k / 8 * TAU
        for (z0, z1) in ((1.5, 12.4), (13.6, 23.8), (25.0, 35.4)):
            pbox("vseam_%d_%d" % (k, z0), 0.014, 0.05, z1 - z0,
                 (3.005 * math.cos(a), 3.005 * math.sin(a), (z0 + z1) / 2), DARK,
                 rot=(0, 0, a), par=root)
        hexn("seambolt_%d" % k, 0.028, 0.02,
             (3.03 * math.cos(a), 3.03 * math.sin(a), 12.42), STEEL,
             rot=(0, RX90[1], a), par=root)

    # ---- nose: faceted 12-gore cone, tip exactly at 43.5
    nose = cone("nose", 3.03, 0.0, 7.38, (0, 0, 39.81), HULL, verts=12, par=root)
    nose.data.shade_flat()
    ring("nosebase", 3.04, 0.045, (0, 0, 36.30), STEEL, maj=26, mino=6, par=root)
    for k in range(4):
        pbox("noseseam_%d" % k, 0.02, 0.05, 6.0, (0, 0, 40.1), DARK,
             rot=(math.radians(20), 0, k * math.pi / 2), par=root)
    # static dischargers on the nose shoulders
    for k in range(3):
        pbox("disch_%d" % k, 0.02, 0.02, 0.4,
             (0.42, math.sin(k * 2.1) * 1.9, 41.6), DARK, par=root)

    # ---- heat shield (dark) — bottom z=0, r 3.05
    lathe("shield", [(0.0, 0.02), (2.72, 0.0), (2.96, 0.14), (3.05, 0.42),
                     (3.05, 0.95), (2.98, 1.0), (0.0, 1.0)], DARK, (0, 0, 0),
          segs=32, par=root, smooth=35)
    for k in range(8):
        a = k / 8 * TAU + 0.39
        pbox("shieldtile_%d" % k, 0.03, 0.5, 0.5,
             (2.6 * math.cos(a), 2.6 * math.sin(a), 0.06), H2,
             rot=(0, 0, a), par=root)

    # ---- window band at z 30.6: individual frames + lenses + mullions
    fr, ln, mu = [], [], []
    for k in range(12):
        a = k / 12 * TAU
        c = (2.985 * math.cos(a), 2.985 * math.sin(a), 30.6)
        fr.append(rbox("winframe_%d" % k, 0.07, 0.40, 0.52, c, H2,
                       bevel_r=0.02, segs=1, rot=(0, 0, a)))
        ln.append(pbox("winlens_%d" % k, 0.05, 0.30, 0.42,
                       (3.02 * math.cos(a), 3.02 * math.sin(a), 30.6), AMB,
                       rot=(0, 0, a)))
        mu.append(pbox("winmul_%d" % k, 0.06, 0.035, 0.44,
                       (3.035 * math.cos(a), 3.035 * math.sin(a), 30.6), DARK,
                       rot=(0, 0, a)))
    join(fr, "window_frames"); parent(bpy.context.object, root)
    join(ln, "window_lenses"); parent(bpy.context.object, root)
    join(mu, "window_mullions"); parent(bpy.context.object, root)
    # ---- forward status bands (cyan + amber, driven by props.js)
    ring("band_cyan", 3.01, 0.045, (0, 0, 28.9), CYN, maj=36, mino=6, par=root)
    ring("band_amber", 3.01, 0.045, (0, 0, 26.4), AMB, maj=36, mino=6, par=root)
    pbox("longstrip", 0.03, 0.10, 8.6, (3.02, -1.35, 20.0), AMB, par=root)

    # ---- hull number "31" raised on +x face
    digitrow("hullnum", 3.045, -0.85, 20.0, 0.42, "31", H2, par=root, dx=0.06)

    # ---- aft fins (±y): tips exactly y=±4.423, leading-edge amber strips
    for sgn in (-1, 1):
        pts = [(2.50 * sgn, 6.60), (2.50 * sgn, 14.10), (4.423 * sgn, 12.35),
               (3.85 * sgn, 7.30)]
        bm = bmesh.new()
        vs = [bm.verts.new((0.0, y, z)) for (y, z) in pts]
        f = bm.faces.new(vs)
        r = bmesh.ops.extrude_face_region(bm, geom=[f])
        up = [g for g in r['geom'] if isinstance(g, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, verts=up, vec=(0.26, 0, 0))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new("fin_%d" % sgn)
        bm.to_mesh(me); bm.free()
        fin = bpy.data.objects.new("fin_%d" % sgn, me); link(fin)
        bevel(fin, 0.035, 1)
        smooth_angle(fin, 40)
        fin.data.materials.append(H2)
        parent(fin, root)
        # leading edge heat strip
        ang = math.atan2(12.35 - 14.10, 4.423 - 2.50)
        pbox("fin_edge_%d" % sgn, 0.05, 2.29, 0.16,
             (0.11, 3.43 * sgn, 13.26), AMB,
             rot=(ang if sgn > 0 else -math.pi - ang, 0, 0), par=root)
        # hinge root bolts + gussets
        for zz in (7.6, 10.4, 13.0):
            hexn("finbolt_%d_%d" % (sgn, zz), 0.035, 0.02,
                 (0.13, 2.56 * sgn, zz), DARK, rot=(0, RX90[1], 0), par=root)
        ibeam("fingus_%d" % sgn, 1.9, 0.24, 0.10, 0.03, (0.14, 3.1 * sgn, 6.75),
              STEEL, rot=(math.radians(-32 * sgn), 0, 0), par=root)
    # ---- canard flaps (3, like the old aft flaps) at 0/120/240
    for k in range(3):
        a = k * TAU / 3
        bpy.ops.mesh.primitive_cube_add(
            size=1, rotation=(0, math.radians(14), a),
            location=(2.92 * math.cos(a), 2.92 * math.sin(a), 32.6))
        c = act(bpy.context.object); c.name = "canard_%d" % k
        c.scale = (0.52, 0.09, 1.5)
        _only(c)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bevel(c, 0.04, 1); smooth_angle(c, 40)
        c.data.materials.append(H2); parent(c, root)
        boltring("canardbolt_%d" % k, (3.02 * math.cos(a), 3.02 * math.sin(a), 32.6),
                 (math.cos(a), math.sin(a), 0), 0.55, 6, DARK, br=0.02, bh=0.016,
                 par=root)

    # ---- engines: center bell to z=-4.2 + regenerative cooling rings
    bell = [(0.62, 0.10), (0.70, -0.10), (0.95, -1.05), (1.42, -2.30),
            (2.10, -3.60), (2.62, -4.18), (2.70, -4.20), (2.56, -4.20),
            (2.02, -3.52), (1.34, -2.22), (0.88, -1.00), (0.66, -0.35),
            (0.50, -0.30), (0.44, 0.10)]
    lathe("engine_c", bell, DARK, (0, 0, 0), segs=22, par=root, smooth=40)
    ball("engine_glow", 0.55, (0, 0, -0.95), MAG, segs=12, par=root)
    for k, (R, zc) in enumerate([(1.18, -1.6), (1.72, -2.7), (2.24, -3.66)]):
        ring("coolring_%d" % k, R, 0.065, (0, 0, zc), STEEL, maj=20, mino=6, par=root)
    ring("manifold", 1.5, 0.11, (0, 0, -0.30), STEEL, maj=24, mino=6, par=root)
    for k in range(8):
        a = k / 8 * TAU + 0.2
        strut("feedpipe_%d" % k, (1.42 * math.cos(a), 1.42 * math.sin(a), -0.32),
              (1.02 * math.cos(a), 1.02 * math.sin(a), 0.16), 0.045, STEEL,
              verts=6, br=0.012, par=root)
    # 4 outboard gimballed bells on the aft skirt
    for k in range(4):
        a = k * TAU / 4 + math.pi / 4
        px, py = 1.62 * math.cos(a), 1.62 * math.sin(a)
        tilt = (math.radians(10) * math.sin(a), -math.radians(10) * math.cos(a))
        b = cone("engine_o%d" % k, 0.34, 0.78, 1.75, (px, py, -0.85), DARK,
                 verts=14, br=0.02, par=root)
        b.rotation_euler = (tilt[0], tilt[1], 0)
        ring("o_gimbal%d" % k, 0.42, 0.06, (px, py, 0.06), STEEL, maj=12, mino=5, par=root)
        for j in (0, 1):
            strut("o_act%d_%d" % (k, j), (px + 0.5 * math.cos(a + j * 2.2),
                   py + 0.5 * math.sin(a + j * 2.2), 0.10),
                  (px + 0.24 * math.cos(a + j * 2.2), py + 0.24 * math.sin(a + j * 2.2), -0.5),
                  0.035, STEEL, verts=6, br=0.01, par=root)
        ring("o_cool%d" % k, 0.62, 0.045, (px, py, -1.55), STEEL, maj=12, mino=5, par=root)
    # aft skirt + TVC hardware
    lathe("skirt", [(2.94, 0.0), (3.05, 0.0), (3.05, 1.2), (2.94, 1.2)], H2,
          (0, 0, 0), segs=32, par=root)

    # ---- landing legs x4: hinge, primary, shock sleeve + coil, footpads
    for k, adeg in enumerate((55, 125, 235, 305)):
        a = math.radians(adeg)
        ca, sa = math.cos(a), math.sin(a)
        A = (2.92 * ca, 2.92 * sa, 7.3)     # hull hinge
        B = (2.52 * ca, 2.52 * sa, 3.0)     # knee
        C = (2.42 * ca, 2.42 * sa, 0.45)    # ankle
        # hinge boss on hull + bolts
        rod("legboss_%d" % k, 0.19, 0.42, (2.82 * ca, 2.82 * sa, 7.3), STEEL,
            rot=(0, RX90[1], a), verts=12, br=0.02, par=root)
        boltring("legbossbolt_%d" % k, (2.6 * ca, 2.6 * sa, 7.3), (0, 0, 1), 0.16, 4,
                 DARK, br=0.022, bh=0.016, par=root)
        strut("leg_up%d" % k, A, B, 0.135, STEEL, verts=12, br=0.03, par=root)
        strut("leg_lo%d" % k, B, (2.42 * ca, 2.42 * sa, 0.34), 0.11, STEEL,
              verts=12, br=0.025, par=root)
        # knee gussets
        ibeam("legknee_%d" % k, 0.5, 0.20, 0.10, 0.028, (B[0] * 1.03, B[1] * 1.03, B[2]),
              H2, rot=(0, 0, a), par=root)
        # shock absorber: body on upper, piston to lower, coil spring
        D0 = (3.0 * ca, 3.0 * sa, 5.1)
        D1 = (2.62 * ca, 2.62 * sa, 2.15)
        strut("shockbody_%d" % k, D0, tuple(Vector(D0).lerp(Vector(D1), 0.45)),
              0.085, H2, verts=10, br=0.018, par=root)
        strut("shockrod_%d" % k, tuple(Vector(D0).lerp(Vector(D1), 0.35)), D1,
              0.045, STEEL, verts=8, br=0.0, par=root)
        dv = Vector(D1) - Vector(D0)
        spring("shockspring_%d" % k, 0.075, dv.length * 0.36, 6, 0.014,
               tuple(Vector(D0) + dv * 0.55), P["amber"],
               rot=_q(dv).to_euler(), par=root, ppt=8)
        # footpad (wide dish down, hinge nut up)
        pad = cone("footpad_%d" % k, 0.5, 0.2, 0.3, (2.42 * ca, 2.42 * sa, 0.17),
                   STEEL, verts=12, br=0.02, par=root)
        ring("footring_%d" % k, 0.5, 0.05, (2.42 * ca, 2.42 * sa, 0.05), DARK,
             maj=14, mino=6, par=root)
        for j in range(6):
            aa = j / 6 * TAU
            pbox("footrib_%d_%d" % (k, j), 0.05, 0.44, 0.05,
                 (2.42 * ca + 0.24 * math.cos(aa) * -sa,
                  2.42 * sa + 0.24 * math.cos(aa) * ca, 0.34), STEEL,
                 rot=(0, 0, aa + a), par=root)
        hexn("footnut_%d" % k, 0.06, 0.05, (2.42 * ca, 2.42 * sa, 0.4), DARK, par=root)

    # ---- boarding gantry on +x (reaches x=3.25): door, platform, stairs
    door_c = Vector((2.96, 0.0, 6.4))
    hatch("boarding_door", door_c, (1, 0, 0), (0, 1, 0), 0.62, STEEL, DARK, STEEL,
          par=root, sq=False, bolts=12)
    # platform: deck + grating slats + kickplate + rail
    plat = rbox("gantry_deck", 0.92, 1.85, 0.06, (2.78, 0.0, 4.62), STEEL,
                bevel_r=0.02, segs=1, par=root)
    for j in range(7):
        pbox("gantry_slat_%d" % j, 0.86, 0.06, 0.05, (2.78, -0.78 + j * 0.26, 4.68),
             DARK, par=root)
    for sy in (-1, 1):
        pbox("gantry_kick_%d" % sy, 0.9, 0.04, 0.14, (2.78, sy * 0.92, 4.72), STEEL,
             par=root)
    handrail("gantry_rail", (3.15, -0.9, 4.68), (3.15, 0.9, 4.68), 1.0, STEEL,
             posts=3, par=root, r=0.028)
    handrail("gantry_rail2", (3.15, 0.9, 4.68), (2.38, 0.9, 4.68), 1.0, STEEL,
             posts=3, par=root, r=0.028)
    handrail("gantry_rail3", (3.15, -0.9, 4.68), (2.38, -0.9, 4.68), 1.0, STEEL,
             posts=3, par=root, r=0.028)
    for sy in (-1, 1):
        strut("gantry_stay_%d" % sy, (3.18, sy * 0.85, 4.66), (2.9, sy * 0.7, 2.7),
              0.05, STEEL, verts=8, br=0.012, par=root)
        boltrow("gantry_bolt_%d" % sy, (2.9, sy * 0.82, 4.55), (2.6, sy * 0.82, 4.55),
                4, DARK, br=0.018, bh=0.014, normal=(0, sy, 0), par=root)
    # fold-down stair: stringers + steps + rails, descending aft-down
    st0 = Vector((3.06, -0.5, 4.6)); st1 = Vector((3.02, -0.5, 1.55))
    en0 = Vector((3.06, 0.5, 4.6));  en1 = Vector((3.02, 0.5, 1.55))
    tube("stair_string_l", [st0, st1], 0.05, STEEL, par=root)
    tube("stair_string_r", [en0, en1], 0.05, STEEL, par=root)
    nst = 8
    for j in range(nst):
        t = j / (nst - 1.0)
        p = Vector(st0).lerp(st1, t)
        pbox("stair_step_%d" % j, 0.3, 1.0, 0.035, (p.x, 0, p.z - 0.05), STEEL,
             par=root)
        if j % 2 == 0:
            hexn("stair_bolt_%d" % j, 0.02, 0.015, (p.x + 0.16, 0.44, p.z - 0.05),
                 DARK, rot=(RX90[0], 0, 0), par=root)
    tube("stair_rail_l", [st0 + Vector((0, 0, 0.95)), st1 + Vector((0, 0, 0.95))],
         0.025, STEEL, par=root)
    tube("stair_rail_r", [en0 + Vector((0, 0, 0.95)), en1 + Vector((0, 0, 0.95))],
         0.025, STEEL, par=root)
    for j in range(3):
        t = j / 2.0
        p = Vector(st0).lerp(st1, t)
        rod("stair_post_%d" % j, 0.02, 0.95, (p.x, -0.5, p.z + 0.42), STEEL,
            verts=6, br=0, par=root)
        p2 = Vector(en0).lerp(en1, t)
        rod("stair_post2_%d" % j, 0.02, 0.95, (p2.x, 0.5, p2.z + 0.42), STEEL,
            verts=6, br=0, par=root)
    # gantry worklight (cyan — driven per-frame by props.js)
    rbox("gantry_light", 0.1, 0.28, 0.1, (2.98, 0.0, 7.35), CYN, bevel_r=0.02,
         segs=1, par=root)

    # ---- services: umbilical conduit up the -x side + junction boxes
    pts = [(-2.98, 0.9, 1.4)]
    for j in range(1, 12):
        t = j / 11.0
        zz = 1.4 + t * 22.0
        pts.append((-2.99, 0.9 + 0.05 * math.sin(t * 20), zz))
    tube("umbilical", pts, 0.075, DARK, par=root)
    for j in range(6):
        zz = 2.6 + j * 3.9
        pbox("clip_%d" % j, 0.05, 0.14, 0.1, (-3.0, 0.9, zz), STEEL, par=root)
        hexn("clipbolt_%d" % j, 0.022, 0.02, (-3.03, 0.9, zz), STEEL,
             rot=(0, RX90[1], 0), par=root)
    rbox("jbox_low", 0.16, 0.5, 0.62, (-2.96, -0.75, 3.2), H2, bevel_r=0.03, segs=1,
         par=root)
    boltrow("jboxbolt_a", (-2.98, -0.98, 3.45), (-2.98, -0.52, 3.45), 4, DARK,
            br=0.018, bh=0.014, normal=(-1, 0, 0), par=root)
    boltrow("jboxbolt_b", (-2.98, -0.98, 2.95), (-2.98, -0.52, 2.95), 4, DARK,
            br=0.018, bh=0.014, normal=(-1, 0, 0), par=root)
    tube("umb2", [(-2.9, -0.75, 2.9), (-2.85, -1.4, 2.6), (-2.7, -1.8, 2.3)],
         0.045, DARK, par=root)
    # antenna whips + beacon
    for k, (ax, ay) in enumerate([(2.1, 1.6), (-1.7, -2.0)]):
        rr = 3.02
        ang = math.atan2(ay, ax)
        rod("whipsock_%d" % k, 0.05, 0.14, (rr * 0.98 * math.cos(ang),
            rr * 0.98 * math.sin(ang), 33.6), DARK, verts=8, br=0.01, par=root)
        strut("whip_%d" % k, (rr * math.cos(ang), rr * math.sin(ang), 33.7),
              (rr * 1.12 * math.cos(ang), rr * 1.12 * math.sin(ang), 35.0),
              0.018, STEEL, verts=6, br=0, par=root)
        ball("whiptip_%d" % k, 0.035, (rr * 1.13 * math.cos(ang),
              rr * 1.13 * math.sin(ang), 35.05), CYN, segs=8, par=root)
    ball("nose_beacon", 0.075, (0.35, 0, 42.4), MAG, segs=8, par=root)
    return root

# ###########################################################################
#  HABITAT DOME — footprint lock: x[-6.15,8.275] y[-6.15,6.15] z[-5.1,5.152]
#  materials: hull_white hull_warm steel dark_panel light_amber light_cyan
# ###########################################################################
def build_habitat_dome():
    purge()
    root = empty("habitat_dome", (0, 0, 0))
    HULL = P["hull"]; H2 = P["hull2"]; STEEL = P["steel"]; DARK = P["dark"]
    AMB = P["amber"]; CYN = P["cyan"]
    RX, RZ = 6.0, 5.1                      # full ellipsoid shell, bottom buried

    # ---- shell: lathed full ellipsoid (top ~5.1, bottom -5.1 buried)
    prof = [(0.02, -RZ)]
    for i in range(15):
        t = -math.pi / 2 + 0.06 + i * (math.pi - 0.36) / 14.0
        prof.append((RX * math.cos(t), RZ * math.sin(t)))
    prof += [(2.35, 4.62), (1.55, 4.70), (1.32, 4.92), (0.02, 5.06)]
    lathe("shell", prof, HULL, (0, 0, 0), segs=36, par=root, smooth=35)

    # ---- base skirt: the -x/-y extreme radius 6.15, bolted deck ring
    rod("skirt", 6.15, 0.9, (0, 0, -0.35), H2, verts=36, br=0.05, par=root)
    ring("deckring", 6.05, 0.05, (0, 0, 0.10), STEEL, maj=36, mino=6, par=root)
    for k in range(18):
        a = k / 18 * TAU
        hexn("skirtbolt_%d" % k, 0.045, 0.03, (6.05 * math.cos(a), 6.05 * math.sin(a), 0.16),
             DARK, par=root)
    # ground anchor collar (hides skirt/terrain junction from all sides)
    lathe("collar", [(6.12, -0.8), (6.05, -0.55), (6.05, -0.1), (5.82, -0.12),
                     (5.82, -0.8)], DARK, (0, 0, 0), segs=28, par=root)

    # ---- mullion grid: 8 meridional ribs + 3 latitude rings + bolts
    ribs = []
    for k in range(8):
        phi = k / 8 * TAU
        pts = []
        for t in range(13):
            th = -0.12 + t / 12.0 * (math.pi / 2 + 0.12)
            pts.append(((RX + 0.015) * math.cos(th) * math.cos(phi),
                        (RX + 0.015) * math.cos(th) * math.sin(phi),
                        (RZ + 0.015) * math.sin(th)))
        ribs.append(tube("rib_%d" % k, pts, 0.06, STEEL))
    join(ribs, "mullion_ribs"); parent(bpy.context.object, root)
    for k, zc in enumerate((1.15, 3.35, 4.42)):
        rr = RX * math.sqrt(max(0.0, 1 - (zc / RZ) ** 2)) + 0.05
        ring("latring_%d" % k, rr, 0.055, (0, 0, zc), STEEL, maj=30, mino=6, par=root)
    # rib/ring intersection bolts
    for k in range(8):
        phi = k / 8 * TAU
        for zc in (1.15, 3.35):
            rr = RX * math.sqrt(1 - (zc / RZ) ** 2) + 0.11
            hexn("mullbolt_%d_%d" % (k, zc), 0.03, 0.03,
                 (rr * math.cos(phi), rr * math.sin(phi), zc), DARK,
                 rot=_q(Vector((math.cos(phi) * math.cos(zc / RZ), math.sin(phi) * math.cos(zc / RZ), math.sin(zc / RZ)))).to_euler(),
                 par=root)

    # ---- warm window strips (light_amber) + mullion posts between them
    for k, zc in enumerate((2.0, 2.42)):
        rr = RX * math.sqrt(1 - (zc / RZ) ** 2) + 0.02
        b = ring("winband_%d" % k, rr, 0.085, (0, 0, zc), AMB, maj=34, mino=6, par=root)
        b.scale = (1, 1, 0.52)
        _only(b); bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    posts = []
    for k in range(14):
        a = k / 14 * TAU + 0.11
        zc = 2.21
        rr = RX * math.sqrt(1 - (zc / RZ) ** 2) + 0.06
        posts.append(pbox("winpost_%d" % k, 0.05, 0.05, 0.5,
                          (rr * math.cos(a), rr * math.sin(a), zc), DARK,
                          rot=(0, 0, a)))
    join(posts, "window_posts"); parent(bpy.context.object, root)
    # the airlock-facing strip window glows all around the drum junction
    ring("drum_glow", 1.32, 0.05, (5.4, 0, 2.62), AMB, maj=12, mino=5,
         rot=(0, RX90[1], 0), par=root)

    # ---- cupola + cyan beacon ring (top of everything, 4.99+0.16≈5.152)
    rod("cupola", 1.28, 0.34, (0, 0, 4.78), H2, verts=18, br=0.03, par=root)
    boltring("cupola_bolts", (0, 0, 4.96), (0, 0, 1), 1.18, 10, DARK, br=0.026,
             bh=0.018, par=root)
    ring("toplight", 1.24, 0.16, (0, 0, 4.99), CYN, maj=16, mino=6, par=root)
    ball("cupola_lenseed", 0.15, (0, 0, 4.9), DARK, segs=10, par=root)

    # ---- airlock drum to +x: shell 3.0→7.8, flange, door, wheel, hinges
    rod("drum", 1.45, 4.8, (5.4, 0, 1.3), HULL, rot=RX90, verts=18, br=0.04, par=root)
    for k, xd in enumerate((4.3, 5.7, 7.0)):
        ring("drumrib_%d" % k, 1.48, 0.07, (xd, 0, 1.3), STEEL, maj=18, mino=6,
             rot=(0, RX90[1], 0), par=root)
    rod("flange", 1.62, 0.16, (7.72, 0, 1.3), STEEL, rot=RX90, verts=20, br=0.02, par=root)
    boltring("flangebolts", (7.82, 0, 1.3), (1, 0, 0), 1.5, 12, DARK, br=0.035,
             bh=0.03, par=root)
    rod("door", 1.28, 0.18, (7.95, 0, 1.3), H2, rot=RX90, verts=18, br=0.02, par=root)
    rod("doorface", 1.06, 0.05, (8.06, 0, 1.3), DARK, rot=RX90, verts=16, br=0, par=root)
    # porthole + wheel + latch on the door (x max ≈ 8.27 with knob)
    ring("doorport", 0.42, 0.07, (8.09, 0, 1.62), STEEL, maj=12, mino=5,
         rot=(0, RX90[1], 0), par=root)
    rod("doorportglass", 0.36, 0.04, (8.09, 0, 1.62), AMB, rot=RX90, verts=12,
        br=0, par=root)
    ring("doorwheel", 0.34, 0.05, (8.12, 0, 0.95), STEEL, maj=14, mino=5,
         rot=(0, RX90[1], 0), par=root)
    for j in range(4):
        aa = j / 4 * math.pi + 0.4
        strut("wheelspoke_%d" % j, (8.10, 0.34 * math.cos(aa) * -1 + 0.0, 0.95 + 0.34 * math.sin(aa)),
              (8.10, 0, 0.95), 0.028, STEEL, verts=6, br=0, par=root)
    rod("wheelhub", 0.09, 0.1, (8.13, 0, 0.95), DARK, rot=RX90, verts=8, br=0, par=root)
    ball("doorlatch", 0.075, (8.19, 0.9, 1.3), DARK, segs=8, par=root)
    strut("latchbar", (8.06, 0.9, 1.3), (8.06, 0.55, 1.3), 0.03, STEEL, verts=6,
          br=0, par=root)
    for sy in (-1, 1):
        rod("hinge_%d" % sy, 0.09, 0.34, (7.98, sy * 1.15, 1.3), STEEL, verts=8,
            br=0.012, par=root)
        hexn("hingebolt_%d" % sy, 0.03, 0.03, (8.08, sy * 1.15, 1.3), DARK,
             rot=RX90, par=root)
    # drum saddle supports + conduit down the drum
    for xd in (4.6, 6.6):
        rbox("drumsaddle_%d" % xd, 0.4, 1.3, 1.3, (xd, 0, 0.42), STEEL,
             bevel_r=0.05, segs=1, par=root)
        pbox("saddlegus_%d" % xd, 0.5, 0.06, 1.2, (xd, 0.68, 0.45), DARK, par=root)
        boltrow("saddlebolt_%d" % xd, (xd - 0.15, -0.6, 0.86), (xd + 0.15, -0.6, 0.86),
                3, DARK, br=0.02, bh=0.015, par=root)
    tube("drum_conduit", [(4.2, -1.35, 1.2), (4.2, -2.2, 0.9), (4.3, -2.9, 0.35),
                          (4.6, -3.4, -0.1)], 0.07, DARK, par=root)
    rbox("drum_jbox", 0.4, 0.3, 0.26, (4.2, -2.6, 0.75), STEEL, bevel_r=0.03,
         segs=1, rot=(0, 0, 0.6), par=root)
    # approach floodlights flanking the door (light_amber)
    for sy in (-1, 1):
        rbox("doorlamp_%d" % sy, 0.14, 0.2, 0.2, (7.55, sy * 1.5, 2.2), AMB,
             bevel_r=0.03, segs=1, rot=(0, 0, sy * 0.3), par=root)
        pbox("doorlampshade_%d" % sy, 0.16, 0.26, 0.06, (7.6, sy * 1.5, 2.34), DARK,
             par=root)

    # ---- sunshade canopy on struts (faceted 10-gore umbrella at z 3.9)
    can = cone("canopy", 5.32, 1.15, 0.8, (0, 0, 3.95), H2, verts=10, par=root)
    can.data.shade_flat()
    ring("canopyrim", 5.32, 0.07, (0, 0, 3.58), STEEL, maj=20, mino=5, par=root)
    rod("canopycap", 1.16, 0.12, (0, 0, 4.36), H2, verts=10, br=0.02, par=root)
    for k in range(6):
        a = k / 6 * TAU + 0.52
        strut("canopystrut_%d" % k, (4.35 * math.cos(a), 4.35 * math.sin(a), 3.05),
              (5.2 * math.cos(a), 5.2 * math.sin(a), 3.62), 0.06, STEEL,
              verts=8, br=0.014, par=root)
        hexn("canopyfoot_%d" % k, 0.05, 0.04, (4.4 * math.cos(a), 4.4 * math.sin(a), 3.08),
             DARK, rot=_q(Vector((math.cos(a) * 0.62, math.sin(a) * 0.62, 0.78))).to_euler(),
             par=root)
    # tension cables from canopy rim to cupola (whitespace detail)
    for k in range(4):
        a = k / 4 * TAU + 0.3
        tube("canopycable_%d" % k, [(5.3 * math.cos(a), 5.3 * math.sin(a), 3.60),
                                    (1.2 * math.cos(a) * 0.8, 1.2 * math.sin(a) * 0.8, 4.95)],
             0.015, DARK, par=root)

    # ---- vent cowls on the dome slope (two opposite, radial)
    for k, (az, zc) in enumerate([(math.radians(155), 3.7), (math.radians(245), 3.2)]):
        rr = RX * math.sqrt(max(0.0, 1 - (zc / RZ) ** 2))
        nrm = Vector((math.cos(az) * (rr / RX), math.sin(az) * (rr / RX), (zc / RZ)))
        base = nrm.normalized() * (rr + 0.15)
        eul = _q((zc / RZ * Vector((math.cos(az), math.sin(az), 0)) +
                  Vector((0, 0, 1)) * (rr / RX))).normalized().to_euler()
        rod("ventpipe_%d" % k, 0.26, 0.75, tuple(base + Vector((0, 0, 0.3))), STEEL,
            rot=eul, verts=12, br=0.02, par=root)
        cone("ventcap_%d" % k, 0.24, 0.4, 0.3, tuple(base + Vector((0, 0, 0.82))), H2,
             rot=eul, verts=12, br=0.02, par=root)
        boltring("ventflange_%d" % k, tuple(base), (nrm.x, nrm.y, nrm.z), 0.3, 6,
                 DARK, br=0.024, bh=0.018, par=root)
        for j in range(3):
            pbox("ventlouver_%d_%d" % (k, j), 0.4, 0.03, 0.07,
                 tuple(base + Vector((0, 0, 0.12 + j * 0.11))), DARK, rot=eul, par=root)

    # ---- perimeter handrail on the deck ring + access ladder at -y
    posts = []
    for k in range(16):
        a = k / 16 * TAU
        if abs(a - 3 * math.pi / 2) < 0.45:
            continue
        posts.append(rod("railpost_%d" % k, 0.03, 0.85,
                         (6.02 * math.cos(a), 6.02 * math.sin(a), 0.62), STEEL,
                         verts=6, br=0, par=root))
    ring("railtop", 6.02, 0.035, (0, 0, 1.05), STEEL, maj=28, mino=5, par=root)
    ring("railmid", 6.02, 0.022, (0, 0, 0.72), STEEL, maj=28, mino=4, par=root)
    ladder("dome_ladder", (0, -6.02, 0.05), 5.0, 0.42, STEEL, steps=11, par=root,
           dir_u=(1, 0, 0), normal=(0, -1, 0))
    # step-off platform at ladder top
    rbox("ladder_platform", 0.8, 0.5, 0.05, (0, -5.75, 5.05), STEEL, bevel_r=0.015,
         segs=1, par=root)
    return root

# --------------------------------------------------------------- driver bits
EXPECTED_MATS = {
    "starship": {"hull_white", "hull_warm", "dark_panel", "steel", "light_amber",
                 "light_cyan", "light_magenta"},
    "habitat_dome": {"hull_white", "hull_warm", "steel", "dark_panel",
                     "light_amber", "light_cyan"},
}
EMISSIVE_OK = {"light_cyan", "light_amber", "light_warm", "light_magenta",
               "plant", "crystal_mat", "pad_glow"}

def verify(name):
    path = os.path.join(OUT, name + ".glb")
    purge()
    bpy.ops.import_scene.gltf(filepath=path)
    mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
    tris = 0; mats = set(); roots = []
    for o in bpy.data.objects:
        if o.parent is None:
            roots.append(o.name)
        if o.type == 'MESH':
            mw = o.matrix_world
            for c in o.bound_box:
                w = mw @ Vector(c)
                mn = Vector((min(mn.x, w.x), min(mn.y, w.y), min(mn.z, w.z)))
                mx = Vector((max(mx.x, w.x), max(mx.y, w.y), max(mx.z, w.z)))
            tris += tri_of(o)
            for s in o.material_slots:
                if s.material:
                    mats.add(_strip_dup(s.material.name))
    t = TARGETS[name]
    got = (round(mn.x, 3), round(mn.y, 3), round(mn.z, 3),
           round(mx.x, 3), round(mx.y, 3), round(mx.z, 3))
    drift = max(abs(got[0] - t[0]), abs(got[1] - t[1]), abs(got[2] - t[2]),
                abs(got[3] - t[3]), abs(got[4] - t[4]), abs(got[5] - t[5]))
    bad_emis = {m for m in mats if m.startswith(("light_", "pad_glow", "plant", "crystal_mat"))
                and m not in EMISSIVE_OK}
    ok = (roots == [name] and drift <= TOL and not bad_emis and
          len(mats) <= 8 and (name not in EXPECTED_MATS or mats == EXPECTED_MATS[name]))
    print("VERIFY %s.glb root=%s tris=%d bytes=%d mats=%d %s drift=%.3f %s" %
          (name, roots, tris, os.path.getsize(path), len(mats), sorted(mats),
           drift, got))
    print("VERIFY %s => %s%s" % (name, "OK" if ok else "DRIFT",
          (" bad_emissives=" + str(bad_emis)) if bad_emis else ""))
    # `ok` is returned, not asserted here: main is what decides the exit code, so
    # one run can still report every asset that drifted instead of stopping at the
    # first. Before this the "VERIFY x => DRIFT" line was a printout that the
    # process then walked past into BASE_DONE with rc=0 (task #95/3).
    return got, mn, mx, ok

def setup_render_world():
    w = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.42, 0.42, 0.44, 1)   # neutral mid-grey
    bg.inputs[1].default_value = 1.0
    ld = bpy.data.lights.new("sun", 'SUN')
    ld.energy = 4.0
    ld.angle = math.radians(3)
    lo = bpy.data.objects.new("sun", ld)
    link(lo)
    lo.rotation_euler = (math.radians(52), math.radians(-14), math.radians(38))
    ld2 = bpy.data.lights.new("fill", 'SUN')
    ld2.energy = 1.1
    lo2 = bpy.data.objects.new("fill", ld2)
    link(lo2)
    lo2.rotation_euler = (math.radians(64), 0, math.radians(-128))

def render_asset(name, mn, mx):
    scene = bpy.context.scene
    ctr = (Vector(mn) + Vector(mx)) / 2
    diag = (Vector(mx) - Vector(mn)).length
    # grounding plane at the model's lowest point
    bpy.ops.mesh.primitive_plane_add(size=max(60.0, diag * 3.0),
                                     location=(ctr.x, ctr.y, mn.z + 0.005))
    pl = act(bpy.context.object)
    pm = mat("__render_floor", (0.26, 0.26, 0.27), rough=0.95)
    pl.data.materials.append(pm)
    pl.name = "render_floor"
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50.0
    cam_data.sensor_width = 36.0
    cam = bpy.data.objects.new("cam", cam_data)
    link(cam)
    fov = 2 * math.atan(cam_data.sensor_width / 2 / cam_data.lens)
    dist = (diag * 0.62) / math.tan(fov / 2)
    # 3/4 hero angle, slightly above centre
    d = Vector((0.78, -1.05, 0.42)).normalized()
    if name in ("launch_tower", "starship"):
        d = Vector((0.85, -1.0, 0.30)).normalized()
    cam.location = ctr + d * dist
    tq = bpy.data.objects.new("camtarget", None)
    link(tq)
    tq.location = ctr
    c = cam.constraints.new('TRACK_TO')
    c.target = tq
    c.track_axis = 'TRACK_NEGATIVE_Z'
    c.up_axis = 'UP_Y'
    scene.camera = cam
    scene.render.engine = 'BLENDER_EEVEE'
    try:
        scene.eevee.taa_render_samples = 16
        scene.eevee.use_raytracing = True
    except Exception:
        pass
    try:
        scene.view_settings.view_transform = 'Standard'
    except Exception:
        pass
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = os.path.join(OUT, "render_%s.png" % name)
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print("RENDERED render_%s.png (%.1fs)" % (name, time.time() - t0))

BUILDERS = {
    "starship": build_starship,
    "habitat_dome": build_habitat_dome,
}
ORDER = ["starship", "habitat_dome", "greenhouse", "launch_tower", "cryo_tank",
         "lander", "lamp", "crystal"]

if __name__ == "__main__":
    # Exit-code contract (audit 2026-09-26, task #95/3): this script used to
    # die with `KeyError: greenhouse` after exporting 2 of 8 assets and still
    # leave blender at rc=0 — blender --background does NOT propagate an
    # uncaught script exception into the exit code (measured on 5.2 LTS), while
    # SystemExit does. So every stage here reports into one of the named
    # SHOWCASE_* lines below, and BASE_DONE only prints when the run is clean:
    #   SHOWCASE_ABORT          requested asset has no builder (nothing built)
    #   SHOWCASE_EXPORT_FAILED  the gltf operator cancelled or wrote no asset
    #   SHOWCASE_VERIFY_FAILED  the re-imported GLB misses TARGETS / material bar
    #   SHOWCASE_FAILED         a stage raised — the asset is not counted as built
    # A crash stops that one asset, not the run: the remaining assets still get
    # their readings, and the process leaves rc=1 naming everything that is undone.
    import traceback
    # `--only greenhousee` used to cost nothing: ORDER is the filter's left-hand side, so a name
    # that is not in it was dropped by the comprehension and the run built an empty batch and
    # printed `BASE_DONE 0/0 []` at rc=0 (measured 2026-09-26, task #95). A requested asset this
    # script cannot build is a refusal, the same way v2 refuses an unknown CLI name.
    outside = [n for n in ONLY if n not in ORDER]
    if outside:
        print("SHOWCASE_ABORT --only names assets this script does not order: %s (ORDER: %s)"
              % (outside, ORDER))
        sys.exit(1)
    expected = [n for n in ORDER if not ONLY or n in ONLY]
    missing = [n for n in expected if n not in BUILDERS]
    if missing:
        print("SHOWCASE_ABORT expected assets have no builder: %s (builders: %s)"
              % (missing, sorted(BUILDERS)))
        sys.exit(1)
    total_tris = 0
    done = []
    crashed = []
    drifted = []
    for name in expected:
        t0 = time.time()
        ok = False
        try:
            root = BUILDERS[name]()
            export(root, name)
            got, mn, mx, ok = verify(name)
            if not flag("--no-render"):
                setup_render_world()
                render_asset(name, mn, mx)
        except SystemExit:
            raise
        except BaseException:
            traceback.print_exc()
            print("SHOWCASE_FAILED asset=%r stage raised — not counted as built" % name)
            crashed.append(name)
            purge()          # the failed build may have left half a scene behind
            continue
        done.append((name, time.time() - t0))
        if not ok:
            print("SHOWCASE_VERIFY_FAILED asset=%r — see the VERIFY lines above "
                  "for which bar it missed" % name)
            drifted.append(name)
    # Reconcile: every expected asset must have a non-empty GLB actually on disk.
    nofile = [n for n in expected
              if not (os.path.isfile(os.path.join(OUT, n + ".glb"))
                      and os.path.getsize(os.path.join(OUT, n + ".glb")) > 0)]
    if crashed or drifted or nofile or len(done) != len(expected):
        print("SHOWCASE_INCOMPLETE built %d/%d crashed=%s verify_failed=%s "
              "no glb on disk=%s" % (len(done), len(expected), crashed, drifted,
              nofile))
        sys.exit(1)
    print("BASE_DONE %d/%d %s" % (len(done), len(expected), done))
