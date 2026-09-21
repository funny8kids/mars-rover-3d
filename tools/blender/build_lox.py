# Blender builder for the pad's LOX stand — the cryo drum that feeds the launch mount, on
# its bund, its four-leg cage and the transfer line slung out toward the flame deck.
#
# The runtime version was a dozen cylinders and boxes plus a TubeGeometry along a curve;
# this is one authored asset. The line is baked in local space along the real bearing to
# the pad, because a cryo transfer line is laid once and then lives where it was welded.
#
# Local frame: origin at the centre of the bund on the ground, z up.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_lox.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, img, textures, uv_cube, rbox, ball, cyl, cone,
                    torus, band, shell, limb, folds, lobes, ramp, chain, empty, parent,
                    purge, export, bool_op, smooth_angle, bevel, mesh_obj, solidify, join,
                    apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

PAD_DX, PAD_DY = -6.0, 12.0     # where the flame deck sits, in this stand's own metres

MAPPED = {}
for k in ("stand_cryo", "stand_cast", "tap_iron", "tap_soot"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                        metal={"stand_cryo": 0.88, "stand_cast": 0.06,
                               "tap_iron": 0.86, "tap_soot": 0.45}[k]), d["v_m"])

FLAT = {
    "hazard": mat("stand_hazard", (0.34, 0.10, 0.045), rough=0.7, metal=0.06),
    "glass":  mat("stand_glass", (0.06, 0.07, 0.08), rough=0.1, metal=0.4, alpha=0.6),
}

PARTS = []


def place(o, key):
    m, tile = MAPPED[key] if key in MAPPED else (None, None)
    o.data.materials.clear()
    if m:
        o.data.materials.append(m)
        uv_cube(o, tile)
    else:
        o.data.materials.append(FLAT[key])
    PARTS.append(o)
    return o


def build_stand():
    purge()
    PARTS.clear()
    root = empty("lox_stand")

    # ── the bund: a poured saucer with a drain lip, not a disc ───────────────────
    place(cone("bund", 1.55, 1.72, 0.22, (0, 0, 0.11), None, verts=32, br=0.045), "stand_cast")
    place(torus("bund_lip", (0, 0, 0.22), (0, 0, 1), (1, 0, 0), 1.66, 0.055, None, maj=40,
                mino=6), "stand_cast")
    place(cyl("sump", 0.19, 0.10, (0.95, -0.75, 0.215), None, verts=14, br=0.02), "tap_soot")

    # ── the drum: a welded pressure vessel with its hoops, saddles and relief line ──
    place(cyl("shell", 0.62, 1.90, (0, 0, 1.19), None, verts=28, br=0.05), "stand_cryo")
    place(ball("dome_lo", 0.62, (0, 0, 2.14), None, segs=26, rings=14,
               scale=(1, 1, 0.52)), "stand_cryo")
    place(cyl("skirt", 0.66, 0.30, (0, 0, 0.36), None, verts=28, br=0.03), "stand_cryo")
    for yy in (0.56, 1.29, 1.96):
        place(torus("hoop_%g" % yy, (0, 0, yy), (0, 0, 1), (1, 0, 0), 0.665, 0.045, None,
                    maj=28, mino=6), "tap_iron")
    place(cyl("nozzle", 0.24, 0.42, (0, 0, 2.42), None, verts=18, br=0.02), "stand_cryo")
    place(torus("nozzle_flange", (0, 0, 2.60), (0, 0, 1), (1, 0, 0), 0.27, 0.05, None,
                maj=18, mino=6), "tap_iron")
    place(cyl("reliser", 0.055, 0.70, (0.30, 0.30, 2.45), None, verts=10, br=0.0), "tap_iron")
    place(ball("relief_head", 0.09, (0.30, 0.30, 2.82), None, segs=14, rings=10), "hazard")
    # the manhole the vessel is built through, and the ladder that reaches it
    place(cyl("manhole", 0.26, 0.07, (0, 0.63, 1.55), None, rot=(math.pi / 2, 0, 0),
              verts=20, br=0.015), "tap_iron")
    for i in range(6):
        place(rbox("mh_bolt%d" % i, 0.045, 0.05, 0.045,
                   (math.cos(i / 6 * TAU) * 0.215, 0.655, 1.55 + math.sin(i / 6 * TAU) * 0.215),
                   None, bevel_r=0.010, segs=1), "tap_soot")
    for i in range(5):
        place(rbox("rung_%d" % i, 0.30, 0.035, 0.035, (0, 0.70, 0.55 + i * 0.34), None,
                   bevel_r=0.010, segs=1), "tap_iron")
    for s in (-1, 1):
        place(cyl("rail_%s" % s, 0.022, 1.95, (s * 0.15, 0.71, 1.35), None, verts=8,
                  br=0.0), "tap_iron")

    # ── the cage: four legs, a ring beam at the top, and the walkway ring ──────────
    for i in range(4):
        a = i * math.tau / 4 + 0.79
        lx, ly = math.sin(a) * 1.12, math.cos(a) * 1.12
        place(cyl("leg%d" % i, 0.075, 2.90, (lx, ly, 1.69), None, verts=12, br=0.014),
              "tap_iron")
        place(rbox("foot%d" % i, 0.30, 0.30, 0.09, (lx, ly, 0.26), None, bevel_r=0.025,
                   segs=2), "tap_soot")
        place(rbox("brace%d" % i, 2.24, 0.10, 0.10, (lx, ly, 3.06), None, bevel_r=0.022,
                   segs=2, rot=(0, 0, a)), "tap_iron")
    place(torus("ring_beam", (0, 0, 3.10), (0, 0, 1), (1, 0, 0), 1.12, 0.06, None, maj=28,
                mino=6), "tap_iron")
    place(torus("guard", (0, 0, 3.62), (0, 0, 1), (1, 0, 0), 1.12, 0.035, None, maj=28,
                mino=5), "tap_soot")
    for i in range(8):
        a = i / 8 * TAU
        place(cyl("guard_post%d" % i, 0.022, 0.52, (math.sin(a) * 1.12, math.cos(a) * 1.12,
                  3.36), None, verts=8, br=0.0), "tap_soot")

    # ── the manifold: a valve chest on the drum's shoulder and its orange lockouts ──
    chest = rbox("manifold", 0.52, 0.44, 0.36, (0.98, -0.62, 0.86), None, bevel_r=0.045,
                 segs=3, rot=(0, 0, 0.80))
    place(chest, "tap_soot")
    place(rbox("valve", 0.15, 0.52, 0.15, (1.24, -0.78, 1.20), None, bevel_r=0.035, segs=2,
               rot=(0, 0, 0.80)), "hazard")
    place(cyl("gauge", 0.10, 0.05, (0.98, -0.90, 1.10), None, rot=(math.pi / 2, 0, 0.8),
              verts=14, br=0.012), "tap_iron")
    place(cyl("glass", 0.085, 0.02, (0.98, -0.93, 1.10), None, rot=(math.pi / 2, 0, 0.8),
              verts=14, br=0.0), "glass")

    # ── the transfer line: laid from the nozzle out to the flame deck, sagging
    #    between the two and clamped three times on the way ─────────────────────────
    pts = []
    for i in range(19):
        t = i / 18
        pts.append(Vector((PAD_DX * t, PAD_DY * t, 2.30 - t * 1.10 - math.sin(t * math.pi) * 0.75)))
    place(limb("transfer", pts, 0.075, 0.075, None, steps=16, verts=12), "tap_soot")
    for t in (0.30, 0.58, 0.84):
        i = int(round(t * 18))
        p = pts[i]
        place(cyl("clamp_%g" % t, 0.105, 0.09, (p.x, p.y, p.z), None, verts=12, br=0.015),
              "tap_iron")
    place(cyl("riser", 0.085, 1.05, (PAD_DX, PAD_DY, 0.55), None, verts=12, br=0.018),
          "tap_iron")
    place(torus("riser_flange", (PAD_DX, PAD_DY, 1.06), (0, 0, 1), (1, 0, 0), 0.13, 0.04,
                None, maj=16, mino=5), "tap_iron")

    for o in PARTS:
        o.parent = root
    root["diameter"] = 3.5
    root["height"] = 3.7
    return root


if __name__ == "__main__":
    export(build_stand(), "lox_stand.glb")
    print("LOX_DONE")
