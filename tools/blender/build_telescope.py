# Blender builder for the observation hill's telescope — the thing the player walks up the rim to
# find, and the reason the night zone has a "press N to skip to midnight" hint next to it.
#
# What the primitives could not do: props.js stood this up as three cylinders — a tapered pier, a
# white tube tipped over at -0.7 rad, and a matte black disc glued on the tube's end at +1.43. The
# disc was the tell. A telescope's business end is an *aperture*: a recessed mirror cell behind a
# dew shield, so the dark you see is set down inside a rim and it is never a flat coin on a stick.
# Everything else that says "an instrument someone aims" was missing too: the fork yoke and azimuth
# ring it sits on, the tube rings and dovetail that hold the tube to the yoke, the counterweight
# bar that keeps a 2.8 m tube from tipping, the focus knobs and the finder scope on top, the
# eyepiece and diagonal at the back, and the grouted circular footing a pier is actually cast into.
#
# Why the tilt is baked: the app used to apply `rotation.x = -0.7` to the tube cylinder only. Here
# the tube is modelled tipped 40 deg toward Blender +Y — which the exporter turns into the app's
# -Z, the same bearing the primitive pointed — so the asset is placed with no rotation at all and
# the yoke, rings and counterweight stay consistent with the tube instead of with the pier.
#
# Five materials, and the merge pass is the reason. props.js batches by material, so each one here
# is one draw call for the instance; the aperture is its own because a mirror that shares a batch
# with the white tube cannot stay dark.
#
# Local frame: z=0 is the top of the graded footing the pier is grouted into, +Z up, the tube aims
# toward +Y as it tips. The app places it by footprint centre, like every other hero here.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_telescope.py
import os, sys, math, bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, torus,
                    empty, purge, export, join)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

MAPPED = {}
for k in ("tap_iron", "tap_soot", "tap_cast", "bar_white"):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0,
                         metal={"tap_iron": 0.86, "tap_soot": 0.45, "tap_cast": 0.12,
                                "bar_white": 0.08}[k]),
                 d["v_m"])

# The primary mirror, seen down the tube: dark, very slightly warm, and non-metallic so it does not
# mirror the noon sun across the whole hill (the flat disc this replaces was matte for that reason).
APERTURE = mat("scope_aperture", (0.035, 0.038, 0.045), rough=0.16, metal=0.0)

PARTS = []
TILT = math.radians(40)          # the tube's elevation above horizontal, baked about the X axis
AX = Vector((0.0, math.sin(TILT), math.cos(TILT)))    # the tube's own axis, in the pier frame
# The tube does not pivot at the ground: the yoke's trunnions sit on top of the azimuth ring, and
# every distance below is measured along the tube from THERE. Reading `aperture.y` off the running
# scene the first time gave 1.4 m — the whole optical train had been modelled through the foot of
# the pier, which is exactly the sort of thing a frame at 40 m cannot show and one number can.
PIVOT = 2.52


def place(o, key):
    m, size = MAPPED[key]
    o.data.materials.clear()
    o.data.materials.append(m)
    uv_cube(o, size)
    PARTS.append(o)
    return o


def along(t, off=(0.0, 0.0, 0.0)):
    """A point on the tube's axis at signed distance `t` from the trunnion, offset across the
    tube's own frame."""
    p = AX * t
    return (off[0] + p.x, off[1] + p.y, PIVOT + off[2] + p.z)


# ───────────────────────────── footing and pier ─────────────────────────────
def build_pier():
    """A cast plinth with a curb, the pier column, and the conduit that feeds the mount."""
    curb = cyl("footing_curb", 0.62, 0.10, (0, 0, 0.05), verts=40, br=0.02)
    slab = cyl("footing_slab", 0.56, 0.16, (0, 0, 0.13), verts=40, br=0.012)
    place(join([curb, slab], "footing"), "tap_cast")
    col = cone("pier", 0.30, 0.40, 1.55, (0, 0, 0.98), verts=36, br=0.018)
    collar = cyl("pier_collar", 0.335, 0.075, (0, 0, 1.76), verts=36, br=0.010)
    place(join([col, collar], "pier"), "tap_iron")
    # The conduit up the pier's lee side, with its clamp band — a mount is powered.
    run = cyl("feed_riser", 0.036, 1.42, (-0.31, 0.16, 0.92), verts=14, br=0.005)
    bend = torus("feed_bend", (-0.24, 0.16, 1.62), (0, 1, 0), (1, 0, 0), 0.10, 0.036, maj=14, mino=8)
    clamp = torus("feed_clamp", (-0.31, 0.16, 0.62), (0, 0, 1), (1, 0, 0), 0.058, 0.018, maj=16, mino=6)
    place(join([run, bend, clamp], "feed"), "tap_soot")


# ───────────────────────────── the mount ─────────────────────────────
def build_mount():
    """Azimuth ring, fork yoke and the counterweight bar on the underside of the tube axis."""
    race = torus("az_ring", (0, 0, 1.83), (0, 0, 1), (1, 0, 0), 0.30, 0.055, maj=40, mino=12)
    base = cyl("yoke_base", 0.26, 0.16, (0, 0, 1.92), verts=32, br=0.02)
    place(join([race, base], "yoke_race"), "tap_cast")
    arms = []
    for s in (-1, 1):
        arm = rbox("yoke_arm", 0.075, 0.20, 0.62, (s * 0.245, 0.02, 2.24), bevel_r=0.022, segs=2)
        piv = cyl("yoke_pivot", 0.062, 0.10, (s * 0.245, 0.0, 2.52), verts=18, br=0.006,
                  rot=(0, math.radians(90), 0))
        arms += [arm, piv]
    place(join(arms, "yoke_arms"), "tap_iron")
    # Counterweight bar and its two slung weights, straight opposite the tube's elevation.
    bar = cyl("cw_bar", 0.042, 1.05, along(-0.72), verts=16, br=0.005,
              rot=(math.degrees(TILT) - 90, 0, 0))
    w1 = cyl("cw_weight", 0.135, 0.11, along(-0.98), verts=24, br=0.014,
             rot=(math.degrees(TILT) - 90, 0, 0))
    w2 = cyl("cw_weight2", 0.115, 0.10, along(-1.16), verts=24, br=0.012,
             rot=(math.degrees(TILT) - 90, 0, 0))
    place(join([bar, w1, w2], "counterweight"), "tap_soot")


# ───────────────────────────── the tube ─────────────────────────────
def build_tube():
    """Optical tube, dew shield, the cell it is screwed into, and the aperture set down inside."""
    body = cyl("tube", 0.215, 2.10, along(0.28), verts=40, br=0.014,
               rot=(math.degrees(TILT) - 90, 0, 0))
    # Dew shield: a slightly wider short cylinder over the front, so the silhouette tapers forward.
    shield = cyl("dew_shield", 0.245, 0.46, along(1.52), verts=40, br=0.012,
                 rot=(math.degrees(TILT) - 90, 0, 0))
    cell = cyl("mirror_cell", 0.235, 0.14, along(-0.86), verts=40, br=0.010,
               rot=(math.degrees(TILT) - 90, 0, 0))
    place(join([body, shield, cell], "tube"), "bar_white")
    # The aperture: recessed 70 mm inside the shield's mouth, so what reads from the hill is a dark
    # disc with a rim of shadow around it, not a coin on the end of a stick.
    glass = cyl("aperture", 0.185, 0.02, along(1.30), verts=32)
    glass.data.materials.clear()
    glass.data.materials.append(APERTURE)
    PARTS.append(glass)
    # Baffle rings inside the shield — three thin annuli that catch the light at the mouth.
    rings = [torus("baffle", along(1.36 + 0.05 * i), AX.to_tuple(), (0, 1, 0), 0.225 - 0.008 * i,
                   0.010, maj=28, mino=6) for i in range(3)]
    place(join(rings, "baffles"), "tap_soot")


def build_fittings():
    """Tube rings, the dovetail bar they clamp to, a handle, the focuser, finder and eyepiece."""
    rings = []
    for t in (0.62, -0.22):
        rings.append(torus("ring", along(t), AX.to_tuple(), (0, 1, 0), 0.235, 0.028, maj=32, mino=8))
    shoe = rbox("dovetail", 0.30, 0.10, 0.055, along(-0.02, off=(0, 0, -0.24)), bevel_r=0.012, segs=2)
    place(join(rings + [shoe], "tube_rings"), "tap_iron")
    # Handle across the top of the tube, forward of the rings, so the instrument can be carried.
    grip = cyl("handle", 0.026, 0.34, along(0.30, off=(0, 0, 0.27)), verts=14, br=0.006,
               rot=(0, math.radians(90), 0))
    posts = [cyl("post", 0.022, 0.11, (along(0.30)[0] + s * 0.17, along(0.30)[1], along(0.30)[2] + 0.16),
                 verts=12) for s in (-1, 1)]
    place(join([grip] + posts, "handle"), "tap_soot")
    # Focuser assembly at the back: a rack tube, a lock screw and two knurled knobs.
    foc = cyl("focuser", 0.075, 0.24, along(-1.02, off=(0, 0, 0.16)), verts=22, br=0.008,
              rot=(math.degrees(TILT) - 90 + 90, 0, 0))
    diag = cyl("diagonal", 0.062, 0.13, along(-1.12, off=(0, 0, 0.30)), verts=18, br=0.008)
    eye = cyl("eyepiece", 0.045, 0.16, along(-1.12, off=(0, 0, 0.42)), verts=16, br=0.006)
    knobs = [cyl("knob", 0.038, 0.026, (along(-1.02)[0] + s * 0.09, along(-1.02)[1], along(-1.02)[2] + 0.16),
                 verts=14, br=0.004, rot=(0, math.radians(90), 0)) for s in (-1, 1)]
    place(join([foc, diag, eye] + knobs, "focuser"), "tap_cast")
    # Finder scope on a dovetail above the tube, aimed 2 deg high so it reads as aligned by eye.
    fd = along(0.72, off=(0.10, 0, 0.26))
    finder = cyl("finder", 0.045, 0.52, fd, verts=22, br=0.008,
                 rot=(math.degrees(TILT) - 92, 0, 0))
    mounts = [cyl("finder_mount", 0.018, 0.12, (fd[0] + s * 0.10, fd[1], fd[2] - 0.07), verts=12)
              for s in (-1, 1)]
    place(join([finder] + mounts, "finder"), "tap_iron")


if __name__ == "__main__":
    purge()
    root = empty("telescope")
    build_pier()
    build_mount()
    build_tube()
    build_fittings()
    for o in PARTS:
        o.parent = root
    export(root, "telescope.glb")
    print("TELESCOPE_PARTS", len(PARTS))
    print("TELESCOPE_DONE")
