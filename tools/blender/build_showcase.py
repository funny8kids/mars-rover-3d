# ============================================================================
# RED STARBASE — SHOWCASE hero-asset builder (Blender 5.2 LTS, headless)
#
# A dramatic step up from build_heroes.py: true hard-surface detailing —
# chamfered armour plating with bolt rows and panel seams, rocker-bogie
# suspension with coil-damped shocks, treaded wheels with machined rims,
# lidar/camera sensor head, articulated arm, thruster bells, folding solar
# wing, and a full set of distinct PBR materials.
#
# Run:  blender --background --python tools/blender/build_showcase.py
# Out:  /tmp/rsb_stage/{rover,teleport_pad,arch,rocks}.glb   (staging dir)
#
# RUNTIME CONTRACT (src/vehicle/rover.js + src/world/props.js):
#   - rover root node "rover"; six leaf-empties "wheelpivot_0..5" AT wheel
#     centres; children of each pivot are that wheel's parts, flat.
#     i = row*2 + side, rows front/mid/rear, side 0=left(-x) 1=right.
#   - headlight lenses use a material NAMED "light_amber" (rig modulates it).
#   - Blender front = -Y; runtime scales 0.85.
#   - teleport pad keeps an emissive material NAMED "pad_glow".
#   - arch keeps "rover_dark" on the stone parts (props.js recolors them).
# ============================================================================
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler

OUT = "/tmp/rsb_stage"
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

TAU = math.tau

# ---------------------------------------------------------------- utilities
def set_in(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val
        return True
    return False

def mat(name, color, rough=0.4, metal=0.0, emis=None, estr=0.0, alpha=None,
        transmit=None, ior=None):
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
    if transmit is not None:
        set_in(b, "Transmission Weight", transmit)
    if ior is not None:
        set_in(b, "IOR", ior)
    if alpha is not None:
        set_in(b, "Alpha", alpha)
        m.blend_method = 'BLEND'
        try:
            m.show_transparent_back = False
        except Exception:
            pass
    return m

# ------------------------------------------------- palette (art direction)
P = {
    # painted bodywork — warm bone off-white (matches toy palette in props.js)
    "body":   mat("rover_white",  (0.885, 0.845, 0.775), rough=0.30),
    "accent": mat("rover_orange", (1.0, 0.235, 0.015), rough=0.35),           # hazard paint
    "alu":    mat("rover_alu",    (0.72, 0.73, 0.76), rough=0.22, metal=1.0),  # bare machined
    "dark":   mat("rover_dark",   (0.075, 0.075, 0.09), rough=0.42, metal=0.85),  # anodised
    "worn":   mat("rover_worn",   (0.16, 0.145, 0.13), rough=0.72, metal=0.25),   # worn accent
    "rubber": mat("rover_rubber", (0.028, 0.026, 0.030), rough=0.95),
    "hub":    mat("rover_hub",    (0.80, 0.78, 0.74), rough=0.30, metal=0.85),    # machined rim
    "steel":  mat("hero_steel",   (0.58, 0.59, 0.62), rough=0.26, metal=1.0),
    "glass":  mat("rover_glass",  (0.75, 0.90, 0.95), rough=0.04, transmit=1.0, ior=1.45, alpha=0.42),
    "amber":  mat("light_amber",  (0.95, 0.50, 0.08), rough=0.25, emis=(1.0, 0.42, 0.05), estr=3.0),
    "cyan":   mat("light_cyan",   (0.55, 0.92, 1.0), rough=0.20, emis=(0.10, 0.72, 0.95), estr=1.8),
    "red":    mat("light_red",    (1.0, 0.25, 0.18), rough=0.30, emis=(1.0, 0.10, 0.05), estr=1.8),
    "cell":   mat("solar_cell",   (0.045, 0.075, 0.16), rough=0.18, metal=0.45),
    # pad / arch / rocks
    "pad":     mat("pad_white",   (0.90, 0.89, 0.87), rough=0.35),
    "padglow": mat("pad_glow",    (0.4, 0.95, 0.9), rough=0.20, emis=(0.10, 0.82, 0.78), estr=3.5),
    "rock":    mat("rock_basalt", (0.085, 0.070, 0.062), rough=0.95),
    "rockrust":mat("rock_rust",   (0.21, 0.105, 0.055), rough=0.92),
}

# ------------------------------------------------------------ scene helpers
def act(o):
    bpy.context.view_layer.objects.active = o
    return o

def _only(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    act(o)

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
    """Angle-limited bevel — rounds crease/boundary edges only (hard-surface workflow)."""
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

def parent(c, p):
    if p is None:
        return c
    c.parent = p
    c.matrix_parent_inverse = p.matrix_world.inverted()
    return c

def empty(name, loc, parent_to=None):
    bpy.ops.object.empty_add(location=loc)
    o = bpy.context.object
    o.name = name
    parent(o, parent_to)
    return act(o)

def purge():
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)

def link(o):
    bpy.context.collection.objects.link(o)
    return o

# ---------------------------------------------------------- primitive maker
def rbox(name, sx, sy, sz, loc, m, bevel_r=None, segs=2, rot=(0, 0, 0), par=None,
         smooth=38):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (max(sx, 1e-4), max(sy, 1e-4), max(sz, 1e-4))
    _only(o)
    bpy.ops.object.transform_apply(scale=True)
    if bevel_r is None:
        bevel_r = min(sx, sy, sz) * 0.22
    if bevel_r > 0:
        bevel(o, bevel_r, segs)
        smooth_angle(o, smooth)
    o.data.materials.append(m)
    parent(o, par)
    return o

def pbox(name, sx, sy, sz, loc, m, rot=(0, 0, 0), par=None):
    """Sharp 12-tri box — for seams, slats, glyphs, straps."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (max(sx, 1e-4), max(sy, 1e-4), max(sz, 1e-4))
    _only(o)
    bpy.ops.object.transform_apply(scale=True)
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

def cone(name, r1, r2, d, loc, m, rot=(0, 0, 0), verts=14, par=None, br=0.0):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=d, location=loc,
                                    rotation=rot, vertices=verts)
    o = act(bpy.context.object)
    o.name = name
    if br > 0:
        bevel(o, br, 1)
    smooth_angle(o)
    o.data.materials.append(m)
    parent(o, par)
    return o

def ball(name, r, loc, m, segs=20, par=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=segs,
                                         ring_count=segs // 2 + 2)
    o = act(bpy.context.object)
    o.name = name
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
def fix_slots(o, m=None):
    """Repair NULL / out-of-range material slots (Blender 5.2 join/boolean
    artifacts): polys on an empty slot inherit the nearest real slot."""
    me = o.data
    slots = list(me.materials)
    if not slots:
        if m is not None:
            me.materials.append(m)
            slots = list(me.materials)
    real = [i for i, s in enumerate(slots) if s is not None]
    if not real:
        if m is not None and slots:
            me.materials[0] = m
        for p in me.polygons:
            p.material_index = 0
        return o
    for p in me.polygons:
        i = p.material_index
        if i >= len(slots) or slots[i] is None:
            p.material_index = min(real, key=lambda k: abs(k - i))
    return o

def join(objs, name):
    """Join a list of objects into the first one (keeps materials)."""
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
    fix_slots(o)
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
    fix_slots(o)
    return o

def tube(name, pts, radius, m, res=1, par=None, closed=False):
    """Swept round tube through poly points (local coords → world +par later)."""
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

def spring(name, r, h, turns, wire, loc, m, rot=(0, 0, 0), par=None, ppt=12):
    """Coil spring with modelled windings (spiral, not a solid cylinder)."""
    n = int(turns * ppt)
    pts = []
    for k in range(n + 1):
        t = k / float(n)
        a = t * turns * TAU
        pts.append((r * math.cos(a), r * math.sin(a), t * h - h / 2.0))
    o = tube(name, pts, wire, m, res=2, par=par)
    o.location = (o.location.x + loc[0], o.location.y + loc[1], o.location.z + loc[2])
    o.rotation_euler = rot
    _only(o)
    bpy.ops.object.transform_apply(location=True, rotation=True)
    return o

def lathe(name, profile, m, loc, segs=28, rot=(0, 0, 0), par=None, smooth=45):
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
    """Extruded I-beam section along Y, centred."""
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

def fluted(name, r, h, loc, m, par=None, flutes=13, depth=0.05, segs=104, taper=0.93):
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

# bolt helpers -------------------------------------------------------------
AX = Vector((1, 0, 0)); AY = Vector((0, 1, 0)); AZ = Vector((0, 0, 1))

def _q(axis):
    return axis.to_track_quat('Z', 'Y')

def boltring(name, center, axis, radius, n, m, br=0.022, bh=0.02, phase=0.0, par=None):
    """Ring of hex bolt heads around center, axis = bolt axis. Joined into 1 mesh."""
    objs = []
    q = _q(Vector(axis))
    for k in range(n):
        a = phase + k / n * TAU
        local = Vector((radius * math.cos(a), radius * math.sin(a), 0))
        p = Vector(center) + q @ local
        bpy.ops.mesh.primitive_cylinder_add(radius=br, depth=bh, location=p,
                                            vertices=6)
        o = bpy.context.object
        o.rotation_euler = q.to_euler()
        o.data.materials.append(m)
        objs.append(o)
    r = join(objs, name)
    parent(r, par)
    return r

def boltrow(name, p0, p1, n, m, br=0.02, bh=0.018, normal=(0, 0, 1), par=None):
    """Row of fasteners along a line (panel edges, plate corners)."""
    objs = []
    q = _q(Vector(normal))
    for k in range(n):
        t = k / (n - 1.0) if n > 1 else 0.5
        p = Vector(p0).lerp(Vector(p1), t)
        bpy.ops.mesh.primitive_cylinder_add(radius=br, depth=bh, location=p, vertices=6)
        o = bpy.context.object
        o.rotation_euler = q.to_euler()
        o.data.materials.append(m)
        objs.append(o)
    r = join(objs, name)
    parent(r, par)
    return r

# wheel-orientation helpers: wheels roll about X, suspension pins about Y
RX90 = (0, math.pi / 2, 0)

def tri_count(root):
    n = 0
    for o in root.children_recursive:
        if o.type == 'MESH':
            n += len(o.data.loop_triangles) or sum(
                len(p.vertices) - 2 for p in o.data.polygons)
    return n

# ###########################################################################
#                                  ROVER
# ###########################################################################
WHEELS = [  # i = row*2 + side: rows front/mid/rear, side 0=left(-x) 1=right
    (-1.30, -1.22, 0.60), (1.30, -1.22, 0.60),
    (-1.30, 0.05, 0.60), (1.30, 0.05, 0.60),
    (-1.30, 1.30, 0.60), (1.30, 1.30, 0.60),
]

def wheel_locof(x):
    return 1 if x > 0 else -1  # outboard sign

def build_wheel(i, x, y, z, par):
    """Detailed wheel: treaded tyre + side lugs + machined drilled rim +
    hub nut ring + brake disc & caliper + inner drum, parented to pivot."""
    lo = wheel_locof(x)          # outboard direction (+1 right)
    parts = []
    # ---- tyre core: wide low-poly drum with pillow sidewalls
    bpy.ops.mesh.primitive_cylinder_add(radius=0.575, depth=0.40, location=(x, y, z),
                                        rotation=RX90, vertices=26)
    tyre = act(bpy.context.object)
    tyre.name = "tyre_%d" % i
    bevel(tyre, 0.13, 2)
    smooth_angle(tyre, 42)
    tyre.data.materials.append(P["rubber"])
    parts.append(tyre)
    # ---- tread blocks around the contact band (chamfered, alternating ribs)
    tb = []
    n = 16
    for k in range(n):
        a = k / n * TAU
        wide = (k % 2 == 0)
        # pair of lateral ribs on even positions, single full-width lug on odd
        offs = (-0.09, 0.09) if wide else (0.0,)
        for ox in offs:
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
            b = act(bpy.context.object)
            b.scale = (0.14 if wide else 0.30, 0.15, 0.06)
            b.rotation_euler = (-a, 0, 0)   # Rx(-a): local Z -> radial (0, sin a, cos a)
            _only(b)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
            bevel(b, 0.015, 1)
            b.location = (x + ox, y + 0.600 * math.sin(a), z + 0.600 * math.cos(a))
            b.data.materials.append(P["rubber"])
            tb.append(b)
    joined = join([tyre] + tb, "wheel_%d" % i)
    smooth_angle(joined, 42)
    parent(joined, par)
    parts = [joined]
    # ---- side lugs on both sidewalls (chevron shoulder cleats)
    lugs = []
    for s in (-1, 1):
        for k in range(10):
            a = (k + 0.5) / 10 * TAU
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
            g = act(bpy.context.object)
            g.scale = (0.05, 0.13, 0.10)
            g.rotation_euler = (-a, 0, 0)
            _only(g)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
            g.location = (x + s * 0.135, y + 0.575 * math.sin(a), z + 0.575 * math.cos(a))
            g.data.materials.append(P["rubber"])
            lugs.append(g)
    lj = join(lugs, "sitelugs_%d" % i)
    fix_slots(lj, P["rubber"])
    parent(lj, par)
    # ---- machined rim: drilled disc with raised outer flange
    bpy.ops.mesh.primitive_cylinder_add(radius=0.40, depth=0.44, location=(x, y, z),
                                        rotation=RX90, vertices=20)
    rim = act(bpy.context.object)
    rim.name = "rim_%d" % i
    rim.data.materials.append(P["hub"])
    cutters = []
    for k in range(6):
        a = k / 6 * TAU + 0.26
        bpy.ops.mesh.primitive_cylinder_add(radius=0.115, depth=1.0,
            location=(x, y + 0.24 * math.cos(a), z + 0.24 * math.sin(a)),
            rotation=RX90, vertices=12)
        cutters.append(bpy.context.object)
    boolean_diff(rim, cutters)
    bevel(rim, 0.02, 1)
    smooth_angle(rim, 40)
    fix_slots(rim, P["hub"])
    parent(rim, par)
    # outer flange ring + back plate
    fl = ring("rimflange_%d" % i, 0.375, 0.035, (x + lo * 0.215, y, z), P["alu"],
              maj=24, mino=6, rot=RX90, par=par)
    # ---- centre hub with nut ring
    rod("hub_%d" % i, 0.13, 0.50, (x, y, z), P["steel"], rot=RX90, verts=14,
        br=0.02, par=par)
    ball("hubcap_%d" % i, 0.115, (x + lo * 0.245, y, z), P["alu"], segs=12, par=par)
    nr = boltring("nutring_%d" % i, (x + lo * 0.245, y, z), (lo, 0, 0), 0.072, 6,
                  P["dark"], br=0.028, bh=0.022, par=par)
    # ---- brake disc behind the rim (inboard) + caliper
    disc_x = x - lo * 0.30
    rod("brakedisc_%d" % i, 0.30, 0.035, (disc_x, y, z), P["steel"], rot=RX90,
        verts=22, br=0.008, par=par)
    rod("discvcap_%d" % i, 0.16, 0.05, (disc_x, y, z), P["worn"], rot=RX90,
        verts=16, br=0.008, par=par)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(disc_x, y, z + 0.27))
    cal = act(bpy.context.object)
    cal.name = "caliper_%d" % i
    cal.scale = (0.075, 0.13, 0.16)
    _only(cal)
    bpy.ops.object.transform_apply(scale=True)
    bevel(cal, 0.02, 1)
    cal.data.materials.append(P["accent"])
    parent(cal, par)
    # ---- inner drum / drive unit
    rod("drum_%d" % i, 0.20, 0.26, (x - lo * 0.16, y, z), P["alu"], rot=RX90,
        verts=16, br=0.015, par=par)
    # tread-worn bottom scuff: a thin worn slat near the contact patch is implied
    return par

# ================================================= main chassis
def build_chassis(root):
    BODY = P["body"]; ALU = P["alu"]; DARK = P["dark"]; WORN = P["worn"]
    # lower hull — chamfered armour core
    hull = rbox("hull", 2.02, 3.05, 0.50, (0, -0.10, 1.15), BODY, bevel_r=0.10, segs=2, par=root)
    # stepped lower belly (skid plate) + worn underside
    pbox("skid", 1.72, 2.72, 0.05, (0, -0.10, 0.885), WORN, par=root)
    # deck plate with a reveal seam around the hull shoulder
    deck = rbox("deck", 1.80, 2.92, 0.08, (0, -0.10, 1.43), BODY, bevel_r=0.03, segs=1, par=root)
    pbox("deckseam_f", 1.86, 0.02, 0.05, (0, -1.545, 1.40), DARK, par=root)
    pbox("deckseam_r", 1.86, 0.02, 0.05, (0, 1.345, 1.40), DARK, par=root)
    # machined corner gussets (armour wedge blocks at deck corners)
    for sx in (-1, 1):
        for sy in (-1, 1):
            g = rbox("gusset_%d_%d" % (sx, sy), 0.26, 0.26, 0.30,
                     (sx * 0.90, -1.46 if sy < 0 else 1.26, 1.28), ALU,
                     bevel_r=0.035, segs=1,
                     rot=(0, 0, math.radians(45 if sx * sy > 0 else -45)), par=root)
    # ---- side armour plates with recessed seam gaps + bolt corners
    segY = [(-0.92, 1.28), (0.62, 1.34)]   # (center, length) fore / aft plates
    for sx in (-1, 1):
        for k, (cy, ly) in enumerate(segY):
            pl = rbox("plate_%d_%d" % (sx, k), 0.045, ly, 0.40,
                      (sx * 1.045, cy, 1.13), BODY, bevel_r=0.02, segs=1, par=root)
            # recessed seam between the two plates
            pbox("seam_%d_%d" % (sx, k), 0.012, 0.03, 0.44, (sx * 1.065, -0.16, 1.13),
                 WORN, par=root)
            # bolt rows at plate corners (millimeter fasteners)
            for bxx in (-1, 1):
                bxp = sx * 1.075
                boltrow("pbolt_%d_%d_%d" % (sx, k, bxx),
                        (bxp, cy - ly / 2 + 0.06, 1.30), (bxp, cy - ly / 2 + 0.06, 0.96),
                        3, ALU, br=0.016, bh=0.012, normal=(sx, 0, 0), par=root)
                boltrow("pbolt2_%d_%d_%d" % (sx, k, bxx),
                        (bxp, cy + ly / 2 - 0.06, 1.30), (bxp, cy + ly / 2 - 0.06, 0.96),
                        3, ALU, br=0.016, bh=0.012, normal=(sx, 0, 0), par=root)
        # ---- recessed service bay (front plate): rim + dark inset + louvers
        by = -0.92
        pbox("bayout_%d" % sx, 0.02, 0.62, 0.26, (sx * 1.075, by, 1.14), WORN, par=root)
        rbox("bayrim_%d" % sx, 0.03, 0.70, 0.34, (sx * 1.075, by, 1.14), ALU,
             bevel_r=0.015, segs=1, par=root)
        pbox("bayin_%d" % sx, 0.016, 0.60, 0.24, (sx * 1.082, by, 1.14), DARK, par=root)
        for j in range(3):
            pbox("louver_%d_%d" % (sx, j), 0.02, 0.52, 0.03,
                 (sx * 1.088, by, 1.06 + j * 0.08), ALU, par=root)
        # ---- hazard stripe band on aft plate lower edge
        for j in range(7):
            col = P["accent"] if j % 2 == 0 else DARK
            pbox("hz_%d_%d" % (sx, j), 0.014, 0.155, 0.10,
                 (sx * 1.078, 0.62 + (j - 3) * 0.165, 0.995), col,
                 rot=(0, 0, 0), par=root)
    # ---- front: nose module + bumper with hazard band + tow hooks
    nose = rbox("nose", 1.50, 0.34, 0.46, (0, -1.72, 1.06), BODY, bevel_r=0.07, segs=2, par=root)
    pbox("noseseam", 1.52, 0.02, 0.05, (0, -1.72, 1.28), DARK, par=root)
    bumper = rbox("bumper", 1.90, 0.14, 0.22, (0, -1.94, 0.98), WORN, bevel_r=0.045, segs=1, par=root)
    for j in range(8):
        col = P["accent"] if j % 2 == 0 else P["body"]
        pbox("fz_%d" % j, 0.185, 0.02, 0.13, (-0.82 + j * 0.235, -2.015, 0.98), col, par=root)
    for sx in (-1, 1):
        ring("towhook_%d" % sx, 0.07, 0.022, (sx * 0.62, -2.02, 1.10), P["steel"],
             maj=12, mino=6, rot=(math.pi / 2, 0, 0), par=root)
    # headlights: bezel + amber lens (light_amber drives the night rig)
    for sx in (-1, 1):
        rbox("lampbox_%d" % sx, 0.36, 0.12, 0.24, (sx * 0.55, -1.925, 1.16), ALU,
             bevel_r=0.03, segs=1, par=root)
        rbox("lens_%d" % sx, 0.26, 0.05, 0.15, (sx * 0.55, -1.99, 1.16), P["amber"],
             bevel_r=0.025, segs=2, par=root)
        # lens bezel screws
        boltrow("lensbolt_%d" % sx, (sx * 0.55 - 0.14, -1.995, 1.075),
                (sx * 0.55 + 0.14, -1.995, 1.075), 3, DARK, br=0.012, bh=0.008,
                normal=(0, -1, 0), par=root)
    # ---- rear face: engine grille + tail bar + status pucks
    pbox("reargrille", 1.30, 0.02, 0.34, (0, 1.425, 1.15), WORN, par=root)
    for j in range(5):
        pbox("rgbar_%d" % j, 1.22, 0.025, 0.028, (0, 1.438, 1.02 + j * 0.065), DARK, par=root)
    rbox("tailhouse", 1.36, 0.05, 0.14, (0, 1.42, 1.44), WORN, bevel_r=0.02, segs=1, par=root)
    for sx in (-1, 1):
        rbox("taillight_%d" % sx, 0.36, 0.045, 0.075, (sx * 0.44, 1.40, 1.44), P["red"],
             bevel_r=0.018, segs=1, par=root)
    # ---- exposed I-beam understructure (visible from side/below)
    for sx in (-1, 1):
        ibeam("ibeamL_%d" % sx, 2.8, 0.14, 0.16, 0.035, (sx * 0.66, -0.10, 0.80),
              P["dark"], par=root)
    ibeam("ibeamX", 1.44, 0.12, 0.14, 0.03, (0, 1.10, 0.86), P["dark"],
          rot=(0, math.pi / 2, 0), par=root)
    # ---- rear cage stanchions (I-beam) + crossbar + worklights
    for sx in (-1, 1):
        ibeam("cage_%d" % sx, 0.55, 0.10, 0.12, 0.028, (sx * 0.86, 1.28, 1.78),
              ALU, rot=(math.pi / 2, 0, 0), par=root)
    rod("cagebar", 0.05, 1.78, (0, 1.28, 2.04), P["alu"], rot=(0, math.pi / 2, 0),
        verts=12, br=0.012, par=root)
    for sx in (-1, 1):
        rbox("worklight_%d" % sx, 0.16, 0.08, 0.10, (sx * 0.42, 1.24, 1.99),
             P["cyan"], bevel_r=0.02, segs=1, par=root)
        rod("wlbeam_%d" % sx, 0.05, 0.03, (sx * 0.42, 1.205, 1.99), P["cyan"],
            rot=(math.pi / 2, 0, 0), verts=10, br=0.0, par=root)
    # ---- deck cable looms clipped down with tiny clamps
    # left fore loom: from under the nose bay back to the arm shoulder
    tube("loom_a", [(-0.70, -1.30, 1.478), (-0.72, -1.05, 1.478), (-0.68, -0.80, 1.478),
                    (-0.72, -0.58, 1.478)], 0.022, DARK, par=root)
    tube("loom_b", [(-0.63, -1.30, 1.478), (-0.66, -1.05, 1.478), (-0.61, -0.80, 1.478),
                    (-0.63, -0.58, 1.478)], 0.015, WORN, par=root)
    # right-edge loom: from the ebox forward along the deck shoulder
    tube("loom_c", [(0.80, 1.05, 1.49), (0.86, 0.65, 1.478), (0.86, 0.10, 1.478),
                    (0.82, -0.55, 1.478)], 0.02, DARK, par=root)
    for k, (cx_, cy_) in enumerate([(-0.70, -1.12), (-0.70, -0.72),
                                    (0.86, 0.55), (0.86, -0.15), (0.86, -0.52)]):
        pbox("clamp_%d" % k, 0.09, 0.05, 0.045, (cx_, cy_, 1.472), ALU, par=root)
        hexn("clampbolt_%d" % k, 0.016, 0.018, (cx_, cy_, 1.503), ALU, par=root)
    # conduit run from rear electronics box into the deck
    tube("conduit_r", [(0.66, 0.80, 1.50), (0.74, 0.92, 1.49), (0.80, 1.02, 1.50)],
         0.028, P["worn"], par=root)
    rbox("ebox", 0.36, 0.30, 0.22, (0.60, 0.72, 1.57), ALU, bevel_r=0.03, segs=1, par=root)
    pbox("eboxface", 0.28, 0.02, 0.14, (0.60, 0.565, 1.57), DARK, par=root)
    boltrow("eboxbolt", (0.45, 0.575, 1.66), (0.75, 0.575, 1.66), 4, DARK,
            br=0.014, bh=0.01, normal=(0, -1, 0), par=root)
    return root

def build_sensors(root):
    BODY = P["body"]; ALU = P["alu"]; DARK = P["dark"]
    mx, my = 0.58, -1.02
    # ---- mast base + tapered post + rib rings
    rbox("mastbase", 0.30, 0.30, 0.10, (mx, my, 1.52), ALU, bevel_r=0.03, segs=1, par=root)
    boltring("mastbolt", (mx, my, 1.575), (0, 0, 1), 0.115, 6, DARK, br=0.016, bh=0.014, par=root)
    cone("mast", 0.075, 0.05, 0.78, (mx, my, 1.95), DARK, verts=10, br=0.01, par=root)
    for k in range(3):
        ring("mastring_%d" % k, 0.068, 0.012, (mx, my, 1.72 + k * 0.24), ALU,
             maj=12, mino=6, par=root)
    # ---- pan head: yoke + housing
    rod("panpin", 0.05, 0.24, (mx, my, 2.36), ALU, rot=RX90, verts=12, br=0.0, par=root)
    head = rbox("sensorhead", 0.46, 0.26, 0.22, (mx, my - 0.02, 2.55), DARK,
                bevel_r=0.035, segs=2, par=root)
    rbox("headvisor", 0.52, 0.34, 0.045, (mx, my - 0.06, 2.685), BODY,
         bevel_r=0.015, segs=1, par=root)
    # ---- lidar drum: faceted cylinder + emissive window strip
    rod("lidar", 0.085, 0.17, (mx, my - 0.14, 2.55), ALU, rot=RX90, verts=12,
        br=0.008, par=root)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.09, depth=0.05,
        location=(mx, my - 0.16, 2.55), rotation=RX90, vertices=12)
    win = act(bpy.context.object)
    win.name = "lidar_window"
    win.data.materials.append(P["cyan"])
    parent(win, root)
    rod("lidartop", 0.05, 0.03, (mx, my - 0.14, 2.55), DARK, rot=RX90, verts=12,
        br=0.0, par=root)
    # ---- camera eyes with glass lenses
    for sx in (-1, 1):
        ex, ez = mx + sx * 0.155, 2.49
        rbox("cambox_%d" % sx, 0.11, 0.07, 0.10, (ex, my - 0.145, ez), ALU,
             bevel_r=0.018, segs=1, par=root)
        rod("camlens_%d" % sx, 0.042, 0.05, (ex, my - 0.185, ez), DARK,
            rot=(math.pi / 2, 0, 0), verts=12, br=0.0, par=root)
        ball("camglass_%d" % sx, 0.036, (ex, my - 0.205, ez), P["glass"], segs=10, par=root)
    # ---- high-gain dish on a yaw bracket (rear-left, tilted up-aft)
    dx, dy, dz = -0.42, 1.26, 1.98
    rod("dishpost", 0.04, 0.42, (dx, dy, 1.72), DARK, verts=10, br=0.0, par=root)
    rot_d = (math.radians(-52), 0, math.radians(12))
    # shallow paraboloid bowl (front surface + thin back), opens toward +Z local
    prof = [(0.0, 0.0), (0.11, 0.014), (0.21, 0.052), (0.30, 0.115),
            (0.30, 0.135), (0.21, 0.078), (0.11, 0.040), (0.0, 0.030)]
    dish = lathe("dish", prof, P["alu"], (dx, dy, dz), segs=48,
                 rot=rot_d, par=root, smooth=60)
    # feed horn along the dish axis: axis = rot_d applied to +Z
    axis = Euler(rot_d, 'XYZ').to_matrix() @ Vector((0, 0, 1))
    fc = Vector((dx, dy, dz))
    rod("dishfeed", 0.014, 0.26, tuple(fc + axis * 0.10),
        P["steel"], rot=rot_d, verts=8, br=0.0, par=root)
    ball("dishfeedtip", 0.03, tuple(fc + axis * 0.245), P["amber"], segs=8, par=root)
    # dish back hub
    rod("dishhub", 0.05, 0.06, tuple(fc - axis * 0.02), P["dark"], rot=rot_d,
        verts=10, br=0.008, par=root)
    # ---- whip antenna with bead tip (mounted on the right cage-bar end)
    ax, ay = 0.80, 1.28
    rod("whipsock", 0.032, 0.12, (ax, ay, 2.13), DARK, verts=10, br=0.008, par=root)
    cone("whip", 0.02, 0.006, 0.82, (ax, ay, 2.60), P["steel"], verts=8, br=0.0, par=root)
    ball("whipbead", 0.026, (ax, ay, 3.03), P["cyan"], segs=8, par=root)
    return root

def build_utility(root):
    """Robotic arm, sample canisters, cargo tray with crates, thrusters, solar wing."""
    ALU = P["alu"]; DARK = P["dark"]; STEEL = P["steel"]; BODY = P["body"]
    # ---- robotic arm (3 segments + wrist + 2-finger grabber), stowed on left deck
    # explicit joint chain so every segment physically meets its pivots:
    #   S shoulder (bx,by,1.72) -> seg1 up/aft 25deg -> E elbow
    #   E -> seg2 down/fwd 45deg -> W wrist -> palm + fingers hang to deck
    bx, by = -0.62, -0.35
    rbox("arm_turret", 0.30, 0.34, 0.16, (bx, by, 1.55), BODY, bevel_r=0.035, segs=1, par=root)
    boltring("armbolt", (bx, by, 1.63), (0, 0, 1), 0.155, 6, DARK, br=0.016, bh=0.012, par=root)
    S = Vector((bx, by, 1.72))
    d1 = Vector((0, math.sin(math.radians(25)), math.cos(math.radians(25))))
    E = S + d1 * 0.50
    d2 = Vector((0, -math.sin(math.radians(45)), -math.cos(math.radians(45))))
    W = E + d2 * 0.44
    rod("arm_shoulder", 0.06, 0.24, (bx, by, 1.72), ALU, rot=RX90, verts=12, br=0.01, par=root)
    m1 = rbox("arm_seg1", 0.10, 0.10, 0.5, tuple((S + E) / 2), ALU, bevel_r=0.022, segs=1,
              rot=d1.to_track_quat('Z', 'Y').to_euler(), par=root)
    rod("arm_elbow", 0.055, 0.22, tuple(E), DARK, rot=RX90, verts=12, br=0.01, par=root)
    m2 = rbox("arm_seg2", 0.085, 0.085, 0.44, tuple((E + W) / 2), ALU, bevel_r=0.018, segs=1,
              rot=d2.to_track_quat('Z', 'Y').to_euler(), par=root)
    rod("arm_wrist", 0.045, 0.16, tuple(W), STEEL, rot=RX90, verts=10, br=0.008, par=root)
    # palm + two-finger grabber hanging stowed just above the deck
    pbox("arm_palm", 0.10, 0.10, 0.05, (bx, W.y - 0.055, W.z - 0.055), STEEL,
         rot=(math.radians(-45 + 18), 0, 0), par=root)
    for szn in (-1, 1):
        pbox("finger_%d" % szn, 0.03, 0.035, 0.14,
             (bx + szn * 0.032, W.y - 0.115, W.z - 0.135), STEEL,
             rot=(math.radians(-14), 0, 0), par=root)
        pbox("finger2_%d" % szn, 0.03, 0.06, 0.035,
             (bx + szn * 0.032, W.y - 0.155, W.z - 0.195), STEEL,
             rot=(math.radians(28 * szn * 0 + 22), 0, 0), par=root)
    # arm harness loop following the segments
    tube("arm_cable", [(bx - 0.08, by + 0.02, 1.74), (bx - 0.10, by + 0.18, 2.02),
                       (bx - 0.11, by + 0.20, 2.17), (bx - 0.10, by - 0.02, 1.95)],
         0.016, DARK, par=root)
    # ---- sample-return canisters in a cradle (rear deck centre)
    cx, cy = 0.02, 1.16
    rbox("cradle_base", 0.56, 0.30, 0.05, (cx, cy, 1.50), STEEL, bevel_r=0.015, segs=1, par=root)
    for sx in (-1, 1):
        pbox("cradle_rail_%d" % sx, 0.04, 0.34, 0.16, (cx + sx * 0.27, cy, 1.57), STEEL, par=root)
    for k in (-1, 0, 1):
        can = rod("canister_%d" % k, 0.075, 0.30, (cx + k * 0.135, cy, 1.59), ALU,
                  rot=(math.pi / 2, 0, 0), verts=14, br=0.012, par=root)
        ball("canister_cap_%d" % k, 0.062, (cx + k * 0.135, cy + 0.165, 1.59), BODY, segs=10, par=root)
        if k == 0:
            rod("canister_band", 0.078, 0.05, (cx, cy - 0.03, 1.59), P["amber"],
                rot=(math.pi / 2, 0, 0), verts=14, br=0.0, par=root)
    # cradle hold-down straps
    for sx in (-1, 1):
        pbox("strap_%d" % sx, 0.62, 0.035, 0.012, (cx, cy + sx * 0.10, 1.668), DARK, par=root)
    # ---- cargo tray with tied-down crates (right deck)
    tx, ty = 0.52, 0.10
    rbox("tray", 0.62, 0.86, 0.035, (tx, ty, 1.49), STEEL, bevel_r=0.012, segs=1, par=root)
    for sx in (-1, 1):
        pbox("traywall_%d" % sx, 0.03, 0.86, 0.10, (tx + sx * 0.315, ty, 1.53), STEEL, par=root)
    for sy in (-1, 1):
        pbox("traywall2_%d" % sy, 0.62, 0.03, 0.10, (tx, ty + sy * 0.435, 1.53), STEEL, par=root)
    c1 = rbox("crate_1", 0.34, 0.36, 0.26, (tx - 0.02, ty - 0.20, 1.645), P["accent"],
              bevel_r=0.025, segs=1, par=root)
    c2 = rbox("crate_2", 0.30, 0.30, 0.20, (tx + 0.02, ty + 0.16, 1.615), BODY,
              bevel_r=0.02, segs=1, par=root)
    for k, (ccx, ccy, ccz, ch) in enumerate([(tx - 0.02, ty - 0.20, 1.78, 0.28),
                                             (tx + 0.02, ty + 0.16, 1.72, 0.22)]):
        pbox("cratestrap_%d" % k, 0.40, 0.035, 0.012, (ccx, ccy - 0.06, ccz), DARK, par=root)
        pbox("cratestrap2_%d" % k, 0.40, 0.035, 0.012, (ccx, ccy + 0.06, ccz), DARK, par=root)
        hexn("buckle_%d" % k, 0.022, 0.016, (ccx + 0.19, ccy - 0.06, ccz), ALU, par=root)
    # ---- rear thruster cluster: 3 modelled bells on a mount plate
    rbox("thr_mount", 0.78, 0.10, 0.34, (0, 1.46, 1.24), DARK, bevel_r=0.03, segs=1, par=root)
    bell = [(0.0, 0.0), (0.05, 0.0), (0.055, 0.045), (0.085, 0.105), (0.115, 0.14),
            (0.13, 0.15), (0.118, 0.148), (0.092, 0.112), (0.06, 0.058), (0.055, 0.01), (0.0, 0.01)]
    for k, (ox, oz, sc) in enumerate([(-0.24, 1.24, 1.0), (0.24, 1.24, 1.0), (0.0, 1.06, 0.72)]):
        b = lathe("thruster_%d" % k, bell, STEEL, (ox, 1.56, oz), segs=18,
                  rot=(math.radians(-90), 0, 0), par=root)
        b.scale = (sc, sc, sc)
        rod("thring_%d" % k, 0.048 * sc, 0.03, (ox, 1.60, oz), P["red"],
            rot=(math.radians(90), 0, 0), verts=12, br=0.0, par=root)
    # ---- folding solar wing with cell grid + hinge hardware (stowed on left deck)
    hx0, hy0 = -0.47, 0.62
    # hinge bar + knuckles
    rod("hingebar", 0.03, 1.05, (-0.97, hy0, 1.56), STEEL, rot=(0, 0, 0), verts=10,
        br=0.0, par=root)
    for k in range(3):
        rod("hinge_knuckle_%d" % k, 0.045, 0.12, (-0.97, hy0 - 0.38 + k * 0.38, 1.56),
            ALU, verts=10, br=0.01, par=root)
        pbox("hinge_pin_%d" % k, 0.016, 0.016, 0.16, (-0.97, hy0 - 0.38 + k * 0.38, 1.56),
             DARK, par=root)
    panel = rbox("solar_frame", 0.86, 1.06, 0.035, (hx0, hy0, 1.60), ALU,
                 bevel_r=0.012, segs=1, par=root)
    pbox("solar_cells", 0.78, 0.98, 0.012, (hx0, hy0, 1.625), P["cell"], par=root)
    # cell grid ridges: 3×4 cells
    for jx in range(4):
        pbox("cellgridx_%d" % jx, 0.012, 0.98, 0.016, (hx0 - 0.39 + jx * 0.26, hy0, 1.634), ALU, par=root)
    for jy in range(3):
        pbox("cellgridy_%d" % jy, 0.78, 0.012, 0.016, (hx0, hy0 - 0.365 + jy * 0.3267, 1.634), ALU, par=root)
    # corner screws on the panel frame
    boltrow("solarbolt_a", (hx0 - 0.36, hy0 - 0.44, 1.63), (hx0 + 0.36, hy0 - 0.44, 1.63), 4,
            DARK, br=0.012, bh=0.008, par=root)
    boltrow("solarbolt_b", (hx0 - 0.36, hy0 + 0.44, 1.63), (hx0 + 0.36, hy0 + 0.44, 1.63), 4,
            DARK, br=0.012, bh=0.008, par=root)
    # folded second wing leaf edge + latch
    rbox("solar_leaf2", 0.86, 1.06, 0.025, (hx0, hy0, 1.545), ALU, bevel_r=0.01, segs=1, par=root)
    pbox("solar_cells2", 0.78, 0.98, 0.01, (hx0, hy0, 1.528), P["cell"], par=root)
    rod("wing_latch", 0.03, 0.12, (hx0 + 0.44, hy0 + 0.5, 1.58), STEEL, rot=(0, math.radians(90), 0),
        verts=8, br=0.0, par=root)
    return root

def build_rover():
    purge()
    root = empty("rover", (0, 0, 0))
    build_chassis(root)
    build_sensors(root)
    build_utility(root)
    # ---- suspension (rocker-bogie arms + shocks)
    for sgn in (-1, 1):
        x = 1.10 * sgn
        front = WHEELS[0 if sgn < 0 else 1]
        mid = WHEELS[2 if sgn < 0 else 3]
        rear = WHEELS[4 if sgn < 0 else 5]
        boss = (x * 0.93, -0.42, 1.04)
        bogie_p = (x, 0.66, 0.92)
        def limb(p0, p1, name, w=0.15, h=0.17):
            a = Vector(p0); b = Vector(p1)
            d = b - a
            o = rbox(name, d.length, w, h, tuple((a + b) / 2), P["dark"],
                     bevel_r=min(w, h) * 0.38, segs=2,
                     rot=d.to_track_quat('X', 'Z').to_euler())
            parent(o, root)
            return o
        limb(boss, front, "rocker_f_%d" % sgn)
        limb(boss, bogie_p, "rocker_r_%d" % sgn)
        limb(bogie_p, mid, "bogie_f_%d" % sgn)
        limb(bogie_p, rear, "bogie_r_%d" % sgn)
        # pivot bosses with pins
        for bp, tag in [(boss, "rockpivot"), (bogie_p, "bogiefivot")]:
            rod("boss_%s_%d" % (tag, sgn), 0.105, 0.30, bp, P["alu"], rot=RX90,
                verts=16, br=0.014, par=root)
            hexn("boss_pin_%s_%d" % (tag, sgn), 0.05, 0.04,
                 (bp[0] + sgn * 0.17, bp[1], bp[2]), P["steel"], rot=RX90, par=root)
        # coil-over shock: damper rod + spiral spring between rocker and hull boss
        d0 = Vector((x * 0.97, -0.18, 1.30))
        d1 = Vector((x * 0.99, 0.30, 0.98))
        dv = d1 - d0
        rotZ = dv.to_track_quat('Z', 'Y').to_euler()
        rod("damper_%d" % sgn, 0.032, dv.length, tuple((d0 + d1) / 2), P["steel"],
            rot=rotZ, verts=10, br=0.0, par=root)
        rod("damper_body_%d" % sgn, 0.052, dv.length * 0.45,
            tuple(d0 + dv * 0.28), P["dark"], rot=rotZ,
            verts=12, br=0.012, par=root)
        spring("spring_%d" % sgn, 0.075, dv.length * 0.55, 6.5, 0.016,
               tuple(d0 + dv * 0.38), P["accent"],
               rot=rotZ, par=root, ppt=12)
    # differential cross-shaft
    rod("diffbar", 0.035, 2.0, (0, 0.10, 1.02), P["steel"], rot=(0, math.pi / 2, 0),
        verts=10, br=0.0, par=root)
    # ---- WHEELS on named pivots (runtime contract: leaf empties at centres)
    for i, (wx, wy, wz) in enumerate(WHEELS):
        pv = empty("wheelpivot_%d" % i, (wx, wy, wz))
        parent(pv, root)
        build_wheel(i, wx, wy, wz, pv)
    return root

# ###########################################################################
#                              TELEPORT PAD
#  footprint compatible with old pad: disc r≈2.6, posts r≈3.0, h≈1.06
# ###########################################################################
def build_teleport():
    purge()
    root = empty("teleport_pad", (0, 0, 0))
    PAD = P["pad"]; ALU = P["alu"]; DARK = P["dark"]; GLOW = P["padglow"]
    # ---- main deck disc: outer rim ring (top z 0.36) + inner island step
    prof = [(0.0, 0.0), (2.52, 0.0), (2.62, 0.10), (2.62, 0.26), (2.50, 0.36),
            (1.92, 0.36), (1.90, 0.30), (0.0, 0.30)]
    lathe("deck", prof, PAD, (0, 0, 0), segs=56, par=root, smooth=40)
    # rim panel seams (4 radial grooves on the outer ring)
    for k in range(4):
        a = k / 4 * TAU + math.pi / 4
        pbox("rimseam_%d" % k, 0.025, 0.60, 0.02,
             (math.cos(a) * 2.22, math.sin(a) * 2.22, 0.355), DARK,
             rot=(0, 0, a), par=root)
    # ---- shallow dark bowl sitting on the island
    prof_b = [(0.0, 0.245), (0.62, 0.225), (1.24, 0.205), (1.66, 0.235),
              (1.76, 0.315), (1.72, 0.325), (1.60, 0.255), (1.20, 0.225),
              (0.60, 0.245), (0.0, 0.265)]
    lathe("bowl", prof_b, DARK, (0, 0, 0), segs=48, par=root)
    # ---- hex floor pattern: 19 hex prisms in an axial grid, centre one glows
    hr = 0.175
    s = hr * math.sqrt(3) * 1.22
    cells = []
    for q in range(-2, 3):
        for r_ in range(-2, 3):
            if abs(q + r_) > 2:
                continue
            cells.append((s * (q + r_ / 2.0), s * 0.866 * r_))
    for k, (hx, hy) in enumerate(sorted(cells, key=lambda c: c[0] ** 2 + c[1] ** 2)):
        rod("hex_%d" % k, hr, 0.045, (hx, hy, 0.275), DARK if k else GLOW,
            verts=6, br=0.008, segs=1, rot=(0, 0, math.radians(15)), par=root)
    # bolt ring around the bowl rim
    boltring("deckbolt", (0, 0, 0.33), (0, 0, 1), 1.98, 12, ALU,
             br=0.03, bh=0.02, par=root)
    # ---- emitter teeth ring: 16 tapered teeth pointing inward on the step
    teeth = []
    for k in range(16):
        a = k / 16 * TAU
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
        t = act(bpy.context.object)
        t.scale = (0.13, 0.30, 0.30)
        _only(t)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        # taper the inward-pointing (-Y) tip (still in unrotated local space)
        me = t.data
        for v in me.vertices:
            if v.co.y < 0:
                v.co.x *= 0.35
                v.co.z *= 0.55
        bevel(t, 0.02, 1)
        # tip (-Y) must point at the pad centre from position angle (a-90°)
        t.rotation_euler = (0, 0, a + math.pi)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        t.location = (math.sin(a) * 2.02, -math.cos(a) * 2.02, 0.47)
        t.data.materials.append(ALU)
        teeth.append(t)
    tt = join(teeth, "teeth")
    parent(tt, root)
    # glow pucks between teeth, aimed at the centre
    glows = []
    for k in range(16):
        a = (k + 0.5) / 16 * TAU
        bpy.ops.mesh.primitive_cylinder_add(radius=0.038, depth=0.06,
            location=(math.cos(a) * 1.86, math.sin(a) * 1.86, 0.40), vertices=10)
        g = bpy.context.object
        g.data.materials.append(P["cyan"])
        glows.append(g)
    gl = join(glows, "toothglow")
    parent(gl, root)
    # ---- emissive ring (material "pad_glow") flush in the rim channel
    ring("glowring", 2.20, 0.05, (0, 0, 0.335), GLOW, maj=56, mino=8, par=root)
    ring("rimcollar", 2.20, 0.068, (0, 0, 0.30), DARK, maj=56, mino=8, par=root)
    # machined bolts on the outer rim
    boltring("rimglow", (0, 0, 0.375), (0, 0, 1), 2.46, 8, ALU, br=0.028, bh=0.018,
             phase=math.pi / 8, par=root)
    # ---- three emitter posts: flange, bolt ring, body, bracket band, amber head
    for i in range(3):
        a = i * TAU / 3 + math.pi / 6
        px, py = math.cos(a) * 2.42, math.sin(a) * 2.42
        rod("post_flange_%d" % i, 0.24, 0.08, (px, py, 0.39), DARK, verts=6,
            br=0.015, par=root)
        boltring("postbolt_%d" % i, (px, py, 0.44), (0, 0, 1), 0.175, 6, ALU,
                 br=0.024, bh=0.02, par=root)
        rbox("post_%d" % i, 0.16, 0.16, 0.56, (px, py, 0.70), PAD, bevel_r=0.035,
             segs=2, rot=(0, 0, a), par=root)
        ring("postband_%d" % i, 0.105, 0.022, (px, py, 0.88), ALU, maj=10, mino=6,
             par=root)
        rbox("posthead_%d" % i, 0.24, 0.24, 0.10, (px, py, 1.02), ALU,
             bevel_r=0.03, segs=1, rot=(0, 0, a), par=root)
        ball("postlamp_%d" % i, 0.075, (px, py, 1.10), P["amber"], segs=12, par=root)
        rbox("postgusset_%d" % i, 0.08, 0.30, 0.22,
             (px * 0.92, py * 0.92, 0.47), ALU, bevel_r=0.02, segs=1,
             rot=(0, 0, a), par=root)
    # ---- cable conduit running off the deck + junction box on a leg
    # (kept inside the old ~2.6-2.8 r footprint of public/assets/teleport_pad)
    tube("conduit_a", [(2.28, -0.48, 0.30), (2.44, -0.76, 0.20), (2.52, -1.05, 0.10)],
         0.075, DARK, par=root)
    for k in range(3):
        pbox("clip_a_%d" % k, 0.10, 0.10, 0.06, (2.33 + k * 0.10, -0.55 - k * 0.19,
             0.25 - k * 0.06), ALU, rot=(0, 0, 0.5), par=root)
    rod("jboxleg", 0.05, 0.42, (2.36, 1.00, 0.21), DARK, verts=8, br=0.0, par=root)
    rbox("jbox", 0.42, 0.34, 0.26, (2.36, 1.00, 0.54), PAD, bevel_r=0.04, segs=1,
         rot=(0, 0, -0.5), par=root)
    pbox("jboxface", 0.30, 0.02, 0.16, (2.33, 0.86, 0.62), DARK, rot=(0, 0, -0.5), par=root)
    tube("conduit_b", [(2.26, 0.84, 0.46), (2.05, 0.64, 0.34), (1.90, 0.40, 0.33)],
         0.06, DARK, par=root)
    return root

# ###########################################################################
#                              GATE ARCH
#  footprint compatible: ~7.4 wide × ~4.2 tall × 0.9 deep. Stone parts use
#  "rover_dark" (props.js recolors them to warm stone).
# ###########################################################################
def build_arch():
    purge()
    root = empty("arch", (0, 0, 0))
    STONE = P["dark"]      # "rover_dark" → re-assigned to stone at runtime
    MET = P["alu"]
    AX_ = 3.1              # column axis x
    for sgn in (-1, 1):
        # stepped plinth with panel seam + bolts
        rbox("plinth_%d" % sgn, 1.15, 0.88, 0.28, (sgn * AX_, 0, 0.14), STONE,
             bevel_r=0.045, segs=2, par=root)
        rbox("plinth2_%d" % sgn, 0.95, 0.74, 0.20, (sgn * AX_, 0, 0.36), STONE,
             bevel_r=0.035, segs=2, par=root)
        for sy in (-1, 1):
            pbox("plinthseam_%d_%d" % (sgn, sy), 1.0, 0.02, 0.06,
                 (sgn * AX_, sy * 0.45, 0.28), P["worn"], par=root)
            boltrow("plbolt_%d_%d" % (sgn, sy),
                    (sgn * AX_ - 0.4, sy * 0.455, 0.14), (sgn * AX_ + 0.4, sy * 0.455, 0.14),
                    5, MET, br=0.024, bh=0.014, normal=(0, sy, 0), par=root)
        # fluted column shaft + base collar + capital moldings
        rod("colbase_%d" % sgn, 0.36, 0.14, (sgn * AX_, 0, 0.53), STONE, verts=20,
            br=0.025, par=root)
        fluted("column_%d" % sgn, 0.30, 2.30, (sgn * AX_, 0, 0.60), STONE, par=root,
               flutes=13, depth=0.05)
        # fillet ring at fluted top
        ring("colring_%d" % sgn, 0.295, 0.028, (sgn * AX_, 0, 2.84), STONE, maj=26, mino=6, par=root)
        # capital: two moldings + abacus
        cone("cap1_%d" % sgn, 0.30, 0.42, 0.16, (sgn * AX_, 0, 2.98), STONE, verts=18, br=0.02, par=root)
        rbox("cap2_%d" % sgn, 0.92, 0.86, 0.16, (sgn * AX_, 0, 3.14), STONE, bevel_r=0.04, segs=2, par=root)
        # Ionic-ish volute discs
        for sy in (-1, 1):
            rod("volute_%d_%d" % (sgn, sy), 0.10, 0.10, (sgn * AX_, sy * 0.40, 3.06),
                STONE, rot=(math.pi / 2, 0, 0), verts=12, br=0.015, par=root)
        # bracket hardware spanning the capital→lintel joint (front + back faces)
        for sy in (-1, 1):
            pbox("bracket_%d_%d" % (sgn, sy), 0.55, 0.12, 0.26,
                 (sgn * (AX_ + 0.28), sy * 0.26, 3.30), MET, par=root)
            hexn("brbolt_%d_%d" % (sgn, sy), 0.035, 0.02,
                 (sgn * (AX_ + 0.56), sy * 0.26, 3.30),
                 P["worn"], rot=(0, math.pi / 2, 0), par=root)
    # ---- lintel beam with seams + engraved frieze band + cornice
    lint = rbox("lintel", 7.40, 0.66, 0.55, (0, 0, 3.65), STONE, bevel_r=0.05, segs=2, par=root)
    rbox("cornice", 7.40, 0.72, 0.18, (0, 0, 4.01), STONE, bevel_r=0.04, segs=2, par=root)
    # panel seams (vertical recesss on the front face)
    for k in range(4):
        x = -2.4 + k * 1.6
        if abs(x) < 0.5:
            continue
        pbox("lintseam_%d" % k, 0.035, 0.02, 0.46, (x, -0.34, 3.65), P["worn"], par=root)
    # engraved band: recessed strip + incised glyph marks (front face)
    pbox("frieze", 6.40, 0.015, 0.17, (0, -0.338, 3.44), P["worn"], par=root)
    glyphs = []
    for k in range(9):
        gx = -2.56 + k * 0.64
        for j, (ox, oy, sx, sy2, rz) in enumerate([
                (-0.10, 0.0, 0.05, 0.11, 0), (0.10, 0.0, 0.05, 0.11, 0),
                (0.0, 0.035, 0.16, 0.04, 0), (0.0, -0.045, 0.06, 0.06, 45)]):
            bpy.ops.mesh.primitive_cube_add(size=1, location=(gx + ox, -0.352, 3.44 + oy))
            g = act(bpy.context.object)
            g.scale = (sx, 0.02, sy2)
            if rz:
                g.rotation_euler = (0, 0, math.radians(rz))
            _only(g)
            # bake rotation into the mesh: setting rotation after
            # transform_apply and before join mis-orients in 5.2 headless
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
            g.data.materials.append(MET)
            glyphs.append(g)
    gl = join(glyphs, "engraving")
    fix_slots(gl, MET)
    parent(gl, root)
    # ---- keystone: hexagonal wedge medallion proud of the lintel front + emblem
    bpy.ops.mesh.primitive_cone_add(radius1=0.42, radius2=0.34, depth=0.14,
        location=(0, -0.30, 3.60), rotation=(math.radians(90), 0, 0), vertices=6)
    ks = act(bpy.context.object)
    ks.name = "keystone"
    ks.rotation_euler = (math.radians(90), 0, math.radians(30))
    _only(ks)
    bevel(ks, 0.025, 1)
    smooth_angle(ks, 40)
    ks.data.materials.append(STONE)
    parent(ks, root)
    # star emblem disc on the keystone (front)
    rod("emblem", 0.20, 0.05, (0, -0.39, 3.60), P["amber"], rot=(math.pi / 2, 0, 0),
        verts=5, br=0.015, par=root)
    # ---- light strip under the lintel + status pucks
    strip = rbox("light_strip", 6.20, 0.10, 0.14, (0, 0, 3.30), P["cyan"],
                 bevel_r=0.035, segs=1, par=root)
    for sgn in (-1, 1):
        rbox("stripsock_%d" % sgn, 0.30, 0.16, 0.18, (sgn * 3.35, 0, 3.30), MET,
             bevel_r=0.025, segs=1, par=root)
    # top badge
    ball("badge", 0.28, (0, 0, 4.22), P["amber"], segs=16, par=root)
    rod("badgering", 0.38, 0.05, (0, 0, 4.22), MET, rot=(0, 0, 0), verts=20,
        br=0.012, par=root)
    return root

# ###########################################################################
#                              ROCKS scatter set
# ###########################################################################
def _pnoise(p, seed):
    v = (math.sin(p[0] * 1.7 + seed) * math.sin(p[1] * 2.3 + seed * 1.3) +
         math.sin(p[2] * 1.3 + seed * 2.1) * math.sin(p[0] * 2.9 - p[1] * 1.1 + seed))
    w = (math.sin(p[0] * 4.7 - seed) * math.sin(p[2] * 3.9 + seed * 0.7) +
         math.sin(p[1] * 5.1 + seed * 1.9) * math.cos(p[0] * 4.1 + p[2] * 3.3))
    return 0.6 * v + 0.25 * w

def displace(o, amp, freq, seed, flatten_z=None):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for v in bm.verts:
        p = v.co
        d = _pnoise((p.x * freq, p.y * freq, p.z * freq), seed)
        v.co = p + p.normalized() * d * amp
    if flatten_z is not None:
        for v in bm.verts:
            if v.co.z < flatten_z:
                v.co.z = flatten_z + (v.co.z - flatten_z) * 0.12
    bm.to_mesh(o.data)
    bm.free()

def rockblob(name, r, loc, m, subdiv=2, seed=1.0, amp=0.30, sx=1, sy=1, sz=1,
             flatten=True, par=None):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r, location=loc)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (sx, sy, sz)
    _only(o)
    bpy.ops.object.transform_apply(scale=True)
    displace(o, amp * r, 1.0 / r * 0.55, seed, flatten_z=-r * 0.55 if flatten else None)
    o.location = (0, 0, 0)
    bevel(o, r * 0.06, 1, min_angle=35)
    smooth_angle(o, 30)
    o.data.materials.append(m)
    o.location = loc
    parent(o, par)
    return o

def build_rocks():
    purge()
    root = empty("rocks", (0, 0, 0))
    # rock_0 — big angular boulder
    r0 = rockblob("rock_0", 1.0, (0, 0, 0.62), P["rock"], subdiv=2, seed=3.1,
                  amp=0.55, sx=1.15, sy=0.9, sz=0.8, par=root)
    # rock_1 — flat layered shelf: stacked displaced slabs
    slabs = []
    for k in range(3):
        s = rockblob("slab_%d" % k, 0.72 - k * 0.12, (0.05 * k, -0.04 * k, 0.16 + k * 0.30),
                     P["rock"] if k % 2 == 0 else P["rockrust"], subdiv=2, seed=7.7 + k,
                     amp=0.34, sx=1.5 - k * 0.18, sy=1.15 - k * 0.12, sz=0.34)
        parent(s, root)
        slabs.append(s)
    r1 = join(slabs, "rock_1")
    r1.location = (2.6, 0.4, 0)
    parent(r1, root)
    # rock_2 — rounded scatter cluster (three merged blobs)
    bs = []
    for k, (dx, dy, dz, rr) in enumerate([(-0.5, 0.0, 0.32, 0.55), (0.15, 0.35, 0.26, 0.48),
                                          (0.5, -0.15, 0.20, 0.38)]):
        bs.append(rockblob("blob_%d" % k, rr, (dx, dy, dz), P["rockrust"], subdiv=2,
                           seed=11.0 + k * 2.3, amp=0.30, sz=0.85))
    r2 = join(bs, "rock_2")
    r2.location = (-2.3, 1.2, 0)
    parent(r2, root)
    # rock_3 — sharp splinter shards
    shards = []
    for k in range(5):
        a = k / 5 * TAU
        hgt = 0.5 + (k % 3) * 0.35
        bpy.ops.mesh.primitive_cone_add(radius1=0.13 + 0.05 * (k % 2), radius2=0.02,
            depth=hgt, location=(math.cos(a) * 0.35, math.sin(a) * 0.3, hgt / 2 - 0.05),
            vertices=6)
        c = act(bpy.context.object)
        c.rotation_euler = (math.radians(24) * math.cos(a * 2), math.radians(20) * math.sin(a), a)
        c.data.materials.append(P["rock"])
        shards.append(c)
    base = rockblob("shardbase", 0.55, (0, 0, 0.16), P["rock"], subdiv=1, seed=5.5,
                    amp=0.40, sz=0.5)
    shards.append(base)
    r3 = join(shards, "rock_3")
    r3.location = (0.4, -2.6, 0)
    parent(r3, root)
    for o in (r0, r1, r2, r3):
        o.select_set(False)
    return root

# ------------------------------------------------------------------- export
def export(root, fname):
    # final safety pass: no NULL / out-of-range material slots may survive —
    # the glTF exporter emits unmaterialised primitives for them
    for o in [root] + list(root.children_recursive):
        if o.type == 'MESH':
            fix_slots(o)
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for o in root.children_recursive:
        if o.type in {'MESH', 'EMPTY'}:
            o.select_set(True)
    path = os.path.join(OUT, fname)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                              use_selection=True, export_yup=True,
                              export_apply=True)
    print("EXPORTED %s  tris=%d" % (fname, tri_count(root)))

if __name__ == "__main__":
    for fn, fname in [(build_rover, "rover.glb"),
                      (build_teleport, "teleport_pad.glb"),
                      (build_arch, "arch.glb"),
                      (build_rocks, "rocks.glb")]:
        r = fn()
        export(r, fname)
    print("SHOWCASE_DONE")
