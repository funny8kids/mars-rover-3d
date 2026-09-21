# Blender builder for Spaceport Gate 01 — the portal the player drives under at the south
# approach, and the first thing in frame at spawn. The runtime version of it was about sixty
# boxes and cylinders; this is one authored asset at the same 20.9 m span and 16.6 m to the
# beacon mast.
#
# Local frame: origin at the centre of the lane on the ground, the span along X, traffic
# passing under along ±Y. Datum z=0 is the ground under the plinths, so placement is one
# translate and one rotation.
#
# What makes it a structure rather than a painted frame: jointed precast pylons whose shafts
# taper course by course on a bolted bearing, a real box girder with chords, verticals,
# soffit joists and a recessed service panel, a catwalk with a railing, and the lane-facing
# light channels set into rebates instead of skinned over the leg.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_gate.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, img, textures, uv_cube, rbox, ball, cyl, cone,
                    torus, band, shell, limb, folds, lobes, ramp, chain, empty, parent,
                    purge, export, bool_op, smooth_angle, bevel, mesh_obj, solidify, join,
                    apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

LEG_X = 8.1                     # the pylon axes either side of the lane
PLINTH_H = 0.78
COURSE = 2.35
COURSES = 4
BEAM_Y = PLINTH_H + COURSES * COURSE      # soffit level of the girder

MAPPED = {}
for k in ("gate_cast", "gate_metal", "gate_dark"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                        metal={"gate_cast": 0.05, "gate_metal": 0.86,
                               "gate_dark": 0.42}[k]), d["v_m"])

FLAT = {
    "channel": mat("light_gate_channel", (0.10, 0.26, 0.30), rough=0.34, metal=0.10,
                   emis=(0.30, 0.86, 1.0), estr=1.0),
    "flood":   mat("light_gate_flood", (0.24, 0.17, 0.07), rough=0.38, metal=0.10,
                  emis=(1.0, 0.76, 0.40), estr=1.0),
    "hazard":  mat("gate_hazard", (0.30, 0.105, 0.055), rough=0.78, metal=0.05),
    "panel":   mat("gate_panel", (0.115, 0.11, 0.105), rough=0.6, metal=0.28),
    "rub":     mat("gate_rubber", (0.045, 0.044, 0.045), rough=0.9, metal=0.05),
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


def pylon(sgn):
    """A precast portal: a plinth on a kerb lip, four tapered courses bolted on a joint
    band, and a bearing pad the girder actually sits on. The light channel is set into a
    rebate on the lane face, because a gate is lit from where the traffic comes from."""
    x = sgn * LEG_X
    place(rbox("plinth%g" % sgn, 4.0, 3.30, 0.78, (x, 0, PLINTH_H / 2), None,
               bevel_r=0.06, segs=3), "gate_cast")
    place(rbox("kerb%g" % sgn, 4.34, 3.64, 0.20, (x, 0, 0.10), None, bevel_r=0.045,
               segs=2), "gate_cast")
    for i in range(COURSES):
        w, d = 2.90 - i * 0.22, 2.50 - i * 0.16
        y = PLINTH_H + i * COURSE + COURSE / 2
        place(rbox("course%g_%d" % (sgn, i), w, d, COURSE - 0.14, (x, 0, y), None,
                   bevel_r=0.055, segs=3), "gate_cast")
        if i < COURSES - 1:
            place(rbox("joint%g_%d" % (sgn, i), w + 0.16, d + 0.16, 0.15,
                       (x, 0, y + (COURSE - 0.14) / 2), None, bevel_r=0.03,
                       segs=2), "gate_metal")
            for cxx in (-1, 1):
                for cyy in (-1, 1):
                    place(cyl("bolt%g_%d_%s%s" % (sgn, i, cxx, cyy), 0.045, 0.06,
                              (x + cxx * (w / 2 - 0.16), cyy * (d / 2 + 0.06),
                               y + (COURSE - 0.14) / 2), None,
                              rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "gate_metal")
    place(rbox("bearing%g" % sgn, 2.20, 2.00, 0.34, (x, 0, BEAM_Y - 0.17), None,
               bevel_r=0.04, segs=2), "gate_dark")
    # the lane-facing channel, sunk into the shaft rather than stuck on it
    place(rbox("channel%g" % sgn, 0.16, 0.44, COURSES * COURSE - 1.10,
               (x - sgn * 1.30, 0, PLINTH_H + (COURSES * COURSE) / 2 - 0.20), None,
               bevel_r=0.03, segs=2), "channel")
    for i in range(4):
        place(rbox("chan_brk%g_%d" % (sgn, i), 0.30, 0.50, 0.16,
                   (x - sgn * 1.28, 0, PLINTH_H + 0.9 + i * 2.0), None, bevel_r=0.025,
                   segs=1), "gate_metal")
    # service mast up the landside of each leg, with its cable clamps
    place(cyl("mast%g" % sgn, 0.13, COURSES * COURSE + 0.40,
              (x + sgn * 1.35, 0.95, PLINTH_H + (COURSES * COURSE) / 2), None, verts=14,
              br=0.0), "gate_metal")
    for t in (0.6, 3.1, 5.6, 8.1):
        place(cyl("clamp%g_%g" % (sgn, t), 0.21, 0.18,
                  (x + sgn * 1.35, 0.95, PLINTH_H + t), None, verts=14, br=0.02), "gate_dark")
    place(limb("feeder%g" % sgn, [(x + sgn * 1.35, 0.95, PLINTH_H + 0.8),
                                  (x + sgn * 1.10, 1.05, PLINTH_H + 4.0),
                                  (x + sgn * 1.35, 0.95, PLINTH_H + 8.6)],
               0.055, 0.055, None, steps=14, verts=10, mod=folds(15, 0.14)), "rub")
    for i in range(3):                          # hazard chevrons on the kerb face
        c = rbox("chevron%g_%d" % (sgn, i), 0.50, 0.10, 0.62,
                 (x - sgn * 1.90, -1.83, 0.42), None, bevel_r=0.02, segs=1)
        c.rotation_euler = (0, 0, 0.62 * (1 if i % 2 else -1))
        place(c, "hazard" if i % 2 else "gate_dark")
    # the ladder that gets somebody up there, and its cage hoops
    for i in range(9):
        place(rbox("rung%g_%d" % (sgn, i), 0.05, 0.34, 0.045,
                   (x + sgn * 1.62, 1.30, PLINTH_H + 0.5 + i * 0.95), None,
                   bevel_r=0.012, segs=1), "gate_metal")
    for i in range(3):
        place(torus("hoop%g_%d" % (sgn, i), (x + sgn * 1.62, 1.30, PLINTH_H + 1.4 + i * 2.6),
                    (0, 0, 1), (0, 1, 0), 0.34, 0.022, None, maj=14, mino=5), "gate_metal")


def girder():
    """Two chords with verticals front and back, soffit joists under the deck plate, and a
    recessed service panel: a driver passes under this, so the underside is the face that
    has to be true."""
    for i, y in enumerate((BEAM_Y + 0.22, BEAM_Y + 2.44)):
        place(rbox("chord%d" % i, 20.90, 2.00, 0.44, (0, 0, y), None, bevel_r=0.05,
                   segs=2), "gate_metal")
    for i in range(9):
        px = -9.8 + i * 2.45
        for sgn in (-1, 1):
            place(rbox("vert%d_%s" % (i, sgn), 0.28, 0.34, 1.78, (px, sgn * 0.82,
                      BEAM_Y + 1.33), None, bevel_r=0.028, segs=1), "gate_metal")
    place(rbox("deck_plate", 21.20, 2.50, 0.18, (0, 0, BEAM_Y + 2.75), None,
               bevel_r=0.035, segs=2), "gate_metal")
    for i in range(10):
        place(rbox("joist%d" % i, 0.20, 2.34, 0.46, (-10.0 + i * 2.22, 0, BEAM_Y + 2.44),
                   None, bevel_r=0.022, segs=1), "gate_metal")
    place(rbox("service_panel", 20.40, 1.55, 0.10, (0, 0, BEAM_Y + 2.20), None,
               bevel_r=0.02, segs=1), "panel")
    for sgn in (-1, 1):
        place(cyl("conduit%g" % sgn, 0.07, 20.40, (0, sgn * 0.95, BEAM_Y + 2.32),
                  None, rot=(0, math.pi / 2, 0), verts=10, br=0.0), "gate_dark")
    for i in range(7):
        px = -9.1 + i * 3.04
        place(cone("downlight%d" % i, 0.21, 0.17, 0.16, (px, 0, BEAM_Y + 2.10), None,
                   verts=14, br=0.015), "gate_dark")
        place(cyl("downlight_lens%d" % i, 0.15, 0.035, (px, 0, BEAM_Y + 2.01), None,
                  verts=14, br=0.0), "flood")
    # catwalk along the top: posts and a two-rail fence either side of the lane
    for i in range(11):
        px = -10.4 + i * 2.08
        for sgn in (-1, 1):
            place(cyl("post%d_%s" % (i, sgn), 0.055, 1.05,
                      (px, sgn * 1.12, BEAM_Y + 3.36), None, verts=10, br=0.0), "gate_dark")
    for sgn in (-1, 1):
        for yy, h in ((sgn * 1.12, BEAM_Y + 3.83), (sgn * 1.12, BEAM_Y + 3.28)):
            place(cyl("handrail%g_%g" % (sgn, h), 0.055, 20.90, (0, yy, h), None,
                      rot=(0, math.pi / 2, 0), verts=10, br=0.0), "gate_dark")
    # the sign boards the name is painted on, and the bolts they clamp with
    for sgn in (-1, 1):
        place(rbox("sign%g" % sgn, 13.40, 0.30, 2.70, (0, sgn * 1.15, BEAM_Y + 1.40),
                   None, bevel_r=0.045, segs=2), "panel")
        for bx in (-6.2, 6.2):
            place(cyl("sign_bolt%g_%g" % (sgn, bx), 0.09, 0.34, (bx, sgn * 1.40,
                      BEAM_Y + 1.40), None, rot=(math.pi / 2, 0, 0), verts=12,
                      br=0.012), "gate_metal")
    # beam-top kit: a junction cabinet and an antenna mast
    for (bx, bw) in ((-6.4, 3.4), (6.6, 2.2)):
        place(rbox("kit_%g" % bx, bw, 1.90, 1.30, (bx, 0, BEAM_Y + 3.50), None,
                   bevel_r=0.055, segs=3), "gate_cast")
        place(rbox("kit_sill_%g" % bx, bw + 0.18, 2.10, 0.16, (bx, 0, BEAM_Y + 2.86),
                   None, bevel_r=0.03, segs=1), "gate_metal")
        place(rbox("kit_door_%g" % bx, 0.14, 1.94, 1.32, (bx, 0, BEAM_Y + 3.50), None,
                   bevel_r=0.02, segs=1), "hazard")
    place(cone("antenna", 0.12, 0.09, 3.40, (9.6, 0, BEAM_Y + 4.60), None, verts=12,
               br=0.01), "gate_metal")
    # approach floods under the girder, aimed at the lane
    for i in range(4):
        fx = -6.3 + i * 4.2
        h = rbox("flood%d" % i, 0.62, 0.86, 0.44, (fx, 0, BEAM_Y - 0.24), None,
                 bevel_r=0.04, segs=2)
        h.rotation_euler = (0.5, 0, 0)
        place(h, "gate_dark")
        place(cyl("flood_lens%d" % i, 0.26, 0.06, (fx, 0.19, BEAM_Y - 0.36), None,
                  rot=(math.pi / 2 - 0.5, 0, 0), verts=14, br=0.0), "flood")


def build_gate():
    purge()
    PARTS.clear()
    root = empty("spaceport_gate")
    for sgn in (-1, 1):
        pylon(sgn)
    girder()
    for o in PARTS:
        o.parent = root
    root["span"] = 20.9
    root["height"] = BEAM_Y + 6.4
    return root


if __name__ == "__main__":
    export(build_gate(), "spaceport_gate.glb")
    print("GATE_DONE")
