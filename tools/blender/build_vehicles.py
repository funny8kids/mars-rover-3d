# Blender builders for the two vehicles of RED STARBASE's maintenance pit: the
# pressurised crew rover and the humanoid robot that services it. Both at their real
# dimensions in metres — 4.1 x 2.4 x 3.4 and 1.73 — because a humanoid's readability *is*
# its proportion, and a bot built on feel reads as a toy.
#
# What makes these models rather than assemblages: the wheels are crowned compliance drums
# lofted along their axles with curved cleats hugging the tread; the pressure hull is one
# sweep that closes itself into domes at both ends instead of a cylinder with two caps
# welded on; the rocker-bogie arms are tapered castings swept along a load path; and every
# panel gap, rivet line and atomised paint edge is a PBR field from rsbtex laid on UVs
# measured in metres, because a 6 mm seam modelled into a 4 m hull is only visible by
# flying through it.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_vehicles.py
import os, sys, math, bpy, bmesh
from mathutils import Vector, Euler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, mat_decal, img, textures, uv_cube, rbox, ball,
                    cyl, cone, torus, band, shell, limb, folds, lobes, ramp, chain, empty,
                    parent, purge, export, bool_op, smooth_angle, bevel, mesh_obj, solidify,
                    join, apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

# ── finishes ──────────────────────────────────────────────────────────────────────────
# Every mapped entry is (material, one repeat in metres): the second value is what the
# cube projection is scaled by, so a part's seams land where a real panel's would.
MAPPED = {}
for k in ("crew_paint", "crew_frame", "crew_metal", "crew_foil", "bot_shell", "bot_poly",
          "bot_joint"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                        metal={"crew_paint": 0.16, "crew_frame": 0.62, "crew_metal": 0.86,
                               "crew_foil": 0.72, "bot_shell": 0.06, "bot_poly": 0.22,
                               "bot_joint": 0.92}[k]), d["v_m"])

FLAT = {
    "rubber": mat("crew_rubber", (0.052, 0.049, 0.047), rough=0.94, metal=0.02),
    "pv":     mat("crew_pv", (0.019, 0.031, 0.072), rough=0.17, metal=0.62),
    "glass":  mat("crew_glass", (0.055, 0.075, 0.09), rough=0.06, metal=0.45, alpha=0.62),
    "lamp":   mat("light_crew_lamp", (0.30, 0.22, 0.09), rough=0.34, metal=0.1,
                  emis=(1.0, 0.78, 0.42), estr=1.3),
    "hazard": mat("crew_hazard", (0.42, 0.115, 0.035), rough=0.62, metal=0.1),
    "bot_glass": mat("bot_glass", (0.035, 0.05, 0.06), rough=0.05, metal=0.55, alpha=0.80),
    "bot_eye":   mat("light_bot_eye", (0.09, 0.15, 0.17), rough=0.3, metal=0.0,
                    emis=(0.62, 0.83, 0.91), estr=1.1),
    "bot_accent": mat("bot_accent", (0.10, 0.095, 0.10), rough=0.42, metal=0.30),
}

PARTS = []


def place(o, key):
    """Give a part its finish and the UVs that finish was authored for, and register it."""
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


def bolt_ring(tag, c, axis, ref, R, n, key="crew_metal", r=0.014, h=0.011):
    """The fasteners a panel is actually held on with, on the bolt circle inside its seam."""
    a = Vector(axis).normalized()
    u = Vector(ref).normalized().cross(a)
    if u.length < 1e-6:
        u = Vector((1, 0, 0)) if abs(a.z) < 0.9 else Vector((0, 1, 0))
    u.normalize()
    v = a.cross(u).normalized()
    for i in range(n):
        ang = i / n * TAU
        p = Vector(c) + (u * math.cos(ang) + v * math.sin(ang)) * R + a * h
        head = cyl(tag + "_bolt%d" % i, r, h * 2, p, None, verts=6, br=0.0)
        head.rotation_euler = a.to_track_quat('Z', 'Y').to_euler()
        place(head, key)


# ───────────────────────────────── crew rover ─────────────────────────────────
WR = 0.42                       # wheel radius
WY = 1.02                       # half-track
AXLE = Vector((0, 1, 0))


def wheel(tag, x, y):
    """A compliance drum: crowned along its axle so the contact patch is a footprint and
    not a knife edge, on a machined hub with its bolt circle, behind twelve curved cleats."""
    crown = [0.398, 0.408, 0.42, 0.408, 0.398]
    drum = limb(tag + "_drum", [(x, y - 0.16, WR), (x, y - 0.08, WR), (x, y, WR),
                                (x, y + 0.08, WR), (x, y + 0.16, WR)],
                crown, crown, None, steps=6, verts=30, shade=46)
    place(drum, "rubber")
    for i in range(12):
        a = i / 12 * TAU
        g = band(tag + "_cleat%d" % i, (x, y, WR), (0, 1, 0), (1, 0, 0), WR + 0.004, 0.295,
                 0.016, None, arc=0.20, nseg=40, center_dir=(math.cos(a), 0, math.sin(a)))
        place(g, "rubber")
    hub = cyl(tag + "_hub", 0.205, 0.34, (x, y, WR), None, rot=(math.pi / 2, 0, 0),
              verts=24, br=0.02)
    place(hub, "crew_metal")
    hubcap = cone(tag + "_cap", 0.13, 0.10, 0.05, (x, y + (0.19 if y > 0 else -0.19), WR),
                  None, rot=(-math.pi / 2 if y > 0 else math.pi / 2, 0, 0), verts=20, br=0.012)
    place(hubcap, "crew_metal")
    bolt_ring(tag, (x, y + (0.175 if y > 0 else -0.175), WR), (0, 1, 0), (1, 0, 0), 0.155,
              8, r=0.016, h=0.014)
    # the spoke web shows through a Mars wheel's open rim
    for i in range(5):
        a = i / 5 * math.pi
        spoke = rbox(tag + "_spoke%d" % i, 0.055, 0.30, 0.30, (x, y, WR), None,
                     bevel_r=0.02, segs=1, rot=(0, a, 0))
        place(spoke, "crew_metal")


def rocker(tag, side):
    """One side of the walking gear: a differential bellcrank at the middle wheel, a rocker
    forward to the nose and a bogie beam aft, all swept castings with the pivot bosses bored
    where the shafts actually go through."""
    x0 = 0.0
    pts = [(x0, side * 0.80, 0.90), (-0.62, side * 0.86, 0.74), (-1.45, side * WY, 0.44)]
    arm = limb(tag + "_rocker", pts, [0.075, 0.062, 0.052], [0.05, 0.048, 0.046], None,
               steps=10, verts=18, shade=44)
    place(arm, "crew_metal")
    bog = limb(tag + "_bogie", [(x0, side * 0.80, 0.90), (0.72, side * 0.86, 0.70),
                                (1.45, side * WY, 0.44)],
               [0.072, 0.060, 0.050], [0.048, 0.046, 0.044], None, steps=10, verts=18)
    place(bog, "crew_metal")
    for x in (-1.45, 0.0, 1.45):
        boss = cyl(tag + "_boss_x%g" % x, 0.075, 0.20, (x, side * (WY - 0.14), 0.44 if abs(x) > 1 else 0.44),
                   None, rot=(math.pi / 2, 0, 0), verts=18, br=0.012)
        boss.location.y = side * (WY - 0.13)
        boss.location.z = WR
        place(boss, "crew_frame")
    # the stub axle the middle wheel hangs off, and the steer yoke on the nose
    yoke = limb(tag + "_yoke", [(-1.45, side * 0.86, 0.52), (-1.45, side * WY, 0.44)],
                [0.055, 0.05], [0.055, 0.05], None, steps=4, verts=14)
    place(yoke, "crew_metal")
    steer = cyl(tag + "_steer", 0.045, 0.30, (-1.45, side * 0.90, 0.60), None, verts=14,
                br=0.01)
    place(steer, "crew_frame")


def build_rover():
    purge()
    PARTS.clear()
    root = empty("crew_rover")

    for x in (-1.45, 0.0, 1.45):
        for side in (1, -1):
            wheel("wh%g_%s" % (x, "p" if side > 0 else "n"), x, side * WY)
    for side in (1, -1):
        rocker("rk" + ("p" if side > 0 else "n"), side)
    # the differential bar the two rockers walk against each other through
    bar = cyl("diff_bar", 0.052, 2 * WY - 0.28, (0.0, 0, 0.90), None,
              rot=(math.pi / 2, 0, 0), verts=16, br=0.0)
    place(bar, "crew_metal")
    for x in (-0.75, 0.75):
        cross = cyl("cross_tube_x%g" % x, 0.05, 2 * WY - 0.2, (x, 0, 0.72), None,
                    rot=(math.pi / 2, 0, 0), verts=14, br=0.0)
        place(cross, "crew_frame")

    # ── chassis: a stressed deck on a frame rail, not a slab ─────────────────────
    deck = rbox("deck", 3.42, 1.74, 0.16, (0.0, 0, 1.06), None, bevel_r=0.035, segs=2)
    place(deck, "crew_frame")
    for z in (-1, 1):
        rail = rbox("rail_z%g" % z, 3.62, 0.11, 0.22, (0.0, z * 0.86, 0.98), None,
                    bevel_r=0.04, segs=2)
        place(rail, "crew_metal")
    for x in (-1.3, -0.4, 0.5, 1.3):
        fr = rbox("web_x%g" % x, 0.09, 1.66, 0.19, (x, 0, 1.0), None, bevel_r=0.02, segs=1)
        place(fr, "crew_frame")

    # ── the pressurised hull: one sweep that closes into its own end domes ────────
    hull = limb("hull", [(-1.62, 0, 1.72), (-1.28, 0, 1.72), (0.0, 0, 1.72),
                         (1.28, 0, 1.72), (1.62, 0, 1.72)],
                [0.30, 0.63, 0.66, 0.63, 0.30], [0.30, 0.63, 0.66, 0.63, 0.30], None,
                steps=14, verts=34, shade=48)
    place(hull, "crew_paint")
    for x in (-1.16, -0.42, 0.34, 1.08):                       # pressure ribs
        rib = band("rib_x%g" % x, (x, 0, 1.72), (1, 0, 0), (0, 1, 0), 0.672, 0.085, 0.022,
                   None, arc=TAU, nseg=44)
        place(rib, "crew_metal")
    stringer = band("stringer", (0.0, 0, 1.72), (1, 0, 0), (0, 0, 1), 0.668, 0.10, 0.02,
                    None, arc=0.5, nseg=44, center_dir=(0, 0, 1))
    place(stringer, "crew_metal")
    for z in (-1, 1):                                          # the dust splash line
        skirt = band("skirt_z%g" % z, (0.0, 0, 1.72), (1, 0, 0), (0, 0, 1), 0.678,
                     2.30, 0.020, None, arc=1.15, nseg=44,
                     center_dir=(0, z, -0.72))
        place(skirt, "crew_foil")

    # ── cupola, portholes and the airlock ────────────────────────────────────────
    cup = ball("cupola_glass", 0.50, (0.62, 0, 2.14), None, segs=30, rings=16,
               scale=(1, 1, 0.94))
    bool_op(cup, rbox("cut", 2.0, 2.0, 1.2, (0.62, 0, 1.53), None, bevel_r=None, segs=1))
    cup.name = "cupola_glass"
    place(cup, "glass")
    coam = cyl("cupola_coaming", 0.512, 0.075, (0.62, 0, 2.145), None, verts=28, br=0.012)
    place(coam, "crew_metal")
    for i in range(4):                                         # mullions over the glass
        a = i / 4 * math.pi
        mull = band("mullion%d" % i, (0.62, 0, 2.14), (0, 0, 1), (1, 0, 0), 0.505, 0.52,
                    0.022, None, arc=0.78, nseg=30, center_dir=(math.cos(a), math.sin(a), 0.4))
        place(mull, "crew_metal")
    for z in (-1, 1):
        for x in (-1.05, -0.2, 0.65):
            fl = cyl("port_flange_x%g_z%g" % (x, z), 0.205, 0.055, (x, z * 0.655, 1.79),
                     None, rot=(math.pi / 2, 0, 0), verts=20, br=0.012)
            place(fl, "crew_metal")
            gl = cyl("port_glass_x%g_z%g" % (x, z), 0.155, 0.05, (x, z * 0.678, 1.79),
                     None, rot=(math.pi / 2, 0, 0), verts=18, br=0.0)
            gl.name = "port_glass"
            place(gl, "glass")
            bolt_ring("port_x%g_z%g" % (x, z), (x, z * 0.682, 1.79), (0, 1, 0), (1, 0, 0),
                      0.182, 6, r=0.011, h=0.009)
    # aft airlock: collar, door, external dogs and the handwheel that cycles it
    collar = cyl("lock_collar", 0.355, 0.17, (-1.60, 0, 1.72), None,
                 rot=(0, math.pi / 2, 0), verts=26, br=0.016)
    place(collar, "crew_metal")
    door = cyl("lock_door", 0.315, 0.075, (-1.70, 0, 1.72), None, rot=(0, math.pi / 2, 0),
               verts=26, br=0.014)
    place(door, "crew_frame")
    bolt_ring("lock", (-1.735, 0, 1.72), (1, 0, 0), (0, 1, 0), 0.275, 10, r=0.016, h=0.013)
    wheel_h = torus("lock_wheel", (-1.755, 0, 1.72), (1, 0, 0), (0, 1, 0), 0.115, 0.019,
                    None, maj=20, mino=6)
    place(wheel_h, "crew_metal")
    for i in range(3):
        sp = cyl("lock_spoke%d" % i, 0.012, 0.22, (-1.755, 0, 1.72), None,
                 rot=(i / 3 * math.pi, 0, 0), verts=8, br=0.0)
        place(sp, "crew_metal")

    # ── roof rack, folded wings, ladder ──────────────────────────────────────────
    for y in (-0.46, 0.46):
        rr = rbox("rack_rail_y%g" % y, 1.52, 0.055, 0.06, (-0.35, y, 2.44), None,
                  bevel_r=0.018, segs=1)
        place(rr, "crew_metal")
    for x in (-1.02, -0.35, 0.32):
        sl = rbox("rack_slat_x%g" % x, 0.06, 0.94, 0.035, (x, 0, 2.455), None,
                  bevel_r=0.012, segs=1)
        place(sl, "crew_metal")
    for y in (-0.42, 0.42):
        leg = rbox("rack_leg_y%g" % y, 0.06, 0.06, 0.24, (0.18, y, 2.33), None,
                   bevel_r=0.014, segs=1)
        place(leg, "crew_frame")
    for s in (-1, 1):                                          # the wings, folded up
        w = rbox("wing_s%g" % s, 1.26, 0.86, 0.035, (-0.35, s * 0.50, 2.53), None,
                 bevel_r=0.012, segs=1, rot=(s * 0.24, 0, 0))
        place(w, "pv")
        spine = rbox("wing_spine_s%g" % s, 1.30, 0.05, 0.05, (-0.35, s * 0.06, 2.50),
                     None, bevel_r=0.014, segs=1, rot=(s * 0.24, 0, 0))
        place(spine, "crew_metal")
    for i in range(4):                                         # the aft ladder
        rung = rbox("rung%d" % i, 0.05, 0.36, 0.042, (-1.87 - i * 0.045, 0, 0.86 + i * 0.30),
                  None, bevel_r=0.012, segs=1)
        place(rung, "crew_metal")
    for y in (-0.17, 0.17):
        rail = cyl("ladder_rail_y%g" % y, 0.022, 1.44, (-1.89 - y * 0.0, y, 1.32), None,
                   rot=(0, math.radians(9), 0), verts=10, br=0.0)
        place(rail, "crew_metal")

    # ── mast, antenna, cabling: the stuff that says a machine was wired, not printed
    mast = cyl("mast", 0.038, 1.02, (1.25, 0.35, 2.86), None, verts=14, br=0.0)
    place(mast, "crew_metal")
    head = rbox("cam_head", 0.23, 0.15, 0.14, (1.25, 0.35, 3.40), None, bevel_r=0.03, segs=2)
    place(head, "crew_frame")
    for z in (0.30, 0.40):
        lens = cyl("lens_z%g" % z, 0.036, 0.05, (1.385, z, 3.40), None,
                   rot=(0, math.pi / 2, 0), verts=14, br=0.0)
        lens.name = "lens_glass"
        place(lens, "glass")
    ant = cyl("whip", 0.009, 0.74, (1.05, -0.30, 3.12), None, rot=(0, math.radians(12), 0),
              verts=8, br=0.0)
    place(ant, "crew_metal")
    for i, pts in enumerate([[(1.20, 0.35, 2.40), (1.30, 0.40, 1.60), (1.20, 0.30, 1.10)],
                             [(-0.95, 0.44, 2.42), (-1.30, 0.60, 2.05), (-1.55, 0.55, 1.30)]]):
        hose = limb("hose%d" % i, pts, 0.026, 0.026, None, steps=10, verts=12,
                    mod=folds(9, 0.16))
        place(hose, "bot_poly")

    # ── front end ────────────────────────────────────────────────────────────────
    bumper = rbox("bumper", 0.16, 1.86, 0.44, (1.87, 0, 1.06), None, bevel_r=0.06, segs=2)
    place(bumper, "crew_frame")
    for z in (-0.62, 0.62):
        bez = cyl("lamp_bezel_z%g" % z, 0.165, 0.05, (1.90, z, 1.20), None,
                  rot=(0, math.pi / 2, 0), verts=16, br=0.012)
        place(bez, "crew_metal")
        gl = cyl("lamp_glass_z%g" % z, 0.128, 0.055, (1.945, z, 1.20), None,
                 rot=(0, math.pi / 2, 0), verts=16, br=0.0)
        place(gl, "lamp")
    winch = cyl("winch_drum", 0.115, 0.44, (1.92, 0, 0.86), None, rot=(0, math.pi / 2, 0),
                verts=18, br=0.014)
    place(winch, "crew_frame")
    for i in range(6):                                         # the rope on the drum
        t = torus("winch_line%d" % i, (1.76 + i * 0.032, 0, 0.86), (1, 0, 0), (0, 1, 0),
                  0.112, 0.011, None, maj=16, mino=5)
        place(t, "bot_poly")
    bar = rbox("hazard_bar", 0.06, 0.52, 0.15, (1.95, 0, 1.44), None, bevel_r=0.02, segs=1)
    place(bar, "hazard")
    for z in (-0.5, 0.5):                                      # mud flaps and their stay
        flap = rbox("flap_z%g" % z, 0.54, 0.05, 0.50, (-1.30, z * 1.02, 1.16), None,
                    bevel_r=0.016, segs=1, rot=(0, 0, -0.10))
        place(flap, "crew_foil")
        stay = cyl("stay_z%g" % z, 0.026, 0.40, (-1.32, z * 1.0, 1.50), None, verts=10,
                 rot=(0, math.radians(16), 0), br=0.0)
        place(stay, "crew_metal")

    for o in PARTS:
        o.parent = root
    root["length"] = 4.1
    root["width"] = 2.44
    root["height"] = 3.47
    return root


# ────────────────────────────────── Optimus ───────────────────────────────────
def hand(tag, s, frame, origin):
    """A palm, four fingers and an opposed thumb, placed in the wrist's own frame so the
    grip the arm ends in is the grip the hand is in."""
    pm = rbox(tag + "_palm", 0.055, 0.032, 0.092, origin + frame @ Vector((0, 0, -0.050)),
              None, bevel_r=0.012, segs=2)
    place(pm, "bot_poly")
    for i in range(4):
        off = -0.019 + i * 0.0128
        b = origin + frame @ Vector((off, 0, -0.094))
        tip = b + frame @ Vector((off * 0.35, 0.012, -0.062))
        fg = limb(tag + "_finger%d" % i, [b, b.lerp(tip, 0.55), tip],
                  [0.0085, 0.008, 0.0065], [0.011, 0.010, 0.008], None, steps=5, verts=10)
        place(fg, "bot_shell")
    thb = origin + frame @ Vector((s * 0.030, 0.016, -0.052))
    th = limb(tag + "_thumb", [thb, thb + frame @ Vector((s * 0.020, 0.026, -0.044))],
              [0.009, 0.0075], [0.009, 0.0075], None, steps=4, verts=10)
    place(th, "bot_shell")


def arm(tag, s, shoulder, elbow, grip):
    """Shoulder → elbow → wrist as three real rotations, so the pose is a pose: the right
    arm is abducted off the hip and its forearm comes forward to hold a service panel."""
    sh = Vector((s * 0.23, 0, 1.385))
    f1 = Euler((0, -s * shoulder, 0)).to_matrix()
    el = sh + f1 @ Vector((0, 0, -0.30))
    f2 = (f1 @ Euler((elbow, 0, 0)).to_matrix())
    wr = el + f2 @ Vector((0, 0, -0.275))
    f3 = (f2 @ Euler((grip, 0, 0)).to_matrix())
    pauld = limb(tag + "_pauldron", [sh, sh + f1 @ Vector((0, 0, -0.055))],
                 [0.062, 0.058], [0.058, 0.054], None, steps=3, verts=18)
    place(pauld, "bot_shell")
    place(cyl(tag + "_shoulder", 0.058, 0.075, sh + f1 @ Vector((0, 0, -0.03)), None,
              rot=(0, math.pi / 2, 0), verts=18, br=0.014), "bot_joint")
    place(limb(tag + "_upper", [sh + f1 @ Vector((0, 0, -0.045)), el], [0.048, 0.043],
               [0.050, 0.045], None, steps=8, verts=16, mod=folds(3, 0.07)), "bot_poly")
    place(cyl(tag + "_elbow", 0.045, 0.058, el, None, rot=(0, math.pi / 2, 0), verts=16,
              br=0.012), "bot_joint")
    place(limb(tag + "_fore", [el, wr], [0.043, 0.036], [0.045, 0.038], None, steps=8,
               verts=16, mod=folds(4, 0.06)), "bot_shell")
    place(cyl(tag + "_wrist", 0.036, 0.042, wr, None, rot=(0, math.pi / 2, 0), verts=14,
              br=0.01), "bot_joint")
    hand(tag, s, f3, wr)
    return wr, f3


def leg(tag, s):
    hx = s * 0.118
    hip = Vector((hx, 0, 0.865))
    knee = Vector((hx, 0.012, 0.500))
    ank = Vector((hx, -0.006, 0.104))
    place(cyl(tag + "_hip", 0.058, 0.062, hip, None, rot=(0, math.pi / 2, 0), verts=18,
              br=0.014), "bot_joint")
    place(limb(tag + "_thigh", [hip, knee], [0.064, 0.052], [0.060, 0.050], None, steps=10,
               verts=18, mod=folds(3, 0.06)), "bot_poly")
    place(cyl(tag + "_knee", 0.054, 0.058, knee, None, rot=(0, math.pi / 2, 0), verts=18,
              br=0.012), "bot_joint")
    place(band(tag + "_kneeguard", knee, (0, 1, 0), (0, 0, 1), 0.062, 0.11, 0.014, None,
               arc=1.5, nseg=20, center_dir=(0, 1, 0.1)), "bot_shell")
    place(limb(tag + "_shin", [knee, ank], [0.050, 0.038], [0.048, 0.038], None, steps=10,
               verts=18, mod=folds(4, 0.05)), "bot_shell")
    foot = rbox(tag + "_foot", 0.108, 0.245, 0.062, (hx, 0.028, 0.032), None,
                bevel_r=0.022, segs=2)
    place(foot, "bot_poly")
    toe = rbox(tag + "_toe", 0.094, 0.062, 0.026, (hx, 0.176, 0.066), None,
               bevel_r=0.011, segs=1, rot=(0.22, 0, 0))
    place(toe, "bot_joint")


def build_optimus():
    purge()
    PARTS.clear()
    root = empty("optimus")

    # ── head: a carapace with the visor let *into* it, not stuck on the front ─────
    head = rbox("head", 0.206, 0.150, 0.214, (0, 0, 1.554), None, bevel_r=0.036, segs=4)
    bool_op(head, rbox("visor_slot", 0.20, 0.10, 0.086, (0, 0.055, 1.556), None,
                       bevel_r=0.04, segs=3))
    place(head, "bot_shell")
    visor = rbox("visor_glass", 0.192, 0.026, 0.080, (0, 0.062, 1.556), None,
                 bevel_r=0.032, segs=3)
    visor.name = "visor_glass"
    place(visor, "bot_glass")
    for s in (-1, 1):
        eye = rbox("eye_s%g" % s, 0.042, 0.012, 0.016, (s * 0.048, 0.0755, 1.566), None,
                   bevel_r=0.006, segs=1)
        place(eye, "bot_eye")
    for s in (-1, 1):                                          # ear pods
        pod = cyl("earpod_s%g" % s, 0.019, 0.036, (s * 0.106, 0, 1.552), None,
                  rot=(0, math.pi / 2, 0), verts=16, br=0.008)
        place(pod, "bot_joint")
    place(limb("neck", [(0, 0, 1.452), (0, 0, 1.488)], 0.046, 0.046, None, steps=3,
               verts=14, mod=folds(5, 0.12)), "bot_poly")
    place(cyl("neck_bearing", 0.060, 0.026, (0, 0, 1.440), None, verts=20, br=0.008),
          "bot_joint")

    # ── torso: black frame, white carapace over it, and the waist cartridge below ─
    frame = rbox("torso_frame", 0.318, 0.188, 0.312, (0, -0.012, 1.278), None,
                 bevel_r=0.045, segs=3)
    place(frame, "bot_poly")
    chest = rbox("chest", 0.318, 0.196, 0.268, (0, 0.012, 1.325), None, bevel_r=0.078,
                 segs=4)
    place(chest, "bot_shell")
    collar = rbox("collar_trim", 0.192, 0.026, 0.058, (0, 0.116, 1.425), None,
                  bevel_r=0.014, segs=1)
    place(collar, "bot_joint")
    badge = rbox("chest_badge", 0.058, 0.016, 0.042, (0, 0.128, 1.385), None,
                 bevel_r=0.008, segs=1)
    place(badge, "bot_accent")
    pack = rbox("backpack", 0.272, 0.072, 0.318, (0, -0.138, 1.262), None, bevel_r=0.032,
                segs=3)
    place(pack, "bot_poly")
    latch = rbox("pack_latch", 0.092, 0.026, 0.092, (0, -0.208, 1.400), None,
                 bevel_r=0.014, segs=1)
    place(latch, "bot_joint")
    for x in (-0.09, 0.09):                                    # the pack's service lines
        place(limb("pack_line_x%g" % x, [(x, -0.205, 1.34), (x, -0.19, 1.16)],
                   0.014, 0.014, None, steps=5, verts=10, mod=folds(7, 0.14)), "bot_joint")
    place(cyl("waist", 0.131, 0.152, (0, 0, 1.050), None, verts=26, br=0.02), "bot_poly")
    place(cyl("hip_bearing", 0.138, 0.024, (0, 0, 0.968), None, verts=26, br=0.008),
          "bot_joint")
    pelvis = rbox("pelvis", 0.274, 0.172, 0.132, (0, 0, 0.900), None, bevel_r=0.048,
                  segs=3)
    place(pelvis, "bot_poly")

    arm("arm_l", -1, 0.09, 0.42, 0.30)
    wr, f3 = arm("arm_r", 1, 0.62, 1.15, -0.35)
    panel = rbox("service_panel", 0.176, 0.030, 0.132, wr + f3 @ Vector((0, 0.032, -0.116)),
                 None, bevel_r=0.012, segs=1)
    panel.rotation_euler = f3.to_euler()
    place(panel, "bot_joint")
    for i in range(3):
        pin = rbox("panel_pin%d" % i, 0.014, 0.020, 0.014,
                   wr + f3 @ Vector((-0.048 + i * 0.048, 0.048, -0.116)), None,
                   bevel_r=0.005, segs=1)
        pin.rotation_euler = f3.to_euler()
        place(pin, "crew_metal")
    for s in (-1, 1):
        leg("leg" + ("_l" if s < 0 else "_r"), s)

    for o in PARTS:
        o.parent = root
    root.rotation_euler = (0, 0, -0.5)
    root["height"] = 1.73
    return root


if __name__ == "__main__":
    export(build_rover(), "crew_rover.glb")
    export(build_optimus(), "optimus_bot.glb")
    print("VEHICLES_DONE")
