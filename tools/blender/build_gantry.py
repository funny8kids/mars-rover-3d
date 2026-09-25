# Builds public/assets/gantry_service.glb — a substation portal gantry.
# Runs headless:  blender -b -P tools/blender/build_gantry.py   (Blender 5.2 has no --noaudio)
# bmesh-only by design: modifier_apply / origin_set are unreliable in Blender 5.2 headless.
import bpy, bmesh, math, os
from mathutils import Matrix, Vector, Euler

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'gantry_service.glb')

MATS = [
    ('hull_white', (0.80, 0.81, 0.83), 0.06, 0.52),
    ('panel_grey', (0.44, 0.45, 0.47), 0.30, 0.55),
    ('struct',     (0.52, 0.50, 0.47), 0.78, 0.46),
    ('dark',       (0.20, 0.195, 0.185), 0.55, 0.58),
    ('orange',     (0.78, 0.27, 0.05), 0.10, 0.55),
    ('yellow',     (0.80, 0.60, 0.06), 0.10, 0.55),
    ('concrete',   (0.36, 0.345, 0.32), 0.02, 0.90),
    ('alu_bright', (0.72, 0.73, 0.75), 0.90, 0.30),
    ('rust',       (0.26, 0.11, 0.06), 0.35, 0.80),
    ('porcelain',  (0.50, 0.48, 0.44), 0.04, 0.28),
    ('copper',     (0.48, 0.24, 0.12), 0.92, 0.34),
    ('light_amber', (1.0, 0.55, 0.14), 0.00, 0.30),
    ('glass',      (0.14, 0.26, 0.30), 0.10, 0.10),
]
IDX = {n: i for i, (n, *_r) in enumerate(MATS)}

bpy.ops.wm.read_factory_settings(use_empty=True)
bm = bmesh.new()


def _mat(items, m):
    i = IDX[m]
    faces = set()
    for e in items:
        t = type(e).__name__
        if t == 'BMFace':
            faces.add(e)
        elif t == 'BMVert':
            faces.update(e.link_faces)
        elif t == 'BMEdge':
            faces.update(e.link_faces)
    for f in faces:
        f.material_index = i


def M(x, y, z, rx=0, ry=0, rz=0):
    return Matrix.Translation((x, y, z)) @ Euler((rx, ry, rz), 'XYZ').to_matrix().to_4x4()


def box(w, d, h, x, y, z, m='struct', rx=0, ry=0, rz=0):
    r = bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.transform(bm, matrix=M(x, y, z, rx, ry, rz) @ Matrix.Diagonal((w, d, h, 1.0)), verts=r['verts'])
    _mat(r['verts'], m)


def cyl(r1, r2, depth, x, y, z, m='alu_bright', seg=12, rx=0, ry=0, rz=0):
    r = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                              radius1=r1, radius2=r2, depth=depth)
    bmesh.ops.transform(bm, matrix=M(x, y, z, rx, ry, rz), verts=r['verts'])
    _mat(r['verts'], m)


def sph(r, x, y, z, m, seg=10, ring=6):
    r0 = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=r)
    bmesh.ops.transform(bm, matrix=M(x, y, z), verts=r0['verts'])
    _mat(r0['verts'], m)


def torus(R, rr, x, y, z, m='dark', seg=14, tube=7, rx=0, ry=0, rz=0):
    T = M(x, y, z, rx, ry, rz)
    ring = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        c = Vector((math.cos(a) * R, math.sin(a) * R, 0.0))
        n = Vector((math.cos(a), math.sin(a), 0.0))
        row = []
        for j in range(tube):
            b = 2 * math.pi * j / tube
            row.append(bm.verts.new(T @ (c + n * (math.cos(b) * rr) + Vector((0, 0, math.sin(b) * rr)))))
        ring.append(row)
    fs = []
    for i in range(seg):
        for j in range(tube):
            q = (ring[i][j], ring[(i + 1) % seg][j], ring[(i + 1) % seg][(j + 1) % tube], ring[i][(j + 1) % tube])
            try:
                fs.append(bm.faces.new(q))
            except ValueError:
                pass
    _mat(fs, m)


def run(p0, p1, r, m='alu_bright', seg=8):
    """Cylinder between two points — used for bracing, conduits and rails."""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    L = d.length
    if L < 1e-4:
        return
    q = d.to_track_quat('Z', 'Y')
    r0 = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=L)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) * 0.5) @ q.to_matrix().to_4x4(), verts=r0['verts'])
    _mat(r0['verts'], m)


# ── layout ── the portal spans X, has two girder planes at Y = ±1.9, deck on top
GX = 5.6          # leg centreline, ±
GY = 1.9          # girder plane
TOP = 7.4         # girder soffit
DECK = 8.72

# 1 ── footings, anchor bolts ────────────────────────────────────────────────
for sx in (-1, 1):
    for sy in (-1, 1):
        x, y = sx * GX, sy * GY
        box(2.30, 2.30, 0.46, x, y, 0.23, 'concrete')
        box(1.98, 1.98, 0.16, x, y, 0.54, 'concrete')
        box(1.14, 1.14, 0.10, x, y, 0.67, 'orange')          # base plate
        for i in range(8):                                    # bolts on a bolt circle
            a = i / 8 * math.tau + 0.39
            bx, by = x + math.cos(a) * 0.48, y + math.sin(a) * 0.48
            cyl(0.045, 0.045, 0.30, bx, by, 0.82, 'alu_bright', 6)
            cyl(0.075, 0.075, 0.07, bx, by, 0.95, 'dark', 6)

# 2 ── lattice legs ─────────────────────────────────────────────────────────
LEG_H = TOP - 0.72
LEG_MID = 0.72 + LEG_H / 2
for sx in (-1, 1):
    for sy in (-1, 1):
        x, y = sx * GX, sy * GY
        for ax in (-1, 1):
            for ay in (-1, 1):
                box(0.15, 0.15, LEG_H, x + ax * 0.44, y + ay * 0.44, LEG_MID, 'struct')
                # taper: a stubbier secondary angle at each corner reads as a built-up section
                box(0.07, 0.07, LEG_H * 0.55, x + ax * 0.53, y + ay * 0.53, 0.72 + LEG_H * 0.27, 'panel_grey')
        panels = 4
        for p in range(panels + 1):
            z = 0.72 + LEG_H * p / panels
            for ay in (-1, 1):                               # girts front / back
                box(0.88, 0.07, 0.11, x, y + ay * 0.44, z, 'struct')
            for ax in (-1, 1):
                box(0.07, 0.88, 0.11, x + ax * 0.44, y, z, 'struct')
            if p < panels:
                z2 = 0.72 + LEG_H * (p + 1) / panels
                for ay in (-1, 1):                           # X lacing on the two girder faces
                    run((x - 0.44, y + ay * 0.44, z), (x + 0.44, y + ay * 0.44, z2), 0.045, 'panel_grey')
                    run((x + 0.44, y + ay * 0.44, z), (x - 0.44, y + ay * 0.44, z2), 0.045, 'panel_grey')
        box(1.02, 1.02, 0.13, x, y, TOP - 0.07, 'struct')    # head cap
        for ax in (-1, 1):
            for ay in (-1, 1):
                box(0.30, 0.30, 0.05, x + ax * 0.40, y + ay * 0.40, 0.74, 'rust')  # gusset pad
        for i in range(5):                                    # hazard chevrons on the base
            box(0.94, 0.10, 0.16, x, y + (i - 2) * 0.20, 0.86, 'orange' if i % 2 else 'yellow', rz=0.62)

# 3 ── plate-girder portal beams ────────────────────────────────────────────
for sy in (-1, 1):
    y = sy * GY
    box(12.90, 0.16, 1.02, 0, y, TOP + 0.51, 'panel_grey')          # web
    box(13.10, 0.34, 0.11, 0, y, TOP + 1.06, 'struct')              # top flange
    box(13.10, 0.34, 0.11, 0, y, TOP - 0.04, 'struct')              # bottom flange
    for i in range(9):                                              # web stiffeners
        box(0.09, 0.40, 0.94, -6.0 + i * 1.5, y, TOP + 0.51, 'struct')
    for i in range(6):                                              # flange bolts
        bx = -5.5 + i * 2.2
        cyl(0.06, 0.06, 0.40, bx, y, TOP + 1.06, 'dark', 6)
        cyl(0.06, 0.06, 0.40, bx, y, TOP - 0.04, 'dark', 6)
    for i in range(11):                                             # slotted web lightening holes
        cyl(0.24, 0.24, 0.20, -6.0 + i * 1.2, y, TOP + 0.51, 'dark', 12, rx=math.pi / 2)

# cross stringers + lateral bracing between the two girder planes
for i in range(7):
    x = -5.6 + i * 1.867
    box(0.20, 3.80, 0.26, x, 0, TOP + 0.90, 'struct')
run((-GX, -GY, TOP - 0.10), (GX, GY, TOP - 0.10), 0.06, 'panel_grey')
run((GX, -GY, TOP - 0.10), (-GX, GY, TOP - 0.10), 0.06, 'panel_grey')

# 4 ── grating deck + handrail ──────────────────────────────────────────────
for sy in (-1, 1):
    box(12.60, 0.10, 0.14, 0, sy * 2.05, DECK - 0.06, 'struct')
for i in range(46):                                                 # bearing bars
    box(0.055, 4.20, 0.055, -6.20 + i * 0.272, 0, DECK, 'alu_bright')
for i in range(9):                                                  # cross flat bars
    box(12.40, 0.05, 0.045, 0, -2.0 + i * 0.5, DECK + 0.045, 'alu_bright')
box(12.70, 4.35, 0.06, 0, 0, DECK + 0.09, 'struct')                 # perimeter frame edge (thin)

RAIL = DECK + 1.10
for i in range(15):
    x = -6.2 + i * 0.886
    for sy in (-1, 1):
        cyl(0.035, 0.035, 1.05, x, sy * 2.10, DECK + 0.56, 'struct', 8)
        box(0.05, 0.16, 0.11, x, sy * 2.10, DECK + 0.10, 'yellow')  # toe-board bracket
for sy in (-1, 1):
    box(12.60, 0.05, 0.10, 0, sy * 2.10, DECK + 0.12, 'yellow')     # toe board
    run((-6.2, sy * 2.10, RAIL), (6.2, sy * 2.10, RAIL), 0.035, 'struct')
    run((-6.2, sy * 2.10, DECK + 0.58), (6.2, sy * 2.10, DECK + 0.58), 0.030, 'struct')
for s2 in (-1, 1):
    x = s2 * 6.2
    run((x, -2.10, RAIL), (x, 2.10, RAIL), 0.035, 'struct')
    run((x, -2.10, DECK + 0.58), (x, 2.10, DECK + 0.58), 0.030, 'struct')
    cyl(0.035, 0.035, 1.05, x, -2.10, DECK + 0.56, 'struct', 8)
    cyl(0.035, 0.035, 1.05, x, 2.10, DECK + 0.56, 'struct', 8)

# 5 ── two transformer bays on the deck ────────────────────────────────────
for sx in (-1, 1):
    cx = sx * 3.3
    box(2.70, 1.90, 0.22, cx, 0, DECK + 0.14, 'dark')               # plinth
    box(2.50, 1.70, 1.85, cx, 0, DECK + 1.20, 'panel_grey')         # main tank
    box(2.60, 1.80, 0.12, cx, 0, DECK + 0.30, 'struct')             # bottom flange
    box(2.60, 1.80, 0.12, cx, 0, DECK + 2.12, 'struct')             # top flange
    box(2.30, 1.50, 0.10, cx, 0, DECK + 2.20, 'struct')             # lid
    for s2 in (-1, 1):
        for i in range(13):                                         # radiator banks
            fx = cx - 1.05 + i * 0.175
            box(0.045, 0.46, 1.45, fx, s2 * 1.06, DECK + 1.18, 'alu_bright')
        for i in range(3):                                          # radiator headers
            cyl(0.075, 0.075, 1.50, cx - 0.7 + i * 0.7, s2 * 1.32, DECK + 1.18, 'struct', 8)
        run((cx - 1.15, s2 * 1.32, DECK + 1.90), (cx - 1.15, s2 * 0.86, DECK + 1.90), 0.06, 'copper')
        run((cx + 1.15, s2 * 1.32, DECK + 0.62), (cx + 1.15, s2 * 0.86, DECK + 0.62), 0.06, 'copper')
    cyl(0.34, 0.34, 2.20, cx, 0, DECK + 2.52, 'panel_grey', 14, ry=math.pi / 2)   # conservator
    for s2 in (-1, 1):
        cyl(0.38, 0.38, 0.10, cx + s2 * 1.10, 0, DECK + 2.52, 'struct', 14, ry=math.pi / 2)
    for i in range(3):                                              # HV bushings
        bx = cx - 0.8 + i * 0.8
        for d in range(6):
            z = DECK + 2.30 + d * 0.14
            cyl(0.19 - d * 0.012, 0.19 - d * 0.012, 0.055, bx, 0, z, 'porcelain', 12)
        cyl(0.055, 0.055, 1.00, bx, 0, DECK + 2.90, 'copper', 8)
        cyl(0.10, 0.10, 0.10, bx, 0, DECK + 3.34, 'dark', 6)
    box(0.55, 0.05, 0.34, cx + 0.95, 0.87, DECK + 0.85, 'yellow')   # nameplate
    box(0.30, 0.05, 0.20, cx - 0.95, 0.87, DECK + 0.60, 'dark')     # tap changer
    for d in range(4):
        cyl(0.05, 0.05, 0.10, cx - 0.95, 0.90, DECK + 0.52 + d * 0.06, 'alu_bright', 8, rx=math.pi / 2)

# 6 ── switchgear cabinet row ───────────────────────────────────────────────
box(2.30, 1.15, 0.16, 0, 0, DECK + 0.11, 'dark')
for i in range(3):
    cx = -0.76 + i * 0.76
    box(0.72, 1.05, 2.05, cx, 0, DECK + 1.22, 'hull_white')
    box(0.62, 0.05, 1.85, cx, 0.53, DECK + 1.22, 'panel_grey')      # door
    box(0.06, 0.10, 0.26, cx + 0.26, 0.58, DECK + 1.22, 'dark')     # handle
    for d in range(6):                                              # louver stack
        box(0.40, 0.05, 0.035, cx, 0.555, DECK + 1.86 - d * 0.075, 'dark')
    sph(0.055, cx - 0.18, 0.565, DECK + 2.06, 'light_amber', 8, 5)
    box(0.30, 0.04, 0.16, cx, 0.555, DECK + 0.55, 'dark')           # meter bezel
    box(0.24, 0.02, 0.11, cx, 0.575, DECK + 0.55, 'glass')
box(2.35, 1.10, 0.10, 0, 0, DECK + 2.30, 'struct')                  # cowl
for i in range(5):
    cyl(0.05, 0.05, 0.30, -0.9 + i * 0.45, 0, DECK + 2.48, 'alu_bright', 8)   # bus post insulators

# 7 ── insulator strings + conductors under the girder ─────────────────────
for sx in (-1, 1):
    for i in range(3):
        px = sx * 5.0 + (i - 1) * 1.15
        for s2 in (-1, 1):
            py = s2 * 1.55
            cyl(0.05, 0.05, 0.34, px, py, TOP - 0.24, 'struct', 8)  # hanger rod
            for d in range(7):
                z = TOP - 0.45 - d * 0.115
                cyl(0.17, 0.17, 0.05, px, py, z, 'porcelain', 12)
                cyl(0.075, 0.075, 0.075, px, py, z - 0.055, 'alu_bright', 8)
            torus(0.11, 0.028, px, py, TOP - 1.30, 'dark', 10, 6, rx=math.pi / 2)
# phase conductors spanning the portal, sagged
for s2 in (-1, 1):
    for i in range(3):
        py = s2 * 1.55
        ph = -1.0 + i * 1.0
        pts = []
        for t in range(9):
            x = -5.75 + t * 1.4375
            z = TOP - 1.34 - math.sin(t / 8 * math.pi) * 0.30
            pts.append((x, py + ph * 0.30, z))
        for t in range(8):
            run(pts[t], pts[t + 1], 0.045, 'alu_bright', 6)

# 8 ── cable tray + conduit runs under the deck edge ───────────────────────
for i in range(11):
    x = -6.0 + i * 1.2
    box(1.05, 0.72, 0.05, x, -2.55, DECK - 0.42, 'alu_bright')      # tray base
    box(1.05, 0.05, 0.24, x, -2.90, DECK - 0.30, 'alu_bright')      # side 1
    box(1.05, 0.05, 0.24, x, -2.20, DECK - 0.30, 'alu_bright')      # side 2
    box(0.05, 0.72, 0.24, x, -2.55, DECK - 0.30, 'panel_grey')      # transverse web
for r, mz, off in ((0.11, 'orange', -2.72), (0.09, 'dark', -2.55), (0.075, 'copper', -2.38)):
    # `ry`, not `rz`: `cyl` builds a cone on the Z axis, so a Z rotation spins it about itself and it
    # stays upright — a 13 m mast standing at the deck edge with its foot 1.88 m over the sand. The
    # exporter measured that as a wall in the portal's drive-through bay (seam `launch:cargo-umbilical#3`).
    cyl(r, r, 13.0, 0, off, DECK - 0.34, mz, 10, ry=math.pi / 2)
for i in range(7):
    torus(0.16, 0.035, -5.4 + i * 1.8, -2.55, DECK - 0.34, 'dark', 12, 6, ry=math.pi / 2)
for i in range(5):                                                  # drops into the switchgear
    x = -1.6 + i * 0.8
    cyl(0.07, 0.07, 0.55, x, -2.55, DECK - 0.06, 'dark', 8)
    torus(0.07, 0.028, x, -2.55, DECK - 0.34, 'struct', 10, 6)

# 9 ── pipe rack along the leeward girder ──────────────────────────────────
for r, off, mz in ((0.16, 1.05, 'alu_bright'), (0.13, 1.55, 'hull_white'), (0.09, 1.98, 'copper')):
    # same axis rule as the conduits above: the clamp rings at §9 are already turned to ring an
    # X-direction pipe, and the 12.6 m length is the girder's own span — only the pipe was upright.
    cyl(r, r, 12.6, 0, off + 0.55, TOP + 1.30, mz, 12, ry=math.pi / 2)
for i in range(7):
    x = -5.4 + i * 1.8
    box(0.10, 1.60, 0.10, x, 1.85, TOP + 1.30, 'struct')            # pipe shoe
    box(0.16, 0.06, 0.42, x, 1.05, TOP + 1.52, 'dark')
    for off in (1.60, 2.10, 2.53):
        torus(off * 0 + 0.19, 0.035, x, off + 0.55, TOP + 1.30, 'dark', 12, 6, ry=math.pi / 2)
for i in range(2):                                                  # gate valves
    x = -2.4 + i * 4.8
    box(0.34, 0.30, 0.34, x, 1.60, TOP + 1.30, 'orange')
    cyl(0.05, 0.05, 0.46, x, 1.60, TOP + 1.66, 'struct', 8)
    torus(0.24, 0.035, x, 1.60, TOP + 1.90, 'orange', 14, 6)
    for s in range(4):
        a = s / 4 * math.pi
        run((x - math.cos(a) * 0.24, 1.60 - math.sin(a) * 0.24, TOP + 1.90),
            (x + math.cos(a) * 0.24, 1.60 + math.sin(a) * 0.24, TOP + 1.90), 0.026, 'orange', 5)

# 10 ── access ladder with safety cage on the -X, -Y leg ──────────────────
lx, ly = -GX - 0.05, -GY - 0.62
for s in (-1, 1):
    box(0.07, 0.07, TOP - 0.7, lx, ly, (TOP + 0.7) / 2, 'alu_bright')
for s in (-1, 1):
    box(0.06, 0.06, TOP - 0.75, lx, ly + s * 0.28, (TOP + 0.75) / 2, 'alu_bright')
for i in range(17):
    z = 1.0 + i * 0.40
    run((lx, ly - 0.28, z), (lx, ly + 0.28, z), 0.028, 'alu_bright', 6)
for i in range(6):                                                  # cage hoops
    z = 1.6 + i * 1.05
    for k in range(9):
        a = -1.35 + k * 0.3375
        p0 = (lx + math.cos(a) * 0.42, ly + math.sin(a) * 0.42, z)
        p1 = (lx + math.cos(a + 0.3375) * 0.42, ly + math.sin(a + 0.3375) * 0.42, z)
        run(p0, p1, 0.024, 'yellow', 5)
for k in range(5):                                                  # cage stringers
    a = -1.35 + k * 0.675
    run((lx + math.cos(a) * 0.42, ly + math.sin(a) * 0.42, 1.5),
        (lx + math.cos(a) * 0.42, ly + math.sin(a) * 0.42, TOP - 0.2), 0.026, 'yellow', 5)
for i in range(5):                                                  # rest platform at the top
    box(0.5, 0.9, 0.05, lx - 0.10, -GY, TOP - 0.15, 'alu_bright')
run((lx - 0.35, -GY - 0.45, TOP - 0.12), (lx - 0.35, -GY + 0.45, TOP - 0.12), 0.03, 'struct')

# 11 ── luminaires, beacon, signage ────────────────────────────────────────
for i in range(5):
    x = -4.8 + i * 2.4
    cyl(0.06, 0.06, 0.42, x, 0, TOP - 0.28, 'struct', 8)
    box(0.62, 0.36, 0.16, x, 0, TOP - 0.55, 'dark', rx=0.42)
    box(0.54, 0.30, 0.05, x, 0, TOP - 0.62, 'light_amber', rx=0.42)
    torus(0.31, 0.035, x, 0, TOP - 0.56, 'hull_white', 12, 6, rx=0.42 + math.pi / 2)
for sx in (-1, 1):                                                  # deck-level floods
    x = sx * 5.9
    cyl(0.05, 0.05, 0.55, x, 0, DECK + 0.40, 'struct', 8)
    box(0.42, 0.26, 0.14, x, 0, DECK + 0.75, 'dark', rx=-0.5)
    box(0.36, 0.21, 0.045, x, 0, DECK + 0.71, 'light_amber', rx=-0.5)
cyl(0.10, 0.10, 1.30, 0, 0, DECK + 2.95, 'struct', 8)               # beacon mast
sph(0.19, 0, 0, DECK + 3.66, 'light_amber', 10, 7)
torus(0.24, 0.05, 0, 0, DECK + 3.48, 'dark', 12, 6)
for s2 in (-1, 1):                                                  # aircraft-warning vanes
    box(0.9, 0.05, 0.16, s2 * 0.55, 0, DECK + 3.66, 'orange')

for sy in (-1, 1):                                                  # sign board on each girder face
    y = sy * (GY + 0.30)
    box(3.60, 0.09, 1.15, 0, y, TOP + 2.05, 'hull_white')
    box(3.76, 0.06, 0.10, 0, y, TOP + 2.66, 'struct')
    box(3.76, 0.06, 0.10, 0, y, TOP + 1.44, 'struct')
    box(0.10, 0.06, 1.34, -1.83, y, TOP + 2.05, 'struct')
    box(0.10, 0.06, 1.34, 1.83, y, TOP + 2.05, 'struct')
    for s2 in (-1, 1):
        box(0.5, 0.05, 0.20, s2 * 1.15, y + sy * 0.06, TOP + 1.60, 'orange')
        box(0.5, 0.05, 0.20, s2 * 0.25, y + sy * 0.06, TOP + 1.60, 'yellow')
    for s2 in (-1, 1):                                              # sign washers
        cyl(0.05, 0.05, 0.30, s2 * 1.3, y, TOP + 2.86, 'struct', 8)
        box(0.28, 0.14, 0.10, s2 * 1.3, y + sy * 0.06, TOP + 2.99, 'dark', rx=0.6)
        box(0.24, 0.03, 0.06, s2 * 1.3, y + sy * 0.13, TOP + 2.97, 'light_amber', rx=0.6)
    box(0.14, 0.30, 1.30, -1.83, y - sy * 0.30, TOP + 2.05, 'struct')
    box(0.14, 0.30, 1.30, 1.83, y - sy * 0.30, TOP + 2.05, 'struct')

# 12 ── misc plant: vents, junction boxes, extinguisher, steps ─────────────
for i in range(6):
    x = -4.2 + i * 1.7
    box(0.30, 0.22, 0.36, x, -GY - 0.20, TOP + 0.30, 'panel_grey')
    box(0.24, 0.05, 0.28, x, -GY - 0.33, TOP + 0.30, 'dark')
    for d in range(3):
        cyl(0.035, 0.035, 0.10, x - 0.09 + d * 0.09, -GY - 0.36, TOP + 0.42, 'alu_bright', 6, rx=math.pi / 2)
    cyl(0.05, 0.05, 0.30, x, -GY - 0.20, TOP + 0.02, 'copper', 8)
for i in range(4):
    x = -3.0 + i * 2.0
    box(0.42, 0.30, 0.52, x, GY + 0.24, DECK - 0.75, 'hull_white')
    box(0.34, 0.04, 0.42, x, GY + 0.40, DECK - 0.75, 'panel_grey')
    cyl(0.045, 0.045, 0.34, x, GY + 0.24, DECK - 1.16, 'struct', 8)
    for s in range(2):
        torus(0.10, 0.022, x - 0.10 + s * 0.20, GY + 0.24, DECK - 0.50, 'dark', 8, 5)
box(0.22, 0.22, 0.72, GX + 0.55, -GY + 0.30, DECK + 0.36, 'orange')  # extinguisher
cyl(0.11, 0.11, 0.72, GX + 0.55, -GY + 0.30, DECK + 0.36, 'orange', 10)
box(0.06, 0.16, 0.30, GX + 0.55, -GY + 0.14, DECK + 0.78, 'dark')
for i in range(10):                                                  # bird-guard wires over the deck
    run((-6.2 + i * 1.38, -2.10, DECK + 0.30), (-6.2 + i * 1.38, 2.10, DECK + 0.30), 0.012, 'alu_bright', 4)

# ── collapse to one object, seat on the origin, export ────────────────────
me = bpy.data.meshes.new('gantry_service')
bm.to_mesh(me)
bm.free()

# Seat on datum and centre in plan, so props.js can place it with the same dy convention as the
# other hero assets.
xs = [v.co.x for v in me.vertices]
zs = [v.co.z for v in me.vertices]
dx = -(min(xs) + max(xs)) / 2
Shift = Matrix.Translation((dx, 0.0, -min(zs)))
for v in me.vertices:
    v.co = Shift @ v.co
me.update()

ob = bpy.data.objects.new('gantry_service', me)
bpy.context.collection.objects.link(ob)
bpy.ops.object.select_all(action='DESELECT')
ob.select_set(True)
bpy.context.view_layer.objects.active = ob

for p in me.polygons:
    p.use_smooth = len(p.vertices) > 4 and p.area < 0.5
me.validate()
me.calc_loop_triangles()
print('TRIS', len(me.loop_triangles), 'PRIMS', len(me.materials))

mats = []
for name, col, met, rough in MATS:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*col, 1.0)
    b.inputs['Metallic'].default_value = met
    b.inputs['Roughness'].default_value = rough
    if name.startswith('light_'):
        b.inputs['Emission Color'].default_value = (*col, 1.0)
        b.inputs['Emission Strength'].default_value = 6.0
    mats.append(m)
    me.materials.append(m)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True,
                          export_yup=True, export_apply=True, export_materials='EXPORT')
print('WROTE', OUT, os.path.getsize(OUT))
