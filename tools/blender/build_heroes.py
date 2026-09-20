# Blender hero-asset builder for RED STARBASE — real hard-surface craft:
# every solid gets beveled rounded edges (the soft toy look), smooth-by-angle shading,
# deliberate silhouette and material separation.
# Run: blender --background --python tools/blender/build_heroes.py
import bpy, bmesh, math, os

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "public", "assets")
OUT = os.path.abspath(OUT)
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- material factory (toy palette, bruno-simon style) ----------
def set_in(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val
        return True
    return False

def mat(name, color, rough=0.4, metal=0.0, emis=None, estr=0.0, alpha=None):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
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
        try: m.show_transparent_back = False
        except Exception: pass
    return m

P = {
    "body":    mat("rover_white",   (0.93, 0.92, 0.90), rough=0.32),          # glossy toy paint
    "accent":  mat("rover_orange",  (0.95, 0.42, 0.13), rough=0.35),
    "rubber":  mat("rover_rubber",  (0.035, 0.033, 0.038), rough=0.92),
    "hub":     mat("rover_hub",     (0.88, 0.86, 0.82), rough=0.4),
    "dark":    mat("rover_dark",    (0.09, 0.09, 0.11), rough=0.55, metal=0.4),
    "glass":   mat("rover_glass",   (0.55, 0.85, 0.95), rough=0.06, alpha=0.38),
    "amber":   mat("light_amber",   (1.0, 0.72, 0.30), rough=0.25, emis=(1.0, 0.58, 0.16), estr=4.0),
    "cyan":    mat("light_cyan",    (0.55, 0.92, 1.0), rough=0.2, emis=(0.22, 0.82, 1.0), estr=3.2),
    "red":     mat("light_red",     (1.0, 0.25, 0.18), rough=0.3, emis=(1.0, 0.12, 0.08), estr=2.6),
    "steel":   mat("hero_steel",    (0.62, 0.63, 0.66), rough=0.28, metal=1.0),
    "pad":     mat("pad_white",     (0.90, 0.89, 0.87), rough=0.35),
    "padglow": mat("pad_glow",      (0.4, 0.95, 0.9), rough=0.2, emis=(0.15, 0.9, 0.85), estr=5.0),
}

def act(o):
    bpy.context.view_layer.objects.active = o
    return o

def bevel(o, width, segs=3, min_angle=28):
    """Angle-limited bevel — rounds only crease/boundary edges (a real hard-surface
    workflow); beveling coplanar triangulation edges on cylinder caps blows up."""
    bm = bmesh.new(); bm.from_mesh(o.data)
    edges = []
    for e in bm.edges:
        if not e.verts: continue
        if len(e.link_faces) < 2:
            edges.append(e)
        else:
            try:
                if e.calc_face_angle() > math.radians(min_angle): edges.append(e)
            except Exception:
                pass
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=width, segments=segs,
                        profile=0.72, affect='EDGES', clamp_overlap=True)
    bm.to_mesh(o.data); bm.free()

def smooth_angle(o, deg=38):
    act(o)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(deg))
    except Exception:
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            o.data.shade_flat()

def rbox(name, sx, sy, sz, loc, m, bevel_r=None, segs=3, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = act(bpy.context.object); o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    r = bevel_r if bevel_r is not None else min(sx, sy, sz) * 0.22
    bevel(o, r, segs)
    smooth_angle(o)
    o.data.materials.append(m)
    return o

def tire(name, r, w, loc, m):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=w, location=loc,
                                        rotation=(0, math.pi / 2, 0), vertices=28)
    o = act(bpy.context.object); o.name = name
    bevel(o, w * 0.30, 3)          # pillow-soft toy tire
    smooth_angle(o, 42)
    o.data.materials.append(m)
    return o

def ball(name, r, loc, m, segs=24):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=segs, ring_count=segs // 2 + 2)
    o = act(bpy.context.object); o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(m)
    return o

def rod(name, r, d, loc, m, rot=(0, 0, 0), verts=14, br=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, rotation=rot, vertices=verts)
    o = act(bpy.context.object); o.name = name
    bevel(o, br if br else r * 0.35, 2)
    smooth_angle(o)
    o.data.materials.append(m)
    return o

def ring(name, R, r, loc, m, maj=36, mino=10, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc,
                                     rotation=rot, major_segments=maj, minor_segments=mino)
    o = act(bpy.context.object); o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(m)
    return o

def empty(name, loc):
    bpy.ops.object.empty_add(location=loc)
    o = bpy.context.object
    o.name = name
    return act(o)

def parent(c, p):
    c.parent = p; c.matrix_parent_inverse = p.matrix_world.inverted()

def purge():
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)

def export(root, fname):
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for o in root.children_recursive:
        if o.type in {'MESH', 'EMPTY'}: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, fname), export_format='GLB',
                              use_selection=True, export_yup=True, export_apply=True)
    print("EXPORTED", fname)

# =========================================================
# ROVER — cute beveled six-wheeler, the thing the player
# stares at for the whole session. Front = -Y (Blender).
# =========================================================
def build_rover():
    purge(); root = empty("rover", (0, 0, 0))

    # main body: soft marshmallow chassis + stepped lower hull
    body = rbox("body", 2.30, 1.60, 0.62, (0, -0.10, 1.16), P["body"], bevel_r=0.30, segs=4)
    parent(body, root)
    belly = rbox("belly", 1.95, 1.45, 0.40, (0, -0.10, 0.72), P["accent"], bevel_r=0.18, segs=3)
    parent(belly, root)
    # nose cone — a beveled snout gives the silhouette a "front"
    nose = rbox("nose", 1.15, 0.55, 0.42, (0, -1.62, 1.02), P["body"], bevel_r=0.20, segs=3)
    parent(nose, root)
    # glass canopy bubble + rim
    bub = ball("canopy", 0.78, (0, -0.52, 1.62), P["glass"], segs=28)
    bub.scale = (1.0, 1.25, 0.80)
    parent(bub, root)
    rim = ring("canopy_rim", 0.80, 0.075, (0, -0.52, 1.30), P["accent"], maj=30, mino=8)
    rim.scale = (1.0, 1.25, 1.0)
    parent(rim, root)

    # headlights — two soft amber pills on the nose (material light_amber drives the rig)
    for s in (-1, 1):
        hl = rbox("headlight", 0.30, 0.10, 0.20, (s * 0.52, -1.90, 1.05), P["amber"], bevel_r=0.07, segs=2)
        parent(hl, root)
    # tail bar
    tail = rbox("taillight", 1.30, 0.08, 0.14, (0, 1.62, 1.10), P["red"], bevel_r=0.05, segs=2)
    parent(tail, root)

    # camera mast + head (iconic Curiosity silhouette, toy-ified)
    mast = rod("mast", 0.055, 1.15, (0.42, 0.85, 1.95), P["dark"], verts=10)
    parent(mast, root)
    head = rbox("cam_head", 0.46, 0.24, 0.22, (0.42, 0.72, 2.52), P["dark"], bevel_r=0.07, segs=2)
    parent(head, root)
    for s in (-1, 1):
        eye = ball("cam_eye", 0.055, (0.42 + s * 0.13, 0.595, 2.53), P["cyan"], segs=12)
        parent(eye, root)
    # dish antenna
    dish = ball("antenna_dish", 0.30, (-0.62, 0.95, 1.78), P["body"], segs=16)
    dish.scale = (1, 1, 0.42); dish.rotation_euler = (math.radians(-38), 0, math.radians(-18))
    parent(dish, root)
    tip = ball("antenna_tip", 0.065, (-0.72, 1.06, 2.02), P["amber"], segs=10)
    parent(tip, root)

    # rocker-bogie arms: slim axles linking body to each wheel row
    WHEELS = [(-1.18, -1.10), (1.18, -1.10), (-1.18, 0.05), (1.18, 0.05), (-1.18, 1.20), (1.18, 1.20)]
    for i, (x, y) in enumerate(WHEELS):
        arm = rbox("arm_%d" % i, 0.42, 0.16, 0.10, (x * 0.75, y, 0.80), P["dark"], bevel_r=0.05, segs=2)
        parent(arm, root)

    # wheels: chunky pillow tires + hubcaps + center nut, on named pivots
    for i, (x, y) in enumerate(WHEELS):
        pv = empty("wheelpivot_%d" % i, (x, y, 0.58)); parent(pv, root)
        t = tire("wheel_%d" % i, 0.58, 0.46, (x, y, 0.58), P["rubber"]); parent(t, pv)
        for s in (-1, 1):
            hub = rod("hubcap_%d" % i, 0.30, 0.06, (x + s * 0.245, y, 0.58), P["hub"],
                      rot=(0, math.pi / 2, 0), verts=20, br=0.03)
            parent(hub, pv)
        # spoke marks on the outer face so wheel rotation reads at speed
        outer = x + (0.28 if x > 0 else -0.28)
        for k in range(3):
            a = k * math.tau / 3
            sp = rbox("spoke_%d_%d" % (i, k), 0.05, 0.46, 0.09, (outer, y, 0.58), P["dark"], bevel_r=0.02, segs=2,
                      rot=(a, 0, 0))
            sp.location = (outer, y + 0.13 * math.sin(a), 0.58 + 0.13 * math.cos(a))
            parent(sp, pv)
    return root

# =========================================================
# TELEPORT PAD — fast-travel beacon the player drives onto
# =========================================================
def build_teleport():
    purge(); root = empty("teleport_pad", (0, 0, 0))
    base = rod("base", 2.6, 0.30, (0, 0, 0.15), P["pad"], verts=40, br=0.10); parent(base, root)
    inner = rod("inner", 1.95, 0.36, (0, 0, 0.20), P["dark"], verts=36, br=0.08); parent(inner, root)
    glow = rod("glow", 1.55, 0.42, (0, 0, 0.23), P["padglow"], verts=32, br=0.05); parent(glow, root)
    rim = ring("rim_light", 2.30, 0.07, (0, 0, 0.34), P["cyan"], maj=40, mino=8); parent(rim, root)
    # three corner posts with amber caps
    for i in range(3):
        a = i * math.tau / 3 + math.pi / 6
        x, y = math.cos(a) * 2.95, math.sin(a) * 2.95
        post = rbox("post_%d" % i, 0.16, 0.16, 0.85, (x, y, 0.55), P["pad"], bevel_r=0.06, segs=2)
        parent(post, root)
        cap = ball("cap_%d" % i, 0.11, (x, y, 1.05), P["amber"], segs=12)
        parent(cap, root)
    return root

# =========================================================
# GATE ARCH — checkpoint / zone marker, beveled and chunky
# =========================================================
def build_arch():
    purge(); root = empty("arch", (0, 0, 0))
    for s in (-1, 1):
        leg = rbox("leg_%d" % s, 0.55, 0.55, 3.2, (s * 3.1, 0, 1.6), P["pad"], bevel_r=0.16, segs=3)
        parent(leg, root)
        foot = rbox("foot_%d" % s, 0.9, 0.9, 0.3, (s * 3.1, 0, 0.15), P["dark"], bevel_r=0.10, segs=2)
        parent(foot, root)
    top = rbox("lintel", 7.4, 0.6, 0.65, (0, 0, 3.55), P["accent"], bevel_r=0.20, segs=3)
    parent(top, root)
    strip = rbox("light_strip", 6.2, 0.10, 0.16, (0, -0.30, 3.30), P["cyan"], bevel_r=0.05, segs=2)
    parent(strip, root)
    badge = ball("badge", 0.34, (0, 0, 4.15), P["amber"], segs=16)
    parent(badge, root)
    return root

if __name__ == "__main__":
    for fn, fname in [(build_rover, "rover.glb"),
                      (build_teleport, "teleport_pad.glb"),
                      (build_arch, "arch.glb")]:
        r = fn()
        export(r, fname)
    print("HEROES_DONE")
