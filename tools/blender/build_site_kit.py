# Blender builder for the base's ground furniture kit — the small moulded and cast things that a
# site scatters in multiples: hazard delineators, traffic cones, a ductal pit cover, the docking
# cradle a crew rover parks in, a short stub mast, and the pad's floodlight housings.
#
# What the primitives could not do: props.js drew every one of these as a `cyl()` or `box()`. The
# delineator was a 0.9 m orange dowel with no weighted base and no retro-reflective band, so it
# read as a traffic cone that had lost its cone. The traffic cone was a truncated disc floating
# over a separate black coin. The pit cover was a grey disc — no frame, no lifting slot, no bolt
# bosses, nothing that says a person opens it with a tool. The cradle was two dark planks, which is
# why the parked rover looked dropped rather than docked. The stub mast was a grey tube the beacon
# balanced on top of with no collar to bolt to. And the pad's 24 floodlights were two stacked
# boxes, one of them in the ring's own material, which is the least plausible thing on a launch
# apron: a flood has a housing, a yoke it tilts on, a heat sink behind the LED board and a glass
# face that the beam rig takes as its anchor.
#
# Materials are the cost model. props.js batches by material after placement, so a kit part costs
# nothing extra per instance while each *material* is one more batch across the scene. Five here,
# and the reason the delineator's band is its own material rather than a texture is that it is the
# only retro-reflective surface on the site.
#
# Local frames: every node's origin is the point props.js already knows — the ground contact for
# stake/cone/cover/mast, the beam's centre for cradle, and the *lamp's own base* for flood, whose
# lens node is named `flood_lens` so the caller can read its world position instead of hand-typing
# an offset (the two floating 44 m cones this replaced were exactly that mistake).
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_site_kit.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, torus,
                    empty, purge, export, join)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

MAPPED = {}
for k, metal in (("tap_cast", 0.12), ("tap_iron", 0.86), ("bar_white", 0.08)):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0, metal=metal), d["v_m"])
# Safety orange and the retro band are flat moulded colours, not weathered metal: a delineator
# spends its life in a dust storm and the one part that stays bright is the band.
MAPPED["haz_orange"] = (mat("haz_orange", (0.72, 0.19, 0.025), rough=0.55, metal=0.0), 0.30)
MAPPED["haz_band"] = (mat("haz_band", (0.86, 0.85, 0.80), rough=0.22, metal=0.0), 0.30)
MAPPED["dark_poly"] = (mat("dark_poly", (0.055, 0.052, 0.05), rough=0.72, metal=0.0), 0.30)

PARTS = []
GROUPS = []
GROUP = None


def begin(name):
    """Start one clonable item. The kit's items are multi-material — a delineator is orange body
    plus retro bands plus a dark cap — so each is a named empty its nodes hang under, and props.js
    clones the empty. Flattening everything onto the root would mean a clone of one stake dragging
    the whole kit with it."""
    global GROUP
    GROUP = empty(name)
    GROUPS.append(GROUP)
    return GROUP


def place(o, key):
    m, size = MAPPED[key]
    o.data.materials.clear()
    o.data.materials.append(m)
    uv_cube(o, size)
    PARTS.append(o)
    return o


def node(objs, name, key):
    """Join a node's pieces into one mesh per material — the kit is cloned 24 times over, and a
    part count that grows with the instance count is how the apron got expensive."""
    o = place(join(objs if isinstance(objs, list) else [objs], name), key)
    if GROUP:
        o.parent = GROUP
    return o


# ───────────────────────────── hazard delineator ─────────────────────────────
def build_stake():
    begin('stake')
    """0.9 m delineator: weighted square base, flexible tapered upright, two retro bands, and the
    hole in the top you carry a line through."""
    base = rbox("stake_base", 0.21, 0.21, 0.035, (0, 0, 0.0175), bevel_r=0.014, segs=2)
    body = cone("stake_body", 0.030, 0.055, 0.83, (0, 0, 0.45), verts=20, br=0.010)
    node([base, body], "stake_body", "haz_orange")
    bands = [cyl("band", 0.0455 - 0.0035 * i, 0.055, (0, 0, 0.42 + 0.19 * i), verts=20)
             for i in range(2)]
    cap = cyl("stake_cap", 0.030, 0.02, (0, 0, 0.87), verts=20)
    node(bands, "stake_bands", "haz_band")
    node([cap], "stake_top", "dark_poly")


# ───────────────────────────── traffic cone ─────────────────────────────
def build_cone():
    begin('cone')
    """0.42 m cone: sloped ballasted base, body with a retro collar and a second narrow band,
    truncated tip. Replaces the floating truncated disc plus the separate black coin under it."""
    base = cone("cone_base", 0.16, 0.145, 0.030, (0, 0, 0.015), verts=24, br=0.008)
    skirt = rbox("cone_skirt", 0.30, 0.30, 0.014, (0, 0, 0.007), bevel_r=0.006, segs=2)
    body = cone("cone_body", 0.030, 0.125, 0.36, (0, 0, 0.21), verts=28, br=0.010)
    node([base, skirt, body], "cone_body", "haz_orange")
    collar = cyl("cone_collar", 0.089, 0.055, (0, 0, 0.215), verts=28)
    thin = cyl("cone_band", 0.062, 0.026, (0, 0, 0.135), verts=28)
    node([collar, thin], "cone_bands", "haz_band")
    tip = cone("cone_tip", 0.020, 0.030, 0.028, (0, 0, 0.404), verts=20, br=0.005)
    node([tip], "cone_tip", "dark_poly")


# ───────────────────────────── ductal pit cover ─────────────────────────────
def build_cover():
    begin('cover')
    """Ø0.92 cast cover in a frame ring: non-skid bar field, a lifting slot, four bolt bosses and
    the site stencil ridge across it."""
    frame = torus("cover_frame", (0, 0, 0.012), (0, 0, 1), (1, 0, 0), 0.44, 0.035, maj=40, mino=8)
    lid = cyl("cover_lid", 0.415, 0.030, (0, 0, 0.020), verts=40, br=0.006)
    bars = [rbox("bar", 0.62, 0.026, 0.010, (0, (i - 3.5) * 0.085, 0.038), bevel_r=0.003, segs=1)
            for i in range(7)]
    slot = rbox("cover_slot", 0.16, 0.030, 0.020, (0.20, 0.0, 0.040), bevel_r=0.004, segs=1)
    bolts = [cyl("bolt", 0.026, 0.022, (0.36 * math.cos(TAU * i / 4 + TAU / 8),
                                        0.36 * math.sin(TAU * i / 4 + TAU / 8), 0.040), verts=12)
             for i in range(4)]
    node([frame, lid] + bars + [slot] + bolts, "cover", "tap_cast")


# ───────────────────────────── rover docking cradle ─────────────────────────────
def build_cradle():
    begin('cradle')
    """One 2.5 m channel the rover's rocker sits in: C-section beam, three V-blocks, end caps and
    a bolted guide plate at the near end. Placed twice, 2.4 m apart, along the rover's own yaw."""
    web = rbox("cradle_web", 0.34, 2.46, 0.045, (0, 0, 0.022), bevel_r=0.008, segs=1)
    fl = [rbox("cradle_flange", 0.055, 2.46, 0.15, (s * 0.145, 0, 0.075), bevel_r=0.010, segs=1)
          for s in (-1, 1)]
    vblocks = []
    for z in (-0.85, 0.0, 0.85):
        for s in (-1, 1):
            vblocks.append(rbox("vblock", 0.10, 0.20, 0.10, (s * 0.085, z, 0.145),
                                bevel_r=0.012, segs=1, rot=(0, math.radians(-18 * s), 0)))
    caps = [rbox("end_cap", 0.36, 0.05, 0.17, (0, z * 1.24, 0.085), bevel_r=0.010, segs=1)
            for z in (-1, 1)]
    node([web] + fl + vblocks + caps, "cradle", "dark_poly")
    guide = rbox("cradle_guide", 0.50, 0.30, 0.016, (0, -1.36, 0.030), bevel_r=0.005, segs=1)
    pins = [cyl("pin", 0.020, 0.05, (sx * 0.19, -1.36, 0.055), verts=12) for sx in (-1, 1)]
    node([guide] + pins, "cradle_guide", "tap_iron")


# ───────────────────────────── stub mast ─────────────────────────────
def build_mast():
    begin('mast')
    """1.6 m stub mast the obstruction light bolts to: base plate with a cable gland, tube in two
    diameters with a joint collar, a clamp band and the mounting flange on top."""
    plate = cyl("mast_plate", 0.20, 0.022, (0, 0, 0.011), verts=28, br=0.005)
    gland = cyl("mast_gland", 0.035, 0.07, (0.13, 0, 0.05), verts=14, br=0.005)
    lower = cyl("mast_lower", 0.055, 0.78, (0, 0, 0.41), verts=22, br=0.006)
    collar = cyl("mast_collar", 0.068, 0.055, (0, 0, 0.82), verts=22, br=0.006)
    upper = cyl("mast_upper", 0.045, 0.66, (0, 0, 1.17), verts=22, br=0.005)
    band = torus("mast_band", (0, 0, 1.44), (0, 0, 1), (1, 0, 0), 0.058, 0.014, maj=22, mino=6)
    top = cyl("mast_flange", 0.115, 0.020, (0, 0, 1.52), verts=26, br=0.005)
    bolts = [cyl("mbolt", 0.014, 0.024, (0.085 * math.cos(TAU * i / 4), 0.085 * math.sin(TAU * i / 4), 1.542),
                 verts=10) for i in range(4)]
    node([plate, gland, lower, collar, upper, band, top] + bolts, "mast", "tap_iron")


# ───────────────────────────── tall mast ─────────────────────────────
def build_mast_tall():
    """6 m mast at the wreck site. Same family as the stub, three times the height, so it earns
    the things a long tube actually needs: two joined sections with a bolted collar, a rung set
    for the person who has to climb it, a cable run clipped up the side, and a finial to take the
    strike instead of the beacon."""
    begin('mast_tall')
    plate = cyl("mt_plate", 0.28, 0.026, (0, 0, 0.013), verts=32, br=0.006)
    stiff = [rbox("mt_stiff", 0.05, 0.30, 0.16, (0.20 * math.cos(TAU * i / 4),
                                                 0.20 * math.sin(TAU * i / 4), 0.10),
                  bevel_r=0.006, segs=1, rot=(0, 0, TAU * i / 4)) for i in range(4)]
    lower = cyl("mt_lower", 0.085, 2.90, (0, 0, 1.47), verts=26, br=0.008)
    joint = cyl("mt_joint", 0.105, 0.22, (0, 0, 2.98), verts=26, br=0.008)
    jb = [cyl("mt_jbolt", 0.016, 0.03, (0.112 * math.cos(TAU * i / 6), 0.112 * math.sin(TAU * i / 6), 2.98),
              verts=10, rot=(0, math.radians(90), 0)) for i in range(6)]
    upper = cyl("mt_upper", 0.068, 2.72, (0, 0, 4.44), verts=24, br=0.006)
    # The top is a receiving flange, not a lightning finial: the obstruction light bolts here, so
    # a spike would have grown straight through the lens. Measured off the clone — the beacon's own
    # mounting plate lands at 5.80 once the mast carries it.
    top = cyl("mt_cap", 0.105, 0.045, (0, 0, 5.80), verts=26, br=0.008)
    tb = [cyl("mt_tbolt", 0.015, 0.026, (0.078 * math.cos(TAU * i / 4 + TAU / 8),
                                          0.078 * math.sin(TAU * i / 4 + TAU / 8), 5.845), verts=10)
          for i in range(4)]
    node([plate] + stiff + [lower, joint, upper, top] + jb + tb, "mast_tall", "tap_iron")
    rungs = [cyl("mt_rung", 0.014, 0.30, (0, 0, 0.85 + i * 0.42), verts=10,
                 rot=(0, math.radians(90), 0)) for i in range(8)]
    rails = [cyl("mt_rail", 0.011, 3.30, (s * 0.155, 0, 2.50), verts=10) for s in (-1, 1)]
    hoops = [torus("mt_hoop", (0, 0, 1.05 + i * 1.05), (0, 0, 1), (1, 0, 0), 0.175, 0.011,
                   maj=20, mino=6) for i in range(3)]
    node(rungs + rails + hoops, "mast_ladder", "tap_iron")
    conduit = cyl("mt_conduit", 0.028, 5.30, (-0.135, 0.06, 2.90), verts=14, br=0.004)
    clips = [torus("mt_clip", (-0.135, 0.06, 1.1 + i * 1.25), (0, 1, 0), (0, 0, 1), 0.040, 0.011,
                   maj=14, mino=6) for i in range(4)]
    node([conduit] + clips, "mast_conduit", "dark_poly")


# ───────────────────────────── pad floodlight ─────────────────────────────
def build_flood():
    begin('flood')
    """A 24-up fixture on the pad ring: stem, tilting yoke, heat-sink body behind a glass lens.
    The lens is its own node because the beam rig anchors on it."""
    stem = cyl("flood_stem", 0.045, 0.16, (0, 0, 0.08), verts=18, br=0.004)
    yoke = [cyl("yoke_arm", 0.018, 0.10, (s * 0.115, 0, 0.20), verts=12) for s in (-1, 1)]
    pivot = cyl("yoke_pivot", 0.024, 0.26, (0, 0, 0.245), verts=14, br=0.004,
                rot=(0, math.radians(90), 0))
    body = rbox("flood_body", 0.30, 0.13, 0.20, (0, 0, 0.245), bevel_r=0.018, segs=2,
                rot=(math.radians(-16), 0, 0))
    fins = [rbox("fin", 0.30, 0.012, 0.16, (0, -0.075 + i * 0.03, 0.245), bevel_r=0.004, segs=1,
                 rot=(math.radians(-16), 0, 0)) for i in range(4)]
    node([stem] + yoke + [pivot, body] + fins, "flood", "tap_iron")
    glass = cyl("flood_glass", 0.088, 0.014, (0, 0.028, 0.262), verts=26,
                rot=(math.radians(74), 0, 0))
    bezel = torus("flood_bezel", (0, 0.030, 0.262), (0, 1, 0), (1, 0, 0), 0.094, 0.012, maj=26, mino=6)
    node([glass, bezel], "flood_frame", "dark_poly")
    # The emitting face, named so the caller reads its world position instead of re-deriving an
    # offset — the two floating 44 m cones were a hand-typed number that drifted off the lamp.
    lens = cyl("emitting_face", 0.080, 0.008, (0, 0.036, 0.268), verts=26,
               rot=(math.radians(74), 0, 0))
    lens.data.materials.clear()
    lens.data.materials.append(MAPPED["haz_band"][0])
    lens.name = "flood_lens"
    lens.parent = GROUP
    PARTS.append(lens)


if __name__ == "__main__":
    purge()
    root = empty("site_kit")
    build_stake()
    build_cone()
    build_cover()
    build_cradle()
    build_mast()
    build_mast_tall()
    build_flood()
    for g in GROUPS:
        g.parent = root
    export(root, "site_kit.glb")
    print("SITE_KIT_PARTS", len(PARTS))
    print("SITE_KIT_DONE")
