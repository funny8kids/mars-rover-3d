#!/usr/bin/env node
// ─── phantom-census: every collider disc measured against the geometry it claims to hide ───
//
// Why this is a node script and not another page run. `tools/disc-audit-probe.js` is an in-page IIFE
// (its line 52 is `const R = window.__RSB`), so its per-disc table can only ever be as wide as a
// JSON blob a GPU session prints. The three questions task #90 still owes answers are all
// *build-time* facts — the disc, the rectangle it was tiled from, the triangles standing under it —
// and `tools/offline-world.mjs` now proves the shipped emitters reproduce the live collider set
// under plain node. So this file runs the same predicates the probe runs, over the world the repo
// actually builds, and writes a row per disc to tools/logs/.
//
// WHAT IS COPIED AND WHAT IS IMPORTED, because a ruler that re-types a threshold is a second
// opinion instead of the shipped one:
//   imported  RIDE / BODY_R / ROOF        (src/vehicle/physics.js)
//             BAND_NY / BAND_STEP          (src/world/plan.js:279-280)
//             surfaceAt / heightAt         (src/world/height.js)
//             START / ISLAND               (src/config.js)
//             the disc set, the lots, the scene graph (src/world/props.js + terrain.js, verbatim)
//   copied, and named here so a reviewer can diff them against the probe line by line:
//             the raster constants (G/X0/RB/FX0/TOL/ISLAND_R), `nearSolid`, `onVeil`, `outlineOf`,
//             `outsideRect`, `judge`, the exposure arithmetic `reachAt/pastAt`, the 0.5 m
//             keep-out flood, and the (cell, heading) configuration-space BFS. The last two exist in
//             the page (disc-audit-probe.js:146-200) and in src/main.js:4746-5153; this file
//             implements BOTH and diffs them, which is question 2.
//
// Usage:
//   node tools/phantom-census.mjs                 # full run: writes the TSV + JSON, prints the tables
//   node tools/phantom-census.mjs --quick         # skip the nearest-face search (the slow pass)
//   node tools/phantom-census.mjs --selfcheck     # stop after the census diff against the live page
// Exit codes (the reader's way to tell a green run from a dead one):
//   0 green · 1 crash · 2 a positive control failed to go red (the ruler is blind)
//   3 the offline world disagrees with the live census (the denominator is a different island)
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { buildOfflineWorld, ROOT } from './offline-world.mjs';
import { RIDE, BODY_R, ROOF } from '../src/vehicle/physics.js';
import { BAND_NY, BAND_STEP, coverDiscs } from '../src/world/plan.js';
import { surfaceAt, heightAt } from '../src/world/height.js';
import { START, ISLAND as ISLANDCFG } from '../src/config.js';

const RC = { OK: 0, CRASH: 1, CONTROL_BLIND: 2, CENSUS_MISMATCH: 3 };
const t0 = performance.now();
const say = (...a) => console.log(...a);
const sec = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

// ─── the probe's own raster constants, kept in one block so they can be diffed against it ───
const ISLAND_R = 112;        // disc-audit-probe.js:80 — rim_veil's face radius, the ring discs share
const TOL = 0.6;             // disc-audit-probe.js:81 — 1.5 grid cells
const G = 0.25, X0 = -135, N = Math.ceil(270 / G);            // probe:103
const RB = 0.5, FX0 = -135, FN = Math.ceil(270 / RB);         // probe:147
const S = 48;                                                // probe:386 rim samples per disc

const out = {
  meta: { started: new Date().toISOString(), anchors: { RIDE, BODY_R, ROOF, BAND_NY, BAND_STEP,
    ISLAND_R, TOL, islandConfig: ISLANDCFG, start: START.pos },
    files: {} },
  counters: {},
};

// ═══ 1. the world ═══
let world;
try {
  world = await buildOfflineWorld({ sky: true });
} catch (e) {
  say('CRASH — offline world: ' + e.stack); process.exit(RC.CRASH);
}
const scene = world.scene;
const colliders = world.colliders;
const lots = world.lots;
scene.updateMatrixWorld(true);
const discs = colliders.filter(c => c.floor === undefined);
const floors = colliders.filter(c => c.floor !== undefined);

// ─── the shipped probe's own last run, quoted rather than re-estimated ───
// tools/logs/disc-audit-2026-09-27-live.txt holds the in-page RESULT blob. Anything printed
// as "the live page says X" is read out of here at runtime, so a stale quote fails loudly instead of
// quietly drifting.
// This artifact replaces disc-audit-2026-09-27-after-pipes.txt, which was recorded by a harness run
// that had no permission to quote the page: the probe walked a scene whose weather had never been
// built, so its numbers described a half-assembled world. The live gate in tools/cdp-run.mjs now
// presses #start-btn before evaluating, which is what makes `applyQuality()` (main.js:2799 → :339)
// run and `stormField` exist. The two sides now match on everything this file compares
// (discs 693, bandFaces 89070 vs the node build's own count, instancing 88/3600 both sides), and the
// census's line-internal ±1 solid puzzle closed with it.
const liveRunFile = path.join(ROOT, 'tools/logs/disc-audit-2026-09-27-live.txt');
let live = null, liveInstancing = {};
if (fs.existsSync(liveRunFile)) {
  const raw = fs.readFileSync(liveRunFile, 'utf8');
  const i = raw.indexOf('RESULT "');
  if (i >= 0) {
    try { live = JSON.parse(JSON.parse(raw.slice(i + 7).split('\n')[0])); } catch { live = null; }
  }
  liveInstancing = live?.instancing ?? {};
}
out.liveRun = liveRunFile && live ? {
  file: path.relative(ROOT, liveRunFile), discs: live.discs, bandFaces: live.bandFaces,
  offIslandFaces: live.offIslandFaces, domeMeshes: live.domeMeshes, instancing: live.instancing,
  exposedFaces: live.exposedFaces, phantomCount: live.phantomCount, overWideCount: live.overWideCount,
  blanketCount: live.blanketCount, mergedCount: live.mergedCount, hollowCount: live.hollowCount,
  discSide: live.discSide, reachability: live.reachability, controls: live.controls,
} : null;
say(`[${sec()}] shipped probe quoted from ${out.liveRun ? path.relative(ROOT, liveRunFile) : 'ABSENT — live readings cannot be quoted this run'}` +
    (out.liveRun ? `: bandFaces ${live.bandFaces} discs ${live.discs} phantom ${live.phantomCount} overWide ${live.overWideCount}` +
      ` blanket ${live.blanketCount} merged ${live.mergedCount} hollow ${live.hollowCount} exposed ${live.exposedFaces}` +
      ` · instancing swept ${liveInstancing.sweptInstances}/${liveInstancing.seenInstances} in ${liveInstancing.seenMeshes} InstancedMeshes` : ''));

// ─── the census diff against the live page, run first so nothing below is quoted unproven ───
// The reference is the live reading `tools/logs/probe-census.js` took of THIS build, re-recorded
// whenever src/world changes (`--census <file>` points it somewhere else). The stale one it used to
// carry — tools/logs/census-work.txt, 695 rows from 2026-09-26 — is the reason this script's first run
// reported the hub barrels as live-only: those two needles became `hub:barrel-east` in #94, a change
// the shipped world has had for a day and the reference had not.
const argv = process.argv;
const cAt = argv.indexOf('--census');
const censusFile = path.resolve(cAt > 0 ? argv[cAt + 1] : 'tools/logs/census-2026-09-27-refactor.txt');
function liveCensus() {
  const raw = fs.readFileSync(censusFile, 'utf8');
  const i = raw.indexOf('RESULT "');
  const payload = JSON.parse(JSON.parse(raw.slice(i + 7).split('\n')[0]));
  const m = new Map();
  for (const line of payload.census) {
    // live rows are `id x z r kind`. The fifth field is KEPT in the key: the probe classifies a
    // collider by `c.floor === undefined ? 'solid' : 'floor'` (probe-census.js:6), so re-deriving it
    // offline is only honest if the two sides also agree on the classification. Dropping the floored
    // boxes from this side, as the first version did, made the 9 m `watch:deck` drum read live-only —
    // the diff was measuring the script, not the island.
    const [id, x, z, r, kind] = line.split(/\s+/);
    m.set(`${id}|${x}|${z}|${r}|${kind}`, (m.get(`${id}|${x}|${z}|${r}|${kind}`) || 0) + 1);
  }
  return { m, rows: payload.census.length, total: payload.total ?? null, payload };
}
const kindOf = c => (c.floor === undefined ? 'solid' : 'floor');
let censusDiff = null;
if (fs.existsSync(censusFile)) {
  const { m: live, rows } = liveCensus();
  const mine = new Map();
  for (const c of colliders) {
    const k = `${c.prop || '?'}|${(+c.x).toFixed(3)}|${(+c.z).toFixed(3)}|${(+c.r).toFixed(3)}|${kindOf(c)}`;
    mine.set(k, (mine.get(k) || 0) + 1);
  }
  const onlyLive = [], onlyMine = [];
  for (const [k, n] of live) { const m = mine.get(k) || 0; if (m < n) onlyLive.push(`${k} ×${n - m}`); }
  for (const [k, n] of mine) { const m = live.get(k) || 0; if (m < n) onlyMine.push(`${k} ×${n - m}`); }
  const sum = m => [...m.values()].reduce((a, b) => a + b, 0);
  censusDiff = { file: path.relative(ROOT, censusFile), liveRows: rows, liveKeys: live.size,
    offlineColliders: colliders.length, offlineDiscs: discs.length, offlineFloors: floors.length,
    mineKeys: mine.size, onlyLive: onlyLive.length, onlyMine: onlyMine.length,
    onlyLiveSample: onlyLive.slice(0, 40), onlyMineSample: onlyMine.slice(0, 40) };
  out.censusVsLive = censusDiff;
}
if (argv.includes('--selfcheck')) {
  if (!censusDiff) { say(`NO REFERENCE — ${censusFile} is absent, so the census cannot be proven`); process.exit(RC.CENSUS_MISMATCH); }
  say(JSON.stringify(censusDiff, null, 1));
  process.exit(censusDiff.onlyLive === 0 && censusDiff.onlyMine === 0 ? RC.OK : RC.CENSUS_MISMATCH);
}
say(`[${sec()}] world: ${discs.length} solid discs + ${floors.length} driveable floor discs, ${lots.length} lots` +
    (censusDiff ? ` · live census ${censusDiff.liveRows} rows, ${censusDiff.onlyLive} live-only keys, ${censusDiff.onlyMine} offline-only` : ''));

// ═══ 2. the geometry sweep — band faces, with EVERY skip counted ═══
// Skips are counted at two levels on purpose (question 3): what the whole-mesh bounding-box filter
// threw away, and what the per-face filters throw away. The shipped probe returns early on the mesh
// box (disc-audit-probe.js:247-250, tools/float-audit-probe.js:119-123); here the early return is
// replaced by a label, so the same pass prints both the shipped number and the per-face number.
const EXCLUDE_ROOTS = {          // probe:91-94, same two roots, same reasons
  terrain: 'the surface being driven on; a slope is not a wall',
  'rim-veil': 'the island edge itself, drawn as travelling dust at the collider ring radius',
};
const rootOf = o => { let p = o; while (p.parent && p.parent !== scene) p = p.parent; return p; };
const rootKey = new Map();
{ let i = 0; for (const ch of scene.children) rootKey.set(ch, `${ch.name || ch.type}#${i++}`); }

const covered = new Uint8Array(N * N), solid = new Uint8Array(N * N);
const gi = x => Math.floor((x - X0) / G);

const cov = new Map();           // root key → what the sweep did with it
const recOf = o => {
  const k = rootKey.get(rootOf(o)) || (rootOf(o).name || rootOf(o).type);
  let r = cov.get(k);
  if (!r) cov.set(k, r = { faces: 0, strays: 0, maxAbove: 0, skippedBy: null, why: null,
    meshes: 0, bboxRejectedMeshes: 0, bboxRejectedBandFaces: 0, bboxRejectedOnIslandFaces: 0,
    tris: 0, trisWalked: 0 });
  r.meshes++;
  return r;
};
const CNT = {
  meshesSeen: 0, meshesWithNoPosition: 0, meshesExcludedByRoot: 0, meshesTransparent: 0,
  meshesBboxRejected: 0, facesOfBboxRejectedMeshes: 0,
  bandFacesOfBboxRejectedMeshes: 0, onIslandBandFacesOfBboxRejectedMeshes: 0,
  instancedMeshes: 0, instancesSeen: 0, instancesSwept: 0, instancesTruncated: 0,
  trisWalked: 0, offIslandFaces: 0, flatFaces: 0, thinFaces: 0, outsideBand: 0, bandFaces: 0,
  nanFaces: 0, skippedHidden: 0, bboxRejectedFacesOnIsland: 0,
};
out.discs = discs.length;

const faces = { x: [], y: [], z: [], lo: [], hi: [], mesh: [], root: [], lod: [] };
const fg = new Map();            // 4 m cell → face indices, for the nearest-drawn-triangle search
const FGC = 4;
const putFace = (mx, my, mz, lo, hi, meshName, rootName, lod) => {
  const i = faces.x.length;
  faces.x.push(mx); faces.y.push(my); faces.z.push(mz); faces.lo.push(lo); faces.hi.push(hi);
  faces.mesh.push(meshName); faces.root.push(rootName); faces.lod.push(lod || null);
  const k = `${Math.floor(mx / FGC)},${Math.floor(mz / FGC)}`;
  const a = fg.get(k); if (a) a.push(i); else fg.set(k, [i]);
  return i;
};

const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nn = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
// The ground the band gate and the exposure arm judge against is cached per 1 m cell, keyed by
// `Math.round(x),Math.round(z)`: the first face sampled in a cell answers for every later one, from a
// point up to 0.71 m away. On a dune flank that is centimetres of height, which is the size of the
// `poke` values the exposure arm reports, and it makes the answer depend on the order the scene was
// walked in — a live page with the rover and its FX in the graph fills the cells in a different order
// from this headless build. So the cache keeps the point it sampled and every hit records how far the
// query was from it: the ruler's own error bar, measured during the sweep rather than argued about
// afterwards. `slopeAt` below turns a planar drift into the height it is worth.
const gcache = new Map();
const GC = { calls: 0, hits: 0, maxDrift: 0, bandMaxDrift: 0, bandDriftSum: 0, bandDriftN: 0 };
let lastGroundDrift = 0;
const groundAt = (x, z) => {
  GC.calls++;
  const k = `${Math.round(x)},${Math.round(z)}`;
  let e = gcache.get(k);
  if (e === undefined) { e = { g: surfaceAt(x, z), x, z }; gcache.set(k, e); lastGroundDrift = 0; }
  else {
    GC.hits++;
    lastGroundDrift = Math.hypot(x - e.x, z - e.z);
    if (lastGroundDrift > GC.maxDrift) GC.maxDrift = lastGroundDrift;
  }
  return e.g;
};
// Steepest descent of the analytic surface at a point, by central difference over 0.5 m — the same
// scale as the cache cell, so `drift × slope` is the height that drift can hide.
const slopeAt = (x, z) => {
  const d = 0.25;
  return Math.hypot((surfaceAt(x + d, z) - surfaceAt(x - d, z)) / (2 * d),
    (surfaceAt(x, z + d) - surfaceAt(x, z - d)) / (2 * d));
};

const bboxTest = o => {
  const w = new THREE.Box3().setFromObject(o);
  return { w, rejected: !w.isEmpty() &&
    (w.max.x - w.min.x > 2 * ISLAND_R || w.max.z - w.min.z > 2 * ISLAND_R) };
};

say(`[${sec()}] sweeping the drawn geometry…`);
scene.traverse(o => {
  if (!o.isMesh) return;
  CNT.meshesSeen++;
  const g = o.geometry, pos = g.attributes?.position;
  if (!pos) { CNT.meshesWithNoPosition++; return; }
  if (!o.visible) { CNT.skippedHidden++; return; }
  if (o.isInstancedMesh) { CNT.instancedMeshes++; CNT.instancesSeen += o.count; }
  const root = rootOf(o);
  const rec = recOf(o);
  const ex = EXCLUDE_ROOTS[root.name];
  if (ex) { CNT.meshesExcludedByRoot++; rec.skippedBy = 'root'; rec.why = ex; return; }
  const m = o.material;
  if (m && (Array.isArray(m) ? m.some(x => x?.transparent) : m.transparent)) {
    CNT.meshesTransparent++; rec.skippedBy = rec.skippedBy || 'transparent'; return;
  }
  const { w, rejected } = bboxTest(o);
  if (rejected) { CNT.meshesBboxRejected++; rec.bboxRejectedMeshes = 1; }
  const idx = g.index, tri = idx ? idx.count : pos.count;
  if (tri < 3) return;

  const mats = [];
  // Which LOD level this mesh is, and where its tile sits. The headless build has no camera, so
  // tools/offline-world.mjs resolves every THREE.LOD to its near level — meaning the sweep walks
  // triangles the shipped page may never have drawn, since `LOD.update(camera)` picks per tile by
  // distance. Recording the level and the tile centre lets the exposure arm ask, for each face it
  // flags, whether the page's own camera point draws that level — turning "the page says 0" from a
  // disagreement into a coverage reading with a number on it.
  const lodP = o.parent?.isLOD ? o.parent : null;
  const lodTag = lodP ? {
    level: lodP.levels.findIndex(l => l.object === o),
    at: [+lodP.position.x.toFixed(1), +lodP.position.y.toFixed(1), +lodP.position.z.toFixed(1)],
    switchAt: lodP.levels.map(l => l.distance),
  } : null;
  if (o.isInstancedMesh) {
    const mm = new THREE.Matrix4();
    for (let q = 0; q < o.count; q++) { o.getMatrixAt(q, mm); mats.push(mm.clone()); }
    CNT.instancesSwept += o.count;
  } else mats.push(new THREE.Matrix4());

  for (const im of mats) {
    const wm = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, im);
    for (let t = 0; t + 2 < tri; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      va.fromBufferAttribute(pos, i0).applyMatrix4(wm);
      vb.fromBufferAttribute(pos, i1).applyMatrix4(wm);
      vc.fromBufferAttribute(pos, i2).applyMatrix4(wm);
      CNT.trisWalked++;
      if (rejected) CNT.facesOfBboxRejectedMeshes++;
      const mx = (va.x + vb.x + vc.x) / 3, mz = (va.z + vb.z + vc.z) / 3;
      if (!Number.isFinite(mx) || !Number.isFinite(mz) || !Number.isFinite(va.y)) { CNT.nanFaces++; continue; }
      const onIsland = Math.hypot(mx, mz) <= ISLAND_R + 4;
      if (!onIsland) { CNT.offIslandFaces++; continue; }
      ab.subVectors(vb, va); ac.subVectors(vc, va); nn.crossVectors(ab, ac).normalize();
      if (Math.abs(nn.y) > 0.7) { CNT.flatFaces++; continue; }
      const lo = Math.min(va.y, vb.y, vc.y), hi = Math.max(va.y, vb.y, vc.y);
      if (hi - lo < BAND_STEP) { CNT.thinFaces++; continue; }
      const gy = groundAt(mx, mz);
      if (lo > gy + ROOF || hi < gy + RIDE) { CNT.outsideBand++; continue; }
      CNT.bandFaces++;
      GC.bandDriftN++; GC.bandDriftSum += lastGroundDrift;
      if (lastGroundDrift > GC.bandMaxDrift) GC.bandMaxDrift = lastGroundDrift;
      rec.faces++;
      if (hi - gy > rec.maxAbove) rec.maxAbove = hi - gy;
      if (rejected) {
        CNT.bandFacesOfBboxRejectedMeshes++;
        CNT.bboxRejectedFacesOnIsland++;
        rec.bboxRejectedBandFaces++;
      }
      const ai = gi(mx), bi = gi(mz);
      if (ai >= 0 && bi >= 0 && ai < N && bi < N) solid[ai * N + bi] = 1;
      putFace(mx, (lo + hi) / 2, mz, lo, hi, o.name || o.type, root.name || root.type, lodTag);
    }
  }
});
// Which faces the bbox filter is *only* correct for: the same mesh pass with the mesh-level early
// return restored, so the shipped reading and the per-face reading come out of one sweep.
CNT.bandFacesShippedMeshFilter = CNT.bandFaces - CNT.bandFacesOfBboxRejectedMeshes;
out.counters = CNT;
out.sweep = { perRoot: [...cov.entries()].map(([k, r]) => ({ root: k, ...r }))
  .sort((a, b) => b.faces - a.faces).slice(0, 24) };
say(`[${sec()}] faces: band ${CNT.bandFaces} (shipped mesh-bbox filter would print ${CNT.bandFacesShippedMeshFilter}),` +
    ` bbox-rejected meshes ${CNT.meshesBboxRejected} holding ${CNT.facesOfBboxRejectedMeshes} walked faces,` +
    ` of which ${CNT.bandFacesOfBboxRejectedMeshes} sit on the island inside the hull band`);

// ═══ 3. the disc side: covered raster, licensing, judge (the probe's, mirrored) ═══
for (const c of discs) {
  const i0 = Math.max(0, gi(c.x - c.r)), i1 = Math.min(N - 1, gi(c.x + c.r));
  const j0 = Math.max(0, gi(c.z - c.r)), j1 = Math.min(N - 1, gi(c.z + c.r));
  for (let i = i0; i <= i1; i++) {
    const x = X0 + (i + 0.5) * G;
    for (let j = j0; j <= j1; j++) {
      const z = X0 + (j + 0.5) * G;
      if ((x - c.x) ** 2 + (z - c.z) ** 2 <= c.r * c.r) covered[i * N + j] = 1;
    }
  }
}
// Band faces that stand outside every disc, counted per root: this is the probe's `strays`
// (disc-audit-probe.js:288 `!covered[ai*N+bi]`), and the live run's `Group#2 strays: 2053` is the
// figure it is meant to be compared with.
let strayBandFaces = 0;
const strayByRoot = new Map();
for (let i = 0; i < faces.x.length; i++) {
  const ai = gi(faces.x[i]), bi = gi(faces.z[i]);
  if (ai >= 0 && bi >= 0 && ai < N && bi < N && covered[ai * N + bi]) continue;
  strayBandFaces++;
  strayByRoot.set(faces.root[i], (strayByRoot.get(faces.root[i]) || 0) + 1);
}
out.strays = { bandFaces: strayBandFaces, byRoot: [...strayByRoot.entries()]
  .sort((a, b) => b[1] - a[1]).slice(0, 12) };

const reachAt = (x, z) => {
  let reach = Infinity, near = null;
  for (const d of discs) {
    const dd = Math.hypot(x - d.x, z - d.z) - d.r;
    if (dd < reach) { reach = dd; near = d; }
  }
  return { reach, near };
};
const pastAt = (x, z) => reachAt(x, z).reach - BODY_R;
const outlineOf = d => {
  if (!d.lot || !d.share) return null;
  return { cx: d.lot.cx, cz: d.lot.cz, hw: d.lot.hw, hd: d.lot.hd,
           cos: Math.cos(d.lot.ry), sin: Math.sin(d.lot.ry),
           entitled: d.r - Math.min(d.share.hw, d.share.hd) };
};
const outsideRect = (o, x, z) => {
  // verbatim disc-audit-probe.js:368-373 — signed distance to the rotated lot rectangle, negative
  // inside; the world→lot basis is the inverse of props.js `lot()`'s placement maths.
  const dx = x - o.cx, dz = z - o.cz;
  const ox = Math.abs(dx * o.cos - dz * o.sin) - o.hw;
  const oz = Math.abs(dx * o.sin + dz * o.cos) - o.hd;
  return Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0);
};
const onVeil = (x, z) => Math.hypot(x, z) > ISLAND_R - 2.5;
const nearSolid = (x, z, tol = TOL) => {
  const i = gi(x), j = gi(z), k = Math.ceil(tol / G);
  for (let di = -k; di <= k; di++) for (let dj = -k; dj <= k; dj++) {
    const p = i + di, q = j + dj;
    if (p >= 0 && q >= 0 && p < N && q < N && solid[p * N + q]) return true;
  }
  return false;
};
// nearest drawn band face, XZ metres, with the 3-D distance and the face's own name
const nearestFace = (x, z, capRings = 10) => {
  const ci = Math.floor(x / FGC), cj = Math.floor(z / FGC);
  for (let ring = 0; ring <= capRings; ring++) {
    let best = null;
    for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) {
      if (ring && Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
      const a = fg.get(`${ci + di},${cj + dj}`);
      if (!a) continue;
      for (const i of a) {
        const d2 = (faces.x[i] - x) ** 2 + (faces.z[i] - z) ** 2;
        if (!best || d2 < best.d2) best = { d2, i };
      }
    }
    if (best) return { metres: Math.sqrt(best.d2), i: best.i,
      mesh: faces.mesh[best.i], root: faces.root[best.i],
      at: [+faces.x[best.i].toFixed(1), +faces.z[best.i].toFixed(1)] };
  }
  return { metres: null, i: -1, mesh: null, root: null, at: null };
};

const judge = (d0, wantNear = false) => {
  const o = outlineOf(d0);
  let bare = 0, unlicensed = 0, licensed = 0, rim = 0, maxPast = -Infinity, worstAt = null;
  const near = { metres: Infinity, mesh: null, at: null };
  for (let i = 0; i < S; i++) {
    const th = i / S * Math.PI * 2;
    const px = d0.x + Math.cos(th) * d0.r, pz = d0.z + Math.sin(th) * d0.r;
    if (onVeil(px, pz)) { rim++; continue; }
    if (nearSolid(px, pz)) { if (wantNear && near.metres > 0) { const q = nearestFace(px, pz, 3);
      if (q.metres !== null && q.metres < near.metres) Object.assign(near, q); } continue; }
    bare++;
    if (!o) continue;
    const past = outsideRect(o, px, pz) - o.entitled;
    if (past > maxPast) { maxPast = past; worstAt = [+px.toFixed(2), +pz.toFixed(2)]; }
    if (past > TOL) unlicensed++; else licensed++;
  }
  let anyNear = onVeil(d0.x, d0.z);
  for (let i = 0; i < 16 && !anyNear; i++) {
    const th = i / 16 * Math.PI * 2;
    for (const rr of [0, d0.r * 0.5, d0.r]) {
      const px = d0.x + Math.cos(th) * rr, pz = d0.z + Math.sin(th) * rr;
      if (onVeil(px, pz) || nearSolid(px, pz)) { anyNear = true; break; }
    }
  }
  const frac = bare / S;
  let centreBare = false, pocket = 0;
  if (d0.emitted) {
    centreBare = !(onVeil(d0.x, d0.z) || nearSolid(d0.x, d0.z));
    if (d0.r > BODY_R) {
      for (let a = -d0.r; a <= d0.r; a += 0.4) for (let b = -d0.r; b <= d0.r; b += 0.4) {
        if (a * a + b * b > d0.r * d0.r) continue;
        const x = d0.x + a, z = d0.z + b;
        if (onVeil(x, z) || nearSolid(x, z, BODY_R)) continue;
        pocket++;
      }
    }
  }
  const kind = !frac ? 'ok' : !anyNear ? 'phantom'
    : d0.emitted && frac > 0.25 ? 'blanket'
    : o && unlicensed / S > 0.25 ? 'overWide' : 'ok';
  // the two overshoot rulers task #90 asks for, both measured against the derived rectangle:
  //  · against the LOT outline (`lot` = the footprint the prop was placed on): r − min(w,d)/2
  //  · against the tiling SHARE (what coverDiscs is obliged to produce): r − min(share.hw, share.hd)
  const lotMin = d0.lot ? Math.min(d0.lot.hw, d0.lot.hd) : null;
  return { bare: frac, bareN: bare, unlicensed, licensed, rim, maxPast: maxPast === -Infinity ? null : maxPast,
    worstAt, anyNear, centreBare, pocket, kind, out: o,
    overshootLot: lotMin === null ? null : +(d0.r - lotMin).toFixed(3),
    entitled: o ? +o.entitled.toFixed(3) : null, near: wantNear ? near : null,
    lotW: d0.lot ? +(2 * d0.lot.hw).toFixed(2) : null, lotD: d0.lot ? +(2 * d0.lot.hd).toFixed(2) : null };
};

say(`[${sec()}] judging ${discs.length} discs…`);
const rows = [];
const byFamily = {};
const DC = { onIsland: 0, skippedOffIsland: 0, rectless: 0, bareAny: 0, bareLicensedOnly: 0,
  bareUnlicensed: 0, phantom: 0, overWide: 0, blanket: 0, merged: 0, hollow: 0, rimSamples: 0,
  licensedBulgeSamples: 0, emitted: 0, withLot: 0, withShare: 0, withBoth: 0 };
for (const d0 of discs) {
  if (d0.emitted) DC.emitted++;
  if (d0.lot) DC.withLot++;
  if (d0.share) DC.withShare++;
  if (d0.lot && d0.share) DC.withBoth++;
  if (Math.hypot(d0.x, d0.z) > ISLAND_R + 4) { DC.skippedOffIsland++; continue; }
  DC.onIsland++;
  const j = judge(d0);
  if (!j.out) DC.rectless++;
  DC.rimSamples += S; DC.licensedBulgeSamples += j.licensed;
  if (j.bareN) {
    DC.bareAny++;
    if (!j.unlicensed) DC.bareLicensedOnly++; else DC.bareUnlicensed++;
  }
  if (j.kind !== 'ok') DC[j.kind]++;
  const fam = (d0.prop || '').replace(/#\d+$/, '');
  byFamily[fam] = byFamily[fam] || { discs: 0, bareAny: 0, bareLicensedOnly: 0, bareUnlicensed: 0,
    phantom: 0, overWide: 0, blanket: 0, maxOvershootLot: -Infinity, maxOvershootAt: null,
    maxPast: -Infinity, nearestFaceMax: -Infinity };
  const b = byFamily[fam];
  b.discs++;
  if (j.bareN) { b.bareAny++; j.unlicensed ? b.bareUnlicensed++ : b.bareLicensedOnly++; }
  if (j.kind !== 'ok') b[j.kind]++;
  if (j.overshootLot !== null && j.overshootLot > b.maxOvershootLot) {
    b.maxOvershootLot = j.overshootLot; b.maxOvershootAt = [+d0.x.toFixed(2), +d0.z.toFixed(2), +d0.r.toFixed(2)];
  }
  if (j.maxPast !== null && j.maxPast > b.maxPast) b.maxPast = +j.maxPast.toFixed(3);
  rows.push({ d: d0, j });
}
out.discSide = DC;

// ═══ 4. the ~60: discs whose bare rim is NOT covered by the tiling licence, with nearest geometry ═══
const needNear = !process.argv.includes('--quick');
say(`[${sec()}] nearest-drawn-triangle pass over ${rows.filter(r => r.j.bareN && r.j.unlicensed).length} unlicensed discs${needNear ? '' : ' (skipped: --quick)'}…`);
const unlicensed = rows.filter(r => r.j.bareN && r.j.unlicensed);
const rockRows = [];
for (const r of unlicensed) {
  if (!needNear) break;
  // nearest face at the disc centre, and the worst bare rim point's nearest face
  const c = nearestFace(r.d.x, r.d.z, 12);
  let worst = null;
  for (let i = 0; i < S; i++) {
    const th = i / S * Math.PI * 2;
    const px = r.d.x + Math.cos(th) * r.d.r, pz = r.d.z + Math.sin(th) * r.d.r;
    if (onVeil(px, pz) || nearSolid(px, pz)) continue;
    const q = nearestFace(px, pz, 12);
    if (q.metres !== null && (!worst || q.metres > worst.metres)) worst = { ...q, at: [+px.toFixed(2), +pz.toFixed(2)] };
  }
  r.nearCentre = c; r.worstBareRim = worst;
  if ((r.d.prop || '').startsWith('scatter:rock')) rockRows.push(r);
}
// every scatter:rock disc, licensed or not, gets a row: the ask is the split of that family
const rockAll = rows.filter(r => (r.d.prop || '').startsWith('scatter:rock'));
for (const r of rockAll) {
  if (!needNear || r.nearCentre) continue;
  const c = nearestFace(r.d.x, r.d.z, 12);
  let worst = null;
  for (let i = 0; i < S; i++) {
    const th = i / S * Math.PI * 2;
    const px = r.d.x + Math.cos(th) * r.d.r, pz = r.d.z + Math.sin(th) * r.d.r;
    if (onVeil(px, pz) || nearSolid(px, pz)) continue;
    const q = nearestFace(px, pz, 12);
    if (q.metres !== null && (!worst || q.metres > worst.metres)) worst = { ...q, at: [+px.toFixed(2), +pz.toFixed(2)] };
  }
  r.nearCentre = c; r.worstBareRim = worst;
}

// ═══ 5. reachability: the probe's flood, the shipped 0.5 m census, the shipped config-space BFS ═══
say(`[${sec()}] flooding reachability three ways…`);
// (a) the probe's flood — disc-audit-probe.js:147-180, ±135 m at 0.5 m, 4-connected, r + BODY_R
const fgi = x => Math.floor((x - FX0) / RB);
const fBlocked = new Uint8Array(FN * FN), reached = new Uint8Array(FN * FN);
for (const c of discs) {
  const rr = c.r + BODY_R;
  const i0 = Math.max(0, fgi(c.x - rr)), i1 = Math.min(FN - 1, fgi(c.x + rr));
  const j0 = Math.max(0, fgi(c.z - rr)), j1 = Math.min(FN - 1, fgi(c.z + rr));
  for (let i = i0; i <= i1; i++) {
    const x = FX0 + (i + 0.5) * RB;
    for (let j = j0; j <= j1; j++) {
      const z = FX0 + (j + 0.5) * RB;
      if ((x - c.x) ** 2 + (z - c.z) ** 2 <= rr * rr) fBlocked[i * FN + j] = 1;
    }
  }
}
let probeFree = 0; for (let k = 0; k < fBlocked.length; k++) if (!fBlocked[k]) probeFree++;
const cellIdx = (x, z) => { const i = fgi(x), j = fgi(z);
  return i >= 0 && j >= 0 && i < FN && j < FN ? i * FN + j : -1; };
const startIdx = (() => { const k = cellIdx(START.pos[0], START.pos[1]);
  return k >= 0 && !fBlocked[k] ? k : -1; })();
let probeReached = 0;
{
  const stack = startIdx >= 0 ? [startIdx] : [];
  while (stack.length) {
    const k = stack.pop();
    if (reached[k]) continue;
    reached[k] = 1; probeReached++;
    const i = (k / FN) | 0, j = k % FN;
    if (i > 0 && !fBlocked[k - FN] && !reached[k - FN]) stack.push(k - FN);
    if (i < FN - 1 && !fBlocked[k + FN] && !reached[k + FN]) stack.push(k + FN);
    if (j > 0 && !fBlocked[k - 1] && !reached[k - 1]) stack.push(k - 1);
    if (j < FN - 1 && !fBlocked[k + 1] && !reached[k + 1]) stack.push(k + 1);
  }
}
const reachedWithin = (x, z, rad) => {
  const q = rad + RB, RING = Math.ceil(q / RB), R2 = q * q;
  const i0 = fgi(x), j0 = fgi(z);
  for (let di = -RING; di <= RING; di++) {
    const i = i0 + di; if (i < 0 || i >= FN) continue;
    const dx = FX0 + (i + 0.5) * RB - x;
    for (let dj = -RING; dj <= RING; dj++) {
      const j = j0 + dj; if (j < 0 || j >= FN || !reached[i * FN + j]) continue;
      const dz = FX0 + (j + 0.5) * RB - z;
      if (dx * dx + dz * dz <= R2) return true;
    }
  }
  return false;
};
const hullReached = (x, z) => reachedWithin(x, z, BODY_R);

// (b) the shipped enclosure census — src/main.js:5079-5110, EC 0.5 over the built bbox padded
//     TURN + 6, 4-neighbour, physics' own keep-out (r + CLEAR with CLEAR = BODY_R)
const CLEAR = 1.6, TURN = 2.9 / Math.tan(0.60), CELL = 2, NH = 16, STEP = Math.PI * 2 / NH;
const B = 32, buckets = new Map();
const bkey = (i, j) => i * 4096 + j;
let maxR = 0;
for (const c of discs) {
  maxR = Math.max(maxR, c.r);
  const k = bkey(Math.floor(c.x / B), Math.floor(c.z / B));
  const a = buckets.get(k); if (a) a.push(c); else buckets.set(k, [c]);
}
const scanDiscs = (x, z, range, cb) => {
  const bi = Math.floor(x / B), bj = Math.floor(z / B);
  const reach = Math.ceil((range + Math.max(0, maxR)) / B);
  for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
    const list = buckets.get(bkey(bi + i, bj + j));
    if (list) for (const c of list) cb(c);
  }
};
const clearAt = (x, z) => {
  let best = 99;
  scanDiscs(x, z, CLEAR + TURN, c => {
    const d = Math.hypot(x - c.x, z - c.z) - c.r - CLEAR;
    if (d < best) best = d;
  });
  return best;
};
// the interactive-point proxy: main.js uses interactivePoints(); the shipped set is POIs from the
// districts, teleports, sample sites and info zones. Offline, teleports + samples + sparkPoints
// are the ones that move the grid bounds at all; the difference is a padding of the bbox, so it can
// change a cell at the outer edge and nothing in the middle of the base. Stated, not hidden.
const poisProxy = [
  ...(world.base.teleports || []).map(t => ({ x: t.x, z: t.z, name: `teleport:${t.key}` })),
  ...(world.base.samples || []).map(s => ({ x: s.x, z: s.z, name: `site:${s.id}` })),
  ...(world.base.sparkPoints || []).map(p => ({ x: p.x ?? p[0], z: p.z ?? p[1], name: 'spark' })),
];
let x0 = START.pos[0], x1 = x0, z0 = START.pos[1], z1 = z0;
const grow = (x, z, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); };
for (const c of discs) grow(c.x, c.z, c.r);
for (const p of poisProxy) grow(p.x, p.z, 8);
x0 -= TURN + 6; x1 += TURN + 6; z0 -= TURN + 6; z1 += TURN + 6;
const EC = 0.5;
const EW = Math.ceil((x1 - x0) / EC) + 1, EH = Math.ceil((z1 - z0) / EC) + 1;
const esc = new Float32Array(EW * EH);
for (let i = 0; i < EW; i++) for (let j = 0; j < EH; j++) esc[i * EH + j] = clearAt(x0 + i * EC, z0 + j * EC);
const cid = new Int32Array(EW * EH).fill(-1);
const comps = [];
for (let s = 0; s < esc.length; s++) {
  if (esc[s] < 0 || cid[s] >= 0) continue;
  const id = comps.length, st = [s];
  const rec = { cells: 0, pivot: 0, maxClear: -99, at: [0, 0], edge: false };
  cid[s] = id;
  while (st.length) {
    const c = st.pop(), i = (c / EH) | 0, j = c % EH, px = x0 + i * EC, pz = z0 + j * EC;
    rec.cells++;
    if (esc[c] >= TURN) rec.pivot++;
    if (esc[c] > rec.maxClear) { rec.maxClear = esc[c]; rec.at = [px, pz]; }
    if (i === 0 || j === 0 || i === EW - 1 || j === EH - 1) rec.edge = true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= EW || nj >= EH) continue;
      const n = ni * EH + nj;
      if (esc[n] >= 0 && cid[n] < 0) { cid[n] = id; st.push(n); }
    }
  }
  comps.push(rec);
}
const pockets = comps.filter(r => !r.edge && r.pivot === 0 && r.cells * EC * EC >= 10);

// (c) the shipped configuration-space BFS — main.js:4904-4960: 2 m cells, 16 headings, arc edges
const W = Math.ceil((x1 - x0) / CELL) + 1, H = Math.ceil((z1 - z0) / CELL) + 1;
const GX = i => x0 + i * CELL, GZ = j => z0 + j * CELL;
const slack = new Float32Array(W * H), free = new Uint8Array(W * H);
for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
  const c = clearAt(GX(i), GZ(j));
  slack[i * H + j] = c; free[i * H + j] = c >= 0 ? 1 : 0;
}
const wrapA = v => Math.atan2(Math.sin(v), Math.cos(v));
const OFF = [];
for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (di || dj) OFF.push([di, dj, Math.atan2(di, dj)]);
const EDGES = [];
for (let h = 0; h < NH; h++) {
  const list = [];
  for (let dh = -1; dh <= 1; dh++) {
    const h2 = (h + dh + NH) % NH;
    const chord = (h + dh * 0.5) * STEP;
    for (const [di, dj, b] of OFF) if (Math.abs(wrapA(b - chord)) <= STEP / 2 + 1e-6) list.push([di, dj, h2]);
  }
  EDGES.push(list);
}
const seen = new Uint8Array(W * H * NH), queue = new Int32Array(W * H * NH);
let qh = 0, qt = 0;
const si = Math.round((START.pos[0] - x0) / CELL), sj = Math.round((START.pos[1] - z0) / CELL);
if (free[si * H + sj]) for (let h = 0; h < NH; h++) { const c = (si * H + sj) * NH + h; seen[c] = 1; queue[qt++] = c; }
while (qh < qt) {
  const c = queue[qh++], h = c % NH, cell = (c - h) / NH;
  const i = (cell / H) | 0, j = cell % H;
  for (const [di, dj, h2] of EDGES[h]) {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
    const ncell = ni * H + nj;
    if (!free[ncell]) continue;
    const n = ncell * NH + h2;
    if (!seen[n]) { seen[n] = 1; queue[qt++] = n; }
  }
}
const cfgReached = new Uint8Array(W * H);
for (let c = 0; c < seen.length; c++) if (seen[c]) cfgReached[(c / NH) | 0] = 1;
const nearReach = (x, z) => {
  const ci = Math.round((x - x0) / CELL), cj = Math.round((z - z0) / CELL);
  for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    if (cfgReached[i * H + j]) return true;
  }
  return false;
};
out.reach = {
  probeFlood: { seed: `START@${START.pos[0]},${START.pos[1]}`, seeded: startIdx >= 0,
    grid: [FN, FN], extent: [FX0, FX0 + FN * RB], freeCells: probeFree, reachedCells: probeReached,
    reachFrac: +(probeReached / probeFree).toFixed(3) },
  shippedCensus: { cell: EC, grid: [EW, EH], extent: [+x0.toFixed(1), +x1.toFixed(1), +z0.toFixed(1), +z1.toFixed(1)],
    regions: comps.length, standableCells: [...esc].filter(v => v >= 0).length,
    pocketRegions: pockets.length, pocketCells: pockets.reduce((a, r) => a + r.cells, 0) },
  shippedConfigBfs: { cell: CELL, headings: NH, grid: [W, H], states: qt,
    freeCells: [...free].reduce((a, v) => a + v, 0), reachedCells: [...cfgReached].reduce((a, v) => a + v, 0) },
};
say(`[${sec()}] reach: probe flood ${out.reach.probeFlood.reachedCells}/${probeFree} cells ·` +
    ` shipped census ${out.reach.shippedCensus.standableCells} standable in ${comps.length} regions (${pockets.length} pockets)` +
    ` · shipped config-BFS ${out.reach.shippedConfigBfs.reachedCells}/${out.reach.shippedConfigBfs.freeCells} cells`);

// ─── the flip count: which faces change category between the two rulers ───
const flip = { probeYesBfsNo: 0, probeNoBfsYes: 0, probeYesCensusNo: 0, both: 0, neither: 0 };
const flipExamples = [];
for (let i = 0; i < faces.x.length; i++) {
  const mx = faces.x[i], mz = faces.z[i];
  const p = hullReached(mx, mz);
  const b = nearReach(mx, mz);
  if (p && b) { flip.both++; continue; }
  if (!p && !b) { flip.neither++; continue; }
  if (p && !b) flip.probeYesBfsNo++;
  else flip.probeNoBfsYes++;
  if (flipExamples.length < 40) flipExamples.push({ at: [+mx.toFixed(1), +mz.toFixed(1)],
    mesh: faces.mesh[i], root: faces.root[i], probe: p, bfs: b,
    past: +pastAt(mx, mz).toFixed(2) });
}
out.faceCategoryFlips = { ...flip, totalBandFaces: faces.x.length, examples: flipExamples.slice(0, 16) };

// ═══ 6. exposure over the reachable subset (the shipped flood, not the probe's) ═══
// Where the live page's camera was parked when it printed `exposedFaces: 0`. Read out of the live
// artifact's own reachability seed rather than guessed: three.js picks an LOD level by distance from
// the *camera*, so the page's zero is a statement about what that camera drew, and comparing it to
// this headless sweep without knowing the point is comparing two different pictures.
const pageCam = (() => { const m = /@(-?[\d.]+),(-?[\d.]+)/.exec(live?.reachability?.seed || '');
  return m ? [+m[1], +m[2]] : null; })();
const EX = { exposedFaces: 0, exposedProbeReachable: 0, exposedBfsReachable: 0,
  exposedNeither: 0, cells: new Map(), wholeBodyFaces: 0, list: [] };
for (let i = 0; i < faces.x.length; i++) {
  const mx = faces.x[i], mz = faces.z[i];
  const past = pastAt(mx, mz);
  if (past <= 0) continue;
  EX.exposedFaces++;
  const p = hullReached(mx, mz), b = nearReach(mx, mz);
  if (p) EX.exposedProbeReachable++;
  if (b) EX.exposedBfsReachable++;
  if (!p && !b) EX.exposedNeither++;
  if (reachAt(mx, mz).reach > 2 * BODY_R) EX.wholeBodyFaces++;
  const near = nearestFace(mx, mz, 2);
  const gy = groundAt(mx, mz), gyDrift = lastGroundDrift;
  // Re-judge the same face against the analytic surface at its OWN centre, and against the slope there.
  // `pokeExact <= 0` is the sharp version of the claim: judged exactly, the band gate (`hi < gy + RIDE`)
  // would have dropped this face as lying wholly under the floor plane, so it was never a wall — the
  // 1 m ground cache answered for it from a neighbour `groundDrift` metres away.
  const gyExact = surfaceAt(mx, mz), sl = slopeAt(mx, mz);
  EX.list.push({ at: [+mx.toFixed(2), +mz.toFixed(2)], past: +past.toFixed(2),
    run: +(faces.hi[i] - faces.lo[i]).toFixed(2), aboveGround: +(faces.hi[i] - gy).toFixed(2),
    // How far into the hull's swept volume this face reaches: `aboveGround − RIDE`, unrounded. The band
    // gate (hi < gy + RIDE) already drops anything wholly under the floor, so every face here clears the
    // plane by some amount — the number that decides whether a player could feel the mismatch at all.
    poke: +(faces.hi[i] - gy - RIDE).toFixed(4),
    pokeExact: +(faces.hi[i] - gyExact - RIDE).toFixed(4),
    groundDrift: +gyDrift.toFixed(2), slope: +sl.toFixed(2),
    // The height the cache's substitution is worth HERE: planar drift × local slope. A `poke` smaller
    // than this is not a measurement of the geometry, it is the ruler's own quantisation.
    cacheWorth: +(gyDrift * sl).toFixed(3),
    // Was this triangle even on the page's picture? `pageDrew` applies three.js' own rule
    // (`LOD.update`: take the last level whose `distance` ≤ the distance to the camera) with the
    // distance measured horizontally from the live camera point. Horizontal is the conservative
    // shortcut — the real 3D distance is never smaller, so a tile this says "far" cannot have been
    // drawn near. `pastSwitch` is how far outside the near band the tile already is, which is the
    // number that says whether a plausible camera trailing distance could flip the verdict.
    lod: (() => { const t = faces.lod[i]; if (!t) return null;
      const d = pageCam ? Math.hypot(t.at[0] - pageCam[0], t.at[2] - pageCam[1]) : null;
      let drawn = null;
      if (d !== null) { drawn = 0; for (let q = t.switchAt.length - 1; q >= 0; q--) if (d >= t.switchAt[q]) { drawn = q; break; } }
      return { level: t.level, switchAt: t.switchAt, tileAt: [t.at[0], t.at[2]],
        distFromPageCam: d === null ? null : +d.toFixed(1), pageLevel: drawn,
        pageDrew: drawn === null ? null : drawn === t.level,
        pastSwitch: d === null || t.switchAt[1] === undefined ? null : +(d - t.switchAt[1]).toFixed(1) }; })(),
    mesh: faces.mesh[i], root: faces.root[i],
    ownerDisc: (() => { const q = reachAt(mx, mz); return q.near ? `${q.near.prop}@${q.near.x.toFixed(1)},${q.near.z.toFixed(1)} r${q.near.r.toFixed(2)}` : null; })(),
    probeReach: p, bfsReach: b, inCoveredRaster: (() => { const ai = gi(mx), bi = gi(mz);
      return ai >= 0 && bi >= 0 && ai < N && bi < N && covered[ai * N + bi] === 1; })() });
  const ck = `${Math.floor(mx / 10) * 10},${Math.floor(mz / 10) * 10}`;
  const c = EX.cells.get(ck) || { cell: ck, n: 0, past: -Infinity, at: null, meshes: new Set() };
  c.n++; if (past > c.past) { c.past = past; c.at = [+mx.toFixed(1), +mz.toFixed(1)]; }
  c.meshes.add(faces.mesh[i]); EX.cells.set(ck, c);
}
out.exposure = { exposedFaces: EX.exposedFaces, probeReachable: EX.exposedProbeReachable,
  bfsReachable: EX.exposedBfsReachable, neither: EX.exposedNeither,
  wholeBodyFaces: EX.wholeBodyFaces, cells: EX.cells.size, faces: EX.list,
  // Written HERE because the JSON is dumped at :1023, before the prose block below runs. A field set
  // after the dump is a sentence in the log and nothing in the artifact.
  instancing: {
    node: `${CNT.instancesSwept}/${CNT.instancesSeen} in ${CNT.instancedMeshes} InstancedMeshes`,
    page: `${liveInstancing.sweptInstances}/${liveInstancing.seenInstances} in ${liveInstancing.seenMeshes} InstancedMeshes`,
    agrees: CNT.instancesSeen === liveInstancing.seenInstances &&
      CNT.instancedMeshes === liveInstancing.seenMeshes,
    lodTiles: world.stats.lodTiles, lodLevelsHidden: world.stats.lodLevelsHidden,
  },
  // The exposure arm's own error bar, measured instead of asserted. `groundAt` keys a 1 m cell and
  // answers with the height the FIRST face sampled inside it, so a later face up to √½ m away is
  // judged against a ground it did not sample. `insideErrorBar` asks the one question that disposes
  // of a face without touching the geometry: is its `poke` smaller than what the substitution is
  // worth HERE (planar drift × local slope)? `sealedWhenExact` is sharper still — re-judged against
  // the analytic surface at the face's own centre, the band gate would have dropped the face as
  // lying wholly under the floor plane, so it was never a finding about the world.
  ruler: {
    groundCalls: GC.calls, groundCells: gcache.size, cacheHits: GC.hits,
    bandSamples: GC.bandDriftN,
    bandDriftMean: +(GC.bandDriftSum / Math.max(1, GC.bandDriftN)).toFixed(3),
    bandDriftMax: +GC.bandMaxDrift.toFixed(3), maxDriftAnyFace: +GC.maxDrift.toFixed(3),
    insideErrorBar: EX.list.filter(f => f.poke <= f.cacheWorth).length,
    sealedWhenExact: EX.list.filter(f => f.pokeExact <= 0).length,
    // Of the faces this sweep flags, how many sit in a tile whose level the page's own camera point
    // never resolves — i.e. triangles that exist in the headless build and not in that frame.
    pageCam, notDrawnAtPageCam: EX.list.filter(f => f.lod && f.lod.pageDrew === false).length,
    nodeBandFaces: CNT.bandFaces, pageBandFaces: live?.bandFaces ?? null,
    pageExposedFaces: live?.exposedFaces ?? null,
    perRoot: (() => {
      const base = n => String(n).replace(/#\d+$/, '');
      const node = new Map(); for (const [k, r] of cov.entries()) node.set(base(k), (node.get(base(k)) || 0) + r.faces);
      const page = new Map(); for (const r of live?.coverage || []) page.set(base(r.root), (page.get(base(r.root)) || 0) + r.faces);
      return [...new Set([...node.keys(), ...page.keys()])].map(k =>
        ({ root: k, node: node.get(k) || 0, page: page.get(k) || 0 }))
        .filter(r => r.node || r.page).sort((a, b) => (b.node - a.node) || (b.page - a.page));
    })(),
  } };

// ═══ 7. the two named suspects, measured with the shipped climbable-step predicate ═══
// There is no 0.2 m step rule in the vehicle: RoverPhysics is surface-locked (physics.js:194 marks
// the rig ungrounded only when `this.y - groundH > 0.30`) and the hull follows `surfaceAt` under it,
// so a *collider* step never gates climbing. The shipped step numbers are
//   BAND_STEP = 0.12 (plan.js:280, mirrored by the probe at :279) — a vertical run under this is
//   "a plate's own rim: a step, not a wall", and
//   crest > 0.2 (main.js:4991) — a TERRAIN bump bar for wheel hang-up, the only 0.2 m number in the
//   repo, and it is measured off the ground field, not off a disc.
const stepOf = (x, z, rad = 2.5) => {
  // the largest vertical run of band faces inside a horizontal window, how many of those faces stand
  // in space the hull can already occupy (past > 0 = exposure, the reading that matters for #90), and
  // the ground's own step
  let run = 0, at = null, groundSpan = 0, exposed = 0, exposedPast = 0, exposedMesh = null;
  const ci = Math.floor(x / FGC), cj = Math.floor(z / FGC), ring = Math.ceil(rad / FGC);
  for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) {
    const a = fg.get(`${ci + di},${cj + dj}`); if (!a) continue;
    for (const i of a) {
      if (Math.hypot(faces.x[i] - x, faces.z[i] - z) > rad) continue;
      const h = faces.hi[i] - faces.lo[i];
      if (h > run) { run = h; at = [+faces.x[i].toFixed(1), +faces.z[i].toFixed(1)]; }
      const p = pastAt(faces.x[i], faces.z[i]);
      if (p > 0 && h >= BAND_STEP) { exposed++; if (p > exposedPast) { exposedPast = p; exposedMesh = faces.mesh[i]; } }
    }
  }
  const g0 = surfaceAt(x, z);
  for (const [ox, oz] of [[rad, 0], [-rad, 0], [0, rad], [0, -rad]]) {
    groundSpan = Math.max(groundSpan, Math.abs(surfaceAt(x + ox, z + oz) - g0));
  }
  return { run: +run.toFixed(3), at, groundSpan: +groundSpan.toFixed(3), ground: +g0.toFixed(3),
    bandFacesInWindow: (() => { let n = 0; for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) { const a = fg.get(`${ci + di},${cj + dj}`); if (a) n += a.length; } return n; })(),
    exposed, exposedPast: +exposedPast.toFixed(2), exposedMesh };
};
const suspects = { note: 'no ≤0.2 m collider-step rule exists in src; BAND_STEP 0.12 is the shipped step predicate',
  bandStep: BAND_STEP, mainJsTerrainCrestBar: 0.2, items: [] };
// teleport pads: every disc whose prop carries a pad family, plus the pad's own anchor
const padDiscs = discs.filter(d => /pad|teleport/i.test(d.prop || ''));
const padFams = [...new Set(padDiscs.map(d => (d.prop || '').replace(/#\d+$/, '')))];
for (const t of (world.base.teleports || [])) {
  const fam = padFams.filter(f => {
    const dd = discs.filter(d => (d.prop || '').replace(/#\d+$/, '') === f);
    return dd.some(d => Math.hypot(d.x - t.x, d.z - t.z) < 8);
  });
  const near = discs.filter(d => Math.hypot(d.x - t.x, d.z - t.z) < 8);
  const top = near.reduce((a, d) => Math.max(a, d.r), 0);
  suspects.items.push({ kind: 'teleport_pad', at: [+t.x.toFixed(1), +t.z.toFixed(1)], key: t.key,
    families: fam, discs: near.length, widestDiscR: +top.toFixed(2),
    step: stepOf(t.x, t.z, 3), reachedByBfs: nearReach(t.x, t.z), probeReach: hullReached(t.x, t.z),
    exposurePastAtPad: +pastAt(t.x, t.z).toFixed(2) });
}
// crystals: the sample sites, ordered by distance from the centre (the island-edge ones)
for (const s of [...(world.base.samples || [])].sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z)).slice(0, 4)) {
  suspects.items.push({ kind: 'crystal_site', at: [+s.x.toFixed(1), +s.z.toFixed(1)], id: s.id,
    rFromCentre: +Math.hypot(s.x, s.z).toFixed(1), rise: +s.rise.toFixed(3), sink: +s.sink.toFixed(3),
    step: stepOf(s.x, s.z, 3), reachedByBfs: nearReach(s.x, s.z), probeReach: hullReached(s.x, s.z),
    discsNear: discs.filter(d => Math.hypot(d.x - s.x, d.z - s.z) < 4).length,
    // `discsNear` reads the list the solver walks, which a buried site is deliberately OUT of;
    // `discsOwned` is the site's own ledger. The two apart is the difference between "a rock with
    // no wall" and "a rock under the sand" — the first row read 0 for three sites and I called it
    // a drive-through spire before asking who removes a buried site's discs and when.
    discsOwned: s.discs.length, wallUp: !!s.wallUp });
}
out.suspects = suspects;

// ═══ 8. positive controls: make the ruler go red, then say so ═══
// (a) a synthetic disc in proven-open ground: nothing drawn near, nothing standing near. The judge
//     must call it phantom with a full bare rim, and the exposure arithmetic must call it a wall the
//     hull walks through.
let openSpot = null, bestReach = -Infinity;
for (let x = -100; x <= 100; x += 2) for (let z = -100; z <= 100; z += 2) {
  if (Math.hypot(x, z) > ISLAND_R - 6) continue;
  if (onVeil(x, z) || nearSolid(x, z, 3)) continue;
  const rr = reachAt(x, z).reach;
  if (rr > bestReach) { bestReach = rr; openSpot = [x, z]; }
}
if (!openSpot || bestReach < BODY_R + 1.2) {
  say('CONTROL BLIND — no open ground found whose clearance exceeds the hull ring; the exposure ' +
      'gate cannot be armed, so this run measures nothing. ' +
      `(best reach ${bestReach.toFixed(2)} m, need > ${(BODY_R + 1.2).toFixed(2)})`);
  process.exit(RC.CONTROL_BLIND);
}
const synthDisc = { x: openSpot[0], z: openSpot[1], r: 1.2, prop: 'CONTROL:synthetic-disc',
  emitted: true, lot: null, share: null };
const cDisc = judge(synthDisc);
// (a2) a MUTATION of a real island disc. Two mutations, because the shipped ruler is only sensitive
//     to one of them and the other is a measured blind spot worth naming:
//     · SHRINK the disc's own lot rectangle by 2 m on each half, leaving `r` and `share` as the tiler
//       wrote them — i.e. "the collider still carries the footprint the prop no longer has". The
//       licence `entitled = r − min(share.hw, share.hd)` does not move, the rectangle does, so the
//       judge must report the 2 m as unlicensed and call the disc overWide. This is the control.
//     · GROW `r` by 1.5 m and leave everything else. Here `entitled` grows by exactly the same 1.5 m
//       as the rim does, so maxPast is provably unchanged: the shipped overWide arm is invariant to
//       a disc simply being fatter. Not a control failure — a sensitivity claim, printed with its
//       numbers, and the reason this file also reports `overshootLot = r − min(lot.hw, lot.hd)`.
const mutBase = rows.filter(r => !r.d.emitted && r.j.bareN > 0 && r.j.unlicensed === 0 && r.d.lot && r.d.share)
  .sort((a, b) => b.d.r - a.d.r)[0];
const SHRINK_LO = 1.5, SHRINK_HI = 3.5, GROW = 1.5;
let mutOverWide = null;
if (mutBase) {
  const d = mutBase.d;
  const shrinkOf = s => judge({ ...d, lot: { ...d.lot, hw: d.lot.hw - s, hd: d.lot.hd - s } });
  const jlo = shrinkOf(SHRINK_LO), jhi = shrinkOf(SHRINK_HI);
  const grown = { ...d, r: d.r + GROW };
  const jg = judge(grown);
  const mk = (j, s) => ({
    mutation: `lot hw/hd −${s} m, r and share untouched`,
    kindBefore: mutBase.j.kind, unlicensedBefore: mutBase.j.unlicensed, maxPastBefore: mutBase.j.maxPast,
    kindAfter: j.kind, unlicensedAfter: j.unlicensed, unlicensedFrac: +(j.unlicensed / S).toFixed(3),
    bareAfter: +j.bare.toFixed(3), maxPastAfter: j.maxPast === null ? null : +j.maxPast.toFixed(3),
  });
  mutOverWide = {
    prop: d.prop, at: [+d.x.toFixed(2), +d.z.toFixed(2)], r: d.r,
    lotBefore: [+d.lot.hw.toFixed(2), +d.lot.hd.toFixed(2)], entitled: mutBase.j.entitled,
    armBar: `overWide needs unlicensed/${S} > 0.25 — the shipped judge's own bar, disc-audit-probe.js:448`,
    shrinkLo: mk(jlo, SHRINK_LO),
    shrink: { ...mk(jhi, SHRINK_HI),
      fired: jhi.kind === 'overWide' && jhi.unlicensed > 0 &&
        jhi.maxPast !== null && mutBase.j.maxPast !== null &&
        jhi.maxPast > mutBase.j.maxPast + SHRINK_HI * 0.6 },
    grow: {
      ...mk(jg, 0), mutation: `r +${GROW} m, lot and share untouched`,
      overshootLotBefore: mutBase.j.overshootLot, overshootLotAfter: jg.overshootLot,
      detected: jg.kind === 'overWide' || (jg.maxPast !== null && mutBase.j.maxPast !== null &&
        jg.maxPast > mutBase.j.maxPast + 0.3),
    },
  };
}
// (b) a synthetic 1 m tall quad standing in that same open ground: the exposure gate must read
//     past > 0 on its faces and the sweep must count the face.
const quad = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.0),
  new THREE.MeshStandardMaterial({ color: 0xff0000 }));
quad.position.set(openSpot[0], surfaceAt(openSpot[0], openSpot[1]) + 0.98, openSpot[1]);
scene.add(quad); scene.updateMatrixWorld(true);
const qf = [];
{
  const gp = quad.geometry, pos = gp.attributes.position, idx = gp.index;
  const tri = idx ? idx.count : pos.count;
  const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3();
  for (let t = 0; t + 2 < tri; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    A.fromBufferAttribute(pos, i0).applyMatrix4(quad.matrixWorld);
    Bv.fromBufferAttribute(pos, i1).applyMatrix4(quad.matrixWorld);
    C.fromBufferAttribute(pos, i2).applyMatrix4(quad.matrixWorld);
    const mx = (A.x + Bv.x + C.x) / 3, mz = (A.z + Bv.z + C.z) / 3;
    qf.push({ at: [+mx.toFixed(2), +mz.toFixed(2)], past: +pastAt(mx, mz).toFixed(3),
      run: +(Math.max(A.y, Bv.y, C.y) - Math.min(A.y, Bv.y, C.y)).toFixed(3),
      probeReach: hullReached(mx, mz), bfsReach: nearReach(mx, mz) });
  }
}
scene.remove(quad); scene.updateMatrixWorld(true);
// (c) the licensing arithmetic, independent of anything drawn: coverDiscs' own middle disc must
//     license its own bulge, and slid 3 m along its lot it must report the whole 3 m.
const bulgeOf = shift => {
  const L = 12, Wd = 4, ry = 0.4;
  const s = coverDiscs(L, Wd)[1];
  const d0 = { x: s.dx * Math.cos(ry) + shift, z: -s.dx * Math.sin(ry), r: s.r,
               lot: { cx: 0, cz: 0, hw: L / 2, hd: Wd / 2, ry }, share: { hw: s.hw, hd: s.hd } };
  const o = outlineOf(d0);
  let past = -Infinity;
  for (let i = 0; i < 96; i++) {
    const th = i / 96 * Math.PI * 2;
    past = Math.max(past, outsideRect(o, d0.x + Math.cos(th) * d0.r, d0.z + Math.sin(th) * d0.r) - o.entitled);
  }
  return +past.toFixed(2);
};
const cleanPast = bulgeOf(0), brokenPast = bulgeOf(3);
// (d) the exposure sign gate on a one-disc world — the probe's own control, same numbers
const one = x => [{ x, z: 0, r: 1 }];
const pastWith = (ds, x, z) => { let best = Infinity; for (const d of ds) best = Math.min(best, Math.hypot(x - d.x, z - d.z) - d.r); return +(best - BODY_R).toFixed(2); };
const gate = { outside: pastWith(one(3.2), 0, 0), inside: pastWith(one(2.4), 0, 0), touch: pastWith(one(2.6), 0, 0) };
// (e) the flood's own polarity: a synthetic ring of discs that seals a box of open ground must make
//     a census region with pivot === 0 and no edge touch, i.e. the pocket detector must fire.
{
  const bx = openSpot[0], bz = openSpot[1], half = 5;
  const ring = [];
  for (let a = 0; a < 6.2832; a += Math.PI / 12) ring.push({ x: bx + Math.cos(a) * half, z: bz + Math.sin(a) * half, r: 1.2 });
  // analytic version of the census on the mutated set: count standable cells with no pivot inside
  const inside = { cells: 0, pivot: 0, maxClear: -99 };
  for (let x = bx - half; x <= bx + half; x += EC) for (let z = bz - half; z <= bz + half; z += EC) {
    if (Math.hypot(x - bx, z - bz) > half - 1) continue;
    let c = 99;
    for (const d of ring) c = Math.min(c, Math.hypot(x - d.x, z - d.z) - d.r - CLEAR);
    if (c < 0) continue;
    inside.cells++; inside.maxClear = Math.max(inside.maxClear, c);
    if (c >= TURN) inside.pivot++;
  }
  const rc = fired => fired ? 0 : RC.CONTROL_BLIND;
// (f) the sand-dressed prop: its drawn crown and its ring's membership are two readings of one `k`,
//     so they must agree. This is the control that the 407-vs-0 exposure argument needed: the offline
//     world took the membership half of the burial and left the spire drawn at its raised height, so
//     the ruler counted a band the shipped page never renders. Break either half and this goes red.
const crownOverGround = s => +(new THREE.Box3().setFromObject(s.crystal).max.y - heightAt(s.x, s.z)).toFixed(2);
const poseDisagree = () => world.base.samples.filter(s => (crownOverGround(s) > RIDE) !== !!s.wallUp);
const poseRows = world.base.samples.map(s => ({ id: s.id, crown: crownOverGround(s), wallUp: !!s.wallUp,
  buried: +s.buried.toFixed(2), discs: s.discs.length }));
const poseClean = poseDisagree();
let poseMutated = null;
{
  const victim = world.base.samples.find(s => !s.wallUp && s.discs.length);
  if (victim) {
    const y = victim.crystal.position.y;
    victim.crystal.position.y = victim.seatY;   // the pre-fix harness: ring out, rock left standing
    victim.crystal.updateMatrixWorld(true);
    poseMutated = { id: victim.id, crown: crownOverGround(victim), wallUp: false, fired: poseDisagree().length > 0 };
    victim.crystal.position.y = y;
    victim.crystal.updateMatrixWorld(true);
  }
}
  const phantomFired = cDisc.kind === 'phantom' && cDisc.bare === 1;
  out.controls = {
    openSpot, openSpotReach: +bestReach.toFixed(2),
    syntheticDisc: { kind: cDisc.kind, bare: +cDisc.bare.toFixed(2), phantomFired, rc: rc(phantomFired) },
    mutateRealDisc: mutOverWide,
    syntheticFace: { faces: qf, n: qf.length,
      faceCaught: qf.length > 0 && qf.every(x => x.past > 0 && x.run >= BAND_STEP) },
    bulge: { cleanPast, brokenPast, pass: cleanPast <= TOL && brokenPast > TOL },
    gate: { ...gate, pass: gate.outside > 0 && gate.inside < 0 && gate.touch === 0 },
    sealedRing: { ...inside, n: ring.length, pocketFired: inside.cells > 0 && inside.pivot === 0 },
    poseGate: { rows: poseRows, disagreements: poseClean.map(r => r.id),
      agree: poseClean.length === 0, mutate: poseMutated },
  };
  out.controls.syntheticDisc.rc = rc(phantomFired);
  out.controls.mutateRealDisc = mutOverWide ? { ...mutOverWide, rc: rc(mutOverWide.shrink.fired) } : null;
  out.controls.syntheticFace.rc = rc(out.controls.syntheticFace.faceCaught);
  out.controls.bulge.rc = rc(out.controls.bulge.pass);
  out.controls.gate.rc = rc(out.controls.gate.pass);
  out.controls.sealedRing.rc = rc(out.controls.sealedRing.pocketFired);
  out.controls.poseGate.agreeFired = out.controls.poseGate.agree;
  out.controls.poseGate.mutateFired = !!poseMutated?.fired;
  out.controls.poseGate.rc = rc(out.controls.poseGate.agree && out.controls.poseGate.mutateFired);
}
const controls = out.controls;
const mm = s => (s === null || s === undefined || (typeof s === 'number' && Number.isNaN(s))) ? '–'
  : (typeof s === 'number' ? s.toFixed(3) : s);
const controlsPass = controls.syntheticDisc.phantomFired && !!controls.mutateRealDisc?.shrink?.fired &&
  controls.syntheticFace.faceCaught && controls.bulge.pass && controls.gate.pass && controls.sealedRing.pocketFired &&
  controls.poseGate.agree && controls.poseGate.mutateFired;
out.controls.pass = controlsPass;
say(`[${sec()}] positive controls (rc 0 = the ruler went red when the data was broken on purpose; rc 2 = it stayed blind):`);
say(`  1 phantom · synthetic r${synthDisc.r} disc in proven-open sand at ${controls.openSpot} (clearance ${controls.openSpotReach} m > hull ring ${(BODY_R + 1.2).toFixed(2)})` +
    ` → reading kind=${controls.syntheticDisc.kind}, bare=${controls.syntheticDisc.bare}/1 → rc ${controls.syntheticDisc.rc}`);
if (controls.mutateRealDisc) {
  const m = controls.mutateRealDisc;
  say(`  2 overWide · real island disc ${m.prop} @${m.at} r${mm(m.r)}, lot halves [${m.lotBefore}] → [${(m.lotBefore[0] - SHRINK_HI).toFixed(2)},${(m.lotBefore[1] - SHRINK_HI).toFixed(2)}], licence ${mm(m.entitled)} unchanged`);
  say(`      before kind ${m.shrink.kindBefore} unlicensed ${m.shrink.unlicensedBefore}/48 maxPast ${mm(m.shrink.maxPastBefore)}` +
      ` → after kind ${m.shrink.kindAfter} unlicensed ${m.shrink.unlicensedAfter}/48 (${m.shrink.unlicensedFrac} of the rim, bar ${m.armBar}) maxPast ${mm(m.shrink.maxPastAfter)} (bare ${m.shrink.bareAfter}) → rc ${m.rc}`);
  const lo = m.shrinkLo;
  say(`      the arm's dead band, same disc shrunk only ${SHRINK_LO} m: maxPast ${mm(lo.maxPastBefore)} → ${mm(lo.maxPastAfter)} but unlicensed ${lo.unlicensedAfter}/48 = ${lo.unlicensedFrac} < 0.25` +
      ` so the reading stays "${lo.kindAfter}" — a real ${SHRINK_LO} m collider/footprint disagreement is INVISIBLE to the shipped overWideCount on a disc this size`);
  say(`      blind spot, same disc mutated the other way · ${m.grow.mutation}: maxPast ${mm(m.grow.maxPastBefore)} → ${mm(m.grow.maxPastAfter)}` +
      ` (Δ ${mm(m.grow.maxPastAfter - m.grow.maxPastBefore)} of the ${GROW} m grown), kind still ${m.grow.kindAfter}, unlicensed ${m.grow.unlicensedAfter}/48.` +
      ` The shipped arm is r-invariant because entitled = r − min(share) moves with r;` +
      ` this file's overshootLot does see it (${mm(m.grow.overshootLotBefore)} → ${mm(m.grow.overshootLotAfter)}) → arm detected it: ${m.grow.detected}`);
} else say(`  2 overWide · NO island disc available to mutate → rc ${RC.CONTROL_BLIND} (the licence arithmetic is unproven on live geometry)`);
const q = controls.syntheticFace;
say(`  3 exposure gate · injected 1.2 × 1.0 m quad at ${controls.openSpot}: past ${q.faces.map(x => x.past).join(' / ')} m (> 0 = the hull walks through drawn geometry),` +
    ` vertical run ${q.faces.map(x => x.run).join(' / ')} m ≥ BAND_STEP ${BAND_STEP}, probe-flood reach ${q.faces.map(x => x.probeReach).join(' / ')}, shipped-BFS reach ${q.faces.map(x => x.bfsReach).join(' / ')} → rc ${q.rc}`);
say(`  4 licence arithmetic · coverDiscs' own middle disc: centred maxPast ${controls.bulge.cleanPast} m ≤ TOL ${TOL},` +
    ` slid ${3} m along its lot maxPast ${controls.bulge.brokenPast} m > ${TOL} → rc ${controls.bulge.rc}`);
say(`  5 exposure sign gate · one-disc world outside/inside/touching = ${controls.gate.outside}/${controls.gate.inside}/${controls.gate.touch}` +
    ` (want >0 / <0 / 0) → rc ${controls.gate.rc}`);
say(`  6 pocket detector · ${controls.sealedRing.cells} standable cells ringed by ${controls.sealedRing.n} discs: pivot cells ${controls.sealedRing.pivot},` +
    ` max clear ${mm(controls.sealedRing.maxClear)} m < TURN ${TURN.toFixed(2)} → the census must call it a sealed pocket → rc ${controls.sealedRing.rc}`);
say(`  7 pose/collider agreement · ${controls.poseGate.rows.length} sample sites: drawn crown over own ground vs. ring membership —` +
    ` ${controls.poseGate.rows.map(r => `${r.id}:${r.crown.toFixed(2)}${r.wallUp ? 'W' : '-'}`).join(' ')}` +
    ` (${controls.poseGate.rows.map(r => `own ${r.discs}, buried ${r.buried.toFixed(2)}`).join(' ')})` +
    ` · ${controls.poseGate.agree ? 'all agree' : `DISAGREE at site ${controls.poseGate.disagreements}`}` +
    ` · leave a ring-out site standing at full height (site ${controls.poseGate.mutate?.id}, crown ${controls.poseGate.mutate?.crown} m)` +
    ` and the check must fire: ${controls.poseGate.mutateFired} → rc ${controls.poseGate.rc}`);
say(`  controls overall → ${controlsPass ? 'ALL SEVEN FIRED' : 'A CONTROL STAYED GREEN — this run measures nothing'}`);

// ═══ 9. the TSV ═══
const COLS = ['prop', 'zone', 'emitted', 'x', 'z', 'r', 'lot_cx', 'lot_cz', 'lot_w', 'lot_d', 'lot_ry',
  'share_hw', 'share_hd', 'overshoot_lot_r_minus_min_whalf_dhalf', 'bulge_entitlement_r_minus_min_share',
  'max_past_beyond_licence_m', 'worst_bare_rim_at', 'bare_of_48', 'unlicensed_of_48', 'licensed_of_48',
  'on_veil_of_48', 'kind', 'centre_bare', 'pocket_samples', 'nearest_face_m', 'nearest_face_mesh',
  'nearest_face_at', 'worst_bare_rim_face_m', 'worst_bare_rim_face_mesh', 'exposed_past_at_centre_m',
  'probe_reach_centre', 'shipped_bfs_reach_centre', 'shipped_census_pivot_in_region', 'shipped_census_edge_touch'];
const f = v => (v === null || v === undefined || Number.isNaN(v)) ? '' : String(v);
const lines = [COLS.join('\t')];
const judgedRows = needNear ? rows : rows.map(r => ({ ...r, nearCentre: null, worstBareRim: null }));
for (const r of judgedRows) {
  const d = r.d, j = r.j;
  const ei = (() => { const i = Math.round((d.x - x0) / EC), k = Math.round((d.z - z0) / EC);
    if (i < 0 || k < 0 || i >= EW || k >= EH) return null;
    const c = cid[i * EH + k]; return c < 0 ? null : comps[c]; })();
  lines.push([
    f(d.prop), f(d.zone), f(d.emitted ? 1 : 0), d.x.toFixed(3), d.z.toFixed(3), d.r.toFixed(3),
    f(d.lot ? d.lot.cx : null), f(d.lot ? d.lot.cz : null), f(j.lotW), f(j.lotD),
    f(d.lot ? (+d.lot.ry).toFixed(4) : null),
    f(d.share ? +d.share.hw.toFixed(3) : null), f(d.share ? +d.share.hd.toFixed(3) : null),
    f(j.overshootLot), f(j.entitled), f(j.maxPast === null ? null : +j.maxPast.toFixed(3)),
    f(j.worstAt ? j.worstAt.join(',') : null), j.bareN, j.unlicensed, j.licensed, j.rim, j.kind,
    f(j.centreBare ? 1 : 0), f(j.pocket || null),
    f(r.nearCentre ? r.nearCentre.metres?.toFixed(2) : null), f(r.nearCentre?.mesh), f(r.nearCentre?.at?.join(',')),
    f(r.worstBareRim ? r.worstBareRim.metres?.toFixed(2) : null), f(r.worstBareRim?.mesh),
    f(+pastAt(d.x, d.z).toFixed(3)), f(hullReached(d.x, d.z) ? 1 : 0), f(nearReach(d.x, d.z) ? 1 : 0),
    f(ei ? ei.pivot : null), f(ei ? (ei.edge ? 1 : 0) : null),
  ].join('\t'));
}
// Two rules the last run broke. The date is taken from the run, not typed here: a hardcoded
// `2026-09-27` keeps printing tomorrow's sweeps into yesterday's file. And a fixed path means every
// re-run destroys the reading a prose block cites — `props.js`'s `siteSinkY` note quotes the
// 412-face count of `phantom-census-2026-09-27-full.log`, and the next run would have flattened the
// json beside it. So a different byte-image is parked, not overwritten, and the parked name is
// printed by the same statement that parks it.
// The park slot is searched for a free name, not derived from the date: the first version used
// `-已被-<date>的运行取代`, and a second same-day run renamed onto the same slot and ate the file it
// was supposed to save (the 22:05 sweep, byte-irreplaceable because the sweep is seeded random).
const stamp = new Date().toISOString().slice(0, 10);
const dump = (name, body) => {
  const p = path.join(ROOT, 'tools/logs', name);
  if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') !== body) {
    const dot = name.lastIndexOf('.');
    let parked;
    for (let n = 1; ; n++) {
      parked = path.join(ROOT, 'tools/logs', `${name.slice(0, dot)}-被${stamp}第${n}次取代${name.slice(dot)}`);
      if (!fs.existsSync(parked)) break;
    }
    fs.renameSync(p, parked);
    say(`REPLACED ${path.relative(ROOT, p)} -> ${path.relative(ROOT, parked)}`);
  }
  fs.writeFileSync(p, body);
  return p;
};
const tsvPath = dump(`phantom-census-${stamp}.tsv`, lines.join('\n') + '\n');
const jsonPath = dump(`phantom-census-${stamp}.json`, JSON.stringify(out, null, 1));
out.files = { tsv: tsvPath, json: jsonPath, rows: lines.length - 1 };

// ═══ 10. the printed tables ═══
const top = (arr, n, k) => [...arr].sort((a, b) => (b[k] ?? -1e9) - (a[k] ?? -1e9)).slice(0, n);
say('\n═══ PHANTOM: discs with no drawn geometry anywhere near them ═══');
const phantomRows = judgedRows.filter(r => r.j.kind === 'phantom');
say(`count ${phantomRows.length} · families ${[...new Set(phantomRows.map(r => r.d.prop))].length}`);
for (const r of top(phantomRows.map(x => ({ ...x, past: x.j.maxPast ?? -9 })), 12, 'past')) {
  say(`  ${r.d.prop} @${r.d.x.toFixed(1)},${r.d.z.toFixed(1)} r${r.d.r.toFixed(2)} bare ${r.j.bareN}/${S}` +
      ` nearest face ${r.nearCentre?.metres ?? '–'} m (${r.nearCentre?.mesh ?? '–'})`);
}
say('\n═══ BARE RIM: every disc with a bare rim sample, split by licence ═══');
say(`  discs with any bare sample : ${DC.bareAny}`);
say(`  …all of it tiling-licensed  : ${DC.bareLicensedOnly}   (legitimate convexity: max past beyond the licence ≤ ${TOL} m)`);
say(`  …past the licence           : ${DC.bareUnlicensed}`);
say(`  …emitted (no rect licence)  : ${unlicensed.filter(r => r.d.emitted).length}`);
const byFamBare = Object.entries(byFamily).filter(([, b]) => b.bareAny)
  .sort((a, b) => b[1].bareUnlicensed - a[1].bareUnlicensed || b[1].bareAny - a[1].bareAny);
say('  families with bare rims (unlicensed | licensed-only | discs):');
for (const [fam, b] of byFamBare.slice(0, 20)) {
  say(`    ${fam.padEnd(28)} ${String(b.bareUnlicensed).padStart(4)} | ${String(b.bareLicensedOnly).padStart(3)} | ${String(b.discs).padStart(4)}` +
      `  max overshoot vs lot ${b.maxOvershootLot === -Infinity ? '–' : b.maxOvershootLot} m @${b.maxOvershootAt ? b.maxOvershootAt.join(',') : '–'}`);
}
say('\n═══ scatter:rock, disc by disc ═══');
say(`  ${rockAll.length} discs in the family · ${rockAll.filter(r => r.j.bareN).length} with a bare rim · ` +
    `${rockAll.filter(r => r.j.bareN && r.j.unlicensed).length} past the licence · ` +
    `${rockAll.filter(r => r.j.kind === 'phantom').length} phantom`);
let rockWorst = null;
for (const r of rockAll) {
  if (!r.j.bareN) continue;
  const d = r.worstBareRim?.metres ?? -1;
  if (!rockWorst || d > rockWorst.d) rockWorst = { r, d };
}
say(`  family max overshoot (r − min(w,d)/2 over the lot outline): ` +
    `${Math.max(...rockAll.map(r => r.j.overshootLot ?? -Infinity)).toFixed(3)} m`);
if (rockWorst && rockWorst.r.worstBareRim) {
  const w = rockWorst.r.worstBareRim;
  say(`  the rock disc whose bare rim stands furthest from any drawn face: ${rockWorst.r.d.prop} ` +
      `@${rockWorst.r.d.x.toFixed(1)},${rockWorst.r.d.z.toFixed(1)} r${rockWorst.r.d.r.toFixed(2)} — ` +
      `a bare rim point at ${w.at.join(',')} is ${w.metres.toFixed(2)} m from the nearest drawn band face ` +
      `(${w.mesh} @${w.at.join(',')})`);
}
say('\n═══ THE SINGLE LARGEST UNLICENSED OVERSHOOT ═══');
const worst = [...judgedRows].filter(r => r.j.bareN && r.j.unlicensed)
  .sort((a, b) => (b.j.maxPast ?? -1e9) - (a.j.maxPast ?? -1e9))[0];
if (worst) say(`  ${worst.d.prop} @${worst.d.x.toFixed(2)},${worst.d.z.toFixed(2)} r${worst.d.r.toFixed(2)}` +
  ` · ${worst.j.maxPast.toFixed(3)} m past its licence, at ${worst.j.worstAt.join(',')}` +
  ` · lot ${worst.j.out ? `${worst.j.out.cx},${worst.j.out.cz} hw${worst.j.out.hw} hd${worst.j.out.hd}` : 'none'}` +
  ` · entitled ${worst.j.entitled} m · nearest drawn face ${worst.nearCentre?.metres ?? '–'} m (${worst.nearCentre?.mesh ?? '–'})`);
else say(`  none. ${DC.bareAny} discs have a bare rim sample and ${DC.bareLicensedOnly} of them are inside the tiling licence, so the population the ask calls "the remaining ~60" measures ${DC.bareUnlicensed}. The largest bare rim anywhere, licensed or not: ${Math.max(...rows.map(r => r.j.maxPast ?? -Infinity)).toFixed(3)} m past its licence — i.e. nothing is past it.`);
say('\n═══ EXPOSURE: reachable subset, and whether the two floods agree ═══');
say(`  band faces ${faces.x.length} · past > 0: ${EX.exposedFaces} · probe flood says reachable: ${EX.exposedProbeReachable}` +
    ` · shipped config-BFS says reachable: ${EX.exposedBfsReachable} · neither: ${EX.exposedNeither}`);
say(`  category flips over ALL band faces: both ${flip.both} · neither ${flip.neither} ·` +
    ` probe-only ${flip.probeYesBfsNo} · bfs-only ${flip.probeNoBfsYes}`);
if (EX.cells.size) {
  say('  worst exposed cells:');
  for (const c of [...EX.cells.values()].sort((a, b) => b.past - a.past).slice(0, 10)) {
    say(`    ${c.cell} n${c.n} past ${c.past.toFixed(2)} m at ${c.at} meshes ${[...c.meshes].slice(0, 3).join('/')}`);
  }
  const byRootExp = {};
  for (const x of EX.list) byRootExp[x.root] = (byRootExp[x.root] || 0) + 1;
  say(`  exposed faces by drawn root: ${Object.entries(byRootExp).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

// The exposure rule is only comparable to the page's 0 if both sides walked the same triangles. This
// used to be asserted in prose ("the whole difference is instance coverage") off a 2:1 ratio nobody
// checked, and the assertion was wrong twice over: the page's other 407 exposed faces came from the
// harness applying one half of a site's burial, not from the gravel. Both numbers are printed side by
// side now, so a divergence is a reading rather than a sentence.
{
  const I = out.exposure.instancing;
  say(`  instancing coverage of the two rulers: node ${I.node} · the page's own run ${I.page} → ${I.agrees ? 'AGREE' : 'DISAGREE'}`);
  say(`  why they can agree at all: ${I.lodTiles} 'stone-field' THREE.LOD tiles hold the same chips twice (80 and 20 facets,` +
      ` terrain.js:1268-1282) and only the renderer's LOD.update() picks a level. A headless build has no camera, so before` +
      ` tools/offline-world.mjs resolved them it swept ${I.lodLevelsHidden} InstancedMeshes this frame never draws and counted` +
      ` every pebble twice. Equal counts are still not the same triangles: the page chooses per tile by camera distance, the` +
      ` harness always takes the near level.`);
  {
    const R = out.exposure.ruler;
    say(`  the exposure arm's own error bar, measured on this run: ${R.groundCalls} ground lookups answering from ` +
        `${R.groundCells} cached 1 m cells (${R.cacheHits} hits). Of the ${R.bandSamples} band faces the gate tested, the one ` +
        `it was handed had drifted ${mm(R.bandDriftMean)} m on average and ${mm(R.bandDriftMax)} m at worst from the point ` +
        `whose height it is holding — worst anywhere in the sweep ${mm(R.maxDriftAnyFace)} m.`);
    if (EX.exposedFaces) {
      const deepest = Math.max(...EX.list.map(x => x.poke));
      say(`  against the page's ${R.pageExposedFaces}: ${EX.exposedFaces} of ${R.nodeBandFaces} band faces, all of them ` +
          `${[...new Set(EX.list.map(x => x.root))].join('/')}, run ` +
          `${Math.min(...EX.list.map(x => x.run)).toFixed(2)}-${Math.max(...EX.list.map(x => x.run)).toFixed(2)} m, poking at most ` +
          `${mm(deepest)} m into the hull's swept volume (RIDE ${RIDE} m).`);
      for (const f of EX.list) say(`    @${f.at} ${f.mesh} · poke ${mm(f.poke)} m · same face re-judged at its own centre: ` +
          `pokeExact ${mm(f.pokeExact)} m · ground drift ${mm(f.groundDrift)} m × slope ${f.slope.toFixed(2)} = the cache is ` +
          `worth ${mm(f.cacheWorth)} m here · ${f.pokeExact <= 0 ? 'SEALED by the band gate when judged exactly' : 'stands, however thin'}` +
          (f.lod ? ` · LOD level ${f.lod.level} of a tile ${f.lod.distFromPageCam} m from the page's camera (switch ` +
            `${f.lod.switchAt[1]} m, ${f.lod.pastSwitch} m past it) → that camera draws level ${f.lod.pageLevel}, so this triangle` +
            `${f.lod.pageDrew ? ' WAS in that frame' : ' was never drawn there'}` : ''));
      // Three tallies, three separate claims, and they do not substitute for one another: the cache's
      // error bar, the exact re-judge, and whether the page's camera resolves the level this face is
      // a triangle of.
      const open = EX.list.filter(f => !(f.pokeExact <= 0) && !(f.lod && f.lod.pageDrew === false)).length;
      const verdict = open === 0
        ? `every face is disposed of by a ruler reading, not by argument: ${R.sealedWhenExact} sealed when judged exactly, `
          + `${R.notDrawnAtPageCam} sitting in an LOD level the page's camera never resolves → nothing left that both rulers can see`
        : `${open} of ${EX.exposedFaces} stand after both tests → open, and named above`;
      say(`  disposition: ${R.insideErrorBar}/${EX.exposedFaces} within the drift×slope error bar · ${R.sealedWhenExact}/${EX.exposedFaces} ` +
          `sealed at pokeExact ≤ 0 (the cache-order hypothesis is FALSIFIED if this is 0: the poke survives the exact ground) · ` +
          `${R.notDrawnAtPageCam}/${EX.exposedFaces} only in a far LOD level · ${verdict}`);
    } else say(`  exposure: 0 band faces of ${R.nodeBandFaces} — the node and the page's ${R.pageExposedFaces} agree.`);
    if (R.pageBandFaces && R.pageBandFaces !== R.nodeBandFaces) {
      const delta = R.pageBandFaces - R.nodeBandFaces;
      say(`  band-face counts differ (node ${R.nodeBandFaces} · page ${R.pageBandFaces} = ${delta > 0 ? '+' : ''}${delta}` +
          ` = ${((delta / R.nodeBandFaces) * 100).toFixed(2)}%). Where, per root, from each side's own coverage table:`);
      for (const r of R.perRoot) if (r.node !== r.page) say(`    ${r.root}: node ${r.node} · page ${r.page} → ${r.node - r.page > 0 ? 'only the headless sweep has these' : 'only the page has these'}`);
      say(`  A root with two LOD levels is the one place the difference is *geometry*, not mesh inventory: this build has no`);
      say(`  camera, so tools/offline-world.mjs resolves every tile to its near level while the page's LOD.update(camera)`);
      say(`  resolves a far tile to its coarse one. Equal instance counts (both 3600) cannot show that — each level holds`);
      say(`  the same instances, only with different triangles per chip.`);
    }
  }
}

say('  faces whose category flips between the two floods (probe flood vs shipped nearReach), first 8:');
for (const e of out.faceCategoryFlips.examples.slice(0, 8)) {
  say(`    ${e.root}/${e.mesh} @${e.at} probe=${e.probe} shippedBFS=${e.bfs} past ${e.past} m`);
}
say('\n═══ THE TWO NAMED SUSPECTS, measured against the shipped step predicate ═══');
say(`  src has NO ≤0.2 m collider-step rule. RoverPhysics is surface-locked (physics.js:194 ungrounds`);
say(`  only when y − groundH > 0.30) and the hull rides surfaceAt, so a disc's top never gates a climb.`);
say(`  The shipped bars are BAND_STEP ${BAND_STEP} (plan.js:280) for step-vs-wall on drawn band faces,`);
say(`  and crest > 0.2 (main.js:4991) for TERRAIN bumps only. RIDE ${RIDE} BODY_R ${BODY_R}.`);
for (const s of suspects.items) {
  const climbable = s.step.run < BAND_STEP;
  say(`  ${s.kind.padEnd(12)} ${String(s.id ?? s.key ?? '').padEnd(9)} @${s.at.join(',')}  ` +
      `band faces within 3 m: ${s.step.bandFacesInWindow}, tallest vertical run ${s.step.run.toFixed(3)} m at ${s.step.at || '—'}  ` +
      `→ step-vs-wall at BAND_STEP ${BAND_STEP}: ${climbable ? 'STEP (the hull rides over it)' : 'WALL (the band ruler treats it as a wall)'}  ` +
      `EXPOSED among them (past > 0 and run ≥ BAND_STEP): ${s.step.exposed}${s.step.exposed ? `, worst past ${s.step.exposedPast} m in ${s.step.exposedMesh}` : ''}  ` +
      `ground span over 3 m: ${s.step.groundSpan.toFixed(3)} m (terrain crest bar 0.2)  ` +
      `path reaches it: shipped config-BFS ${s.reachedByBfs ? 'YES' : 'no'}, probe flood ${s.probeReach ? 'yes' : 'no'}` +
      (s.exposurePastAtPad !== undefined ? `  clearance at the pad anchor: past ${s.exposurePastAtPad} m${s.exposurePastAtPad > 0 ? ' = open drivable space, no collider under the hull ring there' : ' = the anchor is inside a disc'}` : '') +
      (s.rise !== undefined ? `  crystal rise ${s.rise.toFixed(3)} m sink ${s.sink.toFixed(3)} m` : '') +
      (s.discs !== undefined ? `  discs within 8 m: ${s.discs} widest r ${s.widestDiscR}` : ''));
}
say(`  total suspect sites measured: ${suspects.items.length} ` +
    `(${suspects.items.filter(i => i.reachedByBfs).length} reachable under the shipped BFS, ` +
    `${suspects.items.filter(i => i.step.run >= BAND_STEP).length} read as a WALL at BAND_STEP, ` +
    `${suspects.items.filter(i => i.step.exposed > 0).length} with at least one exposed band face in the 3 m window, ` +
    `total exposed faces around the suspects ${suspects.items.reduce((a, i) => a + i.step.exposed, 0)})`);
say('\n═══ DOME FILTER, mesh bbox vs face position ═══');
say(`  shipped (mesh bbox): ${CNT.meshesBboxRejected} meshes skipped; walking their faces anyway puts ${CNT.bandFacesOfBboxRejectedMeshes} of their faces inside the island AND inside the hull band → band faces ${CNT.bandFacesShippedMeshFilter} (bbox) vs ${CNT.bandFaces} (per-face), delta ${CNT.bandFaces - CNT.bandFacesShippedMeshFilter}`);
say(`  per-face filters on the swept meshes: off-island ${CNT.offIslandFaces} · flat (>BAND_NY ${BAND_NY}) ${CNT.flatFaces} · thin (<BAND_STEP ${BAND_STEP}) ${CNT.thinFaces} · outside the RIDE..ROOF band ${CNT.outsideBand}`);
for (const r of out.sweep.perRoot.filter(x => x.bboxRejectedMeshes)) {
  say(`    rejected mesh lives in root ${r.root}: ${r.bboxRejectedBandFaces} band faces on the island`);
}
say(`\n[${sec()}] wrote ${tsvPath} (${lines.length - 1} rows) and ${jsonPath}`);
process.exit(controlsPass ? RC.OK : RC.CONTROL_BLIND);
