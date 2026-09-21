"""Audit every GLB's pivot: does the exported geometry sit on its own origin (boots on the floor),
or is it modelled around its centre? props.js `put()` seats the ORIGIN on the terrain, so a model
whose bounding box starts above zero hangs in the air by exactly that many metres."""
import json, struct, sys, os

def mat4(t, r, s):
    x, y, z, w = r if r else (0, 0, 0, 1)
    m = [1 - 2*(y*y + z*z), 2*(x*y + w*z), 2*(x*z - w*y),
         2*(x*y - w*z), 1 - 2*(x*x + z*z), 2*(y*z + w*x),
         2*(x*z + w*y), 2*(y*z - w*x), 1 - 2*(x*x + y*y)]
    sx, sy, sz = s if s else (1, 1, 1)
    tx, ty, tz = t if t else (0, 0, 0)
    return [m[0]*sx, m[3]*sy, m[6]*sz, tx,
            m[1]*sx, m[4]*sy, m[7]*sz, ty,
            m[2]*sx, m[5]*sy, m[8]*sz, tz]

def mul(a, b):  # row-major 3x4 affine; result applies b first, then a
    out = []
    for r in range(3):
        for c in range(4):
            if c < 3:
                out.append(a[r*4]*b[c] + a[r*4+1]*b[4+c] + a[r*4+2]*b[8+c])
            else:
                out.append(a[r*4]*b[3] + a[r*4+1]*b[7] + a[r*4+2]*b[11] + a[r*4+3])
    return out

def xform(m, p):
    return tuple(m[i*4]*p[0] + m[i*4+1]*p[1] + m[i*4+2]*p[2] + m[i*4+3] for i in range(3))

def glb_json(path):
    with open(path, 'rb') as f:
        if f.read(4) != b'glTF': return None
        f.read(8)
        while True:
            head = f.read(8)
            if len(head) < 8: return None
            ln, ty = struct.unpack('<II', head)
            blob = f.read(ln)
            if ty == 0x4E4F534A: return json.loads(blob)

def walk(path):
    g = glb_json(path)
    meshes, nodes, accs = g.get('meshes', []), g.get('nodes', []), g.get('accessors', [])
    def node_box(i, parent, seen):
        if i in seen: return None
        seen.add(i)
        n = nodes[i]
        lm = mat4(n.get('translation'), n.get('rotation'), n.get('scale'))
        if parent: lm = mul(parent, lm)
        lo, hi = [1e9]*3, [-1e9]*3
        for mi in ([n['mesh']] if 'mesh' in n else []):
            for prim in meshes[mi]['primitives']:
                pos = prim['attributes'].get('POSITION')
                a = accs[pos] if pos is not None else None
                if not a or 'min' not in a: continue
                for xi in (0, 1):
                    for yi in (0, 1):
                        for zi in (0, 1):
                            p = xform(lm, (a['min'][0]*xi + a['max'][0]*(1-xi),
                                           a['min'][1]*yi + a['max'][1]*(1-yi),
                                           a['min'][2]*zi + a['max'][2]*(1-zi)))
                            for k in range(3):
                                lo[k] = min(lo[k], p[k]); hi[k] = max(hi[k], p[k])
        for c in n.get('children', []):
            r = node_box(c, lm, seen)
            if r:
                for k in range(3):
                    lo[k] = min(lo[k], r[0][k]); hi[k] = max(hi[k], r[1][k])
        return None if lo[0] > 1e8 else (lo, hi)
    lo, hi = [1e9]*3, [-1e9]*3
    for scene in g.get('scenes', [{}]):
        for root in scene.get('nodes', []):
            r = node_box(root, None, set())
            if r:
                for k in range(3):
                    lo[k] = min(lo[k], r[0][k]); hi[k] = max(hi[k], r[1][k])
    return lo, hi

for path in sys.argv[1:]:
    lo, hi = walk(path)
    if lo[0] > 1e8:
        print('%-28s  (no POSITION bounds)' % os.path.basename(path))
        continue
    base = lo[1]   # glTF is Y-up; props.js `put()` seats this origin on the terrain
    print('%-28s base=%+7.2f  w=%5.1f d=%5.1f h=%5.1f  %s' % (
        os.path.basename(path), base, hi[0]-lo[0], hi[2]-lo[2], hi[1]-lo[1],
        'OK  sits on origin' if abs(base) < 0.05 else
        ('FLOATS %.2f m' % base if base > 0 else 'SINKS %.2f m' % -base)))
