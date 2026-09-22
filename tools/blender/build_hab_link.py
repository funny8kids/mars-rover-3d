# Blender builder for the habitat's pressurised corridor module — the 5.8 m link that runs from
# the living drum to the greenhouse and from the domes back to the drum.
#
# What the primitive could not do: props.js placed three Kenney pieces (`corridor`,
# `corridor_corner`, `corridor_end`) under the comment "pressurised corridors linking drum → domes →
# greenhouse", and none of them touched a hatch. They were short curved shells dropped at three
# coordinates inside the settlement, so the habitat read as four separate buildings with scenery
# between them — the exact "走廊对不上舱门" defect the C series exists to close. A corridor is not
# decoration set down the block from a door: it is the reason the door is there. This module is
# authored to a span, so the runtime places one per gap and both ends disappear into a hull.
#
# What a corridor actually is, and what is in the mesh because of it: a pressure tube does not sit
# on sand. It is bedded in a cast strip footing with a splashed kerb, the tube rides in a cradle on
# that footing and is held by two bolted straps, the shell is stiffened by hoop ribs, the joint at
# each end is a bolted flange (24 bolts, because that is what keeps four atmospheres in), and the
# services run outside where a tech can reach them — a cable tray over the crown on standoffs, a
# thermal trunk along the footing's shoulder, and a junction box whose conduit bends down into the
# cast. Two portholes per flank and a fitting at each end, because a habitat's inside is worth
# seeing and the settlement's night pass is the payoff.
#
# Why the fields are borrowed: `crew_paint` / `crew_frame` / `crew_metal` / `crew_foil` are the
# rover's switchgear and foil family and `tap_cast` is the reactor tap's cast base. The dwelling
# drum, the domes and the glasshouse all wear those same whites and cast footings already; a
# corridor weathered differently would split the settlement into art passes.
#
# Six materials, not nine. props.js merges by material, so each one here is one draw call, and
# this module is instanced per span across one district.
#
# Local frame: z=0 is the ground the strip footing is cast into, the run is along Blender +Y (which
# exports to the app's -Z), and the module is symmetric about x=0 and y=0 — so the app aims it
# along (dx,dz) with `atan2(dx, dz)` and its centre lands on the gap's midpoint. Both ends bury
# into a hull; nothing is meant to be read at y = ±2.8.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_hab_link.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, torus, band,
                    bool_op, empty, purge, export)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

MAPPED = {}
for k in ("crew_paint", "crew_frame", "crew_metal", "crew_foil", "tap_cast"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                        metal={"crew_paint": 0.16, "crew_frame": 0.62, "crew_metal": 0.86,
                               "crew_foil": 0.72, "tap_cast": 0.12}[k]),
                 d["v_m"])

FLAT = {
    # The glazing and the two fittings share one material: a window is the only other light source
    # a 5.8 m tube can offer the avenue at night. `light_` hands it to the day/night drive in
    # props.js, so the same mesh is dark enamel at noon and a lit strip after dusk. The albedo is
    # deliberately near-white frosted, not saturated: the drive treats a pale strip as frosting
    # (0.34) and a coloured one as a bulb (1.45), and the cyan bulb value blew the bloom into a
    # vertical flare on every dome porthole. Amber is the colour the settlement's own windows
    # advertise after dusk.
    "light": mat("light_link_window", (0.86, 0.94, 0.96), rough=0.22, metal=0.0,
                 emis=(0.98, 0.72, 0.42), estr=0.85),
}

# A crew passage needs 2.1 m of clear bore and a flange to bolt to a module's hull wall. The tube
# is 2.10 m across and the crown breaks 2.8 m; the cast strip under it is a 500 mm kerb, which is
# what a 3.2 m rover clears without noticing.
R = 1.05                     # tunnel outer radius
CZ = 1.75                    # tunnel axis height → crown at 2.80
LEN = 5.6                    # shell length; flanges put the module at 5.8 m overall
FTOP = 0.50                  # top of the cast strip footing
YEND = LEN / 2

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


def build_footing():
    # The strip the tube is bedded in: a cast footing with a splashed kerb so meltwater and drift
    # sand leave the flange instead of standing against it. Nothing on Mars sits on the regolith.
    place(rbox("footing", 2.00, LEN + 0.50, FTOP, (0, 0, FTOP / 2), None,
               bevel_r=0.05, segs=2), "tap_cast")
    place(rbox("apron", 2.50, LEN + 0.90, 0.10, (0, 0, 0.05), None,
               bevel_r=0.030, segs=1), "tap_cast")
    # The haunch between the footing's top and the tube's springline. Without it the shell floats on
    # two pads with a slot of open air under its belly — which is how the first pass read.
    place(rbox("cradle", 1.70, LEN, 0.22, (0, 0, FTOP + 0.11), None,
               bevel_r=0.030, segs=1), "tap_cast")


def build_shell():
    # Bored through its whole length, because the module ends at a hull and the joint has to read
    # as a tube's wall — a solid cylinder leaves a flat white disc inside the flange, which is the
    # "走廊对不上舱门" tell in miniature. The bore is the passage; both ends bury into a hull.
    shell = cyl("shell", R, LEN, (0, 0, CZ), None, rot=(math.pi / 2, 0, 0),
                verts=32, br=0.0)
    bool_op(shell, cyl("bore", R - 0.13, LEN + 1.0, (0, 0, CZ), None,
                       rot=(math.pi / 2, 0, 0), verts=28, br=0.0))
    place(shell, "crew_paint")
    # Hoop ribs: a pressure tube is stiffened where it is supported, and the ribs are the shadow
    # line that stops a 5.6 m white cylinder reading as one. They stand at the cradle stations and
    # mid-bay, so the strap bolts down over a rib instead of sitting beside it.
    for y in (-2.30, -0.77, 0.77, 2.30):
        place(torus("rib", (0, y, CZ), (0, 1, 0), (1, 0, 0), R + 0.04, 0.055, None,
                    maj=26, mino=7), "crew_frame")
    # One multi-layer insulation band, wrapped and strapped: the foil this habitat family shows at
    # all is a gold collar around each service penetration.
    place(cyl("foil_band", R + 0.05, 0.55, (0, 0, CZ), None, rot=(math.pi / 2, 0, 0),
              verts=28, br=0.012), "crew_foil")
    # The cradle straps that hold the tube to its cast: rsbkit's band takes the body radius as the
    # plate's inner radius, so these hug the shell instead of hovering over it.
    for sy in (-1, 1):
        place(band("strap", (0, sy * 2.30, CZ), (0, 1, 0), (1, 0, 0), R, 0.20, 0.045, None,
                   arc=TAU * 0.62, center_dir=(0, 0, -1)), "crew_frame")


def build_flanges():
    # A bolted flange at each end, and an annular one — a solid disc here would cap the tube and
    # put a flat wall exactly where the module's hull should be opening.
    for sy in (-1, 1):
        y = sy * (YEND - 0.09)
        collar = cyl("collar", 1.22, 0.18, (0, y, CZ), None, rot=(math.pi / 2, 0, 0),
                     verts=32, br=0.014)
        bool_op(collar, cyl("bore", 1.02, 1.0, (0, y, CZ), None, rot=(math.pi / 2, 0, 0),
                            verts=28, br=0.0))
        place(collar, "crew_paint")
        for i in range(12):
            a = i / 12 * TAU + (0.26 if sy < 0 else 0.0)
            place(cyl("bolt", 0.045, 0.09, (1.14 * math.cos(a), sy * (YEND + 0.04),
                                            CZ + 1.14 * math.sin(a)), None,
                      rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "crew_frame")


def build_services():
    # The cable tray rides on standoffs above the crown rather than lying on the shell: a tray that
    # is tangent to a curved tube is a tray floating in the air at both its edges. It stops short of
    # the flanges and is supported within 0.4 m of every point along it, because a tray that
    # cantilevers past its last post reads as a beam that was dropped there.
    for sx in (-1, 1):
        for y in (-1.95, -0.65, 0.65, 1.95):
            place(rbox("standoff", 0.09, 0.09, 0.20, (sx * 0.20, y, 2.88), None,
                       bevel_r=0.012, segs=1), "crew_frame")
    place(rbox("tray", 0.56, 4.60, 0.06, (0, 0, 3.01), None,
               bevel_r=0.014, segs=1), "crew_metal")
    for sx in (-1, 1):
        place(rbox("tray_lip", 0.05, 4.60, 0.20, (sx * 0.28, 0, 3.10), None,
                   bevel_r=0.012, segs=1), "crew_frame")
    for x in (-0.14, 0.0, 0.14):
        place(cyl("cable", 0.065, 4.40, (x, 0, 3.10), None, rot=(math.pi / 2, 0, 0),
                  verts=12, br=0.0), "crew_frame")

    # The thermal trunk, bedded on the footing's shoulder where a valve can actually be reached,
    # and clipped down every 1.3 m so it is a piped run and not a stray cylinder.
    place(cyl("trunk", 0.08, LEN - 0.30, (-0.90, 0, FTOP + 0.08), None,
              rot=(math.pi / 2, 0, 0), verts=16, br=0.0), "crew_metal")
    for y in (-1.90, -0.60, 0.70, 2.00):
        place(rbox("trunk_clip", 0.24, 0.08, 0.20, (-0.90, y, FTOP + 0.02), None,
                   bevel_r=0.010, segs=1), "crew_frame")

    # The junction box the tray feeds, and its conduit bending down the flank into the cast. A box
    # with nothing connected to it is the tell this whole series is chasing.
    place(rbox("jbox", 0.16, 0.40, 0.52, (1.06, 2.10, 1.55), None,
               bevel_r=0.016, segs=1), "crew_frame")
    place(cyl("conduit", 0.05, 0.85, (0.98, 2.10, 0.88), None, verts=14, br=0.012), "crew_metal")


def build_openings():
    # Two portholes per flank. The rim is a bored annulus seated on the shell's own surface at that
    # height — sqrt(R² − (z−CZ)²) = 1.031 m — so it stands proud instead of floating off a curve,
    # and the glazing shows through the bore instead of being buried inside a solid disc.
    px = math.sqrt(R * R - (1.95 - CZ) ** 2)
    for sx in (-1, 1):
        for y in (-1.40, 1.40):
            x = sx * px
            rim = cyl("port_rim", 0.28, 0.18, (x, y, 1.95), None, rot=(0, math.pi / 2, 0),
                      verts=24, br=0.016)
            bool_op(rim, cyl("bore", 0.20, 0.5, (x, y, 1.95), None,
                             rot=(0, math.pi / 2, 0), verts=20, br=0.0))
            place(rim, "crew_frame")
            place(cyl("port_glass", 0.205, 0.07, (sx * (px + 0.06), y, 1.95), None,
                      rot=(0, math.pi / 2, 0), verts=20, br=0.0), "light")
    # One fitting per end, on the crown just inboard of the flange where there is a surface to
    # bolt to. On the flange face itself it would hang in mid-air once the joint buries a hull.
    for sy in (-1, 1):
        place(rbox("lamp", 0.26, 0.10, 0.13, (0, sy * 2.45, CZ + R + 0.045), None,
                   bevel_r=0.018, segs=1), "light")


if __name__ == "__main__":
    purge()
    root = empty("hab_link")
    build_footing()
    build_shell()
    build_flanges()
    build_services()
    build_openings()
    for o in PARTS:
        o.parent = root
    export(root, "hab_link.glb")
    print("LINK_PARTS", len(PARTS))
    print("HAB_LINK_DONE")
