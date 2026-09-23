# Blender builder for the base's aviation obstruction lights — the fitting that sits on a mast
# head, a tank drum roof, a dish rim and a gantry cap and blinks red at the sky.
#
# What the primitives could not do: props.js placed five of these as `cyl(r, r, h, M.beacon, …)`,
# a plain drum with flat ends. Read at the 40-90 m ranges the base is actually viewed from, a red
# cylinder on a stick is indistinguishable from a red sphere or a red box, so the one object whose
# whole job is "be a light" carried none of the parts that make a light read as engineered: the
# finned heat sink that keeps the LED array alive in vacuum, the sun-shade hood on struts that
# keeps the lens from cooking and throws the shadow ring across it, the bolt circle that holds the
# assembly to a flange, and the conduit stub that feeds it.
#
# Why one asset instead of five: a site buys these in a box of twelve. Five call sites with the
# same fitting at different scales is the truthful answer, and it is also what makes the base read
# as one installation rather than five art passes — the same reason the feeder pillar borrows the
# reactor tap's switchgear textures.
#
# Four materials, and the lens is its own: props.js merges by material, so the metalwork collapses
# to one batch per material across every instance, while the optical drum has to stay a separate
# mesh because the runtime collects it into `beacons` and pulses its emissive term. It is therefore
# named `lens` and parented to `fitting`, so a clone of `fitting` still answers getObjectByName.
#
# Local frame: z=0 is the top of the mast/flange the fitting bolts to, the axis is +z, and the
# assembly is rotationally symmetric about it. The app places it by position and scale only.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_beacon.py
import os, sys, math, bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, torus,
                    empty, purge, export, mesh_obj, join, bool_op)
import bmesh

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

# The switchgear family's own weathering — same cast iron, same soot, same grit as the reactor tap
# and the feeder pillar, because every bolted fitting on this site sees the same dust.
MAPPED = {}
for k in ("tap_iron", "tap_soot", "tap_cast"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                         metal={"tap_iron": 0.86, "tap_soot": 0.45, "tap_cast": 0.12}[k]),
                 d["v_m"])

# The optical drum. Emissive so the runtime's pulse has something to drive, and rough enough that
# it reads as moulded polycarbonate with a fresnel rib, not as a lit lollipop.
LENS = mat("beacon_lens", (0.62, 0.045, 0.04), rough=0.34, metal=0.0,
           emis=(0.86, 0.035, 0.028), estr=2.6)

PARTS = []


def place(o, key):
    m, size = MAPPED[key]
    o.data.materials.clear()
    o.data.materials.append(m)
    uv_cube(o, size)
    PARTS.append(o)
    return o


def ring(name, n, r, z, fn, key):
    """`n` instances of fn(i, angle) around the axis, joined into one mesh — a bolt circle is one
    draw call, not twelve, and the whole point of the asset is that it costs less than the cylinder
    it replaces."""
    out = []
    for i in range(n):
        a = TAU * i / n + (0.5 * TAU / n if n % 2 else 0.0)
        out.append(fn(i, a))
    return place(join(out, name), key)


# ───────────────────────────── the fitting ─────────────────────────────
def build_mount():
    """Flange, bolt circle and the spigot the housing registers into."""
    base = cyl("mount_plate", 0.215, 0.030, (0, 0, 0.015), verts=48, br=0.006)
    spig = cyl("mount_spigot", 0.128, 0.055, (0, 0, 0.055), verts=40, br=0.008)
    place(join([base, spig], "mount"), "tap_cast")
    ring("mount_bolts", 6, 0.178, 0.033,
         lambda i, a: cyl("bolt", 0.0145, 0.026,
                          (0.178 * math.cos(a), 0.178 * math.sin(a), 0.038),
                          verts=6, br=0.003), "tap_iron")


def build_sink():
    """The heat sink. Eight extruded fins around a barrel: in vacuum the only way out for the
    LED's heat is radiation off surface area, so a real fitting is mostly fin."""
    core = cyl("sink_core", 0.108, 0.150, (0, 0, 0.135), verts=40, br=0.010)
    fins = [rbox("fin", 0.014, 0.048, 0.132,
                 (0.126 * math.cos(TAU * i / 8), 0.126 * math.sin(TAU * i / 8), 0.138),
                 bevel_r=0.005, segs=2, rot=(0, 0, TAU * i / 8))
            for i in range(8)]
    place(join([core] + fins, "sink"), "tap_iron")
    # The girth band the two halves clamp across, with its clamp bolt and lug.
    band = torus("sink_band", (0, 0, 0.212), (0, 0, 1), (1, 0, 0), 0.132, 0.014, maj=40, mino=10)
    lug = rbox("sink_lug", 0.030, 0.052, 0.036, (0.150, 0, 0.212), bevel_r=0.006, segs=2)
    place(join([band, lug], "sink_clamp"), "tap_soot")


def build_lens():
    """The optical drum: barrel-sided so the fresnel ribs catch light across a wide elevation
    band, and ribbed by twelve shallow grooves cut into the outer wall — the thing that makes a
    real lens read as glass rather than as plastic, and impossible on a plain cylinder."""
    d = cyl("lens_body", 0.150, 0.185, (0, 0, 0.310), verts=48, br=0.020)
    ribs = [rbox("rib", 0.30, 0.0105, 0.20,
                 (0.150 * math.cos(TAU * i / 12), 0.150 * math.sin(TAU * i / 12), 0.310),
                 rot=(0, 0, TAU * i / 12))
            for i in range(12)]
    bool_op(d, join(ribs, "lens_ribs"), 'DIFFERENCE')
    # Cap rings top and bottom: a moulded lens is clamped, not floating.
    top = cyl("lens_cap", 0.120, 0.018, (0, 0, 0.408), verts=40, br=0.006)
    bot = cyl("lens_base", 0.126, 0.018, (0, 0, 0.216), verts=40, br=0.006)
    lens = join([d, top, bot], "lens")
    lens.data.materials.clear()
    lens.data.materials.append(LENS)
    PARTS.append(lens)
    return lens


def build_hood(lens):
    """Sun shade: a conical disc on four struts above the lens. It keeps the sun off the optic
    (a lens that cooks discolours) and it is the single most recognisable silhouette on the
    fitting, which is exactly why the cylinder had none."""
    shade = cone("hood_disc", 0.235, 0.115, 0.028, (0, 0, 0.470), verts=48, br=0.008)
    cap = cyl("hood_cap", 0.070, 0.024, (0, 0, 0.492), verts=32, br=0.006)
    place(join([shade, cap], "hood"), "tap_soot")
    struts = [cyl("strut", 0.0095, 0.075,
                  (0.140 * math.cos(TAU * i / 4 + TAU / 8), 0.140 * math.sin(TAU * i / 4 + TAU / 8), 0.440),
                  verts=10, br=0.003)
              for i in range(4)]
    place(join(struts, "hood_struts"), "tap_iron")


def build_feed():
    """Conduit stub off the flange edge with a gland nut — the fitting is not wireless, and the
    stub is what ties it visually to the mast it is bolted on."""
    stub = cyl("feed_tube", 0.024, 0.150, (0.196, 0, 0.075), verts=16, br=0.004)
    arm = cyl("feed_arm", 0.024, 0.085, (0.150, 0, 0.148), verts=16, br=0.004,
              rot=(0, math.radians(90), 0))
    gland = cyl("feed_gland", 0.034, 0.034, (0.196, 0, 0.152), verts=12, br=0.005)
    place(join([stub, arm, gland], "feed"), "tap_soot")


if __name__ == "__main__":
    purge()
    root = empty("beacon_kit")
    build_mount()
    build_sink()
    lens = build_lens()
    build_hood(lens)
    build_feed()
    for o in PARTS:
        o.parent = root
    export(root, "beacon_kit.glb")
    print("BEACON_PARTS", len(PARTS))
    print("BEACON_DONE")
