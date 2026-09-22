# Blender builder for the island's basalt clasts — the six shapes the rim rampart and the dune
# scatter are both built from, and the collision outlines that come off the same geometry.
#
# Why this asset exists at all: the playfield ends at r=118 and the crater rim falls away to a
# 62° cliff. Nothing marked that, so a rover carrying 4 m/s over the lip slid down, could not
# climb back, and — past r=150, where the terrain mesh simply stops — came to rest on invisible
# ground. The fix had to be something you can see coming, because an invisible radius clamp is
# exactly the kind of "不合理" the rest of this base is being audited for. A boulder ridge along
# the lip is what a blocky lava rim actually carries, it reads from every district as "edge of
# the world", and it is solid in the only language the physics speaks: discs.
#
# Why a builder and not the CC0 pack: `kenney/nature/rock_*` are 72–85 triangles apiece and
# under 0.6 m across. Scaled to the 6–7 m clasts a 116 m-radius ring needs for its collision to
# close, that is a faceted golf ball. The fracture pattern is the whole point, so it is authored.
#
# The direction the geometry is authored in — and it is the whole design of this file.
# The first version modelled a clast the obvious way (a noise-swollen sphere truncated by
# fracture planes) and then *measured* the silhouette it happened to leave, fitting the fewest
# ground discs to it. That is an approximation problem with no good solution: a disc can only
# hug one arc, so every facet the rock puts outside the fit comes back as `bulge` — the wall the
# player bumps into before touching stone — and it needed six discs on a 7 m clast and still lied
# by 331 mm. Fitting harder is not the fix; the shape was asking to be described by a number of
# discs it does not have.
#
# So the dependency runs the other way now. A clast's footprint IS a small set of ground discs,
# authored here as numbers (`FOOT`); the mesh's plan outline is traced off exactly those circles
# (`rho`), and everything that makes it read as broken basalt — the fracture faces, the crown,
# the flank relief — is authored in *height*, which cannot move a silhouette at all. (The inner
# radial stations are the one place plan is free, and they are only ever pulled inward, so the
# outline they can never reach is still the only thing `verify` measures.) The
# collision table is then the authoring, not an estimate of it, and the only error left is the
# sagitta between the 112-gon the mesh actually has and the arcs it samples: a few millimetres.
# That is the C3 bar met exactly rather than approached, and `verify` is what proves it — it
# fails the build if the shipped mesh and the shipped discs ever drift apart.
#
# Local frame: z=0 is grade (the clast's lowest 180 mm is authored below it, so it sits *in* the
# sand rather than on it). Blender X is the app's X and Blender Y exports to the app's Z, so the
# app's yaw of −θ lays a clone's Y axis along the ring's tangent at polar angle θ.
#
# Run: python3 tools/blender/rsbtex.py && blender --background --python tools/blender/build_rimrock.py
import os, sys, math, random, bmesh
import bpy
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsbkit import (TAU, mat_pbr, textures, uv_cube, empty, purge, export, mesh_obj, OUT)

bpy.ops.wm.read_factory_settings(use_empty=True)

FIELD = textures()["rock_basalt"]
ROCK_MAT = mat_pbr("rock_basalt", FIELD["maps"], rough=1.0, metal=0.0)
TILE = FIELD["u_m"]           # metres per repeat, straight from the forge

SRC_JS = os.path.abspath(os.path.join(OUT, "..", "..", "src", "world", "rim_rock.js"))

# ───────────────────────── the footprint is the collision ─────────────────────────
# Each clast is the union of these ground circles (Blender x = app x, Blender y = app −z). They
# are not a fit to anything: they are the shape, chosen for how the lump reads from above and for
# how far it reaches along the ring's tangent (`reach` below sets the pitch). The lobes are
# deliberately unequal — a big mass with two or three chips broken off it, offset off-centre —
# because a set of concentric circles is an onion. But each lobe stays *nearly* inside the core
# circle — far enough out to break the roundness, not far enough to read as a petal, which is what
# a first pass here did and what made the plan view look like a cloud rather than a rock.
NODES = [
    # name, tall, fracture cuts, seed, footprint discs (cx, cy, r), foot, shape, crest
    #
    # `foot` is how much of the clast's height is still standing where its silhouette is. It is the
    # single most visible number in this file: at the first value used here (0.46, the default of the
    # original `crown`) every clast is a tortoise shell — a flat top carried on a vertical wall half
    # its own height, which in the dune scatter showed up as 64 identical dome-and-skirt cobbles each
    # wearing a pale band at its foot. Real clasts are masses that *taper* into the ground; the flat
    # faces of blocky lava are fracture shoulders part-way up, which is what `cuts` authors, not the
    # outline. So foot is now per-archetype, and the low, tabular ones (ledge) keep a taller wall
    # because a broken plate genuinely does have one.
    #
    # `shape` and `crest` are what `foot` turned out not to be enough on its own. Measured on the
    # first six-archetype dune scatter, re-weighting the bag and decoupling the height scale moved
    # the population's height-to-width spread exactly as designed and the frame still read as a row
    # of identical turtle shells — because with one shared crown exponent and the crest at the
    # centre, every mass tapers the same way, so six archetypes differing in size are one archetype.
    # `shape` is the crown's curvature (0.25 = tabular bench, 0.85 = pointed); `crest` is where the
    # tall part of the mass sits in plan, as a fraction of the outline. An off-centre crest gives a
    # clast a shoulder on one side and a long sloping back on the other, so it reads as stone that
    # broke off a ledge in a particular direction instead of a dome placed on the ground.
    ("mega",  3.85, 7, 11, [(0.00,  0.00, 2.62), (1.62, -0.28, 1.78),
                            (-1.52, 0.72, 1.52), (0.30,  1.72, 1.32)], 0.30, 0.62, (0.18, -0.10)),
    ("block", 2.75, 6, 23, [(0.00,  0.00, 1.98), (1.18, -0.42, 1.30),
                            (-1.12, 0.62, 1.10)], 0.23, 0.45, (0.12, 0.08)),
    ("slab",  1.50, 5, 37, [(0.00,  0.00, 1.58), (0.92,  0.44, 1.02),
                             (-0.86, -0.48, 0.92)], 0.34, 0.30, (0.05, -0.05)),
    # Three more archetypes, for the dune scatter — which shows a clast alone in a frame instead of
    # shoulder-to-shoulder in a wall. A footprint is only ever a blob if all its lobes sit near the
    # origin, so these are authored as *chains*: lobes strung out along a line. That is what makes a
    # blade read as a blade and a broken plate as a broken plate from the driver's seat, and it is
    # free — the collision is still exactly the disc set, so `verify` holds for them as it does for
    # the ring's three.
    ("shard", 4.40, 8, 61, [(0.00,  0.00, 1.15), (0.98,  0.32, 0.80),
                            (-0.94, -0.28, 0.78)], 0.16, 0.85, (0.20, 0.12)),
    ("ledge", 1.15, 6, 83, [(0.00,  0.00, 1.75), (1.55, -0.35, 1.20),
                            (-1.45, 0.55, 1.15), (0.35,  1.60, 0.95)], 0.44, 0.25, (-0.10, 0.14)),
    ("cobble", 0.95, 5, 97, [(0.00, 0.00, 0.95), (0.58, -0.32, 0.62)], 0.11, 0.70, (0.16, -0.14)),
]

N = 112          # directions around the outline; 3.2° of arc, so a 2.6 m lobe is off its arc by 1 mm
RING_BASE = (0.18, 0.40, 0.60, 0.77, 0.90, 1.0)   # mean radial stations out to the silhouette, t of rho
RING_JITTER = 0.05    # how far one clast's stations move off that shared table
RING_WOBBLE = 0.11    # max inward-only perturbation of a station's radius, as a fraction of itself


def rho_of(discs):
    """How far the footprint reaches along a ray from the node origin: the far exit of whichever
    disc owns that direction. The max of per-circle ray exits *is* the union's radial boundary, so
    this is the outline, not a description of it."""
    def rho(th):
        ca, sa = math.cos(th), math.sin(th)
        best = 0.0
        for cx, cy, r in discs:
            across = cx * sa - cy * ca            # perpendicular offset of the centre from the ray
            d2 = r * r - across * across
            if d2 > 0.0:
                best = max(best, cx * ca + cy * sa + math.sqrt(d2))
        return best
    return rho


def crown(t, tall, foot, shape):
    """The clast's own height profile before anything breaks it: a mass that thickens at the crest
    and *tapers* into the ground, not a dome on a wall. t is the fraction of the way out to the
    silhouette, `foot` the fraction of the height still standing at t=1, `shape` how fast that height
    is given up — see NODES."""
    return tall * (foot + (1.0 - foot) * (1.0 - t * t) ** shape)


def clast(name, discs, tall, seed, cuts, foot, shape, crest, sink=0.18):
    """One clast: the authored footprint swept up into a fracture-faced mass."""
    rng = random.Random(seed)
    rho = rho_of(discs)
    prof = [rho(i * TAU / N) for i in range(N)]

    # Broken faces. Each one is a plane that shaves a *shoulder* off the mass in one direction: it
    # is at height `zc` on the outline where it enters, and it rises as it goes inward, so it never
    # reaches the far side of the clast and never needs a boolean. The rise is set so the ceiling
    # clears the crown at the node origin — a face therefore ends where the rock ends, which is
    # what makes it read as a fracture surface rather than as a wedge cut through a melon. The
    # relief a boulder is read by is jointing, and the forged maps carry that at 240 px/m; these
    # planes are the bigger language, the flat faces of a blocky lava clast seen from 5 m.
    planes = []
    for _ in range(cuts):
        psi = rng.uniform(0.0, TAU)
        s0 = rho(psi)                       # how far the footprint reaches in the face's direction
        zc = tall * rng.uniform(0.34, 0.82)
        rise = (tall * 1.34 - zc) / max(s0, 0.5) * rng.uniform(0.92, 1.16)
        planes.append((math.cos(psi), math.sin(psi), s0, zc, rise))

    def top(x, y, pr):
        # Measured from the crest, not the node origin, and expressed as a fraction of the outline so
        # it means the same thing at every lobe. Clamped at the silhouette: past the crest's own reach
        # the mass is a low bench, which is what a shoulder breaking back down to the sand looks like.
        t = min(1.0, math.hypot(x - crest[0] * pr, y - crest[1] * pr) / pr)
        z = crown(t, tall, foot, shape)
        z += noise.noise(Vector((x * 0.55, y * 0.55, 3.10))) * tall * 0.17
        z += noise.noise(Vector((x * 1.90, y * 1.90, 7.70))) * tall * 0.07
        for (nx, ny, s0, zc, rise) in planes:
            z = min(z, zc + (s0 - (x * nx + y * ny)) * rise)
        # No face runs out through the floor: the skirt has to keep some height or the wall inverts
        # along that arc and the mesh turns inside out.
        return max(z, tall * 0.10 - sink)

    bm = bmesh.new()
    # Radial stations, moved off the shared table per clast and then wobbled inward. Both are allowed
    # to pull *inside* the authored silhouette and nowhere else, and that restriction is the whole
    # point: `verify` reads the mesh's support function, which the u=1 ring alone defines, so an inner
    # station can be reshaped freely without the collision moving by a micron.
    #
    # What that buys is the removal of the kit's worst tell. With one fixed table of similar copies,
    # every clast on the island wore the same five concentric ridge lines at the same fraction of its
    # own outline — a self-similarity that survives scaling, which is why it survived the scatter
    # re-weight untouched. Real jointing does not repeat at rock scale, so neither should the mesh
    # that is supposed to read as rock.
    sta = sorted(min(0.95, max(0.07, b + rng.uniform(-RING_JITTER, RING_JITTER)))
                 for b in RING_BASE[:-1]) + [1.0]
    lat = []
    for j, u in enumerate(sta):
        # Never more than half the way to either neighbour, so the grid cannot fold on itself.
        lim = min(u - (sta[j - 1] if j else 0.0), (sta[j + 1] if j + 1 < len(sta) else 1.0) - u)
        amp = min(RING_WOBBLE, 0.5 * lim / u)
        ring = []
        for i in range(N):
            th = i * TAU / N
            pr = prof[i]
            if u < 1.0:
                w = 0.5 + 0.5 * noise.noise(Vector((math.cos(th) * 2.4, math.sin(th) * 2.4,
                                                    seed + u * 4.7)))
                u *= 1.0 - amp * w
            x, y = u * pr * math.cos(th), u * pr * math.sin(th)
            ring.append(bm.verts.new((x, y, top(x, y, pr))))
        lat.append(ring)
    apex = bm.verts.new((0.0, 0.0, top(0.0, 0.0, prof[0])))

    # The skirt: the silhouette dropped to below grade, so the clast is a solid wall, not a sheet.
    base = [bm.verts.new((v.co.x, v.co.y, -sink)) for v in lat[-1]]

    for j in range(len(sta) - 1):
        a, b = lat[j], lat[j + 1]
        for i in range(N):
            k = (i + 1) % N
            bm.faces.new((a[i], a[k], b[k], b[i]))
    for i in range(N):
        bm.faces.new((apex, lat[0][i], lat[0][(i + 1) % N]))
    for i in range(N):
        k = (i + 1) % N
        bm.faces.new((lat[-1][i], lat[-1][k], base[k], base[i]))
    bm.faces.new(tuple(reversed(base)))
    for f in bm.faces:
        f.normal_update()

    o = mesh_obj(name, bm, ROCK_MAT, shade=44)
    uv_cube(o, TILE)
    return o, discs


# ─────────────────────────────── the C3 proof ───────────────────────────────
NS = 240   # directions the two silhouettes are compared on


def support(verts):
    """The mesh's own outline, as a support function: for each direction, how far the clast's
    vertices reach along it. Measured rather than assumed, because what has to agree with the
    collision is the exported geometry — not the numbers that built it."""
    pts = [(v.co.x, v.co.y) for v in verts]
    out = []
    for i in range(NS):
        ca, sa = math.cos(i * TAU / NS), math.sin(i * TAU / NS)
        out.append(max(x * ca + y * sa for x, y in pts))
    return out


def _union(discs, a):
    """Where the collision sits along direction `a`: the outermost of its discs, which is the only
    one the rover ever meets."""
    return max(cx * math.cos(a) + cy * math.sin(a) + r for cx, cy, r in discs)


def verify(o, discs):
    """(bulge, gap) in millimetres between the shipped mesh and the shipped collision, and the
    reach of the collision along any direction — the pitch's input.

    `bulge` is the invisible wall: collision outside the stone. `gap` is the other half of the lie,
    stone you can drive through. Both are measured on the union of the discs, so two circles that
    overlap in one direction count as the one wall the player hits rather than two."""
    prof = support(list(o.data.vertices))
    bulge = gap = 0.0
    for i, p in enumerate(prof):
        u = _union(discs, i * TAU / NS)
        bulge = max(bulge, u - p)
        gap = max(gap, p - u)
    # The grid test is the part the support comparison cannot see: `rho` traces the max-exit curve,
    # and that curve is the union only if the region it encloses has no part the disc set does not
    # cover. Sample both indicator functions and count the cells that disagree.
    xs = [cx - r for cx, cy, r in discs]; xe = [cx + r for cx, cy, r in discs]
    ys = [cy - r for cx, cy, r in discs]; ye = [cy + r for cx, cy, r in discs]
    lo_x, hi_x, lo_y, hi_y = min(xs), max(xe), min(ys), max(ye)
    bad = 0
    M = 150
    rho = rho_of(discs)
    for a in range(M):
        for b in range(M):
            x = lo_x + (hi_x - lo_x) * (a + 0.5) / M
            y = lo_y + (hi_y - lo_y) * (b + 0.5) / M
            d = math.hypot(x, y)
            in_poly = d <= rho(math.atan2(y, x))
            in_discs = any((x - cx) ** 2 + (y - cy) ** 2 <= r * r for cx, cy, r in discs)
            if in_poly != in_discs:
                bad += 1
    cells = (hi_x - lo_x) * (hi_y - lo_y) / (M * M)
    reach = max(math.hypot(cx, cy) + r for cx, cy, r in discs)
    return round(bulge * 1000), round(gap * 1000), round(reach, 3), round(bad * cells * 1e4) / 1e4


TOL_MM = 9      # the bar the shipped asset has to clear, and it clears it by a wide margin


def emit_js(report):
    lines = [HEADER, "export const RIM_ROCK = {"]
    for name, d in report.items():
        lines.append("  %s: { h: %s, reachT: %s, bulge_mm: %d, gap_mm: %d, discs: ["
                     % (name, d["h"], d["reachT"], d["bulge_mm"], d["gap_mm"]))
        for i, disc in enumerate(d["discs"]):
            lines.append("    [%s, %s, %s]%s" % (disc[0], disc[1], disc[2],
                                                 "" if i == len(d["discs"]) - 1 else ","))
        lines.append("  ] },")
    lines.append("};\n")
    with open(SRC_JS, "w") as f:
        f.write("\n".join(lines))
    print("RIMROCK_JS", SRC_JS)


HEADER = """// Generated by tools/blender/build_rimrock.py — do not edit by hand; re-run the builder.
// The rim rampart's collision. It is not a fit to the rock: the rock's footprint is authored *as*
// these circles (NODES/FOOT in the builder) and the mesh is swept off them, so this table is the
// appearance rather than an estimate of it — which is the C3 bar, and `verify` in the builder
// fails the build if the exported mesh and these discs ever drift apart. bulge_mm/gap_mm are the
// measured disagreement: wall outside the stone, and stone outside its wall. Both are millimetre
// scale, against the 90 mm a hand-typed bounding box would have been. Offsets are metres in the
// exported frame (x = radial, z = tangential) about the node origin; `reachT` is how far the cover
// runs along the ring's tangent, which is what decides the pitch that keeps the ring sealed.
"""


def build_kit(spread=0.0):
    purge()
    kit = empty("rim_rock_kit")
    report = {}
    for (i, (name, tall, cuts, seed, discs, foot, shape, crest)) in enumerate(NODES):
        o, _ = clast(name, discs, tall, seed, cuts, foot, shape, crest)
        o.parent = kit
        # The three clasts are alternatives, not parts of one assembly, so they share the node
        # origin and the app places each by name. Spreading them along Blender Y (the app's Z, so
        # they stay standing) is only ever asked for by RIMROCK_SPREAD, to get all three into one
        # preview frame without them intersecting.
        o.location.y = i * spread
        bulge_mm, gap_mm, reach, area_slack = verify(o, discs)
        if os.environ.get("RIMROCK_DEBUG"):
            sup = support(list(o.data.vertices))
            xs = [v.co.x for v in o.data.vertices]; ys = [v.co.y for v in o.data.vertices]
            print("DBG %s verts=%d tris=%d width=%.3f depth=%.3f support=%.3f..%.3f area_slack=%s m2"
                  % (name, len(o.data.vertices), len(o.data.polygons),
                     max(xs) - min(xs), max(ys) - min(ys), min(sup), max(sup), area_slack))
        if max(bulge_mm, gap_mm) > TOL_MM:
            raise SystemExit("RIMROCK_FIT %s bulge=%dmm gap=%dmm over %dmm tolerance"
                             % (name, bulge_mm, gap_mm, TOL_MM))
        h = max(v.co.z for v in o.data.vertices)
        # Blender (x, y) -> app (x, z = -y); the sign is irrelevant to a disc but the table is
        # written in the frame the app actually reads, so nothing has to remember to flip it later.
        report[name] = {"h": round(h, 3), "reachT": reach, "bulge_mm": bulge_mm, "gap_mm": gap_mm,
                        "discs": [[round(cx, 3), round(-cy, 3), round(r, 3)] for cx, cy, r in discs]}
        print("RIMROCK %-6s %5.2f m tall  reachT=%4.2f  %d discs  bulge=%2d mm  gap=%2d mm"
              % (name, h, reach, len(discs), bulge_mm, gap_mm))
    return kit, report


if __name__ == "__main__":
    # RIMROCK_SPREAD renders the kit as a preview GLB with the three clasts laid apart, for
    # preview.py to frame in one shot. It writes no collision table and no shipped asset: the
    # spread lives on the node, not in the geometry the app clones.
    spread = float(os.environ.get("RIMROCK_SPREAD", "0"))
    kit, report = build_kit(spread)
    export(kit, "rim_rock_preview.glb" if spread else "rim_rock.glb")
    if not spread:
        emit_js(report)
    print("RIMROCK_DONE")
