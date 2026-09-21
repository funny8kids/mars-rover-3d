# Blender builder for the grandstand's flight-information display — the 3.7 × 2.2 m board the
# crowd reads the launch from.
#
# What the primitives could not do: this was five `box()`s in props.js — a dark slab, a hood, a
# square post, a plate under it and a glowing chip stuck to the corner. Read from a seat 6 m
# away it was the flattest thing on the deck, and read from 2 m it was a drawing of a monitor
# rather than one. A real field display is a *weatherproof enclosure*: the screen sits down
# inside a bezel so the sun cannot wash it, the bezel is bolted through a folded frame, the back
# is a fin heat sink because 3 m² of LCD cooks, a visor rides above it on tabs, and a conduit
# comes up the post's back and into a gland plate. None of that is a rectangle.
#
# Why the screen itself stays in the app: the aperture is the only part of this asset that shows
# something different every second — countdown, ascent arc, telemetry bars — so it has to be a
# live texture, not a baked one. `rsbtex` forges static surfaces; a flight display is not one.
# This file builds the hole it drops into and props.js floats the panel 15 mm proud of the
# recess floor, which is where a real display's glass actually sits.
#
# Five materials, and every one of them is a field some other hero already carries: the deck's
# cast concrete under the plinth, the barrier's galvanised white on the post, the substation's
# soot enamel on the housing. props.js merges per material, so this is five buffers in the field.
#
# Local frame: z=0 is the deck surface it is bolted to, the screen looks toward Blender +Y
# (which exports to the app's -Z), and the run is symmetric about x=0. Same convention as
# `hazard_sign`, so the app aims both with `atan2(dx, dz) + PI`.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_telemetry_board.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, cyl, cone, torus, empty,
                    bool_op, purge, export)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

MAPPED = {}
for k, metal, rough in (("deck_cast", 0.04, 1.0), ("bar_white", 0.08, 1.0),
                        ("bar_soot", 0.55, 1.0), ("tap_soot", 0.35, 1.0)):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=rough, metal=metal), d["v_m"])

FLAT = {
    # Same contract as the placard's reflectors: `light_` hands the material to the day/night
    # drive. The base colour is deliberately near-black amber — a saturated albedo under the
    # noon sun renders as a flat candy chip even at emission 0, so the lens has to be smoked.
    "hot": mat("light_board_beacon", (0.23, 0.085, 0.03), rough=0.30, metal=0.0,
               emis=(1.0, 0.38, 0.11), estr=0.9),
}

# ── the enclosure, as bought ────────────────────────────────────────────────────────────
HW, HH = 1.86, 1.08          # housing half width / half height: 3.72 × 2.16 m
CZ = 2.65                    # centre of the housing above the deck — the sightline the old
                             # runtime box already hung the board at, so the deck does not change
FRONT, BACK = 0.12, -0.08    # the shell's two faces; the wall is 200 mm of folded sheet
AX, AZ, ACZ = 1.62, 0.80, 2.69   # aperture half-size and its centre

PARTS = []


def place(o, key, tile=None):
    o.data.materials.clear()
    if key in FLAT:
        o.data.materials.append(FLAT[key])
    else:
        m, vm = MAPPED[key]
        o.data.materials.append(m)
        uv_cube(o, tile or vm)
    PARTS.append(o)
    return o


def build_ground():
    # 30 mm of the plinth goes below the datum: the board is anchored into the deck, and a
    # footing that stops exactly at the surface is the tell of a prop that was dropped there.
    place(rbox("plinth", 1.15, 0.95, 0.16, (0, 0, 0.05), None, bevel_r=0.028, segs=2), "deck_cast")
    place(rbox("sole", 0.52, 0.40, 0.028, (0, 0, 0.144), None, bevel_r=0.006, segs=1), "bar_soot")
    for sx in (-1, 1):
        for sy in (-1, 1):
            place(cyl("anchor", 0.022, 0.050, (sx * 0.19, sy * 0.14, 0.175), None,
                      verts=6, br=0.0), "bar_soot")
    # The boot: a cast taper where the tube meets the pad, because a square tube does not simply
    # start — it is grouted, and grout has a fillet.
    place(cone("boot", 0.245, 0.165, 0.20, (0, 0, 0.25), None, verts=4,
               rot=(0, 0, math.pi / 4), br=0.022), "bar_soot")


def build_post():
    # A formed square tube, tapered: 260 mm at the boot to 210 mm where it enters the housing.
    place(cone("post", 0.184, 0.148, 1.55, (0, 0, 1.12), None, verts=4,
               rot=(0, 0, math.pi / 4), br=0.032), "bar_white")
    place(rbox("splice", 0.30, 0.30, 0.070, (0, 0, 1.20), None, bevel_r=0.010, segs=2), "bar_soot")

    # ── the back of the post is where the wiring lives, and it is never bare ──
    place(rbox("hatch", 0.20, 0.016, 0.30, (0, -0.128, 0.80), None,
               bevel_r=0.004, segs=1), "bar_soot")
    for sx in (-1, 1):
        place(cyl("hinge", 0.012, 0.055, (sx * 0.088, -0.136, 0.665), None,
                  rot=(math.pi / 2, 0, 0), verts=10, br=0.0), "bar_white")
    place(cyl("quarter_turn", 0.016, 0.022, (0.062, -0.140, 0.930), None,
              rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "bar_white")
    # Up the post's back, then in through the gland: a cylinder's axis is +Z as built, so the
    # riser takes no rotation and only the short stub that enters the shell lies on its side.
    place(cyl("conduit", 0.030, 1.45, (0.11, -0.155, 0.95), None,
              verts=14, br=0.009), "bar_white")
    place(cyl("conduit_run", 0.030, 0.20, (0.11, -0.10, 1.70), None,
              rot=(math.pi / 2, 0, 0), verts=14, br=0.009), "bar_white")
    for z in (0.45, 0.80, 1.15, 1.50):
        place(rbox("clamp", 0.090, 0.078, 0.030, (0.11, -0.155, z), None,
                   bevel_r=0.006, segs=1), "bar_soot")
    place(rbox("gland", 0.24, 0.12, 0.18, (0.11, -0.145, 1.72), None,
               bevel_r=0.012, segs=1), "bar_soot")


def build_housing():
    body = rbox("shell", HW * 2, FRONT - BACK, HH * 2, (0, (FRONT + BACK) / 2, CZ), None,
                bevel_r=0.030, segs=2)
    # The screen bay, cut rather than drawn: a 100 mm-deep recess with real rims, so the panel
    # sits *inside* the frame instead of in front of it. Flat-shaded geometry cannot fake the
    # shadow line that recess throws, and that shadow line is what reads as an instrument.
    cutter = rbox("cut", AX * 2, 0.16, AZ * 2, (0, 0.10, ACZ), None, bevel_r=0.010, segs=1)
    bool_op(body, cutter)
    place(body, "tap_soot")

    # ── the folded bezel: four members carried on the shell's face, bolted through ──
    place(rbox("rail_lo", HW * 2, 0.050, 0.060, (0, 0.145, ACZ - AZ - 0.030), None,
               bevel_r=0.008, segs=1), "bar_white")
    place(rbox("rail_hi", HW * 2, 0.050, 0.060, (0, 0.145, ACZ + AZ + 0.030), None,
               bevel_r=0.008, segs=1), "bar_white")
    for sx in (-1, 1):
        place(rbox("stile", 0.060, 0.050, HH * 2, (sx * (AX + 0.030), 0.145, CZ), None,
                   bevel_r=0.008, segs=1), "bar_white")

    # Stainless hex heads, on the rails where a service tech would actually put them.
    for z in (ACZ - AZ - 0.030, ACZ + AZ + 0.030):
        for x in (-1.28, -0.64, 0.0, 0.64, 1.28):
            place(cyl("bolt", 0.014, 0.016, (x, 0.176, z), None,
                      rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "bar_soot")
    for sx in (-1, 1):
        for z in (CZ - 0.55, CZ + 0.55):
            place(cyl("bolt", 0.014, 0.016, (sx * (AX + 0.030), 0.176, z), None,
                      rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "bar_soot")

    for sx in (-1, 1):
        for sz in (-1, 1):
            place(rbox("gusset", 0.15, 0.235, 0.15,
                       (sx * (HW - 0.075), 0.005, CZ + sz * (HH - 0.075)), None,
                       bevel_r=0.016, segs=1), "bar_soot")


def build_thermal():
    # A display behind 200 mm of insulated shell needs its heat moved, and a fin stack is what
    # does it. The blades are tilted downhill, because the louvre that faces the sky is the louvre
    # that fills with dust — but the thing that makes it read as *one* part rather than six loose
    # spikes pinned to the back of a box is the shroud: end cheeks and cowl rails that bound the
    # block, with the fins stopping just short of them so the assembly has a front and a back.
    place(rbox("spine", 3.34, 0.060, 1.38, (0, -0.105, CZ), None,
               bevel_r=0.008, segs=1), "bar_soot")
    # Sixteen shallow blades at 86 mm pitch, not six deep ones at 240 mm: a fin stack only reads
    # as a heat sink when the ridges are closer together than the eye can resolve individually,
    # and the tilt is what keeps blowing dust from landing flat on them.
    for i in range(16):
        place(rbox("fin", 3.26, 0.110, 0.014, (0, -0.180, CZ - 0.645 + i * 0.086), None,
                   bevel_r=0.004, segs=1, rot=(-0.35, 0, 0)), "bar_white")
    for sx in (-1, 1):
        place(rbox("cheek", 0.020, 0.160, 1.40, (sx * 1.690, -0.155, CZ), None,
                   bevel_r=0.006, segs=1), "bar_soot")
    for sz in (-1, 1):
        place(rbox("cowl", 3.40, 0.170, 0.024, (0, -0.155, CZ + sz * 0.712), None,
                   bevel_r=0.006, segs=1), "bar_soot")
    # Data plate, below the shroud on the bare shell — the one spot on the back a tech can read
    # without lying down in the cable trench.
    place(rbox("nameplate", 0.46, 0.014, 0.17, (-1.10, -0.085, CZ - 0.87), None,
               bevel_r=0.003, segs=1), "bar_white")


def build_sunshade():
    # The reason this whole thing has a roof: the noon sun is the one thing that makes a field
    # display unreadable, and every screen you can actually read outdoors has a visor. Tilted 17°
    # so it shades the glass at the sun's worst hour and still throws its shadow clear of the
    # bezel.
    #
    # The brackets are the whole job here. A visor hung in the air 40 mm above the shell reads as
    # a separate shelf tilting off the box — so each bracket is welded into the top-front corner,
    # overlapping both faces, and the visor's own rear edge is dropped onto the bracket tops at
    # their front ends. Load path you can see: shell → bracket → visor, one continuous line.
    for x in (-1.75, -0.58, 0.58, 1.75):
        place(rbox("tab", 0.055, 0.160, 0.200, (x, 0.160, CZ + HH - 0.070), None,
                   bevel_r=0.006, segs=1), "bar_soot")
    place(rbox("visor", 3.90, 0.380, 0.055, (0, 0.300, CZ + HH + 0.014), None,
               bevel_r=0.008, segs=1, rot=(-0.30, 0, 0)), "bar_white")
    # The folded hem at the visor's outer edge: sheet metal does not end in a raw cut.
    place(rbox("visor_lip", 3.90, 0.022, 0.080, (0, 0.475, CZ + HH - 0.045), None,
               bevel_r=0.005, segs=1, rot=(-0.30, 0, 0)), "bar_white")
    # Lifting eyes, because a 3.7 m enclosure gets set down by a crane and nobody carries it.
    # Sunk into the top face — a ring standing off a plate by 25 mm is a modelling error, not a
    # fitting, so the pad under it is what the weld actually sits on.
    for x in (-1.30, 1.30):
        place(rbox("eye_pad", 0.105, 0.105, 0.026, (x, -0.02, CZ + HH + 0.012), None,
                   bevel_r=0.006, segs=1), "bar_soot")
        place(torus("eye", (x, -0.02, CZ + HH + 0.055), (0, 1, 0), (1, 0, 0),
                    0.075, 0.016, None, maj=16, mino=6), "bar_soot")


def build_beacon():
    place(rbox("beacon_base", 0.26, 0.26, 0.035, (0, -0.02, CZ + HH + 0.015), None,
               bevel_r=0.008, segs=1), "bar_soot")
    place(cyl("beacon_lens", 0.085, 0.26, (0, -0.02, CZ + HH + 0.165), None,
              verts=16, br=0.020), "hot")
    place(cone("beacon_cap", 0.100, 0.052, 0.075, (0, -0.02, CZ + HH + 0.330), None,
               verts=16, br=0.012), "bar_soot")


if __name__ == "__main__":
    purge()
    root = empty("telemetry_board")
    build_ground()
    build_post()
    build_housing()
    build_thermal()
    build_sunshade()
    build_beacon()
    for o in PARTS:
        o.parent = root
    export(root, "telemetry_board.glb")
    print("BOARD_PARTS", len(PARTS))
    print("TELEMETRY_BOARD_DONE")
