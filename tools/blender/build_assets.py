# Blender headless asset builder for RED STARBASE.
# Stylized low-poly + emissive Mars base, Outer Wilds inspired.
# Run: blender --background --python tools/blender/build_assets.py
import bpy, math, random, os

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "public", "assets")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- helpers ----------
def set_in(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val
        return True
    return False

def mat(name, color=(0.8, 0.8, 0.8), metallic=0.0, rough=0.55,
        emissive=None, strength=0.0, alpha=None):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    set_in(bsdf, "Base Color", (*color, 1))
    set_in(bsdf, "Metallic", metallic)
    set_in(bsdf, "Roughness", rough)
    if emissive:
        set_in(bsdf, "Emission Color", (*emissive, 1))
        set_in(bsdf, "Emission Strength", strength)
    if alpha is not None:
        set_in(bsdf, "Alpha", alpha)
        m.blend_method = 'BLEND'
        try: m.show_transparent_back = False
        except Exception: pass
    return m

COL = {
    "hull":     mat("hull_white",   (0.87, 0.85, 0.82), rough=0.4),
    "hull2":    mat("hull_warm",    (0.78, 0.72, 0.65), rough=0.5),
    "metal":    mat("steel",        (0.42, 0.40, 0.42), metallic=0.9, rough=0.35),
    "dark":     mat("dark_panel",   (0.06, 0.06, 0.075), rough=0.6),
    "rust":     mat("rust_orange",  (0.65, 0.28, 0.12), rough=0.7),
    "amber":    mat("light_amber",  (1.0, 0.62, 0.25), emissive=(1.0, 0.55, 0.18), strength=3.0, rough=0.3),
    "warm":     mat("light_warm",   (1.0, 0.9, 0.75), emissive=(1.0, 0.82, 0.5), strength=2.2),
    "cyan":     mat("light_cyan",   (0.55, 0.9, 1.0), emissive=(0.25, 0.8, 1.0), strength=2.4),
    "mag":      mat("light_magenta",(1.0, 0.45, 0.85), emissive=(1.0, 0.15, 0.7), strength=4.5),
    "glass":    mat("glass_green",  (0.35, 0.75, 0.55), rough=0.12, alpha=0.32),
    "plant":    mat("plant",        (0.18, 0.62, 0.28), emissive=(0.2, 0.9, 0.3), strength=1.0, rough=0.8),
    "solar":    mat("solar_blue",   (0.08, 0.12, 0.35), metallic=0.6, rough=0.18),
    "gold":     mat("ml_gold",      (0.85, 0.65, 0.22), metallic=1.0, rough=0.28),
    "red":      mat("acc_red",      (0.7, 0.12, 0.1), rough=0.5),
    "cloth":    mat("canvas_red",   (0.62, 0.1, 0.12), rough=0.9),
}

def obj(o):
    bpy.context.view_layer.objects.active = o
    return o

def box(name, size, loc, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = obj(bpy.context.object); o.name = name; o.scale = (size[0]/2, size[1]/2, size[2]/2)
    o.data.materials.append(m); return o

def cyl(name, r, d, loc, m, rot=(0, 0, 0), verts=24):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, rotation=rot, vertices=verts)
    o = obj(bpy.context.object); o.name = name
    o.data.materials.append(m); return o

def sph(name, r, loc, m, segs=20, rings=14, flat=False):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=segs, ring_count=rings)
    o = obj(bpy.context.object); o.name = name
    if flat: o.data.shade_flat()
    else: bpy.ops.object.shade_smooth()
    o.data.materials.append(m); return o

def ico(name, r, loc, m, subdiv=1):
    bpy.ops.mesh.primitive_ico_sphere_add(radius=r, location=loc, subdivisions=subdiv)
    o = obj(bpy.context.object); o.name = name; o.data.shade_flat()
    o.data.materials.append(m); return o

def cone(name, r1, r2, d, loc, m, verts=24):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=d, location=loc, vertices=verts)
    o = obj(bpy.context.object); o.name = name; bpy.ops.object.shade_smooth()
    o.data.materials.append(m); return o

def tor(name, R, r, loc, m, maj=24, mino=8, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc,
                                     rotation=rot, major_segments=maj, minor_segments=mino)
    o = obj(bpy.context.object); o.name = name; bpy.ops.object.shade_smooth()
    o.data.materials.append(m); return o

def parent(child, p):
    child.parent = p; child.matrix_parent_inverse = p.matrix_world.inverted()

def new_root(name):
    bpy.ops.object.empty_add(location=(0, 0, 0))
    e = obj(bpy.context.object); e.name = name; return e

def move_all_to(collection, root):
    for o in list(collection.objects):
        if o != root and o.parent is None: o.parent = root

def export(root, fname):
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for o in root.children_recursive:
        if o.type in {'MESH', 'EMPTY'}: o.select_set(True)
    path = os.path.join(OUT, fname)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                              use_selection=True, export_yup=True,
                              export_apply=True)
    print("EXPORTED", fname)

def clean(o):
    if o and o.name != "":
        try: bpy.data.objects.remove(o, do_unlink=True)
        except Exception: pass

def delete_all():
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)

random.seed(7)

# =========================================================
# 1. HABITAT DOME — faceted white dome, amber window ring, airlock
# =========================================================
def build_habitat_dome():
    delete_all(); root = new_root("habitat_dome")
    d = ico("dome", 6.0, (0, 0, 0), COL["hull"], subdiv=2)
    d.scale = (1, 1, 0.85); parent(d, root)
    # window band: torus of amber, faceted
    b = tor("window_band", 5.05, 0.42, (0, 0, 2.6), COL["amber"], maj=16, mino=6)
    b.scale = (1, 1, 0.55); parent(b, root)
    # top ring light
    parent(tor("top_light", 1.3, 0.16, (0, 0, 5.0), COL["cyan"], maj=12, mino=5), root)
    # base skirt
    parent(cyl("base", 6.15, 0.9, (0, 0, -0.35), COL["hull2"], verts=16), root)
    # airlock tunnel
    a = cyl("airlock", 1.35, 5.2, (5.6, 0, 1.3), COL["hull"], rot=(0, math.pi/2, 0), verts=12)
    parent(a, root)
    parent(tor("airlock_ring", 1.4, 0.18, (8.0, 0, 1.3), COL["metal"], maj=12, mino=5,
               rot=(0, math.pi/2, 0)), root)
    parent(cyl("door", 1.1, 0.25, (8.15, 0, 1.3), COL["amber"], rot=(0, math.pi/2, 0), verts=10), root)
    # strut fins
    for i in range(6):
        ang = i * math.tau / 6
        f = box("fin", (0.35, 1.1, 2.6), (5.6*math.cos(ang), 5.6*math.sin(ang), 0.6),
                COL["metal"], rot=(0, 0, ang))
        parent(f, root)
    return root

# =========================================================
# 2. GREENHOUSE — glass icosphere on ring base, glowing plants
# =========================================================
def build_greenhouse():
    delete_all(); root = new_root("greenhouse")
    parent(cyl("base", 4.6, 0.8, (0, 0, 0.2), COL["hull2"], verts=12), root)
    g = ico("glass_dome", 4.4, (0, 0, 0.6), COL["glass"], subdiv=1); g.scale = (1, 1, 0.9)
    parent(g, root)
    # frame ribs
    for i in range(6):
        ang = i * math.tau / 6
        r = tor("rib", 4.45, 0.09, (0, 0, 0.6), COL["metal"], maj=10, mino=4,
                rot=(math.pi/2, 0, ang))
        r.scale = (1, 1, 0.9); parent(r, root)
    parent(tor("equator", 4.45, 0.1, (0, 0, 0.6), COL["metal"], maj=12, mino=4), root)
    # plant blobs inside
    for i in range(9):
        rr = random.uniform(0.5, 1.5); ang = random.uniform(0, math.tau)
        rad = random.uniform(0.5, 3.0)
        p = ico("plant", rr, (rad*math.cos(ang), rad*math.sin(ang), 0.8+rr*0.5),
                COL["plant"], subdiv=0)
        p.scale = (1, 1, random.uniform(0.7, 1.3)); parent(p, root)
    # grow lights
    for i in range(4):
        ang = i * math.tau/4 + 0.4
        parent(sph("grow_light", 0.22, (2.4*math.cos(ang), 2.4*math.sin(ang), 3.4),
                   COL["mag"], segs=8, rings=6), root)
    return root

# =========================================================
# 3. LAUNCH TOWER — lattice tower + arm + service platform
# =========================================================
def build_launch_tower():
    delete_all(); root = new_root("launch_tower")
    H, W = 46.0, 5.0
    for sx in (-1, 1):
        for sy in (-1, 1):
            parent(cyl("leg", 0.45, H, (sx*W/2, sy*W/2, H/2), COL["rust"], verts=8), root)
    # cross bracing
    for i in range(9):
        z = 3 + i * 4.8
        for k in range(4):
            ang = k * math.tau/4
            x1 = W/2*math.cos(ang); y1 = W/2*math.sin(ang)
            x2 = W/2*math.cos(ang+math.tau/4); y2 = W/2*math.sin(ang+math.tau/4)
            dx, dy = x2-x1, y2-y1
            ln = math.hypot(dx, dy)
            b = box("brace", (ln, 0.18, 0.18), ((x1+x2)/2, (y1+y2)/2, z), COL["rust"],
                    rot=(0, 0, math.atan2(dy, dx)))
            parent(b, root)
        # diagonal X on two faces
        for sx in (-1, 1):
            b = box("diag", (0.15, 0.15, 6.8), (sx*W/2, 0, z+2.2), COL["rust"],
                    rot=(math.radians(22 if sx > 0 else -22), 0, 0))
            parent(b, root)
    # top cab
    parent(box("cab", (W+1.2, W+1.2, 3.0), (0, 0, H+1.2), COL["dark"]), root)
    parent(box("cab_light", (W*0.6, 0.3, 0.5), (0, -(W+1.2)/2, H+1.5), COL["amber"]), root)
    # chopstick service arm toward ship
    arm = box("service_arm", (14.0, 1.0, 0.7), (W/2+6.5, 0, 34.0), COL["rust"])
    parent(arm, root)
    parent(box("arm_light", (14.0, 0.25, 0.2), (W/2+6.5, -0.55, 34.0), COL["cyan"]), root)
    # low service platforms
    for z in (8.0, 18.0):
        parent(box("platform", (W+2.5, W+2.5, 0.4), (1.5, 0, z), COL["dark"]), root)
        parent(box("plat_light", (0.4, W+2.5, 0.15), (1.5+(W+2.5)/2, 0, z+0.28), COL["amber"]), root)
    # beacons
    parent(sph("beacon", 0.4, (0, 0, H+3.0), COL["red"], segs=8, rings=6), root)
    return root

# =========================================================
# 4. STARSHIP — hull + nose + fins + glowing window strip
# =========================================================
def build_starship():
    delete_all(); root = new_root("starship")
    H = 36.0
    body = cyl("hull", 3.0, H, (0, 0, H/2), COL["hull"], verts=28)
    parent(body, root)
    nose = cone("nose", 3.0, 0.0, 7.5, (0, 0, H+3.75), COL["hull"], verts=28)
    parent(nose, root)
    # heat shield bottom
    parent(cyl("shield", 3.05, 0.5, (0, 0, 0.25), COL["dark"], verts=28), root)
    # forward + aft flaps
    for (sy, nm) in ((-1, "aft"), (1, "fwd")):
        f = box(nm+"_fin", (0.3, 3.4, 5.2), (2.4, sy*3.4, 6.5 if nm == "aft" else H-6.0),
                COL["hull2"], rot=(math.radians(-8*sy), 0, 0))
        parent(f, root)
    # window strip + engine light
    parent(box("win_strip", (0.15, 0.45, H*0.62), (3.0, 0, H*0.5), COL["amber"]), root)
    parent(box("logo_band", (0.15, 1.2, 0.5), (3.0, 0, H*0.78), COL["cyan"]), root)
    # flaps aft
    for i in range(3):
        ang = i * math.tau/3
        f = box("flap", (0.25, 1.6, 4.5), (3.2*math.cos(ang), 3.2*math.sin(ang), 4.0),
                COL["hull2"], rot=(0, 0, ang))
        parent(f, root)
    # engine bell
    parent(cone("engine", 1.9, 2.7, 3.2, (0, 0, -1.4), COL["dark"], verts=20), root)
    parent(sph("plume_seed", 1.2, (0, 0, -3.0), COL["mag"], segs=10, rings=8), root)
    return root

# =========================================================
# 5. ROVER — chassis, 6 named wheels, mast, RTG, lights
# =========================================================
def build_rover():
    delete_all(); root = new_root("rover")
    ch = box("chassis", (2.6, 3.6, 0.7), (0, 0, 0.95), COL["gold"]); parent(ch, root)
    deck = box("deck", (2.2, 2.6, 0.25), (0, -0.3, 1.42), COL["hull"]); parent(deck, root)
    body = box("body", (2.35, 2.0, 0.9), (0, -1.0, 1.6), COL["hull"]); parent(body, root)
    # amber light bar
    parent(box("beam", (2.0, 0.15, 0.15), (0, -2.05, 1.55), COL["amber"]), root)
    parent(box("tail", (2.0, 0.12, 0.12), (0, 1.05, 1.5), COL["red"]), root)
    # camera mast + head
    parent(cyl("mast", 0.09, 1.7, (0, -1.5, 2.5), COL["metal"], verts=8), root)
    head = box("cam_head", (0.75, 0.3, 0.35), (0, -1.5, 3.4), COL["dark"]); parent(head, root)
    parent(box("cam_eye", (0.35, 0.1, 0.12), (0, -1.66, 3.42), COL["cyan"]), root)
    # dish
    dsh = sph("dish", 0.55, (0.75, 0.4, 2.2), COL["hull"], segs=12, rings=8)
    dsh.scale = (1, 1, 0.45); parent(dsh, root)
    # RTG with fins at back
    rtg = cyl("rtg", 0.32, 1.15, (0, 1.75, 1.5), COL["dark"], rot=(0, math.pi/2, 0), verts=10)
    parent(rtg, root)
    for i in range(6):
        ang = i * math.tau/6
        fin = box("rtg_fin", (0.05, 1.0, 0.35), (0.32*math.cos(ang), 1.75, 0.32*math.sin(ang)+1.5),
                  COL["metal"], rot=(ang, 0, 0))
        parent(fin, root)
    parent(sph("rtg_glow", 0.12, (0.36, 1.75, 1.5), COL["mag"], segs=8, rings=6), root)
    # wheels: named wheel_0..5 (FL FR RL MM... ) for runtime rotation
    positions = [(-1.35, -1.35), (1.35, -1.35), (-1.35, -0.15), (1.35, -0.15),
                 (-1.35, 1.05), (1.35, 1.05)]
    for i, (x, y) in enumerate(positions):
        bpy.ops.object.empty_add(location=(x, y, 0.62))
        pv = obj(bpy.context.object); pv.name = "wheelpivot_%d" % i
        parent(pv, root)
        w = cyl("wheel_%d" % i, 0.62, 0.5, (x, y, 0.62), COL["dark"],
                rot=(0, math.pi/2, 0), verts=14)
        parent(w, pv)
        hub = cyl("hub_%d" % i, 0.34, 0.54, (x, y, 0.62), COL["gold"],
                  rot=(0, math.pi/2, 0), verts=10)
        parent(hub, pv)
        # treads
        for k in range(6):
            ang = k * math.tau/6
            t = box("tread", (0.14, 0.66, 0.1), (x, y + 0.6*math.cos(ang), 0.62 + 0.6*math.sin(ang)),
                    COL["metal"], rot=(ang, 0, 0))
            parent(t, pv)
    # flag!
    parent(cyl("flagpole", 0.04, 1.6, (0.9, 0.9, 2.3), COL["metal"], verts=6), root)
    parent(box("flag", (0.7, 0.02, 0.45), (1.25, 0.9, 2.9), COL["cloth"]), root)
    return root

# =========================================================
# 6. SOLAR ARRAY — double tilted panels on pylon
# =========================================================
def build_solar_array():
    delete_all(); root = new_root("solar_array")
    parent(cyl("pylon", 0.28, 2.4, (0, 0, 1.2), COL["metal"], verts=8), root)
    parent(cyl("foot", 0.9, 0.25, (0, 0, 0.12), COL["hull2"], verts=10), root)
    for sy in (-1, 1):
        p = box("panel", (3.4, 5.2, 0.12), (0, sy*2.7, 2.55), COL["solar"],
                rot=(math.radians(32*sy), 0, 0))
        parent(p, root)
        # cell grid lines
        for k in range(4):
            g = box("grid", (3.45, 0.05, 0.14), (0, sy*(0.7+k*1.3), 2.55+ (1.95 - k*1.3)*math.tan(math.radians(32))*sy*0),
                    COL["dark"], rot=(math.radians(32*sy), 0, 0))
            g.location.z = 2.55 + (1.9 - k*1.25)*math.sin(math.radians(32))*sy*-1
            g.location.y = sy*2.7 - (1.9 - k*1.25)*math.cos(math.radians(32))*sy*-1*0
            parent(g, root)
        parent(box("edge_light", (3.4, 0.08, 0.08), (0, sy*4.9, 1.75), COL["cyan"]), root)
    parent(sph("node", 0.2, (0, 0, 2.5), COL["amber"], segs=8, rings=6), root)
    return root

# =========================================================
# 7. COMM DISH — faceted dish + strut + feed
# =========================================================
def build_comm_dish():
    delete_all(); root = new_root("comm_dish")
    parent(cyl("mast", 0.3, 3.2, (0, 0, 1.6), COL["metal"], verts=8), root)
    parent(cyl("foot", 1.1, 0.35, (0, 0, 0.15), COL["hull2"], verts=8), root)
    d = cone("dish", 3.0, 0.4, 1.4, (0, 0.6, 3.9), COL["hull"], verts=14)
    d.rotation_euler = (math.radians(-118), 0, 0)
    parent(obj(d), root)
    feed = cyl("feed", 0.08, 2.2, (0, 1.6, 4.7), COL["dark"], rot=(math.radians(40), 0, 0), verts=6)
    parent(feed, root)
    parent(sph("feed_tip", 0.22, (0, 2.2, 5.5), COL["amber"], segs=8, rings=6), root)
    return root

# =========================================================
# 8. CRYO TANKS — twin tanks + pipe bridge
# =========================================================
def build_cryo_tank():
    delete_all(); root = new_root("cryo_tank")
    t = cyl("tank", 2.0, 7.0, (0, 0, 4.6), COL["hull"], verts=18); parent(t, root)
    parent(sph("cap", 2.0, (0, 0, 8.1), COL["hull"], segs=18, rings=8), root)
    parent(tor("hoop1", 2.05, 0.1, (0, 0, 3.2), COL["amber"], maj=14, mino=5), root)
    parent(tor("hoop2", 2.05, 0.1, (0, 0, 6.4), COL["cyan"], maj=14, mino=5), root)
    for i in range(4):
        ang = i * math.tau/4
        parent(cyl("leg", 0.16, 1.8, (1.55*math.cos(ang), 1.55*math.sin(ang), 0.8),
                   COL["metal"], verts=6), root)
    parent(cyl("outlet", 0.3, 1.6, (2.4, 0, 1.4), COL["metal"], rot=(0, math.pi/2, 0), verts=8), root)
    parent(box("label", (0.08, 1.0, 1.6), (2.02, 0, 5.0), COL["red"]), root)
    return root

# =========================================================
# 9. LAMP — pole + glowing head (road lighting)
# =========================================================
def build_lamp():
    delete_all(); root = new_root("lamp")
    parent(cyl("pole", 0.12, 4.4, (0, 0, 2.2), COL["metal"], verts=6), root)
    parent(cyl("foot", 0.35, 0.2, (0, 0, 0.1), COL["hull2"], verts=8), root)
    a = tor("arm", 0.9, 0.09, (0.9, 0, 4.3), COL["metal"], maj=8, mino=4,
            rot=(0, math.pi/4, 0))
    parent(a, root)
    parent(sph("bulb", 0.28, (1.55, 0, 4.05), COL["warm"], segs=10, rings=8), root)
    parent(box("stripe", (0.05, 0.1, 1.2), (0.12, 0, 3.0), COL["amber"]), root)
    return root

# =========================================================
# 10. ROCK CLUSTER + ARCH STONE — low-poly scatter
# =========================================================
def displaced_ico(name, r, loc, m, amount=0.35, subdiv=1):
    o = ico(name, r, loc, m, subdiv=subdiv)
    for v in o.data.vertices:
        v.co += v.co.normalized() * random.uniform(-amount, amount) * r
    return o

def build_rocks():
    delete_all(); root = new_root("rock_cluster")
    for i in range(5):
        r = random.uniform(0.8, 2.6)
        o = displaced_ico("rock_%d" % i, r,
                          (random.uniform(-5, 5), random.uniform(-5, 5), r*0.55),
                          COL["rust"], amount=0.4, subdiv=1)
        o.scale = (random.uniform(0.7, 1.4), random.uniform(0.7, 1.4), random.uniform(0.6, 1.0))
        parent(o, root)
    return root

def build_crystal():
    delete_all(); root = new_root("crystal")
    c = cone("shard", 0.5, 0.0, 2.6, (0, 0, 1.3),
             mat("crystal_mat", (0.6, 0.9, 1.0), rough=0.1, emissive=(0.4, 0.9, 1.0),
                 strength=2.6, alpha=0.7), verts=6)
    c.data.shade_flat(); parent(c, root)
    for i in range(3):
        ang = i * math.tau/3
        s = cone("shard2", 0.22, 0.0, 1.1, (0.6*math.cos(ang), 0.6*math.sin(ang), 0.5),
                 bpy.data.materials["crystal_mat"], verts=5)
        s.rotation_euler = (math.radians(25*math.sin(ang)*2), math.radians(25*math.cos(ang)*2), 0)
        s.data.shade_flat(); parent(s, root)
    return root

# =========================================================
# 11. GATE — time-trial arch with neon ring
# =========================================================
def build_gate():
    delete_all(); root = new_root("gate")
    parent(cyl("post_l", 0.35, 7.0, (-4.0, 0, 3.5), COL["dark"], verts=8), root)
    parent(cyl("post_r", 0.35, 7.0, (4.0, 0, 3.5), COL["dark"], verts=8), root)
    parent(box("top", (8.7, 0.7, 0.7), (0, 0, 7.2), COL["hull2"]), root)
    parent(box("neon", (8.7, 0.15, 0.15), (0, -0.4, 7.2), COL["mag"]), root)
    parent(box("neon2", (8.7, 0.15, 0.15), (0, 0.4, 6.8), COL["cyan"]), root)
    parent(sph("bulb_l", 0.4, (-4.0, 0, 7.2), COL["amber"], segs=8, rings=6), root)
    parent(sph("bulb_r", 0.4, (4.0, 0, 7.2), COL["amber"], segs=8, rings=6), root)
    return root

# =========================================================
# 12. LANDER — small egg-shaped landing craft on legs
# =========================================================
def build_lander():
    delete_all(); root = new_root("lander")
    e = sph("egg", 2.2, (0, 0, 2.6), COL["hull"], segs=14, rings=10)
    e.scale = (1, 1, 1.25); parent(e, root)
    parent(tor("belt", 2.25, 0.14, (0, 0, 2.4), COL["amber"], maj=14, mino=5), root)
    parent(sph("eye", 0.5, (0, -1.9, 3.4), COL["cyan"], segs=10, rings=8), root)
    for i in range(3):
        ang = i * math.tau/3
        l = box("leg", (0.22, 2.4, 0.22), (1.6*math.cos(ang), 1.6*math.sin(ang), 0.9),
                COL["metal"], rot=(0, math.radians(50), ang + math.pi/2))
        parent(l, root)
        parent(sph("pad", 0.35, (2.5*math.cos(ang), 2.5*math.sin(ang), 0.25),
                   COL["hull2"], segs=8, rings=6), root)
    return root

assets = [
    (build_habitat_dome, "habitat_dome.glb"),
    (build_greenhouse,   "greenhouse.glb"),
    (build_launch_tower, "launch_tower.glb"),
    (build_starship,     "starship.glb"),
    (build_rover,        "rover.glb"),
    (build_solar_array,  "solar_array.glb"),
    (build_comm_dish,    "comm_dish.glb"),
    (build_cryo_tank,    "cryo_tank.glb"),
    (build_lamp,         "lamp.glb"),
    (build_rocks,        "rock_cluster.glb"),
    (build_crystal,      "crystal.glb"),
    (build_gate,         "gate.glb"),
    (build_lander,       "lander.glb"),
]

if __name__ == "__main__":
    for fn, fname in assets:
        r = fn()
        move_all_to(bpy.context.scene.collection, r)
        export(r, fname)
    print("ALL_DONE")
