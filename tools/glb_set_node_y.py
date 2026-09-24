#!/usr/bin/env python3
"""Re-datum a GLB by rewriting one node's Y translation.

Site assets have to be authored with their origin on the surface they stand on. This edits that
translation in place — the JSON chunk only, no vertex data — so the placement code can seat the
prop on the graded ground without a per-prop offset constant.

  python3 tools/glb_set_node_y.py public/assets/launch_tower.glb tower_body 0

Exits non-zero if the node is missing, if it is not the only node moved, or if the re-read after
writing does not match. Idempotent: running it twice is a no-op.
"""
import json
import struct
import sys

MAGIC, VERSION = 0x46546C67, 2
JSON_CHUNK = struct.unpack('<I', b'JSON')[0]


def read(path):
    with open(path, 'rb') as fh:
        blob = fh.read()
    magic, version, total = struct.unpack('<3I', blob[:12])
    assert magic == MAGIC and version == VERSION, f'{path}: not a GLB v2 (magic {magic:#x} v{version})'
    assert total == len(blob), f'{path}: header length {total} != file {len(blob)}'
    chunks, off = [], 12
    while off < total:
        length = struct.unpack('<I', blob[off:off + 4])[0]
        kind = struct.unpack('<I', blob[off + 4:off + 8])[0]
        chunks.append((kind, off, length))
        off += 8 + length
    return blob, chunks


def json_chunk(chunks):
    hits = [c for c in chunks if c[0] == JSON_CHUNK]
    assert len(hits) == 1, f'{len(hits)} JSON chunks'
    return hits[0]


def parse(blob, chunk):
    _, off, length = chunk
    return json.loads(blob[off + 8:off + 8 + length].rstrip(b'\x00 '))


def serialise(doc):
    payload = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    return payload + b' ' * (-len(payload) % 4)


def main(path, node_name, want):
    blob, chunks = read(path)
    jchunk = json_chunk(chunks)
    assert jchunk == chunks[0], 'JSON chunk must come first so the binary chunk keeps its order'
    doc = parse(blob, jchunk)
    nodes = doc.get('nodes', [])
    hits = [i for i, n in enumerate(nodes) if n.get('name') == node_name]
    assert len(hits) == 1, f'node {node_name!r}: {len(hits)} matches, need exactly 1'
    node = nodes[hits[0]]
    tr = list(node.get('translation') or [0.0, 0.0, 0.0])
    before = tr[1]
    moved = [i for i, n in enumerate(nodes) if (n.get('translation') or [0, 0, 0])[1]]
    assert moved in ([], [hits[0]]), f'other nodes carry a Y offset too: {moved}'
    tr[1] = float(want)
    node['translation'] = tr

    payload = serialise(doc)
    rest = blob[jchunk[1] + 8 + jchunk[2]:]
    out = blob[:12] + struct.pack('<II', len(payload), JSON_CHUNK) + payload + rest
    out = out[:8] + struct.pack('<I', len(out)) + out[12:]
    with open(path, 'wb') as fh:
        fh.write(out)

    check, c2 = read(path)
    got = parse(check, json_chunk(c2))['nodes'][hits[0]]['translation'][1]
    assert abs(got - float(want)) < 1e-6, f're-read gave {got}, wanted {want}'
    tail = struct.unpack('<I', check[12 + 8 + len(payload):12 + 12 + len(payload)])[0]
    assert check[12 + 8 + len(payload) + 8:] == blob[12 + 8 + jchunk[2] + 8:], 'binary chunk moved'
    print(f'{path}: {node_name}.translation.y {before} -> {got}  '
          f'(json {jchunk[2]} -> {len(payload)} B, file {len(blob)} -> {len(out)} B, '
          f'binary chunk {tail} B untouched)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
