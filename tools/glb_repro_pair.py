#!/usr/bin/env python3
# ============================================================================
# RED STARBASE — builder reproducibility gate (#95)
#
# Runs one headless build command TWICE, keeps both GLBs, and says in plain
# lines whether a rebuild of unchanged source is byte-identical — and if it is
# not, which class of bytes moved.
#
# Why the class split matters: a glTF rebuild can drift in three different
# ways and only two of them are ours to fix.
#   SCALAR/ELEMENT_BUFFER drift  = the triangle INDEX buffer came out in a
#         different order. The asset renders the same, but two builds of the
#         UNCHANGED launch_tower script differed by 10 593 index bytes at an
#         identical file size (measured 2026-09-27, see
#         tools/logs/repro-uv-sphere-2026-09-27.log §2), so no re-run could be
#         compared to any other re-run. Cause: bmesh/`primitive_uv_sphere_add`
#         emits its face list in a per-call order that is not repeatable, and
#         the exporter writes indices in face order.
#   VEC*/ARRAY_BUFFER drift      = float attribute values (UVs) off by 1-4 ULP.
#         Cause: `bmesh.ops.bevel(clamp_overlap=True)` interpolates the UV
#         layer with an order that depends on allocator state (same minimal
#         repro file). Nothing in the builders can pin it without changing the
#         numbers themselves.
#   JSON chunk drift             = names, accessors, materials or the exporter
#         version moved. Always a real content difference.
#
# Exit codes are named in the output lines, not invented per run:
#   0  REPRO_PAIR_IDENTICAL       two runs, byte for byte the same
#   1  REPRO_PAIR_INDEX_DRIFT     index buffers differ (the #95 failure)
#   3  REPRO_PAIR_FLOAT_DRIFT     indices identical, only float attributes move
#   2  REPRO_PAIR_JSON_DRIFT      the glTF structure itself differs
#   4  REPRO_PAIR_FAILED          a run did not produce the expected file
#
# Usage:
#   python3 tools/glb_repro_pair.py <asset.glb written by the command> -- <command...>
# e.g.
#   python3 tools/glb_repro_pair.py /tmp/rsb_stage3/lamp.glb -- \
#       blender --background --python tools/blender/build_base_v2.py -- lamp
# ============================================================================
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from collections import Counter

ELEMENT_BUFFER = 34963


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for blk in iter(lambda: f.read(1 << 20), b''):
            h.update(blk)
    return h.hexdigest()


def glb_chunks(path):
    d = open(path, 'rb').read()
    if d[:4] != b'glTF':
        raise SystemExit('%s is not a GLB' % path)
    off = 12
    out = {}
    while off + 8 <= len(d):
        ln, typ = struct.unpack('<II', d[off:off + 8])
        out[typ] = d[off + 8:off + 8 + ln]
        off += 8 + ln
    return out


def compare(p1, p2):
    """Return (json_equal, class_counter, ulp_max) for the two GLBs."""
    c1, c2 = glb_chunks(p1), glb_chunks(p2)
    json_equal = c1.get(0x4E4F534A) == c2.get(0x4E4F534A)
    b1, b2 = c1.get(0x004E4942, b''), c2.get(0x004E4942, b'')
    if not json_equal:
        return json_equal, Counter({'json': 1}), 0
    j = json.loads(c1[0x4E4F534A])
    per = Counter()
    ulp = 0
    for k, ac in enumerate(j['accessors']):
        bv = j['bufferViews'][ac['bufferView']]
        s = bv['byteOffset'] + ac.get('byteOffset', 0)
        n = ac['count']
        ct = ac['componentType']
        comps = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[ac['type']]
        size = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[ct]
        L = n * comps * size
        a1, a2 = b1[s:s + L], b2[s:s + L]
        if a1 == a2:
            continue
        per[(ac['type'], bv.get('target'), ct)] += sum(1 for x, y in zip(a1, a2) if x != y)
        if ct == 5126:
            w1 = struct.unpack('<%dI' % (L // 4), a1)
            w2 = struct.unpack('<%dI' % (L // 4), a2)
            ulp = max([ulp] + [abs(x - y) for x, y in zip(w1, w2) if x != y])
    return json_equal, per, ulp


def main():
    args = sys.argv[1:]
    if '--' not in args:
        print('usage: glb_repro_pair.py <asset.glb> -- <command...>')
        raise SystemExit(64)
    sep = args.index('--')
    asset = args[:sep][0]
    cmd = args[sep + 1:]
    # This tool moves the produced file out of the way twice, so it must never
    # be pointed at a shipped asset: rsbkit-based builders write straight into
    # public/assets and their OUT has to be redirected first (see
    # tools/blender/rsbkit.py:OUT). Refusing beats restoring from a copy.
    if os.path.abspath(asset).startswith(os.path.abspath(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                         'public', 'assets'))):
        print('REPRO_PAIR_REFUSED %s is under public/assets — redirect the builder '
              'OUT to a scratch dir first' % asset)
        raise SystemExit(65)
    scratch = tempfile.mkdtemp(prefix='rsb-repro-')
    kept = []
    for i in (1, 2):
        if os.path.exists(asset):
            os.remove(asset)
        t0 = time.time()
        log = os.path.join(scratch, 'run%d.log' % i)
        with open(log, 'wb') as f:
            rc = subprocess.call(cmd, stdout=f, stderr=subprocess.STDOUT)
        if not os.path.isfile(asset) or os.path.getsize(asset) == 0:
            print('REPRO_PAIR_FAILED run=%d rc=%d no asset at %s (see %s)' % (i, rc, asset, log))
            raise SystemExit(4)
        dst = os.path.join(scratch, 'run%d.glb' % i)
        shutil.move(asset, dst)
        kept.append(dst)
        print('REPRO_PAIR run=%d rc=%d %.1fs bytes=%d sha256=%s'
              % (i, rc, time.time() - t0, os.path.getsize(dst), sha256(dst)))
    if kept[0] == kept[1]:
        pass
    h1, h2 = sha256(kept[0]), sha256(kept[1])
    print('REPRO_PAIR scratch=%s' % scratch)
    if h1 == h2:
        print('REPRO_PAIR_IDENTICAL %s' % os.path.basename(kept[0]))
        raise SystemExit(0)
    json_equal, per, ulp = compare(kept[0], kept[1])
    print('REPRO_PAIR json_equal=%s float_ulp_max=%d' % (json_equal, ulp))
    for (typ, target, ct), n in per.most_common(12):
        kind = 'INDEX' if target == ELEMENT_BUFFER else 'ATTRIBUTE'
        print('REPRO_PAIR   %-9s %-5s compType=%d target=%s differing_bytes=%d'
              % (kind, typ, ct, target, n))
    if not json_equal:
        print('REPRO_PAIR_JSON_DRIFT structure itself differs')
        raise SystemExit(2)
    idx = sum(n for (typ, target, ct), n in per.items() if target == ELEMENT_BUFFER)
    if idx:
        print('REPRO_PAIR_INDEX_DRIFT triangle index buffers differ (%d bytes)' % idx)
        raise SystemExit(1)
    print('REPRO_PAIR_FLOAT_DRIFT indices identical; only float attributes move '
          '(%d bytes, <=%d ULP)' % (sum(per.values()), ulp))
    raise SystemExit(3)


main()
