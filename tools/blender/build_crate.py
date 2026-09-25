# Blender builder for the drum crate — the welded steel skid that carries three stainless
# cryogenic drums to the LOX depot, the pad, the rail yard and the lubricant area.
#
# What the primitive could not do: the world placed `barrels` at four sites and every one of
# them was the vendored Kenney pack — two flat-shaded orange/cream banded blocks on a white
# plinth, i.e. a crate of cryo drums drawn as a crate of two crayons. A real palletised cryo
# delivery is a piece of ground support equipment: a welded dark-steel skid with fork pockets,
# three 0.6 m stainless drums with dished heads and rolled chime rings, galvanised strapping
# bands stadium-wrapped around the group with their buckles on the front run, welded lift lugs
# at the corners, and a valve manifold header tying all three vaporiser outlets together —
# plus the one thing that says *why* this crate exists: a DOT 5.1 oxidiser placard.
#
# Metric scale, off real equipment: a 50 L cryo drum is 0.6 m ⌀ × ~1.5 m over its heads; the
# skid is a 1.86 × 1.08 m welded frame (three drums of 0.6 m shoulder to shoulder need the
# width, and 1.08 m keeps the fork entry along the short side standard); the header stands the
# assembly 1.84 m clear. That lands the crate inside the 2.0 m envelope every placement site
# has, because the game sizes the collider disc off this model's own measured footprint.
#
# Where the detail lives: the brush, the girth weld and the heat haze on the shells are the
# `steel` field's (1.25 m weld pitch, so one drum shows exactly one seam), and the drum UVs are
# authored as a true cylindrical unwrap — u along the circumference, v straight up the barrel —
# because cube projection would run the weld ring one way on the ±X facets and the other way on
# the ±Y ones. Panel seams and rivets on the chime rings and the skid stay in their maps.
#
# Local frame: origin at the centre of the skid's footprint on the grade, z up, the placard and
# the strap buckles face Blender +Y (which exports to the app's -Z, the same convention every
# other hero in this directory carries).
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_crate.py
import os, sys, math, bpy, bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, torus,
                    band, empty, purge, export, bool_op, smooth_angle, bevel, mesh_obj,
                    solidify, join, apply_mods)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

# Four borrowed fields and two new ones. `steel` is the starship's brushed-and-welded
# stainless, `gate_dark` the substation family's worn dark steel — the skid is the same
# painted-then-scratched iron as the gate's counterweight — and `tap_iron` the switchgear
# galvanising every fitting on this site bolts with. `drum_yellow` and `cryo_placard` are
# forged for this asset in rsbtex.
MAPPED = {}
for k, metal in (("steel", 0.62), ("gate_dark", 0.42), ("tap_iron", 0.86),
                 ("drum_yellow", 0.06), ("cryo_placard", 0.05)):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0, metal=metal), d["v_m"])

FLAT = {
    # The valve handwheels and the gauge dial are moulded parts, small enough that a panel
    # field would be stucco at viewing distance — same ruling build_lox applies to its
    # lockouts.
    "wheel": mat("crate_valve", (0.34, 0.10, 0.045), rough=0.68, metal=0.05),
    "dial":  mat("crate_dial", (0.85, 0.83, 0.78), rough=0.32, metal=0.0),
}

# The drum, as bought: 0.30 m radius shell from 0.26 to 1.50 m, 0.10 m dished heads, and a
# 0.075 m top neck. Three of them on 1.16 m centres, so the group spans 1.76 m of shells
# inside the 1.86 m skid.
DR_R, DR_X = 0.30, 0.58
DR_Z0, DR_Z1 = 0.26, 1.50
HEAD = 0.10                      # dished-head depth
SKID_X, SKID_Y = 0.93, 0.54      # half-extents of the skid frame
DECK_Z = 0.13                    # top of the deck plate the drums stand on
Z_HDR = 1.80                     # manifold header axis

PARTS = []


def place(o, key, cube=True):
    """Material, and the UV the field asks for: metre-cube for every tiling field, nothing
    for the flats, and a hand-authored unwrap for the two graphics (the caller does those)."""
    o.data.materials.clear()
    if key in MAPPED:
        m, tile = MAPPED[key]
        o.data.materials.append(m)
        if cube:
            uv_cube(o, tile)
    else:
        o.data.materials.append(FLAT[key])
    PARTS.append(o)
    return o


def uv_cyl(o, cx=0.0, cy=0.0, R=0.30, u_m=2.5, v_m=2.5):
    """A true cylindrical unwrap in the map's own metre scale: u is arc length around the
    axis, v is height above grade. The `steel` field's girth weld sits on a 1.25 m pitch in
    v and its brush runs in v too, so this is the only UV under which a horizontal weld ring
    stays a ring on every facet instead of breaking at the quadrant seams."""
    if not o.data.uv_layers:
        o.data.uv_layers.new()
    uvl = o.data.uv_layers.active
    for li in range(len(o.data.loops)):
        co = o.data.vertices[o.data.loops[li].vertex_index].co
        ang = math.atan2(co.y - cy, co.x - cx)
        # The +0.23 v-offset is placed so the field's girth weld lands at z = 1.02: the one
        # band on the barrel that sits in clear sight between the two straps (welds hidden
        # under a buckle are welds nobody sees).
        uvl.data[li].uv = (ang * R / u_m, (co.z + 0.23) / v_m)
    return o


def uv_patch(o, cx, cy, z0, w_m, h_m):
    """Planar-in-development UVs on a curved shell patch: u runs *against* +X (the same
    measured handedness build_hazard_sign's `uv_face` documents, for the same +Y-facing
    viewer), v is up, both scaled so the card's exact-metre map lands 1:1 on the shell."""
    if not o.data.uv_layers:
        o.data.uv_layers.new()
    uvl = o.data.uv_layers.active
    for li in range(len(o.data.loops)):
        co = o.data.vertices[o.data.loops[li].vertex_index].co
        uvl.data[li].uv = (0.5 - (co.x - cx) / w_m, 0.5 + (co.z - z0) / h_m)
    return o


def strap_band(name, z, ty, thick, half_h, cx, n=96):
    """A galvanised strapping band stadium-wrapped around the three-drum group: two straight
    runs tangent to the outer shells and a half-loop around each end drum — which is exactly
    the plan-view convex hull of a row of circles, so the band lies on the shells instead of
    bridging air over them. The path IS the inner face (radius `ty` off each end drum's axis);
    the section is `thick` outward by `2*half_h` tall, rectangular — no radial subdivisions.
    """
    arc = TAU * ty / 2.0
    seg = 2 * (2 * cx) + 2 * arc
    bm = bmesh.new()
    rings = []
    for i in range(n):
        s = i / n * seg
        if s < 2 * cx:                                    # bottom run, +X
            p, nr = Vector((-cx + s, -ty, 0)), Vector((0, -1, 0))
        elif s < 2 * cx + arc:                            # right half-loop
            a = -math.pi / 2 + (s - 2 * cx) / ty
            p, nr = Vector((cx + ty * math.cos(a), ty * math.sin(a), 0)), \
                Vector((math.cos(a), math.sin(a), 0))
        elif s < 4 * cx + arc:                            # top run, -X
            p, nr = Vector((cx - (s - 2 * cx - arc), ty, 0)), Vector((0, 1, 0))
        else:                                             # left half-loop
            a = math.pi / 2 + (s - 4 * cx - arc) / ty
            p, nr = Vector((-cx + ty * math.cos(a), ty * math.sin(a), 0)), \
                Vector((math.cos(a), math.sin(a), 0))
        p.z = z
        rings.append([bm.verts.new(p + nr * tt + Vector((0, 0, dz)))
                      for tt, dz in ((0.0, -half_h), (0.0, half_h),
                                     (thick, half_h), (thick, -half_h))])
    for i in range(n):
        a, b = rings[i], rings[(i + 1) % n]
        for j in range(4):
            bm.faces.new((a[j], a[(j + 1) % 4], b[(j + 1) % 4], b[j]))
    return mesh_obj(name, bm, shade=44)


def build_skid():
    """The welded pallet: a 14 mm deck on a perimeter of 90 mm box rail, a centre cross-rail
    that puts a fork pocket on each third, and tie plates at the corners."""
    deck = rbox("deck", 2 * SKID_X - 0.02, 2 * SKID_Y - 0.02, 0.014, (0, 0, DECK_Z - 0.007),
                None, bevel_r=0.005, segs=1)
    rails = [rbox("rail_x", 2 * SKID_X, 0.09, 0.092, (0, s * (SKID_Y - 0.045), 0.046), None,
                  bevel_r=0.010, segs=1) for s in (-1, 1)]
    rails += [rbox("rail_y", 0.09, 2 * SKID_Y - 0.18, 0.092, (s * (SKID_X - 0.045), 0, 0.046),
                   None, bevel_r=0.010, segs=1) for s in (-1, 1)]
    rails.append(rbox("rail_c", 0.08, 2 * SKID_Y - 0.18, 0.092, (0, 0, 0.046), None,
                      bevel_r=0.010, segs=1))
    # Drum stops: welded cleats that locate each shell at ±x against the skid's own frame, so
    # the drums cannot walk on a Mars quake.
    cleats = []
    for dx in (-(DR_X + DR_R + 0.012), DR_X + DR_R + 0.012):
        for s in (-1, 1):
            cleats.append(rbox("cleat", 0.030, 0.070, 0.055, (dx, s * 0.24, DECK_Z + 0.020),
                               None, bevel_r=0.007, segs=1, rot=(0, 0, -s * 0.5)))
    place(join([deck] + rails + cleats, "pallet"), "gate_dark")


def build_lugs():
    """Four welded lift lugs, one per corner, plate standing on the deck rail with a 55 mm
    hoisting eye cut through it by boolean — a lug with a painted-on hole is the tell."""
    for i, (sx, sy) in enumerate(((-1, -1), (-1, 1), (1, -1), (1, 1))):
        lx, ly = sx * (SKID_X - 0.045), sy * (SKID_Y - 0.045)
        a = math.atan2(ly, lx)
        lug = rbox("lug_%d" % (i + 1), 0.020, 0.170, 0.170,
                   (lx, ly, DECK_Z + 0.085), None, bevel_r=0.006, segs=1,
                   rot=(0, 0, a + math.pi / 2))
        # The eye is cut across the plate's local y — a cutter barrelled along the plate's
        # horizontal axis, at 45° to the world because the lug points at the corner.
        cut = cyl("cuttmp", 0.0275, 0.10, (lx - math.sin(a) * 0.0, ly, DECK_Z + 0.135), None,
                  rot=(0, math.pi / 2, a), verts=16, br=0.0)
        bool_op(lug, cut)
        # stiffener gusset welded to the inboard face of the plate, offset along the corner
        # direction because that is the plate's own normal
        gus = rbox("gus", 0.090, 0.016, 0.070, (lx - math.cos(a) * 0.026, ly - math.sin(a) * 0.026,
                                                DECK_Z + 0.035), None, bevel_r=0.005, segs=1,
                   rot=(0, 0, a + math.pi / 2))
        place(join([lug, gus], "lug_%d" % (i + 1)), "gate_dark")


def build_drums():
    """Shell, two dished heads and the top neck joined as one mesh per drum, unwrapped as a
    true cylinder so the forged girth weld rings the barrel once."""
    for i, dx in enumerate((-DR_X, 0.0, DR_X)):
        body = cyl("shell", DR_R, DR_Z1 - DR_Z0, (dx, 0, (DR_Z0 + DR_Z1) / 2), None,
                   verts=28, br=0.012)
        lo = ball("head_lo", DR_R, (dx, 0, DR_Z0), None, segs=26, rings=10,
                  scale=(1, 1, HEAD / DR_R))
        hi = ball("head_hi", DR_R, (dx, 0, DR_Z1), None, segs=26, rings=10,
                  scale=(1, 1, HEAD / DR_R))
        neck = cyl("neck", 0.062, 0.085, (dx, 0, DR_Z1 + HEAD - 0.010), None, verts=14,
                   br=0.008)
        d = join([body, lo, hi, neck], "drum_%d" % (i + 1))
        place(d, "steel", cube=False)
        uv_cyl(d, dx, 0.0, R=DR_R, u_m=TEX["steel"]["u_m"], v_m=TEX["steel"]["v_m"])


def build_chimes():
    """The rolled bottom rim every drum stands on: a 0.318 m collar from deck to relief
    groove with an edge bead top and bottom, painted safety yellow because a chime ring is
    the one part of a cryo drum that is never left bare."""
    for i, dx in enumerate((-DR_X, 0.0, DR_X)):
        wall = cyl("collar", 0.318, 0.105, (dx, 0, DECK_Z + 0.0525), None, verts=28, br=0.0)
        bool_op(wall, cyl("cuttmp", 0.302, 0.20, (dx, 0, DECK_Z + 0.0525), None, verts=28,
                          br=0.0))
        beads = [torus("bead", (dx, 0, z), (0, 0, 1), (1, 0, 0), 0.314, 0.009, None,
                       maj=28, mino=6) for z in (DECK_Z + 0.014, DECK_Z + 0.092)]
        place(join([wall] + beads, "chime_%d" % (i + 1)), "drum_yellow")


def build_straps():
    """Two strapping bands at body height and shoulder height, each with its tensioner buckle
    and tail plate on the front run — a band with no buckle is a painted ring."""
    for tag, z, bx in (("lo", 0.78, 0.20), ("hi", 1.26, -0.16)):
        s = strap_band("strap_" + tag, z, 0.303, 0.008, 0.024, DR_X)
        buck = rbox("buckle", 0.095, 0.030, 0.066, (bx, 0.313, z), None, bevel_r=0.008, segs=1)
        tail = rbox("tail", 0.050, 0.014, 0.085, (bx + 0.075, 0.317, z - 0.020), None,
                    bevel_r=0.004, segs=1, rot=(0, 0.28, 0))
        place(join([s, buck, tail], "strap_" + tag), "tap_iron")


def build_manifold():
    """The vaporiser header: a DN60 manifold pipe along the row at head height, a drop leg and
    an isolation valve on each drum neck, a capped far end and a pressure gauge on the near
    one. Three drums feeding one line is what makes this LOX distribution, not decoration."""
    hdr = cyl("header", 0.030, 1.30, (0.01, 0, Z_HDR), None, rot=(0, math.pi / 2, 0),
              verts=18, br=0.008)
    parts = [hdr]
    parts.append(cyl("cap", 0.040, 0.030, (0.665, 0, Z_HDR), None, rot=(0, math.pi / 2, 0),
                     verts=16, br=0.006))
    for dx in (-DR_X, 0.0, DR_X):
        parts.append(cyl("drop", 0.020, 0.16, (dx, 0, Z_HDR - 0.075), None, verts=12, br=0.0))
        parts.append(rbox("vbody", 0.085, 0.085, 0.095, (dx, 0, DR_Z1 + HEAD + 0.045), None,
                          bevel_r=0.012, segs=2))
        parts.append(cyl("bonnet", 0.026, 0.045, (dx, 0, DR_Z1 + HEAD + 0.115), None,
                         verts=10, br=0.0))
    place(join(parts, "manifold"), "tap_iron")
    wheels = []
    for dx in (-DR_X, 0.0, DR_X):
        # The wheel lies flat over its bonnet — this is a top-entry isolation valve, and a
        # sideways wheel on a vertical stem is the tell of a rotated primitive.
        wheels.append(cyl("wheel", 0.058, 0.014, (dx, 0, DR_Z1 + HEAD + 0.145), None,
                          verts=20, br=0.004))
        wheels.append(cyl("stem", 0.010, 0.030, (dx, 0, DR_Z1 + HEAD + 0.125), None,
                          verts=8, br=0.0))
    place(join(wheels, "valves"), "wheel", cube=False)
    place(cyl("gauge_body", 0.050, 0.026, (-0.60, 0.048, Z_HDR), None,
              rot=(math.pi / 2, 0, 0), verts=18, br=0.005), "tap_iron")
    place(cyl("gauge_dial", 0.041, 0.006, (-0.60, 0.062, Z_HDR), None,
              rot=(math.pi / 2, 0, 0), verts=18, br=0.0), "dial", cube=False)


def build_placard():
    """The DOT card on the outboard drum's front face: a 4 mm laminate shell hugging the
    0.30 m radius, UVs authored in the card's own metres so the legend lands 1:1."""
    w_m, h_m = TEX["cryo_placard"]["u_m"], TEX["cryo_placard"]["v_m"]
    z0 = 1.02
    p = band("placard", (DR_X, 0, z0), (0, 0, 1), (1, 0, 0), DR_R + 0.002, h_m, 0.004,
             arc=w_m / (DR_R + 0.002) + 0.02, nseg=26, center_dir=(0, 1, 0))
    place(p, "cryo_placard", cube=False)
    uv_patch(p, DR_X, 0.0, z0, w_m, h_m)


if __name__ == "__main__":
    purge()
    root = empty("drum_crate")
    build_skid()
    build_lugs()
    build_drums()
    build_chimes()
    build_straps()
    build_manifold()
    build_placard()
    for o in PARTS:
        o.parent = root
    root["diameter"] = 1.86
    root["height"] = 1.84
    export(root, "drum_crate.glb")
    print("CRATE_PARTS", len(PARTS))
    print("CRATE_DONE")
