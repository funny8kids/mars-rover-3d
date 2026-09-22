# Blender builder for the launch apron's feeder pillar — the cable cabinet that stands beside the
# comms mast on the raised service deck at the edge of the pad.
#
# What the primitive could not do: in props.js this was one `box(0.7, 0.9, 0.5)` in flat structural
# grey, and the comment sitting above it already said the truth — "what actually lives on a raised
# service deck is a comms mast and its feeder pillar". The mast became an asset; the pillar stayed a
# brick, which made the pair read as a model and its plinth. A feeder pillar is the most ordinary
# piece of electrical furniture on a site and it is never a box: it has a door on hinges with a
# three-point latch, louvres because the transformers inside cook, a pitched rain roof that
# overhangs the door so the laminate stays legible, glands and a conduit bend out of its foot, and a
# grouted cast plinth because nothing on Mars sits directly on the deck.
#
# Why the fields are borrowed: `tap_iron` / `tap_soot` / `tap_cast` are the reactor tap substation's,
# imported rather than re-forged. A pillar and a substation are the same switchgear family on the
# same grid; if they weather differently the base reads as three art passes glued together.
#
# Four materials, not nine. props.js merges by material, so each one here is one draw call in the
# field, and the apron's deck carries the only instance on the island.
#
# Local frame: z=0 is the deck it bolts to, the door looks toward Blender +Y (which exports to the
# app's -Z), and the run is symmetric about x=0. The app aims it with `atan2(dx, dz) + PI` — the
# same +Y convention every other hero in this directory carries.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_feeder_pillar.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, torus,
                    empty, purge, export)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

MAPPED = {}
for k in ("tap_iron", "tap_soot", "tap_cast", "bar_white", "bar_stripe"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                         metal={"tap_iron": 0.86, "tap_soot": 0.45, "tap_cast": 0.12,
                                "bar_white": 0.08, "bar_stripe": 0.06}[k]),
                 d["v_m"])

FLAT = {
    # The one lamp on the cabinet says "this bay is live". `light_` hands it to the day/night
    # drive, so it is a dark bead at noon and a lit one after dusk without any code here.
    "hot": mat("light_pillar_lamp", (0.24, 0.10, 0.03), rough=0.34, metal=0.0,
               emis=(1.0, 0.42, 0.12), estr=1.0),
}

# The cabinet as bought: 700 × 500 mm of sheet steel, 820 mm of body on a 60 mm plinth, and a
# 0.90 m top of roof. Those are the exact outer dimensions the runtime box had, so the deck's
# layout does not move — only what stands in it.
BW, BD, BZ = 0.70, 0.50, 0.47          # body width, depth, centre height (plinth is 0.06)
PLH = 0.06
DOOR_W, DOOR_H, DOOR_Z = 0.58, 0.64, 0.50
FRONT = BD / 2                          # the body's front face, Blender +Y

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


def build_plinth():
    # The cast base the cabinet is set into, 20 mm proud of the body on every side so the rain
    # running off the roof lands outside the door seam instead of in it.
    place(rbox("plinth", BW + 0.10, BD + 0.10, PLH, (0, 0, PLH / 2), None,
               bevel_r=0.018, segs=2), "tap_cast")
    for sx in (-1, 1):
        for sy in (-1, 1):
            place(cyl("foot_bolt", 0.021, 0.030, (sx * (BW / 2 + 0.025), sy * (BD / 2 + 0.025),
                                                  PLH + 0.004), None, verts=6, br=0.0),
                  "tap_soot")
    # A grout fillet at the heel: nothing on a graded deck meets concrete with a clean 90° line.
    place(rbox("grout", BW + 0.16, BD + 0.16, 0.022, (0, 0, 0.011), None,
               bevel_r=0.010, segs=1), "tap_cast")


def build_body():
    place(rbox("body", BW, BD, 0.82, (0, 0, PLH + 0.41), None, bevel_r=0.012, segs=2),
          "tap_iron")
    # The door, 6 mm proud of the shell, and the rebate frame around it so the panel edge catches
    # a shadow instead of ending in the same plane as the body.
    place(rbox("door", DOOR_W, 0.016, DOOR_H, (0, FRONT + 0.014, DOOR_Z), None,
               bevel_r=0.006, segs=1), "tap_iron")
    for z in (DOOR_Z + DOOR_H / 2 - 0.014, DOOR_Z - DOOR_H / 2 + 0.014):
        place(rbox("door_rail", DOOR_W + 0.036, 0.020, 0.028, (0, FRONT + 0.010, z), None,
                   bevel_r=0.005, segs=1), "tap_soot")
    for sx in (-1, 1):
        place(rbox("door_stile", 0.028, 0.020, DOOR_H + 0.036,
                   (sx * (DOOR_W / 2 + 0.014), FRONT + 0.010, DOOR_Z), None,
                   bevel_r=0.005, segs=1), "tap_soot")

    # Hinges on the west jamb, three of them, knuckles showing. They stand clear of the stile
    # because a hinge is what the door turns on, not something buried inside its frame.
    for z in (DOOR_Z - 0.24, DOOR_Z, DOOR_Z + 0.24):
        place(cyl("hinge", 0.017, 0.086, (-DOOR_W / 2 - 0.042, FRONT + 0.020, z), None,
                  verts=14, br=0.004), "tap_soot")
        place(rbox("hinge_arm", 0.058, 0.012, 0.052,
                   (-DOOR_W / 2 - 0.014, FRONT + 0.020, z), None,
                   bevel_r=0.004, segs=1), "tap_soot")

    # The swing latch: a plate, a barrel, and the lever itself lying across the door.
    place(rbox("latch_plate", 0.086, 0.016, 0.230, (DOOR_W / 2 - 0.070, FRONT + 0.024, DOOR_Z),
               None, bevel_r=0.005, segs=1), "tap_soot")
    place(cyl("latch_barrel", 0.020, 0.030, (DOOR_W / 2 - 0.070, FRONT + 0.040, DOOR_Z + 0.055),
              None, rot=(math.pi / 2, 0, 0), verts=16, br=0.004), "tap_soot")
    place(rbox("latch_lever", 0.030, 0.115, 0.028,
               (DOOR_W / 2 - 0.070, FRONT + 0.044, DOOR_Z - 0.048), None,
               bevel_r=0.007, segs=1, rot=(0.16, 0, 0)), "tap_soot")


def build_vents():
    # Louvres on the flanks and the back, never the door. A cabinet's front is the face a tech
    # reads; the ventilation is where the rain cannot blow straight into the windings, and the
    # slats are tilted, which is the whole reason a louvre is not a grille of holes.
    for sx in (-1, 1):
        for i in range(4):
            place(rbox("vent_hi", 0.030, 0.30, 0.013,
                       (sx * (BW / 2 + 0.002), 0, 0.640 + i * 0.028), None,
                       bevel_r=0.003, segs=1, rot=(0, sx * 0.62, 0)), "tap_soot")
        for i in range(3):
            place(rbox("vent_lo", 0.030, 0.30, 0.013,
                       (sx * (BW / 2 + 0.002), 0, 0.150 + i * 0.028), None,
                       bevel_r=0.003, segs=1, rot=(0, sx * 0.62, 0)), "tap_soot")
    for i in range(4):
        place(rbox("vent_back", 0.44, 0.030, 0.013, (0, -(FRONT + 0.004), 0.700 + i * 0.028),
                   None, bevel_r=0.003, segs=1, rot=(0.62, 0, 0)), "tap_soot")


def build_roof():
    # A rain roof with a fall to the back, overhanging 30 mm all round. Flat-topped cabinets are
    # the tell of a box: water has to leave somewhere, and it leaves over a drip edge.
    place(rbox("roof", BW + 0.14, BD + 0.14, 0.026, (0, 0, 0.900), None,
               bevel_r=0.008, segs=1, rot=(0.055, 0, 0)), "tap_iron")
    place(rbox("drip", BW + 0.16, 0.020, 0.040, (0, FRONT + 0.062, 0.888), None,
               bevel_r=0.005, segs=1, rot=(0.055, 0, 0)), "tap_soot")
    place(rbox("gutter", BW + 0.16, 0.020, 0.046, (0, -(FRONT + 0.062), 0.882), None,
               bevel_r=0.005, segs=1, rot=(0.055, 0, 0)), "tap_soot")
    # Two lifting eyes, because a 90 kg cabinet is craned onto its deck, not carried. The ring's
    # centre sits a full radius above the pad it is welded to: an eye sunk into the plate it stands
    # on is a modelling error, not a fitting.
    for sx in (-1, 1):
        place(rbox("eye_pad", 0.090, 0.090, 0.020, (sx * 0.24, -0.06, 0.916), None,
                   bevel_r=0.005, segs=1, rot=(0.055, 0, 0)), "tap_soot")
        place(torus("eye", (sx * 0.24, -0.06, 0.984), (0, 1, 0), (1, 0, 0),
                    0.058, 0.013, None, maj=14, mino=6), "tap_soot")


def build_feed():
    # The feeder itself: three glands on the back of the plinth and one conduit that bends out
    # along the deck toward the mast. Without this the cabinet is a dead prop with nothing
    # connected to it, which is exactly the complaint the B series exists to answer.
    for i, x in enumerate((-0.16, 0.0, 0.16)):
        place(cyl("gland", 0.030, 0.040, (x, -(FRONT + 0.008), PLH + 0.020), None,
                  rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "tap_soot")
    place(cyl("sweep", 0.026, 0.13, (0.0, -(FRONT + 0.075), PLH + 0.020), None,
              rot=(math.pi / 2, 0, 0), verts=14, br=0.004), "tap_soot")
    place(cyl("conduit", 0.026, 0.62, (0.0, -(FRONT + 0.40), 0.030), None,
              rot=(math.pi / 2, 0, 0), verts=14, br=0.004), "tap_soot")
    for sy in (-(FRONT + 0.20), -(FRONT + 0.52)):
        place(rbox("strap", 0.070, 0.030, 0.036, (0.0, sy, 0.026), None,
                   bevel_r=0.005, segs=1), "tap_soot")


def build_marks():
    # The asset tag and the warning tile, both on the door's field of view. `bar_stripe` is the
    # barrier kit's diagonal marking field — the same faded hazard yellow the pad's kerbs wear, so
    # the pillar belongs to the base it stands in.
    place(rbox("nameplate", 0.170, 0.008, 0.056, (-0.185, FRONT + 0.030, 0.225), None,
               bevel_r=0.003, segs=1), "bar_white")
    place(rbox("warn", 0.104, 0.008, 0.104, (-0.185, FRONT + 0.030, 0.665), None,
               bevel_r=0.004, segs=1), "bar_stripe")
    place(rbox("lamp", 0.034, 0.012, 0.034, (0.0, FRONT + 0.030, 0.745), None,
               bevel_r=0.004, segs=1), "hot")
    # A hasp staple over the door's top rail: the bay is locked against everyone but the crew.
    place(torus("hasp", (0.0, FRONT + 0.026, 0.845), (0, 1, 0), (0, 0, 1),
                0.034, 0.009, None, maj=14, mino=6), "tap_soot")


if __name__ == "__main__":
    purge()
    root = empty("feeder_pillar")
    build_plinth()
    build_body()
    build_vents()
    build_roof()
    build_feed()
    build_marks()
    for o in PARTS:
        o.parent = root
    export(root, "feeder_pillar.glb")
    print("PILLAR_PARTS", len(PARTS))
    print("FEEDER_PILLAR_DONE")
