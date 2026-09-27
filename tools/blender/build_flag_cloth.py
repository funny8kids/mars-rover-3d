# Blender builder for the plaza flag's cloth — the one prop the census still excused.
#
# What the primitive could not do: `PlaneGeometry(2.3, 1.35, 14, 6)` with a written-in loop
# (`sin(u*7.4) * 0.11 + u**2.4 * 0.20`) is a sheet whose ripple is one sine at one wavelength and
# whose droop is one power law. Real bunting on a hoist solves: the weight pulls the fly edge down
# along a catenary, the wind runs waves whose wavelength changes across the panel, and the two
# together put diagonal creases from the hoist corners into the field. None of that is a function of
# u alone, and the creases are the part the eye reads as fabric.
#
# So the shape here is *simulated*, not authored: the hoist edge is held on the halyard line,
# gravity pulls, a wind field blows toward +X with turbulence, and the builder walks the frame range
# until the sheet's own mean has stopped drifting — one second of fly-edge height matching the
# second before it — then freezes the frame whose silhouette carries that window's mean angle.
# Settled cannot mean still here: a flag in a steady wind carries travelling waves for as long as the
# wind does, and those waves are the thing being bought. The criterion is about the mesh, not about a
# timestamp, and it is about a window rather than a frame — see SETTLE_WIN.
#
# Two numbers are chosen by hand: the fabric's mass and the wind's strength. The strength is picked
# by a sweep against a measured angle (printed as SWEEP rows), not by eye, and the target is the
# angle the plane already showed — its droop was 0.26 m of fall over 2.3 m of fly, 6.4 deg. Holding
# that is deliberate: the flag's silhouette against the plaza sky is what every frame the hub
# appears in was composed around, and this ticket is about the cloth reading as cloth.
#
# What stays in props.js: the flag's painted face. The 460x270 canvas carries the insignia, the
# stitched hem and the sun-bleach, and it is attached to this asset's material at load the way the
# telemetry board's live face reaches its screen mesh. Weave is neither modelled nor forged: at the
# plaza's nearest vantage a 1.6 mm thread is 0.07 px, so a weave field would rasterise to noise —
# the reasoning in build_flagmast.py's header, applied to fabric.
#
# Local frame — matches build_flagmast.py's, so the two assets meet without an arithmetic step:
# +Z is up, +X is the fly direction, +Y is the ripple/depth axis, and the export maps
# Blender (x, y, z) -> app (x, z, -y). The ORIGIN is the hoist edge's top corner, i.e. the head of
# the flag where the halyard leaves the mast's sheave, because that is the one point a flag is
# actually rigged by; the cloth runs x 0 -> +2.30 and z 0 -> -1.35. `recentre()` in
# src/world/assets.js shifts X and Z to the footprint centre, so the asset opts out via NO_RECENTRE
# the same way `lox_stand` does: the authored datum is the rigging point, not a bbox centre.
#
# Run: blender --background --python tools/blender/build_flag_cloth.py
import bpy, bmesh, math, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import mat, empty, purge, export, solidify, act, compact_materials

bpy.ops.wm.read_factory_settings(use_empty=True)

W, H = 2.30, 1.35              # the cloth the plaza flies today, in metres
NU, NV = 70, 40                # ~33 mm cells: six cells across a 200 mm wave, which is what a
#                              solver needs before a crease stops being a staircase
MASS = 0.46                    # kg — 150 g/m^2 banner cloth over the 3.1 m^2 panel
BENDING = 0.35                 # the solver's resistance to curvature, on a 0.5 default for an
#                              ordinary cloth sheet. Kept low because banner cloth is low: measured
#                              across bending 1.5 / 6.0 / 25.0 (2026-09-27) the mean fly angle moved
#                              by about a degree and a half at a given wind and the reach stayed
#                              between 1.83 and 1.97 m, so stiffness is not what sets the shape —
#                              the wind is. What it did not buy is the quietness: the sheet swinging
#                              tens of degrees inside a one-second window is the flow, and the sweep
#                              has to find the arms where that swing is small rather than assume it.
BEND_DAMP = 5.0                # `bending_damping`, the solver's loss on curvature springs. There is
#                              no `damping` field on this Blender's cloth (the rig's `setp` refused it:
#                              56 writable fields, and the dissipation ones are air_damping, the three
#                              stiffness damplings and internal_friction), and a flag's flutter is a
#                              bending wave, so this is the field that can quiet the flutter without
#                              changing what the wind holds the sheet at. Measured 2026-09-27 as
#                              damping @ wind -> fly-deg, window-to-window drift, reach, ripple:
#                              0.5 @ 90 000 -> 8.68, 4.60, 1.916 m, 108 mm (flap 45.3: a gust's mean)
#                              5.0 @ 90 000 -> 5.39, 0.65, 2.030 m,  83 mm
#                              5.0 @ 30 000 -> 10.73, 1.81, 2.000 m,  86 mm
#                             20.0 @ 90 000 -> 2.37, 2.27, 2.070 m, 104 mm (over-flown past the target)
#                             20.0 @ 30 000 -> 9.83, 0.85, 1.956 m, 117 mm
#                              Ten times the default buys the quiet arm and keeps the waves; it is a
#                              fabric property, not a knob on the wind or on the gate.

SEED_MM = 25.0                 # the crumple the sheet is hoisted with, largest at the fly edge. The
#                              solver's wind pushes only on faces angled to the flow, so a perfectly
#                              flat sheet aligned with the wind has nothing for the wind to blow on:
#                              measured, a flat panel hung at the identical angle at every strength
#                              from 30 to 800. A real flag is never hoisted flat either.
FPS = 60
FRAME_MAX = 300                # 5 s of solved cloth; the builder stops at the steady window
SETTLE_WIN = 60                # frames — one second of fly-edge mean, the shortest window over
#                              which "stopped drifting" can be said at all. The first version of this
#                              test compared 12 frames, and on a sheet whose flap period is a third
#                              of a second that is a sample of the gust, not a reading of the state:
#                              the sweep it produced hung the banner at 64.9 deg at strength 300,
#                              73.0 at 1000, 90.0 (folded upwind, reach −0.46 m) at 3000 and 25.7 at
#                              10000, i.e. four single frames of one flag flapping.
DRIFT_MM = 5.0                 # two consecutive windows agree to this on the fly edge's mean height
SPAN = 60                      # frames of steady state sampled before one is frozen
G_MARS = (0.0, 0.0, -3.71)     # m/s^2 — the acceleration this world has: the cloth hangs the way it
#                              would hang here. It has to be written to `scene.gravity`, not to the
#                              modifier: measured 2026-09-27 on this Blender, `ClothSettings.gravity`
#                              is inert. With `scene.gravity` at −9.81 the fly edge drooped 1.3473 m
#                              by frame 60 for every value of the modifier's own gravity (0, −3.71
#                              and −9.81 alike), and 0.0000 m with `scene.gravity` at 0.

SWEEP = (10000.0, 30000.0, 65000.0, 90000.0)
# The effector's strength is not a pressure: it is a number the solver scales by face area and
# divides by mass in units of its own. So the sweep has to be wide enough to cross from "the load
# wins" to "the flow wins" rather than stepping politely — the first version of this list ran 30 to
# 800, and every one of those six hung the banner in the same fold against the mast, which is a
# reading about the range, not about the wind. With BEND_DAMP at 5.0 the curve the sweep has to
# bracket is 35.7 deg / reach 1.47 m at 10 000 (a hanging flag, and the control that keeps the
# reach gate honest), 10.7 deg at 30 000, 5.4 deg at 90 000, and 2.4 deg at 90 000 when the damping
# is pushed to 20 — so the plaza's 6.4 deg lives between 30 000 and 90 000 and nothing below
# 10 000 is worth sweeping at all.
TARGET_DEG = 6.4               # the plane's own droop angle, measured before this script existed
TOL_DEG = 2.5                  # how near the sweep has to land before a shape is accepted
ANGSTAB_MAX = 3.0              # deg the window mean of the fly angle may move between two
#                              consecutive one-second windows and still be called a state. Measured
#                              on the 2026-09-27 sweep: the arms whose mean is a gust drift 4.60 and
#                              6.09 deg window to window, the arms whose mean is a state drift 0.65,
#                              0.85, 1.81 and 2.27. TOL_DEG is 2.5, so an arm that cannot repeat its
#                              own mean to better than the tolerance it is judged by is not being
#                              measured, it is being sampled — and this line is what says so.
REACH_MIN = 1.80               # metres the fly edge has to stand downwind of the mast for the sheet
#                              to count as extended. The first version asked for 0.90 * W = 2.07 m and
#                              that number was wrong in units, so it refused a flag that was flying:
#                              the reach is a *projection*, so a banner of arc length W held at angle
#                              theta can never project more than W * cos theta (2.27 m at the target's
#                              8.9 deg), and the ripples eat another 11-21 % of that. The four states
#                              measured on this rig — 0.91 m folded against the mast, 1.48 m hanging at
#                              35.5 deg, 1.87 m and 2.00 m flying at 19 deg and 11.6 deg — put the line
#                              between the hanging band and the flying band at 1.80 m, and the control
#                              run below makes the hanging arm refuse on it.
EXPORT_TOL_DEG = 0.05          # deg / m the shape may move between the capture and the mesh that
EXPORT_TOL_M = 0.005           #      gets exported. Sized against the only drift ever measured here:
#                              run 10 captured its frozen frame at 6.04 deg / 1.879 m and exported
#                              6.02 / 1.879, so the hem plus the 1.6 mm shell cost 0.02 deg and none
#                              of the reach. The bar is a bit over twice that, and the metre bar is
#                              five of the millimetres this print resolves to while the measured cost
#                              is zero of them. The rig repeats tighter than either bar: runs 8 and 10
#                              print an identical export reading, 6.02 deg / 1.88 m / 74.3 mm, from
#                              two independent solver passes. The pair that must refuse is the one the
#                              old print confused — the window mean against the frame — 5.39 deg /
#                              2.030 m vs 6.02 / 1.879.


def setp(obj, name, val):
    """Set a solver property or stop and say so. A misspelled stiffness would otherwise fall back
    to a default in silence, and the flag would be made of some other cloth."""
    pr = next((p for p in obj.bl_rna.properties if p.identifier == name and not p.is_readonly), None)
    if pr is None:
        raise SystemExit("FLAG_CLOTH_NO_PROPERTY %s.%s — this Blender's solver has no such field"
                         % (type(obj).__name__, name))
    if pr.type == 'ENUM' and val not in {i.identifier for i in pr.enum_items}:
        raise SystemExit("FLAG_CLOTH_BAD_ENUM %s.%s=%s — the items are %s"
                         % (type(obj).__name__, name, val, sorted(i.identifier for i in pr.enum_items)))
    try:
        setattr(obj, name, val)
    except TypeError as e:
        raise SystemExit("FLAG_CLOTH_SET_FAILED %s.%s=%r — %s" % (type(obj).__name__, name, val, e))


def panel_mesh():
    """The sheet as it is hoisted, with the printed face's UVs and the hoist edge in a vertex group.

    The y-offset is the crumple, not decoration: the solver's wind loads a face in proportion to how
    much of it the flow sees, so a laser-flat panel aligned with the wind has no angle of attack
    anywhere and never catches — see SEED_MM."""
    bm = bmesh.new()
    rows = []
    for j in range(NV + 1):
        z = -H * j / NV
        row = []
        for i in range(NU + 1):
            x = W * i / NU
            y = SEED_MM / 1000.0 * (i / NU) ** 1.5 * math.sin(3.0 * math.pi * i / NU + 0.7 * j)
            row.append(bm.verts.new((x, y, z)))
        rows.append(row)
    for j in range(NV):
        for i in range(NU):
            bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))
    uv = bm.loops.layers.uv.active or bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = (co.x / W, (co.z + H) / H)   # v = 1 at the head, 0 at the foot
    me = bpy.data.meshes.new("flag_cloth")
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("flag_cloth", me)
    bpy.context.collection.objects.link(o)
    vg = o.vertex_groups.new(name="hoist")
    vg.add([v.index for v in me.vertices if v.co.x < W / NU * 0.5], 1.0, 'REPLACE')
    return o


def wind(strength):
    """A wind field blowing toward +X: Blender's field emits along its own +Z, so a 90 deg turn
    about Y points it down the fly direction. `noise` is the turbulence that starts the waves and
    `seed` is fixed, so a rebuild lands on the same cloth rather than on a new gust.

    The sphere is sized to cover the panel rather than to gust across it: the authored corner farthest
    from the field's centre is 1.333 m away, and a probe at size 1.60 against size 4.00 returned
    droop and ripple identical to three decimals — the cloth flies in one wind, which is what a 2.3 m
    flag in a plaza-scale flow does."""
    bpy.ops.object.effector_add(type='WIND', location=(W / 2.0, 0.0, -H / 2.0),
                                rotation=(0.0, math.pi / 2.0, 0.0))
    fo = bpy.context.object
    fo.name = "wind"
    for k, v in (("strength", strength), ("noise", 0.55), ("seed", 7), ("flow", 1.0),
                 ("falloff_type", 'SPHERE'), ("size", 1.60)):
        setp(fo.field, k, v)
    return fo


def rigged(strength):
    """A fresh panel with the solver and the wind on it. Rebuilt per pass, because the two passes
    below have to agree on a shape rather than share a cache."""
    o = panel_mesh()
    md = o.modifiers.new("cloth", 'CLOTH')
    s = md.settings
    for k, v in (("quality", 16), ("mass", MASS), ("air_damping", 0.8),
                 ("bending_damping", BEND_DAMP),
                 ("tension_stiffness", 22.0), ("compression_stiffness", 22.0),
                 ("shear_stiffness", 12.0), ("bending_stiffness", BENDING),
                 ("bending_model", 'LINEAR'), ("internal_friction", 0.4),
                 ("collider_friction", 0.5), ("vertex_group_mass", "hoist")):
        setp(s, k, v)
    # `vertex_group_mass` is the rigging point, and it is not what its name says. This Blender has no
    # pin group on the cloth at all — `ClothSettings` exposes `pin_stiffness` and the `goal_*` scalars
    # but no `vertex_group_pinning`, and the only group fields are mass, structural/shear/bending
    # stiffness, shrink, pressure, intern and the two collision ones. Measured the difference between
    # the two readings of that field: with the hoist column at weight 1.0 its mean distance from the
    # authored position is 0.0000 m at frames 10, 30, 60, 90 and 120 while the same sheet with no
    # group is 1.54 m away by frame 30 and 15.89 m by frame 120. So weight 1 is a hard hold, not a
    # heavier vertex — which is the only thing a mass could not do, because gravity accelerates a
    # heavy vertex at exactly the same rate as a light one.

    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.gravity = G_MARS
    scene.frame_start = 1
    scene.frame_end = FRAME_MAX
    return o, wind(strength)


def read(o):
    """The evaluated sheet at the current frame, as plain tuples."""
    me = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    return [(v.co.x, v.co.y, v.co.z) for v in me.vertices]


# The fly edge, the hoist head and the rippled field are named by their column in the authored grid,
# never by where they happen to sit: a sheet hanging in a light wind loses horizontal extent, and a
# test like `x > W - 0.02` then quietly stops matching anything.
FLY_COL = [j * (NU + 1) + NU for j in range(NV + 1)]
HEAD_COL = [j * (NU + 1) for j in range(NV + 1)]
FIELD_COL = [i for i in range((NU + 1) * (NV + 1)) if (i % (NU + 1)) * W / NU > 0.25]


def readings(co):
    """Three readings off a solved shape, each one about the sheet rather than about a timestamp:

    angle — the mean over the hoist-to-fly lines. This is the silhouette the plaza frames against.
      The ruler here used to be the fly column's mean height below the flat sheet, and on one and the
      same solve the two read 36.45 deg and 14.8 deg: the column mean cannot tell a banner streaming
      out with a sagging leech from one collapsed against the mast, because the hoist corners it
      averages over are pinned and never move.
    reach — how far downwind the fly edge has actually travelled, out of the 2.30 m authored. A flag
      at a small angle that reaches 0.9 m is hanging in a fold, not flying, and no angle says so.
    ripple — mean |y| across the field, which is what says the sheet is cloth and not a hinge."""
    ang = [math.degrees(math.atan2(co[h][2] - co[f][2], max(co[f][0] - co[h][0], 1e-6)))
           for h, f in zip(HEAD_COL, FLY_COL)]
    deep = [abs(co[i][1]) for i in FIELD_COL]
    return (sum(ang) / len(ang), sum(co[f][0] for f in FLY_COL) / len(FLY_COL),
            sum(deep) / len(deep))


def fly_mean_z(co):
    """The only statistic the settle test needs: how high the fly edge is riding. Motion, not shape."""
    return sum(co[i][2] for i in FLY_COL) / len(FLY_COL)


# Settled here does not mean still. A flag in a steady wind carries travelling waves for as long as
# the wind does, so no vertex ever stops; what stops is the mean droop. So the criterion is on the
# fly edge's mean height over a SETTLE_WIN window, and the frame frozen is the one whose own angle
# sits nearest that window's mean — the silhouette the plaza reads, from inside the frames whose
# ripple depth is not an outlier.
def wmean(d, a, b):
    """Mean of a per-frame reading over frames a..b inclusive."""
    return sum(d[k] for k in range(a, b + 1)) / (b - a + 1)


def solve(strength):
    """Fly the sheet in this wind and measure the frames that represent the steady state.

    Settled is a property of the mesh, not of a clock: the fly edge's mean height over one second has
    to match the second before it. Which is also why the numbers this returns are window means: a
    flag carries travelling waves for as long as the wind does, so no single frame is the shape, and
    a SETTLE_WIN window is one second — a few flap periods. The frozen frame — the one whose angle
    sits nearest its window's mean, from among the frames whose ripple depth is not an outlier — is
    what gets exported, and the flap and ang_dev columns are what say how honest that one frame is.
    """
    o, w = rigged(strength)
    scene = bpy.context.scene
    ride, ang, reach, rip, onset = {}, {}, {}, {}, None
    f = 1
    for f in range(1, FRAME_MAX + 1):
        scene.frame_set(f)
        co = read(o)
        ride[f] = fly_mean_z(co)
        ang[f], reach[f], rip[f] = readings(co)
        if onset is None:
            if f >= 2 * SETTLE_WIN and abs(wmean(ride, f - SETTLE_WIN + 1, f)
                                           - wmean(ride, f - 2 * SETTLE_WIN + 1, f - SETTLE_WIN)
                                           ) * 1000.0 < DRIFT_MM:
                onset = f
        elif f >= onset + SPAN:
            break
    bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.objects.remove(w, do_unlink=True)
    b1 = f
    b0 = b1 - SETTLE_WIN + 1
    a0 = b0 - SETTLE_WIN
    a1 = b0 - 1
    win = list(range(b0, b1 + 1))
    mean_rip = wmean(rip, b0, b1)
    mean_ang = wmean(ang, b0, b1)
    # The frame that gets frozen is chosen for its SILHOUETTE. The plaza reads the banner's outline,
    # so the still has to carry the window-mean angle, not merely a typical depth: the first version
    # of this line took the ripple-typical frame, and on the arm this sweep settles on the window's
    # flap is 22.68 deg peak-to-peak, so a median-depth frame sits ~11 deg from the mean the whole
    # table quotes. Ripple stays as a filter rather than the key — the candidate set is the frames
    # within half the window's own ripple spread, so a gust's peak is still not eligible — and among
    # those the angle decides. `ang_dev` is how far the export still is from the quoted mean.
    spread = max(rip[k] for k in win) - min(rip[k] for k in win)
    cand = [k for k in win if abs(rip[k] - mean_rip) <= spread * 0.5] or win
    freeze = min(cand, key=lambda k: abs(ang[k] - mean_ang))
    # `ang±` and `rch±` are the reading of the reading: the mean of the window before this one
    # subtracted from the mean of this one. A window mean is only a state if two consecutive
    # windows agree, and the sweep's first tables showed the angle plateauing at 11-12 deg from
    # 30 000 to 65 000 and then dropping to 8.4 at 90 000 — a curve with a flat run and a step is
    # the signature of comparing gusts, so no arm is accepted on its mean until the drift of that
    # mean is on the same page as the mean.
    return {"strength": strength, "settled": onset is not None,
            "ang": wmean(ang, b0, b1), "reach": wmean(reach, b0, b1),
            "ripple": mean_rip,
            "flap": max(ang[k] for k in win) - min(ang[k] for k in win),
            "ang_drift": abs(wmean(ang, a0, a1) - wmean(ang, b0, b1)),
            "reach_drift": abs(wmean(reach, a0, a1) - wmean(reach, b0, b1)),
            "ang_f": ang[freeze], "reach_f": reach[freeze], "rip_f": rip[freeze],
            "ang_dev": abs(ang[freeze] - mean_ang),
            "onset": onset or 0, "freeze": freeze, "frames": b1}


def capture(strength, freeze):
    """Re-solve and keep the sheet at the frame `solve` picked.

    Stepped one frame at a time like the sweep, not jumped to: `frame_set(148)` on a cold cache and
    148 steps of `frame_set(1..148)` are two different pieces of cloth. Measured on the same wind —
    the jump leaves the banner streamed out to x 2.20 m with a 5 mm ripple, the stepping folds it
    against the mast at x 0.91 m with a 93 mm one. The second is the solve, so the second is what
    gets exported, and the check in __main__ is what says the two passes agree."""
    o, w = rigged(strength)
    scene = bpy.context.scene
    for f in range(1, freeze + 1):
        scene.frame_set(f)
    co = read(o)
    bpy.data.objects.remove(w, do_unlink=True)
    return o, co


def bake(o, verts):
    """Write the solved shape onto the object and drop the modifier, so the hem below works on real
    coordinates instead of an evaluated copy."""
    for v, co in zip(o.data.vertices, verts):
        v.co = co
    o.data.update()
    act(o)
    for md in list(o.modifiers):
        o.modifiers.remove(md)
    return o


def hem(o, width=0.026, proud=0.003):
    """Turn the three free edges back on themselves. A flag's leech is not a cut end: it is a corded
    hem, and the cord is what holds that edge straight while the field waves behind it. The hoist
    edge is left alone because it is sewn round the halyard instead.

    Each boundary edge is extruded along its own in-plane outward direction — the cross product of
    the edge with the normal of the one face it belongs to, signed by which way is away from that
    face's centre, so a wave cannot fold the hem back through the sheet."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    turned = 0
    for e in [e for e in bm.edges if e.is_boundary and e.link_faces]:
        a, b = e.verts
        if a.co.x < 0.005 and b.co.x < 0.005:
            continue                       # the hoist: rigged, not hemmed
        f = e.link_faces[0]
        out = (b.co - a.co).normalized().cross(f.normal)
        if (f.calc_center_median() - (a.co + b.co) * 0.5).dot(out) > 0:
            out = -out
        res = bmesh.ops.extrude_edge_only(bm, edges=[e])
        for el in res["geom"]:
            if isinstance(el, bmesh.types.BMVert):
                el.co += out * width + f.normal * proud
        turned += 1
    bm.normal_update()
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return turned


def certify(cap, out):
    """Refuse the export unless the mesh about to be written is the frame that was chosen.

    `cap` is the (deg, m) reading of the captured solve, `out` the same reading taken off the
    evaluated mesh after the hem and the 1.6 mm shell. A pure function of two pairs so that
    `probe_flag_gates.py` can drive it both ways — the honest build hands it a pair that agrees, and
    the probe hands it the frame-vs-window pair the old print confused (6.04/1.880 against
    5.39/2.030), which has to refuse. Without that second case this gate is one comparison nobody
    has ever seen fail.
    """
    if abs(out[0] - cap[0]) > EXPORT_TOL_DEG or abs(out[1] - cap[1]) > EXPORT_TOL_M:
        raise SystemExit(
            "FLAG_CLOTH_EXPORT_MOVED capture=%.3f deg/%.3f m exported=%.3f deg/%.3f m — either the "
            "hem or the 1.6 mm shell moved the solved sheet, or the evaluated mesh no longer starts "
            "with the solve grid's rows and this reading is addressing the wrong vertices"
            % (cap[0], cap[1], out[0], out[1]))


def accept(rows):
    """Read a sweep table and name the one arm worth exporting, or refuse with a named cause.

    A pure function of the rows, and that is the whole reason it is a function: the shipped sweep
    lands one flying-quiet arm and refuses the rest for one specific reason each, so two of the
    branches below would never be entered by a real build. `probe_flag_gates.py` drives each of them
    with rows copied from the measured sweeps and requires the named message, so a mutated comparison
    is caught even though the honest build never walks that branch. Every value here is a window mean
    printed in the SWEEP table, not a frame.
    """
    # A sweep only means something if it moved. Both dead ends this script found the hard way read as
    # a flat column of numbers: a panel with no crumple for the wind to get behind, and a gravity
    # written to a modifier field the solver does not read.
    spread = max(r["ang"] for r in rows) - min(r["ang"] for r in rows)
    if spread < 0.1:
        raise SystemExit("FLAG_CLOTH_WIND_INERT — the fly edge hangs at the same angle at every "
                         "strength (spread %.2f deg over %s): the wind is not reaching the cloth"
                         % (spread, ", ".join("%.0f" % r["strength"] for r in rows)))
    flew = [r for r in rows if r["settled"] and r["reach"] >= REACH_MIN]
    if not flew:
        raise SystemExit("FLAG_CLOTH_NEVER_FLEW — no settled strength in the sweep put the fly edge "
                         "out to %.2f m (best reach %.2f m of %.2f authored, flap up to %.2f deg): "
                         "the wind in this solver never holds the banner up, so there is no flying "
                         "shape to export" % (REACH_MIN, max(r["reach"] for r in rows), W,
                                              max(r["flap"] for r in rows)))
    # An arm can fly and still be unreadable. `ANGSTAB_MAX` is the second half of the bar: a banner
    # whose window mean moves 4.60 deg between one second and the next has not reached a state, it is
    # being sampled mid-gust, and the mean this gate would compare against TARGET_DEG is an average of
    # two different shapes. Measured on the 2026-09-27 damping sweep: bending_damping 0.5 at 90 000
    # flew to 1.916 m of reach (so it passes the bar above) while its angle reading drifted 4.60 deg.
    quiet = [r for r in flew if r["ang_drift"] <= ANGSTAB_MAX]
    if not quiet:
        raise SystemExit("FLAG_CLOTH_NEVER_QUIET — %d settled arm(s) flew past %.2f m but none "
                         "repeated its own one-second mean to within %.1f deg (tightest drift %.2f, "
                         "flap up to %.2f): there is a flying shape in this sweep but no state to "
                         "freeze, so the damping or the wind is wrong rather than the target"
                         % (len(flew), REACH_MIN, ANGSTAB_MAX,
                            min(r["ang_drift"] for r in flew), max(r["flap"] for r in flew)))
    best = min(quiet, key=lambda r: abs(r["ang"] - TARGET_DEG))
    if abs(best["ang"] - TARGET_DEG) > TOL_DEG:
        raise SystemExit("FLAG_CLOTH_OFF_TARGET best=%.1f fly=%.2f deg reach=%.2f m, target "
                         "%.2f +/- %.2f — the sweep flew quiet cloth, but not at the angle the plaza "
                         "holds (each calm row: %s)"
                         % (best["strength"], best["ang"], best["reach"], TARGET_DEG, TOL_DEG,
                            ", ".join("%.0f:%.2f" % (r["strength"], r["ang"]) for r in quiet)))
    return best


if __name__ == "__main__":
    t0 = time.time()
    purge()
    bpy.context.scene.render.fps = FPS
    # A neutral base color: the painted face arrives at load in props.js, and glTF multiplies it by
    # baseColorFactor, so anything other than white here would tint the flag twice.
    cloth = mat("flag_cloth", (1.0, 1.0, 1.0), rough=0.82, metal=0.0)

    print("SWEEP  strength    fly-deg     ang+-   reach-m     rch+-  ripple-mm    flap "
          " onset  freeze   frames")
    rows = []
    for k in SWEEP:
        r = solve(k)
        rows.append(r)
        print("SWEEP  %8.1f    %7.2f    %7.2f    %7.2f    %7.3f    %8.1f  %6.2f  %5d  %6d  %6d%s"
              % (r["strength"], r["ang"], r["ang_drift"], r["reach"], r["reach_drift"],
                 r["ripple"] * 1000.0, r["flap"],
                 r["onset"], r["freeze"], r["frames"] - r["onset"] + 1,
                 "" if r["settled"] else "  UNSETTLED"), flush=True)
    best = accept(rows)
    strength, ang, reach = best["strength"], best["ang"], best["reach"]

    o, verts = capture(strength, best["freeze"])
    # The capture is a second solve, so it has to reproduce the reading the sweep picked it on. If
    # this disagrees, the shape exported is not the shape the sweep measured.
    chk_ang, chk_reach, _ = readings(verts)
    if abs(chk_ang - best["ang_f"]) > 0.05 or abs(chk_reach - best["reach_f"]) > 0.005:
        raise SystemExit("FLAG_CLOTH_CAPTURE_MISMATCH sweep=%.3f deg/%.3f m capture=%.3f deg/%.3f m"
                         % (best["ang_f"], best["reach_f"], chk_ang, chk_reach))
    print("PICKED strength=%.1f fly=%.2f deg reach=%.2f m ripple=%.1f mm onset=%d freeze=%d "
          "flap=%.2f deg (frame %.2f deg at export, dev %.2f) drift=%.2f deg"
          % (strength, ang, reach, best["ripple"] * 1000.0, best["onset"], best["freeze"],
             best["flap"], chk_ang, best["ang_dev"], best["ang_drift"]))
    bake(o, verts)
    turned = hem(o)
    solidify(o, 0.0016)
    compact_materials(o)
    o.data.materials.clear()
    o.data.materials.append(cloth)
    root = empty("flag_cloth")
    o.parent = root
    # The reading that certifies the shape is taken off the mesh that is about to be written, after
    # the hem and the solidify, and BEFORE the export: a refusal has to stop the file from existing,
    # not describe it afterwards.
    #
    # `readings()` addresses the solve grid by row-major index, so it only works here if the hem's
    # appended ring and the duplicated shell leave the grid's rows in the first `len(verts)` slots.
    # They do — runs 8 and 10 both read the finished mesh at 6.02 deg / 1.88 m / 74.3 mm, which is
    # 0.02 deg and 0.000 m from the capture reading of the same pass (run 10 prints both halves:
    # 6.04 / 1.879 solved, 6.02 / 1.879 exported). That agreement is now the refusal below rather
    # than a coincidence: the shell's cost is hundredths of a degree, while a mesh whose rows had
    # been reordered would land on some other part of the sheet and move the reading by degrees.
    #
    # An earlier version of this block compared these numbers to the SWEEP table's columns and looked
    # like 150 mm of lost reach. That was a mislabelled print, not a lost shape: the sweep's `fly` and
    # `reach` columns are one-second window means, while the export is a single frozen frame, and the
    # frozen frame at 6.04 deg / 1.879 m is simply not the mean of its own window (5.39 / 2.03 — the
    # window's flap is 22.68 deg peak-to-peak). Both are printed here, labelled.
    #
    # `band_readings` was tried as an index-free ruler for this job and rejected: selecting the fly
    # edge as "everything within 30 mm of the farthest x" reads the same mesh at 3.12 deg / 2.06 m
    # against the column ruler's 6.04 / 1.88, because the band catches the panel's outermost tips
    # instead of its whole leech. One ruler, named by column, is the better instrument.
    ev = [tuple(v.co) for v in o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh().vertices]
    out_ang, out_reach, out_rip = readings(ev[:len(verts)])
    certify((chk_ang, chk_reach), (out_ang, out_reach))
    xs = [v.co.x for v in o.data.vertices]
    ys = [v.co.y for v in o.data.vertices]
    zs = [v.co.z for v in o.data.vertices]
    export(root, "flag_cloth.glb")
    print("CLOTH verts=%d polys=%d hem_edges=%d" % (len(o.data.vertices), len(o.data.polygons), turned))
    print("CLOTH exported fly=%.2f deg reach=%.3f m ripple=%.1f mm  (frozen frame %.2f / %.3f / %.1f; "
          "its one-second window %.2f / %.2f / %.1f)"
          % (out_ang, out_reach, out_rip * 1000.0, chk_ang, chk_reach, best["rip_f"] * 1000.0,
             ang, reach, best["ripple"] * 1000.0))
    print("CLOTH blender x[%+.3f..%+.3f] y[%+.3f..%+.3f] z[%+.3f..%+.3f]"
          % (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))
    print("CLOTH seconds=%.1f" % (time.time() - t0))
    print("FLAG_CLOTH_DONE")
