// Which vendored GLB materials may have their back faces culled, and which may not.
//
// Why this tool exists: Blender's glTF exporter writes `doubleSided: true` onto *every* material it
// exports, regardless of the model. GLTFLoader turns that into THREE.DoubleSide, which disables
// backface culling in the beauty pass and — because three derives `shadowSide` from `side` when
// `shadowSide` is null — draws both faces into the sun's depth map too. Measured on the hub at 640×696
// with the shadow map refreshed every frame: 1 704 062 of 2 213 894 scene triangles (77 %) were being
// rasterised twice, and culling them is worth 1.7 ms on a ~20 ms frame. Nothing in the library needs
// that; it is an exporter default, not an art decision.
//
// Culling is only safe on a closed shell, so the tool decides per primitive from the mesh topology:
// weld vertices by quantised position, then count edges touched by exactly one triangle (boundary
// edges). A closed solid has none. A one-sided *sheet* — cloth, leaf, ground quad, grille — has most
// of its edges on the boundary, and culling its back face makes it vanish when seen from behind.
// Sheets keep DoubleSide; everything else is culled.
//
// Usage:
//   node tools/audit_double_sided.mjs            # report
//   node tools/audit_double_sided.mjs --emit     # print the SHEETS table for src/world/assets.js
//   node tools/audit_double_sided.mjs --check    # exit 1 if that table is stale
import fs from 'fs';
import path from 'path';

const ROOT = 'public/assets';
const TARGET = 'src/world/assets.js';
// Culling is only provably safe on a *closed* shell, so the predicate is binary: a primitive with no
// boundary edge is a closed solid, and one with any boundary edge at all is open and must stay
// DoubleSide.
//
// This used to be a ratio — 25% boundary edges before a primitive counted as a sheet, on the grounds
// that 0.25 sat in the widest gap of the measured distribution. That gap was a measurement of the
// *thick* sheets only, and it got thin open shells wrong: the starship's aft skirt is a lampshade
// with two rim loops, so it measures ~4% boundary and was classed as a solid. Culled, it vanished as
// soon as the rover drove under the ship, and the overhead chopstick arm vanished from the pad. Set
// RSB_SHEET to a positive fraction to reproduce that classification and see what it deletes.
const SHEET = process.env.RSB_SHEET !== undefined ? +process.env.RSB_SHEET : 0;
const Q = 1e4; // weld tolerance: 0.1 mm, far below the smallest feature in the library
const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function glbs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) glbs(p, out);
    else if (e.name.endsWith('.glb')) out.push(p);
  }
  return out;
}

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file}: JSON chunk is first`);
  // chunk 0 = [8-byte header][jsonLen bytes], chunk 1 = [8-byte header][data]
  return { json: JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')), buf, bin: 20 + jsonLen + 8 };
}

function accessor(json, buf, bin, ix) {
  const a = json.accessors[ix];
  const bv = json.bufferViews[a.bufferView];
  const off = bin + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const n = a.count, c = TYPE_N[a.type], tc = a.componentType, sz = COMP[tc];
  if (!sz || !c) throw new Error(`accessor ${ix}: unsupported ${a.type}/${tc}`);
  const stride = bv.byteStride || sz * c;
  const data = new Float64Array(n * c);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      const p = off + i * stride + k * sz;
      data[i * c + k] = tc === 5126 ? buf.readFloatLE(p)
        : tc === 5125 ? buf.readUInt32LE(p)
        : tc === 5123 ? buf.readUInt16LE(p)
        : tc === 5121 ? buf.readUInt8(p)
        : tc === 5122 ? buf.readInt16LE(p)
        : tc === 5120 ? buf.readInt8(p)
        : buf.readDoubleLE(p);
    }
  }
  return { data, n, c };
}

// Boundary-edge count and unique-edge count for one triangle primitive, with vertices welded so
// seam-duplicated positions (glTF duplicates them for UVs) collapse to one.
function topology(pos, idx, tris) {
  const weld = new Map();
  let vid = 0;
  const at = (vi) => {
    const k = Math.round(pos[vi * 3] * Q) + ',' + Math.round(pos[vi * 3 + 1] * Q) + ',' + Math.round(pos[vi * 3 + 2] * Q);
    let v = weld.get(k);
    if (v === undefined) { v = vid++; weld.set(k, v); }
    return v;
  };
  const edges = new Map();
  for (let t = 0; t < tris; t++) {
    const v = [0, 1, 2].map(j => at(idx ? idx[t * 3 + j] : t * 3 + j));
    for (let j = 0; j < 3; j++) {
      const a = v[j], b = v[(j + 1) % 3];
      const e = a < b ? a * 2 ** 24 + b : b * 2 ** 24 + a;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const c of edges.values()) if (c === 1) boundary++;
  return { boundary, edges: edges.size };
}

const files = glbs(ROOT).filter(f => !f.startsWith(ROOT + '/web/'));
const prims = [];
for (const f of files) {
  const { json, buf, bin } = readGlb(f);
  const rel = path.relative(ROOT, f).replace(/\.glb$/, '');
  const mats = json.materials || [];
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives) {
      if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
      const pos = accessor(json, buf, bin, prim.attributes.POSITION);
      const ix = prim.indices ? accessor(json, buf, bin, prim.indices) : null;
      const tris = Math.floor((ix ? ix.n : pos.n) / 3);
      if (!tris) continue;
      const { boundary, edges } = topology(pos.data, ix ? ix.data : null, tris);
      const m = prim.material === undefined ? null : mats[prim.material];
      prims.push({ file: rel, mat: m ? (m.name || '(anon)') : '(none)', dbl: m ? !!m.doubleSided : false, tris, boundary, ratio: edges ? boundary / edges : 0 });
    }
  }
}

const sheets = prims.filter(p => p.boundary && p.ratio >= SHEET);
const pinhole = prims.filter(p => p.boundary && p.ratio < SHEET);
const byName = new Map();
for (const p of prims) {
  const e = byName.get(p.mat) || { mat: p.mat, tris: 0, sheetTris: 0, sheetPrims: 0, prims: 0, files: new Set() };
  e.tris += p.tris; e.prims++; e.files.add(p.file);
  if (p.boundary && p.ratio >= SHEET) { e.sheetTris += p.tris; e.sheetPrims++; }
  byName.set(p.mat, e);
}
const keep = [...byName.values()].filter(e => e.sheetPrims).sort((a, b) => b.tris - a.tris);
const keepTris = keep.reduce((s, e) => s + e.tris, 0);
const allTris = prims.reduce((s, p) => s + p.tris, 0);
// One-sided sheets are only dangerous in the color pass. A *fully closed* asset is also invisible
// from its own inside, so list which assets lose DoubleSide altogether — that is the enterability
// audit the frame sweep has to cover.
const sheetFiles = new Set(sheets.map(p => p.file));
const allCull = new Set(prims.map(p => p.file).filter(f => !sheetFiles.has(f)));

const table = keep.map(e => ({ mat: e.mat, tris: e.tris, sheetTris: e.sheetTris, files: [...e.files].sort() }));

if (process.argv.includes('--emit')) {
  console.log(table.map(r => `  // ${r.mat}: ${r.sheetTris} sheet triangles of ${r.tris} — ${r.files.slice(0, 3).join(', ')}${r.files.length > 3 ? ` +${r.files.length - 3} more` : ''}`).join('\n'));
  console.log('export const SHEET_MATERIALS = new Set([\n' + table.map(r => `  '${r.mat}',`).join('\n') + '\n]);');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const src = fs.readFileSync(TARGET, 'utf8');
  const block = src.match(/const SHEET_MATERIALS = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) { console.error('assets.js: no SHEET_MATERIALS set found'); process.exit(1); }
  // Strip line comments first: the prose above the set quotes `tools/audit_double_sided.mjs` and
  // `--check` in backticks, and a bare quote scan happily pairs a backtick with the next apostrophe
  // and reports the sentence as a stale material name.
  const quoted = block[1].replace(/^[ \t]*\/\/.*$/gm, '').match(/'[^']+'/g);
  if (!quoted) { console.error("assets.js SHEET_MATERIALS holds no quoted name — an empty set is a failure, not a pass"); process.exit(1); }
  const committed = quoted.map(s => s.slice(1, -1)).sort();
  const mine = table.map(r => r.mat).sort();
  const missing = mine.filter(m => !committed.includes(m));
  const stale = committed.filter(c => !mine.includes(c));
  if (missing.length || stale.length) {
    console.error(`assets.js SHEET_MATERIALS is stale vs ${ROOT}/**.glb\n  missing (asset sheets not yet whitelisted): ${missing.join(', ') || '-'}\n  stale (whitelisted but no longer a sheet):    ${stale.join(', ') || '-'}\n  regenerate: node tools/audit_double_sided.mjs --emit`);
    process.exit(1);
  }
  console.log(`SHEET_MATERIALS matches the library: ${mine.length} materials, ${keepTris} of ${allTris} triangles kept DoubleSide (${(100 * keepTris / allTris).toFixed(1)}%).`);
  process.exit(0);
}

console.log(JSON.stringify({
  glbs: files.length,
  trianglePrims: prims.length,
  triangles: allTris,
  doubleSidedFlagged: prims.filter(p => p.dbl).length,
  sheetPrims: sheets.length,
  sheetTris: sheets.reduce((s, p) => s + p.tris, 0),
  pinholePrims: pinhole.length,
  pinholeTris: pinhole.reduce((s, p) => s + p.tris, 0),
  keepDoubleSideMaterials: keep.length,
  keepTris,
  keepPct: +(100 * keepTris / allTris).toFixed(1),
  culledMaterials: byName.size - keep.length,
  assetsLosingDoubleSideEntirely: [...allCull].sort(),
}, null, 1));
console.log('\nmat                 tris   sheet   files');
for (const e of keep) console.log(e.mat.padEnd(18) + String(e.tris).padStart(7) + String(e.sheetTris).padStart(8) + '   ' + [...e.files].slice(0, 3).join(', ') + (e.files.size > 3 ? ` +${e.files.size - 3}` : ''));
