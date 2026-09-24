# Headless preview renderer for the RED STARBASE Blender assets.
# The viewport-screenshot operator is unavailable in this environment, so a real
# EEVEE render is the only way to look at what the builders produced.
# Run: blender --background --python tools/blender/preview.py -- astronaut [views...]
import bpy, math, sys, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
ASSET = argv[0] if argv else "astronaut"
GLB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "public", "assets", ASSET + ".glb"))
OUTDIR = "/tmp/rsb_preview"
os.makedirs(OUTDIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

# The glTF importer already undoes the exporter's Y-up bake, so the figure
# stands along Blender Z as authored — no manual rotation here.

# frame the object
deps = bpy.context.evaluated_depsgraph_get()
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    for c in o.bound_box:
        w = (o.matrix_world @ Vector(c))
        for i in range(3):
            mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
ctr = (mn + mx) / 2
size = max((mx - mn)[i] for i in range(3))

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.eevee.taa_render_samples = 32
sc.render.resolution_x = 900
sc.render.resolution_y = 1100
sc.view_settings.view_transform = 'Filmic'
sc.view_settings.look = 'Medium High Contrast'

world = bpy.data.worlds.new("w") if not sc.world else sc.world
sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs[0].default_value = (0.10, 0.085, 0.075, 1)
bg.inputs[1].default_value = 0.55

def light(name, loc, energy, size=2.0):
    d = bpy.data.lights.new(name, 'SUN'); d.energy = energy; d.angle = math.radians(2)
    o = bpy.data.objects.new(name, d); o.location = loc
    o.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(o); return o

light("key", (4, -5, 6), 5.0)
light("rim", (-5, 4, 3), 1.6)
light("fill", (-2, -6, 1), 0.9)

cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d)
sc.collection.objects.link(cam)
sc.camera = cam
# The default 100 m far plane simply hides anything the size of a launch stack.
cam_d.clip_start = max(0.001, size / 2000)
cam_d.clip_end = max(1000.0, size * 20)

VIEWS = argv[1:] or ["front", "threeq", "back", "helm"]
# name: (direction, focus offset as a fraction of size, distance fraction, lens)
SPAN = {"front": ((0, -1, 0.10), 0.0, 1.9, 60), "back": ((0, 1, 0.10), 0.0, 1.9, 60),
        "left": ((-1, 0, 0.06), 0.0, 1.9, 60), "right": ((1, 0, 0.06), 0.0, 1.9, 60),
        "threeq": ((-0.75, -0.9, 0.30), 0.0, 1.9, 60), "top": ((0, -0.2, 1.0), 0.0, 1.9, 60),
        "helm": ((0, -1, 0.30), 0.30, 1.35, 85), "boots": ((0, -1, -0.45), -0.42, 1.35, 85),
        "low34": ((-0.8, -1, -0.15), 0.0, 1.9, 60),
        # A ground fitting's beam faces +Y, so `front` (camera on −Y) is its back. `lamp` is the
        # viewpoint that matters for a flood bolted to a deck: standing on the pad, looking down.
        "lamp": ((0.42, 0.74, 0.52), 0.0, 1.5, 60),
        "nose": ((-0.7, -0.75, 0.22), 0.44, 0.30, 70),
        "mid": ((-0.8, -0.6, 0.05), 0.02, 0.30, 70),
        "aft": ((-0.7, -0.75, -0.20), -0.44, 0.30, 70),
        "word": ((0, -1, -0.05), -0.30, 0.20, 70)}
for v in VIEWS:
    d, fz, fd, lens = SPAN.get(v, ((0, -1, 0.2), 0.0, 1.9, 60))
    dirn = Vector(d).normalized()
    dist = size * fd
    focus = ctr + Vector((0, 0, size * fz))
    cam.location = focus + dirn * dist
    cam.rotation_euler = (focus - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_d.lens = lens
    sc.render.filepath = os.path.join(OUTDIR, "%s_%s.png" % (ASSET, v))
    bpy.ops.render.render(write_still=True)
    print("RENDERED", sc.render.filepath)
print("PREVIEW_DONE", ASSET, "meshes", sum(1 for o in bpy.data.objects if o.type == 'MESH'),
      "tris", sum(sum(len(p.vertices) - 2 for p in o.data.polygons)
                  for o in bpy.data.objects if o.type == 'MESH'))
