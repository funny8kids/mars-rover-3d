# Blender builder for the Roadster — the easter egg parked against the crater rim, and the
# one object on the island that has to be recognised as a *car* rather than as a red brick.
#
# The runtime version was five boxes, four cylinders and a capsule. This lofts the body
# through eleven rounded sections along its length, so the nose drops, the shoulders rise
# and the tail kicks up the way a Roadster's do; the greenhouse is a second, narrower loft
# with the glass set into it; the wheels are crowned tyres on spoked rims in arches; and
# Starman is built the way the crew are — swept limbs, a shelled helmet, a gold visor.
#
# Local frame: origin at the centre of the wheelbase on the ground, width along X, the nose
# toward +Y, height up Z.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_roadster.py
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
for k in ("car_paint", "car_trim", "car_rim"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                        metal={"car_paint": 0.55, "car_trim": 0.30, "car_rim": 0.9}[k]),
                 d["v_m"])

FLAT = {
    "tyre":    mat("car_tyre", (0.035, 0.034, 0.033), rough=0.94, metal=0.02),
    "glass":   mat("car_glass", (0.045, 0.06, 0.075), rough=0.05, metal=0.4, alpha=0.55),
    "lamp":    mat("light_car_lamp", (0.30, 0.24, 0.10), rough=0.25, metal=0.1,
                   emis=(1.0, 0.86, 0.55), estr=0.9),
    "tail":    mat("light_car_tail", (0.26, 0.045, 0.03), rough=0.3, metal=0.1,
                   emis=(1.0, 0.14, 0.08), estr=0.8),
    "suit":    mat("car_suit", (0.72, 0.70, 0.66), rough=0.62, metal=0.05),
    "visor":   mat("car_visor", (0.55, 0.36, 0.09), rough=0.12, metal=1.0),
    "carbon":  mat("car_carbon", (0.055, 0.055, 0.06), rough=0.36, metal=0.35),
}

PARTS = []


def place(o, key):
    o.data.materials.clear()
    if key in MAPPED:
        m, tile = MAPPED[key]
        o.data.materials.append(m)
        uv_cube(o, tile)
    else:
        o.data.materials.append(FLAT[key])
    PARTS.append(o)
    return o


def section(hw, zlo, zhi, cr, n=5):
    """A rounded-rect car section: half-width, floor height, roof height, corner radius.
    The four corner arcs are walked in order so the ring closes without a twisted edge."""
    cr = max(0.005, min(cr, hw * 0.9, (zhi - zlo) * 0.45))
    zc, hz = (zlo + zhi) / 2.0, (zhi - zlo) / 2.0
    pts = []
    for step in range(4):
        sgn_x, sgn_z = ((1, 1), (-1, 1), (-1, -1), (1, -1))[step]
        cx, cz = sgn_x * (hw - cr), zc + sgn_z * (hz - cr)
        for i in range(n + 1):
            a = (step + i / n) * (math.pi / 2)
            pts.append((cx + math.cos(a) * cr, cz + math.sin(a) * cr))
    return pts


def loft(name, stations, m_key, close=True, shade=42):
    """Bridge a chain of (y, section) stations into a closed body — the only way to get a
    car's shoulder line without resorting to a bevelled brick."""
    bm = bmesh.new()
    rows = [[bm.verts.new(Vector((px, y, pz))) for (px, pz) in sec] for (y, sec) in stations]
    np_ = len(stations[0][1])
    for j in range(len(stations) - 1):
        for i in range(np_):
            bm.faces.new((rows[j][i], rows[j][(i + 1) % np_],
                          rows[j + 1][(i + 1) % np_], rows[j + 1][i]))
    bm.faces.new(list(reversed(rows[0])))
    bm.faces.new(rows[-1])
    return mesh_obj(name, bm, None, shade)


def body_station(y, hw, zlo, zhi, cr=0.16):
    return (y, section(hw, zlo, zhi, cr))


def build_roadster():
    purge()
    PARTS.clear()
    root = empty("roadster")

    # ── the lower body: one loft from the nose to the tail ───────────────────────
    st = [body_station(-2.34, 0.52, 0.34, 0.62, 0.14),
          body_station(-2.16, 0.72, 0.30, 0.70, 0.18),
          body_station(-1.70, 0.84, 0.28, 0.76, 0.20),
          body_station(-1.05, 0.90, 0.26, 0.80, 0.22),
          body_station(-0.30, 0.93, 0.25, 0.83, 0.24),
          body_station(0.45, 0.94, 0.25, 0.84, 0.24),
          body_station(1.20, 0.92, 0.27, 0.83, 0.22),
          body_station(1.78, 0.86, 0.30, 0.80, 0.20),
          body_station(2.16, 0.74, 0.34, 0.74, 0.16),
          body_station(2.34, 0.56, 0.38, 0.62, 0.12)]
    place(loft("body", st, None), "car_paint")

    # ── the greenhouse: a narrower loft sitting on the shoulder line ──────────────
    cab = [body_station(-0.62, 0.60, 0.84, 0.92, 0.10),
           body_station(-0.30, 0.66, 0.86, 1.16, 0.16),
           body_station(0.24, 0.68, 0.86, 1.24, 0.16),
           body_station(0.78, 0.64, 0.86, 1.20, 0.14),
           body_station(1.16, 0.54, 0.86, 1.00, 0.12),
           body_station(1.30, 0.48, 0.86, 0.90, 0.08)]
    place(loft("cabin", cab, None), "car_paint")
    # the glass: a slightly smaller loft, so the pillars stay painted
    gl = [(y - 0.02, [(px * 1.03, pz + 0.016) for (px, pz) in sec]) for (y, sec) in cab]
    place(loft("glass", gl, None), "glass")

    # ── sills, splitter and diffuser: the black that makes a car look low ─────────
    place(rbox("sill_l", 0.10, 2.30, 0.14, (0.90, -0.05, 0.30), None, bevel_r=0.035,
               segs=2), "carbon")
    place(rbox("sill_r", 0.10, 2.30, 0.14, (-0.90, -0.05, 0.30), None, bevel_r=0.035,
               segs=2), "carbon")
    place(rbox("splitter", 1.42, 0.30, 0.05, (0, -2.30, 0.24), None, bevel_r=0.018,
               segs=1), "carbon")
    place(rbox("diffuser", 1.30, 0.34, 0.12, (0, 2.30, 0.30), None, bevel_r=0.025,
               segs=1, rot=(0.18, 0, 0)), "carbon")
    for x in (-0.44, 0, 0.44):
        place(rbox("strake%d" % x, 0.05, 0.30, 0.11, (x, 2.28, 0.31), None, bevel_r=0.012,
                   segs=1), "carbon")
    place(rbox("spoiler", 1.24, 0.24, 0.045, (0, 2.06, 0.90), None, bevel_r=0.016, segs=1,
               rot=(-0.12, 0, 0)), "carbon")
    for x in (-0.52, 0.52):
        place(rbox("spoil_stay%d" % x, 0.05, 0.16, 0.16, (x, 2.12, 0.82), None,
                   bevel_r=0.014, segs=1), "carbon")

    # ── the wheels: crowned tyres on a five-spoke rim, in a rolled arch ───────────
    for (wx, wy) in ((0.92, -1.50), (-0.92, -1.50), (0.92, 1.55), (-0.92, 1.55)):
        s = 1 if wx > 0 else -1
        ty = limb("tyre_%g_%g" % (wx, wy), [(wx - s * 0.19, wy, 0.42), (wx, wy, 0.42),
                                            (wx + s * 0.19, wy, 0.42)],
                  [0.36, 0.42, 0.36], [0.36, 0.42, 0.36], None, steps=5, verts=24, shade=46)
        place(ty, "tyre")
        rim = cyl("rim_%g_%g" % (wx, wy), 0.26, 0.30, (wx + s * 0.05, wy, 0.42), None,
                  rot=(0, math.pi / 2, 0), verts=22, br=0.02)
        place(rim, "car_rim")
        hub = cyl("hub_%g_%g" % (wx, wy), 0.09, 0.36, (wx + s * 0.05, wy, 0.42), None,
                  rot=(0, math.pi / 2, 0), verts=14, br=0.015)
        place(hub, "car_trim")
        for i in range(5):
            a = i / 5 * TAU
            place(rbox("spoke_%g_%g_%d" % (wx, wy, i), 0.16, 0.075, 0.24,
                       (wx + s * 0.06, wy + math.cos(a) * 0.13, 0.42 + math.sin(a) * 0.13),
                       None, bevel_r=0.02, segs=1, rot=(a, 0, 0)), "car_rim")
        arch = band("arch_%g_%g" % (wx, wy), (wx, wy, 0.42), (1, 0, 0), (0, 1, 0),
                    0.50, 0.30, 0.035, None, arc=2.6, nseg=22, center_dir=(0, 0, 1))
        place(arch, "car_trim")

    # ── lamps, mirrors, glass and the shut lines that make it a car and not a blob ─
    for x in (-0.62, 0.62):
        place(rbox("headlamp_x%g" % x, 0.30, 0.10, 0.13, (x, -2.24, 0.60), None,
                   bevel_r=0.035, segs=2, rot=(0, 0, 0)), "lamp")
        place(rbox("tail_x%g" % x, 0.34, 0.08, 0.11, (x, 2.26, 0.68), None, bevel_r=0.03,
                   segs=2), "tail")
    for x in (-0.98, 0.98):
        place(rbox("mirror_x%g" % x, 0.16, 0.10, 0.09, (x, -0.42, 0.96), None,
                   bevel_r=0.025, segs=2), "carbon")
        place(cyl("mirror_stay_x%g" % x, 0.02, 0.16, (x * 0.94, -0.42, 0.94), None,
                  rot=(0, math.pi / 2, 0), verts=8, br=0.0), "car_trim")
    # door and hood shut lines: thin recessed bands, because a panel gap is a gap
    for (nm, y, w, h) in (("hood", -1.52, 1.60, 0.012), ("deck", 1.42, 1.52, 0.012)):
        place(rbox("line_%s" % nm, w, 0.022, h, (0, y, 0.80), None, bevel_r=0.006,
                   segs=1), "car_trim")
    for x in (-0.90, 0.90):
        place(rbox("line_door_x%g" % x, 0.02, 1.28, 0.012, (x, 0.16, 0.62), None,
                   bevel_r=0.005, segs=1), "car_trim")
        place(rbox("handle_x%g" % x, 0.03, 0.20, 0.045, (x * 1.005, -0.34, 0.66), None,
                   bevel_r=0.012, segs=1), "car_rim")
    place(rbox("grille", 0.86, 0.06, 0.16, (0, -2.33, 0.44), None, bevel_r=0.025,
               segs=1), "carbon")
    # charge port and its hinge — the one detail that says this car is not on petrol
    place(cyl("port", 0.11, 0.05, (-0.86, -1.16, 0.80), None, rot=(0, math.pi / 2, 0),
              verts=16, br=0.012), "car_trim")

    # ── Starman: swept limbs in the driver's seat, gold visor to the rim ──────────
    seat = Vector((0.42, 0.10, 0.86))
    place(limb("star_torso", [seat + Vector((0, 0, 0.02)), seat + Vector((0, -0.04, 0.40))],
               [0.20, 0.19], [0.24, 0.22], None, steps=6, verts=18,
               mod=folds(5, 0.07)), "suit")
    place(ball("star_helm", 0.155, seat + Vector((0, -0.05, 0.58)), None, segs=22,
               rings=14), "suit")
    vis = ball("star_visor", 0.152, seat + Vector((0, -0.075, 0.575)), None, segs=18,
               rings=12, scale=(0.98, 0.78, 0.74))
    place(vis, "visor")
    for sgn, tag in ((-1, "l"), (1, "r")):
        place(limb("star_leg_%s" % tag,
                   [seat + Vector((sgn * 0.10, 0.02, -0.06)),
                    seat + Vector((sgn * 0.11, -0.34, -0.10)),
                    seat + Vector((sgn * 0.11, -0.62, -0.34))],
                   [0.085, 0.075, 0.06], [0.09, 0.08, 0.055], None, steps=8, verts=14),
              "suit")
        place(limb("star_arm_%s" % tag,
                   [seat + Vector((sgn * 0.19, -0.02, 0.30)),
                    seat + Vector((sgn * 0.24, -0.24, 0.16)),
                    seat + Vector((sgn * 0.16, -0.44, 0.10))],
                   [0.065, 0.055, 0.045], [0.07, 0.06, 0.05], None, steps=8, verts=14),
              "suit")

    for o in PARTS:
        o.parent = root
    root["length"] = 4.7
    root["width"] = 2.0
    root["height"] = 1.3
    return root


if __name__ == "__main__":
    export(build_roadster(), "roadster.glb")
    print("ROADSTER_DONE")
