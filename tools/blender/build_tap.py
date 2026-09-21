# Blender builder for the reactor tap — the substation stand that sits beside every
# teleport pad, and the thing the rover's battery has to walk the grid back up to.
#
# The runtime version was about sixty boxes and cylinders repeated six times over; this is
# one authored asset cloned to each pad. What it has to survive is a glance from 100 m and
# a drive-past from 3 m, so it is built the way a substation actually is: an octagonal
# foundation with its bolt circle, a finned transformer drum under a conservator cap, three
# porcelain bushings stacked from sheds, a four-leg lattice mast braced in X on every face,
# and a service deck with a handrail hung over the core cage.
#
# Local frame: origin at the centre of the foundation, z=0 at its underside. The animated
# core, its light shaft and the cable run to the pad stay in the app — one of them spins,
# one of them samples terrain, and neither is geometry you would bake.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_tap.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, img, textures, uv_cube, rbox, ball, cyl, cone,
                    torus, band, shell, limb, folds, lobes, ramp, chain, empty, parent,
                    purge, export, bool_op, smooth_angle, bevel, mesh_obj, solidify, join,
                    apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

MAPPED = {}
for k in ("tap_iron", "tap_soot", "tap_cast"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                        metal={"tap_iron": 0.86, "tap_soot": 0.45, "tap_cast": 0.12}[k]),
                 d["v_m"])

FLAT = {
    "porcelain": mat("tap_porcelain", (0.44, 0.40, 0.335), rough=0.34, metal=0.06),
    "hot":       mat("light_tap_lamp", (0.26, 0.10, 0.035), rough=0.5, metal=0.1,
                     emis=(1.0, 0.36, 0.12), estr=1.0),
}

PARTS = []


def place(o, key):
    if key in MAPPED:
        m, tile = MAPPED[key]
        o.data.materials.clear()
        o.data.materials.append(m)
        uv_cube(o, tile)
    else:
        o.data.materials.clear()
        o.data.materials.append(FLAT[key])
    PARTS.append(o)
    return o


def build_tap():
    purge()
    PARTS.clear()
    root = empty("reactor_tap")

    # ── foundation: an octagonal footing, a bolted flange, and the eight keys that
    # hold the drum down ───────────────────────────────────────────────────────────
    place(cyl("footing", 2.05, 0.26, (0, 0, 0.13), None, verts=8, br=0.035), "tap_cast")
    place(cyl("flange", 1.42, 0.14, (0, 0, 0.33), None, verts=8, br=0.025), "tap_iron")
    for i in range(8):
        a = i * math.tau / 8 + 0.39
        place(rbox("key%d" % i, 0.14, 0.14, 0.13, (math.sin(a) * 1.42, math.cos(a) * 1.42, 0.46),
                   None, bevel_r=0.022, segs=2), "tap_soot")

    # ── the transformer: a finned drum under a conservator, with its bushings on top ─
    place(cyl("drum", 0.62, 1.0, (0, 0, 0.92), None, verts=26, br=0.04), "tap_iron")
    # the fins are plates standing proud of the drum: thin along the circumference, deep
    # along the radius, tall along the axis — so each one is a box turned about Z to its
    # station on the drum
    for i in range(12):
        a = i * math.tau / 12
        place(rbox("fin%d" % i, 0.045, 0.24, 0.82, (math.sin(a) * 0.68, math.cos(a) * 0.68, 0.92),
                   None, bevel_r=0.012, segs=1, rot=(0, 0, -a)), "tap_soot")
    place(cone("conservator", 0.58, 0.44, 0.16, (0, 0, 1.50), None, verts=24, br=0.02),
          "tap_soot")
    for i in range(3):
        a = i * math.tau / 3 + 0.5
        bx, bz = math.sin(a) * 0.33, math.cos(a) * 0.33
        for d in range(3):                       # the sheds a porcelain insulator is made of
            place(cyl("shed%d_%d" % (i, d), 0.145 - d * 0.015, 0.05,
                      (bx, bz, 1.66 + d * 0.13), None, rot=(0, 0, 0), verts=16, br=0.012),
                  "porcelain")
        place(cyl("rod%d" % i, 0.03, 0.46, (bx, bz, 1.98), None, verts=10, br=0.0), "tap_iron")
        place(ball("terminal%d" % i, 0.055, (bx, bz, 2.22), None, segs=12, rings=8), "tap_iron")
    # the tap's own status lamp, on the drum's shoulder
    place(cyl("lamp_bezel", 0.10, 0.05, (0.60, 0.0, 1.28), None, rot=(0, math.pi / 2, 0),
              verts=14, br=0.012), "tap_iron")
    place(cyl("lens", 0.075, 0.04, (0.63, 0.0, 1.28), None, rot=(0, math.pi / 2, 0),
              verts=14, br=0.0), "hot")

    # ── the lattice mast: four legs, a rail at every tier, and an X on each face ────
    MS, Y0, Y1 = 0.6, 2.2, 4.7
    TIER = (Y1 - Y0) / 3
    for sx in (-1, 1):
        for sz in (-1, 1):
            place(rbox("leg_%s%s" % (sx, sz), 0.10, 0.10, Y1 - Y0 + 0.30,
                       (sx * MS, sz * MS, (Y0 + Y1) / 2), None, bevel_r=0.022, segs=2),
                  "tap_iron")
    # one face of the lattice at a time: its outward normal, the direction along it, and
    # the Euler that puts a horizontal bar into that face's vertical plane
    for k in range(4):
        nx, ny = ((0, 1), (1, 0), (0, -1), (-1, 0))[k]
        ang = math.atan2(ny, nx) + math.pi / 2
        for t in range(4):
            place(rbox("rail%d_%d" % (k, t), MS * 2, 0.07, 0.06, (nx * MS, ny * MS, Y0 + t * TIER),
                       None, bevel_r=0.014, segs=1, rot=(0, 0, ang)), "tap_iron")
        L = math.hypot(MS * 2, TIER) + 0.06
        tilt = math.atan2(TIER, MS * 2)
        for t in range(3):
            yc = Y0 + (t + 0.5) * TIER
            for sgn in (-1, 1):
                place(rbox("brace%d_%d_%s" % (k, t, sgn), L, 0.05, 0.05,
                           (nx * MS, ny * MS, yc), None, bevel_r=0.010, segs=1,
                           rot=(0, sgn * tilt, ang)), "tap_soot")
    place(rbox("deck", 1.50, 1.50, 0.11, (0, 0, Y1 + 0.06), None, bevel_r=0.028, segs=2),
          "tap_iron")
    for k in range(4):
        a = k * math.pi / 2
        place(rbox("guardrail%d" % k, 1.44, 0.045, 0.045, (math.sin(a) * 0.70, math.cos(a) * 0.70,
                     Y1 + 0.52), None, bevel_r=0.012, segs=1, rot=(0, 0, -a)), "tap_soot")
        place(cyl("guard_post%d" % k, 0.028, 0.42,
                  (math.sin(a + 0.7) * 0.70, math.cos(a + 0.7) * 0.70, Y1 + 0.30), None,
                  verts=8, br=0.0), "tap_soot")

    # ── the yoke the core hangs in, its cage, and the hanger off the deck ───────────
    place(cyl("hanger", 0.14, 0.90, (0, 0, 5.00), None, verts=8, br=0.02), "tap_iron")
    place(torus("yoke", (0, 0, 5.85), (0, 0, 1), (1, 0, 0), 0.92, 0.055, None, maj=24,
                mino=6), "tap_iron")
    for i in range(4):
        a = i * math.pi / 2
        place(rbox("cage%d" % i, 0.055, 0.055, 1.50, (math.sin(a) * 0.72, math.cos(a) * 0.72,
                     5.85), None, bevel_r=0.012, segs=1,
                   rot=(math.cos(a) * 0.24, -math.sin(a) * 0.24, 0)), "tap_iron")
    place(torus("cage_hoop", (0, 0, 6.42), (0, 0, 1), (1, 0, 0), 0.60, 0.035, None, maj=20,
                mino=5), "tap_iron")
    # the feeder clamp where the cable leaves for the pad
    place(rbox("feeder_clamp", 0.20, 0.16, 0.14, (0, -1.05, 0.20), None, bevel_r=0.025,
               segs=2), "tap_soot")

    for o in PARTS:
        o.parent = root
    root["diameter"] = 4.1
    root["height"] = 6.5
    return root


if __name__ == "__main__":
    export(build_tap(), "reactor_tap.glb")
    print("TAP_DONE")
