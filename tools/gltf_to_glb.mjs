// gltf_to_glb.mjs — merge a multi-file glTF (.gltf + .bin + external textures)
// into a single self-contained .glb (assets.js:171 only loads ./assets/<name>.glb).
//
// Usage: node tools/gltf_to_glb.mjs <in.gltf> <out.glb>
//
// Strategy (keeps textures byte-identical, no image re-encode, low memory):
//   BIN chunk  = geometry .bin (zero-padded to 4) ++ each JPEG appended 4-aligned,
//                exposed as plain bufferViews over buffer 0 (images[].uri -> bufferView).
//   JSON chunk = original .gltf JSON with uri fields stripped, padded with 0x20.
// Also reports: bytes, triangle count (INDEX/MODE per primitive) and world-space
// bbox in metres (POSITION accessor min/max pushed through node world matrices),
// so intake can be checked against the repo's 1 unit = 1 m rule.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { Matrix4, Vector3, Quaternion } from 'three';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node tools/gltf_to_glb.mjs <in.gltf> <out.glb>');
  process.exit(1);
}
const base = dirname(resolve(inPath));
const gltf = JSON.parse(readFileSync(inPath, 'utf8'));
if ((gltf.buffers || []).length !== 1) throw new Error('expected exactly one buffer');
if (gltf.buffers[0].uri === undefined || gltf.buffers[0].uri.startsWith('data:'))
  throw new Error('expected one external (non-data) buffer');

// --- gather geometry bin + image bytes, build new BIN chunk -----------------
const chunks = [];
let geomLen = 0;
{
  const buf = readFileSync(join(base, gltf.buffers[0].uri));
  if (buf.length !== gltf.buffers[0].byteLength)
    throw new Error(`bin size mismatch: ${buf.length} != ${gltf.buffers[0].byteLength}`);
  chunks.push(buf);
  geomLen = pad4(buf.length);
  if (geomLen > buf.length) chunks.push(Buffer.alloc(geomLen - buf.length));
}
gltf.buffers[0] = { byteLength: 0 }; // placeholder, finalised below

gltf.bufferViews = gltf.bufferViews || [];
gltf.images = gltf.images || [];
const embedded = [];
let off = geomLen;
for (const img of gltf.images) {
  if (!img.uri) { embedded.push('(already embedded)'); continue; }
  const file = join(base, decodeURIComponent(img.uri));
  const imgName = img.uri;
  const data = readFileSync(file); // 4-aligned append, then released with `chunks`
  chunks.push(data);
  const padded = pad4(data.length);
  if (padded > data.length) chunks.push(Buffer.alloc(padded - data.length));
  gltf.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: data.length });
  const mimeType = img.mimeType ||
    (/\.png$/i.test(img.uri) ? 'image/png' : 'image/jpeg');
  img.bufferView = gltf.bufferViews.length - 1;
  img.mimeType = mimeType;
  delete img.uri;
  embedded.push({ file: imgName, bytes: data.length });
  off += padded;
}
const bin = Buffer.concat(chunks);
gltf.buffers[0].byteLength = bin.length;

// --- serialize GLB -----------------------------------------------------------
const jsonStr = JSON.stringify(gltf);
const jsonBuf = Buffer.from(jsonStr, 'utf8');
const jsonPad = pad4(jsonBuf.length);
const jsonChunk = Buffer.alloc(jsonPad, 0x20);
jsonBuf.copy(jsonChunk);
const binPad = pad4(bin.length);
const binChunk = bin.length === binPad ? bin : Buffer.concat([bin, Buffer.alloc(binPad - bin.length)]);

const glb = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length);
let p = 0;
glb.writeUInt32LE(0x46546c67 /* 'glTF' */, p); p += 4; // magic
glb.writeUInt32LE(2, p); p += 4;                     // version
glb.writeUInt32LE(glb.length, p); p += 4;            // total length
glb.writeUInt32LE(jsonChunk.length, p); p += 4;
glb.writeUInt32LE(0x4e4f534a /* JSON */, p); p += 4;
jsonChunk.copy(glb, p); p += jsonChunk.length;
glb.writeUInt32LE(binChunk.length, p); p += 4;
glb.writeUInt32LE(0x004e4942 /* BIN\x00 */, p); p += 4;
binChunk.copy(glb, p);
writeFileSync(outPath, glb);

// --- report: triangles + world bbox (read back from the written GLB) --------
const report = analyze(outPath);
report.out = outPath;
report.bytes = statSync(outPath).size;
report.sourceBinBytes = geomLen;
report.textures = embedded;
console.log(JSON.stringify(report, null, 2));

function pad4(n) { return (n + 3) & ~3; }

function analyze(file) {
  const g = readFileSync(file);
  if (g.readUInt32LE(0) !== 0x46546c67) throw new Error('bad magic after write');
  const jsonLen = g.readUInt32LE(12);
  const j = JSON.parse(g.subarray(20, 20 + jsonLen).toString('utf8'));
  const binBuf = g.subarray(20 + jsonLen + 8, g.length);
  let tris = 0, points = 0, lines = 0, meshes = 0;
  const accessors = j.accessors, bufferViews = j.bufferViews, meshesList = j.meshes;
  function posMinMax(accIdx) {
    const a = accessors[accIdx];
    if (a.min && a.max) return [a.min, a.max];
    const bv = bufferViews[a.bufferView];
    const view = binBuf.subarray((bv.byteOffset || 0) + (a.byteOffset || 0),
      (bv.byteOffset || 0) + (a.byteOffset || 0) + bv.byteLength);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < a.count; i++)
      for (let k = 0; k < 3; k++) {
        const v = view.readFloatLE(i * 12 + k * 4);
        if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
      }
    return [mn, mx];
  }
  function nodeMat(n) {
    const m = new Matrix4();
    if (n.matrix) return m.fromArray(n.matrix);
    // glTF TRS: translation xyz, quaternion xyzw, scale xyz
    const q = n.quaternion ? new Quaternion(n.quaternion[0], n.quaternion[1], n.quaternion[2], n.quaternion[3]) : new Quaternion();
    m.compose(new Vector3(...(n.translation || [0, 0, 0])), q, new Vector3(...(n.scale || [1, 1, 1])));
    return m;
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const v = new Vector3();
  function walk(n, parent) {
    const world = parent.clone().multiply(nodeMat(n));
    const meshIdx = n.mesh === undefined ? [] : [n.mesh];
    for (const mi of meshIdx) {
      meshes++;
      for (const prim of meshesList[mi].primitives) {
        const mode = prim.mode ?? 4;
        const count = accessors[prim.indices ?? prim.attributes.POSITION].count;
        if (prim.indices !== undefined) {
          if (mode === 4) tris += count / 3; else if (mode === 1) lines += count / 2; else if (mode === 0) points += count;
        } else if (mode === 4) tris += count / 3;
        if (prim.attributes.POSITION === undefined) continue;
        const [aMin, aMax] = posMinMax(prim.attributes.POSITION);
        for (let i = 0; i < 8; i++) {
          v.set(i & 1 ? aMax[0] : aMin[0], i & 2 ? aMax[1] : aMin[1], i & 4 ? aMax[2] : aMin[2]).applyMatrix4(world);
          for (let k = 0; k < 3; k++) {
            const val = v.getComponent(k);
            if (val < mn[k]) mn[k] = val; if (val > mx[k]) mx[k] = val;
          }
        }
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  }
  for (const s of j.scenes) for (const root of s.nodes) walk(j.nodes[root], new Matrix4());
  const texNames = (j.images || []).map(i => {
    const bv = j.bufferViews[i.bufferView];
    const sig = binBuf.subarray(bv.byteOffset, bv.byteOffset + 3);
    return { size: bv.byteLength, jpeg: sig[0] === 0xff && sig[1] === 0xd8 };
  });
  return {
    triangles: tris, points, lines, meshPrims: meshes,
    bboxMin: mn.map(x => +x.toFixed(3)), bboxMax: mx.map(x => +x.toFixed(3)),
    bboxSizeMeters: mn.map((x, k) => +(mx[k] - x).toFixed(3)),
    embeddedTexturesOk: texNames.every(t => t.jpeg && t.size > 0),
    textureCount: texNames.length,
  };
}
