# Blender builder for the hub plaza deck — the paved surface the arrival shot lands on.
# The runtime version of it was thirty-six separate boxes laid on a Kenney platform, which
# is the definition of the thing this goal exists to remove. Here it is one authored plate:
# broomed concrete in quarter-metre slabs with shadowed joints, a raised landing disc on a
# hazard ring, twelve flush lens studs set level with the deck, and two threshold bands.
#
# Local frame: origin at the plaza centre, underside of the plate at z=0, 20 m square.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_plaza.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, img, textures, uv_cube, rbox, ball, cyl, cone,
                    torus, band, shell, limb, folds, lobes, ramp, chain, empty, parent,
                    purge, export, bool_op, smooth_angle, bevel, mesh_obj, solidify, join,
                    apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

SIDE = 20.0                     # the plate is square; the app scales it to the deck it covers

MAPPED = {}
for k in ("plaza_pave", "plaza_ring"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0, metal=0.05), d["v_m"])

FLAT = {
    "hazard": mat("plaza_hazard", (0.30, 0.115, 0.055), rough=0.8, metal=0.05),
    "stud":   mat("light_plaza_stud", (0.10, 0.26, 0.30), rough=0.28, metal=0.1,
                  emis=(0.30, 0.86, 1.0), estr=1.0),
    "plaza_steel": mat("plaza_steel", (0.36, 0.355, 0.35), rough=0.46, metal=0.8),
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


def build_plaza():
    purge()
    PARTS.clear()
    root = empty("hub_plaza")

    # The plate itself: one slab with a chamfered kerb around it, not a grid of pucks. A
    # 20 m cast panel field would crack, so it is sawn into quarters at the expansion
    # joints and the broom finish runs across each quarter.
    plate = rbox("paving", SIDE, SIDE, 0.10, (0, 0, 0.05), None, bevel_r=0.022, segs=2)
    place(plate, "plaza_pave")
    for s in (-1, 1):
        place(rbox("kerb_x%g" % s, 0.42, SIDE, 0.16, (s * (SIDE / 2 - 0.21), 0, 0.08),
                   None, bevel_r=0.03, segs=2), "plaza_ring")
        place(rbox("kerb_z%g" % s, SIDE - 0.84, 0.42, 0.16, (0, s * (SIDE / 2 - 0.21), 0.08),
                   None, bevel_r=0.03, segs=2), "plaza_ring")
    # expansion joints sawn into the field, one quarter of the plate on each side of centre
    for s in (-1, 1):
        place(rbox("joint_x%g" % s, 0.06, SIDE - 1.2, 0.035, (s * SIDE / 4, 0, 0.098),
                   None, bevel_r=None, segs=1), "plaza_steel")
        place(rbox("joint_z%g" % s, SIDE - 1.2, 0.06, 0.035, (0, s * SIDE / 4, 0.098),
                   None, bevel_r=None, segs=1), "plaza_steel")

    # the landing: a raised disc on a painted hazard ring, with the threshold bands a
    # pilot actually lines up against at either end of the approach
    place(cyl("landing_disc", 3.5, 0.14, (0, 0, 0.12), None, verts=52, br=0.025),
          "plaza_ring")
    place(torus("hazard_ring", (0, 0, 0.175), (0, 0, 1), (1, 0, 0), 4.0, 0.15, None,
                maj=64, mino=7), "hazard")
    place(torus("disc_collar", (0, 0, 0.19), (0, 0, 1), (1, 0, 0), 3.52, 0.045, None,
                maj=56, mino=6), "plaza_steel")
    for s in (-1, 1):
        place(rbox("threshold_s%g" % s, 5.6, 0.5, 0.045, (0, s * 4.9, 0.118), None,
                   bevel_r=None, segs=1), "hazard")

    # Apron lighting is furniture set into the deck, not pucks standing on it: each stud is
    # a steel bowl with a lens ground flush with the rim.
    for i in range(12):
        a = i / 12 * TAU + 0.26
        x, y = math.cos(a) * 9.4, math.sin(a) * 9.4
        place(cyl("stud_bowl%d" % i, 0.185, 0.07, (x, y, 0.035), None, verts=18, br=0.014),
          "plaza_steel")
        place(cyl("stud_lens%d" % i, 0.148, 0.028, (x, y, 0.078), None, verts=18, br=0.008),
          "stud")
    # two drain grates where the deck actually sheets water
    for (dx, dz) in ((-6.6, 6.6), (6.6, -6.6)):
        o = math.radians(45)
        place(rbox("drain%g" % dx, 1.50, 0.70, 0.05, (dx, dz, 0.10), None, bevel_r=0.0,
                   segs=1, rot=(0, 0, o)), "plaza_steel")
        for i in range(5):                       # the bars lie across the mouth of the grate
            off = (i - 2) * 0.14
            place(rbox("drain_bar%g_%d" % (dx, i), 1.30, 0.05, 0.062,
                       (dx - math.sin(o) * off, dz + math.cos(o) * off, 0.112), None,
                       bevel_r=0.0, segs=1, rot=(0, 0, o)), "plaza_steel")
    for o in PARTS:
        o.parent = root
    root["side"] = SIDE
    return root


if __name__ == "__main__":
    export(build_plaza(), "hub_plaza.glb")
    print("PLAZA_DONE")
