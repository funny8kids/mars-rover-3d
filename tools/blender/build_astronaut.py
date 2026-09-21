# Blender builder for the RED STARBASE EVA crew — an actual EMU-class pressure
# suit, not a stack of primitives. Built on rsbkit so that every part that belongs
# on a curved body is derived from that body: the helmet window and gold visor are
# boolean cuts with real rims, the armor plates are bands at the limb radius, the
# lamps and antenna are mounted along a surface direction, and the soft goods are
# lofted sweeps whose radius is modulated into pressurised lobes and joint bellows.
# Run: blender --background --python tools/blender/build_astronaut.py
import os, sys, math, bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, rbox, ball, cyl, torus, band, shell, limb, folds,
                    lobes, ramp, chain, empty, parent, purge, export, bool_op,
                    smooth_angle, bevel)

bpy.ops.wm.read_factory_settings(use_empty=True)

# props.js owns the final tones: SHELL re-dates hull_white/hull_warm/steel/
# acc_orange/visor_gold, the ^dark_ rule graphite-ises hardware, ^light_ joins the
# day/night lamp drive and glass_pane becomes the shadow-free bubble.
P = {
    "suit":   mat("hull_white", (0.90, 0.895, 0.88), rough=0.46),
    "soft":   mat("hull_warm", (0.74, 0.71, 0.65), rough=0.62),
    "panel":  mat("dark_panel", (0.30, 0.30, 0.32), rough=0.62, metal=0.25),
    "steel":  mat("steel", (0.55, 0.56, 0.58), rough=0.35, metal=0.9),
    "orange": mat("acc_orange", (0.85, 0.33, 0.07), rough=0.45),
    # A metalness of 1 leaves the visor at the mercy of whatever the renderer has to
    # reflect: in the app there is a Mars sky to burnish it, in a bare preview there is
    # nothing and it reads as a sooty bowl. Gold-filmed polycarbonate is a *coat*, so it
    # keeps a dielectric sheen and its own colour regardless of the environment.
    "visor":  mat("visor_gold", (0.87, 0.58, 0.17), rough=0.16, metal=0.55),
    "glass":  mat("glass_pane", (0.72, 0.88, 0.95), rough=0.04, alpha=0.30),
    "lamp":   mat("light_cyan", (0.80, 0.96, 1.0), rough=0.25, emis=(0.28, 0.80, 1.0), estr=2.2),
}

FRONT = Vector((0, -1, 0))


def smount(name, c, R, dirn, sx, sy, sz, m, off=0.0, br=0.008):
    """A fitting on a round body: placed along a surface direction, oriented so its
    local +Z is the outward normal. It cannot float unless R is wrong."""
    d = Vector(dirn).normalized()
    return rbox(name, sx, sy, sz, Vector(c) + d * (R + off), m, bevel_r=br, segs=2,
                rot=d.to_track_quat('Z', 'Y').to_euler())


def build_astronaut():
    purge()
    root = empty("astronaut")
    kids = []

    def add(o):
        parent(o, root)
        kids.append(o)
        return o

    # ══════════════ hard upper torso ══════════════
    # One beveled volume, then real panel grooves cut with booleans — the seams are
    # geometry, not a texture, so they catch the rim light at every angle.
    hut = rbox("hut", 0.462, 0.375, 0.425, (0, -0.005, 1.300), None, bevel_r=0.105, segs=5)
    for gz in (1.225, 1.405):
        bool_op(hut, rbox("groove", 0.50, 0.44, 0.014, (0, -0.005, gz), None, bevel_r=0.006, segs=2))
    bool_op(hut, rbox("groove_v", 0.014, 0.44, 0.36, (0.115, -0.005, 1.300), None, bevel_r=0.006, segs=2))
    hut.data.materials.append(P["suit"])
    add(hut)
    # shoulder bearings: the suit cannot bend here without a machined race
    for s in (-1, 1):
        add(torus("shoulder_race", (s * 0.228, -0.005, 1.428), (s * 1.0, 0, 0), (0, 0, 1),
                  0.090, 0.017, P["panel"], maj=30, mino=8))
        add(band("shoulder_cowl", (s * 0.205, -0.005, 1.428), (s * 1.0, 0, 0), (0, 0, 1),
                 0.098, 0.135, 0.016, P["suit"], arc=2.5,
                 center_dir=(s * 0.2, -0.85, 0.5)))
        add(rbox("patch_%d" % s, 0.078, 0.014, 0.052, (s * 0.152, -0.199, 1.442), P["orange"],
                 bevel_r=0.006, segs=2))

    # ══════════════ lower torso + waist ══════════════
    add(limb("lta", [(0, 0.006, 1.135), (0, 0.012, 1.030), (0, 0.010, 0.930)],
             [0.172, 0.184, 0.170], [0.146, 0.158, 0.146], P["soft"], steps=12, verts=24,
             mod=folds(3, 0.055)))
    add(torus("waist_bearing", (0, 0.008, 1.108), (0, 0, 1), (1, 0, 0), 0.196, 0.020,
              P["panel"], maj=34, mino=8))
    hips = rbox("hips", 0.404, 0.322, 0.185, (0, 0.008, 0.898), None, bevel_r=0.075, segs=4)
    bool_op(hips, rbox("groove", 0.44, 0.36, 0.012, (0, 0.008, 0.885), None, bevel_r=0.005, segs=2))
    hips.data.materials.append(P["soft"])
    add(hips)
    for s in (-1, 1):
        add(cyl("hip_race", 0.088, 0.055, (s * 0.112, 0.008, 0.862), P["panel"],
                rot=(0, math.radians(90), 0), verts=26, br=0.010))

    # ══════════════ arms ══════════════
    for s in (-1, 1):
        sh = Vector((s * 0.238, -0.005, 1.428))
        el = Vector((s * 0.302, -0.026, 1.152))
        wr = Vector((s * 0.340, -0.104, 0.912))
        d1 = (el - sh).normalized()
        d2 = (wr - el).normalized()
        add(limb("upper_arm_%d" % s, [sh, sh.lerp(el, 0.5), el],
                 [0.082, 0.077, 0.070], [0.080, 0.075, 0.068], P["suit"], steps=12, verts=22,
                 mod=chain(lobes(2, 0.035), lambda t: 1.0 + 0.10 * ramp(t, 0.0, 0.14))))
        add(limb("elbow_%d" % s, [el - d1 * 0.075, el, el + d2 * 0.080],
                 [0.072, 0.070, 0.068], None, P["soft"], steps=10, verts=22, mod=folds(4, 0.13)))
        add(torus("elbow_race", el, d2, (s * 1.0, 0, 0.3), 0.071, 0.012, P["panel"],
                  maj=24, mino=7))
        add(limb("forearm_%d" % s, [el, el.lerp(wr, 0.55), wr],
                 [0.070, 0.064, 0.056], [0.068, 0.062, 0.055], P["suit"], steps=12, verts=22,
                 mod=chain(lobes(2, 0.03), lambda t: 1.0 + 0.09 * ramp(t, 0.86, 1.0))))
        add(torus("wrist_ring", wr, d2, (s * 1.0, 0, 0.4), 0.057, 0.011, P["steel"],
                  maj=24, mino=7))
        # glove: an elliptical mitten swept along the arm, so it is never a tube
        add(limb("glove_cuff_%d" % s, [wr, wr + d2 * 0.070], [0.058, 0.062], [0.050, 0.054],
                 P["soft"], steps=6, verts=20, mod=folds(3, 0.09)))
        gp0 = wr + d2 * 0.072
        gc = wr + d2 * 0.122 + Vector((0, -0.014, 0))
        gd = (gc - gp0).normalized()
        gq = gd.to_track_quat('Y', 'X')          # the glove's own frame

        def gl(x, y, z):
            return gc + gq @ Vector((x, y, z))

        # The glove is a moulded mitten with cut finger grooves, not a tube: a
        # pressure gauntlet has no articulation to show, so its read is the block,
        # the weld ring at the wrist and the deep grooves between the fingers.
        mit = rbox("mitten_%d" % s, 0.098, 0.132, 0.064, gc, None, bevel_r=0.040, segs=4,
                   rot=gq.to_euler())
        for k in (-0.028, 0.0, 0.028):
            bool_op(mit, rbox("finger_slot", 0.011, 0.080, 0.080, gl(k, -0.056, 0.008),
                              None, bevel_r=0.004, segs=2, rot=gq.to_euler()))
        mit.data.materials.append(P["soft"])
        add(mit)
        add(limb("thumb_%d" % s, [gl(s * 0.040, -0.048, -0.004), gl(s * 0.074, -0.084, -0.030)],
                 [0.021, 0.015], [0.019, 0.013], P["soft"], steps=6, verts=14))

    # ══════════════ legs ══════════════
    for s in (-1, 1):
        hip = Vector((s * 0.112, 0.008, 0.855))
        kn = Vector((s * 0.134, -0.024, 0.505))
        an = Vector((s * 0.146, 0.014, 0.145))
        d1, d2 = (kn - hip).normalized(), (an - kn).normalized()
        add(limb("thigh_%d" % s, [hip, hip.lerp(kn, 0.5), kn],
                 [0.104, 0.097, 0.088], [0.100, 0.094, 0.086], P["suit"], steps=14, verts=24,
                 mod=chain(lobes(3, 0.030), lambda t: 1.0 + 0.10 * ramp(t, 0.0, 0.10))))
        add(limb("knee_%d" % s, [kn - d1 * 0.085, kn, kn + d2 * 0.090],
                 [0.086, 0.083, 0.080], None, P["soft"], steps=10, verts=22, mod=folds(5, 0.11)))
        add(torus("knee_race", kn, d2, (s * 1.0, 0, 0.25), 0.096, 0.012, P["panel"],
                  maj=24, mino=7))
        add(band("knee_guard", kn, d2, (s, 0, 0.25), 0.098, 0.120, 0.016, P["panel"],
                 arc=1.6, center_dir=(0, -1, 0.12)))
        add(limb("shin_%d" % s, [kn, kn.lerp(an, 0.55), an],
                 [0.084, 0.077, 0.068], [0.082, 0.075, 0.066], P["suit"], steps=14, verts=24,
                 mod=chain(lobes(2, 0.030), lambda t: 1.0 + 0.09 * ramp(t, 0.84, 1.0))))
        add(band("shin_guard", kn.lerp(an, 0.42), d2, (s, 0, 0.25), 0.088, 0.200, 0.014,
                 P["suit"], arc=1.7, center_dir=(0, -1, 0.10)))
        add(torus("ankle_race", an, d2, (s, 0, 0.3), 0.076, 0.011, P["panel"], maj=22, mino=7))
        # boot: sole, upper, toe cap and collar, each overlapping the last.
        # The tread is cut *out* of the sole rather than glued underneath it —
        # a cleat below z=0 would be the first thing to vanish into the ground.
        bc = an + Vector((0, -0.046, -0.072))
        add(rbox("boot_%d" % s, 0.118, 0.258, 0.108, bc, P["soft"], bevel_r=0.044, segs=4))
        sole = rbox("sole_%d" % s, 0.130, 0.274, 0.040, bc + Vector((0, -0.004, -0.052)),
                    None, bevel_r=0.016, segs=3)
        sc = bc + Vector((0, -0.004, -0.052))
        for k in range(5):
            bool_op(sole, rbox("tread", 0.300, 0.014, 0.030,
                               (0, sc.y + (-0.100 + k * 0.050), sc.z - 0.025), None,
                               bevel_r=0.004, segs=2))
        # the heel break: a boot that cannot flex at the arch is a shoe-last, not footwear
        bool_op(sole, rbox("arch_break", 0.300, 0.020, 0.036, (0, sc.y + 0.004, sc.z - 0.023),
                           None, bevel_r=0.005, segs=2))
        sole.data.materials.append(P["panel"])
        add(sole)
        add(rbox("toe_cap_%d" % s, 0.108, 0.078, 0.062, bc + Vector((0, -0.112, -0.014)),
                 P["panel"], bevel_r=0.026, segs=3))
        add(band("boot_collar_%d" % s, an + Vector((0, -0.020, -0.030)), d2, (s, 0, 0.3),
                 0.070, 0.070, 0.016, P["soft"], arc=TAU, nseg=26))

    # ══════════════ PLSS backpack ══════════════
    add(rbox("plss", 0.400, 0.180, 0.470, (0, 0.270, 1.290), P["soft"], bevel_r=0.058, segs=4))
    add(rbox("plss_lta", 0.330, 0.140, 0.170, (0, 0.243, 1.015), P["soft"], bevel_r=0.048, segs=3))
    add(rbox("sublimator", 0.300, 0.032, 0.245, (0, 0.368, 1.400), P["panel"], bevel_r=0.014, segs=2))
    for i in range(5):
        add(rbox("sublimator_rib", 0.272, 0.018, 0.014, (0, 0.386, 1.308 + i * 0.048),
                 P["steel"], bevel_r=0.005, segs=2))
    add(rbox("wo_box", 0.062, 0.030, 0.078, (0.140, 0.368, 1.145), P["panel"], bevel_r=0.012, segs=2))
    add(cyl("wo_handle", 0.011, 0.075, (0.140, 0.398, 1.160), P["orange"],
            rot=(math.radians(90), 0, 0), verts=14, br=0.004))
    for s in (-1, 1):
        add(cyl("gas_valve", 0.019, 0.050, (s * 0.118, 0.352, 1.055), P["steel"],
                rot=(math.radians(90), 0, 0), verts=18, br=0.005))
        add(ball("gas_knob", 0.023, (s * 0.118, 0.380, 1.055), P["panel"], segs=18))
        add(rbox("tank", 0.105, 0.115, 0.330, (s * 0.150, 0.268, 1.230), P["steel"],
                 bevel_r=0.048, segs=4))
        # ribbed hoses, over the shoulder and into the chest quick-disconnects
        add(limb("hose_%d" % s,
                 [(s * 0.150, 0.300, 1.505), (s * 0.205, 0.205, 1.560),
                  (s * 0.243, 0.050, 1.540), (s * 0.232, -0.125, 1.420),
                  (s * 0.150, -0.205, 1.330), (s * 0.082, -0.218, 1.298)],
                 0.0215, None, P["panel"], steps=20, verts=14, mod=folds(13, 0.20)))
        add(cyl("hose_end", 0.024, 0.030, (s * 0.082, -0.228, 1.298), P["steel"],
                rot=(math.radians(90), 0, 0), verts=18, br=0.005))

    # ══════════════ chest control unit ══════════════
    add(rbox("dcu", 0.228, 0.058, 0.178, (0, -0.196, 1.345), P["soft"], bevel_r=0.024, segs=3))
    add(rbox("dcu_screen", 0.108, 0.012, 0.058, (-0.030, -0.226, 1.382), P["panel"],
             bevel_r=0.008, segs=2))
    for i in range(3):
        for j in range(2):
            add(cyl("dcu_btn", 0.0092, 0.016, (-0.086 + i * 0.046, -0.226, 1.272 + j * 0.030),
                    P["steel"], rot=(math.radians(90), 0, 0), verts=14, br=0.003))
    add(rbox("dcu_lamp", 0.070, 0.012, 0.018, (0.078, -0.226, 1.398), P["lamp"],
             bevel_r=0.005, segs=2))
    for s in (-1, 1):
        add(cyl("qd_port", 0.023, 0.034, (s * 0.152, -0.206, 1.298), P["steel"],
                rot=(math.radians(90), 0, 0), verts=20, br=0.005))

    # ══════════════ helmet: shell, bubble, gold visor, brim, lamps ══════════════
    HC = Vector((0, 0.006, 1.700))
    HR = 0.145
    add(shell("helmet_shell", HC, HR, P["suit"], thick=0.012, segs=40, rings=24,
              squash=(1.0, 1.04, 1.0), cut=[((0, -0.200, 1.712), 0.155)]))
    add(ball("helmet_bubble", 0.138, HC + Vector((0, -0.004, 0.002)), P["glass"], segs=34))
    # Gold film is deposited on the *outside* of the polycarbonate bubble, so the visor
    # is concentric with it and a few millimetres proud. Centred anywhere else it ends
    # up swallowed by the glass and the face reads as a white golf ball.
    vis = shell("visor_gold", HC + Vector((0, -0.004, 0.002)), 0.1425, None, thick=0.005,
                segs=36, rings=22, squash=(0.99, 1.0, 0.97))
    bool_op(vis, ball("visorkeep", 0.175, (0, -0.160, 1.700), None, segs=26), op='INTERSECT')
    vis.data.materials.append(P["visor"])
    add(vis)
    add(torus("neck_ring", (0, 0.006, 1.552), (0, 0, 1), (1, 0, 0), 0.113, 0.019,
              P["steel"], maj=34, mino=9))
    add(limb("neck_soft", [(0, 0.006, 1.492), (0, 0.008, 1.545)], [0.122, 0.114],
             [0.116, 0.108], P["soft"], steps=8, verts=22, mod=folds(2, 0.06)))
    add(band("sun_brim", HC, (0, 1, 0), (0, 0, 1), HR + 0.006, 0.120, 0.015, P["suit"],
             arc=2.35, center_dir=(0, -0.72, 0.70)))
    for s in (-1, 1):
        add(cyl("comm_cap", 0.034, 0.032, (s * (HR - 0.006), 0.020, 1.700), P["panel"],
                rot=(0, math.radians(90), 0), verts=22, br=0.006))
        d = Vector((s * 0.52, -0.72, 0.46)).normalized()
        add(smount("helmet_lamp", HC, HR, d, 0.052, 0.056, 0.034, P["panel"], off=-0.006))
        add(smount("helmet_lens", HC, HR, d, 0.036, 0.040, 0.012, P["lamp"], off=0.014))
    d = Vector((0.66, 0.30, 0.62)).normalized()
    add(cyl("antenna_stalk", 0.0065, 0.130, HC + d * (HR + 0.055), P["steel"],
            rot=d.to_track_quat('Z', 'Y').to_euler(), verts=12, br=0.002))
    add(ball("antenna_tip", 0.014, HC + d * (HR + 0.128), P["lamp"], segs=14))
    add(rbox("camera", 0.048, 0.052, 0.040, HC + Vector((-0.086, -0.104, 0.104)), P["panel"],
             bevel_r=0.010, segs=2))
    add(cyl("camera_lens", 0.013, 0.016, HC + Vector((-0.086, -0.132, 0.100)), P["lamp"],
            rot=(math.radians(90), 0, 0), verts=16, br=0.003))

    # ══════════════ restraint tether: it hangs, it does not float ══════════════
    # Two anchors and gravity decide the shape. It is snapped between the left hip
    # ring and the lower PLSS flank — strung across the chest instead, the same curve
    # reads as a stray stick lying over the DCU.
    TA = Vector((-0.150, -0.135, 1.055))   # left hip D-ring
    TB = Vector((-0.196, 0.150, 1.010))    # PLSS lower left flank
    tether = []
    for i in range(13):
        t = i / 12
        p = TA.lerp(TB, t)
        p.x -= 0.105 * math.sin(math.pi * t)
        p.y -= 0.060 * math.sin(math.pi * t)
        p.z -= 0.215 * math.sin(math.pi * t)
        tether.append(tuple(p))
    add(limb("tether", tether, 0.019, None, P["orange"], steps=6, verts=14,
             mod=folds(11, 0.09)))
    for a, b in ((TA, (0, -0.004, 0)), (TB, (-0.004, 0, 0))):
        add(cyl("tether_snap", 0.021, 0.026, (a.x + b[0], a.y + b[1], a.z), P["steel"],
                rot=(math.radians(90), 0, 0), verts=16, br=0.003))
    return root


if __name__ == "__main__":
    r = build_astronaut()
    export(r, "astronaut.glb")
    print("ASTRONAUT_DONE")
