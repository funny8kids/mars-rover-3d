# Blender builder for the RED STARBASE launch stack — a Starship riding a Super Heavy,
# in metres of the real vehicle.
#
# Why this is modelled rather than assembled: the silhouette that makes the vehicle
# recognisable at 200 m is a *surface*, not a pile. So the whole airframe is one lofted
# body of revolution whose radius is authored as a profile — barrel, interstage step,
# ogive — and the tile blanket is a second skin derived from the hull's own radius, so the
# steel-to-tile seam is a rim with thickness, not a decal. The flaps are D-sections swept
# from a profile; the Raptor bells are lofted de Laval curves; the grid fins are a plate
# with their pockets cut out of them.
#
# The millimetre detail is deliberately *not* geometry. A 3 cm weld bead lofted into the
# hull shades as a stack of dinner plates, so the girth welds, the brush of the stainless
# and the 300 mm thermal tiles are PBR maps from rsbtex, laid on UVs measured in metres.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_starship.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (OUT, TAU, mat, mat_pbr, mat_decal, img, textures, rbox, ball, cyl, cone,
                    torus, band, shell, limb, folds, lobes, ramp, chain, empty, parent, purge,
                    export, bool_op, smooth_angle, bevel, mesh_obj, solidify, join, apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)

# ── the vehicle, in metres ────────────────────────────────────────────────────────
R = 4.5                 # hull radius: 9 m diameter tanks
BOOT = 36.0             # Super Heavy, above the mount plane
STAGE = 38.4            # top of the interstage; the ship's aft skirt starts here
SHIP = 33.0
TIP = STAGE + SHIP      # 71.4 m to the nose tip
NOSE0 = STAGE + 20.0    # the ogive starts where the payload bay ends
WIND = 0.9              # half-angle of the windward face that carries tiles

# The forged maps, read from rsbtex's manifest: each one knows its repeat size in metres,
# which is what lets a UV put a weld on every 1.25 m and a tile on every 300 mm at any
# point on the hull.
TEX = textures()


def uvfor(key, r):
    """(u per radian, v per metre) for a surface of revolution of radius `r` that should
    receive `key`'s field at its authored physical scale."""
    d = TEX[key]
    return (r / d["u_m"], 1.0 / d["v_m"])


# props.js re-tones SHELL colours, graphite-ises ^dark_ and drives ^light_ lamps. This
# is one specific alloy in one specific finish, so every material here is named outside
# those rules and keeps what it was authored with. The `*_tex` skins are the ones carrying
# maps, and so only ever go on meshes whose UVs came from uvfor().
P = {
    "steel":  mat("rocket_steel", (0.66, 0.645, 0.62), rough=0.42, metal=0.55),
    "burnt":  mat("rocket_burnt", (0.40, 0.325, 0.265), rough=0.68, metal=0.60),
    "tps":    mat("rocket_tps", (0.62, 0.60, 0.56), rough=0.86, metal=0.05),
    "struct": mat("rocket_struct", (0.175, 0.165, 0.155), rough=0.70, metal=0.40),
    "hinge":  mat("rocket_hinge", (0.45, 0.44, 0.425), rough=0.28, metal=0.95),
    "nozzle": mat("rocket_nozzle", (0.135, 0.115, 0.105), rough=0.50, metal=0.90),
    "glass":  mat("rocket_glass", (0.05, 0.07, 0.09), rough=0.07, metal=0.60),

    "skin":   mat_pbr("rocket_skin", TEX["steel"]["maps"], rough=1.0, metal=0.62),
    "flame":  mat_pbr("rocket_burnt_tex", TEX["burnt"]["maps"], rough=1.0, metal=0.62),
    "tile":   mat_pbr("rocket_tps_tex", TEX["tps"]["maps"], rough=1.0, metal=0.04),
    "shield": mat_pbr("rocket_tps_dark", TEX["tps_dark"]["maps"], rough=1.0, metal=0.04),
    "word":   mat_decal("rocket_wordmark", TEX["wordmark"]["maps"], rough=0.38, metal=0.0),
}

PARTS = []


def add(o):
    PARTS.append(o)
    return o


# ─────────────────────────── lofting ───────────────────────────
def revolve(name, zs, rfun, m=None, verts=64, arc=TAU, a0=0.0, uv=None, shade=44):
    """A surface of revolution through authored stations. `uv` is (u per radian of arc,
    v per metre), or a callable of z returning that pair — the nose needs it, because a
    ring near the tip has to repeat the tile field more often per radian for the tiles to
    stay the size they are. u runs from the arc's own start, so a partial band's decal can
    be authored as 0..1 across it."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap") if uv else None
    closed = arc >= TAU
    grid = [[bm.verts.new(Vector((rfun(z) * math.cos(a0 + arc * i / verts),
                                  rfun(z) * math.sin(a0 + arc * i / verts), z)))
             for i in range(verts + (0 if closed else 1))] for z in zs]
    for j in range(len(zs) - 1):
        uvp = uv(zs[j]) if callable(uv) else uv
        for i in range(verts if closed else verts - 0):
            a, b = grid[j][i % verts if closed else i], grid[j][(i + 1) % verts if closed else i + 1]
            c, d = grid[j + 1][(i + 1) % verts if closed else i + 1], grid[j + 1][i % verts if closed else i]
            f = bm.faces.new((a, b, c, d))
            if uvl:
                for k, lp in enumerate(f.loops):
                    ang = [i, i + 1, i + 1, i][k]
                    zz = [zs[j], zs[j], zs[j + 1], zs[j + 1]][k]
                    lp[uvl].uv = (arc * ang / verts * uvp[0], (zz - zs[0]) * uvp[1])
    return mesh_obj(name, bm, m, shade)


def hull_stations():
    """Rings for the airframe: a structural pitch along the barrel, a finer one through
    the ogive, and a loop exactly where the nose starts so the profile kinks there rather
    than rounding off."""
    zs = [NOSE0 * i / 78 for i in range(79)]
    zs += [NOSE0 + (TIP - NOSE0) * i / 26 for i in range(1, 27)]
    return zs


def ring_stations(z0, z1, n):
    return [z0 + (z1 - z0) * i / n for i in range(n + 1)]


def ogive(z):
    """Starship's nose keeps its curvature to the very tip: r = R(1-t^2)^0.55 stays
    blunt where a cone would be sharp, which is the whole difference between
    'Starship' and '1960s rocket'."""
    t = min(1.0, (z - NOSE0) / (TIP - NOSE0))
    return max(0.03, R * (1 - t * t) ** 0.55)


def hull_r(z, lift=0.0):
    return (ogive(z) if z >= NOSE0 else R) + lift


# ─────────────────────────── components ───────────────────────────
def raptor(tag, x, y, z, s=1.0):
    """A de Laval bell — throat, then a flare that straightens out — lofted through
    stations rather than approximated by a cone, with its jacket, gimbal ring and the
    turbopump duct that feeds it."""
    depth, r_exit, r_thr = 1.55 * s, 0.66 * s, 0.132 * s
    zs = [-depth * (i / 12) for i in range(13)]
    bell = revolve(tag + "_bell", zs, lambda zz: r_thr + (r_exit - r_thr) * (-zz / depth) ** 2.2,
                   P["nozzle"], verts=22, shade=50)
    bell.location = (x, y, z)
    add(bell)
    jk = revolve(tag + "_jacket", [0.0, 0.30 * s, 0.80 * s],
                 lambda zz: (0.90 if zz < 0.4 else 0.70) * s, P["burnt"], verts=22)
    jk.location = (x, y, z)
    add(jk)
    add(torus(tag + "_gimbal", (x, y, z + 0.88 * s), (0, 0, 1), (1, 0, 0),
              0.58 * s, 0.075 * s, P["hinge"], maj=20, mino=6))
    duct = revolve(tag + "_duct", [0.92 * s, 2.0 * s], lambda zz: 0.26 * s,
                   P["struct"], verts=12)
    duct.location = (x, y, z)
    add(duct)


def flap(tag, y, side, span, tilt):
    """D-section: a straight hinge line and a swept round trailing body, lofted along
    the vehicle's own radial so the tile face and the steel lee rim are two surfaces
    with a step between them, not one painted plate."""
    out = [(0.0, -span / 2), (0.0, span / 2)]
    for i in range(1, 14):
        a = math.pi / 2 - math.pi * i / 14
        out.append(((span / 2) * math.cos(a), (span / 2) * math.sin(a)))

    def slab(name, m, thick, squash):
        bm = bmesh.new()
        A = [bm.verts.new(Vector((side * p[0] * squash, -thick, p[1] * squash))) for p in out]
        B = [bm.verts.new(Vector((side * p[0] * squash, thick, p[1] * squash))) for p in out]
        n = len(out)
        for i in range(n):
            bm.faces.new((A[i], A[(i + 1) % n], B[(i + 1) % n], B[i]))
        bm.faces.new(list(reversed(A)))
        bm.faces.new(B)
        return mesh_obj(name, bm, m, 40)

    face = slab(tag, P["tps"], 0.115, 1.0)
    bevel(face, 0.042, 2)
    rim = slab(tag + "_rim", P["steel"], 0.150, 0.93)
    for o in (face, rim):
        o.location = (side * R * 0.985, 0, y)
        o.rotation_euler = (0, side * tilt, 0)
        add(o)
    for hz in (-span * 0.34, span * 0.34):
        add(cyl(tag + "_clevis", 0.19, 0.78, (side * (R * 0.985 + 0.05), 0, y + hz),
                P["hinge"], rot=(math.radians(90), 0, 0), verts=18, br=0.03))
        add(rbox(tag + "_act", 0.44, 0.30, 0.26,
                 (side * (R * 0.985 - 0.22), 0, y + hz), P["struct"], bevel_r=0.05, segs=2))


def grid_fin(tag, a, z):
    """A plate with its pockets cut out, not a cage of bars — the open squares are what
    makes the silhouette read as 'booster that came back'."""
    fin = rbox(tag, 0.14, 2.72, 2.72, (0, 0, 0), P["struct"], bevel_r=0.04, segs=2)
    for i in range(4):
        for j in range(4):
            bool_op(fin, rbox("pocket", 0.70, 0.50, 0.50,
                              (0, -1.02 + i * 0.68, -1.02 + j * 0.68), None,
                              bevel_r=0.06, segs=2))
    fin.location = (math.cos(a) * (R + 0.38), math.sin(a) * (R + 0.38), z)
    fin.rotation_euler = (0, 0, a)
    add(fin)
    add(cyl(tag + "_pintle", 0.21, 0.86, (math.cos(a) * (R + 0.08), math.sin(a) * (R + 0.08), z),
            P["hinge"], rot=(0, math.radians(90), a), verts=18, br=0.03))


# ─────────────────────────── the stack ───────────────────────────
def build_starship():
    purge()
    root = empty("starship")

    # ── airframe: the same loft, but carried as two bodies ───────────────────────
    # The stack leaves the pad as one silhouette and crosses the sky as two, so the
    # barrel is split on the line this file already documents as the vehicle boundary:
    # STAGE, the top of the interstage, where the ship's aft skirt starts and the tile
    # line is. Splitting the *loft* rather than bisecting the exported mesh puts a ring
    # exactly on the interface, so both rims are welded circles instead of a torn band,
    # and each half's tile lattice restarts at that weld — which is where a real girth
    # seam is.
    zs = hull_stations()
    add(revolve("hull_booster", [z for z in zs if z < STAGE] + [STAGE], hull_r, P["skin"],
                verts=64, uv=uvfor("steel", R), shade=46))
    add(revolve("hull_ship", [STAGE] + [z for z in zs if z > STAGE], hull_r, P["skin"],
                verts=64, uv=uvfor("steel", R), shade=46))
    # Both halves are tubes, and a tube you can see the inside of is a hole the moment
    # they part. Each interface rim therefore gets the structure a real vehicle has
    # there: the booster's interstage is roofed over, and the ship hangs its three aft
    # Raptors off its own bulkhead.
    add(cyl("booster_bulkhead", R - 0.02, 0.10, (0, 0, STAGE - 0.10), P["struct"], br=0, verts=64))
    add(cyl("ship_aft_bulkhead", R - 0.02, 0.10, (0, 0, STAGE + 0.10), P["burnt"], br=0, verts=64))
    # the aft skirt takes every Raptor start: straw-blue oxide at the flame edge
    add(revolve("aft_skirt", ring_stations(0.0, 4.6, 16), lambda z: hull_r(z) + 0.022,
                P["flame"], verts=64, uv=uvfor("burnt", R + 0.022), shade=46))

    # ── thermal protection: a blanket over the orbital stage, and the windward
    #    shield that eats the re-entry heat ────────────────────────────────────────
    # The booster stays bare stainless (it never re-enters) and the ship is tiled from
    # its aft skirt up, so the tile line is also the line where the two vehicles meet.
    # One u scale for the whole blanket: a per-ring scale would keep every tile the
    # authored 300 mm but slide each ring's lattice out of phase with the one under it, and
    # the eye reads that as a row of dashes across the vehicle. Columns lined up, tiles
    # narrowing toward the tip the way they are actually cut, is the honest trade. The last
    # metre or two stays bare steel, because below ~2 m radius the lattice is sub-pixel.
    blanket = revolve("tps_blanket", ring_stations(STAGE + 1.2, TIP - 1.8, 92),
                      lambda z: hull_r(z) + 0.055, P["tile"], verts=52,
                      uv=uvfor("tps", R + 0.055), shade=50)
    solidify(blanket, 0.026)
    add(blanket)
    shield = revolve("tps_shield", ring_stations(STAGE + 1.2, TIP - 1.2, 92),
                     lambda z: hull_r(z) + 0.086, P["shield"], verts=20,
                     arc=WIND * 3, a0=math.pi / 2 - WIND * 1.5,
                     uv=uvfor("tps_dark", R + 0.086), shade=50)
    solidify(shield, 0.026)
    add(shield)

    # ── interstage: the step, its bolt circle and the hot-staging gas ────────────
    add(revolve("interstage", ring_stations(BOOT, STAGE, 7), lambda z: R + 0.13,
                P["skin"], verts=56, uv=uvfor("steel", R + 0.13)))
    for i in range(24):
        a = i / 24 * TAU
        add(cyl("stage_bolt", 0.10, 0.20, (math.cos(a) * (R + 0.20), math.sin(a) * (R + 0.20),
                                           BOOT + 0.55), P["hinge"],
                rot=(0, math.radians(90), a), verts=6, br=0.018))
    for i in range(8):
        a = i / 8 * TAU
        add(cone("gas_bell", 0.17, 0.09, 0.40,
                 (math.cos(a) * (R + 0.26), math.sin(a) * (R + 0.26), BOOT + 2.02),
                 P["nozzle"], rot=(math.radians(-28), 0, a), verts=14, br=0.02))

    # ── Raptor fields: thirteen round the rim, three gimballed in the middle ─────
    for i in range(13):
        a = i / 13 * TAU
        raptor("raptor_o", math.cos(a) * 3.5, math.sin(a) * 3.5, 0.30)
    for i in range(3):
        a = i / 3 * TAU + 0.5
        raptor("raptor_c", math.cos(a) * 1.25, math.sin(a) * 1.25, 0.30, 1.15)
    for i in range(3):
        a = i / 3 * TAU
        raptor("raptor_s", math.cos(a) * 1.6, math.sin(a) * 1.6, STAGE + 0.05, 0.85)

    # ── control surfaces ─────────────────────────────────────────────────────────
    flap("flap_aft", STAGE + 2.6, 1, 5.2, 0.06)
    flap("flap_aft_w", STAGE + 2.6, -1, 5.2, 0.06)
    flap("flap_fwd", NOSE0 - 1.4, 1, 3.1, 0.10)
    flap("flap_fwd_w", NOSE0 - 1.4, -1, 3.1, 0.10)
    for i in range(4):
        grid_fin("grid_fin", i * math.pi / 2 + math.pi / 4, BOOT - 4.5)

    # ── the small stuff that sells it at 20 m ────────────────────────────────────
    for y in (BOOT - 1.4, BOOT - 3.2):     # cupper: the bands the chopsticks grab
        add(torus("cupper", (0, 0, y), (0, 0, 1), (1, 0, 0), R + 0.16, 0.17,
                  P["hinge"], maj=56, mino=7))
    for a0 in (-math.pi / 2 - 0.26, -math.pi / 2 - 0.005):   # payload bay doors
        d = revolve("bay_door", [STAGE + 6.8, STAGE + 12.4], lambda z: R + 0.075,
                    P["skin"], verts=8, arc=0.25, a0=a0, uv=uvfor("steel", R + 0.075),
                    shade=46)
        solidify(d, 0.05)
        add(d)
    for y in (STAGE + 6.8, STAGE + 12.4):
        add(torus("door_rail", (0, 0, y), (0, 0, 1), (1, 0, 0), R + 0.09, 0.055,
                  P["hinge"], maj=10, mino=6))
    for k, (y, a) in enumerate([(TIP - 4.2, 0.6), (TIP - 4.2, math.pi + 0.6),
                                (STAGE + 1.4, math.pi / 2), (STAGE + 1.4, -math.pi / 2)]):
        rr = hull_r(y) + 0.12                  # the nose tapers; the pods ride its own radius
        x, z = math.cos(a) * rr, math.sin(a) * rr
        add(rbox("rcs_%d" % k, 0.36, 0.52, 0.52, (x, z, y), P["struct"], bevel_r=0.07,
                 segs=2, rot=(0, math.radians(90), a)))
        for d in (-0.17, 0, 0.17):
            add(cone("rcs_bell", 0.115, 0.07, 0.24,
                     (math.cos(a) * (rr + 0.22), math.sin(a) * (rr + 0.22), y + d),
                     P["nozzle"], rot=(0, math.radians(90), a), verts=12, br=0.014))
    for i in range(3):                      # the crew window band, set into the shield
        w = revolve("window", [NOSE0 + 1.6 + i * 1.5, NOSE0 + 2.12 + i * 1.5],
                    lambda z: hull_r(z) + 0.095, P["glass"], verts=6, arc=0.12,
                    a0=0.28, shade=60)
        add(w)
    # fill/drain line up the windward side, and the access ladder down the aft
    add(cyl("feed_pipe", 0.095, BOOT - 6.0, (0, R + 0.15, BOOT / 2 - 1), P["struct"],
            verts=14, br=0.0))
    for a in (-0.10, 0.10):
        add(cyl("ladder_rail", 0.055, BOOT - 10.0,
                (math.sin(a) * (R + 0.18), R + 0.18, BOOT / 2 - 3), P["hinge"],
                verts=10, br=0.0))
    for i in range(int((BOOT - 12) / 1.1)):
        add(cyl("ladder_rung", 0.032, 0.56, (0, R + 0.18, 4.0 + i * 1.1), P["hinge"],
                rot=(0, math.radians(90), 0), verts=8, br=0.0))
    # the wordmark, painted on the aft stainless on the lee side. The band is only a
    # carrier for the decal's alpha: everywhere there is no paint, the hull shows.
    add(revolve("wordmark", [9.0, 14.0], lambda z: R + 0.065, P["word"], verts=20,
                arc=1.6, a0=-math.pi / 2 - 0.8, uv=(1 / 1.6, 1 / 5.0), shade=60))

    # ── two bodies, not one pile of parts ────────────────────────────────────────
    # The stack leaves the pad as one silhouette and crosses the sky as two, so the
    # export carries the split as actual nodes. Every part is filed by the prefix its
    # author used; a name that matches nothing fails the build instead of quietly
    # welding itself to the wrong vehicle, because a forgotten part would be the one
    # thing left standing on the pad when the ship goes.
    booster = empty("booster")
    ship = empty("ship")
    booster.parent = root
    ship.parent = root
    BOOTSIDE = ("hull_booster", "booster_bulkhead", "aft_skirt", "raptor_o", "raptor_c",
                "interstage", "stage_bolt", "gas_bell", "grid_fin", "cupper", "feed_pipe",
                "ladder_rail", "ladder_rung", "wordmark")
    SHIPSIDE = ("hull_ship", "ship_aft_bulkhead", "raptor_s", "tps_", "flap_", "bay_door",
                "door_rail", "rcs_", "window")
    counts = {"booster": 0, "ship": 0}
    for o in PARTS:
        side = [k for k, table in (("booster", BOOTSIDE), ("ship", SHIPSIDE))
                if o.name.startswith(table)]
        if len(side) != 1:
            raise RuntimeError("part %r matches %s — the body table needs exactly one entry"
                               % (o.name, side or "no body"))
        o.parent = booster if side[0] == "booster" else ship
        counts[side[0]] += 1
    booster["height"] = STAGE
    ship["height"] = SHIP
    root["height"] = TIP
    root["radius"] = R + 0.6
    print("BODIES", counts, "parts", len(PARTS))
    return root


if __name__ == "__main__":
    r = build_starship()
    export(r, "starship_stack.glb")
    print("STARSHIP_DONE")
