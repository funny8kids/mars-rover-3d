# Re-export one named node of a multi-module kit GLB on its own, so preview.py frames that fitting
# alone instead of rendering the whole kit at the scale of its biggest member.
# Run: blender --background --python tools/blender/split_node.py -- site_kit flood
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
ASSET, NODE = argv[0], argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(HERE, "..", "..", "public", "assets", ASSET + ".glb")
OUT = "/tmp/rsb_node_%s.glb" % NODE

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

root = bpy.data.objects.get(NODE) or next((o for o in bpy.data.objects if o.name.startswith(NODE)), None)
if root is None:
    raise SystemExit("no node %r in %s (have: %s)" % (NODE, ASSET, [o.name for o in bpy.data.objects][:40]))

bpy.ops.object.select_all(action='DESELECT')
root.select_set(True)
for o in root.children_recursive:
    if o.type in {'MESH', 'EMPTY'}:
        o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True,
                          export_yup=True, export_apply=True)
print("SPLIT", OUT, "meshes", sum(1 for o in bpy.data.objects if o.type == 'MESH'))
