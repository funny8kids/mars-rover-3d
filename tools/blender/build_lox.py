# Blender builder for the pad's LOX stand — the cryo drum that feeds the launch mount, on
# its bund, its four-leg cage, and the transfer line bridged out to a distribution manifold.
#
# The runtime version was a dozen cylinders and boxes plus a TubeGeometry along a curve;
# this is one authored asset. The line is baked in local space along the real bearing to
# the pad, because a cryo transfer line is laid once and then lives where it was welded.
#
# Local frame: origin at the centre of the bund on the ground, z up.
#
# The glTF exporter turns this z-up frame into the app's y-up one by mapping builder +y onto
# app-space -z. A bearing written in world terms therefore lands mirrored on export, so every
# offset below is stated in BUILDER metres, i.e. negate the world z before writing it.
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

MOUNT_DX, MOUNT_DY_APP = -6.0, 12.0    # the launch mount, app metres from the bund centre
RUN = 5.7          # where the line lands, measured along that bearing from the bund
_u = RUN / math.hypot(MOUNT_DX, MOUNT_DY_APP)
PAD_DX, PAD_DY = MOUNT_DX * _u, -MOUNT_DY_APP * _u    # builder metres (see the frame note)

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

    # ── the transfer line: a gooseneck off the vessel's top nozzle, then a pipe bridge over the
    #    apron to the pad manifold, sagging between its trestles and clamped where it crosses them ─
    # The deck of this bridge is set by the vehicle, not by a person standing under it. Collision
    # here is a set of ground discs with no vertical dimension, so the only honest heights are
    # "above everything the rover carries" or "marked with discs at grade". Parked on this pad with
    # the suspension settled, the rover measures 2.63 m wheel-to-camera-mast and its mast tip sits
    # 2.72 m over the grade it stands on (read off phys.groundY at the stand, mid-span and terminal:
    # all 0.60, the apron is one flat pour). A line at 2.2-2.55 m — which is what this asset used to
    # carry, argued as "head height" — is therefore geometry the mast drives straight through, not
    # geometry it passes under. The exported span's lowest underside outside the bund is 3.945 m.
    # RUN stops at 5.7 m of the 13.4 m bearing rather than at the vehicle because the audit reads
    # one 6.5 m disc around the mount (lot('starship', …, 9.2, 9.2) circumscribes to 6.505). A post
    # on the mount would sit inside that disc with a negative gap — a raw overlap, which is the
    # shape that gives a rover two push-outs fighting each other. At 5.7 m the terminal's own
    # 1.15 m concrete pad circumscribes to 0.813 m and leaves 0.40 m of daylight, and the line ends
    # on a distribution manifold, which is where a cryo feed actually terminates: the pad's own
    # umbilicals take it from there to the vehicle.
    CLIMB, Z_NOZ, Z_TOP, SAG = 0.22, 2.62, 4.32, 0.30
    pts = []
    for i in range(19):
        t = i / 18
        if t <= CLIMB:
            # u**0.45 sends the first sample straight up off the nozzle instead of diagonally:
            # a top nozzle has a riser, and a line that leaves it sideways is the tell.
            z = Z_NOZ + (Z_TOP - Z_NOZ) * (t / CLIMB) ** 0.45
        else:
            z = Z_TOP - SAG * math.sin((t - CLIMB) / (1 - CLIMB) * math.pi)
        pts.append(Vector((PAD_DX * t, PAD_DY * t, z)))
    place(limb("transfer", pts, 0.075, 0.075, None, steps=16, verts=12), "tap_soot")
    # A line clamped to nothing is a floating pipe. Each clamp sits on a stanchion down to grade on
    # its own baseplate, so the span sags between supports the way a welded cryo line does. Two posts
    # and the terminal give 5.7 m of bridge as spans of 1.6, 1.6 and 2.5 m: equal saddles off the
    # drum, and the one long approach where the line is landing on its own pad anyway — which is
    # also where a 75 mm cryo line wants its posts. The far post stops at t=0.55 rather than the
    # even-thirds t=0.67 because its ground drum then sits 3.50 m off the launch mount's disc
    # instead of 2.87 m, i.e. outside the audit's corridor, and a third post anywhere near t=0.86
    # would not be outside it at all.
    for t in (0.30, 0.55):
        i = int(round(t * 18))
        p = pts[i]
        place(cyl("clamp_%g" % t, 0.105, 0.09, (p.x, p.y, p.z), None, verts=12, br=0.015),
              "tap_iron")
        place(rbox("trestle_foot_%g" % t, 0.34, 0.34, 0.09, (p.x, p.y, 0.045), None,
                   bevel_r=0.022, segs=2), "tap_soot")

        # A 4 m column of 50 mm pipe is a flagpole. Real pipe-bridge trestles at that height are
        # lattices: four battered legs to a narrow head, hoops and X-bracing in the panels, and a
        # saddle the span lands on. The legs are `limb`s rather than rotated cylinders so the
        # batter is in the mesh, and there is no centre post any more — the first pass at this
        # left the original stanchion standing inside its own lattice, which is both a flagpole and
        # a tower, i.e. neither.
        # `inset` is where the leg axis is at a given height, and every hoop and brace is built
        # from it, so the bracing lands on the legs instead of floating inside the tower. That also
        # makes the reach provable rather than hoped for: the widest point of the whole structure
        # is the foot, fb plus the leg skin, hypot(0.130, 0.130) + 0.040 = 0.224 m, which is what
        # has to fit inside the 0.24 m drum the app circumscribes from the 0.34 m footplate. At the
        # fb=0.155 this first shipped with, the same figure is 0.259 m — six vertices of leg poking
        # 19 mm past the collider that is supposed to own them, in the band the rover's body
        # drives through.
        H = p.z - 0.045
        fb, ft = 0.130, 0.095
        inset = lambda h: fb + (ft - fb) * (h - 0.09) / (H - 0.09)
        # Ordered *around* the square, not by x then y: the hoop and brace loops below walk
        # consecutive pairs as faces, and a diagonal read as a face would cross the tower's own
        # opening twice.
        corners = [(-1, -1), (-1, 1), (1, 1), (1, -1)]
        for ci, (cx_, cz_) in enumerate(corners):
            place(limb("leg_%g_%d" % (t, ci),
                       [Vector((p.x + cx_ * fb, p.y + cz_ * fb, 0.09)),
                        Vector((p.x + cx_ * ft, p.y + cz_ * ft, H))], 0.040, 0.032, None,
                       steps=6, verts=8), "tap_iron")
        place(rbox("saddle_%g" % t, 0.30, 0.30, 0.055, (p.x, p.y, H - 0.0575), None,
                   bevel_r=0.018, segs=1), "tap_soot")   # top face tangent to the pipe's underside
        for hz in (0.62, 1.62, H - 0.55):
            hs = inset(hz)
            for ci, (cx_, cz_) in enumerate(corners):
                n = corners[(ci + 1) % 4]
                place(limb("hoop_%g_%d_%g" % (t, ci, hz),
                           [Vector((p.x + cx_ * hs, p.y + cz_ * hs, hz)),
                            Vector((p.x + n[0] * hs, p.y + n[1] * hs, hz))], 0.020, 0.020, None,
                           steps=2, verts=6), "tap_iron")
        # X in the two lower panels on all four faces; the top panel is where the pipe lands and
        # would only be in the way of its own saddle.
        for lo, hi in ((0.62, 1.62), (1.62, H - 0.55)):
            slo, shi = inset(lo), inset(hi)
            for ci in range(4):
                a, b = corners[ci], corners[(ci + 1) % 4]
                place(limb("brace_%g_%d_%g" % (t, ci, lo),
                           [Vector((p.x + a[0] * slo, p.y + a[1] * slo, lo)),
                            Vector((p.x + b[0] * shi, p.y + b[1] * shi, hi))], 0.016, 0.016, None,
                           steps=2, verts=6), "tap_iron")
                place(limb("brace_%g_%d_%g_b" % (t, ci, lo),
                           [Vector((p.x + b[0] * slo, p.y + b[1] * slo, lo)),
                            Vector((p.x + a[0] * shi, p.y + a[1] * shi, hi))], 0.016, 0.016, None,
                           steps=2, verts=6), "tap_iron")
        # With the centre post gone, the span reaches the tower through the saddle, so the saddle
        # has to be tied to the clamp it sits under. Four gussets from the saddle's corners to
        # tangency on the clamp's barrel (0.105 m; foot at hypot(0.125, 0.125) = 0.177 m, inside
        # the saddle's own 0.212 m corner).
        for ci, (cx_, cz_) in enumerate(corners):
            place(limb("gusset_%g_%d" % (t, ci),
                       [Vector((p.x + cx_ * 0.125, p.y + cz_ * 0.125, H - 0.030)),
                        Vector((p.x + cx_ * 0.075, p.y + cz_ * 0.075, H + 0.060))], 0.016, 0.014,
                       None, steps=2, verts=6), "tap_iron")

    # ── the pad manifold the run terminates on: a down-comer into a valve chest on its own
    #    concrete pad, with the two cross-branches left blind-flanged (the umbilicals are the
    #    mount's, not this stand's) ──────────────────────────────────────────────────
    ex, ey = PAD_DX, PAD_DY
    place(rbox("mana_pad", 1.15, 1.15, 0.14, (ex, ey, 0.07), None, bevel_r=0.03, segs=2),
          "stand_cast")
    place(rbox("mana_chest", 0.80, 0.80, 0.62, (ex, ey, 0.45), None, bevel_r=0.05, segs=3),
          "tap_iron")
    place(cyl("downcomer", 0.085, Z_TOP - 0.76, (ex, ey, (Z_TOP + 0.76) / 2), None, verts=12,
              br=0.018), "tap_iron")
    place(torus("downcomer_flange", (ex, ey, Z_TOP - 0.14), (0, 0, 1), (1, 0, 0), 0.13, 0.04, None,
                maj=16, mino=5), "tap_iron")
    pa = math.atan2(pts[-1].y, pts[-1].x) + math.pi / 2      # branches leave across the run
    for s in (-1, 1):
        place(cyl("branch_%+d" % s, 0.115, 0.34,
                  (ex + math.cos(pa) * 0.52 * s, ey + math.sin(pa) * 0.52 * s, 0.45), None,
                  rot=(math.pi / 2, 0, pa), verts=14, br=0.012), "tap_soot")
        place(torus("blind_%+d" % s, (ex + math.cos(pa) * 0.69 * s, ey + math.sin(pa) * 0.69 * s,
                    0.45), (math.cos(pa), math.sin(pa), 0), (0, 0, 1), 0.14, 0.035, None,
                    maj=16, mino=5), "tap_iron")
    place(cyl("mana_wheel", 0.19, 0.055, (ex, ey, 0.83), None, verts=16, br=0.012), "hazard")
    place(cyl("mana_stem", 0.04, 0.16, (ex, ey, 0.78), None, verts=8, br=0.0), "tap_iron")
    # A 150 mm dial bolted to nothing is the same tell as a pipe clamped to nothing, and it was:
    # the gauge used to hang at 0.62 m on a point scaled off the pad's own centre, 2.2 m from any
    # support, in the band the rover drives through. It rides the riser above the chest it reads
    # now — which is where a manifold gauge actually is, at waist height for the operator standing
    # on the apron — and its outermost point is 0.275 m off the riser's axis against the 0.813 m
    # disc that terminal's pad circumscribes to, so the open apron the discs claim is open for real.
    gx, gy = math.cos(pa), math.sin(pa)
    place(cyl("mana_stub", 0.022, 0.09, (ex + gx * 0.11, ey + gy * 0.11, 1.30), None,
              rot=(math.pi / 2, 0, pa), verts=8, br=0.0), "tap_iron")
    place(cyl("mana_gauge", 0.11, 0.05, (ex + gx * 0.165, ey + gy * 0.165, 1.30), None,
              rot=(math.pi / 2, 0, pa), verts=14, br=0.012), "tap_iron")

    for o in PARTS:
        o.parent = root
    root["diameter"] = 3.5
    root["height"] = 4.4   # the export tops out at 4.393, on the sag span's own crown
    return root


if __name__ == "__main__":
    export(build_stand(), "lox_stand.glb")
    print("LOX_DONE")
