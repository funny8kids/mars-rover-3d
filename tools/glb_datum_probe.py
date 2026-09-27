#!/usr/bin/env python3
# ============================================================================
# RED STARBASE — where a GLB keeps its ground plane (#95)
#
# `tools/blender/build_base_v2.py` snaps every asset so its lowest point sits on Z=0, which is the
# contract the runtime placement reads. One asset is documented not to honour it: launch_tower reaches
# 2.535 m below the graded pad surface (the flame duct and the footing stack), so either the datum is
# carried in the file or it is bolted on afterwards — and those two are not the same thing to whoever
# places the tower next.
#
# Bounds are computed in FILE space: every node transform between the scene root and the accessor is
# applied. Reading a POSITION accessor alone is not enough, and this is not a hypothetical — the first
# draft of this probe printed launch_tower as 6.9 m tall, because its height lives in the hierarchy
# (a tower assembled from parts whose local boxes are metres across). A glTF can also keep its datum in
# two places, a node translation or the vertex values, which produce the same pixels and different
# numbers, so both are printed.
#
#   python3 tools/glb_datum_probe.py <a.glb> [<b.glb>]
#
# Exit codes:
#   0  DATUM_PROBE_OK          read the file(s)
#   2  DATUM_PROBE_CANNOT_READ a file is missing, truncated, or has no float32 POSITION accessor
# ============================================================================
import hashlib
from collections import Counter
import json
import struct
import sys

IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def load(path):
    with open(path, 'rb') as f:
        blob = f.read()
    if blob[:4] != b'glTF' or len(blob) < 20:
        raise ValueError('not a GLB')
    chunks, off = [], 12
    while off + 8 <= len(blob):
        ln, kind = struct.unpack_from('<II', blob, off)
        chunks.append((kind, blob[off + 8: off + 8 + ln]))
        off += 8 + ln
    js = next((c for k, c in chunks if k == 0x4E4F534A), None)
    bin_ = next((c for k, c in chunks if k == 0x004E4942), b'')
    if js is None:
        raise ValueError('no JSON chunk')
    return json.loads(js), bin_, blob


def node_matrix(n):
    """The node's own 4x4, column-major: the spec's `matrix` if present, else its TRS."""
    if 'matrix' in n:
        return list(n['matrix'])
    p = n.get('translation', [0.0, 0.0, 0.0])
    q = n.get('rotation', [0.0, 0.0, 0.0, 1.0])
    s = n.get('scale', [1.0, 1.0, 1.0])
    x, y, z, w = q
    xx, yy, zz = 2 * x * x, 2 * y * y, 2 * z * z
    xy, yz, zx = 2 * x * y, 2 * y * z, 2 * z * x
    wx, wy, wz = 2 * w * x, 2 * w * y, 2 * w * z
    return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (zx - wy) * s[0], 0.0,
            (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0.0,
            (zx + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0.0,
            p[0], p[1], p[2], 1.0]


def mul(a, b):
    """Column-major product a*b, where b is the child (b applies first)."""
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def apply_y(m, v):
    """The vertical reading. glTF is Y-up and so is three.js after GLTFLoader — the axis the base
    contract is written on is the file's Y, not its Z; a first draft of this probe measured Z and
    reported a 54 m tower as 6.9 m tall, which is the depth of its widest part."""
    return apply_axis(m, v, 1)


def accessor_points(j, bin_, ai):
    a = j['accessors'][ai]
    if a.get('componentType') != 5126 or a.get('type') != 'VEC3':
        return None
    bv = j['bufferViews'][a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or 12
    return [struct.unpack_from('<3f', bin_, base + i * stride) for i in range(a['count'])]


def apply_axis(m, v, ax):
    """Component `ax` of `m` applied to `v`, column-major: the row is (ax, ax+4, ax+8, ax+12), not the
    slice ax*4..ax*4+3 — that is a basis vector, not the row. The first draft used the slice, which for a
    node carrying only a translation silently drops the translation and compares local coordinates."""
    return m[ax] * v[0] + m[ax + 4] * v[1] + m[ax + 8] * v[2] + m[ax + 12]


def aabb(j, bin_):
    """[(x, y, z) extents] over every float32 POSITION primitive, in file space."""
    pts = all_points(j, bin_)
    lo = [min(v[i] for vs in pts.values() for v in vs) for i in range(3)]
    hi = [max(v[i] for vs in pts.values() for v in vs) for i in range(3)]
    return lo, hi


def all_points(j, bin_):
    """{path: [(x, y, z) in file space]} — the same walk as bounds(), keeping the triples so two files can
    be compared primitive by primitive instead of byte by byte. A byte count across two GLBs whose buffers
    are 16 bytes apart in offset reports millions of "differing bytes" that are only a shift."""
    roots = [n for sc in (j.get('scenes') or [{}]) for n in sc.get('nodes', [])]

    def walk(ni, parent, path):
        n = j['nodes'][ni]
        here = mul(parent, node_matrix(n))
        name = '%s/%s' % (path, n.get('name') or 'node%d' % ni)
        out = {}
        if 'mesh' in n:
            for pi, pr in enumerate(j['meshes'][n['mesh']].get('primitives', [])):
                ai = pr['attributes'].get('POSITION')
                pts = accessor_points(j, bin_, ai) if ai is not None else None
                if pts is None:
                    continue
                out['%s#%d' % (name, pi)] = [tuple(apply_axis(here, v, ax) for ax in range(3)) for v in pts]
        for c in n.get('children', []):
            out.update(walk(c, here, name))
        return out

    res = {}
    for r in roots:
        res.update(walk(r, IDENT, ''))
    return res


def bounds(j, bin_):
    """[(path, vertex count, (ymin, ymax))] for every float32 POSITION primitive, in file space. The
    other two axes are reported once, as the AABB, because props.js quotes the tower's metres across."""
    roots = [n for sc in (j.get('scenes') or [{}]) for n in sc.get('nodes', [])]

    def walk(ni, parent, path):
        n = j['nodes'][ni]
        here = mul(parent, node_matrix(n))
        name = '%s/%s' % (path, n.get('name') or 'node%d' % ni)
        rows = []
        if 'mesh' in n:
            for pi, p in enumerate(j['meshes'][n['mesh']].get('primitives', [])):
                ai = p['attributes'].get('POSITION')
                pts = accessor_points(j, bin_, ai) if ai is not None else None
                if pts is None:
                    continue
                ys = [apply_y(here, v) for v in pts]
                rows.append(('%s#%d' % (name, pi), len(pts), (min(ys), max(ys))))
        for c in n.get('children', []):
            rows += walk(c, here, name)
        return rows

    return [r for root in roots for r in walk(root, IDENT, '')]


def report(path):
    with open(path, 'rb') as f:
        blob = f.read()
    j, bin_, _ = load(path)
    rows = bounds(j, bin_)
    print('%s  %d bytes  sha256 %s' % (path, len(blob), hashlib.sha256(blob).hexdigest()[:16]))
    if not rows:
        raise ValueError('no float32 VEC3 POSITION accessor found')
    zmin = min(r[2][0] for r in rows)
    zmax = max(r[2][1] for r in rows)
    verts = sum(r[1] for r in rows)
    print('   file-space Y = [%+.3f .. %+.3f]  height %.3f  over %d verts / %d primitives'
          % (zmin, zmax, zmax - zmin, verts, len(rows)))
    for name, n, (a, b) in sorted(rows, key=lambda r: r[2][0])[:4]:
        print('     lowest  %-52s n=%-7d y=[%+.3f .. %+.3f]' % (name[-52:], n, a, b))
    for name, n, (a, b) in sorted(rows, key=lambda r: -r[2][1])[:2]:
        print('     top     %-52s n=%-7d y=[%+.3f .. %+.3f]' % (name[-52:], n, a, b))
    moved = [(n.get('name') or '?', node_matrix(n)) for n in j.get('nodes', [])]
    moved = [(nm, m) for nm, m in moved if any(abs(v) > 1e-6 for v in m[12:15])]
    lo, hi = aabb(j, bin_)
    print('   file-space AABB = %.3f x %.3f x %.3f m  (x, y, z; y is up)'
          % (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
    print('   nodes carrying an offset: %s' % (', '.join(
        '%s=[%+.3f %+.3f %+.3f]' % (nm, m[12], m[13], m[14]) for nm, m in moved[:8]) or 'none'))
    return zmin, zmax, verts, lo, hi


def points_of(path):
    j, bin_, _ = load(path)
    return all_points(j, bin_)


def pair_content(pa, pb):
    """Primitive-by-primitive content comparison, in metres. "The rebuild matches the library" has to
    mean the same vertices in the same places — a whole-file byte count cannot say that, because two
    GLBs whose binary chunks start 16 bytes apart differ in millions of bytes that are only a shift."""
    A, B = points_of(pa), points_of(pb)
    shared = [k for k in A if k in B]
    moved = same = 0
    worst = (0.0, '')
    for k in shared:
        a, b = A[k], B[k]
        n = min(len(a), len(b))
        if len(a) != len(b):
            print('   primitive %s: %d verts vs %d — not compared vertex by vertex' % (k, len(a), len(b)))
        for i in range(n):
            d = max(abs(a[i][ax] - b[i][ax]) for ax in range(3))
            if d > 1e-6:
                moved += 1
                if d > worst[0]:
                    worst = (d, '%s[%d]' % (k, i))
            else:
                same += 1
    only_a = [k for k in A if k not in B]
    only_b = [k for k in B if k not in A]
    print('   content over %d shared primitives: %d verts identical to within 1e-6 m, %d moved'
          % (len(shared), same, moved))
    print('   largest move = %s m at %s' % ('%.3e' % worst[0] if moved else '0', worst[1] or '-'))
    if only_a or only_b:
        print('   primitives only in one file: %s' % (', '.join(only_a + only_b) or 'none'))
    tot_a = sum(len(v) for v in A.values())
    tot_b = sum(len(v) for v in B.values())
    # Index-by-index comparison only says something when the two files emit vertices in the same order.
    # A rebuilt mesh whose faces came out in another order has the same cloth cut differently, so compare
    # the multisets too: "same vertices, new order" and "different vertices" need separate verdicts.
    QS = 1e-5
    key = lambda v: (round(v[0] / QS), round(v[1] / QS), round(v[2] / QS))
    set_same = set_diff = 0
    for k in shared:
        ca, cb = Counter(key(v) for v in A[k]), Counter(key(v) for v in B[k])
        if ca == cb:
            set_same += 1
        else:
            set_diff += 1
            print('   multiset differs in %s: %+d verts unique to the first file, %+d to the second'
                  % (k, sum((ca - cb).values()), sum((cb - ca).values())))
    print('   as multisets: %d/%d shared primitives hold exactly the same vertex set'
          % (set_same, len(shared)))
    print('   verts %d vs %d' % (tot_a, tot_b))
    print('   CONTENT_IDENTICAL=%s' % (not moved and not only_a and not only_b and tot_a == tot_b))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    try:
        a = report(sys.argv[1])
        if len(sys.argv) > 2:
            b = report(sys.argv[2])
            print('PAIR %s vs %s' % (sys.argv[1], sys.argv[2]))
            print('   datum (lowest y) delta = %+.6f m' % (b[0] - a[0]))
            print('   top (highest y)  delta = %+.6f m' % (b[1] - a[1]))
            print('   verts delta = %+d  (a content difference, not a datum one)' % (b[2] - a[2]))
            # Two different questions, so two lines: how far the box moved, and whether the box changed
            # size. Summing lo and hi into one number (an earlier draft) printed -5.0700 for a tower
            # whose height is identical in both files, which reads as a 5 m change in the wrong column.
            print('   AABB shift = %+.4f x %+.4f x %+.4f m'
                  % ((b[3][0] + b[4][0]) / 2 - (a[3][0] + a[4][0]) / 2,
                     (b[3][1] + b[4][1]) / 2 - (a[3][1] + a[4][1]) / 2,
                     (b[3][2] + b[4][2]) / 2 - (a[3][2] + a[4][2]) / 2))
            print('   AABB size  = %+.4f x %+.4f x %+.4f m'
                  % ((b[4][0] - b[3][0]) - (a[4][0] - a[3][0]),
                     (b[4][1] - b[3][1]) - (a[4][1] - a[3][1]),
                     (b[4][2] - b[3][2]) - (a[4][2] - a[3][2])))
            print('   DATUM_SAME=%s' % (abs(b[0] - a[0]) < 1e-3))
            pair_content(sys.argv[1], sys.argv[2])
        print('DATUM_PROBE_OK')
        return 0
    except (OSError, ValueError, KeyError) as e:
        print('DATUM_PROBE_CANNOT_READ %s — %s: %s' % (sys.argv[1], type(e).__name__, e))
        return 2


if __name__ == '__main__':
    sys.exit(main())
