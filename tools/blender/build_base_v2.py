# ============================================================================
# RED STARBASE — BASE STRUCTURES v2 (Blender 5.2 LTS, headless)
#
# The eight base landmarks, rebuilt to the bruno-simon bar: real panel
# construction, structural space frames, visible internals, per-face dust and
# scuff weathering, and 8-14 distinct PBR slots per asset.
#
# Run:   blender --background --python tools/blender/build_base_v2.py
#        ... -- launch_tower greenhouse            (optional: build a subset)
# Out:   /tmp/rsb_stage3/<name>.glb
#
# RUNTIME CONTRACT (verified against src/world/assets.js + src/world/props.js
# + src/vehicle/rover.js + src/main.js — do not change any of this):
#   * Units are METRES, authored at real scale, +Z up in Blender, exported
#     with export_yup=True (glTF Y-up conversion by the exporter).
#   * The scene root node name MUST equal the file name: props.js does
#     loadModel(name) -> ./assets/<name>.glb, and rover.js walks the inner
#     scene looking meshes up by MATERIAL, not by node.
#   * Base sits at local Z=0 and the model is centred in X/Y, because
#     put(name,x,z,s,ry,dy) sets position=(x, surfaceAt+dy, z) and rotation.y
#     = ry — an off-centre pivot makes the model orbit its placement point.
#   * Horizontal footprints are matched to the shipped assets within ~10% so
#     the colliders in props.js stay valid. Targets (local metres):
#       launch_tower  x[-7.7 7.7]  y[-3.1 3.1]   z[0    .. 49.4]
#       greenhouse    x[-4.6 4.6]  y[-4.6 4.6]   z[0    ..  4.9]
#       cryo_tank     x[-2.7 2.7]  y[-2.1 2.1]   z[0    .. 10.1]
#       lander        x[-2.6 2.6]  y[-2.5 2.5]   z[0    ..  5.4]
#       lamp          x[-1.1 1.1]  y[-1.0 1.0]   z[0    ..  5.0]
#       crystal       x[-1.0 1.0]  y[-1.0 1.0]   z[0    ..  2.6]
#       starship      x[-3.2 3.2]  y[-4.4 4.4]   z[0    .. 43.5]
#       habitat_dome  x[-4.3 4.3]  y[-5.6 5.6]   z[0    ..  5.6]
#   * Material names the runtime keys off — reuse them for the same role:
#       'light_amber'   rover.js findMeshByMaterial() + props.js emissive set
#       'light_cyan', 'light_warm', 'light_magenta', 'pad_glow'  props.js set
#       'plant'         greenhouse interior crops      (props.js emissive set)
#       'crystal_mat'   crystal body                   (props.js emissive set)
#       'hull_white', 'hull_warm', 'dark_panel', 'steel', 'acc_red',
#       'rust_orange', 'glass_green'  — kept from the shipped set so the
#                       base's colour language stays continuous.
#   * main.js lifts the whole starship group on launch and tilts it about its
#     group origin -> the ship's engine exit plane must be at local Z=0.
#   * main.js hovers + spins the sample crystals at y=1.05 and replaces EVERY
#     mesh material with one shared crystal material, so the crystal must read
#     from silhouette + facet shading alone, and must be modelled underneath.
# ============================================================================
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix, Euler

OUT = "/tmp/rsb_stage3"
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

TAU = math.tau
AX = Vector((1, 0, 0))
AY = Vector((0, 1, 0))
AZ = Vector((0, 0, 1))
RX90 = (0, math.pi / 2, 0)      # cylinder axis -> X
import os as _os
_CLEANUP_DEBUG = bool(_os.environ.get("BBV_DEBUG"))
RY90 = (math.pi / 2, 0, 0)      # cylinder axis -> Y


# ============================================================================
#  materials
# ============================================================================
def set_in(node, name, val):
    if node and name in node.inputs:
        node.inputs[name].default_value = val
        return True
    return False


def mat(name, color, rough=0.4, metal=0.0, emis=None, estr=0.0, alpha=None,
        transmit=None, ior=None, coat=None, aniso=None):
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
        m["_emis"] = estr
    if transmit is not None:
        set_in(b, "Transmission Weight", transmit)
    if ior is not None:
        set_in(b, "IOR", ior)
    if coat is not None:
        set_in(b, "Coat Weight", coat)
        set_in(b, "Coat Roughness", 0.08)
    if aniso is not None:
        set_in(b, "Anisotropic", aniso)
    if alpha is not None:
        set_in(b, "Alpha", alpha)
        m.blend_method = 'BLEND'
        try:
            m.show_transparent_back = False
        except Exception:
            pass
    return m


# --------------------------------------------------------------- palette
# Eight families, deliberately far apart in roughness/metalness so a surface
# reads as *what it is made of* even in silhouette.
P = {
    # --- painted (dielectric) bodywork
    "white":   mat("hull_white",   (0.845, 0.815, 0.760), rough=0.30, metal=0.04, coat=0.35),
    "cream":   mat("hull_warm",    (0.735, 0.660, 0.540), rough=0.46, metal=0.03),
    "orange":  mat("acc_orange",   (0.870, 0.290, 0.045), rough=0.36, metal=0.05, coat=0.30),
    "red":     mat("acc_red",      (0.480, 0.055, 0.040), rough=0.44, metal=0.05),
    "navblue": mat("acc_blue_anod", (0.055, 0.130, 0.300), rough=0.28, metal=0.10, coat=0.50),
    # --- bare / machined metal
    "alu":     mat("steel",        (0.700, 0.706, 0.730), rough=0.23, metal=1.0),
    "alumach": mat("alu_bright",   (0.860, 0.870, 0.890), rough=0.11, metal=1.0, aniso=0.55),
    "titan":   mat("ti_anodised",  (0.360, 0.430, 0.660), rough=0.20, metal=1.0),
    "copper":  mat("cu_pipe",      (0.720, 0.330, 0.190), rough=0.29, metal=1.0),
    "gunmetal":mat("dark_panel",   (0.072, 0.074, 0.086), rough=0.44, metal=0.88),
    "soot":    mat("thruster_soot", (0.030, 0.028, 0.028), rough=0.86, metal=0.25),
    # --- composite / rubber / mineral
    "rubber":  mat("composite_rub", (0.026, 0.024, 0.027), rough=0.94),
    "grate":   mat("floor_grate",  (0.300, 0.295, 0.285), rough=0.55, metal=0.75),
    "concrete": mat("footing_cast", (0.335, 0.300, 0.265), rough=0.93),
    "worn":    mat("worn_metal",   (0.150, 0.132, 0.118), rough=0.72, metal=0.40),
    "dust":    mat("dust_mars",    (0.430, 0.212, 0.128), rough=0.98, metal=0.0),
    "rust":    mat("rust_orange",  (0.290, 0.110, 0.050), rough=0.88, metal=0.15),
    # --- glazing
    "glass":   mat("glass_green",  (0.62, 0.86, 0.84), rough=0.03, transmit=1.0, ior=1.45, alpha=0.30),
    "lens":    mat("glass_clear",  (0.90, 0.95, 0.98), rough=0.02, transmit=1.0, ior=1.50, alpha=0.22),
    "insul":   mat("cryo_insul",   (0.905, 0.930, 0.960), rough=0.62, metal=0.0),
    # --- photovoltaic / biology
    "cell":    mat("solar_cell",   (0.038, 0.062, 0.145), rough=0.15, metal=0.50, coat=0.6),
    "plant":   mat("plant",        (0.10, 0.42, 0.13), rough=0.72, emis=(0.16, 0.62, 0.20), estr=0.35),
    "soil":    mat("grow_soil",    (0.075, 0.052, 0.038), rough=0.97),
    # --- emissives (names are runtime API — see header)
    "amber":   mat("light_amber",  (0.95, 0.50, 0.08), rough=0.22, emis=(1.0, 0.45, 0.06), estr=4.0),
    "cyan":    mat("light_cyan",   (0.52, 0.90, 1.0), rough=0.18, emis=(0.10, 0.74, 0.96), estr=3.0),
    "warm":    mat("light_warm",   (1.0, 0.86, 0.60), rough=0.20, emis=(1.0, 0.80, 0.48), estr=2.6),
    "magenta": mat("light_magenta", (1.0, 0.16, 0.66), rough=0.24, emis=(1.0, 0.12, 0.62), estr=3.6),
    "redglow": mat("light_red",    (1.0, 0.20, 0.14), rough=0.28, emis=(1.0, 0.06, 0.03), estr=3.2),
    # NOTE: props.js overrides this slot at runtime with an OPAQUE emissive
    # MeshStandardMaterial (0xbaf5ee / emissive 0x3fd9c4, rough 0.12, metal 0.35),
    # so the authored slot is matched to that look -- no transmission, because a
    # glassy body would hide the facet read the runtime actually delivers.
    "crystal": mat("crystal_mat",  (0.66, 0.94, 0.92), rough=0.12, metal=0.35,
                   emis=(0.16, 0.78, 0.70), estr=1.25),
}
# alias every entry by its real material name too, so builders can refer to
# either the role ("alu") or the glTF slot name ("steel")
for _k, _v in list(P.items()):
    P.setdefault(_v.name, _v)


# ============================================================================
#  scene plumbing
# ============================================================================
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
    """Angle-limited bevel: rounds crease + boundary edges only."""
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
    if p is None or c is None:
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


# ============================================================================
#  primitives
# ============================================================================
def rbox(name, sx, sy, sz, loc, m, bevel_r=None, segs=2, rot=(0, 0, 0), par=None,
         smooth=38):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (max(abs(sx), 1e-4), max(abs(sy), 1e-4), max(abs(sz), 1e-4))
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
    """Sharp 12-tri box — seams, slats, ribs, glyphs. Never used as a visible
    plate flush against a surface (that z-fights); always proud or recessed."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object)
    o.name = name
    o.scale = (max(abs(sx), 1e-4), max(abs(sy), 1e-4), max(abs(sz), 1e-4))
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


def tube_simple(name, r1, r2, d, loc, m, rot=(0, 0, 0), verts=20, par=None, br=0.0):
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


cone = tube_simple


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
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc,
                                        rotation=rot, vertices=6)
    o = act(bpy.context.object)
    o.name = name
    bevel(o, r * 0.22, 1)
    smooth_angle(o, 35)
    o.data.materials.append(m)
    parent(o, par)
    return o


def prism(name, r, h, loc, m, sides=8, rot=(0, 0, 0), par=None, br=0.0, segs=1):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc,
                                        rotation=rot, vertices=sides)
    o = act(bpy.context.object)
    o.name = name
    if br > 0:
        bevel(o, br, segs)
    o.data.materials.append(m)
    parent(o, par)
    return o


# ------------------------------------------------------------------ bmesh ops
def from_bm(name, bm, m, loc=(0, 0, 0), rot=(0, 0, 0), par=None, smooth=40,
            scale=None):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o)
    o.location = loc
    o.rotation_euler = rot
    if scale:
        o.scale = scale
    o.data.materials.append(m)
    if scale:
        _only(o)
        bpy.ops.object.transform_apply(scale=True)
    smooth_angle(o, smooth)
    parent(o, par)
    return o


def lathe(name, profile, m, loc, segs=28, rot=(0, 0, 0), par=None, smooth=45):
    """Spin an (r,z) polyline about Z -> closed shell of revolution.  A profile
    point at r==0 collapses to a single apex so the solid is genuinely capped
    (a 1e-4 stub would leave a 26-sided boundary loop, i.e. an open shell)."""
    bm = bmesh.new()
    verts = [bm.verts.new((r if r > 1e-3 else 0.0, 0, z)) for r, z in profile]
    edges = [bm.edges.new((verts[k], verts[k + 1])) for k in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1),
                   angle=TAU, steps=segs, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    return from_bm(name, bm, m, loc, rot, par, smooth)


def extrude_poly(name, pts2d, h, m, loc, rot=(0, 0, 0), par=None, capping=True,
                 taper=1.0, twist=0.0, smooth=40, steps=1):
    """Extrude a 2-D section along Z with optional taper/twist — the workhorse
    for brackets, gussets, blades and lattice members with real sections."""
    bm = bmesh.new()
    n = len(pts2d)
    prev = None
    rings = []
    for s in range(steps + 1):
        t = s / float(steps)
        scl = (1.0 - t) + t * taper
        ang = t * twist
        ca, sa = math.cos(ang), math.sin(ang)
        z = -h / 2.0 + h * t
        ring_v = []
        for (x, y) in pts2d:
            X = (x * scl) * ca - (y * scl) * sa
            Y = (x * scl) * sa + (y * scl) * ca
            ring_v.append(bm.verts.new((X, Y, z)))
        rings.append(ring_v)
    for s in range(steps):
        a = rings[s]
        b = rings[s + 1]
        for i in range(n):
            j = (i + 1) % n
            try:
                bm.faces.new((a[i], a[j], b[j], b[i]))
            except ValueError:
                pass
    if capping:
        try:
            bm.faces.new(list(reversed(rings[0])))
            bm.faces.new(rings[-1])
        except ValueError:
            pass
    return from_bm(name, bm, m, loc, rot, par, smooth)


def ibeam(name, length, w, h, t, loc, m, rot=(0, 0, 0), par=None):
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, -h / 2 + t),
           (t / 2, -h / 2 + t), (t / 2, h / 2 - t), (w / 2, h / 2 - t),
           (w / 2, h / 2), (-w / 2, h / 2), (-w / 2, h / 2 - t),
           (-t / 2, h / 2 - t), (-t / 2, -h / 2 + t), (-w / 2, -h / 2 + t)]
    return extrude_poly(name, pts, length, m, loc, rot=rot, par=par, smooth=40)


def csection(name, length, w, h, t, loc, m, rot=(0, 0, 0), par=None):
    """Channel / C-section — the honest section for a space-frame strut."""
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, -h / 2 + t),
           (t / 2, -h / 2 + t), (t / 2, h / 2 - t), (w / 2, h / 2 - t),
           (w / 2, h / 2), (-w / 2, h / 2)]
    return extrude_poly(name, pts, length, m, loc, rot=rot, par=par, smooth=40)


def tube(name, pts, radius, m, res=1, par=None, closed=False, loc=(0, 0, 0),
         radii=None):
    """Swept round tube through poly points. `radii` gives a per-point radius
    so a single sweep can taper (goosenecks, nozzles, hose runs)."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for k, p in enumerate(pts):
        sp.points[k].co = (p[0], p[1], p[2], 1)
    sp.use_cyclic_u = closed
    if radii:
        cu.bevel_depth = 1.0
        for k, rr in enumerate(radii):
            sp.points[k].radius = rr
    else:
        cu.bevel_depth = radius
    cu.bevel_resolution = res
    cu.use_fill_caps = True
    o = bpy.data.objects.new(name, cu)
    link(o)
    o.location = loc
    o.data.materials.append(m)
    _only(o)
    bpy.ops.object.convert(target='MESH')
    o = act(bpy.context.object)
    o.name = name
    # use_fill_caps generates the end faces on their own duplicated rim verts,
    # so every converted sweep is technically a bag of unsealed shells. Welding
    # closes them; without this a tube-only asset audits ~24 open edges per end.
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    smooth_angle(o, 50)
    parent(o, par)
    return o


def spring(name, r, h, turns, wire, loc, m, rot=(0, 0, 0), par=None, ppt=12):
    n = max(8, int(turns * ppt))
    pts = []
    for k in range(n + 1):
        t = k / float(n)
        a = t * turns * TAU
        pts.append((r * math.cos(a), r * math.sin(a), t * h - h / 2.0))
    o = tube(name, pts, wire, m, res=2, par=par)
    q = Euler(rot, 'XYZ').to_matrix()
    for v in o.data.vertices:
        w = q @ v.co
        v.co = w + Vector(loc)
    return o


def bellows(name, r, n, pitch, loc, m, par=None, rot=(0, 0, 0)):
    """Corrugated expansion joint — a stack of real tori, not a ridged cylinder."""
    objs = []
    for k in range(n):
        t = ring("blw_%d_%d" % (k, 0), r, r * 0.30, (0, 0, k * pitch - (n - 1) * pitch / 2.0),
                 m, maj=16, mino=6, par=None)
        objs.append(t)
    rod("blw_core", r * 0.86, n * pitch, (0, 0, 0), m, verts=16, br=0.0, par=None)
    objs.append(bpy.context.object)
    o = join(objs, name)
    o.location = loc
    o.rotation_euler = rot
    _only(o)
    bpy.ops.object.transform_apply(location=True, rotation=True)
    parent(o, par)
    return o


# ------------------------------------------------------------- fasteners
def _q(axis):
    return Vector(axis).to_track_quat('Z', 'Y')


def boltring(name, center, axis, radius, n, m, br=0.022, bh=0.02, phase=0.0, par=None):
    objs = []
    q = _q(Vector(axis))
    for k in range(n):
        a = phase + k / n * TAU
        p = Vector(center) + q @ Vector((radius * math.cos(a), radius * math.sin(a), 0))
        bpy.ops.mesh.primitive_cylinder_add(radius=br, depth=bh, location=p, vertices=6)
        o = bpy.context.object
        o.rotation_euler = q.to_euler()
        o.data.materials.append(m)
        objs.append(o)
    r = join(objs, name)
    parent(r, par)
    return r


def boltrow(name, p0, p1, n, m, br=0.02, bh=0.018, normal=(0, 0, 1), par=None):
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


def boltgrid(name, origin, u, v, nu, nv, m, du, dv, br=0.018, bh=0.016, par=None):
    """Fastener field on an arbitrary plane — corner bolts for access panels."""
    O = Vector(origin)
    U = Vector(u)
    V = Vector(v)
    objs = []
    for i in range(nu):
        for j in range(nv):
            p = O + U * (i * du) + V * (j * dv)
            bpy.ops.mesh.primitive_cylinder_add(radius=br, depth=bh, location=p, vertices=6)
            o = bpy.context.object
            o.rotation_euler = U.normalized().to_track_quat('Z', 'Y').to_euler()
            o.data.materials.append(m)
            objs.append(o)
    r = join(objs, name)
    parent(r, par)
    return r


# ============================================================================
#  mesh surgery
# ============================================================================
def fix_slots(o, m=None):
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


def flat(items):
    out = []
    for it in items:
        if it is None:
            continue
        if isinstance(it, (list, tuple)):
            out.extend(flat(it))
        else:
            out.append(it)
    return out


def meshes(items):
    return [o for o in flat(items) if o.type == 'MESH']


def join(objs, name):
    objs = flat(objs)
    if not objs:
        return None
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        if o.name not in bpy.context.view_layer.objects:
            link(o)
        o.select_set(True)
    act(objs[0])
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    fix_slots(o)
    return o


def boolean_diff(o, cutters, keep=False):
    for c in cutters:
        md = o.modifiers.new("bs", 'BOOLEAN')
        md.operation = 'DIFFERENCE'
        md.object = c
        md.solver = 'EXACT'
        _only(o)
        bpy.ops.object.modifier_apply(modifier=md.name)
        if not keep:
            bpy.data.objects.remove(c, do_unlink=True)
    fix_slots(o)
    return o


def boolean_union(o, adders):
    for c in adders:
        md = o.modifiers.new("bu", 'BOOLEAN')
        md.operation = 'UNION'
        md.object = c
        md.solver = 'EXACT'
        _only(o)
        bpy.ops.object.modifier_apply(modifier=md.name)
        bpy.data.objects.remove(c, do_unlink=True)
    fix_slots(o)
    return o


def inset_faces(o, dist=0.02, mat_new=None, sel=None):
    """Recede a face set to make a real panel gap (a groove, not a painted line).
    `sel` is a predicate(polygon)->bool. Returns the newly created inner faces."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    faces = [f for f in bm.faces if sel is None or sel(_FaceProxy(f, o))]
    res = bmesh.ops.inset_region(bm, faces=faces, thickness=dist, depth=-dist,
                                 use_even_offset=True)
    inner = [g for g in res.get('faces', []) if isinstance(g, bmesh.types.BMFace)]
    if mat_new is not None and inner:
        slot = None
        for i, s in enumerate(o.data.materials):
            if s is mat_new:
                slot = i
                break
        if slot is None:
            o.data.materials.append(mat_new)
            slot = len(o.data.materials) - 1
        me = o.data
        bm.to_mesh(me)
        bm.free()
        # tag the recessed floor dark
        for f in inner:
            pass
        return slot
    bm.to_mesh(o.data)
    bm.free()
    return None


class _FaceProxy(object):
    __slots__ = ('index', 'normal', 'center', 'co')

    def __init__(self, f, o):
        self.index = f.index
        self.normal = f.normal
        self.center = f.calc_center_median()
        self.co = o.matrix_world @ self.center


def reassign(o, pred, m, slot_only_new=True, keep=None):
    """Assign material `m` to every polygon matching pred(poly) -> bool.
    poly gets .center (world) and .normal (world) already transformed.
    `keep` is a set of materials the weathering passes must never overwrite —
    emissive optics and hazard markings in particular."""
    me = o.data
    if m not in [s.material for s in o.material_slots]:
        me.materials.append(m)
    idx = [i for i, s in enumerate(o.material_slots) if s.material is m][0]
    kept = {i for i, s in enumerate(o.material_slots) if s.material in (keep or ())}
    mw = o.matrix_world
    n = 0
    for p in me.polygons:
        if p.material_index in kept:
            continue
        c = mw @ p.center
        nn = (mw.to_3x3() @ p.normal).normalized()
        if pred(p, c, nn):
            p.material_index = idx
            n += 1
    return n


# every emissive / marked material: weathering passes must leave these alone
EMISSIVE_SLOTS = None


def _emissive():
    global EMISSIVE_SLOTS
    if EMISSIVE_SLOTS is None:
        EMISSIVE_SLOTS = {v for v in P.values() if v.get("_emis", 0.0)}
    return EMISSIVE_SLOTS


def dust_top(o, m=None, zmin=-1e9, min_nz=0.62, keep=None):
    """Weathering pass 1: a Mars-dust film on every substantially upward face
    above zmin. Real per-face slot assignment, so it survives into glTF."""
    m = m or P["dust"]
    k = _emissive() | set(keep or ())
    return reassign(o, lambda p, c, nn: c.z > zmin and nn.z > min_nz, m, keep=k)


def scuff_low(o, m=None, zmax=1e9, max_nz=0.35, keep=None):
    """Weathering pass 2: scuffed, grit-blasted metal everywhere the dust
    film cannot sit — the vertical and downward faces of the lower structure."""
    m = m or P["worn"]
    k = _emissive() | set(keep or ())
    return reassign(o, lambda p, c, nn: c.z < zmax and nn.z < max_nz, m, keep=k)


def soot_back(o, m=None, ygt=None, zmax=1e9, keep=None):
    m = m or P["soot"]
    k = _emissive() | set(keep or ())
    return reassign(o, lambda p, c, nn: (ygt is None or c.y > ygt) and c.z < zmax, m,
                    keep=k)


def recolor(o, old, new):
    """Swap one slot for another on an already-joined mesh."""
    for i, s in enumerate(o.material_slots):
        if s.material is old:
            o.material_slots[i].material = new
            return True
    return False


# ============================================================================
#  composite greebles — the things that make hard surface read as engineered
# ============================================================================
def hatch(name, loc, r, m_body, m_bolt, m_handle, axis=(0, 0, 1), par=None,
          bolts=8, flat=True):
    """Bolted pressure hatch: recessed rim, raised door, dog ring, handle."""
    q = _q(Vector(axis))
    rot = q.to_euler()
    parts = []
    parts.append(rod("%s_collar" % name, r * 1.16, 0.055, loc, m_body, rot=rot,
                     verts=24, br=0.012, par=par))
    off = q @ Vector((0, 0, r * 0.045))
    p2 = Vector(loc) + off
    parts.append(rod("%s_door" % name, r, 0.075, p2, m_body, rot=rot, verts=24,
                     br=0.018, par=par))
    p3 = Vector(loc) + q @ Vector((0, 0, r * 0.075))
    parts.append(boltring("%s_bolts" % name, p3, axis, r * 0.86, bolts, m_bolt,
                          br=max(0.014, r * 0.075), bh=max(0.012, r * 0.05), par=par))
    parts.append(ring("%s_seam" % name, r * 1.02, max(0.010, r * 0.045),
                      Vector(loc) + q @ Vector((0, 0, r * 0.055)), m_bolt,
                      maj=24, mino=6, rot=rot, par=par))
    hp = Vector(loc) + q @ Vector((0, 0, r * 0.115))
    parts.append(rod("%s_stem" % name, r * 0.10, r * 0.30, hp, m_handle, rot=rot,
                     verts=10, br=0.0, par=par))
    for k in range(3):
        a = k / 3.0 * TAU
        tip = Vector(loc) + q @ Vector((r * 0.34 * math.cos(a), r * 0.34 * math.sin(a),
                                        r * 0.24))
        parts.append(rod("%s_spoke%d" % (name, k), r * 0.055, r * 0.30,
                         (tip + hp) / 2.0, m_handle,
                         rot=(tip - hp).to_track_quat('Z', 'Y').to_euler(),
                         verts=8, br=0.0, par=par))
    return parts


def louvers(name, loc, w, h, n, m, tilt=0.62, axis='y', thick=0.012, par=None):
    """Angered ventilation slats in a recessed frame — real geometry."""
    parts = []
    for k in range(n):
        z = loc[2] - h / 2 + (k + 0.5) * h / n
        if axis == 'y':
            parts.append(pbox("%s_%d" % (name, k), w, thick, h / n * 0.62,
                              (loc[0], loc[1], z), m, rot=(tilt, 0, 0), par=par))
        else:
            parts.append(pbox("%s_%d" % (name, k), thick, w, h / n * 0.62,
                              (loc[0], loc[1], z), m, rot=(0, tilt, 0), par=par))
    return parts


def ladder(name, x, y, z0, z1, m_side, m_rung, width=0.42, par=None, cage=False,
           cage_from=None, rot_z=0.0):
    """Ship's ladder: flat-bar sides with real rungs, kickers and bolt feet.
    Optional OSHA-style safety cage with hooped bands and vertical straps."""
    parts = []
    L = z1 - z0
    for s in (-1, 1):
        if abs(rot_z) < 1e-6:
            parts.append(pbox("%s_side%d" % (name, s), 0.045, 0.022, L,
                              (x + s * width / 2, y, z0 + L / 2), m_side, par=par))
        else:
            o = pbox("%s_side%d" % (name, s), 0.045, 0.022, L,
                     (s * width / 2, 0, L / 2), m_side, par=None)
            o.location = (x * math.cos(rot_z) - (s * width / 2) * math.sin(rot_z),
                          x * math.sin(rot_z) + (s * width / 2) * math.cos(rot_z), z0)
            o.rotation_euler = (0, 0, rot_z)
            _only(o)
            bpy.ops.object.transform_apply(location=True, rotation=True)
            parent(o, par)
            parts.append(o)
    nr = max(2, int(L / 0.30))
    for k in range(nr + 1):
        z = z0 + (k + 0.5) * L / (nr + 1)
        if abs(rot_z) < 1e-6:
            parts.append(rod("%s_rung%d" % (name, k), 0.016, width, (x, y, z), m_rung,
                             rot=(0, math.pi / 2, 0), verts=8, br=0.0, par=par))
        else:
            r = rod("%s_rung%d" % (name, k), 0.016, width, (0, 0, 0), m_rung,
                    rot=(0, math.pi / 2, rot_z), verts=8, br=0.0, par=None)
            r.location = (x * math.cos(rot_z) - 0 * math.sin(rot_z),
                          x * math.sin(rot_z), z)
            _only(r)
            bpy.ops.object.transform_apply(location=True, rotation=True)
            parent(r, par)
            parts.append(r)
    if cage:
        zc = cage_from if cage_from is not None else z0 + 1.2
        nb = max(2, int((z1 - zc) / 0.9))
        for k in range(nb + 1):
            z = zc + k * (z1 - zc) / nb
            parts.append(ring("%s_hoop%d" % (name, k), width * 0.92, 0.014,
                              (x, y, z), m_rung, maj=14, mino=5,
                              rot=(math.pi / 2, 0, rot_z), par=par))
        for s in (-1, 1, 0):
            a = math.pi / 2 + s * 1.05 + rot_z
            parts.append(pbox("%s_strap%d" % (name, s), 0.02, 0.02, z1 - zc,
                              (x + math.cos(a) * width * 0.92,
                               y + math.sin(a) * width * 0.92, (z1 + zc) / 2),
                              m_rung, rot=(0, 0, rot_z), par=par))
    return parts


def pipe_run(name, pts, r, m, m_flange, par=None, flange_at=None, clamp_at=None,
             res=2):
    """A pipe run with welded flanges at the listed point indices and clamp
    bands at the listed arc-length fractions. Everything is real geometry."""
    o = tube(name, pts, r, m, res=res, par=par)
    parts = [o]
    n = len(pts)
    if flange_at:
        for i in flange_at:
            if i >= n:
                continue
            p = Vector(pts[i])
            if i + 1 < n:
                d = Vector(pts[i + 1]) - p
            else:
                d = p - Vector(pts[i - 1])
            if d.length < 1e-6:
                continue
            q = d.normalized().to_track_quat('Z', 'Y')
            fl = prism("%s_fl%d" % (name, i), r * 1.65, r * 0.55, p, m_flange,
                       sides=16, rot=q.to_euler(), par=par, br=r * 0.14)
            parts.append(fl)
            parts.append(boltring("%s_fb%d" % (name, i), p + q @ Vector((0, 0, r * 0.34)),
                                  d.normalized(), r * 1.28, 6, m_flange,
                                  br=r * 0.16, bh=r * 0.22, par=par))
    if clamp_at:
        # walk the polyline to find the clamp stations
        segs = []
        tot = 0.0
        for i in range(n - 1):
            L = (Vector(pts[i + 1]) - Vector(pts[i])).length
            segs.append(L)
            tot += L
        for f in clamp_at:
            target = f * tot
            acc = 0.0
            for i, L in enumerate(segs):
                if acc + L >= target or i == len(segs) - 1:
                    t = (target - acc) / max(L, 1e-6)
                    p = Vector(pts[i]).lerp(Vector(pts[i + 1]), max(0.0, min(1.0, t)))
                    d = Vector(pts[i + 1]) - Vector(pts[i])
                    q = d.normalized().to_track_quat('Z', 'Y')
                    parts.append(ring("%s_cl%g" % (name, f), r * 1.28, r * 0.30, p,
                                      m_flange, maj=14, mino=6, rot=q.to_euler(),
                                      par=par))
                    break
                acc += L
    return parts


def crossbrace(name, p0, p1, p2, p3, r, m, par=None, verts=8):
    """X brace between two quads' corners — the lattice member."""
    a = Vector(p0)
    b = Vector(p1)
    c = Vector(p2)
    d = Vector(p3)
    out = []
    for u, v in ((a, d), (b, c)):
        w = v - u
        out.append(rod(name + "_x", r, w.length, tuple((u + v) / 2), m,
                       rot=w.to_track_quat('Z', 'Y').to_euler(), verts=verts,
                       br=0.0, par=par))
    return out


def gusset(name, p, u, v, size, m, par=None, t=0.016):
    """Triangular gusset plate at a strut intersection."""
    pts = [(0, 0), (size, 0), (0, size * 0.82)]
    U = Vector(u).normalized()
    V = Vector(v).normalized()
    N = U.cross(V).normalized()
    M = Matrix((U, V, N)).transposed().to_4x4()
    o = extrude_poly(name, pts, t, m, (0, 0, 0), par=None, smooth=30)
    for vert in o.data.vertices:
        vert.co = M @ vert.co + Vector(p)
    parent(o, par)
    return o


def panel_field(name, loc, w, h, nx, ny, m_face, m_seam, axis='z', par=None,
                depth=0.014, gap=0.016, inset=0.006):
    """A built-up panel wall: individual plates with real reveal gaps between
    them and a recessed seam floor. This is what replaces 'a box with lines'."""
    parts = []
    px = w / nx
    py = h / ny
    for i in range(nx):
        for j in range(ny):
            cx = loc[0] + (-w / 2 + (i + 0.5) * px)
            cy = loc[1] + (-h / 2 + (j + 0.5) * py)
            cz = loc[2]
            sx = px - gap
            sy = py - gap
            if axis == 'z':
                parts.append(rbox("%s_p%d_%d" % (name, i, j), sx, sy, depth,
                                  (cx, cy, cz + depth / 2), m_face,
                                  bevel_r=min(sx, sy) * 0.10, segs=1, par=par,
                                  smooth=32))
                # seam floor behind the reveal
                parts.append(pbox("%s_s%d_%d" % (name, i, j), px, py, depth * 0.4,
                                  (cx, cy, cz - depth * 0.3), m_seam, par=par))
            elif axis == 'x':
                parts.append(rbox("%s_p%d_%d" % (name, i, j), depth, sx, sy,
                                  (cx, cz + depth / 2, cy), m_face,
                                  bevel_r=min(sx, sy) * 0.10, segs=1, par=par,
                                  smooth=32))
                parts.append(pbox("%s_s%d_%d" % (name, i, j), depth * 0.4, px, py,
                                  (cx - depth * 0.3, cz, cy), m_seam, par=par))
            else:
                parts.append(rbox("%s_p%d_%d" % (name, i, j), sx, depth, sy,
                                  (cx, cz + depth / 2, cy), m_face,
                                  bevel_r=min(sx, sy) * 0.10, segs=1, par=par,
                                  smooth=32))
                parts.append(pbox("%s_s%d_%d" % (name, i, j), px, depth * 0.4, py,
                                  (cx, cz - depth * 0.3, cy), m_seam, par=par))
    return parts


def bolted_flange(name, loc, axis, R, m, m_bolt, par=None, n=12, t=0.05):
    q = _q(Vector(axis))
    a = [rod("%s_ring" % name, R, t, loc, m, rot=q.to_euler(), verts=24,
             br=t * 0.22, par=par)]
    a.append(boltring("%s_bolts" % name, Vector(loc) + q @ Vector((0, 0, t * 0.62)),
                      axis, R * 0.86, n, m_bolt, br=R * 0.055, bh=t * 0.5, par=par))
    return a


def rail_ring(name, cx, cy, z, R, m_post, m_rail, n=16, h=1.0, par=None,
              toeboard=True):
    """Guard rail on a platform edge: posts, top rail, mid rail, toe board."""
    parts = []
    for k in range(n):
        a = k / n * TAU
        px, py = cx + R * math.cos(a), cy + R * math.sin(a)
        parts.append(pbox("%s_post%d" % (name, k), 0.05, 0.05, h, (px, py, z + h / 2),
                          m_post, par=par))
    for fz, fr in ((h, 0.028), (h * 0.52, 0.022)):
        parts.append(ring("%s_rail%g" % (name, fz), R, fr, (cx, cy, z + fz), m_rail,
                          maj=max(24, n * 2), mino=6, par=par))
    if toeboard:
        parts.append(ring("%s_toe" % (name), R, 0.06, (cx, cy, z + 0.05), m_post,
                          maj=max(24, n * 2), mino=4, rot=(0, 0, 0), par=par))
    return parts


def grating(name, cx, cy, z, w, d, m, par=None, nx=8, ny=8, t=0.02):
    """Open mesh floor grating — bars, not a solid slab, so you see through it."""
    parts = []
    for i in range(nx):
        x = cx - w / 2 + (i + 0.5) * w / nx
        parts.append(pbox("%s_x%d" % (name, i), w / nx * 0.34, d, t, (x, cy, z), m,
                          par=par))
    for j in range(ny):
        y = cy - d / 2 + (j + 0.5) * d / ny
        parts.append(pbox("%s_y%d" % (name, j), w, d / ny * 0.30, t * 0.7,
                          (cx, y, z - t * 0.5), m, par=par))
    return parts


def hazard_band(name, cx, cy, cz, length, h, n, m_a, m_b, axis='x', par=None,
                thick=0.012):
    """Alternating diagonal hazard chevrons built from geometry."""
    parts = []
    step = length / n
    for i in range(n):
        m = m_a if i % 2 == 0 else m_b
        if axis == 'x':
            x = cx - length / 2 + (i + 0.5) * step
            parts.append(pbox("%s_%d" % (name, i), step * 0.94, thick, h,
                              (x, cy, cz), m, rot=(0, 0, 0), par=par))
        elif axis == 'y':
            y = cy - length / 2 + (i + 0.5) * step
            parts.append(pbox("%s_%d" % (name, i), thick, step * 0.94, h,
                              (cx, y, cz), m, par=par))
        else:
            z = cz - length / 2 + (i + 0.5) * step
            parts.append(pbox("%s_%d" % (name, i), thick, h, step * 0.94,
                              (cx, cy, z), m, par=par))
    return parts


def radial_slats(name, cx, cy, cz, R0, R1, n, w, m, par=None, tilt=0.0):
    """Turbine / vane / louver ring built from individual airfoils."""
    parts = []
    for k in range(n):
        a = k / n * TAU
        o = pbox("%s_%d" % (name, k), R1 - R0, w, 0.014, (0, 0, 0), m, par=None)
        o.rotation_euler = (0, tilt, a)
        _only(o)
        bpy.ops.object.transform_apply(rotation=True)
        o.location = (cx + math.cos(a) * (R0 + R1) / 2,
                      cy + math.sin(a) * (R0 + R1) / 2, cz)
        parent(o, par)
        parts.append(o)
    return parts


def letter_row(name, text, loc, h, m, depth=0.02, dirv=(1, 0, 0), up=(0, 0, 1),
               par=None, gapf=0.24):
    """Extruded raised lettering built from block glyph geometry — a real
    decal alternative that survives at 60 m as a mass, and rewards a close look."""
    # 3x5 bitmap glyphs, drawn as raised blocks
    G = {
        'A': ('..#..', '.#.#.', '#...#', '#####', '#...#'),
        'B': ('####.', '#...#', '####.', '#...#', '####.'),
        'C': ('.###.', '#...#', '#....', '#...#', '.###.'),
        'D': ('####.', '#...#', '#...#', '#...#', '####.'),
        'E': ('#####', '#....', '####.', '#....', '#####'),
        'F': ('#####', '#....', '####.', '#....', '#....'),
        'G': ('.###.', '#....', '#.###', '#...#', '.###.'),
        'H': ('#...#', '#...#', '#####', '#...#', '#...#'),
        'I': ('#####', '..#..', '..#..', '..#..', '#####'),
        'K': ('#...#', '#..#.', '###..', '#..#.', '#...#'),
        'L': ('#....', '#....', '#....', '#....', '#####'),
        'M': ('#...#', '##.##', '#.#.#', '#...#', '#...#'),
        'N': ('#...#', '##..#', '#.#.#', '#..##', '#...#'),
        'O': ('.###.', '#...#', '#...#', '#...#', '.###.'),
        'P': ('####.', '#...#', '####.', '#....', '#....'),
        'R': ('####.', '#...#', '####.', '#..#.', '#...#'),
        'S': ('.####', '#....', '.###.', '....#', '####.'),
        'T': ('#####', '..#..', '..#..', '..#..', '..#..'),
        'U': ('#...#', '#...#', '#...#', '#...#', '.###.'),
        'V': ('#...#', '#...#', '#...#', '.#.#.', '..#..'),
        'W': ('#...#', '#...#', '#.#.#', '##.##', '#...#'),
        'X': ('#...#', '.#.#.', '..#..', '.#.#.', '#...#'),
        'Y': ('#...#', '.#.#.', '..#..', '..#..', '..#..'),
        'Z': ('#####', '...#.', '..#..', '.#...', '#####'),
        '0': ('.###.', '#..##', '#.#.#', '##..#', '.###.'),
        '1': ('..#..', '.##..', '..#..', '..#..', '.###.'),
        '2': ('####.', '....#', '..##.', '.#...', '#####'),
        '3': ('####.', '....#', '.###.', '....#', '####.'),
        '4': ('#...#', '#...#', '#####', '....#', '....#'),
        '5': ('#####', '#....', '####.', '....#', '####.'),
        '7': ('#####', '...#.', '..#..', '.#...', '.#...'),
        '8': ('.###.', '#...#', '.###.', '#...#', '.###.'),
        '9': ('.###.', '#...#', '.####', '....#', '.###.'),
        ' ': ('.....', '.....', '.....', '.....', '.....'),
        '-': ('.....', '.....', '#####', '.....', '.....'),
        '.': ('.....', '.....', '.....', '.....', '..#..'),
    }
    D = Vector(dirv).normalized()
    U = Vector(up).normalized()
    N = D.cross(U).normalized()
    cw = h * 0.6
    step = cw + h * gapf * 0.5
    parts = []
    O = Vector(loc)
    col = 0
    for ch in text:
        rows = G.get(ch.upper(), G[' '])
        for r, row in enumerate(rows):
            run = None
            for cidx, v in enumerate(list(row) + ['#']):
                on = (v == '#')
                if on and run is None:
                    run = cidx
                if not on and run is not None:
                    w = (cidx - run) * (cw / 5.0)
                    x = run * (cw / 5.0)
                    z = (4 - r) * (h / 5.0)
                    ctr = O + D * (col * step + x + w / 2) + U * (z + h / 10.0)
                    o = pbox("%s_%d_%d%d" % (name, col, r, run), 1, 1, 1, (0, 0, 0), m)
                    M = Matrix((D * (w / 2), U * (h / 10.0), N * (depth / 2))).transposed().to_4x4()
                    for vv in o.data.vertices:
                        vv.co = M @ vv.co + ctr
                    _only(o)
                    bpy.ops.object.transform_apply(location=False, rotation=False,
                                                   scale=False)
                    parts.append(o)
                    run = None
        col += 1
    if not parts:
        return []
    j = join(parts, name)
    parent(j, par)
    return [j]


# ============================================================================
#  validation + export
# ============================================================================
def tri_count(root):
    n = 0
    for o in [root] + list(root.children_recursive):
        if o.type == 'MESH':
            n += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return n


def audit(name, root):
    """Honest self-check: non-manifold edges, zero-area faces, loose verts and
    coincident coplanar triangle pairs (the z-fight generators)."""
    stats = dict(tris=0, nonman=0, open=0, zero=0, loose=0, coplanar=0, slots=set(),
                 meshes=0, hotspots=[])
    for o in [root] + list(root.children_recursive):
        if o.type != 'MESH':
            continue
        stats['meshes'] += 1
        for s in o.material_slots:
            if s.material:
                stats['slots'].add(s.material.name)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        stats['tris'] += sum(len(f.verts) - 2 for f in bm.faces)
        stats['nonman'] += sum(1 for e in bm.edges if len(e.link_faces) > 2)
        stats['open'] += sum(1 for e in bm.edges if len(e.link_faces) < 2)
        stats['zero'] += sum(1 for f in bm.faces if f.calc_area() < 1e-8)
        stats['loose'] += sum(1 for v in bm.verts if not v.link_faces)
        for e in bm.edges:
            if len(e.link_faces) > 2:
                stats.setdefault('nm_dbg', []).append(
                    (o.name + "|faces=%d" % len(e.link_faces), len(e.link_faces),
                     tuple(round(q, 3) for q in e.verts[0].co),
                     tuple(round(q, 3) for q in e.verts[1].co)))
        hash_ = {}
        for f in bm.faces:
            c = f.calc_center_median()
            nrm = f.normal
            if nrm.length < 1e-7:
                continue
            nrm = nrm.normalized()
            key = (round(c.x / 0.004), round(c.y / 0.004), round(c.z / 0.004))
            hash_.setdefault(key, []).append((nrm, c))
        for k, lst in hash_.items():
            if len(lst) < 2:
                continue
            for i in range(len(lst)):
                for j in range(i + 1, len(lst)):
                    if abs(lst[i][0].dot(lst[j][0])) > 0.9995:
                        stats['coplanar'] += 1
                        stats['hotspots'].append(
                            (tuple(round(q, 3) for q in lst[i][1]),
                             tuple(round(q, 3) for q in lst[j][1])))
        bm.free()
    if stats.get('nm_dbg'):
        agg = {}
        for nm_, nf, a, b in stats['nm_dbg']:
            agg.setdefault(nf, []).append((a, b))
        byn = {}
        for nm_, nf, a, b in stats['nm_dbg']:
            byn[nm_] = byn.get(nm_, 0) + 1
        print("      NONMANIFOLD edges by mesh: %s" % (byn,))
    stats['slots'] = sorted(stats['slots'])
    print("AUDIT %-14s tris=%6d meshes=%3d slots=%2d nonmanifold=%d openedges=%d "
          "zeroarea=%d looseverts=%d coincident_coplanar_pairs=%d"
          % (name, stats['tris'], stats['meshes'], len(stats['slots']),
             stats['nonman'], stats['open'], stats['zero'], stats['loose'],
             stats['coplanar']))
    print("      slots: %s" % ", ".join(stats['slots']))
    if stats['hotspots']:
        seen = []
        for a, b in stats['hotspots']:
            dup = False
            for sa, sb in seen:
                if (abs(a[0] - sa[0]) + abs(a[1] - sa[1]) + abs(a[2] - sa[2])
                        + abs(b[0] - sb[0]) + abs(b[1] - sb[1]) + abs(b[2] - sb[2])) < 0.10:
                    dup = True
                    break
            if not dup:
                seen.append((a, b))
        print("      ZFIGHT hotspots (coincident face centres A | B):")
        for a, b in seen[:14]:
            print("        A=%s | B=%s" % (a, b))
    return stats


def cleanup(o):
    """Enforce the closed / non-degenerate manifold contract the shadow pass
    needs. Order matters: weld doubles, dissolve slivers, delete genuine
    zero-area faces, then FILL anything that opened up so every shell stays
    watertight, and finally unify normals."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
    dead = [f for f in bm.faces if f.calc_area() < 1e-8]
    if dead:
        bmesh.ops.delete(bm, geom=dead, context='EDGES')
    loose = [v for v in bm.verts if not v.link_faces] + \
            [e for e in bm.edges if not e.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.holes_fill(bm, edges=bm.edges, sides=14)
    # any edge still shared by >2 faces is a weld between two interpenetrating
    # shells: crack it apart along that edge and re-cap the shells so each one
    # is independently watertight (Blender 5.x has no unsplit_edges).
    for _ in range(4):
        bad = [e for e in bm.edges if len(e.link_faces) > 2]
        if not bad:
            break
        if _CLEANUP_DEBUG:
            for e in bad[:12]:
                print("  NM %s %s %s nf=%d" % (o.name,
                      tuple(round(q, 4) for q in e.verts[0].co),
                      tuple(round(q, 4) for q in e.verts[1].co), len(e.link_faces)))
        bmesh.ops.split_edges(bm, edges=bad)
        bmesh.ops.holes_fill(bm, edges=bm.edges, sides=14)
        dead = [f for f in bm.faces if f.calc_area() < 1e-8]
        if dead:
            bmesh.ops.delete(bm, geom=dead, context='EDGES')
    loose = [v for v in bm.verts if not v.link_faces] + \
            [e for e in bm.edges if not e.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # drop any face that ended up facing backwards after the repair pass
    bmesh.ops.reverse_faces(bm, faces=[f for f in bm.faces if f.calc_area() < 0])
    bm.to_mesh(o.data)
    bm.free()
    return o


def snap_datum(root):
    """Guarantee the runtime contract: XY AABB centred on the origin and the
    lowest point exactly on Z=0. Prints the shift so nothing is silent."""
    bpy.context.view_layer.update()
    mn, mx = extents(root)
    dx = -(mn.x + mx.x) / 2.0
    dy = -(mn.y + mx.y) / 2.0
    dz = -mn.z
    if abs(dx) < 1e-4 and abs(dy) < 1e-4 and abs(dz) < 1e-4:
        print("   datum: already centred, base on Z=0")
        return (0.0, 0.0, 0.0)
    for o in root.children_recursive:
        if o.type in {'MESH', 'EMPTY'}:
            o.location = (o.location.x + dx, o.location.y + dy, o.location.z + dz)
    bpy.context.view_layer.update()
    print("   datum shift applied: dx=%+.3f dy=%+.3f dz=%+.3f" % (dx, dy, dz))
    return (dx, dy, dz)


def extents(root):
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    for o in [root] + list(root.children_recursive):
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def export(root, fname, label):
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
    mn, mx = extents(root)
    print("EXPORTED %-22s -> %s" % (fname, path))
    print("   blender AABB x[%.2f .. %.2f]  y[%.2f .. %.2f]  z[%.2f .. %.2f]"
          % (mn.x, mx.x, mn.y, mx.y, mn.z, mx.z))
    print("   centre x=%.2f y=%.2f  dims %.2f x %.2f x %.2f"
          % ((mn.x + mx.x) / 2, (mn.y + mx.y) / 2,
             mx.x - mn.x, mx.y - mn.y, mx.z - mn.z))
    print("   tris=%d" % tri_count(root))


BUILDERS = {}


def builder(fn):
    BUILDERS[fn.__name__] = fn
    return fn


# ============================================================================
#  BUILDERS
# ============================================================================

# ============================================================================
#  shared helpers for the last three landmarks
# ============================================================================
def obase(name, c, su, sv, sd, U, V, m, par=None, segs=8):
    """A brick/panel in an arbitrary oriented frame: U and V are two of its
    axes, the third is their cross product. Used for curved walls, tapered
    cores and anything that is not axis-aligned."""
    o = pbox(name, 1, 1, 1, (0, 0, 0), m, par=None)
    Uv = Vector(U).normalized()
    Vv = Vector(V).normalized()
    Nv = Uv.cross(Vv).normalized()
    M = Matrix((Uv * su, Vv * sv, Nv * sd)).transposed().to_4x4()
    ctr = Vector(c) - (Uv * su + Vv * sv + Nv * sd) / 2.0
    for v in o.data.vertices:
        v.co = M @ v.co + ctr
    parent(o, par)
    return o


def obrick(name, c, su, sv, sd, ang, m, par=None):
    """obase with the plan frame rotated `ang` about Z: U = tangent-ish."""
    ca, sa = math.cos(ang), math.sin(ang)
    return obase(name, c, su, sv, sd, (sa, -ca, 0), (ca, sa, 0), m, par=par)


def rect_lattice(name, cx, cy, hx0, hy0, hx1, hy1, zb, zt, bays, m_memb, m_brace,
                 m_node=None, par=None, chord_r=0.075, brace_r=0.042, ring=True,
                 xbr=True, skip_face=None):
    """Tapered rectangular-plan lattice: four corner chords, a ring member at
    every bay and a crossed brace on each face — every member a solid round."""
    parts = []

    def corner(i, k):
        f = i / float(bays)
        hx = hx0 + (hx1 - hx0) * f
        hy = hy0 + (hy1 - hy0) * f
        sx, sy = ((1, -1), (1, 1), (-1, 1), (-1, -1))[k]
        return Vector((cx + sx * hx, cy + sy * hy, zb + (zt - zb) * f))

    for k in range(4):
        for i in range(bays):
            p0, p1 = corner(i, k), corner(i + 1, k)
            d = p1 - p0
            parts.append(rod("%s_chord%d_%d" % (name, k, i), chord_r, d.length,
                             tuple((p0 + p1) / 2), m_memb,
                             rot=d.to_track_quat('Z', 'Y').to_euler(), verts=10,
                             br=chord_r * 0.13, par=par))
    for i in range(bays + 1):
        if ring:
            for k in range(4):
                if skip_face and skip_face(i, k):
                    continue
                p0, p1 = corner(i, k), corner(i, (k + 1) % 4)
                d = p1 - p0
                parts.append(rod("%s_ring%d_%d" % (name, i, k), brace_r, d.length,
                                 tuple((p0 + p1) / 2), m_memb,
                                 rot=d.to_track_quat('Z', 'Y').to_euler(), verts=8,
                                 br=brace_r * 0.18, par=par))
        if xbr and i < bays:
            for k in range(4):
                a0, a1 = corner(i, k), corner(i, (k + 1) % 4)
                b0, b1 = corner(i + 1, k), corner(i + 1, (k + 1) % 4)
                pairs = ((a0, b1), (a1, b0)) if (i + k) % 2 == 0 else ((a0, b1),)
                for u, v in pairs:
                    d = v - u
                    parts.append(rod("%s_x%d_%d" % (name, i, k), brace_r * 0.85,
                                     d.length, tuple((u + v) / 2), m_brace,
                                     rot=d.to_track_quat('Z', 'Y').to_euler(),
                                     verts=8, br=0.0, par=par))
        if m_node is not None:
            for k in range(4):
                parts.append(ball("%s_node%d_%d" % (name, i, k), chord_r * 1.42,
                                  tuple(corner(i, k)), m_node, segs=8, par=par))
    return parts


def rect_rail(name, cx, cy, z, w, d, m_post, m_rail, par=None, h=1.02, n_x=4,
              n_y=2, toe=True):
    """Rectangular guard rail: posts on the two long runs, return posts on the
    ends, top + mid rails and a toe board. No duplicated corner posts."""
    parts = []
    for i in range(n_x + 1):
        x = cx - w / 2 + i * w / n_x
        for s in (-1, 1):
            parts.append(pbox("%s_px%d%d" % (name, i, s > 0), 0.05, 0.05, h,
                              (x, cy + s * d / 2, z + h / 2), m_post, par=par))
    for j in range(1, n_y):
        y = cy - d / 2 + j * d / n_y
        for s in (-1, 1):
            parts.append(pbox("%s_py%d%d" % (name, j, s > 0), 0.05, 0.05, h,
                              (cx + s * w / 2, y, z + h / 2), m_post, par=par))
    for fz in (h, h * 0.52):
        for s in (-1, 1):
            parts.append(pbox("%s_rx%d" % (name, s), w + 0.05, 0.042, 0.042,
                              (cx, cy + s * d / 2, z + fz), m_rail, par=par))
            parts.append(pbox("%s_ry%d" % (name, s), 0.042, d + 0.05, 0.042,
                              (cx + s * w / 2, cy, z + fz), m_rail, par=par))
    if toe:
        for s in (-1, 1):
            parts.append(pbox("%s_toex%d" % (name, s), w, 0.028, 0.13,
                              (cx, cy + s * (d / 2 - 0.014), z + 0.065), m_post,
                              par=par))
            parts.append(pbox("%s_toey%d" % (name, s), 0.028, d - 0.06, 0.13,
                              (cx + s * (w / 2 - 0.014), cy, z + 0.065), m_post,
                              par=par))
    return parts


def poly_arc(name, cx, cz, r, ry, y0, y1, n, m, par=None, tilt=1.0, res=2):
    """Sweep a round member along an elliptical arc in the (y, z) plane at x=cx:
    the greenhouse vault rib."""
    pts = []
    for k in range(n + 1):
        u = y0 + (y1 - y0) * k / float(n)
        pts.append((cx, r * math.sin(u), cz + ry * tilt * math.cos(u)))
    return tube(name, pts, 0.075, m, res=res, par=par)


def fan_blades(name, c, nrm, R0, R1, n, w, m, par=None, tilt=0.55):
    """A fan / propeller disc whose blades are individually pitched plates on an
    arbitrary axis — radial_slats only builds horizontal rings."""
    N = Vector(nrm).normalized()
    A1 = N.orthogonal().normalized()
    A2 = N.cross(A1).normalized()
    parts = []
    for k in range(n):
        a = k / float(n) * TAU
        rad = A1 * math.cos(a) + A2 * math.sin(a)
        tan = -A1 * math.sin(a) + A2 * math.cos(a)
        V = tan * math.cos(tilt) + N * math.sin(tilt)
        parts.append(obase("%s_%d" % (name, k),
                           tuple(Vector(c) + rad * (R0 + R1) / 2.0), R1 - R0, w,
                           0.014, rad, V, m, par=par))
    return parts
# ==== END INSERT BUILDERS HERE ====


# ============================================================================
#  7. CRYO_TANK — LOX/LCH4 cylindrical vessel with a 2:1 dome on a skirt

# ============================================================================
#  7. CRYO_TANK — LOX/LCH4 cylindrical vessel with a 2:1 dome on a skirt
#  target: x +/-2.70  y +/-2.10  z 0..10.10   (shipped: 5.40 x 4.20 x 10.10)
#  runtime: props.js `put('cryo_tank', tx, tz, 1.5, 0.5+i)` with a collider of
#  r 3.4 world (= 2.27 local) and a spark point just off the shell, so the
#  valve island lives on -x and the service face (manway / gauge / ladder) on +y.
# ============================================================================
@builder
def cryo_tank():
    root = empty("cryo_tank", (0, 0, 0))
    W = P["white"]; CREAM = P["cream"]; ALU = P["alu"]; MACH = P["alumach"]
    DARK = P["gunmetal"]; STEEL = P["steel"]; TI = P["titan"]; RUB = P["rubber"]
    CONC = P["concrete"]; INS = P["insul"]; ORANGE = P["orange"]
    CYAN = P["cyan"]; AMBER = P["amber"]; GL = P["lens"]; GRATE = P["grate"]
    WORN = P["worn"]; RED = P["red"]
    KEEP = {ORANGE, RED, CYAN, AMBER, GL, TI, W, CREAM, INS}
    A = []
    RT = 1.800                                 # shell radius
    ZB, ZS = 0.62, 7.68                        # shell bottom / top of straight run

    # ---- cast ring footing: curb, anchor cage, drainage scuppers, hazard kerb
    A.append(prism("footing", 2.02, 0.20, (0, 0, 0.10), CONC, sides=40, par=root,
                   br=0.030, segs=2))
    A.append(ring("footing_curb", 1.965, 0.055, (0, 0, 0.205), CONC, maj=44, mino=6,
                  par=root))
    for k in range(16):
        a = k / 16.0 * TAU + 0.10
        px, py = 1.86 * math.cos(a), 1.86 * math.sin(a)
        A.append(rod("anchor_%d" % k, 0.030, 0.20, (px, py, 0.30), STEEL, verts=10,
                     br=0.0, par=root))
        A.append(hexn("anchor_nut_%d" % k, 0.052, 0.036, (px, py, 0.40), MACH,
                      rot=(0, 0, a), par=root))
        A.append(ring("anchor_wash%d" % k, 0.042, 0.012, (px, py, 0.372), DARK,
                      maj=12, mino=4, par=root))
    for k in range(6):
        a = k / 6.0 * TAU + 0.52
        A.append(pbox("scupper_%d" % k, 0.14, 0.10, 0.080,
                      (1.975 * math.cos(a), 1.975 * math.sin(a), 0.100), DARK,
                      rot=(0, 0, a), par=root))
    for k in range(20):
        a = k / 20.0 * TAU
        A.append(pbox("kerb_%d" % k, 0.205, 0.055, 0.048,
                      (2.008 * math.cos(a), 2.008 * math.sin(a), 0.224),
                      ORANGE if k % 2 else DARK, rot=(0, 0, a), par=root))

    # ---- support skirt: eight channel legs on a ring beam, gusseted and bolted
    A.append(ring("ring_beam", 1.72, 0.078, (0, 0, 0.50), STEEL, maj=40, mino=6,
                  par=root))
    for k in range(8):
        a = k / 8.0 * TAU + math.pi / 8
        cx, cy = 1.60 * math.cos(a), 1.60 * math.sin(a)
        A.append(csection("leg_%d" % k, 0.54, 0.22, 0.30, 0.034, (cx, cy, 0.30),
                          DARK, rot=(0, 0, a), par=root))
        A.append(gusset("leg_gus_%d" % k, (cx * 1.03, cy * 1.03, 0.60),
                        (-math.sin(a), math.cos(a), 0), (0, 0, 1), 0.24, STEEL,
                        par=root, t=0.018))
        for s in (-1, 1):
            A.append(hexn("leg_bolt_%d%d" % (k, s), 0.030, 0.024,
                          (cx * 1.05 + s * 0.085 * -math.sin(a),
                           cy * 1.05 + s * 0.085 * math.cos(a), 0.235), MACH,
                          rot=(0, 0, a), par=root))

    # ---- pressure shell: a genuine solid of revolution with a 2:1 dome
    prof = [(0.0, ZB), (1.60, ZB), (RT, ZB + 0.24), (RT, ZS),
            (RT - 0.03, ZS + 0.44), (RT - 0.22, ZS + 0.88), (1.28, 8.98),
            (0.60, 9.20), (0.0, 9.26)]
    A.append(lathe("shell", prof, CREAM, (0, 0, 0), segs=56, par=root, smooth=42))

    # ---- four rolled insulation jackets, each strapped and riveted
    for i, zb in enumerate((1.30, 3.05, 4.80, 6.55)):
        hg = 1.05
        A.append(rod("jacket%d" % i, RT + 0.048, hg, (0, 0, zb + hg / 2), INS,
                     verts=56, br=0.022, segs=1, par=root))
        for zz in (zb + 0.07, zb + hg - 0.07):
            A.append(ring("jacket_strap%d_%g" % (i, zz), RT + 0.066, 0.026,
                          (0, 0, zz), MACH, maj=56, mino=5, par=root))
        for k in range(12):
            a = k / 12.0 * TAU + i * 0.26
            A.append(hexn("jacket_rivet%d_%d" % (i, k), 0.026, 0.018,
                          ((RT + 0.066) * math.cos(a), (RT + 0.066) * math.sin(a),
                           zb + hg / 2), DARK, rot=(0, 0, a), par=root))

    # ---- bare metal between the jackets: weld lands, stringers, girth welds
    for k in range(12):
        a = k / 12.0 * TAU + 0.13
        A.append(pbox("weld_seam%d" % k, 0.028, 0.016, ZS - ZB - 0.34,
                      ((RT + 0.013) * math.cos(a), (RT + 0.013) * math.sin(a),
                       (ZB + ZS) / 2 + 0.10), WORN, rot=(0, 0, a), par=root))
    for zz in (2.55, 4.30, 6.05, 7.42):
        A.append(ring("stringer_%g" % zz, RT + 0.022, 0.020, (0, 0, zz), STEEL,
                      maj=56, mino=5, par=root))
    for zz in (ZB + 0.26, 2.42, 4.18, 5.94, ZS - 0.12):
        A.append(ring("girth_%g" % zz, RT + 0.015, 0.014, (0, 0, zz), WORN, maj=56,
                      mino=4, par=root))

    # ---- dome hardware: burst disc, three PRVs, a frosted vent stack
    A += hatch("burst_disc", (0.0, 0.0, 9.245), 0.34, DARK, MACH, STEEL,
               axis=(0, 0, 1), par=root, bolts=12)
    for k in range(3):
        a = math.radians(28 + k * 120)
        ux, uy = math.cos(a), math.sin(a)
        p = Vector((1.00 * ux, 1.00 * uy, 9.02))
        d = Vector((ux * 0.34, uy * 0.34, 0.94)).normalized()
        q = d.to_track_quat('Z', 'Y')
        A.append(rod("prv_base_%d" % k, 0.118, 0.16, tuple(p), DARK,
                     rot=q.to_euler(), verts=16, br=0.014, par=root))
        A.append(rod("prv_body_%d" % k, 0.086, 0.30,
                     tuple(p + q @ Vector((0, 0, 0.22))), TI, rot=q.to_euler(),
                     verts=16, br=0.016, par=root))
        A.append(ring("prv_flange_%d" % k, 0.104, 0.018,
                      tuple(p + q @ Vector((0, 0, 0.085))), MACH, maj=16, mino=5,
                      rot=q.to_euler(), par=root))
        A.append(rod("prv_exit_%d" % k, 0.038, 0.24,
                     tuple(p + q @ Vector((0.15, 0, 0.36))), STEEL,
                     rot=((q.to_matrix() @ Matrix.Rotation(math.radians(74), 3, 'X'))
                          .to_euler()),
                     verts=10, br=0.0, par=root))
    A.append(rod("vent_stack", 0.156, 0.88, (0.60, -0.50, 9.32), STEEL, verts=20,
                 br=0.016, par=root))
    A.append(ring("vent_collar", 0.188, 0.030, (0.60, -0.50, 9.04), MACH, maj=20,
                  mino=6, par=root))
    A.append(cone("vent_frost", 0.150, 0.030, 0.36, (0.60, -0.50, 9.88), INS,
                  verts=18, par=root))
    A.append(prism("vent_cap", 0.238, 0.048, (0.60, -0.50, 10.03), MACH, sides=20,
                   par=root, br=0.012))
    for k in range(4):
        a = k / 4.0 * TAU + 0.4
        A.append(rod("vent_stay%d" % k, 0.014, 0.30,
                     (0.60 + 0.175 * math.cos(a), -0.50 + 0.175 * math.sin(a), 9.91),
                     STEEL, verts=8, br=0.0, par=root))

    # ---- manway on the service face with a swing derrick above it
    A += hatch("manway", (0.0, RT + 0.05, 4.55), 0.46, ALU, DARK, STEEL,
               axis=(0, 1, 0), par=root, bolts=12)
    A.append(rod("derrick_post", 0.056, 1.34, (0.0, RT + 0.34, 5.46), STEEL,
                 verts=12, br=0.0, par=root))
    A.append(rod("derrick_arm", 0.046, 1.10, (0.0, RT + 0.66, 6.10), STEEL,
                 rot=(math.pi / 2, 0, 0), verts=12, br=0.0, par=root))
    A.append(ring("derrick_block", 0.10, 0.032, (0.0, RT + 1.14, 6.10), MACH,
                  maj=14, mino=6, rot=(math.pi / 2, 0, 0), par=root))
    A.append(rod("derrick_hook", 0.028, 0.40, (0.0, RT + 1.14, 5.86), DARK,
                 verts=10, br=0.0, par=root))

    # ---- level gauge column: segmented cyan indicator between two sight glasses
    A.append(pbox("gauge_back", 0.17, 0.032, 5.60, (0.66, RT + 0.060, 3.60), DARK,
                  par=root))
    for k in range(11):
        A.append(rbox("gauge_seg%d" % k, 0.118, 0.030, 0.34,
                      (0.66, RT + 0.092, 1.12 + k * 0.47),
                      CYAN if k > 2 else DARK, bevel_r=0.010, segs=1, par=root))
    for k in (0, 1):
        A.append(rbox("gauge_end%d" % k, 0.155, 0.046, 0.10,
                      (0.66, RT + 0.086, 0.86 + k * 4.70), MACH, bevel_r=0.014,
                      segs=1, par=root))
    A.append(rod("sight_a", 0.056, 0.92, (0.66, RT + 0.140, 2.30), GL, verts=14,
                 br=0.010, par=root))
    A.append(rod("sight_b", 0.056, 0.92, (0.66, RT + 0.140, 4.90), GL, verts=14,
                 br=0.010, par=root))

    # ---- caged service ladder on +x up to the top platform
    A += ring_ladder("climb", RT, 0.0, 0.24, 7.34, STEEL, MACH, width=0.48,
                     par=root, cage=True, cage_from=2.20, standoff=0.30)

    # ---- top platform: open grating, guard rail on three sides, toe boards
    A += grating("plat", 2.16, 0.0, 7.355, 1.06, 1.66, STEEL, par=root, nx=7, ny=11,
                 t=0.026)
    for sy in (-1, 1):
        A.append(pbox("plat_stringer%d" % sy, 1.10, 0.080, 0.18, (2.16, sy * 0.82, 7.26),
                      DARK, par=root))
        A.append(pbox("plat_toe%d" % sy, 1.10, 0.050, 0.14, (2.16, sy * 0.86, 7.44),
                      DARK, par=root))
    A.append(pbox("plat_toe_out", 0.050, 1.72, 0.14, (2.68, 0.0, 7.44), DARK,
                  par=root))
    A.append(pbox("plat_edge", 0.075, 1.72, 0.20, (2.71, 0.0, 7.29), STEEL, par=root))
    for sy in (-1, 1):
        A.append(rod("plat_knee%d" % sy, 0.034, 0.92, (2.00, sy * 0.80, 6.86), STEEL,
                     rot=(math.radians(28) * sy, 0, 0), verts=10, br=0.0, par=root))
    RAIL = [(2.60, 0.82), (2.60, -0.82), (2.10, 0.86), (2.10, -0.86), (2.60, 0.0)]
    for k, (px, py) in enumerate(RAIL):
        A.append(pbox("rail_post%d" % k, 0.052, 0.052, 1.08, (px, py, 7.90), STEEL,
                      par=root))
    for fz in (8.44, 7.90):
        A += pipe_run("rail_y%g" % fz, [(2.60, -0.82, fz), (2.60, 0.0, fz),
                                        (2.60, 0.82, fz)], 0.028, MACH, DARK,
                      par=root, res=2)
        A += pipe_run("rail_x%g" % fz, [(2.10, -0.86, fz), (2.60, -0.82, fz)], 0.028,
                      MACH, DARK, par=root, res=2)
        A += pipe_run("rail_x2_%g" % fz, [(2.10, 0.86, fz), (2.60, 0.82, fz)], 0.028,
                      MACH, DARK, par=root, res=2)

    # ---- platform inspection lamp on a gooseneck
    A += pipe_run("lamp_arm", [(2.44, 0.60, 7.42), (2.48, 0.66, 8.28),
                               (2.56, 0.62, 8.72)], 0.030, STEEL, DARK, par=root,
                  res=2)
    A.append(rbox("lamp_head", 0.22, 0.28, 0.11, (2.56, 0.62, 8.84), ALU,
                  bevel_r=0.022, segs=2, par=root))
    A.append(rbox("lamp_die", 0.160, 0.22, 0.024, (2.56, 0.62, 8.777), AMBER,
                  bevel_r=0.006, segs=1, par=root))

    # ---- valve island on -x: three cryo lines, elbows, bellows, handwheels
    MAN = ((0.95, 1.30, 0.135), (0.30, 1.85, 0.115), (-0.42, 2.40, 0.095))
    for i, (yy, zz, pr) in enumerate(MAN):
        A += pipe_run("line%d" % i, [(-1.72, yy, zz), (-2.20, yy, zz),
                                     (-2.48, yy, zz - 0.34), (-2.48, yy, 0.34)],
                      pr, ALU if i else STEEL, MACH, par=root, flange_at=[0, 3],
                      clamp_at=[0.5], res=3)
        bl = bellows("bellows%d" % i, pr * 1.35, 5, pr * 0.46, (-2.20, yy, zz), RUB,
                     par=root)
        bl.rotation_euler = (0, math.pi / 2, 0)
        A.append(bl)
        A.append(rod("valve_body%d" % i, pr * 1.55, pr * 2.2, (-1.96, yy, zz), DARK,
                     verts=16, br=pr * 0.20, par=root))
        A.append(rod("valve_stem%d" % i, pr * 0.26, 0.34, (-1.96, yy + pr * 2.4, zz),
                     STEEL, rot=(math.pi / 2, 0, 0), verts=10, br=0.0, par=root))
        A.append(ring("valve_rim%d" % i, pr * 1.25, pr * 0.18, (-1.96, yy + pr * 3.4, zz),
                      RED, maj=18, mino=6, rot=(math.pi / 2, 0, 0), par=root))
        for k in range(4):
            a = k / 4.0 * TAU + 0.4
            A.append(rod("valve_spoke%d_%d" % (i, k), pr * 0.13, pr * 2.4,
                         (-1.96 + pr * 0.62 * math.cos(a), yy + pr * 3.4,
                          zz + pr * 0.62 * math.sin(a)), RED,
                         rot=(math.pi / 2, 0, a), verts=6, br=0.0, par=root))
    # manifold frame: this is what sets the y footprint
    A.append(pbox("manifold_beam", 0.16, 4.16, 0.16, (-2.46, 0.0, 0.30), DARK,
                  par=root))
    for sy in (-1, 1):
        A.append(pbox("manifold_post%d" % sy, 0.14, 0.14, 0.46, (-2.46, sy * 1.98, 0.08),
                      DARK, par=root))
        A.append(rbox("manifold_pad%d" % sy, 0.38, 0.38, 0.10, (-2.46, sy * 1.98, 0.05),
                      CONC, bevel_r=0.022, segs=1, par=root))
        A.append(pbox("manifold_gus%d" % sy, 0.44, 0.09, 0.09, (-2.24, sy * 1.98, 0.50),
                      STEEL, par=root))
    for i, (yy, zz, pr) in enumerate(MAN):
        A.append(rod("line_riser%d" % i, pr * 0.9, 0.30, (-2.48, yy, 0.42), STEEL,
                     verts=12, br=0.0, par=root))

    # ---- hazard placard, data plate, extruded vessel ID
    A.append(rbox("placard", 0.66, 0.024, 0.46, (-0.66, RT + 0.060, 2.05), W,
                  bevel_r=0.012, segs=1, par=root))
    for k in range(6):
        A.append(pbox("placard_chev%d" % k, 0.105, 0.016, 0.42,
                      (-0.92 + k * 0.125, RT + 0.078, 2.05), RED,
                      rot=(0, math.radians(28), 0), par=root))
    A.append(rbox("data_plate", 0.32, 0.016, 0.21, (-0.66, RT + 0.056, 1.52), MACH,
                  bevel_r=0.008, segs=1, par=root))
    A += letter_row("vessel_id", "LOX-02", (-0.44, RT + 0.056, 3.48), 0.20, ORANGE,
                    depth=0.018, dirv=(1, 0, 0), up=(0, 0, 1), par=root, gapf=0.30)

    # ---- cable condup + tray down the +x/+y quadrant
    A += pipe_run("condup", [(1.24, 1.34, 7.20), (1.60, 1.00, 6.20),
                             (1.84, 0.58, 4.10), (1.88, 0.16, 2.00),
                             (1.88, 0.0, 0.50)], 0.048, RUB, DARK, par=root,
                  clamp_at=[0.18, 0.46, 0.74])
    for k in range(6):
        a = math.radians(40 + k * 8)
        A.append(pbox("tray_rung%d" % k, 0.055, 0.32, 0.022,
                      (1.90 * math.cos(a), 1.90 * math.sin(a), 6.90 - k * 1.12),
                      STEEL, rot=(0, 0, a), par=root))

    # ---- join + weather
    g = join(meshes(A), "cryo_body")
    parent(g, root)
    smooth_angle(g, 34)
    # the coldest metal sits nearest the outlet: a frost halo on the valve island
    reassign(g, lambda p, c, nn: c.x < -1.62 and c.z < 1.55, INS, keep=KEEP)
    dust_top(g, zmin=0.24, min_nz=0.60, keep=KEEP)
    scuff_low(g, zmax=1.15, max_nz=0.42, keep=KEEP)
    return root



def ring_ladder(name, R, ang, z0, z1, m_side, m_rung, width=0.46, par=None,
                cage=False, cage_from=None, standoff=0.17, ties=None):
    """A caged ship's ladder mounted on the mantle of a vertical cylinder: the
    rails run vertically, the width runs TANGENTIAL at azimuth `ang`, and the
    whole thing stands off the surface on real tie rods."""
    ux, uy = math.cos(ang), math.sin(ang)
    tx, ty = -uy, ux
    tz = math.atan2(ty, tx)
    L = z1 - z0
    parts = []
    for s in (-1, 1):
        parts.append(pbox("%s_side%d" % (name, s), 0.052, 0.050, L,
                          ((R + standoff) * ux + s * width / 2 * tx,
                           (R + standoff) * uy + s * width / 2 * ty, z0 + L / 2),
                          m_side, rot=(0, 0, tz), par=par))
    nr = max(2, int(L / 0.30))
    for k in range(nr + 1):
        z = z0 + (k + 0.5) * L / (nr + 1)
        p0 = Vector(((R + standoff) * ux - width / 2 * tx,
                     (R + standoff) * uy - width / 2 * ty, z))
        p1 = Vector(((R + standoff) * ux + width / 2 * tx,
                     (R + standoff) * uy + width / 2 * ty, z))
        d = p1 - p0
        parts.append(rod("%s_rung%d" % (name, k), 0.016, d.length, tuple((p0 + p1) / 2),
                         m_rung, rot=d.to_track_quat('Z', 'Y').to_euler(), verts=8,
                         br=0.0, par=par))
    if cage:
        zc = cage_from if cage_from is not None else z0 + 1.4
        nb = max(2, int((z1 - zc) / 0.95))
        Rc = R + standoff + width * 0.62
        q = Vector((tx, ty, 0)).to_track_quat('Z', 'Y').to_euler()
        for k in range(nb + 1):
            z = zc + k * (z1 - zc) / nb
            parts.append(ring("%s_hoop%d" % (name, k), width * 0.94, 0.014,
                              (Rc * ux, Rc * uy, z), m_rung, maj=16, mino=5,
                              rot=q, par=par))
        for s in (-1, 0, 1):
            parts.append(pbox("%s_strap%d" % (name, s), 0.022, 0.022, z1 - zc,
                              (Rc * ux + s * width * 0.86 * tx,
                               Rc * uy + s * width * 0.86 * ty, (z1 + zc) / 2),
                              m_rung, rot=(0, 0, tz), par=par))
        parts.append(ring("%s_cage_top" % name, width * 0.94, 0.016,
                          (Rc * ux, Rc * uy, z1 + 0.10), m_rung, maj=16, mino=5,
                          rot=q, par=par))
    for zz in (ties if ties else (z0 + 0.30, z0 + L * 0.5, z1 - 0.30)):
        for s in (-1, 1):
            parts.append(rod("%s_tie%g%d" % (name, zz, s), 0.028, standoff + 0.14,
                             ((R + standoff / 2 - 0.02) * ux + s * width / 2 * tx,
                              (R + standoff / 2 - 0.02) * uy + s * width / 2 * ty, zz),
                             m_rung, rot=(math.pi / 2, 0, tz), verts=8, br=0.0,
                             par=par))
    return parts


def radial_pipe(name, R, ang, z, length, r, m, m_flange, par=None, outboard=True):
    """A short stub pipe leaving a cylindrical mantle radially, with a bolted
    flange collar at the wall and a flanged termination."""
    ux, uy = math.cos(ang), math.sin(ang)
    q = Vector((ux, uy, 0)).to_track_quat('Z', 'Y').to_euler()
    p0 = Vector((R * ux, R * uy, z))
    p1 = p0 + Vector((ux, uy, 0)) * length
    parts = [rod(name, r, length, tuple((p0 + p1) / 2), m, rot=q, verts=18,
                 br=r * 0.10, par=par),
             ring(name + "_collar", r * 1.5, r * 0.30, tuple(p0 + Vector((ux, uy, 0)) * r * 0.4),
                  m_flange, maj=18, mino=5, rot=q, par=par)]
    parts.append(prism(name + "_fl", r * 1.6, r * 0.5, tuple(p1), m_flange, sides=16,
                       rot=q, par=par, br=r * 0.12))
    return parts


def face_ring(R, ang_off, z):
    """Corner ring of an n-gon mantle: returns [(x, y)] for 4 quadrant faces."""
    return [(R * math.cos(ang_off + k * math.pi / 2),
             R * math.sin(ang_off + k * math.pi / 2)) for k in range(4)]


def oct_lattice(name, Rb, Rt, zb, zt, bays, m_memb, m_brace, m_gus, par=None,
                ang_off=0.0, chord_r=None, brace_r=None, plate_every=1):
    """A tapered square lattice mast on a 45-degree diagonal: four corner
    chords, horizontal ring members per bay and a real X brace on every face.
    Chords, rings, braces and node gussets are all separate solid members."""
    cr = chord_r or (Rb - Rt) * 0.10 + 0.055
    br = brace_r or cr * 0.42
    parts = []
    def corner(i, k):
        f = i / float(bays)
        R = Rb + (Rt - Rb) * f
        a = ang_off + k * math.pi / 2
        return Vector((R * math.cos(a), R * math.sin(a), zb + (zt - zb) * f))
    for k in range(4):
        for i in range(bays):
            p0, p1 = corner(i, k), corner(i + 1, k)
            d = p1 - p0
            parts.append(rod("%s_chord%d_%d" % (name, k, i), cr, d.length,
                             tuple((p0 + p1) / 2), m_memb,
                             rot=d.to_track_quat('Z', 'Y').to_euler(), verts=10,
                             br=cr * 0.16, par=par))
    for i in range(bays + 1):
        for k in range(4):
            p0, p1 = corner(i, k), corner(i, (k + 1) % 4)
            d = p1 - p0
            parts.append(rod("%s_ring%d_%d" % (name, i, k), br, d.length,
                             tuple((p0 + p1) / 2), m_memb,
                             rot=d.to_track_quat('Z', 'Y').to_euler(), verts=8,
                             br=br * 0.18, par=par))
        if i < bays:
            for k in range(4):
                a0, a1 = corner(i, k), corner(i, (k + 1) % 4)
                b0, b1 = corner(i + 1, k), corner(i + 1, (k + 1) % 4)
                for u, v in ((a0, b1), (a1, b0)):
                    d = v - u
                    parts.append(rod("%s_x%d_%d" % (name, i, k), br * 0.8, d.length,
                                     tuple((u + v) / 2), m_brace,
                                     rot=d.to_track_quat('Z', 'Y').to_euler(),
                                     verts=8, br=0.0, par=par))
        if i % plate_every == 0:
            for k in range(4):
                p = corner(i, k)
                parts.append(ball("%s_node%d_%d" % (name, i, k), cr * 1.35, tuple(p),
                                  m_gus, segs=10, par=par))
    return parts

# ============================================================================
#  shared structural helpers added for the base set
# ============================================================================
def fluted(name, r0, r1, h, loc, m, par=None, flutes=14, depth=0.02, segs=84,
           smooth=55, z0=0.0):
    """Extrusion whose radius is modulated by standing cos(flutes*theta) —
    a machined/fluted column rather than a plain cylinder."""
    bm = bmesh.new()
    bot, top = [], []
    for i in range(segs):
        th = i / segs * TAU
        rr0 = r0 - depth * max(0.0, math.cos(flutes * th)) ** 0.85
        rr1 = r1 - depth * max(0.0, math.cos(flutes * th)) ** 0.85
        bot.append(bm.verts.new((rr0 * math.cos(th), rr0 * math.sin(th), z0)))
        top.append(bm.verts.new((rr1 * math.cos(th), rr1 * math.sin(th), z0 + h)))
    for i in range(segs):
        bm.faces.new((bot[i], bot[(i + 1) % segs], top[(i + 1) % segs], top[i]))
    bm.faces.new(list(reversed(bot)))
    bm.faces.new(top)
    return from_bm(name, bm, m, loc, par=par, smooth=smooth)


def poly_loft(name, rings, m, par=None, smooth=45, caps=True):
    """Loft a stack of closed 2-D rings (each a list of (x,y) at its own z)."""
    bm = bmesh.new()
    rv = []
    for ring_pts in rings:
        rv.append([bm.verts.new((p[0], p[1], p[2])) for p in ring_pts])
    for s in range(len(rv) - 1):
        a, b = rv[s], rv[s + 1]
        n = min(len(a), len(b))
        for i in range(n):
            j = (i + 1) % n
            try:
                bm.faces.new((a[i], a[j], b[j], b[i]))
            except ValueError:
                pass
    if caps:
        try:
            bm.faces.new(list(reversed(rv[0])))
            bm.faces.new(rv[-1])
        except ValueError:
            pass
    return from_bm(name, bm, m, (0, 0, 0), par=par, smooth=smooth)


def ngon_ring(name, R, r_tube, z, m, n=12, par=None, rot=(0, 0, 0)):
    return ring(name, R, r_tube, (0, 0, z), m, maj=n * 2, mino=6, rot=rot, par=par)


def finstack(name, cx, cy, cz, n, gap, w, d, t, m, par=None, axis='x'):
    """Heat-sink / radiator fin field built from individual thin plates."""
    parts = []
    for k in range(n):
        o = gap * (k - (n - 1) / 2.0)
        if axis == 'x':
            parts.append(pbox("%s_%d" % (name, k), t, w, d, (cx + o, cy, cz), m, par=par))
        elif axis == 'y':
            parts.append(pbox("%s_%d" % (name, k), w, t, d, (cx, cy + o, cz), m, par=par))
        else:
            parts.append(pbox("%s_%d" % (name, k), w, d, t, (cx, cy, cz + o), m, par=par))
    return parts


def crystal_prism(name, base_r, top_r, h, loc, m, par=None, sides=6, phase=0.0,
                  twist=0.0, bellies=None, tip_frac=0.30, jitter=0.0, seed=0.0,
                  root_depth=0.22):
    """A terminated crystal: a faceted prism with growth ledges converging into
    a real six-faced point, and a matching counter-point underneath — the
    runtime hovers and spins these, so the underside is part of the design."""
    import random as _r
    rnd = _r.Random(int(abs(seed) * 1000.0 + loc[0] * 97.3 + loc[1] * 51.7 +
                        loc[2] * 33.1 + phase * 11.0) & 0x7FFFFFFF)
    bellies = bellies or []
    stations = [(0.0, base_r)] + [(f, base_r * rr) for f, rr in bellies] + \
               [(1.0 - tip_frac, top_r), (1.0 - tip_frac * 0.40, top_r * 0.62)]
    stations = sorted(stations, key=lambda s: s[0])
    bm = bmesh.new()
    rings = []
    for f, r in stations:
        z = h * f
        tw = twist * f
        pts = []
        for k in range(sides):
            a = phase + tw + k / float(sides) * TAU
            jj = 1.0 + jitter * rnd.uniform(-1.0, 1.0)
            pts.append(bm.verts.new((r * jj * math.cos(a), r * jj * math.sin(a), z)))
        rings.append(pts)
    for s in range(len(rings) - 1):
        a, b = rings[s], rings[s + 1]
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((a[i], a[j], b[j], b[i]))
    # tip apex
    apex = bm.verts.new((0, 0, h * 1.03))
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new((rings[-1][i], rings[-1][j], apex))
    # root apex (below grade / underneath the hover)
    rapex = bm.verts.new((0, 0, -h * root_depth))
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new((rings[0][j], rings[0][i], rapex))
    o = from_bm(name, bm, m, loc, par=None, smooth=44)
    # keep the object origin AT loc so the caller's rotation leans the prism
    # about its own base rather than flinging it around the world origin
    parent(o, par)
    return o


# ============================================================================
#  5. LAMP  — twin-arm base luminaire with a mission banner
#  target: x +/-1.07  y +/-0.95  z 0..5.00   (shipped: 2.17 x 1.98 x 5.00)
# ============================================================================
@builder
def lamp():
    root = empty("lamp", (0, 0, 0))
    W = P["white"]; ALU = P["alu"]; MACH = P["alumach"]; DARK = P["gunmetal"]
    RUB = P["rubber"]; STEEL = P["steel"]; GRATE = P["grate"]
    AMBER = P["amber"]; CYAN = P["cyan"]; WARM = P["warm"]; CELL = P["cell"]
    CONC = P["concrete"]; ORANGE = P["orange"]; GL = P["lens"]
    parts_all = []

    # ---- cast footing: chamfered concrete plinth + anchor cage
    foot = [rbox("footing", 0.60, 0.60, 0.11, (0, 0, 0.055), CONC, bevel_r=0.028,
                 segs=2, par=root)]
    foot.append(rbox("footing_cap", 0.50, 0.50, 0.06, (0, 0, 0.115), CONC,
                     bevel_r=0.016, segs=1, par=root))
    for sx in (-1, 1):
        for sy in (-1, 1):
            foot.append(rod("anchor_%d%d" % (sx, sy), 0.022, 0.16,
                            (sx * 0.215, sy * 0.215, 0.205), STEEL, verts=10,
                            br=0.0, par=root))
            foot.append(hexn("anchor_nut_%d%d" % (sx, sy), 0.038, 0.030,
                             (sx * 0.215, sy * 0.215, 0.235), ALU, par=root))
            foot.append(ring("anchor_wash%d%d" % (sx, sy), 0.030, 0.008,
                             (sx * 0.215, sy * 0.215, 0.219), DARK, maj=12, mino=4,
                             par=root))
    # drainage chamfer strips on two sides
    for sy in (-1, 1):
        foot.append(pbox("drain_%d" % sy, 0.44, 0.028, 0.020, (0, sy * 0.29, 0.128),
                         DARK, par=root))
    parts_all += foot

    # ---- base housing: octagonal die-cast boot with a real access door
    base = []
    base.append(prism("base_boot", 0.185, 0.46, (0, 0, 0.34), W, sides=8, par=root,
                      br=0.028, segs=2))
    base.append(prism("base_collar", 0.205, 0.055, (0, 0, 0.575), ALU, sides=8,
                      par=root, br=0.010))
    base.append(boltring("base_bolts", (0, 0, 0.605), (0, 0, 1), 0.152, 8, DARK,
                         br=0.017, bh=0.016, par=root))
    # handhole: recessed frame + door + 4 bolts + a data plate
    for sy in (-1, 1):
        base.append(pbox("hh_recess_%d" % sy, 0.135, 0.014, 0.20, (0, sy * 0.172, 0.36),
                         DARK, rot=(0, 0, 0), par=root))
        d = rbox("hh_door_%d" % sy, 0.118, 0.020, 0.180, (0, sy * 0.180, 0.36), ALU,
                 bevel_r=0.008, segs=1, par=root)
        base.append(d)
        for i in (-1, 1):
            for j in (-1, 1):
                base.append(hexn("hh_bolt_%d%d%d" % (sy, i, j), 0.013, 0.012,
                                 (i * 0.045, sy * 0.192, 0.36 + j * 0.070), DARK,
                                 rot=(math.pi / 2, 0, 0), par=root))
    base.append(pbox("data_plate", 0.075, 0.012, 0.048, (0.0, -0.190, 0.470), MACH,
                     par=root))
    parts_all += base

    # ---- main pole: fluted tapered extrusion with weld collars
    pole = fluted("pole", 0.108, 0.068, 3.62, (0, 0, 0), P["white"], par=root,
                  flutes=16, depth=0.010, segs=64, z0=0.60)
    parts_all.append(pole)
    for z in (0.60, 2.05, 3.55, 4.20):
        parts_all.append(ring("pole_weld_z%g" % z, 0.104 - 0.036 * (z / 4.2), 0.011,
                              (0, 0, z), ALU, maj=32, mino=6, par=root))
    # cable condup climbing the pole in a real conduit with clamp bands
    parts_all += pipe_run("condup", [(0.115, 0.075, 0.20), (0.132, 0.055, 0.62),
                                     (0.118, 0.048, 2.05), (0.100, 0.040, 3.55),
                                     (0.072, 0.030, 4.02)],
                          0.020, RUB, DARK, par=root, clamp_at=[0.18, 0.45, 0.72])
    parts_all.append(rbox("condup_boot", 0.075, 0.075, 0.10, (0.118, 0.062, 0.165),
                          RUB, bevel_r=0.014, segs=1, par=root))

    # ---- mid-pole node box (comms + controller) with louvres and a status LED
    nb = []
    nb.append(rbox("node_body", 0.20, 0.24, 0.34, (0.0, 0.0, 2.42), W, bevel_r=0.026,
                   segs=2, par=root))
    nb.append(rbox("node_lid", 0.225, 0.265, 0.045, (0.0, 0.0, 2.61), ALU,
                   bevel_r=0.014, segs=1, par=root))
    for k in range(4):
        nb.append(pbox("node_louvre_%d" % k, 0.014, 0.16, 0.020,
                       (0.104, -0.06 + k * 0.042, 2.30), DARK, rot=(0, 0.55, 0),
                       par=root))
    nb.append(rbox("node_screen", 0.012, 0.10, 0.055, (0.106, 0.055, 2.46), CYAN,
                   bevel_r=0.006, segs=1, par=root))
    for s in (-1, 1):
        nb.append(ring("node_band_%d" % s, 0.112, 0.018, (0, 0, 2.24 + (s + 1) * 0.16),
                       ALU, maj=20, mino=6, par=root))
    # whip antenna + GPS puck on the node lid
    nb.append(rod("ant_base", 0.030, 0.05, (0.06, 0.07, 2.66), DARK, verts=12,
                  br=0.006, par=root))
    nb.append(cone("ant_whip", 0.011, 0.0035, 0.42, (0.06, 0.07, 2.90), STEEL,
                   verts=8, par=root))
    nb.append(ball("ant_tip", 0.016, (0.06, 0.07, 3.115), AMBER, segs=8, par=root))
    nb.append(rod("gps_puck", 0.045, 0.030, (-0.055, -0.06, 2.655), MACH, verts=14,
                  br=0.006, par=root))
    parts_all += nb

    # ---- mission sign: a rigid framed panel bolted to through-arms.  Every
    #      member physically touches its neighbours so nothing reads as a
    #      floating plank, and the whole assembly is 55 mm thick so it never
    #      vanishes edge-on.
    ban = []
    SY = 0.90                        # half-span of the sign along y
    Z0, Z1 = 2.86, 3.30              # sign span along z
    ZM = 0.5 * (Z0 + Z1)
    TH = 0.058                       # welded frame thickness along x
    PTH = 0.038                      # inner panel thickness along x
    # one continuous through-arm: two mirrored rods would leave coincident end
    # caps at y=0, which weld into a non-manifold sandwich
    ban.append(rod("banner_arm", 0.014, 2 * (SY + 0.028), (0.0, 0.0, ZM), STEEL,
                   rot=(math.pi / 2, 0, 0), verts=10, br=0.0, par=root))
    for s in (-1, 1):
        ban.append(rbox("banner_post_%d" % s, 0.080, 0.058, (Z1 - Z0) + 0.12,
                        (0.0, s * (SY + 0.028), ZM), ALU, bevel_r=0.012, segs=1,
                        par=root))
        for k in (-1, 1):
            ban.append(hexn("banner_postbolt_%d%d" % (s, k), 0.016, 0.018,
                            (0.041, s * (SY + 0.028), ZM + k * 0.16), DARK,
                            rot=(0, math.pi / 2, 0), par=root))
        # diagonal brace from the arm back up to the pole: a real load path
        p0 = Vector((0.0, s * 0.16, Z1 + 0.13))
        p1 = Vector((0.0, s * (SY - 0.10), ZM - 0.02))
        d = p1 - p0
        ban.append(rod("banner_brace_%d" % s, 0.010, d.length, tuple((p0 + p1) / 2),
                       STEEL, rot=d.to_track_quat('Z', 'Y').to_euler(), verts=8,
                       br=0.0, par=root))
    # the panel, recessed 10 mm inside a welded frame on all four sides
    ban.append(rbox("banner_plate", PTH, 2 * SY - 0.24, (Z1 - Z0) - 0.12,
                    (0.0, 0.0, ZM), ORANGE, bevel_r=0.006, segs=1, par=root))
    for zz in (Z1 - 0.025, Z0 + 0.025):
        ban.append(rbox("banner_rail_%g" % zz, TH, 2 * SY - 0.05, 0.050,
                        (0.0, 0.0, zz), ALU, bevel_r=0.010, segs=1, par=root))
    for s in (-1, 1):
        ban.append(rbox("banner_stile_%d" % s, TH, 0.050, Z1 - Z0 - 0.05,
                        (0.0, s * (SY - 0.020), ZM), ALU, bevel_r=0.010, segs=1,
                        par=root))
    # chunky graphics that still read at 60 m: a double chevron at each end,
    # moulded through the panel so they are proud of BOTH faces
    for s in (-1, 1):
        for k in (0, 1):
            for u in (-1, 1):
                ban.append(pbox("banner_chev_%d%d%d" % (s, k, u), PTH + 0.012, 0.145,
                                0.034, (0.0, s * (SY - 0.235 - k * 0.125),
                                        ZM + u * 0.056), P["white"],
                                rot=(math.radians(36 if u > 0 else -36), 0, 0),
                                par=root))
    LT = PTH / 2
    ban += letter_row("banner_text", "RSB", (LT, -0.20, ZM - 0.075), 0.150,
                      P["white"], depth=0.012, dirv=(0, 1, 0), up=(0, 0, 1),
                      par=root, gapf=0.36)
    ban += letter_row("banner_text2", "RSB", (-LT, 0.20, ZM - 0.075), 0.150,
                      P["white"], depth=0.012, dirv=(0, -1, 0), up=(0, 0, 1),
                      par=root, gapf=0.36)
    parts_all += ban

    # ---- twin gooseneck arms (main + secondary), swept with a tapering radius
    def gooseneck(tag, sign, z_root, reach, r_root, head_scale):
        pts = [(sign * 0.055, 0.0, z_root),
               (sign * 0.13, 0.0, z_root + 0.26),
               (sign * (reach * 0.42), 0.0, z_root + 0.42),
               (sign * (reach * 0.78), 0.0, z_root + 0.40),
               (sign * reach, 0.0, z_root + 0.24)]
        rad = [r_root, r_root * 0.92, r_root * 0.80, r_root * 0.70, r_root * 0.62]
        a = tube("goose_%s" % tag, pts, None, P["white"], res=2, par=root, radii=rad)
        # gusset where the arm leaves the pole
        g = rbox("goose_gusset_%s" % tag, 0.055 * sign, 0.075, 0.16,
                 (sign * 0.10, 0.0, z_root + 0.10), ALU, bevel_r=0.012, segs=1,
                 par=root)
        # a diagonal tie-rod back to the pole for a real load path
        p0 = Vector((sign * 0.09, 0, z_root + 0.02))
        p1 = Vector((sign * reach * 0.72, 0, z_root + 0.40))
        d = p1 - p0
        tie = rod("goose_tie_%s" % tag, 0.011, d.length, tuple((p0 + p1) / 2), STEEL,
                  rot=d.to_track_quat('Z', 'Y').to_euler(), verts=8, br=0.0, par=root)
        return [a, g, tie]

    parts_all += gooseneck("A", 1, 4.30, 0.80, 0.052, 1.0)
    parts_all += gooseneck("B", -1, 3.62, 0.66, 0.044, 0.78)

    # ---- luminaire head: heat-sink body, shroud, glass, emissive die, clips.
    #      Every optic plane is separated from its neighbour by >= 8 mm so no
    #      pair can z-fight, and nothing hangs detached beneath the body.
    def head(tag, cx, cz, sx, sy, warm_mat):
        hp = []
        hp.append(rbox("%s_body" % tag, sx, sy, 0.085, (cx, 0, cz), ALU,
                       bevel_r=0.020, segs=2, par=root))
        hp += finstack("%s_fin" % tag, cx, 0, cz + 0.075, 9, 0.030, sy * 0.86,
                       0.055, 0.010, MACH, par=root, axis='y')
        hp.append(rbox("%s_shroud" % tag, sx * 1.10, sy * 1.12, 0.030,
                       (cx, 0, cz + 0.115), W, bevel_r=0.012, segs=1, par=root))
        # dark reflector tray: overlaps the body by 12 mm, continues to -0.090
        hp.append(rbox("%s_sump" % tag, sx * 0.96, sy * 0.96, 0.060,
                       (cx, 0, cz - 0.060), DARK, bevel_r=0.012, segs=1, par=root))
        # a thick lens slab that straddles the tray mouth
        hp.append(rbox("%s_lens" % tag, sx * 0.90, sy * 0.90, 0.030,
                       (cx, 0, cz - 0.088), GL, bevel_r=0.008, segs=1, par=root))
        hp.append(rbox("%s_die" % tag, sx * 0.70, sy * 0.70, 0.020,
                       (cx, 0, cz - 0.070), warm_mat, bevel_r=0.004, segs=1, par=root))
        # lens retainer: four bars bridging tray-mouth to below the lens
        for i, (lx, ly, w, d) in enumerate(
                ((cx, sy * 0.44, sx * 1.02, 0.024), (cx, -sy * 0.44, sx * 1.02, 0.024),
                 (cx - sx * 0.44, 0, 0.024, sy * 0.98),
                 (cx + sx * 0.44, 0, 0.024, sy * 0.98))):
            hp.append(pbox("%s_ret%d" % (tag, i), w, d, 0.046, (lx, ly, cz - 0.088),
                           STEEL, par=root))
        # tilt knuckle at the arm end
        hp.append(rod("%s_knuckle" % tag, 0.030, sy * 0.62, (cx, 0, cz + 0.155), STEEL,
                      rot=(0, math.pi / 2, 0), verts=12, br=0.0, par=root))
        hp.append(hexn("%s_knurlt" % tag, 0.020, 0.016,
                       (cx - sy * 0.34, 0, cz + 0.155), DARK, rot=RX90, par=root))
        return hp

    parts_all += head("headA", 0.80, 4.50, 0.60, 0.54, WARM)
    parts_all += head("headB", -0.66, 3.84, 0.44, 0.40, AMBER)

    # ---- small PV panel + battery can on the back of the main arm
    pv = []
    pv.append(rbox("pv_frame", 0.30, 0.24, 0.022, (0.30, -0.24, 4.62), ALU,
                   bevel_r=0.007, segs=1, rot=(0, math.radians(-16), 0), par=root))
    pv.append(rbox("pv_cells", 0.255, 0.195, 0.012, (0.298, -0.240, 4.640), CELL,
                   bevel_r=0.003, segs=1, rot=(0, math.radians(-16), 0), par=root))
    for k in range(3):
        pv.append(pbox("pv_grid%d" % k, 0.258, 0.008, 0.014,
                       (0.298, -0.305 + k * 0.065, 4.648), ALU,
                       rot=(0, math.radians(-16), 0), par=root))
    pv.append(rod("pv_strut", 0.010, 0.20, (0.30, -0.30, 4.56), STEEL,
                  rot=(math.radians(70), 0, 0), verts=8, br=0.0, par=root))
    pv.append(cylinder_can("batt_can", 0.075, 0.26, (0.0, -0.20, 4.16), P["cream"],
                           par=root))
    parts_all += pv

    # ---- pole top: beacon, finial, wind vane
    top = []
    top.append(prism("top_cap", 0.078, 0.075, (0, 0, 4.28), ALU, sides=12, par=root,
                     br=0.010))
    top.append(rbox("beacon_brk", 0.05, 0.05, 0.10, (0, 0, 4.35), DARK,
                    bevel_r=0.010, segs=1, par=root))
    top.append(ball("beacon", 0.058, (0, 0, 4.44), AMBER, segs=14, par=root))
    top.append(ring("beacon_collar", 0.062, 0.012, (0, 0, 4.395), MACH, maj=18,
                    mino=5, par=root))
    top.append(rod("finial", 0.014, 0.30, (0, 0, 4.66), STEEL, verts=8, br=0.0,
                   par=root))
    top.append(cone("lightning_rod", 0.012, 0.001, 0.22, (0, 0, 4.90), MACH,
                    verts=8, par=root))
    parts_all += top

    # ---- join into a few logical meshes, then weather
    g_shell = join(meshes(parts_all), "lamp_shell")
    parent(g_shell, root)
    smooth_angle(g_shell, 34)
    dust_top(g_shell, zmin=0.14, min_nz=0.66)
    scuff_low(g_shell, zmax=0.62, max_nz=0.40)
    return root


def cylinder_can(name, r, h, loc, m, par=None, caps_mat=None):
    """A capped canister with a rolled rim — reused by lamp/lander/cryo."""
    o = rod(name, r, h, loc, m, verts=18, br=r * 0.16, segs=2, par=par)
    if caps_mat:
        ring(name + "_rimt", r * 0.94, r * 0.10, (loc[0], loc[1], loc[2] + h / 2),
             caps_mat, maj=18, mino=5, par=par)
        ring(name + "_rimb", r * 0.94, r * 0.10, (loc[0], loc[1], loc[2] - h / 2),
             caps_mat, maj=18, mino=5, par=par)
    return o


# ============================================================================
#  6. CRYSTAL — alien mineral cluster
#  target: x +/-1.0  y +/-1.0  z 0..2.60   (shipped: 1.49 x 2.08 x 2.63)
#  NOTE: main.js replaces EVERY mesh material with one shared crystal material,
#  so the read must come from silhouette + facet shading alone, and the
#  underside is modelled because the sample crystals hover and spin.
# ============================================================================
@builder
def crystal():
    """An intergrown spray of terminated hexagonal prisms rising from a chunky
    spalled mineral matrix.  main.js swaps EVERY mesh here for one shared
    crystal material, so the whole read has to come from silhouette, facet
    angles and the crisp light/dark break of flat shading -- and the underside
    is modelled because the runtime hovers and spins the big sample."""
    root = empty("crystal", (0, 0, 0))
    C = P["crystal"]
    import random as _r
    rnd = _r.Random(7717)
    prisms = []

    # ---- primary: straight, thick, crisply terminated, with real growth ledges
    prisms.append(crystal_prism("cry_primary", 0.250, 0.215, 2.06, (0.015, -0.02, 0.22),
                                C, sides=6, phase=0.31, twist=0.0,
                                bellies=[(0.26, 1.085), (0.305, 1.000),
                                         (0.55, 1.060), (0.595, 1.000)],
                                tip_frac=0.195, jitter=0.0, seed=1.7,
                                root_depth=0.10))
    prisms[0].rotation_euler = (math.radians(3.5), math.radians(-3.0), 0)

    # ---- two fat secondaries, one sheared off mid-growth on a real fracture
    prisms.append(crystal_prism("cry_secondary", 0.185, 0.145, 1.44, (0.240, 0.222, 0.20),
                                C, sides=6, phase=1.05, twist=0.0,
                                bellies=[(0.40, 1.070), (0.445, 1.000)],
                                tip_frac=0.24, jitter=0.0, seed=3.1,
                                root_depth=0.14))
    prisms[-1].rotation_euler = (math.radians(17), math.radians(-15), 0)
    cut = rbox("shear_cutter", 1.5, 1.5, 0.75, (1.15, 0.95, 1.30), C, bevel_r=None,
               par=None, rot=(math.radians(26), math.radians(12), 0.45))
    boolean_diff(prisms[-1], [cut])

    prisms.append(crystal_prism("cry_tertiary", 0.165, 0.130, 1.14, (-0.250, 0.140, 0.18),
                                C, sides=6, phase=2.30, twist=0.0,
                                bellies=[(0.46, 1.075)], tip_frac=0.26,
                                jitter=0.0, seed=8.4, root_depth=0.14))
    prisms[-1].rotation_euler = (math.radians(-15), math.radians(-21), 0)

    # ---- companion spray: eight prisms leaning out of the matrix shoulder
    #      x       y      h      r     phase   twist  leanX  leanY
    SPEC = [(-0.398, 0.018, 1.16, 0.112, 0.20, 0.0,  26,  -7),
            (0.150, -0.398, 0.94, 0.104, 1.10, 0.0, -11,  29),
            (-0.158, -0.338, 0.72, 0.092, 2.00, 0.0,  29,  15),
            (0.375, -0.150, 0.84, 0.096, 0.60, 0.0, -14, -27),
            (-0.355, -0.192, 0.58, 0.080, 2.80, 0.0,  33,  18),
            (-0.008, 0.390, 0.66, 0.084, 3.60, 0.0, -26,  9),
            (0.285, 0.285, 0.48, 0.070, 4.40, 0.0,  21, -23),
            (-0.278, 0.278, 0.40, 0.062, 5.10, 0.0, -29, -14),
            (0.062, 0.208, 0.30, 0.052, 1.70, 0.0,  12,  33)]

    for i, (x, y, h, r, ph, tw, lx, ly) in enumerate(SPEC):
        prisms.append(crystal_prism("cry_c%d" % i, r, r * 0.60, h, (x, y, 0.16), C,
                                    sides=6, phase=ph, twist=tw,
                                    bellies=[(0.50, 1.065)], tip_frac=0.27,
                                    jitter=0.0, seed=5.0 + i, root_depth=0.16))
        prisms[-1].rotation_euler = (math.radians(lx), math.radians(ly), 0)

    # ---- spalled shards resting against the matrix foot
    chips = []
    for k in range(6):
        a = 0.55 + k * TAU / 6.0 + rnd.uniform(-0.22, 0.22)
        rr = rnd.uniform(0.80, 0.99)
        c = crystal_prism("shard%d" % k, rnd.uniform(0.055, 0.085),
                          rnd.uniform(0.026, 0.042), rnd.uniform(0.20, 0.34),
                          (rr * math.cos(a), rr * math.sin(a), 0.045), C, sides=6,
                          phase=rnd.uniform(0, TAU), twist=0.0,
                          bellies=[], tip_frac=0.34, jitter=0.0, seed=21.0 + k)
        c.rotation_euler = (rnd.uniform(-1.25, -0.75), rnd.uniform(-0.55, 0.55),
                            rnd.uniform(0, TAU))
        chips.append(c)

    # ---- the matrix: a chunky spalled mineral mass, not a machined disc.
    #      Lathed profile, then per-vertex crystalline noise so every facet
    #      catches the light differently, closed with a real root point below.
    prof = [(0.0, -0.195), (0.165, -0.125), (0.310, -0.045), (0.415, 0.035),
            (0.500, 0.125), (0.462, 0.205), (0.358, 0.258), (0.235, 0.282),
            (0.100, 0.275), (0.0, 0.255)]
    mtx = lathe("matrix", prof, C, (0, 0, 0), segs=26, par=None, smooth=30)
    for v in mtx.data.vertices:
        th = math.atan2(v.co.y, v.co.x)
        rr = math.hypot(v.co.x, v.co.y)
        if rr < 1e-5:
            continue
        k = (1.0 + 0.115 * math.sin(3.0 * th + v.co.z * 5.5)
             + 0.075 * math.sin(5.0 * th - 1.7) + 0.045 * math.sin(9.0 * th + 0.6))
        v.co.x *= k
        v.co.y *= k
        v.co.z += 0.030 * math.sin(4.0 * th + 2.1) * min(1.0, rr / 0.5)
    prisms.append(mtx)

    allp = [o for o in prisms + chips if o is not None]
    g = join(allp, "crystal_body")
    parent(g, root)
    smooth_angle(g, 11)
    # the runtime overrides this material, but keep the file honest: one slot
    recolor(g, C, C)
    return root



# ============================================================================
#  4. LANDER — "DAWN-7" freight lander, hard-landed and torn open
#  target: x +/-2.60  y +/-2.50  z 0..5.40   (shipped: 5.20 x 5.00 x 5.40)
#  runtime: props.js does put('lander', yx, yz, 1.15, 0.6, 0.8) and then tips it
#  with rotation.z = 1.45 / rotation.x = 0.25 — the wreck lies on its side, so
#  the pressure-side underside, the bay interior and the leg bellies are all in
#  shot. Nothing here is left unmodelled because it "sits on the ground".
# ============================================================================
@builder
def lander():
    root = empty("lander", (0, 0, 0))
    W = P["white"]; CREAM = P["cream"]; ALU = P["alu"]; MACH = P["alumach"]
    DARK = P["gunmetal"]; RUB = P["rubber"]; CONC = P["concrete"]; INS = P["insul"]
    COP = P["copper"]; GRATE = P["grate"]; WORN = P["worn"]; RUST = P["rust"]
    SOOT = P["soot"]; LENS = P["lens"]; ORANGE = P["orange"]; REDP = P["red"]
    AMBER = P["amber"]; CYAN = P["cyan"]; WARM = P["warm"]; REDL = P["redglow"]
    KEEP = {AMBER, CYAN, WARM, REDL, LENS, ORANGE, REDP, SOOT}
    A = []
    OFF = math.pi / 8.0                      # corners at 22.5deg -> faces on the axes

    def oring(R, z):
        return [(R * math.cos(OFF + k * math.pi / 4.0),
                 R * math.sin(OFF + k * math.pi / 4.0), z) for k in range(8)]

    def face(k):
        """Unit vector + apothem of the k-th of eight flat faces."""
        a = math.radians(45 * k)
        return a, math.cos(a), math.sin(a)

    # ---------------------------------------------------------------- undercarriage
    # Four jackstrut legs on alternate faces; the -y one is the one that folded.
    for k in (1, 3, 5, 7):
        a, ux, uy = face(k)
        bent = (k == 7)
        r0, z0 = 1.44, 2.36                       # shoulder attach on the hull face
        r1, z1 = (1.72 if bent else 2.06), (0.52 if bent else 0.30)
        p_sh = Vector((r0 * ux, r0 * uy, z0))
        p_ft = Vector((r1 * ux, r1 * uy, z1))
        p_km = p_sh.lerp(p_ft, 0.52) + Vector((0, 0, 0.10))
        A.append(rod("leg_upper_%d" % k, 0.105, (p_km - p_sh).length,
                     tuple((p_km + p_sh) / 2), ALU,
                     rot=(p_km - p_sh).to_track_quat('Z', 'Y').to_euler(), verts=12,
                     br=0.016, par=root))
        A.append(rod("leg_lower_%d" % k, 0.072, (p_ft - p_km).length,
                     tuple((p_ft + p_km) / 2), MACH,
                     rot=(p_ft - p_km).to_track_quat('Z', 'Y').to_euler(), verts=12,
                     br=0.0, par=root))
        # telescoping crush core collar + a hydraulic scuff plate
        A.append(ring("leg_collar_%d" % k, 0.092, 0.026, tuple(p_km), DARK,
                      maj=14, mino=5,
                      rot=(p_ft - p_km).to_track_quat('Z', 'Y').to_euler(), par=root))
        # secondary jackstrut from the hull belt to two thirds down the primary
        p_b0 = Vector((1.06 * ux, 1.06 * uy, 1.06))
        p_b1 = p_sh.lerp(p_ft, 0.66)
        A.append(rod("leg_brace_%d" % k, 0.048, (p_b1 - p_b0).length,
                     tuple((p_b1 + p_b0) / 2), ALU,
                     rot=(p_b1 - p_b0).to_track_quat('Z', 'Y').to_euler(), verts=8,
                     br=0.0, par=root))
        A.append(gusset("leg_gus_%d" % k, tuple(p_b0 + Vector((0, 0, 0.05))),
                        (ux, uy, 0), (0, 0, 1), 0.26, MACH, par=root, t=0.020))
        # shoulder bracket: a forged clevis with two real pins
        A.append(rbox("leg_shoulder_%d" % k, 0.26, 0.30, 0.20, tuple(p_sh), DARK,
                      bevel_r=0.035, segs=2, rot=(0, 0, a), par=root))
        for s in (-1, 1):
            A.append(rod("leg_pin_%d%d" % (k, s > 0), 0.036, 0.34,
                         tuple(p_sh + Vector((-uy * s * 0.13, ux * s * 0.13, 0))),
                         MACH, rot=(math.pi / 2, 0, a), verts=10, br=0.0, par=root))
        # footpad: dished shoe, crushable honeycomb cone, ground skirt
        p_pad = Vector((r1 * ux, r1 * uy, z1 - 0.24))
        A.append(cone("pad_%d" % k, 0.50, 0.20, 0.26, tuple(p_pad + Vector((0, 0, 0.13))),
                      ALU, verts=20, par=root, br=0.02))
        A.append(ring("pad_rim_%d" % k, 0.505, 0.042, tuple(p_pad + Vector((0, 0, 0.02))),
                      MACH, maj=22, mino=6, par=root))
        A.append(cone("pad_crush_%d" % k, 0.20, 0.115, 0.30,
                      tuple(p_pad + Vector((0, 0, 0.40))), WORN, verts=14, par=root))
        for j in range(6):                      # radial stiffeners under the shoe
            b = math.radians(60 * j)
            A.append(pbox("pad_rib_%d%d" % (k, j), 0.055, 0.30, 0.075,
                          (p_pad.x + 0.30 * math.cos(b), p_pad.y + 0.30 * math.sin(b),
                           p_pad.z + 0.10), DARK, rot=(0, 0, b), par=root))
        # touchdown pad lamp on the outboard side of the shoe
        A.append(prism("td_light_%d" % k, 0.055, 0.045,
                       tuple(p_pad + Vector((0.42 * ux, 0.42 * uy, 0.24))), AMBER,
                       sides=8, par=root, br=0.01))

    # ------------------------------------------------------------- descent engine
    # A regenerative bell with 22 cooling tubes, a throat liner and sooted hardware.
    ZB, ZE = 1.02, 0.30
    A.append(cone("engine_bell", 0.80, 0.285, ZB - ZE, (0, 0, (ZB + ZE) / 2), DARK,
                  verts=26, par=root, br=0.018))
    A.append(cone("engine_liner", 0.735, 0.245, ZB - ZE - 0.05,
                  (0, 0, (ZB + ZE) / 2 - 0.02), SOOT, verts=24, par=root))
    A.append(ring("engine_rim", 0.795, 0.038, (0, 0, ZE + 0.012), MACH, maj=28,
                  mino=6, par=root))
    for j in range(22):
        b = j / 22.0 * TAU
        rr = 0.545
        A.append(rod("engine_tube%d" % j, 0.030, 0.80,
                     (rr * math.cos(b) * 0.90, rr * math.sin(b) * 0.90, 0.68), COP,
                     rot=(0, math.radians(16), b), verts=8, br=0.0, par=root))
    A.append(rod("engine_gimbal", 0.30, 0.20, (0, 0, ZB + 0.06), ALU, verts=20,
                 br=0.02, par=root))
    A.append(ring("engine_gimbal_ring", 0.335, 0.045, (0, 0, ZB + 0.15), MACH,
                  maj=22, mino=6, par=root))
    for j in range(4):
        b = math.radians(90 * j + 45)
        A.append(pipe_run("engine_feed%d" % j,
                          [(0.44 * math.cos(b), 0.44 * math.sin(b), 1.24),
                           (0.62 * math.cos(b), 0.62 * math.sin(b), 1.02),
                           (0.40 * math.cos(b), 0.40 * math.sin(b), 0.80)],
                          0.040, COP, MACH, par=root, flange_at=[2], res=2))
    # tankage ring: four pressure spheres half sunk into the skirt
    for j in range(4):
        b = math.radians(90 * j + 45)
        cx, cy = 1.06 * math.cos(b), 1.06 * math.sin(b)
        A.append(ball("tank_%d" % j, 0.40, (cx, cy, 1.30), INS, segs=18, par=root))
        A.append(ring("tank_band_%d" % j, 0.405, 0.030, (cx, cy, 1.30), MACH,
                      maj=18, mino=5, rot=(0, math.pi / 2, b), par=root))
        A.append(pipe_run("tank_line%d" % j, [(cx, cy, 1.66), (cx * 0.72, cy * 0.72, 1.90),
                                              (0.0, 0.0, 2.02)], 0.034, ALU, MACH,
                          par=root, clamp_at=[0.5]))
        A.append(hexn("tank_valve_%d" % j, 0.062, 0.07, (cx * 1.16, cy * 1.16, 1.52),
                      DARK, rot=(math.pi / 2, 0, b), par=root))

    # ------------------------------------------------------------------ lower hull
    hull = poly_loft("lower_hull", [oring(1.28, 0.94), oring(1.46, 1.14),
                                    oring(1.560, 1.62), oring(1.580, 2.06),
                                    oring(1.50, 2.34), oring(1.36, 2.52)],
                     CREAM, par=root, smooth=42)
    A.append(hull)
    A.append(ngon_ring("belt_low", 1.585, 0.055, 1.86, ALU, n=8, par=root))
    A.append(ngon_ring("belt_high", 1.44, 0.060, 2.46, ALU, n=8, par=root))
    # multilayer insulation blankets: eight faces x three quilted bands, strap-tied
    for k in range(8):
        a, ux, uy = face(k)
        ap = 0.9239 * 1.56
        for j, (zb, h) in enumerate(((1.06, 0.44), (1.56, 0.44), (2.06, 0.30))):
            A.append(obase("foil_%d_%d" % (k, j),
                           (ap * ux, ap * uy, zb), 0.86, h, 0.035,
                           (-uy, ux, 0), (0, 0, 1), INS, par=root))
        for j in range(3):                     # retainers: the classic taped joints
            zz = 1.04 + j * 0.50
            A.append(obase("foil_tape%d_%d" % (k, j),
                           (ap * ux + 0.006 * ux, ap * uy + 0.006 * uy, zz),
                           0.90, 0.045, 0.048, (-uy, ux, 0), (0, 0, 1), MACH, par=root))
        # a service panel with four corner fasteners on every other face
        if k % 2 == 0:
            A.append(obase("svc_panel%d" % k, (ap * ux, ap * uy, 1.34), 0.44, 0.40,
                           0.030, (-uy, ux, 0), (0, 0, 1), GRATE, par=root))
            for su in (-1, 1):
                for sv in (-1, 1):
                    A.append(hexn("svc_bolt%d_%d%d" % (k, su > 0, sv > 0), 0.024,
                                  0.022,
                                  (ap * ux - su * 0.17 * uy,
                                   ap * uy + su * 0.17 * ux, 1.34 + sv * 0.15),
                                  MACH, rot=(0, 0, a), par=root))

    # ------------------------------------------------------------- torn cargo bay
    # A real boolean recess on the -y face, ribbed inside, with the door torn off
    # its hinges and the manifest spilled across the pads.
    cutter = pbox("bay_cutter", 1.62, 1.10, 1.16, (0, -1.50, 1.80), CREAM)
    boolean_diff(hull, [cutter])
    apy = 0.9239 * 1.56
    for j in range(4):                         # bay frames deep in the recess
        A.append(pbox("bay_rib%d" % j, 1.44 - j * 0.06, 0.055, 0.075,
                      (0, -apy + 0.06 + j * 0.115, 2.30), DARK, par=root))
        A.append(pbox("bay_ribb%d" % j, 1.44 - j * 0.06, 0.055, 0.075,
                      (0, -apy + 0.06 + j * 0.115, 1.32), DARK, par=root))
    for s in (-1, 1):
        A.append(pbox("bay_post%d" % (s > 0), 0.07, 0.52, 1.02,
                      (s * 0.78, -apy + 0.24, 1.80), DARK, par=root))
    A.append(pbox("bay_floor", 1.56, 0.50, 0.05, (0, -apy + 0.26, 1.28), GRATE,
                  par=root))
    A += louvers("bay_vents", (0, -apy + 0.30, 2.42), 1.10, 0.16, 4, DARK,
                 tilt=0.9, axis='y', par=root)
    # the door, still hanging by one hinge, peeled outward and down
    A.append(pbox("bay_door", 1.50, 0.10, 1.06, (0.24, -apy - 0.30, 1.50), W,
                  rot=(math.radians(14), math.radians(-8), math.radians(-52)),
                  par=root))
    A.append(ring("bay_hinge", 0.055, 0.030, (0.95, -apy, 2.14), MACH, maj=10,
                  mino=5, rot=(math.pi / 2, 0, 0), par=root))
    # cargo: three crates in the recess, two slid out onto the regolith
    def crate(name, c, s, rz, worn=False):
        o = rbox(name, s, s * 0.78, s * 0.66, c, CREAM if not worn else WORN,
                 bevel_r=s * 0.07, segs=2, rot=(0, 0, rz), par=root)
        for i in range(2):
            A.append(obase(name + "_strake%d" % i,
                           (c[0], c[1], c[2] - s * 0.22 + i * s * 0.44),
                           s * 1.02, 0.035, s * 0.10, (math.cos(rz), math.sin(rz), 0),
                           (-math.sin(rz), math.cos(rz), 0), MACH, par=root))
        A.append(obase(name + "_plate", (c[0], c[1] - s * 0.40 * math.cos(rz) * 0,
                                        c[2] + s * 0.34),
                       s * 0.34, s * 0.20, 0.02, (math.cos(rz), math.sin(rz), 0),
                       (-math.sin(rz), math.cos(rz), 0), ORANGE, par=root))
        return o
    A.append(crate("crate_bay0", (-0.44, -1.36, 1.44), 0.44, 0.05))
    A.append(crate("crate_bay1", (0.30, -1.30, 1.40), 0.40, -0.14, True))
    A.append(crate("crate_out0", (-0.98, -2.26, 0.20), 0.42, 0.62))
    A.append(crate("crate_out1", (0.72, -2.40, 0.16), 0.36, -0.30, True))
    for j in range(3):                         # loose canisters rolled out
        A.append(rod("canister_%d" % j, 0.105, 0.40,
                     (-1.62 + j * 0.86, -2.28 + j * 0.16, 0.11), ALU,
                     rot=(math.pi / 2, 0, j * 0.7), verts=14, br=0.02, par=root))
    A += pipe_run("bay_hose", [(-0.62, -1.50, 2.28), (-0.20, -1.94, 2.06),
                               (0.26, -2.16, 1.52), (0.44, -2.32, 0.92)],
                  0.036, RUB, DARK, par=root, clamp_at=[0.4])
    A.append(pbox("bay_cable%d" % 0, 0.028, 0.028, 0.9, (0.52, -1.70, 2.10), COP,
                  rot=(math.radians(24), 0, 0), par=root))

    # ----------------------------------------------------------------- ascent stage
    up = poly_loft("upper_hull", [oring(1.26, 2.62), oring(1.34, 2.80),
                                 oring(1.32, 3.34), oring(1.18, 3.70),
                                 oring(0.96, 3.96)], CREAM, par=root, smooth=42)
    A.append(up)
    A.append(ngon_ring("stage_flange", 1.36, 0.075, 2.56, ALU, n=8, par=root))
    for k in range(8):                         # bolted stage separation plane
        a, ux, uy = face(k)
        A.append(hexn("stage_bolt%d" % k, 0.040, 0.030, (1.36 * ux, 1.36 * uy, 2.56),
                      MACH, rot=(0, 0, a), par=root))
    A.append(poly_loft("cabin", [oring(0.94, 3.98), oring(0.90, 4.14),
                                 oring(0.62, 4.36), oring(0.30, 4.48)], W,
                       par=root, smooth=42))
    # faceted windscreen: three panes on the leading faces plus their mullions
    for k in (0, 1, 7):
        a, ux, uy = face(k)
        A.append(obase("glass%d" % k, (0.90 * ux, 0.90 * uy, 4.10), 0.46, 0.26,
                       0.055, (-uy, ux, 0), (0, 0, 1), LENS, par=root))
        A.append(obase("glass_frame%d" % k, (0.90 * ux, 0.90 * uy, 4.10), 0.53, 0.33,
                       0.040, (-uy, ux, 0), (0, 0, 1), DARK, par=root))
    for k in (0, 1, 7):
        a, ux, uy = face(k)
        A.append(obase("glass_in%da" % k, (0.945 * ux, 0.945 * uy, 4.10), 0.40, 0.20,
                       0.020, (-uy, ux, 0), (0, 0, 1), WARM, par=root))
    # hatch on the +y face with dogs, a window and a real opening frame
    ha, hux, huy = face(2)
    har = 0.9239 * 1.32
    A += hatch("cabin_hatch", (0, har + 0.03, 3.40), 0.30, W, MACH, ALU,
               axis=(0, 1, 0), par=root, bolts=8)
    # RCS quads: three pods (the fourth face is the bay, and it never fired)
    for k in (0, 2, 4):
        a, ux, uy = face(k)
        r0 = 1.34
        A.append(prism("rcs_pod%d" % k, 0.21, 0.30, (r0 * ux, r0 * uy, 3.16), W,
                       sides=8, rot=(0, 0, a), par=root, br=0.05, segs=2))
        for su in (-1, 1):
            for sv in (-1, 1):
                p = Vector((r0 * ux, r0 * uy, 3.16)) + Vector((-uy * su * 0.13,
                                                              ux * su * 0.13, sv * 0.11))
                A.append(cone("rcs_noz%d_%d%d" % (k, su > 0, sv > 0), 0.052, 0.020,
                              0.10, tuple(p + Vector((ux * 0.16, uy * 0.16, 0))), DARK,
                              rot=(0, math.radians(24) * -sv, a), verts=10, par=root))
        A.append(rod("rcs_stack%d" % k, 0.030, 0.44,
                     (r0 * ux, r0 * uy, 3.16), COP, rot=(math.pi / 2, 0, a), verts=8,
                     br=0.0, par=root))
    # radiator panel field on the +x face — the heat rejection is visible
    ra, rux, ruy = face(0)
    rap = 0.9239 * 1.30
    for j in range(3):
        A.append(obase("rad_panel%d" % j, (rap * rux, rap * ruy, 2.86 + j * 0.30),
                       0.62, 0.24, 0.045, (-ruy, rux, 0), (0, 0, 1), ALU, par=root))
        A += finstack("rad_fin%d" % j, rap * rux + 0.06 * rux, rap * ruy + 0.06 * ruy,
                      2.86 + j * 0.30, 7, 0.085, 0.20, 0.22, 0.014, MACH, par=root,
                      axis='y')
    # top furniture: docking probe, dipole antennae, dish, beacon and handrail
    A.append(rod("probe_mast", 0.075, 0.52, (0, 0, 4.72), ALU, verts=12, br=0.0,
                 par=root))
    A.append(cone("probe_drogue", 0.17, 0.05, 0.22, (0, 0, 5.05), DARK, verts=16,
                  par=root))
    A.append(ring("probe_collar", 0.145, 0.028, (0, 0, 4.92), MACH, maj=14, mino=5,
                  par=root))
    for s in (-1, 1):
        A.append(rod("antenna_%d" % (s > 0), 0.018, 0.86, (s * 0.30, 0.26, 4.94), MACH,
                     rot=(math.radians(14), math.radians(-16 * s), 0), verts=6,
                     br=0.0, par=root))
        A.append(ball("antenna_tip%d" % (s > 0), 0.028,
                      (s * 0.36, 0.32, 5.34), REDL, segs=8, par=root))
    A.append(cone("dish", 0.30, 0.05, 0.17, (-0.44, -0.30, 4.66), MACH, verts=18,
                  rot=(math.radians(122), 0, math.radians(-140)), par=root))
    A.append(rod("dish_feed", 0.020, 0.26, (-0.44, -0.30, 4.80), ALU, verts=8,
                 br=0.0, par=root))
    for k in range(6):
        b = k / 6.0 * TAU + 0.3
        A.append(pbox("rail_post%d" % k, 0.035, 0.035, 0.42,
                      (0.66 * math.cos(b), 0.66 * math.sin(b), 4.55), MACH, par=root))
    A.append(ring("rail_top", 0.66, 0.024, (0, 0, 4.76), MACH, maj=20, mino=5,
                  par=root))
    A.append(prism("beacon", 0.075, 0.10, (0, 0, 4.50), REDL, sides=10, par=root,
                   br=0.02))
    # descent ladder down the clear +y face, stand-off booms and a safety rail
    A += ladder("cabin_ladder", 0.0, apy + 0.12, 0.50, 2.50, MACH, ALU, width=0.40,
                par=root, cage=False)
    # two flood lamps that lit the touchdown
    for s in (-1, 1):
        A.append(rbox("flood%d" % (s > 0), 0.20, 0.10, 0.14, (s * 0.52, -1.30, 2.66),
                      DARK, bevel_r=0.02, segs=1, rot=(math.radians(28), 0, 0),
                      par=root))
        A.append(obase("flood_lens%d" % (s > 0), (s * 0.52, -1.35, 2.62), 0.15, 0.10,
                       0.02, (1, 0, 0), (0, 0, 1), WARM, par=root))
    # identification: raised letters across the +x face of the lower hull
    A += letter_row("craft_id", "DAWN-7", (-0.66, 1.48, 2.02), 0.24, ORANGE,
                    depth=0.020, dirv=(1, 0, 0), up=(0, 0, 1), par=root, gapf=0.22)
    for s in (-1, 1):                          # the stripes the surveyors flew by
        A.append(obase("id_band%d" % (s > 0), (0, s * (apy + 0.02), 2.18), 0.94, 0.10,
                       0.03, (1, 0, 0), (0, 0, 1), REDP, par=root))
    A.append(prism("gnome", 0.10, 0.13, (0.60, -1.28, 2.60), DARK, sides=8,
                   rot=(math.radians(70), 0, 0.4), par=root, br=0.01))
    A += [rod("gnome_pin%d" % j, 0.012, 0.30, (0.62 + j * 0.05, -1.30, 2.72), MACH,
              rot=(math.radians(100), 0, j * 0.5), verts=6, br=0.0, par=root)
          for j in range(2)]

    # ------------------------------------------------------------------- finish
    g = join(meshes(A), "lander_body")
    parent(g, root)
    smooth_angle(g, 34)
    reassign(g, lambda p, c, nn: c.z < 0.62 and nn.z < 0.20, SOOT, keep=KEEP)
    dust_top(g, zmin=0.16, min_nz=0.58, keep=KEEP)
    scuff_low(g, zmax=1.05, max_nz=0.45, keep=KEEP)
    return root


# ============================================================================
#  2. GREENHOUSE — pressurised grow-bay with a glazed vault and a real crop
#  target: x +/-4.60  y +/-4.60  z 0..4.90   (shipped: 9.20 x 9.20 x 4.90)
#  runtime: props.js put('greenhouse', vx-16, vz+10, 2.9, -0.5) — the corridor
#  end plugs into the +x gable, so that is the door side. The glazing is kept
#  as its own mesh so props.js can stop it casting an opaque shadow.
# ============================================================================
@builder
def greenhouse():
    root = empty("greenhouse", (0, 0, 0))
    W = P["white"]; CREAM = P["cream"]; ALU = P["alu"]; MACH = P["alumach"]
    DARK = P["gunmetal"]; RUB = P["rubber"]; CONC = P["concrete"]; GRATE = P["grate"]
    WORN = P["worn"]; RUST = P["rust"]; SOIL = P["soil"]; PLANT = P["plant"]
    COP = P["copper"]; INS = P["insul"]; ORANGE = P["orange"]; GL = P["lens"]
    AMBER = P["amber"]; CYAN = P["cyan"]; WARM = P["warm"]; MAG = P["magenta"]
    PANE = mat("glass_pane", (0.70, 0.88, 0.85), rough=0.05, alpha=0.22, coat=0.55)
    KEEP = {AMBER, CYAN, WARM, MAG, PANE, PLANT, GL, ORANGE}
    A = []
    G = []                                   # glazing: separate mesh, no shadow

    HY, ZX, RISE, SPAN = 0.90, 0.0, 3.80, 3.90    # springing height / rise / half-span
    XH = 4.20                                     # half length
    SEG = 9
    def arc(k, n=SEG):
        u = math.pi / 2.0 - k / float(n) * math.pi
        return u, SPAN * math.sin(u), ZX + RISE * math.cos(u)

    # ------------------------------------------------------------------- plinth
    A.append(rbox("plinth", 8.70, 8.06, 0.30, (0, 0, 0.15), CONC, bevel_r=0.045,
                  segs=2, par=root))
    A.append(rbox("plinth_curb", 8.86, 8.22, 0.09, (0, 0, 0.325), CONC,
                  bevel_r=0.02, segs=1, par=root))
    A += [boltgrid("plinth_bolt%d_%d" % (i > 0, j > 0),
                   (-4.20 + i * 8.40 / 10, -3.86 + j * 7.72 / 8, 0.372),
                   (1, 0, 0), (0, 1, 0), 1, 1, MACH, 0.0, 0.0, br=0.030, bh=0.026,
                   par=root) for i in (0, 10) for j in (0, 8)]
    for i in range(11):
        A.append(hexn("anchor_%d" % i, 0.048, 0.030, (-4.20 + i * 0.84, -3.86, 0.39),
                      MACH, par=root))
        A.append(hexn("anchor_b_%d" % i, 0.048, 0.030, (-4.20 + i * 0.84, 3.86, 0.39),
                      MACH, par=root))
    A += hazard_band("plinth_hazard", 0, -4.04, 0.20, 8.4, 0.20, 12, ORANGE, DARK,
                     axis='x', par=root, thick=0.026)

    # ------------------------------------------------- knee wall (insulated panel)
    for s in (-1, 1):
        for i in range(6):
            x = -XH + (i + 0.5) * (2 * XH) / 6.0
            A.append(obase("knee_%d_%d" % (s, i), (x, s * 3.94, 0.62), (2 * XH) / 6 - 0.06,
                           0.50, 0.075, (1, 0, 0), (0, 0, 1), CREAM, par=root))
            A.append(obase("knee_seam%d_%d" % (s, i), (x, s * 3.90, 0.62),
                           (2 * XH) / 6 - 0.02, 0.055, 0.10, (1, 0, 0), (0, 0, 1),
                           DARK, par=root))
        for i in range(7):
            x = -XH + i * (2 * XH) / 6.0
            A.append(pbox("knee_post%d_%d" % (s, i), 0.075, 0.10, 0.62,
                          (x, s * 3.96, 0.60), ALU, par=root))
        A.append(rod("gutter_%d" % (s > 0), 0.085, 2 * XH + 0.24, (0, s * 3.99, 0.93),
                     MACH, rot=(0, math.pi / 2, 0), verts=14, br=0.0, par=root))
        A.append(rod("gutter_lip%d" % (s > 0), 0.030, 2 * XH + 0.24,
                     (0, s * 4.07, 0.99), ALU, rot=(0, math.pi / 2, 0), verts=10,
                     br=0.0, par=root))
        for sx in (-1, 1):                     # downpipes into collection butts
            A += pipe_run("downpipe%d_%d" % (s > 0, sx > 0),
                          [(sx * (XH - 0.30), s * 4.02, 0.92),
                           (sx * (XH - 0.30), s * 4.24, 0.60),
                           (sx * (XH - 0.30), s * 4.30, 0.34)], 0.055, MACH, DARK,
                          par=root, flange_at=[1])
            A.append(cylinder_can("butt%d_%d" % (s > 0, sx > 0), 0.30, 0.62,
                                  (sx * (XH - 0.30), s * 4.32, 0.31), DARK, par=root,
                                  caps_mat=MACH))
            A.append(pbox("butt_gauge%d_%d" % (s > 0, sx > 0), 0.05, 0.03, 0.30,
                          (sx * (XH - 0.30) + 0.28, s * 4.32, 0.34), CYAN, par=root))

    # ------------------------------------------------------------- vault framing
    NST = 6                                    # 6 bays -> 7 ribs
    for i in range(NST + 1):
        x = -XH + i * (2 * XH) / NST
        A.append(poly_arc("rib%d" % i, x, ZX, SPAN, RISE, math.pi / 2, -math.pi / 2,
                          SEG, ALU, par=root))
        A.append(pbox("rib_foot%d_l" % i, 0.11, 0.11, 0.34, (x, -SPAN, 0.86), ALU,
                      par=root))
        A.append(pbox("rib_foot%d_r" % i, 0.11, 0.11, 0.34, (x, SPAN, 0.86), ALU,
                      par=root))
    for k in range(SEG + 1):
        u, yy, zz = arc(k)
        if 0 < k < SEG:
            A.append(rod("purlin%d" % k, 0.034, 2 * XH + 0.10, (0, yy, zz + 0.045),
                         MACH, rot=(0, math.pi / 2, 0), verts=8, br=0.0, par=root))
    A.append(rod("ridge_beam", 0.070, 2 * XH + 0.20, (0, 0, ZX + RISE + 0.06), ALU,
                 rot=(0, math.pi / 2, 0), verts=12, br=0.012, par=root))
    for i in range(NST + 1):                   # ridge cap plate per rib
        A.append(pbox("ridge_cap%d" % i, (2 * XH) / NST - 0.05, 0.30, 0.055,
                      (-XH + (i + 0.5) * (2 * XH) / NST if i < NST else XH - 0.35,
                       0, ZX + RISE + 0.14), W, par=root))

    # ------------------------------------------------------------------ glazing
    for i in range(NST):
        x0 = -XH + i * (2 * XH) / NST
        xm = x0 + (2 * XH) / NST / 2.0
        for k in range(SEG):
            ua, ya, za = arc(k)
            ub, yb, zb = arc(k + 1)
            ym, zm = (ya + yb) / 2.0, (za + zb) / 2.0
            al = math.atan2(zb - za, yb - ya)
            ch = math.hypot(yb - ya, zb - za)
            if k in (4, 5) and i in (2, 3):
                continue                       # ridge vents stand open here
            o = pbox("pane%d_%d" % (i, k), (2 * XH) / NST - 0.055, ch + 0.015, 0.028,
                     (xm, ym, zm + 0.088), PANE, rot=(al, 0, 0), par=root)
            G.append(o)
    # open ridge vents: two louvered hatch leaves raised off the deck
    for s in (-1, 1):
        for i in (2, 3):
            x0 = -XH + i * (2 * XH) / NST
            al = math.radians(38) * s
            o = pbox("vent%d_%d" % (i, s > 0), (2 * XH) / NST - 0.10, 0.62, 0.045,
                     (x0 + (2 * XH) / NST / 2.0, s * 0.42, ZX + RISE + 0.10), GL,
                     par=root)
            o.rotation_euler = (al, 0, 0)
            _only(o)
            bpy.ops.object.transform_apply(rotation=True)
            parent(o, root)
            G.append(o)
            A.append(pbox("vent_frame%d_%d" % (i, s > 0), (2 * XH) / NST - 0.04, 0.06,
                          0.10, (x0 + (2 * XH) / NST / 2.0, s * 0.76,
                                 ZX + RISE + 0.02), ALU, rot=(al * 0.5, 0, 0),
                          par=root))
            A += [rod("vent_arm%d_%d%d" % (i, s > 0, j), 0.016, 0.34,
                      (x0 + (2 * XH) / NST / 2.0 + (-1 + j) * 0.5, s * 0.60,
                       ZX + RISE - 0.04), MACH, rot=(math.radians(60), 0, 0),
                      verts=6, br=0.0, par=root) for j in (0, 1)]

    # --------------------------------------------------------------- gable walls
    # -x: technical end (air handler, louvers, plant). +x: people door for the
    # corridor that docks here.
    for s in (-1, 1):
        x = s * (XH + 0.04)
        for i in range(4):
            y = -3.45 + (i + 0.5) * 2.30
            A.append(obase("gable%d_%d" % (s, i), (x, y, 0.98), 2.24, 0.62, 0.09,
                           (0, 1, 0), (0, 0, 1), CREAM, par=root))
        for i in range(5):                     # spandrel glazing under the vault
            y = -3.45 + (i + 0.5) * 1.38
            if s > 0 and i in (1, 2, 3):
                # the corridor docks here: solid wall behind the door plane
                A.append(obase("gable_solid%d_%d" % (s, i), (x - 0.12, y, 1.52),
                               1.30, 1.06, 0.06, (0, 1, 0), (0, 0, 1), CREAM,
                               par=root))
                continue
            G.append(pbox("gable_glass%d_%d" % (s, i), 0.026, 1.30, 0.86,
                          (x, y, 1.54), PANE, par=root))
        for i in range(6):
            y = -3.45 + i * 1.38
            A.append(pbox("gable_mullion%d_%d" % (s, i), 0.085, 0.075, 1.14,
                          (x, y, 1.52), ALU, par=root))
        A.append(pbox("gable_eave%d" % s, 0.10, 7.00, 0.12, (x, 0, 2.06), ALU,
                      par=root))
        for j in range(4):
            u, yy, zz = arc(j + 1)
            A.append(obase("gable_sill%d_%d" % (s, j), (x, yy * 0.55, zz - 0.10),
                           0.10, 0.10, 0.10, (0, 1, 0), (0, 0, 1), ALU, par=root))
    # air handler block on the -x gable
    A.append(rbox("ahu", 0.60, 2.30, 1.50, (-4.60, 1.60, 1.05), W, bevel_r=0.06,
                  segs=2, par=root))
    A += louvers("ahu_louvers", (-4.92, 1.60, 1.30), 2.00, 0.60, 6, DARK, tilt=0.55,
                 axis='x', par=root)
    A += pipe_run("ahu_duct", [(-4.60, 0.20, 1.60), (-4.05, 0.20, 2.00),
                               (-3.40, 0.20, 1.92)], 0.16, ALU, MACH, par=root,
                  flange_at=[1, 2])
    A.append(pbox("ahu_display", 0.03, 0.44, 0.22, (-4.91, 1.02, 1.62), CYAN,
                  par=root))
    A.append(ring("ahu_fan", 0.30, 0.045, (-4.93, 2.42, 1.05), MACH, maj=16, mino=5,
                  rot=(0, math.pi / 2, 0), par=root))
    A += fan_blades("ahu_blades", (-4.93, 2.42, 1.05), (1, 0, 0), 0.06, 0.28, 7, 0.13,
                    DARK, par=root, tilt=0.7)
    # door: framed, glazed, with a closer rail, kick plate and a push bar
    A.append(pbox("door_jamb_l", 0.16, 0.12, 2.20, (XH + 0.02, -0.92, 1.10), ALU,
                  par=root))
    A.append(pbox("door_jamb_r", 0.16, 0.12, 2.20, (XH + 0.02, 0.92, 1.10), ALU,
                  par=root))
    A.append(pbox("door_head", 0.16, 1.96, 0.14, (XH + 0.02, 0, 2.14), ALU, par=root))
    A.append(pbox("door_leaf", 0.075, 1.78, 2.06, (XH + 0.06, 0, 1.03), W, par=root))
    o = pbox("door_light", 0.09, 1.30, 1.00, (XH + 0.06, 0, 1.50), PANE, par=root)
    G.append(o)
    A.append(pbox("door_kick", 0.085, 1.72, 0.30, (XH + 0.07, 0, 0.20), MACH,
                  par=root))
    A.append(rod("door_bar", 0.028, 1.10, (XH + 0.14, 0, 1.05), MACH,
                 rot=(math.pi / 2, 0, 0), verts=10, br=0.0, par=root))
    for sv in (-1, 1):
        A.append(pbox("door_hinge%d" % (sv > 0), 0.10, 0.16, 0.20,
                      (XH + 0.03, sv * 0.86, 0.60 + (sv > 0) * 1.0), DARK, par=root))
    A.append(rbox("door_ramp", 1.60, 2.10, 0.10, (XH + 0.90, 0, 0.06), CONC,
                  bevel_r=0.03, segs=1, rot=(0, math.radians(-6), 0), par=root))
    A += hazard_band("door_hazard", XH + 0.86, 0, 0.13, 1.5, 0.06, 8, ORANGE, DARK,
                     axis='y', par=root, thick=0.02)
    A.append(prism("door_lamp", 0.13, 0.22, (XH + 0.10, 0, 2.34), DARK, sides=10,
                   rot=(math.radians(122), 0, 0), par=root, br=0.02))
    A.append(obase("door_lens", (XH + 0.16, 0, 2.30), 0.16, 0.10, 0.02,
                   (0, 1, 0), (0, 0, 1), WARM, par=root))
    A += letter_row("bay_id", "AG BAY 03", (-1.55, -3.99, 0.48), 0.22, W,
                    depth=0.022, dirv=(1, 0, 0), up=(0, 0, 1), par=root, gapf=0.24)

    # ---------------------------------------------------------------- interior
    BEDY = (-2.72, -1.02, 1.02, 2.72)
    for n, by in enumerate(BEDY):
        A.append(rbox("bed%d" % n, 7.20, 0.70, 0.30, (0, by, 0.78), CREAM,
                      bevel_r=0.035, segs=1, par=root))
        A.append(pbox("bed_soil%d" % n, 7.02, 0.58, 0.05, (0, by, 0.945), SOIL,
                      par=root))
        for s in (-1, 1):
            A.append(rod("bed_rail%d%d" % (n, s > 0), 0.026, 7.20, (0, by + s * 0.36,
                         1.02), MACH, rot=(0, math.pi / 2, 0), verts=8, br=0.0,
                         par=root))
        for i in range(5):
            x = -3.2 + i * 1.6
            for s in (-1, 1):
                A.append(pbox("bed_leg%d%d%d" % (n, i, s > 0), 0.06, 0.06, 0.62,
                              (x, by + s * 0.28, 0.31), ALU, par=root))
        # drip line with emitters
        A.append(rod("drip%d" % n, 0.020, 7.10, (0, by, 1.30), MACH,
                     rot=(0, math.pi / 2, 0), verts=8, br=0.0, par=root))
        for i in range(13):
            A.append(rod("emitter%d_%d" % (n, i), 0.014, 0.10,
                         (-3.48 + i * 0.58, by, 1.24), COP, verts=6, br=0.0,
                         par=root))
        # the crop: nine plants per bed, three growth stages
        rnd = __import__("random").Random(1177 + n)
        for i in range(9):
            px = -3.20 + i * 0.80 + rnd.uniform(-0.07, 0.07)
            py = by + rnd.uniform(-0.16, 0.16)
            scl = (0.62, 1.0, 1.34)[i % 3]
            nl = 5 + (i % 3) * 2
            for j in range(nl):
                b = j / float(nl) * TAU + px
                ln = 0.20 * scl
                tilt = math.radians(34 + 16 * (j % 3))
                A.append(obase("leaf%d_%d_%d" % (n, i, j),
                               (px + math.cos(b) * ln * 0.55,
                                py + math.sin(b) * ln * 0.55,
                                0.97 + ln * 0.42 * math.sin(tilt) + 0.02),
                               0.055, ln, ln * 0.52,
                               (-math.sin(b), math.cos(b), 0),
                               (math.cos(b) * math.cos(tilt),
                                math.sin(b) * math.cos(tilt), math.sin(tilt)),
                               PLANT, par=root))
            A.append(rod("stem%d_%d" % (n, i), 0.014, 0.16 * scl, (px, py, 1.03),
                         PLANT, verts=6, br=0.0, par=root))
        # magenta grow-light bar over the bed
        A.append(rbox("bar%d" % n, 6.90, 0.20, 0.10, (0, by, 2.52), DARK,
                      bevel_r=0.02, segs=1, par=root))
        A.append(pbox("bar_led%d" % n, 6.62, 0.14, 0.035, (0, by, 2.455), MAG,
                     par=root))
        for i in (-1, 1):
            A.append(rod("bar_hanger%d_%d" % (n, i > 0), 0.014, 0.90,
                         (i * 2.6, by, 2.98), MACH, verts=6, br=0.0, par=root))
            A.append(ring("bar_hang_eye%d_%d" % (n, i > 0), 0.035, 0.010,
                          (i * 2.6, by, 3.42), MACH, maj=8, mino=4, par=root))
    # aisle grating, seedling racks, propagation dome, a control trolley
    A += grating("aisle_grate", 0, 0, 0.36, 7.60, 1.20, GRATE, par=root, nx=14,
                 ny=3, t=0.024)
    for n, by in enumerate((-1.87, 1.87)):
        A.append(pbox("cross%d" % n, 0.80, 0.06, 0.06, (0, by, 0.66), ALU, par=root))
    for i, (rx, ry) in enumerate(((-3.55, -1.87), (-3.55, 1.87))):
        A.append(rbox("rack%d" % i, 0.90, 0.74, 1.60, (rx, ry, 0.80), MACH,
                      bevel_r=0.02, segs=1, par=root))
        for j in range(4):
            A.append(pbox("rack_shelf%d_%d" % (i, j), 0.94, 0.78, 0.035,
                          (rx, ry, 0.30 + j * 0.42), GRATE, par=root))
            A.append(pbox("rack_tray%d_%d" % (i, j), 0.80, 0.62, 0.06,
                          (rx, ry, 0.345 + j * 0.42), SOIL, par=root))
            for q in range(6):
                A.append(ball("rack_sprout%d_%d%d" % (i, j, q), 0.045,
                              (rx - 0.30 + q * 0.12, ry + (q % 2) * 0.18 - 0.09,
                               0.40 + j * 0.42), PLANT, segs=8, par=root))
    # a harvest trolley parked in the aisle — the base's only other robot
    A.append(rbox("trolley_body", 0.92, 0.62, 0.34, (1.30, 0.0, 0.60), W,
                  bevel_r=0.05, segs=2, par=root))
    A.append(rbox("trolley_bin", 0.70, 0.48, 0.26, (1.30, 0.0, 0.86), GRATE,
                  bevel_r=0.03, segs=1, par=root))
    for sx in (-1, 1):
        for sy in (-1, 1):
            A.append(rod("trolley_wheel%d%d" % (sx > 0, sy > 0), 0.11, 0.06,
                         (1.30 + sx * 0.40, sy * 0.30, 0.40), RUB,
                         rot=(0, math.pi / 2, 0), verts=14, br=0.015, par=root))
    A.append(rod("trolley_handle", 0.022, 0.66, (1.86, 0.0, 0.98), MACH,
                 rot=(math.pi / 2, 0, 0), verts=8, br=0.0, par=root))
    A.append(pbox("trolley_screen", 0.02, 0.26, 0.16, (1.78, 0.0, 0.92), CYAN,
                  par=root))
    A.append(prism("trolley_lamp", 0.06, 0.05, (1.30, 0.0, 1.02), AMBER, sides=8,
                   par=root, br=0.01))
    # circulation fans on the purlins + a condensate trough under the ridge
    for i in (-1, 1):
        fx = i * 2.1
        A.append(ring("fan_shroud%d" % (i > 0), 0.34, 0.055, (fx, 0, 3.30), ALU,
                      maj=20, mino=6, rot=(math.pi / 2, 0, 0), par=root))
        A += fan_blades("fan_blade%d" % (i > 0), (fx, 0, 3.30), (0, 1, 0), 0.05, 0.30,
                        6, 0.13, DARK, par=root, tilt=0.62)
        A.append(rod("fan_hub%d" % (i > 0), 0.055, 0.10, (fx, 0, 3.30), MACH,
                     verts=10, br=0.01, par=root))
        A.append(pbox("fan_bracket%d" % (i > 0), 0.05, 0.05, 0.42,
                      (fx, 0, 3.55), MACH, par=root))
    A.append(rod("cond_trough", 0.055, 7.40, (0, 0.30, 3.60), MACH,
                 rot=(0, math.pi / 2, 0), verts=12, br=0.0, par=root))
    # exterior: planters, a bench, stacked flats and a shade-cloth roller
    for i in range(3):
        A.append(rbox("ext_planter%d" % i, 1.10, 0.62, 0.42,
                      (-3.10 + i * 1.62, -4.62, 0.21), CREAM, bevel_r=0.04, segs=1,
                      par=root))
        A.append(pbox("ext_soil%d" % i, 1.00, 0.52, 0.04, (-3.10 + i * 1.62, -4.62,
                      0.42), SOIL, par=root))
        for j in range(5):
            # young hedge stock: a stem with six drooping leaves, not a green ball
            px, py = -3.50 + i * 1.62 + j * 0.20, -4.62 + (j % 2) * 0.16 - 0.04
            hgt = 0.20 + 0.055 * ((i * 5 + j) % 3)
            A.append(rod("ext_stem%d_%d" % (i, j), 0.016, hgt, (px, py, 0.44 + hgt / 2),
                         PLANT, verts=6, br=0.0, par=root))
            for q in range(6):
                b = math.radians(60 * q + j * 24)
                tilt = math.radians(46 + 14 * (q % 3))
                ln = 0.15 + 0.03 * ((i + j + q) % 2)
                A.append(obase("ext_leaf%d_%d%d" % (i, j, q),
                               (px + math.cos(b) * ln * 0.5,
                                py + math.sin(b) * ln * 0.5,
                                0.44 + hgt * (0.55 + 0.13 * (q % 3))),
                               0.048, ln, ln * 0.5,
                               (-math.sin(b), math.cos(b), 0),
                               (math.cos(b) * math.cos(tilt),
                                math.sin(b) * math.cos(tilt), math.sin(tilt)),
                               PLANT, par=root))
    A.append(rbox("ext_bench", 1.80, 0.46, 0.09, (3.10, -4.60, 0.46), CREAM,
                  bevel_r=0.02, segs=1, par=root))
    for sx in (-1, 1):
        A.append(pbox("bench_leg%d" % (sx > 0), 0.08, 0.42, 0.44,
                      (3.10 + sx * 0.78, -4.60, 0.22), ALU, par=root))
    for j in range(3):
        A.append(rbox("flat%d" % j, 0.62, 0.42, 0.09, (4.30, 2.10 - j * 0.02,
                      0.45 + j * 0.14), MACH, bevel_r=0.015, segs=1,
                      rot=(0, 0, 0.2 * j), par=root))
    A.append(rod("shade_roller", 0.075, 6.20, (-0.9, 2.62, 3.06), DARK,
                 rot=(0, math.pi / 2, 0), verts=12, br=0.0, par=root))
    A.append(pbox("shade_cloth", 6.10, 0.02, 0.90, (-0.9, 2.62, 2.62), WORN,
                  rot=(math.radians(-16), 0, 0), par=root))
    for sx in (-1, 1):
        A.append(pbox("shade_post%d" % (sx > 0), 0.06, 0.06, 0.62,
                      (-0.9 + sx * 3.1, 2.62, 3.32), MACH, par=root))

    # ------------------------------------------------------------------- finish
    b = join(meshes(A), "greenhouse_body")
    parent(b, root)
    smooth_angle(b, 34)
    dust_top(b, zmin=0.30, min_nz=0.60, keep=KEEP)
    scuff_low(b, zmax=0.95, max_nz=0.50, keep=KEEP)
    reassign(b, lambda p, c, nn: c.z < 0.42 and abs(c.x) > 3.4, RUST, keep=KEEP)
    gl = join(meshes(G), "greenhouse_glass")
    parent(gl, root)
    smooth_angle(gl, 60)
    return root


# ============================================================================
#  3. LAUNCH TOWER — chopstick strongback + service mast on PAD A1
#  target: x +/-7.70  y +/-3.10  z 0..49.40   (shipped: 15.40 x 6.20 x 49.40)
#  runtime: props.js does put('launch_tower', px+11, pz, 0.62, PI*0.92, -0.2)
#  with a collider of r 4 world, and the starship stands at px. After that
#  rotation the model's LOCAL +x points at the vehicle, so the strongback and
#  every swinging arm live on +x and the service mast, stairs and cryo lines on
#  -x. Tipped 165.6deg, so both faces of the plan get seen — model both.
# ============================================================================
@builder
def launch_tower():
    root = empty("launch_tower", (0, 0, 0))
    W = P["white"]; CREAM = P["cream"]; ALU = P["alu"]; MACH = P["alumach"]
    DARK = P["gunmetal"]; STEEL = P["steel"]; RUB = P["rubber"]; CONC = P["concrete"]
    GRATE = P["grate"]; WORN = P["worn"]; RUST = P["rust"]; COP = P["copper"]
    INS = P["insul"]; ORANGE = P["orange"]; REDP = P["red"]; GL = P["lens"]
    AMBER = P["amber"]; CYAN = P["cyan"]; WARM = P["warm"]; REDL = P["redglow"]
    KEEP = {AMBER, CYAN, WARM, REDL, GL, ORANGE, REDP}
    A = []
    ZT, ZS = 44.0, 41.0                        # mast top / strongback top
    MC, SC = -4.90, 4.65                       # mast / strongback plan centres

    # ------------------------------------------------------------- pad footing
    A.append(rbox("footing", 15.20, 5.90, 0.48, (0, 0, 0.24), CONC, bevel_r=0.05,
                  segs=2, par=root))
    A.append(rbox("footing_curb", 15.44, 6.14, 0.12, (0, 0, 0.50), CONC,
                  bevel_r=0.03, segs=1, par=root))
    for i in range(13):
        for j in range(5):
            x, y = -6.6 + i * 1.10, -2.3 + j * 1.15
            if abs(x - MC) < 2.1 or abs(x - SC) < 1.7:
                A.append(hexn("anchor%d_%d" % (i, j), 0.055, 0.040, (x, y, 0.565),
                              MACH, par=root))
                A.append(ring("anchor_w%d_%d" % (i, j), 0.075, 0.016, (x, y, 0.545),
                              DARK, maj=10, mino=4, par=root))
    # flame trench: duct walls, a curved liner and a deluge ring
    for s in (-1, 1):
        A.append(rbox("trench_wall%d" % (s > 0), 8.20, 0.42, 1.30, (-3.2, s * 2.30, 0.62),
                      CONC, bevel_r=0.05, segs=1, par=root))
    A.append(rbox("trench_floor", 8.20, 4.30, 0.24, (-3.2, 0, 0.12), WORN,
                  bevel_r=0.03, segs=1, par=root))
    for i in range(9):
        A.append(pbox("trench_rib%d" % i, 0.10, 4.20, 0.16,
                      (-6.9 + i * 0.95, 0, 0.26), DARK, par=root))
    A.append(ring("deluge_ring", 3.05, 0.085, (-2.2, 0, 0.60), COP, maj=28, mino=6,
                  rot=(0, math.pi / 2, 0), par=root))
    for j in range(10):
        b = j / 10.0 * TAU
        A.append(cone("deluge_noz%d" % j, 0.055, 0.022, 0.14,
                      (-2.2 + 3.05 * math.cos(b) * 0.0, 3.05 * math.sin(b) * 0.62,
                       0.72), MACH, verts=8, par=root))
    A += pipe_run("deluge_feed", [(-2.2, -1.9, 0.60), (-5.4, -2.6, 0.60),
                                  (-7.0, -2.6, 0.34)], 0.11, COP, MACH, par=root,
                  flange_at=[1, 2])
    A += hazard_band("kerb_hazard", -1.0, 3.00, 0.60, 11.0, 0.22, 16, ORANGE, DARK,
                     axis='x', par=root, thick=0.03)
    A += [pbox("kerb_tooth%d" % i, 0.70, 0.30, 0.62, (-6.4 + i * 1.40, 2.90, 0.55),
               CONC, par=root) for i in range(10)]
    A += [pbox("kerb_tooth_b%d" % i, 0.70, 0.30, 0.62, (-6.4 + i * 1.40, -2.90, 0.55),
               CONC, par=root) for i in range(10)]

    # -------------------------------------------------------------- service mast
    A += rect_lattice("mast", MC, 0, 1.80, 1.62, 1.20, 1.10, 0.55, ZT, 12, STEEL,
                      DARK, m_node=MACH, par=root, chord_r=0.115, brace_r=0.062)
    # strongback: a narrow, deeper truss that carries the arms
    A += rect_lattice("strong", SC, 0, 0.80, 1.40, 0.55, 1.00, 0.55, ZS, 14, STEEL,
                      DARK, m_node=MACH, par=root, chord_r=0.095, brace_r=0.052)
    # tie beams between the two trusses, each with a diagonal and a service walk
    for i, zz in enumerate((9.0, 16.0, 23.0, 30.0, 37.0)):
        A.append(rod("tie_top%d" % i, 0.075, SC - MC, ((MC + SC) / 2, 0, zz + 1.55),
                     STEEL, rot=(0, math.pi / 2, 0), verts=10, br=0.0, par=root))
        A.append(rod("tie_bot%d" % i, 0.075, SC - MC, ((MC + SC) / 2, 0, zz - 0.30),
                     STEEL, rot=(0, math.pi / 2, 0), verts=10, br=0.0, par=root))
        A += crossbrace("tie_x%d" % i, (MC, -0.9, zz - 0.30), (MC, 0.9, zz + 1.55),
                        (SC, 0.9, zz - 0.30), (SC, -0.9, zz + 1.55), 0.048, DARK,
                        par=root)
        A += grating("tie_walk%d" % i, (MC + SC) / 2, 0, zz + 1.62, SC - MC - 0.4,
                     1.50, GRATE, par=root, nx=7, ny=3, t=0.026)
        A += rect_rail("tie_rail%d" % i, (MC + SC) / 2, 0, zz + 1.64, SC - MC - 0.4,
                       1.50, MACH, MACH, par=root, h=1.05, n_x=5, n_y=1)
    # base collars and a stiffened pedestal on each truss
    for cx, hw, hd in ((MC, 2.05, 1.85), (SC, 1.05, 1.65)):
        A.append(rbox("pedestal_%g" % cx, hw * 2, hd * 2, 0.66, (cx, 0, 0.83), CONC,
                      bevel_r=0.05, segs=1, par=root))
        for s in (-1, 1):
            for t in (-1, 1):
                A.append(rod("ped_pin%d_%d%d" % (cx, s > 0, t > 0), 0.055, 0.70,
                             (cx + s * (hw - 0.25), t * (hd - 0.25), 1.20), MACH,
                             verts=8, br=0.0, par=root))

    # ------------------------------------------------------------- access arms
    # Six swinging arms, each a real parallel-chord truss with a grating deck,
    # guard rail, cradle collar and a hoist cable to the strongback head.
    ARMS = ((7.2, 4.30), (13.0, 4.60), (19.4, 5.00), (25.8, 4.80), (32.0, 4.40),
            (37.8, 3.90))
    for i, (za, reach) in enumerate(ARMS):
        x0, x1 = SC - 0.55, SC + reach
        for sy in (-1, 1):
            A.append(rod("arm_chord%d_%d" % (i, sy > 0), 0.085, x1 - x0,
                         ((x0 + x1) / 2, sy * 0.72, za + 1.42), STEEL,
                         rot=(0, math.pi / 2, 0), verts=10, br=0.0, par=root))
            A.append(rod("arm_low%d_%d" % (i, sy > 0), 0.070, x1 - x0,
                         ((x0 + x1) / 2, sy * 0.72, za + 0.22), STEEL,
                         rot=(0, math.pi / 2, 0), verts=10, br=0.0, par=root))
        n = max(3, int((x1 - x0) / 1.5))
        for j in range(n + 1):
            x = x0 + j * (x1 - x0) / n
            for sy in (-1, 1):
                A.append(rod("arm_v%d_%d%d" % (i, j, sy > 0), 0.038, 1.20,
                             (x, sy * 0.72, za + 0.82), DARK, verts=8, br=0.0,
                             par=root))
                if j < n:
                    xm = x0 + (j + 0.5) * (x1 - x0) / n
                    A.append(rod("arm_d%d_%d%d" % (i, j, sy > 0), 0.034,
                                 math.hypot((x1 - x0) / n, 1.20), (xm, sy * 0.72,
                                 za + 0.82), DARK,
                                 rot=(0, math.atan2(1.20, (x1 - x0) / n) * (
                                     1 if (j + i) % 2 else -1), 0), verts=8, br=0.0,
                                 par=root))
        for sy in (-1, 1):                     # diagonal web to the strongback
            A.append(rod("arm_riser%d%d" % (i, sy > 0), 0.048,
                         math.hypot(1.1, 2.3), (x0 + 0.55, sy * 0.55, za + 2.6),
                         STEEL, rot=(0, math.atan2(1.1, 2.3), 0), verts=8, br=0.0,
                         par=root))
        A += grating("arm_deck%d" % i, (x0 + x1) / 2, 0, za + 0.06, x1 - x0 + 0.4,
                     2.10, GRATE, par=root, nx=9, ny=4, t=0.028)
        A += rect_rail("arm_rail%d" % i, (x0 + x1) / 2, 0, za + 0.10, x1 - x0 + 0.4,
                       2.10, MACH, MACH, par=root, h=1.08, n_x=6, n_y=2)
        A.append(pbox("arm_toe%d" % i, x1 - x0 + 0.5, 2.2, 0.06,
                      ((x0 + x1) / 2, 0, za + 0.02), DARK, par=root))
        # cradle collar hugging the vehicle at the arm's outer end
        A.append(ring("arm_collar%d" % i, 1.05, 0.075, (x1, 0, za + 0.86), RUB,
                      maj=22, mino=6, rot=(0, math.pi / 2, 0), par=root))
        for j in range(4):
            b = math.radians(90 * j + 45)
            A.append(pbox("arm_key%d_%d" % (i, j), 0.16, 0.16, 0.34,
                          (x1, 1.05 * math.cos(b), za + 0.86 + 1.05 * math.sin(b)),
                          MACH, par=root))
        # hinge box + hoist cable back to the strongback head
        A.append(rbox("arm_hinge%d" % i, 0.46, 1.70, 1.80, (SC - 0.35, 0, za + 0.80),
                      DARK, bevel_r=0.06, segs=2, par=root))
        A.append(rod("arm_hinge_pin%d" % i, 0.10, 1.90, (SC - 0.35, 0, za + 1.62),
                     MACH, rot=(math.pi / 2, 0, 0), verts=12, br=0.0, par=root))
        A.append(tube("arm_cable%d" % i, [(SC - 0.2, 0, ZS + 1.0),
                                          (SC + 0.9, 0, za + 2.6 + (ZS - za) * 0.10),
                                          (x1 - 0.4, 0, za + 1.50)], 0.028, WORN,
                      res=1, par=root))
        # service umbilical riding under each arm
        A += pipe_run("arm_line%d" % i, [(SC, 0.45, za + 0.30),
                                         (x0 + 1.2, 0.45, za + 0.16),
                                         (x1 - 0.6, 0.45, za + 0.24)], 0.055,
                      INS, MACH, par=root, flange_at=[2], clamp_at=[0.35])
        A.append(prism("arm_qd%d" % i, 0.14, 0.20, (x1 - 0.5, 0.45, za + 0.24), MACH,
                       sides=12, rot=(0, math.pi / 2, 0), par=root, br=0.02))
        A.append(pbox("arm_lamp%d" % i, 0.30, 0.10, 0.16, (x1 - 0.1, -1.06,
                      za + 0.30), AMBER, rot=(0, 0, math.radians(18)), par=root))

    # ------------------------------------------------------- cryo service lines
    # Three risers climb the mast's -x face, girth-clamped every 3 m, and break
    # over the top into a gooseneck that feeds the strongback carriage.
    for n, (yy, rr, mm) in enumerate(((-1.05, 0.185, INS), (0.0, 0.235, ALU),
                                      (1.05, 0.145, COP))):
        pts = [(MC - 1.85, yy, 0.60), (MC - 1.72, yy, 6.0), (MC - 1.60, yy, 20.0),
               (MC - 1.55, yy, 34.0), (MC - 1.50, yy, ZT - 2.0),
               (MC - 1.0, yy, ZT + 0.6), (MC + 0.6, yy * 0.6, ZT + 1.05)]
        A += pipe_run("cryo_riser%d" % n, pts, rr, mm, MACH, par=root,
                      flange_at=[0, 1, 3, 5, 6],
                      clamp_at=[0.12, 0.26, 0.40, 0.54, 0.68, 0.82], res=3)
    A += pipe_run("cryo_crossover", [(MC + 0.6, -0.6, ZT + 1.05),
                                     (MC + 2.6, -0.3, ZT + 1.30),
                                     (SC - 0.9, -0.2, ZT + 1.20),
                                     (SC - 0.4, 0.0, ZT - 1.0)], 0.14, INS, MACH,
                 par=root, flange_at=[1, 3])
    # valve island at the foot of the mast
    A.append(rbox("vali", 1.20, 3.30, 0.80, (MC - 1.55, 0, 1.30), STEEL,
                  bevel_r=0.05, segs=2, par=root))
    for j in range(3):
        A.append(rod("vali_stem%d" % j, 0.055, 0.50, (MC - 1.55, -1.1 + j * 1.1, 1.86),
                     MACH, verts=10, br=0.01, par=root))
        A.append(ring("vali_hand%d" % j, 0.20, 0.030, (MC - 1.55, -1.1 + j * 1.1, 2.10),
                      REDP, maj=16, mino=5, rot=(math.pi / 2, 0, 0), par=root))
        A.append(prism("vali_gauge%d" % j, 0.115, 0.06, (MC - 2.18, -1.1 + j * 1.1,
                       1.62), GL, sides=12, rot=(0, math.pi / 2, 0), par=root,
                       br=0.01))
    A += [pbox("vali_bolt%d" % j, 0.06, 0.06, 0.06, (MC - 1.55 + (j % 2 * 2 - 1) * 0.5,
          -1.5 + (j // 2) * 1.5, 1.70), MACH, par=root) for j in range(4)]

    # -------------------------------------------------- stairs, ladders, lift
    # A stair tower on the -x face of the mast with six landings, plus a lift.
    LAND = (2.20, 9.00, 16.00, 23.00, 30.00, 37.00, ZT - 2.20)
    for i, zz in enumerate(LAND):
        A += grating("land_grate%d" % i, MC - 2.5, 0, zz, 2.30, 3.10, GRATE,
                     par=root, nx=3, ny=7, t=0.028)
        A += rect_rail("land_rail%d" % i, MC - 2.5, 0, zz + 0.02, 2.30, 3.10, MACH,
                       MACH, par=root, h=1.06, n_x=2, n_y=4)
        A.append(pbox("land_bumper%d" % i, 0.06, 3.10, 0.10, (MC - 3.66, 0, zz + 0.06),
                      RUB, par=root))
    for i in range(len(LAND) - 1):
        z0, z1 = LAND[i], LAND[i + 1]
        n = max(6, int((z1 - z0) / 0.42))
        for j in range(n):
            t = j / float(n)
            A.append(pbox("step%d_%d" % (i, j), 0.30, 1.30, 0.045,
                          (MC - 3.55 + t * 2.30, 0, z0 + 0.20 + t * (z1 - z0)),
                          GRATE, par=root))
        A.append(rod("stringer%d" % i, 0.060, math.hypot(2.30, z1 - z0),
                     (MC - 2.40, -0.66, (z0 + z1) / 2 + 0.10), STEEL,
                     rot=(0, math.atan2(2.30, z1 - z0) * -1 + math.pi / 2, 0),
                     verts=8, br=0.0, par=root))
        A.append(rod("stringer_b%d" % i, 0.060, math.hypot(2.30, z1 - z0),
                     (MC - 2.40, 0.66, (z0 + z1) / 2 + 0.10), STEEL,
                     rot=(0, math.atan2(2.30, z1 - z0) * -1 + math.pi / 2, 0),
                     verts=8, br=0.0, par=root))
        A += rect_rail("stair_rail%d" % i, MC - 2.40, -0.72, (z0 + z1) / 2, 2.30, 0.05,
                       MACH, MACH, par=root, h=0.98, n_x=3, n_y=0, toe=False)
    A += ladder("mast_ladder", MC - 1.66, 1.72, 1.5, 22.0, MACH, ALU, width=0.48,
                par=root, cage=True, cage_from=4.0)
    A += ladder("mast_ladder_hi", MC - 1.42, 1.45, 22.0, ZT - 2.0, MACH, ALU,
                width=0.48, par=root, cage=True, cage_from=24.0)
    # lift: guide rails, a cage car, a counterweight and a machine house
    for sy in (-1, 1):
        A.append(rod("lift_rail%d" % (sy > 0), 0.055, ZT - 3.2,
                     (MC - 2.05, sy * 0.62, (ZT + 2.2) / 2), MACH, verts=8, br=0.0,
                     par=root))
    A.append(rbox("lift_car", 1.35, 1.40, 2.10, (MC - 2.05, 0, 12.4), GRATE,
                  bevel_r=0.05, segs=2, par=root))
    A.append(pbox("lift_roof", 1.45, 1.50, 0.09, (MC - 2.05, 0, 13.52), ALU, par=root))
    for s in (-1, 1):
        A.append(pbox("lift_guide%d" % (s > 0), 0.30, 0.24, 0.34,
                      (MC - 2.05, s * 0.66, 11.40), DARK, par=root))
        A.append(pbox("lift_guide%d" % (s > 0), 0.30, 0.24, 0.34,
                      (MC - 2.05, s * 0.66, 13.40), DARK, par=root))
    A.append(rbox("lift_cwt", 0.50, 0.80, 2.40, (MC - 2.05, 0, 30.0), WORN,
                  bevel_r=0.04, segs=1, par=root))
    A.append(rod("lift_rope", 0.022, ZT - 15.5, (MC - 2.05, 0, (ZT + 13.5) / 2), RUB,
                 verts=6, br=0.0, par=root))

    # ------------------------------------------------------------- head house
    A.append(rbox("head_floor", 4.30, 3.90, 0.18, (MC, 0, ZT + 0.62), GRATE,
                  bevel_r=0.03, segs=1, par=root))
    for s in (-1, 1):                          # built-up panel walls, both sides
        for i in range(5):
            for j in range(3):
                A.append(obase("head_panel%d_%d_%d" % (s, i, j),
                               (MC - 2.10 + (i + 0.5) * 0.84, s * 2.00,
                                ZT + 0.78 + (j + 0.5) * 0.80), 0.78, 0.74, 0.07,
                               (1, 0, 0), (0, 0, 1), W, par=root))
        for i in range(6):
            A.append(pbox("head_vseam%d_%d" % (s, i), 0.05, 0.075, 2.42,
                          (MC - 2.10 + i * 0.84, s * 1.975, ZT + 1.93), DARK,
                          par=root))
        for j in range(4):
            A.append(pbox("head_hseam%d_%d" % (s, j), 4.22, 0.075, 0.05,
                          (MC, s * 1.975, ZT + 0.78 + j * 0.80), DARK, par=root))
    for s in (-1, 1):
        A.append(obase("head_end%d" % (s > 0), (MC + s * 2.15, 0, ZT + 1.92), 3.80,
                       2.40, 0.09, (0, 1, 0), (0, 0, 1), CREAM, par=root))
    A.append(rbox("head_roof", 4.70, 4.30, 0.14, (MC, 0, ZT + 3.20), ALU,
                  bevel_r=0.04, segs=1, par=root))
    A += louvers("head_louvers", (MC - 2.20, 0, ZT + 2.60), 3.0, 0.70, 5, DARK,
                 tilt=0.5, axis='x', par=root)
    A += rect_rail("head_rail", MC, 0, ZT + 0.72, 4.30, 3.90, MACH, MACH, par=root,
                   h=1.05, n_x=4, n_y=3)
    # winch drum + crane jib reaching over the vehicle
    A.append(rod("winch_drum", 0.52, 1.60, (MC + 0.4, 0, ZT + 1.55), DARK,
                 rot=(0, math.pi / 2, 0), verts=20, br=0.05, par=root))
    A.append(rod("winch_shaft", 0.085, 2.30, (MC + 0.4, 0, ZT + 1.55), MACH,
                 rot=(0, math.pi / 2, 0), verts=10, br=0.0, par=root))
    A += [pbox("winch_flange%d" % (s > 0), 0.10, 1.72, 1.20,
               (MC + 0.4 + s * 0.86, 0, ZT + 1.55), STEEL, rot=(0, 0, 0.7 + s * 0.4),
               par=root) for s in (-1, 1)]
    A.append(tube("crane_jib", [(MC + 1.4, 0, ZT + 3.0), (SC + 1.6, 0, ZS + 2.2),
                               (SC + 5.2, 0, ZS + 1.0)], 0.14, STEEL, res=2, par=root))
    A.append(tube("crane_stay", [(MC - 1.0, 0, ZT + 4.4), (SC + 4.4, 0, ZS + 1.6)],
                  0.032, WORN, res=1, par=root))
    A.append(rbox("crane_block", 0.44, 0.34, 0.60, (SC + 4.8, 0, ZS + 0.6), DARK,
                  bevel_r=0.05, segs=2, par=root))
    A.append(rod("crane_hook", 0.055, 0.62, (SC + 4.8, 0, ZS + 0.0), MACH, verts=8,
                 br=0.0, par=root))
    # lightning masts and guys
    for s in (-1, 1):
        A.append(rod("lightning%d" % (s > 0), 0.045, 4.40,
                     (MC + s * 1.7, 0, ZT + 5.4), MACH, verts=8, br=0.0, par=root))
        A.append(ball("lightning_tip%d" % (s > 0), 0.12, (MC + s * 1.7, 0, ZT + 7.7),
                      ALU, segs=10, par=root))
        A.append(tube("guy%d" % (s > 0), [(MC + s * 1.7, 0, ZT + 5.0),
                                          (MC + s * 3.4, 0, ZT - 8.0),
                                          (MC + s * 3.9, 0, 1.0)], 0.018, WORN,
                      res=1, par=root))
        A.append(tube("guyb%d" % (s > 0), [(MC + s * 1.7, s * 1.2, ZT + 5.0),
                                           (MC + s * 2.2, s * 2.6, ZT - 6.0)],
                      0.016, WORN, res=1, par=root))
    # floodlight bars on the strongback and the mast
    for i, (fx, fy, fz, ry) in enumerate(((MC - 2.1, -1.4, ZT - 6.0, 0.5),
                                          (MC - 2.1, 1.4, ZT - 12.0, -0.5),
                                          (SC + 1.0, 0, ZS - 4.0, 1.9),
                                          (SC + 1.0, 0, ZS - 16.0, 1.9))):
        A.append(rbox("flood%d" % i, 0.20, 1.45, 0.44, (fx, fy, fz), DARK,
                      bevel_r=0.04, segs=1, rot=(0, 0, ry), par=root))
        for j in range(4):
            A.append(obase("flood_lens%d_%d" % (i, j),
                           (fx + 0.12 * math.cos(ry), fy - 0.54 + j * 0.36, fz),
                           0.26, 0.05, 0.30,
                           (-math.sin(ry), math.cos(ry), 0), (0, 0, 1), GL, par=root))
            A.append(obase("flood_em%d_%d" % (i, j),
                           (fx + 0.135 * math.cos(ry), fy - 0.54 + j * 0.36, fz),
                           0.22, 0.02, 0.24,
                           (-math.sin(ry), math.cos(ry), 0), (0, 0, 1), WARM,
                           par=root))
        A.append(rod("flood_stay%d" % i, 0.028, 0.80, (fx - 0.30 * math.cos(ry), fy,
                     fz + 0.55), MACH, rot=(math.radians(70), 0, ry), verts=6,
                     br=0.0, par=root))
    # aviation warning lights and the tower's identity board
    for i, zz in enumerate((ZT + 3.1, 27.0, 12.0)):
        A.append(prism("beacon%d" % i, 0.16, 0.14, (MC, 0, zz), REDL, sides=10,
                       par=root, br=0.02))
        A.append(ring("beacon_collar%d" % i, 0.21, 0.035, (MC, 0, zz - 0.10), MACH,
                      maj=14, mino=5, par=root))
    A += letter_row("tower_id", "RED STARBASE", (-6.9, -3.06, 5.90), 1.05, W,
                    depth=0.05, dirv=(1, 0, 0), up=(0, 0, 1), par=root, gapf=0.16)
    A += [pbox("id_board%d" % j, 0.06, 0.06, 0.06, (-7.0 + j * 1.1, -3.10, 5.30),
               MACH, par=root) for j in range(14)]
    A.append(rbox("id_board", 15.0, 0.10, 2.30, (-0.6, -3.14, 6.05), DARK,
                  bevel_r=0.03, segs=1, par=root))
    # cable trays on both trusses, and a conduit bundle into the pad
    for i in range(46):
        z = 1.6 + i * 0.92
        A.append(pbox("tray_rung%d" % i, 0.055, 0.62, 0.026, (MC - 1.75, 0, z), STEEL,
                      par=root))
        A.append(pbox("tray_rung_b%d" % i, 0.055, 0.62, 0.026, (SC + 0.95, 0, z), STEEL,
                      par=root))
    for s in (-1, 1):
        A.append(pbox("tray_side%d" % (s > 0), 0.030, 0.055, 42.0,
                      (MC - 1.75, s * 0.31, 22.0), STEEL, par=root))
        A.append(pbox("tray_side_b%d" % (s > 0), 0.030, 0.055, 40.0,
                      (SC + 0.95, s * 0.31, 21.0), STEEL, par=root))
        A += pipe_run("conduit%d" % (s > 0), [(MC - 1.75, s * 0.20, 3.0),
                                              (MC - 2.6, s * 0.9, 1.2),
                                              (MC - 3.4, s * 1.6, 0.62)], 0.055, RUB,
                      DARK, par=root, clamp_at=[0.5])
    # two knuckle-boom service booms on the mast's outer face
    for i, zz in enumerate((14.0, 26.0)):
        A.append(rod("boom%d" % i, 0.085, 4.2, (MC + 0.6, 0, zz), STEEL,
                     rot=(0, math.radians(64), 0), verts=10, br=0.0, par=root))
        A.append(ring("boom_knuckle%d" % i, 0.14, 0.045, (MC + 2.4, 0, zz + 1.9), MACH,
                      maj=12, mino=5, rot=(0, math.pi / 2, 0), par=root))
        A.append(rod("boom%d_up" % i, 0.065, 3.0, (MC + 3.5, 0, zz + 3.2), STEEL,
                     rot=(0, math.radians(-28), 0), verts=10, br=0.0, par=root))
        A.append(pbox("boom_platform%d" % i, 1.30, 1.30, 0.07, (MC + 4.6, 0,
                      zz + 4.5), GRATE, par=root))
        A += rect_rail("boom_rail%d" % i, MC + 4.6, 0, zz + 4.55, 1.30, 1.30, MACH,
                       MACH, par=root, h=1.0, n_x=2, n_y=2)
    # access doors on the mast and the strongback, and a fire standpipe
    A.append(rbox("base_door", 0.10, 1.10, 2.05, (MC - 1.90, 0, 1.60), GRATE,
                  bevel_r=0.03, segs=1, par=root))
    A.append(rod("door_bar", 0.022, 0.90, (MC - 1.99, 0.42, 1.55), MACH, verts=8,
                 br=0.0, par=root))
    A.append(rbox("base_door_b", 1.10, 1.10, 0.10, (SC, 0, 2.10), GRATE,
                  bevel_r=0.03, segs=1, par=root))
    A.append(prism("door_wheel", 0.16, 0.05, (SC, 0, 2.10), MACH, sides=12,
                   rot=(math.pi / 2, 0, 0), par=root, br=0.01))
    A += pipe_run("standpipe", [(-7.1, 2.4, 0.34), (-7.1, 2.4, 5.0),
                                (-6.4, 2.4, 6.2)], 0.10, REDP, MACH, par=root,
                  flange_at=[1])
    A.append(prism("standpipe_valve", 0.16, 0.14, (-7.1, 2.4, 5.2), MACH, sides=12,
                   rot=(math.pi / 2, 0, 0), par=root, br=0.02))

    # ------------------------------------------------------------------- finish
    g = join(meshes(A), "tower_body")
    parent(g, root)
    smooth_angle(g, 34)
    # the rust bloom stops at the identity board — signage stays crisp
    def _sign(c):
        return c.y < -2.90 and 4.60 < c.z < 7.45

    reassign(g, lambda p, c, nn: c.z < 6.5 and abs(nn.z) < 0.80 and not _sign(c),
             RUST, keep=KEEP)
    reassign(g, lambda p, c, nn: c.z < 1.35, WORN, keep=KEEP)
    dust_top(g, zmin=0.55, min_nz=0.66, keep=KEEP)
    scuff_low(g, zmax=1.60, max_nz=0.55, keep=KEEP)
    return root


# ============================================================================
#  habitat dome — the dwelling pressure hull
# ============================================================================
@builder
def habitat_dome():
    """A real habitat, not a shell on a promise.

    The shipped asset this replaces was one merged icosphere whose datum came
    from the lowest vertex anywhere in it — the entry porch, 9.745 units out —
    so the export node lifted the load-bearing drum base ring 4.42 into the
    air and every one of them read as a floating oval house. Here the Z=0 plane
    is the footing's own sole plate, and everything above it is stacked on that
    with no fudge: cast ring footing -> insulated drum -> gore-stiffened dome
    -> crown. Air side and ground side are two different structures because
    that is how a pressure hull is actually built.

    Frame: porch/ECLSS along Y (Blender -Y is the runtime +Z the door faces)."""
    root = empty("habitat_dome", (0, 0, 0))
    CREAM = P["cream"]; ALU = P["alu"]; MACH = P["alumach"]
    DARK = P["gunmetal"]; CONC = P["concrete"]; GRATE = P["grate"]
    WORN = P["worn"]; RUST = P["rust"]; INS = P["insul"]; ORANGE = P["orange"]
    AMBER = P["amber"]; CYAN = P["cyan"]; WARM = P["warm"]
    PANE = mat("glass_pane", (0.70, 0.88, 0.85), rough=0.05, alpha=0.22, coat=0.55)
    KEEP = {AMBER, CYAN, WARM, PANE, ORANGE}
    A = []
    G = []                                   # glazing: own mesh, never shadow-casting

    # ------------------------------------------------------------- geometry
    PLT = 0.34                # footing sole -> finished floor line
    DR = 3.60                 # drum radius
    DZ0 = 1.30                # dome springing
    DZ1 = 4.28                # dome crown
    CZ = 0.993                # centre of the generating sphere
    RS = 3.6131               # ... and its radius
    TAU = math.pi * 2

    def rd(z):                               # shell radius at height z
        return math.sqrt(max(0.0, RS * RS - (z - CZ) ** 2))

    def tang(ang):                           # (radial, tangent, up) at azimuth
        u = (math.cos(ang), math.sin(ang), 0.0)
        return u, (-u[1], u[0], 0.0)

    def cpl(name, q, su, sv, sd, U, V, m, par=root):
        """Plate placed BY CENTRE. obase anchors the +U+V+N corner, which makes
        every cladding panel read half a size off its stated line; nothing here
        is authored that way, because the datum has to stay symmetric."""
        Uv = Vector(U).normalized()
        Vv = Vector(V).normalized()
        c = Vector(q) + (Uv * su + Vv * sv + Uv.cross(Vv) * sd) * 0.5
        return obase(name, tuple(c), su, sv, sd, Uv, Vv, m, par=par)

    DECK = 0.36                              # apron / equipment-pad top of cast

    # ------------------------------------------------------- cast ring footing
    # Both profile ends sit on the axis, so the lathe is a closed solid and the
    # sole plate is genuinely at Z=0 rather than an open skirt.
    A.append(lathe("footing", [(0.0, 0.0), (4.30, 0.0), (4.30, 0.24),
                                (4.16, PLT), (0.0, PLT)], CONC, (0, 0, 0),
                   segs=48, par=root, smooth=25))
    A.append(ring("footing_curb", 4.20, 0.050, (0, 0, 0.285), CONC, maj=48,
                  mino=6, par=root))
    A.append(boltring("footing_bolts", (0, 0, PLT + 0.005), (0, 0, 1), 3.90, 24, MACH,
                      br=0.040, bh=0.055, par=root))
    for k in range(6):                       # anchor chairs into the regolith
        ang = k / 6.0 * TAU + TAU / 24
        u, t = tang(ang)
        A.append(hexn("footing_anchor%d" % k, 0.075, 0.16,
                      (3.98 * u[0], 3.98 * u[1], 0.16), MACH,
                      rot=(0, 0, ang), par=root))
    for sx in (-1, 1):                       # keep-out chevrons at the cart edges
        A += hazard_band("footing_hazard_%d" % sx, sx * 3.95, 0, 0.245, 1.15, 0.05,
                         8, ORANGE, DARK, axis='y', par=root, thick=0.014)
    for i, ang in enumerate([sgn * (k - 0.5) / 12.0 * TAU
                             for sgn in (-1, 1) for k in (1, 2)]):
        # services out to the cart bays: on drum bay centres, so no run crosses
        # a joint strip, and clear of the footing deck so nothing is cast in
        # concrete - each one lands in its own saddle block.
        u, t = tang(ang)
        A += radial_pipe("service_stub%d" % i, 3.90, ang, 0.62, 0.42, 0.055,
                         MACH, DARK, par=root)
        A.append(pbox("service_shoe%d" % i, 0.12, 0.12, 0.30,
                      (4.12 * u[0], 4.12 * u[1], 0.475), CONC, rot=(0, 0, ang),
                      par=root))

    # ------------------------------------------------------------------- drum
    # The pressure vessel's lower cylinder: a solid ring wall, because the
    # interior is never visible and a hollow drum shows its own backfaces.
    A.append(prism("drum", DR + 0.06, 1.06, (0, 0, 0.83), INS, sides=48,
                   par=root, br=0.03))
    # Clamp band over the shell foot. It has to bite the shell: a ring whose
    # inner equator is merely tangent to the shell corner (major 3.66 / minor
    # 0.08 at the springing) shares a whole 48-vertex circle with the lathe,
    # the weld pass then merges two independent shells into a 4-face edge and
    # the recap cannot close it — that was all 192 open edges of the audit.
    A.append(ring("springing_ring", DR + 0.035, 0.085, (0, 0, DZ0 + 0.16), ALU,
                  maj=48, mino=6, par=root))
    for k in range(24):
        ang = k / 24.0 * TAU
        u, t = tang(ang)
        A.append(hexn("drum_flange%d" % k, 0.045, 0.05,
                      (3.72 * u[0], 3.72 * u[1], 1.46), MACH,
                      rot=(math.pi / 2, 0, ang), par=root))
    # insulation cladding: tangent panels in two courses, seated on the mantle,
    # with a seal strip over every joint and a machined pilaster outside it
    for j in range(12):
        ang = (j + 0.5) / 12.0 * TAU
        u, t = tang(ang)
        for zz in (0.60, 1.06):
            A.append(cpl("drum_panel%d_%g" % (j, zz),
                         (3.6875 * u[0], 3.6875 * u[1], zz), 1.72, 0.38, 0.075,
                         t, (0, 0, 1), CREAM, par=root))
        ang = j / 12.0 * TAU
        u, t = tang(ang)
        A.append(cpl("drum_seal%d" % j, (3.665 * u[0], 3.665 * u[1], 0.83),
                     0.26, 1.04, 0.06, t, (0, 0, 1), DARK, par=root))
        if j not in (0, 9):                  # 9 is the porch throat, 0 the louver
            A.append(cpl("drum_pilaster%d" % j, (3.755 * u[0], 3.755 * u[1], 0.83),
                         0.15, 1.02, 0.09, t, (0, 0, 1), ALU, par=root))

    # ------------------------------------------------------------- dome shell
    arc = []
    for k in range(9):
        z = DZ1 - k * (DZ1 - DZ0) / 8.0
        arc.append((rd(z) + 0.035, z))
    A.append(lathe("habitat_shell",
                   [(0.0, 4.40), (1.70, 4.40), (1.50, DZ1)] + arc +
                   [(DR - 0.02, DZ0), (DR - 0.02, DZ0 - 0.14), (0.0, DZ0 - 0.14)],
                   INS, (0, 0, 0), segs=48, par=root, smooth=25))
    # sixteen gore ribs, each riding the shell and thickened across the band
    for j in range(12):
        ang = j / 12.0 * TAU
        u, t = tang(ang)
        pts = []
        for k in range(11):
            z = 1.28 + k * (4.24 - 1.28) / 10.0
            r = rd(z) + (0.085 if 1.90 < z < 3.95 else 0.035)
            pts.append((r * u[0], r * u[1], z))
        A.append(tube("gore_rib%d" % j, pts, 0.055, ALU, par=root))
    for z in (1.95, 2.65, 3.35, 3.95):
        A.append(ring("latitude_ring%.2f" % z, rd(z) + 0.06, 0.052, (0, 0, z), ALU,
                      maj=48, mino=6, par=root))
    for z in (2.58, 3.38):                   # sill and head of the window band
        A.append(ring("window_chan%.2f" % z, rd(z) + 0.075, 0.062, (0, 0, z), DARK,
                      maj=48, mino=6, par=root))

    # ------------------------------------------------- window band (12 panes)
    # Every window is authored off the shell's own surface frame: N is the
    # outward normal, S runs up the meridian, so a `d` offset is a real
    # distance out of the dome and nothing can end up buried by accident.
    ZP0, ZP1 = 2.62, 3.34
    ZPM = 0.5 * (ZP0 + ZP1)
    RM0 = rd(ZPM)
    km = (ZPM - CZ) / RM0                    # shell slope: dz/dr
    sn = math.hypot(1.0, km)
    for j in range(12):
        ang = (j + 0.5) / 12.0 * TAU
        u, t = tang(ang)
        S = (-km * u[0] / sn, -km * u[1] / sn, 1.0 / sn)   # up the meridian
        Tv = Vector(t)
        Sv = Vector(S)
        Nv = Tv.cross(Sv)                                   # out of the shell
        B = Vector((RM0 * u[0], RM0 * u[1], ZPM))

        def at(d=0.0, s=0.0, w=0.0):
            return tuple(B + Nv * d + Sv * s + Tv * w)

        A.append(cpl("window_backing%d" % j, at(0.020), 1.34, 0.90, 0.06,
                     t, S, DARK, par=root))
        G.append(cpl("window_pane%d" % j, at(0.075), 1.16, 0.72, 0.035,
                     t, S, PANE, par=root))
        for s2 in (-1, 1):                   # head and sill caps
            A.append(cpl("window_trim%d_%d" % (j, s2), at(0.085, s2 * 0.47),
                         1.44, 0.075, 0.06, t, S, ALU, par=root))
        for w in (-0.29, 0.29):              # mullion bars over the glazing
            A.append(cpl("window_mull%d_%g" % (j, w), at(0.100, 0.0, w),
                         0.075, 0.72, 0.055, t, S, ALU, par=root))
        for s2 in (-1, 1):                   # rebate bolts at the corners
            for w in (-0.62, 0.62):
                A.append(hexn("window_bolt%d_%d_%g" % (j, s2, w), 0.035, 0.05,
                              at(0.062, s2 * 0.40, w), MACH, par=root,
                              rot=Nv.to_track_quat('Z', 'Y').to_euler()))
    A.append(ring("window_strip", rd(2.50) + 0.055, 0.042, (0, 0, 2.50), AMBER,
                  maj=48, mino=6, par=root))
    for j in range(12):
        ang = j / 12.0 * TAU
        u, t = tang(ang)
        A.append(prism("strip_lamp%d" % j, 0.075, 0.10,
                       ((rd(2.50) + 0.115) * u[0], (rd(2.50) + 0.115) * u[1],
                        2.50), MACH, sides=6, rot=(math.pi / 2, 0, ang),
                       par=root))

    # ---------------------------------------------------- airlock porch (-Y)
    # Section is the portal silhouette; extruding along local Z puts its depth
    # on world -Y, which is the bearing the runtime door faces.
    arch = [(-0.95, 0.30), (0.95, 0.30), (0.95, 1.90), (0.70, 2.32), (0.0, 2.48),
            (-0.70, 2.32), (-0.95, 1.90)]
    A.append(extrude_poly("porch_tunnel", arch, 1.75, INS, (0, -3.575, 0),
                          rot=(math.pi / 2, 0, 0), par=root, smooth=30))
    A.append(rbox("porch_roof", 2.42, 2.30, 0.10, (0, -3.70, 2.50), ALU,
                  bevel_r=0.03, segs=1, par=root))
    for sx in (-1, 1):                       # canopy braces off the bulkhead
        p0 = Vector((sx * 1.05, -2.72, 1.95))
        p1 = Vector((sx * 1.05, -4.62, 2.46))
        dv = p1 - p0
        A.append(rod("porch_strut%d" % (sx > 0), 0.038, dv.length,
                     tuple((p0 + p1) / 2), MACH,
                     rot=dv.to_track_quat('Z', 'Y').to_euler(), verts=10, br=0.0,
                     par=root))
    A.append(rbox("door_surround", 1.95, 0.22, 2.40, (0, -4.545, 1.40), DARK,
                  bevel_r=0.03, segs=1, par=root))
    for zz in (0.26, 2.34):                  # jamb bars proud of the bulkhead
        A.append(rbox("door_frame_h%d" % (zz > 1), 1.80, 0.06, 0.12,
                      (0, -4.68, zz), ALU, bevel_r=0.02, segs=1, par=root))
    for q in (-0.87, 0.87):
        A.append(rbox("door_frame_v%d" % (q > 0), 0.12, 0.06, 2.20,
                      (q, -4.68, 1.30), ALU, bevel_r=0.02, segs=1, par=root))
    # the door plane, measured by the consumer: outer face at y = -4.70
    A.append(rbox("habitat_door", 1.55, 0.08, 2.04, (0, -4.66, 1.29), ORANGE,
                  bevel_r=0.05, segs=1, par=root))
    A.append(ring("door_porthole", 0.245, 0.032, (0, -4.70, 1.66), MACH, maj=24,
                  mino=6, rot=(math.pi / 2, 0, 0), par=root))
    G.append(prism("door_porthole_glass", 0.235, 0.03, (0, -4.70, 1.66), PANE,
                   sides=24, rot=(math.pi / 2, 0, 0), par=root))
    for zz in (0.72, 1.06, 1.50, 1.84):      # dogs around the pressure seal
        for sx in (-1, 1):
            A.append(rod("door_dog%.2f%d" % (zz, sx), 0.022, 0.26,
                         (sx * 0.65, -4.72, zz), MACH, rot=(math.pi / 2, 0, 0),
                         verts=8, br=0.0, par=root))
    A.append(prism("door_wheel", 0.16, 0.07, (0.0, -4.74, 1.28), MACH, sides=12,
                   rot=(math.pi / 2, 0, 0), par=root, br=0.012))
    for k in range(4):
        A.append(rod("door_wheel_spoke%d" % k, 0.020, 0.30, (0, -4.74, 1.28), MACH,
                     rot=(math.pi / 2, 0, k * math.pi / 4), verts=6, br=0.0,
                     par=root))
    for zz in (0.62, 1.28, 1.94):
        A.append(rbox("door_hinge%.2f" % zz, 0.16, 0.14, 0.20, (-0.80, -4.68, zz),
                      MACH, bevel_r=0.02, segs=1, par=root))
    A += letter_row("door_tag", "HAB-1", (-0.244, -4.650, 2.42), 0.14, AMBER,
                    dirv=(1, 0, 0), up=(0, 0, 1), par=root)

    # ------------------------------------------------------- porch apron (散水)
    # A drainage apron stands 2 cm above the ring footing so run-off is pushed
    # clear of the drum; the step is the joint to the graded site.
    A.append(rbox("porch_apron", 3.50, 2.00, DECK, (0, -4.275, DECK / 2), CONC,
                  bevel_r=0.03, segs=1, par=root))
    A.append(rbox("apron_step", 3.00, 0.325, 0.19, (0, -5.4375, 0.095), CONC,
                  bevel_r=0.025, segs=1, par=root))
    A += hazard_band("apron_hazard", 0, -5.24, DECK + 0.02, 3.20, 0.16, 12,
                     ORANGE, DARK, axis='x', par=root)
    for sx in (-1, 1):
        A.append(prism("apron_bollard%d" % (sx > 0), 0.13, 0.85, (sx * 1.55, -4.35,
                                                     DECK + 0.395), ORANGE,
                       sides=12, par=root, br=0.03))
        A.append(ring("apron_bollard_band_%d" % (sx > 0), 0.135, 0.026,
                      (sx * 1.55, -4.35, DECK + 0.70), WARM, maj=16, mino=6,
                      rot=(math.pi / 2, 0, 0), par=root))
        for q in (-1, 1):
            A.append(hexn("apron_anchor%d_%d" % (sx > 0, q > 0), 0.055, 0.10,
                          (sx * 1.60 + q * 0.10, -5.16, DECK + 0.03), MACH,
                          rot=(0, 0, 0.3 * q), par=root))
    A.append(rbox("threshold_plate", 1.70, 0.45, 0.06, (0, -4.95, DECK + 0.025),
                  MACH, bevel_r=0.015, segs=1, par=root))
    for sx in (-1, 1):                       # stub grab rails beside the hatch
        A.append(rod("porch_grab_v%d" % (sx > 0), 0.026, 1.10,
                     (sx * 0.98, -4.72, 1.05), MACH, verts=10, br=0.0, par=root))
        for q in (-1, 1):
            A.append(rod("porch_grab_t%d_%d" % (sx > 0, q > 0), 0.020, 0.22,
                         (sx * 0.98, -4.61, 0.58 + (q > 0)), MACH,
                         rot=(math.pi / 2, 0, 0), verts=8, br=0.0, par=root))

    # --------------------------------------------- ECLSS plenum (+Y) and curb
    # Mirrors the porch side one-for-one: pad, kerb, then the plant on top, so
    # the asset's footprint stays symmetric about the origin in both axes.
    A.append(rbox("plenum_pad", 3.10, 2.00, DECK, (0, 4.275, DECK / 2), CONC,
                  bevel_r=0.03, segs=1, par=root))
    A.append(rbox("plenum_curb", 3.24, 0.325, 0.50, (0, 5.4375, 0.25), CONC,
                  bevel_r=0.025, segs=1, par=root))
    A.append(rbox("plenum_body", 2.60, 1.40, 1.86, (0, 4.25, 1.29), WORN,
                  bevel_r=0.05, segs=1, par=root))
    for sx in (-1, 1):
        for sy in (-1, 1):
            A.append(cpl("plenum_post%d_%d" % (sx > 0, sy > 0),
                         (sx * 1.32, 4.25 + sy * 0.70, 1.30), 0.18, 0.18, 1.90,
                         (1, 0, 0), (0, 1, 0), ALU, par=root))
    A.append(rbox("plenum_roof", 2.90, 1.72, 0.10, (0, 4.24, 2.29), ALU,
                  bevel_r=0.03, segs=1, par=root))
    A += louvers("plenum_louvers", (0, 4.97, 1.05), 2.00, 0.60, 6, DARK,
                 axis='y', par=root)
    A += louvers("plenum_louver_x", (1.36, 4.25, 1.45), 1.10, 0.62, 5, DARK,
                 axis='x', par=root)
    A.append(rbox("plenum_door", 0.08, 1.10, 1.86, (-1.33, 4.25, 1.29), GRATE,
                  bevel_r=0.02, segs=1, par=root))
    A.append(rod("plenum_door_bar", 0.022, 0.60, (-1.42, 4.50, 1.30), MACH,
                 rot=(math.pi / 2, 0, 0), verts=8, br=0.0, par=root))
    A.append(prism("plenum_door_wheel", 0.14, 0.06, (-1.42, 3.95, 1.30), MACH,
                   sides=12, rot=(math.pi / 2, 0, 0), par=root, br=0.01))
    A.append(rbox("plenum_sign", 2.20, 0.06, 0.52, (0, 4.975, 1.78), DARK,
                  bevel_r=0.02, segs=1, par=root))
    A += letter_row("plenum_tag", "ECLSS-2", (-0.492, 5.015, 1.68), 0.20, CREAM,
                    depth=0.03, dirv=(1, 0, 0), up=(0, 0, 1), par=root)
    for sx in (-1, 1):                       # ducts from the plenum into the dome
        A += pipe_run("plenum_duct_%d" % (sx > 0), [(sx * 0.62, 4.20, 2.38),
                                             (sx * 0.62, 3.40, 3.05),
                                             (sx * 0.62, 2.55, 3.42)], 0.10, INS,
                      MACH, par=root, flange_at=[1, 2])
    A += pipe_run("plenum_feeder", [(1.40, 4.86, 2.02), (1.42, 4.88, 1.20),
                                     (1.40, 4.86, 0.42)], 0.055, DARK, MACH,
                  par=root, flange_at=[0, 2])
    A.append(ring("plenum_lift_eye", 0.13, 0.028, (0, 4.25, 2.42), MACH, maj=16,
                  mino=6, rot=(0, math.pi / 2, 0), par=root))

    # ------------------------------------------------------------ crown stack
    A.append(prism("crown_plate", 1.66, 0.12, (0, 0, 4.30), ALU, sides=24,
                   par=root, br=0.02))
    A.append(boltring("crown_bolts", (0, 0, 4.365), (0, 0, 1), 1.52, 16, MACH,
                      br=0.030, bh=0.045, par=root))
    A.append(rod("cupola", 1.15, 0.50, (0, 0, 4.60), INS, verts=24, br=0.18,
                 segs=2, par=root))
    for zz in (4.35, 4.85):
        A.append(ring("cupola_rim%.2f" % zz, 1.08, 0.115, (0, 0, zz), ALU, maj=24,
                      mino=5, par=root))
    A.append(ring("cupola_curb", 1.22, 0.055, (0, 0, 4.86), ALU, maj=32, mino=6,
                  par=root))
    A.append(ring("crown_light", 0.92, 0.060, (0, 0, 4.92), CYAN, maj=32, mino=6,
                  par=root))
    A.append(prism("crown_cap", 0.90, 0.10, (0, 0, 5.02), ALU, sides=24, par=root,
                   br=0.02))
    for k in range(4):                       # pressure relief valves
        ang = k / 4.0 * TAU + TAU / 8
        u, t = tang(ang)
        c = (1.32 * u[0], 1.32 * u[1], 4.44)
        A.append(hexn("prv_base%d" % k, 0.11, 0.10, c, MACH, rot=(0, 0, ang),
                      par=root))
        A.append(rod("prv_shank%d" % k, 0.055, 0.22, (c[0], c[1], 4.60), DARK,
                     verts=10, br=0.0, par=root))
        A.append(tube_simple("prv_hood%d" % k, 0.13, 0.055, 0.14,
                             (c[0], c[1], 4.77), ALU, verts=12, par=root,
                             br=0.015))
    for k in range(2):
        ang = k * math.pi
        A.append(hexn("burst_plug%d" % k, 0.14, 0.09, (1.45 * math.cos(ang),
                                                       1.45 * math.sin(ang), 4.40),
                      MACH, rot=(0, 0, ang), par=root))
    A += pipe_run("vent_stack", [(0.55, -0.35, 4.35), (0.55, -0.35, 5.00)], 0.075,
                  MACH, DARK, par=root, flange_at=[0])
    A.append(tube_simple("vent_cowl", 0.115, 0.055, 0.18, (0.55, -0.35, 5.12),
                         DARK, verts=14, par=root, br=0.012))
    A.append(rod("beacon_mast", 0.030, 0.44, (0, 0, 5.28), MACH, verts=8, br=0.0,
                 par=root))
    A.append(ball("beacon", 0.085, (0, 0, 5.48), AMBER, par=root))

    # -------------------------------------------------- roof walkway + access
    # A guard rail that stops dead in mid-air is a promise again, so the
    # walkway is authored as two continuous runs and the breaks are aimed at
    # the two things actually in the way on this shell: the porch throat at
    # 270 deg and the ECLSS louver wall at 0 deg. Every run end returns its
    # rails into the drum on a stub, so the guard is never left open.
    #
    # The previous attempt failed twice over, and both failures were measured
    # rather than seen. `abs((ang - a) % TAU) < radians(20)` is not an angular
    # distance - the modulo turns -12 deg into 348 deg - so the skip never
    # fired and all ten bays were built, including the ones that were supposed
    # to clear the porch and the louver. And the bays were 0.86 m pads on a
    # 2.45 m pitch: 1.59 m holes bridged by a 0.86 m rail stub that ended in
    # thin air at both sides. What reads from the apron as "the walkway stops
    # at the door" is that - ten stepping stones, not a walkway.
    WALK_IN, WALK_OUT = 3.86, 4.58       # 0.72 m clear; springing ring outer 3.72
    WALK_R = 0.5 * (WALK_IN + WALK_OUT)
    RAIL_R = WALK_OUT - 0.06
    DECK_TOP, DECK_T = 1.500, 0.055      # 150 mm above the shell's springing line
    POST_H = 1.06                        # guard height, was 0.92
    PITCH_ARC = 1.02                     # grating module, post to post
    # Each run end is set by the thing it has to stand clear of, measured off
    # the parts above - not by a symmetric gap that happens to miss them:
    #   25 deg   - past wall_hatch (15 +/- 5.9 deg) and the louver plate (+/- 10)
    #   346 deg  - 4 deg past the louver plate's other edge
    #   249/291  - 1.4 deg past the porch roof's |x| 1.21 line and the tunnel
    #              corner at 250.75/289.25, and past the struts at |x| 1.10
    A_HATCH_OUT, A_PORCH0 = math.radians(25), math.radians(249)
    A_PORCH1, A_HATCH_IN = math.radians(291), math.radians(346)
    RUNS = [(A_HATCH_OUT, A_PORCH0), (A_PORCH1, A_HATCH_IN)]
    LAD_K = 0                            # run 0's first panel is the ladder opening

    def arc_pts(a0, a1, R, z, n):
        return [(R * math.cos(a0 + (a1 - a0) * k / n),
                 R * math.sin(a0 + (a1 - a0) * k / n), z) for k in range(n + 1)]

    lad_ang = None
    for ri, (a0, a1) in enumerate(RUNS):
        # ceil, not round: a run wanting 16.3 modules gets 17 and lands under a
        # metre per panel. Rounding down would stretch the pitch the posts stand on.
        n = max(2, int(math.ceil((a1 - a0) * WALK_R / PITCH_ARC)))
        step = (a1 - a0) / n
        chord = 2 * WALK_R * math.sin(step / 2.0)
        for k in range(n):
            if ri == 0 and k == LAD_K:
                lad_ang = a0 + (k + 0.5) * step   # the ship's ladder rises here
                continue
            ang = a0 + (k + 0.5) * step
            u, t = tang(ang)
            A.append(cpl("walk_pad%d_%d" % (ri, k),
                         (WALK_R * u[0], WALK_R * u[1], DECK_TOP - DECK_T / 2),
                         chord - 0.02, WALK_OUT - WALK_IN, DECK_T, t, u, GRATE,
                         par=root))
            A.append(cpl("walk_toe%d_%d" % (ri, k),
                         ((WALK_OUT - 0.01) * u[0], (WALK_OUT - 0.01) * u[1],
                          DECK_TOP + 0.06), chord - 0.02, 0.12, 0.02, t,
                         (0, 0, 1), ALU, par=root))
        for k in range(n + 1):
            ang = a0 + k * step
            u, t = tang(ang)
            # Canted corbel: bolted through the drum at r 3.66 / z 0.96, hooked
            # under the deck at r 4.50 / z 1.49. It passes below the springing
            # ring (outer 3.72, z 1.375..1.545) rather than through it, which is
            # the only place on this shell a bracket can be both grounded and
            # clear of a pressure joint.
            A.append(cpl("walk_corbel%d_%d" % (ri, k),
                         (4.08 * u[0], 4.08 * u[1], 1.225), 0.99, 0.10, 0.028,
                         (0.845 * u[0], 0.845 * u[1], 0.535), t, ALU, par=root))
            A.append(hexn("walk_bolt%d_%d" % (ri, k), 0.040, 0.055,
                          (3.690 * u[0], 3.690 * u[1], 0.978), MACH,
                          rot=(math.pi / 2, 0, ang), par=root))
            A.append(hexn("walk_nut%d_%d" % (ri, k), 0.042, 0.062,
                          (4.430 * u[0], 4.430 * u[1], 1.442), MACH,
                          rot=(0, 0, ang), par=root))
            if 0 < k < n:
                A.append(pbox("walk_post%d_%d" % (ri, k), 0.052, 0.052, POST_H,
                              (RAIL_R * u[0], RAIL_R * u[1], DECK_TOP + POST_H / 2),
                              ALU, rot=(0, 0, ang), par=root))
            else:
                # Run end: a newel instead of a spaced post, and both rails
                # turned back into the shell. This is what the old version
                # never had - the reason the walkway read as truncated.
                A.append(pbox("walk_newel%d_%d" % (ri, k), 0.075, 0.075,
                              POST_H + 0.08,
                              (RAIL_R * u[0], RAIL_R * u[1],
                               DECK_TOP + 0.5 * (POST_H + 0.08)), ALU,
                              rot=(0, 0, ang), par=root))
                for ti, (zz, rr) in enumerate(((DECK_TOP + POST_H, 0.028),
                                               (DECK_TOP + 0.55, 0.022))):
                    A.append(tube("walk_return%d_%d_%d" % (ri, k, ti),
                                  [(RAIL_R * u[0], RAIL_R * u[1], zz),
                                   (3.72 * u[0], 3.72 * u[1], zz)], rr, MACH,
                                  res=1, par=root))
        for ti, (zz, rr) in enumerate(((DECK_TOP + POST_H, 0.028),
                                       (DECK_TOP + 0.55, 0.022))):
            A.append(tube("walk_rail%d_%d" % (ri, ti),
                          arc_pts(a0, a1, RAIL_R, zz, 2 * n), rr, MACH, res=1,
                          par=root))
    # The ladder rises through a panel that is genuinely not there, and its
    # rails run 0.55 m past the deck line as grab bars; no rung falls inside
    # the deck thickness.
    A += ring_ladder("shell_ladder", DR + 0.06, lad_ang, 0.30, 2.05, ALU, MACH,
                     standoff=0.14, ties=(0.60, 1.00, 1.35), par=root)

    # --------------------------------------------------------------- services
    # Every service owns a drum bay: no diagonal run crosses a joint strip, and
    # nothing is buried in - or floating outside - the cladding it pierces.
    A.append(cpl("louver_plate", (3.730, 0.0, 0.95), 1.30, 0.86, 0.06,
                 (0, 1, 0), (0, 0, 1), ALU, par=root))
    A += louvers("shell_louvers", (3.752, 0.0, 0.95), 1.10, 0.70, 6, MACH,
                 axis='x', par=root)
    hu, _ht = tang(math.radians(15))
    A += hatch("wall_hatch", (3.70 * hu[0], 3.70 * hu[1], 0.95), 0.38, ALU, MACH,
               MACH, axis=(hu[0], hu[1], 0.0), par=root)
    for i, az in enumerate((157.5, 172.5)):   # shell drains into footing scuppers
        u, t = tang(math.radians(az))
        A += pipe_run("condensate_%d" % i, [(3.75 * u[0], 3.75 * u[1], 1.30),
                                            (3.75 * u[0], 3.75 * u[1], 0.80),
                                            (4.02 * u[0], 4.02 * u[1], 0.36)],
                      0.048, MACH, DARK, par=root, flange_at=[1])
        A.append(cpl("condensate_scupper%d" % i,
                     (4.02 * u[0], 4.02 * u[1], 0.355), 0.24, 0.24, 0.05, t, u,
                     GRATE, par=root))
        A.append(ring("condensate_foot%d" % i, 0.075, 0.024,
                      (4.02 * u[0], 4.02 * u[1], 0.375), MACH, maj=16, mino=5,
                      par=root))

    # ---------------------------------------------------------------- finish
    gl = join(meshes(G), "habitat_glazing")
    parent(gl, root)
    smooth_angle(gl, 45)
    g = join(meshes(A), "habitat_shell")
    parent(g, root)
    smooth_angle(g, 34)
    # Weathering shades a surface; it must never relabel it. Four roles have to
    # survive into the GLB: cast concrete footing, painted drum cladding, bare
    # alloy structure, and walkway grating. The blanket z-thresholds this pass
    # used to run with erased all four - footing_cast exported to zero faces,
    # floor_grate kept 4 of its triangles, and 29% of the asset became
    # worn_metal, so the biggest mass at eye level read as one poured lump.
    # Rust in particular only blooms where there is ferrous metal to bloom on.
    MINERAL = {CONC, GRATE}
    CLADDING = {CREAM, INS}
    reassign(g, lambda p, c, nn: c.z < 0.62 and abs(nn.z) < 0.85, RUST,
             keep=KEEP | MINERAL | CLADDING)
    scuff_low(g, zmax=1.45, max_nz=0.55, keep=KEEP | MINERAL | CLADDING)
    # near-horizontal only, and strictly so: at min_nz 0.60 the shell crossed
    # the threshold right at the window head and the dome came out two-toned
    # with a paint-straight line across it. 0.95 keeps every real ledge (window
    # sills and heads are flat, so nz = 1.0) and shrinks the crown film to the
    # part of the cap that actually is flat, where dust would stand.
    dust_top(g, zmin=0.40, min_nz=0.95, keep=KEEP | {GRATE})
    return root


# ============================================================================
#  main
# ============================================================================
ORDER = ["lamp", "crystal", "cryo_tank", "lander", "greenhouse",
         "habitat_dome", "launch_tower", "starship"]

if __name__ == "__main__":
    want = [a for a in sys.argv[4:] if a in BUILDERS]
    for nm in (want or ORDER):
        if nm not in BUILDERS:
            print("SKIP (no builder):", nm)
            continue
        purge()
        root = BUILDERS[nm]()
        root.name = nm
        for o in root.children_recursive:
            if o.type == 'MESH':
                cleanup(o)
        snap_datum(root)
        audit(nm, root)
        export(root, nm + ".glb", nm)
    print("BASE_V2_DONE")

