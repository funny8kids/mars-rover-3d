# Blender builder for the hub plaza's flag mast — the 8 m pole the plaza is addressed by.
#
# What the primitives could not do: the old mast was one tapered cylinder with a sphere on top,
# three torus rings at the same height as the cloth, and a stub of tube between them. A mast that
# tall is *built* in sections and *ridden* with hardware: a bolted-down boot, a halyard winch, a
# cleat, section flanges every ~2.4 m, and a truck with a sheave the line actually passes over.
# Every one of those is a silhouette cue, and the silhouette is the only thing a 5-px-wide tube
# can still communicate at 40 m.
#
# Why there are no texture maps on this one: the pole is 160 mm of section. At the plaza's viewing
# distances it is about five pixels wide, so a 6 mm panel gap from rsbtex rasterises to nothing.
# The micro-detail is left to surface_detail.js, which lays its world-anchored 2.6 m module grid
# and rivets over the tube at render time — which is also where the section flanges already are.
# What had to be authored in geometry is the *form*: chamfers, flanges, gussets, the drum.
#
# Three materials, not six. The mast is a single instance, so every material on it is one extra
# draw call in the plaza's merged batch; pale tube, steel work and shadowed smallware is the
# whole palette a mast like this actually has.
#
# Local frame: z=0 is plaza grade, the mast runs up +Z, the flag flies toward +X (which exports to
# the app's +X). The halyard runs at x=+0.20, clear of the 0.108–0.15 tube, and the cloth's hoist
# edge has to be moved there in props.js so the rings are threaded on something.
#
# Run: blender --background --python tools/blender/build_flagmast.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, rbox, ball, cyl, cone, torus, empty, purge, export)

bpy.ops.wm.read_factory_settings(use_empty=True)

# Authored to land in the plaza's existing value band rather than the "kit white" that the SHELL
# retint pass in props.js exists to pull down: chalked paint, galvanised fittings, sun-faded line.
M = {
    "pale": mat("mast_pale", (0.42, 0.40, 0.375), rough=0.56, metal=0.34),
    "steel": mat("mast_steel", (0.30, 0.305, 0.32), rough=0.74, metal=0.42),
    "dark": mat("mast_dark", (0.115, 0.11, 0.105), rough=0.82, metal=0.3),
}

# Stations the runtime already draws the cloth against: the halyard rings the hoist sleeve hangs on.
RING_Z = (6.98, 6.35, 5.72)
HALYARD_X = 0.20
MAST_TOP, TOTAL_TOP = 7.0, 7.84

PARTS = []
root = None


def add(o, key):
    o.data.materials.append(M[key])
    o.parent = root
    PARTS.append(o)
    return o


# ─── the foot: what stops a 160 mm tube in 20 m/s of katabatic wind ───────────────────
def build_foot():
    # Tapered boot with 80 mm of skirt below grade, so seating it on the sampled plaza height can
    # never lift a rim into the air the way the old cylinder's open bottom did.
    add(cone("boot", 0.25, 0.19, 0.42, (0, 0, 0.13), None, verts=12, br=0.022), "dark")
    add(rbox("plate", 0.40, 0.40, 0.030, (0, 0, 0.345), None, bevel_r=0.008, segs=1), "steel")
    for i in range(8):
        a = i * TAU / 8 + math.pi / 8
        add(cyl("anchor%d" % i, 0.024, 0.085, (math.sin(a) * 0.155, math.cos(a) * 0.155, 0.395),
                None, verts=6, br=0.0), "steel")
    # Four gussets carry the tube into the plate; without them the joint is a paint line.
    for i in range(4):
        a = i * math.pi / 2 + math.pi / 4
        add(rbox("gusset%d" % i, 0.018, 0.155, 0.21,
                 (math.sin(a) * 0.145, math.cos(a) * 0.145, 0.455), None,
                 bevel_r=0.006, segs=1, rot=(0, 0, a)), "steel")

    # ── the winch the halyard is actually tensioned by ────────────────────────────────
    add(rbox("winch_frame", 0.13, 0.20, 0.20, (0.175, 0, 0.56), None,
             bevel_r=0.012, segs=1), "steel")
    add(cyl("winch_drum", 0.058, 0.115, (0.245, 0, 0.56), None,
            rot=(math.pi / 2, 0, 0), verts=18, br=0.010), "dark")
    for sgn in (-1, 1):
        add(cyl("drum_end", 0.070, 0.016, (0.245, sgn * 0.062, 0.56), None,
                rot=(math.pi / 2, 0, 0), verts=18, br=0.0), "steel")
    # crank: an arm on the drum axis with a grip turned back over it
    add(rbox("crank_arm", 0.020, 0.135, 0.020, (0.245, -0.075, 0.615), None,
             bevel_r=0.006, segs=1, rot=(0.45, 0, 0)), "steel")
    add(cyl("crank_grip", 0.017, 0.075, (0.268, -0.140, 0.648), None,
            rot=(math.pi / 2, 0, 0), verts=12, br=0.008), "dark")

    # ── the cleat the tail is made fast to, 800 mm above the drum ──────────────────────
    add(rbox("cleat_base", 0.10, 0.075, 0.030, (0.165, 0, 1.305), None,
             bevel_r=0.008, segs=1), "steel")
    for sgn in (-1, 1):
        add(rbox("cleat_horn%d" % sgn, 0.115, 0.028, 0.028, (0.20, sgn * 0.052, 1.345), None,
                 bevel_r=0.010, segs=1, rot=(0, 0, sgn * 0.30)), "steel")


# ─── the mast: sections, flanges, and the head the line runs over ──────────────────────
def build_mast():
    SECTIONS = ((0.30, 2.62, 0.150, 0.140), (2.72, 4.98, 0.140, 0.126), (5.08, MAST_TOP, 0.126, 0.106))
    for i, (z0, z1, r0, r1) in enumerate(SECTIONS):
        add(cone("section%d" % i, r0, r1, z1 - z0, (0, 0, (z0 + z1) / 2), None,
                 verts=24, br=0.0), "pale")
    # Each section below the top butts into a bolted collar 2.3 m apart: it is the one line of
    # construction detail a 160 mm tube can still carry at 40 m, and it is why the mast can be
    # 8 m of aluminium without being a single extrusion.
    for (z0, z1, r0, r1) in SECTIONS[:-1]:
        zr = z1 + 0.05
        add(cyl("flange", r1 + 0.038, 0.072, (0, 0, zr), None, verts=24, br=0.012), "steel")
        for i in range(6):
            a = i * TAU / 6
            add(cyl("flange_bolt%d" % i, 0.016, 0.026,
                    (math.sin(a) * (r1 + 0.020), math.cos(a) * (r1 + 0.020), zr + 0.045), None,
                    verts=6, br=0.0), "steel")

    # ── the truck: a bracket the sheave turns in, not a cap glued on top ───────────────
    add(rbox("truck", 0.30, 0.10, 0.17, (0.055, 0, 7.075), None, bevel_r=0.020, segs=2), "steel")
    add(cyl("sheave", 0.078, 0.034, (HALYARD_X, 0, 7.135), None,
            rot=(math.pi / 2, 0, 0), verts=22, br=0.008), "dark")
    add(cyl("sheave_pin", 0.016, 0.115, (HALYARD_X, 0, 7.135), None,
            rot=(math.pi / 2, 0, 0), verts=12, br=0.0), "steel")
    add(cone("shoulder", 0.118, 0.055, 0.13, (0, 0, 7.29), None, verts=20, br=0.010), "pale")
    # finial: spike then ball, ending 2 cm below where the old sphere's top sat
    add(cyl("spike", 0.028, 0.26, (0, 0, 7.47), None, verts=12, br=0.008), "steel")
    add(ball("finial", 0.115, (0, 0, 7.725), None, segs=20, rings=12), "pale")


# ─── the rigging: halyard, and the rings the sleeve hangs from ─────────────────────────
def build_rigging():
    # The line runs from the sheave down the flag face of the mast to the cleat, then into the
    # drum. Both legs stay inside the pole's own silhouette from the plaza's approach, so they
    # cost nothing to read and are the reason the rings mean something.
    add(cyl("halyard", 0.017, 5.80, (HALYARD_X, 0, 4.20), None, verts=8, br=0.0), "dark")
    add(cyl("halyard_tail", 0.017, 0.86, (HALYARD_X - 0.012, 0, 1.03), None,
            verts=8, br=0.0), "dark")
    # Thimble-eyed rings at the cloth's hoist stations, in the line of the sleeve: axis along +X,
    # so the halyard passes through the hole and the cloth hangs between the two faces of the ring
    # exactly as a hoist sleeve does. The old ones sat on the pole's own axis, inside the tube.
    for i, z in enumerate(RING_Z):
        add(torus("ring%d" % i, (HALYARD_X, 0, z), (1, 0, 0), (0, 0, 1), 0.150, 0.030,
                  None, maj=18, mino=7), "steel")
    # A mast-head wind indicator: the plaza's one free hint about which way the storm is coming.
    add(cone("vane", 0.045, 0.0, 0.30, (0.36, 0, 6.955), None, verts=10, br=0.0,
             rot=(0, math.pi / 2, 0)), "dark")


if __name__ == "__main__":
    purge()
    root = empty("flag_mast")
    build_foot()
    build_mast()
    build_rigging()
    export(root, "flag_mast.glb")
    print("MAST_PARTS", len(PARTS), "TOP", TOTAL_TOP)
    print("FLAGMAST_DONE")
