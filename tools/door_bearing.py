#!/usr/bin/env python3
"""Which way does each hull's door actually face, in app space?

props.js rotates a placed model about the app's Y axis by `ry`, so a corridor can only be
aimed at a hatch if the hatch's bearing is known in the same frame. The exporter maps
Blender (x, y, z) onto app (x, z, -y), so app_x = gltf_x and app_z = -gltf_y.

Every vertex is pushed through its node chain, then bucketed by 15-degree app azimuth. The
azimuth whose slice sticks furthest out past the body is the porch/airlock/gable door.

    python3 tools/door_bearing.py habitat_dome greenhouse hangar_roundA
"""
import json, math, os, struct, sys
from collections import defaultdict

AS = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "public", "assets")

COMP = {5126: ("f", 4), 5125: ("I", 4), 5123: ("H", 2), 5122: ("h", 2), 5121: ("B", 1), 5120: ("b", 1)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    blob = open(path, "rb").read()
    assert blob[:4] == b"glTF", path
    off, gltf, binch = 12, None, b""
    while off + 8 <= len(blob):
        ln, typ = struct.unpack_from("<II", blob, off)
        off += 8
        if typ == 0x4E4F534A:
            gltf = json.loads(blob[off:off + ln])
        elif typ == 0x004E4942:
            binch = blob[off:off + ln]
        off += ln
    return gltf, binch


def accessor(gltf, binch, idx):
    a = gltf["accessors"][idx]
    code, csize = COMP[a["componentType"]]
    n = NCOMP[a["type"]]
    bv = gltf["bufferViews"][a["bufferView"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or n * csize
    for k in range(a["count"]):
        yield struct.unpack_from("<" + code * n, binch, base + k * stride)


def col(m16):
    """glTF matrices are column-major: m[c*4+r] -> row r, col c"""
    return [[m16[c * 4 + r] for c in range(4)] for r in range(4)]


def ident():
    return [[1.0 if r == c else 0.0 for c in range(4)] for r in range(4)]


def mul(A, B):
    return [[sum(A[r][k] * B[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def rotq(q):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1]]


def node_xf(n):
    if "matrix" in n:
        return col(n["matrix"])
    M = rotq(n["rotation"]) if "rotation" in n else ident()
    t = n.get("translation", [0, 0, 0])
    s = n.get("scale", [1, 1, 1])
    M[0][3], M[1][3], M[2][3] = t[0], t[1], t[2]
    for r in range(3):
        M[r][0] *= s[0]; M[r][1] *= s[1]; M[r][2] *= s[2]
    return M


def apply(M, p):
    x, y, z = p[0], p[1], p[2]
    return (M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3],
            M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3],
            M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3])


def points(name):
    """(material, point) for every vertex, pushed through its node chain into app space."""
    gltf, binch = read_glb(os.path.join(AS, name + ".glb"))
    nodes = gltf.get("nodes", [])
    mats = [m.get("name", "?") for m in gltf.get("materials", [])]
    out = []

    def walk(i, parent):
        n = nodes[i]
        M = node_xf(n) if parent is None else mul(node_xf(n), parent)
        for mi in [n["mesh"]] if "mesh" in n else []:
            for prim in gltf["meshes"][mi]["primitives"]:
                if "POSITION" not in prim["attributes"]:
                    continue
                mat = mats[prim.get("material", 0)] if prim.get("material") is not None else "-"
                for v in accessor(gltf, binch, prim["attributes"]["POSITION"]):
                    out.append((mat, apply(M, v)))
        for c in n.get("children", []):
            walk(c, M)

    scene = gltf["scenes"][gltf.get("scene", 0)]
    for root in scene["nodes"]:
        walk(root, None)
    return out


def by_material(name):
    """Per-material footprint, in the frame props.js actually places in: assets.js `recentre()`
    shifts every template so its XZ bounding-box centre is the origin, so the tool does the same
    subtraction before it reports where a skin sits. The door is the cluster whose centroid is
    furthest off-centre and whose apex reaches past the body."""
    pts = points(name)
    xs = [p[0] for _, p in pts]; zs = [p[2] for _, p in pts]
    ox, oz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
    grp = defaultdict(list)
    for m, (x, y, z) in pts:
        grp[m].append((x - ox, y, z - oz))
    print(f"\n=== {name}  {len(pts)} verts   recentred footprint "
          f"{max(xs) - min(xs):.2f} x {max(zs) - min(zs):.2f}")
    for m, ps in sorted(grp.items(), key=lambda kv: -len(kv[1])):
        cx = sum(p[0] for p in ps) / len(ps)
        cy = sum(p[1] for p in ps) / len(ps)
        cz = sum(p[2] for p in ps) / len(ps)
        print(f"  {m:14s} n{len(ps):6d}  centroid ({cx:+6.2f}, h{cy:5.2f}, {cz:+6.2f})  "
              f"r {math.hypot(cx, cz):5.2f} @ ry {math.degrees(math.atan2(cx, cz)) % 360:3.0f}"
              f"   far corner {max(math.hypot(p[0], p[2]) for p in ps):5.2f}")

def bearing(pt):
    """The `ry` that would aim this vertex, read off the glTF node space. three.js uses glTF
    coordinates unchanged and the exporter has already folded Blender's Z-up into it, so the
    glTF y *is* the app's up: no sign flip is needed here, only the atan2(dx, dz) convention
    props.js rotates with."""
    return math.degrees(math.atan2(pt[0], pt[2])) % 360      # 0 = +Z, 90 = +X, 180 = -Z, 270 = -X


def report(name):
    pts = [p for _, p in points(name)]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; zs = [p[2] for p in pts]
    print(f"{name:16s} bbox x[{min(xs):+6.2f},{max(xs):+6.2f}] "
          f"y[up {min(ys):5.2f}..{max(ys):5.2f}] z[{min(zs):+6.2f},{max(zs):+6.2f}]")
    by_material(name)


if __name__ == "__main__":
    for n in sys.argv[1:] or ["habitat_dome", "greenhouse", "hab_link"]:
        report(n)
