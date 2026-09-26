// cc0-conform.mjs — conformance gate for CC0 intake candidates (work item #96).
//
// Usage: node tools/cc0-conform.mjs <candidate.glb> [more.glb ...]
//
// Prints ONE machine-checkable `KEY=VALUE|...` line per asset, then a rule-source
// block, and exits 1 if any asset fails any check. A verify script that only
// prints is decoration; this one sets an exit code.
//
// Rules, established from the repo (not invented here):
//   R1 scale        The only 3.5 in the runtime is `src/world/props.js:21`
//                   `const S = 3.5; // Kenney grid → diorama scale` — a multiplier
//                   applied to Kenney kit models at `src/world/props.js:740`
//                   (`putSolid(name, x, z, S * sc, ...)`), NOT an upper bound, and
//                   it never touches hero GLBs (those go through `putSolid` with an
//                   absolute scale, e.g. props.js:1969-2043). There is NO
//                   `conforms`-style validator and NO "3.5× mesh extent" cap
//                   anywhere in the repo (grep 2026-09-26: only hits are the Kenney
//                   multiplier, shadow_budget.js thresholds, and prose). What the
//                   repo does carry is the intake convention "1 unit = 1 m", noted
//                   at `tools/gltf_to_glb.mjs:12` and `staging/cc0/INTAKE.md:36-38`.
//                   This script therefore checks the *measurable* part: the asset's
//                   real-world extent must sit inside the shipped library's extent
//                   envelope (largest shipped GLB, measured at run time).
//                   LIMIT = max bbox extent over the shipped library.
//   R2 budget       No written triangle/vertex budget exists in the repo (checked:
//                   docs/, src/, tools/). `shadow_budget.js` budgets shadow-caster
//                   *area*, not asset triangles. LIMIT here is likewise measured:
//                   the largest currently-shipped GLB by triangles / vertices.
//   R3 emissive     props.js art-directs glTF emissives by MATERIAL NAME:
//                   'pad_glow' (props.js:146), /^light_/ (props.js:147),
//                   'plant'/'crystal_mat' (props.js:172) get their emissive drive
//                   set; the comment at props.js:123-124 states why — "glTF
//                   emissives arrive at full strength; under the sun + bloom band
//                   they blow out into white discs". Any material that carries an
//                   emissive factor/texture and is NOT one of those names keeps
//                   full-strength emissive -> FAIL.
//   R3b palette     Same mechanism one level broader: re-tint / BRDF /
//                   double-sided / desun passes in assets.js+props.js key off
//                   material name (assets.js:14-18 BRDF, 68-86 SHEET_MATERIALS,
//                   props.js:140-181 name branches, 214-233 SHELL). BUT the repo
//                   has no rule that a name must appear there — shipped heroes
//                   carry unhooked authored names — so this is reported as INFO
//                   (count of names receiving zero repo-side handling), never a
//                   gate. Style risk is prose in staging/cc0/INTAKE.md:42,80.
//   R4 collision    Colliders are NOT hand-typed per asset any more: they are
//                   derived from the lot rectangle the geometry occupies
//                   (props.js:651-658 comment; putSolid -> footOf() bbox -> lot()
//                   -> coverDiscs(), props.js:742-752, 717-728; plan.js coverDiscs).
//                   The one risk is the lamp case (props.js:754-760, LAMP_BASE): an
//                   asset whose full XZ footprint is far wider than its FOOTPRINT
//                   BELOW 0.25 m (same 0.25 m datum props.js:757 uses) would get an
//                   invisible wall around empty air. That case is reported as
//                   NEEDS-FOOT-EXCEPTION (informational; not an exit-code fail).

import { readFileSync, readdirSync } from 'node:fs';
import { Matrix4, Vector3, Quaternion } from 'three';

const argv = process.argv.slice(2);
if (!argv.length || argv.some(a => a === '-h' || a === '--help')) {
  console.error('usage: node tools/cc0-conform.mjs <file.glb> [more.glb ...]');
  process.exit(2);
}

function readGlb(file) {
  const g = readFileSync(file);
  if (g.length < 28 || g.readUInt32LE(0) !== 0x46546c67 || g.readUInt32LE(4) !== 2)
    throw new Error(`${file}: not a GLB v2`);
  const jsonLen = g.readUInt32LE(12);
  if (g.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file}: JSON chunk missing`);
  const json = JSON.parse(g.subarray(20, 20 + jsonLen).toString('utf8'));
  const binOff = 20 + jsonLen;
  let bin;
  if (binOff + 8 <= g.length && g.readUInt32LE(binOff + 4) === 0x004e4942)
    bin = g.subarray(binOff + 8, binOff + 8 + g.readUInt32LE(binOff));
  else bin = Buffer.alloc(0);
  return { json, bin, bytes: g.length };
}

function nodeMat(n) {
  const m = new Matrix4();
  if (n.matrix) return m.fromArray(n.matrix);
  const q = n.quaternion ? new Quaternion(...n.quaternion) : new Quaternion();
  return m.compose(new Vector3(...(n.translation || [0, 0, 0])), q,
    new Vector3(...(n.scale === undefined ? [1, 1, 1] : n.scale)));
}

function accessorRange(json, bin, accIdx) {
  const a = json.accessors[accIdx];
  const bv = json.bufferViews[a.bufferView ?? 0];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const itemW = 12; // VEC3 float32 assumed for POSITION
  if (a.componentType !== 5126 || a.type !== 'VEC3')
    throw new Error(`accessor ${accIdx}: unexpected ${a.type}/0x${a.componentType.toString(16)}`);
  if (a.min && a.max) return { view: bin.subarray(off, off + a.count * itemW), count: a.count, stride: itemW };
  return { view: bin.subarray(off, off + a.count * itemW), count: a.count, stride: bv.byteStride || itemW };
}

// Props.js / assets.js name hooks that neutralise or re-tint a material. A name
// matching none of these arrives at the scene untouched (R3b), and an emissive
// under such a name blows bloom (R3).
const WHITELIST_EMISSIVE = [/^light_/, /^pad_glow$/, /^plant$/, /^crystal_mat$/]; // props.js:146-172
const PALETTE_NAMES = new Set([ // assets.js:15-17 BRDF + props.js SHELL keys
  'metal', 'metalDark', 'metalRed', 'dark', 'rock', 'rockDark', 'rockTrack', 'dirt', 'grass',
  'skin', 'crystal', 'leaf', 'wood', '_defaultMat',
  'hull_white', 'hull_warm', 'cryo_insul', 'steel', 'alu_bright', 'acc_orange', 'orange',
]);
const PALETTE_PATTERNS = [ // props.js:140-181 + assets.js SHEET_MATERIALS names
  /^glass_pane$/, /^glass_clear$/, /^pad_glow$/, /^light_/, /^plant$/, /^crystal_mat$/,
  /^dark_/, /^solar_cell$/, /^rover_/, /^pad_white$/, /^hero_/, /^deck_/, /^cu_pipe$/,
  /^composite_/, /^footing_/, /^floor_/, /^rust_/, /^worn_/, /^rocket_/, /^thruster_/,
  /^grow_/, /^dust_mars$/, /^dirt$/, /^grass$/, /^rockTrack$/, /^rock$/, /^rockDark$/,
  /^crystal$/, /^leaf$/, /^wood$/, /^skin$/, /^metal$/, /^metalDark$/, /^metalRed$/, /^_defaultMat$/,
];

function analyze(file, candidateSet) {
  const { json: j, bin, bytes } = readGlb(file);
  const nodes = j.nodes || [];
  let prims = 0, tris = 0, verts = 0;
  const seenMesh = new Set();
  let vertsUnique = 0;
  const usedMatIdx = new Set();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const bmn = [Infinity, Infinity, Infinity], bmx = [-Infinity, -Infinity, -Infinity]; // foot y<0.25
  const v = new Vector3();
  function walk(n, parent) {
    const world = parent.clone().multiply(nodeMat(n));
    if (n.mesh !== undefined) {
      if (!seenMesh.has(n.mesh)) { seenMesh.add(n.mesh); }
      for (const p of j.meshes[n.mesh].primitives) {
        prims++;
        const mode = p.mode ?? 4;
        if (mode === 4) tris += Math.floor((p.indices !== undefined
          ? j.accessors[p.indices].count : j.accessors[p.attributes.POSITION].count) / 3);
        const posAcc = p.attributes.POSITION;
        if (posAcc !== undefined) {
          const a = j.accessors[posAcc];
          verts += a.count;
          const { view, count, stride } = accessorRange(j, bin, posAcc);
          for (let i = 0; i < count; i++) {
            for (let k = 0; k < 3; k++) v.setComponent(k, view.readFloatLE(i * stride + k * 4));
            v.applyMatrix4(world);
            for (let k = 0; k < 3; k++) {
              const x = v.getComponent(k);
              if (x < mn[k]) mn[k] = x; if (x > mx[k]) mx[k] = x;
            }
            if (v.y < 0.25) for (let k of [0, 2]) {
              const x = v.getComponent(k);
              if (x < bmn[k]) bmn[k] = x; if (x > bmx[k]) bmx[k] = x;
            }
          }
        }
        if (p.material !== undefined) usedMatIdx.add(p.material);
      }
    }
    for (const c of n.children || []) walk(nodes[c], world);
  }
  const sceneRoots = (j.scenes && j.scenes.length) ? j.scenes[0].nodes : (j.nodes || []).map((_, i) => i);
  for (const r of sceneRoots) walk(nodes[r], new Matrix4());
  // unique-vertex pass: count each referenced mesh's primitive once
  vertsUnique = 0;
  for (const mi of seenMesh) for (const p of j.meshes[mi].primitives)
    if (p.attributes.POSITION !== undefined) vertsUnique += j.accessors[p.attributes.POSITION].count;

  const mats = [...usedMatIdx].sort().map(i => j.materials[i]);
  const names = mats.map(m => m.name || '(unnamed)');
  const emissive = mats.filter(m =>
    (m.emissiveTexture !== undefined) ||
    ((m.emissiveFactor || [0, 0, 0]).some(x => x > 0)) ||
    (m.extensions && m.extensions.KHR_materials_emissive_strength));
  const size = mn.map((x, k) => mx[k] - x);
  const foot = (bmn[0] === Infinity) ? [0, 0, 0] : [bmx[0] - bmn[0], 0, bmx[2] - bmn[2]];
  return { file, bytes, prims, tris: Math.round(tris), verts, vertsUnique,
    size, maxExtent: Math.max(...size), names, emissiveNames: emissive.map(m => m.name),
    foot, footOk: bmn[0] !== Infinity };
}

// ── baseline: the shipped library (everything under public/assets/*.glb that
//    is not one of the candidates given on the command line) ──
const candFiles = new Set(argv.map(a => a.replace(/\\/g, '/').split('/').pop()));
const dir = 'public/assets';
const shipped = readdirSync(dir).filter(f => f.endsWith('.glb') && !candFiles.has(f));
let baseTris = 0, baseTrisFile = '', baseVerts = 0, baseVertsFile = '',
    baseExtent = 0, baseExtentFile = '', minTris = Infinity;
for (const f of shipped) {
  const r = analyze(`${dir}/${f}`, candFiles);
  if (r.tris > baseTris) { baseTris = r.tris; baseTrisFile = f.replace(".glb", ""); }
  if (r.tris < minTris) minTris = r.tris;
  if (r.vertsUnique > baseVerts) { baseVerts = r.vertsUnique; baseVertsFile = f.replace(".glb", ""); }
  if (r.maxExtent > baseExtent) { baseExtent = r.maxExtent; baseExtentFile = f.replace(".glb", ""); }
}

let anyFail = false;
// An empty baseline is not a zero limit. The envelope, the triangle budget and the extent cap are all
// measured from the shipped library, so when every `.glb` in the directory was passed as a candidate
// the comparison has no source — and the run that did exactly that printed `limit=0.00`,
// `tris_limit=0` and FAIL for all 36 shipped assets (measured 2026-09-26 with
// `node tools/cc0-conform.mjs public/assets/*.glb`). A verdict with no denominator is not a verdict.
if (!shipped.length) {
  console.log(`BASELINE_EMPTY dir=${dir} shipped_library_n=0 candidates=${argv.length}` +
    ' — pass only the new assets; the limits are measured from what is already shipped');
  process.exit(2);
}
const lines = [];
for (const f of argv) {
  const r = analyze(f, candFiles);
  const checks = [];

  // R1 — scale/extent (no documented cap; measured envelope of shipped library)
  const r1 = r.maxExtent <= baseExtent ? 'PASS' : 'FAIL';
  checks.push(`R1_SCALE=${r1} measured_max_extent_m=${r.maxExtent.toFixed(2)} limit=${baseExtent.toFixed(2)} (largest shipped: ${baseExtentFile}; NOTE: no 3.5x cap exists in repo, only Kenney multiplier src/world/props.js:21,740; convention 1u=1m tools/gltf_to_glb.mjs:12)`);

  // R2 — triangles / vertices vs largest shipped asset (measured limit)
  const r2 = (r.tris <= baseTris && r.vertsUnique <= baseVerts) ? 'PASS' : 'FAIL';
  checks.push(`R2_BUDGET=${r2} measured_tris=${r.tris} tris_limit=${baseTris} (${baseTrisFile}) measured_verts=${r.vertsUnique} verts_limit=${baseVerts} (${baseVertsFile}) shipped_range_tris=${minTris}..${baseTris} src=measured (no written budget in repo; shadow_budget.js budgets caster area not triangles)`);

  // R3 — emissive materials must be named to the props.js whitelist
  const rogueEmissive = r.emissiveNames.filter(n => !WHITELIST_EMISSIVE.some(rx => rx.test(n)));
  const r3 = rogueEmissive.length === 0 ? 'PASS' : 'FAIL';
  checks.push(`R3_EMISSIVE=${r3} measured_emissive_mats=${r.emissiveNames.join(',') || '(none)'} rogue=${rogueEmissive.join(',') || '(none)'} whitelist=^light_|pad_glow|plant|crystal_mat src=src/world/props.js:146,147,172`);

  // R3b — palette exposure, INFORMATIONAL. The repo enforces no palette rule: many
  // shipped heroes carry authored names no pass re-tints (bar_cast, tap_soot,
  // crew_frame ...), and the "photo-real PBR vs toy-soft palette" concern is prose
  // in staging/cc0/INTAKE.md:42,80 — an art decision, not a validator. We only
  // report how many material names receive zero repo-side handling.
  const unknown = r.names.filter(n => !PALETTE_NAMES.has(n) && !PALETTE_PATTERNS.some(rx => rx.test(n)));
  checks.push(`R3B_PALETTE=INFO measured_mats=${r.names.join(',') || '(unnamed)'} unhooked_names=${unknown.join(',') || '(none)'} src=assets.js:14-18,68-86 + props.js:140-181,214-233 list name-keyed passes; no repo rule requires a name to appear there (INTAKE.md:42,80 flags style mismatch as authoring work)`);

  // R4 — collision: derived from footprint lot; flag the lamp-case geometry
  const fullW = r.size[0], fullD = r.size[2];
  const wideAir = r.footOk && (fullW - r.foot[0] > 1.0 || fullD - r.foot[2] > 1.0);
  const r4 = wideAir ? 'NEEDS-FOOT-EXCEPTION' : 'PASS';
  checks.push(`R4_COLLISION=${r4} derived=yes via putSolid->footOf->lot->coverDiscs src=src/world/props.js:742-752,717-728,651-658 measured_footprint_wxd_m=${fullW.toFixed(2)}x${fullD.toFixed(2)} foot_below_0.25m=${r.footOk ? r.foot[0].toFixed(2) + 'x' + r.foot[2].toFixed(2) : '(none)'} (lamp precedent src/world/props.js:754-760; no hand disc list required)`);

  if (r1 === 'FAIL' || r2 === 'FAIL' || r3 === 'FAIL') anyFail = true;
  lines.push(`FILE=${f}|bytes=${r.bytes}|meshPrims=${r.prims}|tris=${r.tris}|verts=${r.verts}|vertsUnique=${r.vertsUnique}|bbox_m=${r.size.map(x => x.toFixed(2)).join('x')}|` + checks.join('|'));
}
for (const l of lines) console.log(l);
console.log(`BASELINE shipped_library_n=${shipped.length} max_tris=${baseTris}(${baseTrisFile}) max_verts=${baseVerts}(${baseVertsFile}) max_extent_m=${baseExtent.toFixed(2)}(${baseExtentFile})`);
console.log(anyFail ? 'RESULT=FAIL' : 'RESULT=PASS');
process.exit(anyFail ? 1 : 0);
