# Blender builder for RED STARBASE's watch deck — the grandstand the launch finale is
# watched from. Modelled as one asset at the real 17 m across, because the runtime version
# of it was a stack of boxes: a cast drum, four stepped tiers of woven seats, a shade
# canopy on tapered columns, a two-rail fence, bollard lamps and a broadcast camera on a
# tripod.
#
# Local frame: origin at the deck centre, the base of the drum at z=0, and the launch pad
# off local +Y. The crowd sits behind (-Y) and looks over the deck toward it, so placing
# the asset is one rotation by the pad bearing.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_watch_deck.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, img, textures, uv_cube, rbox, ball, cyl, cone,
                    torus, band, shell, limb, folds, lobes, ramp, chain, empty, parent,
                    purge, export, bool_op, smooth_angle, bevel, mesh_obj, solidify, join,
                    apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

DECK_TOP = 1.0                      # the wearing surface the crowd stands on
ARC = 1.5                           # radians of seating, centred on -Y
BACK = math.pi                      # bearing of the seating's middle seat

MAPPED = {}
for k in ("deck_cast", "deck_plate", "deck_weave"):
    MAPPED[k] = (mat_pbr(k, TEX[k]["maps"], rough=1.0,
                         metal={"deck_cast": 0.04, "deck_plate": 0.06,
                                "deck_weave": 0.16}[k]), TEX[k]["v_m"])

FLAT = {
    "steel":  mat("deck_steel", (0.40, 0.395, 0.385), rough=0.44, metal=0.82),
    "frame":  mat("deck_frame", (0.185, 0.175, 0.165), rough=0.56, metal=0.55),
    "red":    mat("deck_red", (0.28, 0.105, 0.062), rough=0.78, metal=0.05),
    "roof":   mat("deck_roof", (0.52, 0.505, 0.46), rough=0.52, metal=0.42),
    "black":  mat("deck_black", (0.045, 0.044, 0.046), rough=0.62, metal=0.25),
    "glass":  mat("deck_glass", (0.05, 0.06, 0.07), rough=0.08, metal=0.5, alpha=0.75),
    # The fascia is painted steel, not a lamp: a full-width emissive band reads as a neon
    # rope by day, and the six house lights under the lip already say "occupied" after dark.
    "fascia": mat("deck_fascia", (0.255, 0.175, 0.095), rough=0.52, metal=0.14),
    "bollard": mat("light_deck_bollard", (0.26, 0.19, 0.09), rough=0.42, metal=0.1,
                   emis=(1.0, 0.78, 0.46), estr=1.0),
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


def at(bearing, r, z):
    """Deck coordinates: a bearing measured the way the base measures them — (sin, cos),
    so bearing 0 is local +Y, the direction of the pad."""
    return Vector((math.sin(bearing) * r, math.cos(bearing) * r, z))


def ring_loft(name, profile, arc=ARC, a0=BACK - ARC / 2, nseg=40, m=None, tile=None,
              close_base=False, shade=44):
    """A (radius, height) profile swept around a bearing arc — the only honest way to make
    a stepped cast tier, a curved roof or a coved gutter. The profile is closed back to the
    inner face so the solid is watertight."""
    bm = bmesh.new()
    prof = list(profile)
    if close_base:
        prof = prof + [(prof[-1][0], 0.0), (prof[0][0], 0.0)]
    rows = []
    for i in range(nseg + 1):
        b = a0 + arc * i / nseg
        rows.append([bm.verts.new(Vector((math.sin(b) * r, math.cos(b) * r, z)))
                     for (r, z) in prof])
    for i in range(nseg):
        for j in range(len(prof) - 1):
            bm.faces.new((rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]))
    if len(prof) > 2:
        for i in (0, nseg):
            bm.faces.new(list(reversed(rows[i])) if i == 0 else rows[i])
    o = mesh_obj(name, bm, m, shade)
    if tile:
        uv_cube(o, tile)
    return o


# ───────────────────────────── the structure ─────────────────────────────
def build_deck():
    purge()
    PARTS.clear()
    root = empty("watch_deck")

    # ── the cast drum and its wearing surface ────────────────────────────────────
    place(cone("drum", 8.40, 8.00, DECK_TOP, (0, 0, DECK_TOP / 2), None, verts=64,
               br=0.055), "deck_cast")
    place(cyl("plinth", 8.56, 0.16, (0, 0, 0.08), None, verts=64, br=0.03), "deck_cast")
    place(cyl("plate", 7.94, 0.10, (0, 0, DECK_TOP + 0.03), None, verts=64, br=0.02),
          "deck_plate")
    place(torus("safety_band", (0, 0, DECK_TOP + 0.095), (0, 0, 1), (1, 0, 0), 7.50, 0.052,
                None, maj=76, mino=6), "red")
    for rr in (4.20, 6.00):
        place(torus("inlay_r%g" % rr, (0, 0, DECK_TOP + 0.09), (0, 0, 1), (1, 0, 0), rr,
                    0.045, None, maj=56, mino=6), "frame")
    # the drain the deck actually needs, running to two scuppers on the seating side
    place(torus("drain", (0, 0, DECK_TOP + 0.085), (0, 0, 1), (1, 0, 0), 7.05, 0.030,
                None, maj=64, mino=5), "black")
    for u in (BACK - 0.55, BACK + 0.55):
        place(rbox("scupper" + "%g" % u, 0.42, 0.16, 0.10, at(u, 7.98, DECK_TOP - 0.02),
                   None, bevel_r=0.02, segs=1, rot=(0, 0, u)), "frame")

    # ── the tiers: one stepped cast sweep, then the seats slung on it ────────────
    # inner radius, riser height above the deck, seat count — a tread runs to the next
    # tier's riser, which is what makes it a stair a crowd can actually sit on
    tiers = [[2.50, 0.00, 5], [3.90, 0.22, 7], [5.30, 0.46, 9], [6.60, 0.70, 11]]
    outer = [3.90, 5.30, 6.60, 7.60]
    prof = [(2.30, DECK_TOP + 0.10)]
    for (r, rise, n), ro in zip(tiers, outer):
        prof += [(r, DECK_TOP + 0.10 + rise), (ro, DECK_TOP + 0.10 + rise)]
    prof += [(7.60, DECK_TOP + 0.06)]
    place(ring_loft("tiers", prof, close_base=True, nseg=44), "deck_cast")
    for (r, rise, n) in tiers:
        for i in range(n):
            u = BACK + (i / (n - 1) - 0.5) * ARC
            seat = at(u, r + 0.42, DECK_TOP + 0.44 + rise)
            pan = rbox("seat_%g_%d" % (r, i), 0.60, 0.055, 0.42, seat, None,
                       bevel_r=0.022, segs=2, rot=(0.06, 0, u))
            place(pan, "deck_weave")
            back = at(u, r + 0.66, DECK_TOP + 0.68 + rise)
            bk = rbox("back_%g_%d" % (r, i), 0.60, 0.050, 0.34, back, None,
                      bevel_r=0.020, segs=2, rot=(0, -0.16, u))
            place(bk, "deck_weave")
            for s in (-1, 1):                      # the cheek the seat hangs off
                off = Vector((math.cos(u) * s * 0.31, -math.sin(u) * s * 0.31, 0))
                place(rbox("cheek_%g_%d_%s" % (r, i, s), 0.045, 0.56, 0.46,
                           seat + off + Vector((0, 0, -0.24)), None, bevel_r=0.016, segs=1,
                           rot=(0, 0, u)), "frame")
        for i in range(n + 1):                     # armrest dividers on the tier's pitch
            u = BACK + (i / n - 0.5) * ARC - 0.75 / n
            place(rbox("divider_%g_%d" % (r, i), 0.06, 0.56, 0.24,
                       at(u, r + 0.42, DECK_TOP + 0.60 + rise), None, bevel_r=0.018,
                       segs=1, rot=(0, 0, u)), "steel")
        z0 = DECK_TOP + 0.10 + rise
        place(ring_loft("footrail_%g" % r, [(r - 0.10, z0 + 0.075), (r + 0.03, z0 + 0.075),
                                            (r + 0.03, z0), (r - 0.10, z0)], nseg=30),
              "steel")

    # ── the shade canopy over the top tier ───────────────────────────────────────
    for u in (BACK - 0.72, BACK - 0.24, BACK + 0.24, BACK + 0.72):
        p = at(u, 7.35, 0)
        place(cone("column_%g" % u, 0.19, 0.13, 3.5, (p.x, p.y, DECK_TOP + 1.75), None,
                   verts=18, br=0.02), "steel")
        place(rbox("col_base_%g" % u, 0.50, 0.50, 0.11,
                   (p.x, p.y, DECK_TOP + 0.10), None, bevel_r=0.028, segs=2, rot=(0, 0, u)),
              "frame")
        for s in (-0.19, 0.19):                    # the gusset that carries the roof beam
            place(rbox("gusset_%g_%s" % (u, s), 0.05, 0.44, 0.34,
                       (p.x + math.cos(u) * s, p.y - math.sin(u) * s, DECK_TOP + 3.36),
                       None, bevel_r=0.014, segs=1, rot=(0, 0, u)), "frame")
    cx, cz = at(BACK, 6.30, 0)[:2]
    roof = rbox("canopy_roof", 9.70, 4.45, 0.17, (cx, cz, DECK_TOP + 3.62), None,
                bevel_r=0.055, segs=3, rot=(0, 0, BACK))
    roof.rotation_euler = (0.10, 0, BACK)
    place(roof, "roof")
    place(ring_loft("canopy_gutter", [(6.20, DECK_TOP + 3.44), (6.44, DECK_TOP + 3.30),
                                      (6.44, DECK_TOP + 3.46)], a0=BACK - 0.86, arc=1.72,
                    nseg=26), "roof")
    lip = rbox("canopy_lip", 9.30, 0.14, 0.30, (cx, cz, DECK_TOP + 3.44), None,
               bevel_r=0.03, segs=2, rot=(0, 0, BACK))
    place(lip, "roof")
    fas = rbox("fascia_strip", 8.90, 0.10, 0.13, (cx, cz, DECK_TOP + 3.30), None,
               bevel_r=0.02, segs=1, rot=(0, 0, BACK))
    fp = at(BACK, -2.05, 0)                        # the strip sits over the front edge
    fas.location.x += fp.x
    fas.location.y += fp.y
    place(fas, "fascia")
    for i in range(6):                             # the house lights under the lip
        o = (i / 5 - 0.5) * 8.4
        p = at(BACK, 6.05, DECK_TOP + 3.36)
        place(cyl("house_lamp%d" % i, 0.09, 0.07,
                  (p.x + math.cos(BACK) * o, p.y - math.sin(BACK) * o, DECK_TOP + 3.36),
                  None, verts=12, br=0.0), "bollard")
    for u in (BACK - 0.5, BACK + 0.5):             # a lantern over the top row's centre
        place(rbox("lantern_%g" % u, 1.70, 0.42, 0.10, at(u, 6.30, DECK_TOP + 3.80),
                   None, bevel_r=0.03, segs=2, rot=(0, 0, u)), "frame")
        place(rbox("lantern_glass_%g" % u, 1.56, 0.30, 0.05, at(u, 6.30, DECK_TOP + 3.86),
                   None, bevel_r=0.02, segs=1, rot=(0, 0, u)), "glass")

    # ── the fence on the open viewing side, and the bollard lamps on the lip ─────
    for i in range(16):
        u = (i / 15 - 0.5) * 2.5
        p = at(u, 7.62, 0)
        place(cyl("stanchion%d" % i, 0.05, 1.15, (p.x, p.y, DECK_TOP + 0.62), None,
                  verts=10, br=0.008), "steel")
        place(cyl("stanchion_shoe%d" % i, 0.085, 0.10, (p.x, p.y, DECK_TOP + 0.10), None,
                  verts=10, br=0.012), "frame")
        place(ball("stanchion_cap%d" % i, 0.055, (p.x, p.y, DECK_TOP + 1.20), None,
                   segs=12, rings=8), "steel")
    for ry in (1.16, 0.66):
        place(torus("rail_%g" % ry, (0, 0, DECK_TOP + ry), (0, 0, 1), (1, 0, 0), 7.62,
                    0.045, None, maj=44, mino=6), "steel")
    for i in range(9):
        u = (i / 8 - 0.5) * 2.9
        p = at(u, 7.10, 0)
        place(cone("bollard%d" % i, 0.12, 0.10, 0.52, (p.x, p.y, DECK_TOP + 0.30), None,
                   verts=14, br=0.02), "steel")
        place(cyl("bollard_lens%d" % i, 0.105, 0.09, (p.x, p.y, DECK_TOP + 0.60), None,
                  verts=14, br=0.014), "bollard")
        place(cyl("bollard_collar%d" % i, 0.135, 0.05, (p.x, p.y, DECK_TOP + 0.05), None,
                  verts=14, br=0.012), "frame")

    # ── the broadcast camera: the shot that films the launch ─────────────────────
    u = 1.02
    c = at(u, 6.60, 0)
    for i in range(3):
        a = u + i / 3 * TAU
        foot = Vector((c.x + math.sin(a) * 0.34, c.y + math.cos(a) * 0.34, DECK_TOP + 0.02))
        top = Vector((c.x, c.y, DECK_TOP + 1.42))
        place(limb("tripod_leg%d" % i, [foot, top], [0.036, 0.026], [0.036, 0.026], None,
                   steps=6, verts=10), "black")
        place(rbox("tripod_pad%d" % i, 0.10, 0.10, 0.035, foot, None, bevel_r=0.012,
                   segs=1), "frame")
    place(cyl("tripod_collar", 0.075, 0.14, (c.x, c.y, DECK_TOP + 1.16), None, verts=14,
              br=0.012), "steel")
    place(rbox("cam_head", 0.16, 0.20, 0.11, (c.x, c.y, DECK_TOP + 1.50), None,
               bevel_r=0.024, segs=2, rot=(0, 0, u)), "frame")
    body = rbox("cam_body", 0.26, 0.22, 0.24, at(u, 6.60 - 0.02, 0) + Vector((0, 0, DECK_TOP + 1.66)),
                None, bevel_r=0.032, segs=2, rot=(0, 0, u))
    body.rotation_euler = (0.12, 0, u)
    place(body, "black")
    lens_dir = Vector((math.sin(u), math.cos(u), 0))
    lc = Vector((c.x, c.y, DECK_TOP + 1.66)) + lens_dir * 0.20
    place(cyl("cam_lens", 0.075, 0.16, lc, None, rot=(math.pi / 2, 0, u), verts=18,
              br=0.012), "black")
    place(cyl("cam_glass", 0.062, 0.03, lc + lens_dir * 0.085, None,
              rot=(math.pi / 2, 0, u), verts=18, br=0.0), "glass")
    place(rbox("cam_matte", 0.20, 0.05, 0.19, lc + lens_dir * 0.12, None, bevel_r=0.014,
               segs=1, rot=(0, 0, u)), "black")
    place(rbox("cam_finder", 0.11, 0.08, 0.07,
               Vector((c.x, c.y, DECK_TOP + 1.80)) - lens_dir * 0.06, None,
               bevel_r=0.016, segs=1, rot=(0, 0, u)), "black")
    place(limb("cam_cable", [Vector((c.x, c.y, DECK_TOP + 1.44)),
                             Vector((c.x, c.y, DECK_TOP + 0.6)) + lens_dir * 0.5,
                             at(u, 7.4, DECK_TOP + 0.08)], 0.026, 0.026, None, steps=12,
              verts=10, mod=folds(11, 0.12)), "black")

    for o in PARTS:
        o.parent = root
    root["diameter"] = 17.12
    root["height"] = DECK_TOP + 4.0
    return root


if __name__ == "__main__":
    export(build_deck(), "watch_deck.glb")
    print("WATCH_DECK_DONE")
