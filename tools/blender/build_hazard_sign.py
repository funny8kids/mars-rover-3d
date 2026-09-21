# Blender builder for the leak-field hazard placard — the 2.2 × 1.1 m board that marks the
# propulsion leak out on the sand.
#
# What the primitives could not do: this was two `box()`s hung at `deck + 1.5` in props.js, a
# dark slab with a hazard stripe in front of it and nothing reaching the ground. It read as a
# floating rectangle — the same complaint the whole B series exists to answer. A placard that
# big is a *structure*: it stands on two galvanised posts bolted into cast footings, it carries
# a folded aluminium frame around the laminate, a visor above it because the sun is the reason
# nobody can read a sign at 14:00, and a drip lip below because that is where the saltation
# leaves its line.
#
# Why the graphic lives in a texture and not in geometry: the print is 20 mm of black enamel on
# a 2.2 m plate. Modelled as geometry that is 110 separate meshes for one lettering job; in a
# normal map it is a relief you can see the sun catch. `rsbtex.sign_face_maps` forges the whole
# face at the panel's exact metres, and this file gives it planar UVs so it lands 1:1.
#
# Four materials, not nine. props.js merges the prop by material, so each one here is one draw
# call in the field: galvanised white tube, sooted fittings, cast footing, and the printed face.
#
# Local frame: z=0 is grade, the face looks toward Blender +Y (which exports to the app's -Z),
# and the run is symmetric about x=0. The app aims it with `atan2(dx, dz) + PI` — the +PI is
# that +Y convention, and every other hero in this directory has the same one.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_hazard_sign.py
import os, sys, math, bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat, mat_pbr, textures, uv_cube, rbox, ball, cyl, cone, empty,
                    purge, export)

bpy.ops.wm.read_factory_settings(use_empty=True)
TEX = textures()

# The three structural fields are the barrier kit's, imported rather than re-forged: a sign on
# a kerb in the same district has to weather the same way or the two read as different worlds.
MAPPED = {}
for k, metal in (("bar_stripe", 0.06), ("bar_white", 0.08), ("bar_soot", 0.55),
                 ("bar_cast", 0.04)):
    d = TEX[k]
    MAPPED[k] = (mat_pbr(k, d["maps"], rough=1.0, metal=metal), d["v_m"])

# The one non-tiling field in the set. It is a graphic, so it gets planar UVs from `uv_face`
# below and never sees `uv_cube` — cube projection is measured from the world origin, which
# would land a different slice of the lettering on the plate depending on where it stands.
FACE = mat_pbr("hazard_face", TEX["hazard_face"]["maps"], rough=1.0, metal=0.05)

FLAT = {
    # Unlit glass-bead reflectors, same contract as the barrier's: `light_` hands them to the
    # day/night drive, so they go amber-dark by day and glow by night without any code here.
    "hot": mat("light_sign_reflector", (0.24, 0.09, 0.02), rough=0.32, metal=0.0,
               emis=(1.0, 0.36, 0.10), estr=0.9),
}

# The panel, as bought: 2 240 × 1 140 mm of laminate in a folded frame, its middle 1 500 mm off
# the ground — the height a driver on the seat reads a placard at, and the height the old
# runtime box already hung it at, so the sightline down the approach does not change.
PW, PH, PZ = 2.24, 1.14, 1.50
LEG_X, LEG_TOP = 0.62, 2.10

PARTS = []


def place(o, key, tile=None):
    o.data.materials.clear()
    if key == "face":
        o.data.materials.append(FACE)
    elif key in MAPPED:
        m, vm = MAPPED[key]
        o.data.materials.append(m)
        uv_cube(o, tile or vm)
    else:
        o.data.materials.append(FLAT[key])
    PARTS.append(o)
    return o


def uv_face(o, w_m, h_m, scrap=(0.114, 0.909)):
    """Planar UVs on the front face, and every other loop pinned to one clean texel of the
    field. A placard is the one asset here whose map does not tile: cube-projected, the 12 mm
    rim would sample a wrapped copy of the lettering, and a sign with a stripe of upside-down
    text down its edge is worse than a sign with no edge at all."""
    uvl = o.data.uv_layers.active
    for poly in o.data.polygons:
        front = poly.normal.y > 0.90
        for li in poly.loop_indices:
            co = o.data.vertices[o.data.loops[li].vertex_index].co
            # The face is authored toward Blender +Y, which exports to the app's -Z, and U has to
            # run *against* +X for the legend to read left-to-right from the viewer's side. This is
            # measured, not argued: with `co.x / w_m + 0.5` the rendered board read "ЯEGNAᗡ".
            uvl.data[li].uv = ((0.5 - co.x / w_m, co.z / h_m + 0.5) if front else scrap)
    return o


def build_foot():
    for sx in (-1, 1):
        # A cast pad rather than a dowel in the sand: 170 mm of it sits below grade, so when the
        # app seats this on a sampled dune the footing is buried, not hovering.
        place(rbox("footing", 0.40, 0.40, 0.34, (sx * LEG_X, 0, -0.07), None,
                   bevel_r=0.035, segs=2), "bar_cast")
        place(rbox("plate", 0.22, 0.22, 0.018, (sx * LEG_X, 0, 0.108), None,
                   bevel_r=0.005, segs=1), "bar_soot")
        for ax in (-1, 1):
            for ay in (-1, 1):
                place(cyl("anchor", 0.024, 0.034,
                          (sx * LEG_X + ax * 0.078, ay * 0.078, 0.134), None,
                          verts=6, br=0.0), "bar_soot")
        # Welded ribs at the heel of the tube, the same fitting the barrier posts carry.
        for k in range(4):
            a = k * math.pi / 2 + math.pi / 4
            place(rbox("rib", 0.018, 0.13, 0.16,
                       (sx * LEG_X + math.sin(a) * 0.055, math.cos(a) * 0.055, 0.155), None,
                       bevel_r=0.005, segs=1, rot=(0, 0, a)), "bar_soot")


def build_frame():
    for sx in (-1, 1):
        place(rbox("leg", 0.090, 0.090, LEG_TOP - 0.10, (sx * LEG_X, 0, (LEG_TOP + 0.10) / 2),
                   None, bevel_r=0.010, segs=2), "bar_white")
        place(rbox("splice", 0.104, 0.104, 0.07, (sx * LEG_X, 0, 1.16), None,
                   bevel_r=0.010, segs=2), "bar_soot")
        place(cyl("cap", 0.050, 0.026, (sx * LEG_X, 0, LEG_TOP + 0.012), None,
                  verts=12, br=0.008), "bar_soot")
    # The stretcher is what makes two posts into one frame, and it sits low enough to clear the
    # dust it is standing in.
    place(rbox("stretcher", 2 * LEG_X + 0.10, 0.060, 0.050, (0, 0, 0.62), None,
               bevel_r=0.010, segs=2), "bar_white")


def build_panel():
    # The plate itself: 30 mm of composite panel, then the printed laminate bonded over it.
    place(rbox("body", PW - 0.04, 0.030, PH - 0.04, (0, 0.060, PZ), None,
               bevel_r=0.006, segs=1), "bar_white")
    face = place(rbox("laminate", PW - 0.04, 0.012, PH - 0.04, (0, 0.081, PZ), None,
                      bevel_r=0.004, segs=1), "face")
    uv_face(face, TEX["hazard_face"]["u_m"], TEX["hazard_face"]["v_m"])

    # ── the folded frame: four members of the same channel, overlapping the laminate's edge ──
    for z, sx_, sz_ in ((PZ + PH / 2 - 0.017, PW, 0.034), (PZ - PH / 2 + 0.017, PW, 0.034)):
        place(rbox("rail", sx_, 0.060, sz_, (0, 0.075, z), None, bevel_r=0.008, segs=1),
              "bar_white")
    for sx in (-1, 1):
        place(rbox("stile", 0.034, 0.060, PH, (sx * (PW / 2 - 0.017), 0.075, PZ), None,
                   bevel_r=0.008, segs=1), "bar_white")

    # ── the visor, on tabs off the legs so it is carried by the frame and not by the panel ──
    place(rbox("visor", PW, 0.26, 0.016, (0, 0.185, PZ + PH / 2 + 0.115), None,
               bevel_r=0.006, segs=1, rot=(-0.32, 0, 0)), "bar_soot")
    for sx in (-1, 1):
        place(rbox("visor_tab", 0.050, 0.085, 0.13, (sx * LEG_X, 0.085, PZ + PH / 2 + 0.035),
                   None, bevel_r=0.006, segs=1), "bar_soot")
    # The drip lip: an inward fold at the foot of the board, which is exactly where the
    # saltation line in the face map says the grit stops.
    place(rbox("drip", PW - 0.06, 0.055, 0.014, (0, 0.078, PZ - PH / 2 - 0.020), None,
               bevel_r=0.005, segs=1, rot=(0.55, 0, 0)), "bar_soot")

    # ── reflectors on the frame's foot, one to each side of the lane it closes ──
    for sx in (-1, 1):
        place(rbox("reflector", 0.062, 0.014, 0.044, (sx * 0.86, 0.112, PZ - PH / 2 + 0.017),
                   None, bevel_r=0.004, segs=1), "hot")


if __name__ == "__main__":
    purge()
    root = empty("hazard_sign")
    build_foot()
    build_frame()
    build_panel()
    for o in PARTS:
        o.parent = root
    export(root, "hazard_sign.glb")
    print("SIGN_PARTS", len(PARTS))
    print("HAZARD_SIGN_DONE")
