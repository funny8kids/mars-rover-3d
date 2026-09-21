# Blender builder for the Spaceport Gate barrier kit — a post and one bay of rail, the two
# modules the runtime repeats five and four times down each side of the south approach.
#
# Why a kit and not one long model: the run has to follow the dune. `surfaceAt` is sampled at
# each of the five post stations and every bay is tilted onto its own two posts, which is the
# only reason the kerb is neither floating at one end nor buried at the other. So the geometry
# is authored here and the placement stays in the app — exactly how a real barrier is bought.
#
# What the primitives could not do: a cylinder post is a dowel with no base, and a tube rail is
# a dowel that stops dead. A barrier is bolted down, welded, capped and reflective, and its
# whole job is to be seen at 100 m against sand — which is done by the stripe field in rsbtex,
# not by brighter paint.
#
# One file, two nodes. The app clones `post` and `bay` out of the same GLB, so the four small
# texture fields are packed once and shared instead of riding along in two exports.
#
# Local frame: z=0 is grade, the run lies along Blender Y (which exports to the app's Z).
#   post — origin under the post centre, 1.20 m tall, rails met at 0.62 and 0.98.
#   bay  — origin at the segment's mid-length and mid-grade, 2.28 m over the rail ends
#          so both neighbours pass through the post they meet.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_barriers.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, empty,
                    purge, export, bevel, smooth_angle)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

# Small fields, not the tap's: a barrier is 300 mm of section you drive past in under a second,
# and reusing the reactor's 400 px/m grit maps cost 1.5 MB of PNG per export for a fitting that
# never occupies more than a few inches of screen.
MAPPED = {}
for k, metal in (("bar_stripe", 0.06), ("bar_white", 0.08), ("bar_soot", 0.55),
                 ("bar_cast", 0.04)):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0, metal=metal), d["v_m"])

FLAT = {
    # An unlit reflector is a piece of glass beads, not a lamp: dark amber by day, and the
    # `light_` name is what hands it to the day/night drive in props.js.
    "hot": mat("light_bar_reflector", (0.24, 0.09, 0.02), rough=0.32, metal=0.0,
               emis=(1.0, 0.36, 0.10), estr=0.9),
}

PARTS = []


def place(o, key, tile=None):
    o.data.materials.clear()
    if key in MAPPED:
        m, vm = MAPPED[key]
        o.data.materials.append(m)
        uv_cube(o, tile or vm)
    else:
        o.data.materials.append(FLAT[key])
    PARTS.append(o)
    return o


def group_under(root, name):
    """Park the parts built so far under a named node and hand it back, so one export can
    carry both modules and the app can pick either one by name."""
    g = empty(name)
    g.parent = root
    for o in PARTS:
        o.parent = g
    PARTS.clear()
    return g


# The rail stations the app already uses for its collision and its chord tilt — the asset has
# to meet them or every bay lands in the wrong place.
RAIL_LOW, RAIL_TOP, POST_TOP = 0.62, 0.98, 1.14


def build_post(root):
    # ── the bit that makes it stand up: buried footing, baseplate, four anchors ─────────
    place(cyl("footing", 0.165, 0.16, (0, 0, -0.055), None, verts=10, br=0.02), "bar_cast")
    place(rbox("plate", 0.26, 0.26, 0.024, (0, 0, 0.030), None, bevel_r=0.006, segs=1), "bar_soot")
    for sx in (-1, 1):
        for sz in (-1, 1):
            place(cyl("anchor", 0.026, 0.036, (sx * 0.093, sz * 0.093, 0.058), None,
                      verts=6, br=0.0), "bar_soot")
    # welded ribs at the heel of the tube — a square tube bolted to a plate always has them
    for k in range(4):
        a = k * math.pi / 2
        place(rbox("rib%d" % k, 0.020, 0.135, 0.17,
                   (math.sin(a) * 0.055, math.cos(a) * 0.055, 0.125), None,
                   bevel_r=0.006, segs=1, rot=(0, 0, a)), "bar_soot")

    # ── the tube: galvanised, jointed, and capped so the section reads as hollow ────────
    place(rbox("lower", 0.090, 0.090, 0.60, (0, 0, 0.34), None, bevel_r=0.010, segs=2), "bar_white")
    place(rbox("splice", 0.104, 0.104, 0.07, (0, 0, 0.645), None, bevel_r=0.010, segs=2), "bar_soot")
    place(rbox("upper", 0.088, 0.088, 0.47, (0, 0, 0.905), None, bevel_r=0.010, segs=2), "bar_white")
    place(cyl("cap", 0.052, 0.030, (0, 0, POST_TOP + 0.014), None, verts=12, br=0.008), "bar_soot")
    place(ball("finial", 0.030, (0, 0, POST_TOP + 0.046), None, segs=12, rings=8), "bar_soot")

    # ── hazard band: the legibility the whole structure exists for ──────────────────────
    place(rbox("collar", 0.106, 0.106, 0.15, (0, 0, 1.06), None, bevel_r=0.012, segs=2),
          "bar_stripe")

    # ── saddles: the rails are bolted through these, so they must be where the bays put them
    for z in (RAIL_LOW, RAIL_TOP):
        for sgn in (-1, 1):
            place(rbox("saddle_%.2f_%d" % (z, sgn), 0.128, 0.018, 0.17,
                       (0, sgn * 0.054, z), None, bevel_r=0.007, segs=1), "bar_soot")
            for d in (-1, 1):
                place(cyl("saddle_bolt", 0.013, 0.020, (0, sgn * 0.066, z + d * 0.052), None,
                          rot=(math.pi / 2, 0, 0), verts=6, br=0.0), "bar_soot")

    # ── the reflectors that face the lane, one on each side of the run ──────────────────
    for sgn in (-1, 1):
        place(rbox("reflector", 0.016, 0.062, 0.046, (sgn * 0.054, 0, 0.80), None,
                   bevel_r=0.005, segs=1), "hot")

    return group_under(root, "post")


def build_bay(root):
    LEN, HALF = 2.28, 1.14

    # Precast kerb: 300 mm above grade, and 140 mm of skirt below it so that tilting the bay
    # onto a slope never lifts its ends out of the sand.
    place(rbox("kerb", 0.34, 2.24, 0.44, (0, 0, 0.08), None, bevel_r=0.028, segs=2), "bar_cast")
    # a chamfer on the lane edge: the arris a vehicle scrapes, and the line the sun catches
    place(rbox("chamfer", 0.10, 2.24, 0.09, (0.125, 0, 0.262), None, bevel_r=0.022, segs=2),
          "bar_cast")
    # The joint between precast units: 20 mm of sealant laid flush with the top of the kerb
    # where this bay butts its neighbours. It is the one line that says the run is built from
    # bought sections, which is also what the app is doing when it repeats this bay.
    for sgn in (-1, 1):
        place(rbox("joint%d" % sgn, 0.27, 0.022, 0.026, (0, sgn * 1.112, 0.288), None,
                   bevel_r=0.006, segs=1), "bar_soot")

    # ── the two tubes. Dark striped lower rail at sand level, pale upper rail against the
    # sky: the pair is what survives every viewpoint that a single rail cannot.
    place(cyl("rail_low", 0.055, LEN, (0, 0, RAIL_LOW), None, rot=(math.pi / 2, 0, 0),
              verts=20, br=0.010), "bar_stripe", tile=0.24)
    place(cyl("rail_high", 0.050, LEN, (0, 0, RAIL_TOP), None, rot=(math.pi / 2, 0, 0),
              verts=20, br=0.010), "bar_white", tile=0.55)
    # end plugs, because the tube is hollow and the joint is where the light catches it
    for z, r in ((RAIL_LOW, 0.040), (RAIL_TOP, 0.036)):
        for sgn in (-1, 1):
            place(cyl("plug", r, 0.022, (0, sgn * (HALF - 0.004), z), None,
                      rot=(math.pi / 2, 0, 0), verts=14, br=0.0), "bar_soot")
    # a splice sleeve at mid-span, and the standoffs that hold the tubes off the kerb
    for z in (RAIL_LOW, RAIL_TOP):
        place(cyl("sleeve", 0.068, 0.15, (0, 0, z), None, rot=(math.pi / 2, 0, 0),
                  verts=16, br=0.012), "bar_soot")
        for sgn in (-1, 1):
            place(rbox("standoff", 0.048, 0.040, 0.30, (0, sgn * 0.62, z - 0.16), None,
                       bevel_r=0.010, segs=1), "bar_soot")

    return group_under(root, "bay")


def build_kit():
    purge()
    kit = empty("barrier_kit")
    build_post(kit)
    build_bay(kit)
    return kit


if __name__ == "__main__":
    export(build_kit(), "barrier_kit.glb")
    print("BARRIERS_DONE")
