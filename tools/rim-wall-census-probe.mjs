#!/usr/bin/env node
// ─── #56 rim-wall census — pure-node diagnosis of the island's outer containment ───
//
// Every number here is produced by this file reading shipped code, in the manner of
// tools/scan-triples.mjs. No browser, no state-mutating git, nothing under src/ touched.
//
// Instruments it borrows (verbatim, not re-invented):
//   * BODY_R / RIDE / ROOF            — imported from src/vehicle/physics.js:12-29.
//   * TURN = 2.9/tan(0.60)            — src/main.js:4747 (WHEELBASE/lock from physics.js:137-140,144).
//   * the shipped exit test           — the pocket census of scan(): standable ground (slack >= 0)
//     flooded 4-connected, component exitable iff it touches the census-box edge or holds a pivot
//     cell (slack >= TURN); EC = 0.5, bbox padded TURN + 6 (src/main.js:5071-5120, and the rule as
//     restated in tools/scan-triples.mjs:26-46).
//   * sealCheck(discs)                — src/world/plan.js:360-403, the ring-seal test props.js:3311
//     runs on `rim:border`.
//   * the disc dump                   — tools/logs/census-work.txt (`id x z r kind` per line, the
//     format tools/scan-triples.mjs:81-90 parses), captured from the built map on 2026-09-26.
//   * GLB triangle counts             — read off the accessors in node, same chunk walk as
//     tools/cc0-conform.mjs:64-96.
//
// Outputs:
//   tools/logs/rim-wall-census-2026-09-27.tsv  — per-bearing census at the band centre circle
//   stdout                                     — gap table, exit-test verdicts, tri counts.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Matrix4, Vector3, Quaternion, Euler } from 'three';

import { RIM, ISLAND, TERRAIN, START } from '../src/config.js';
import { heightAt, surfaceSlope } from '../src/world/height.js';
import { sealCheck } from '../src/world/plan.js';
import { RIM_ROCK } from '../src/world/rim_rock.js';
import { BODY_R, RIDE, ROOF } from '../src/vehicle/physics.js';
import { mulberry32 } from '../src/utils/noise.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const TURN = 2.9 / Math.tan(0.60);            // 4.843 m
const PAD = TURN + 6;                          // main.js:5106-ish bbox growth (scan-triples:70-73)
const TAU = Math.PI * 2;

// ─── 1. disc sets ────────────────────────────────────────────────────────────────────────
function loadCensus(p) {                                        // scan-triples.mjs:81-90 verbatim
  const raw = fs.readFileSync(p, 'utf8');
  const nl = raw.indexOf('\n');
  if (!raw.slice(0, nl < 0 ? raw.length : nl).startsWith('READY')) throw new Error('bad census head');
  const body = nl < 0 ? raw : raw.slice(nl + 1).replace(/^RESULT /, '').trim();
  return JSON.parse(nl < 0 ? raw : JSON.parse(body));
}
const CENSUS_FILE = path.join(HERE, 'logs', 'census-work.txt');
const obj = loadCensus(CENSUS_FILE);
const solid = [], floor = [];
for (const line of obj.census) {
  const t = line.trim().split(/\s+/);
  if (t.length !== 5) continue;
  const d = { id: t[0], x: +t[1], z: +t[2], r: +t[3] };
  (t[4] === 'solid' ? solid : floor).push(d);
}
const rimB = solid.filter(d => d.id.startsWith('rim:border'));
const scat = solid.filter(d => d.id.startsWith('scatter:rock'));
const nonRim = solid.filter(d => !d.id.startsWith('rim:border'));

// analytic re-derivation of the border ring straight from the emitter (props.js:683-688 + config.js:41)
const rimDiscsN = Math.ceil((TAU * RIM.discR) / RIM.arc);
const rimGen = [];
for (let k = 0; k < rimDiscsN; k++) {
  const a = (k / rimDiscsN) * TAU;
  rimGen.push({ x: +(Math.cos(a) * RIM.discR).toFixed(2), z: +(Math.sin(a) * RIM.discR).toFixed(2), r: RIM.disc });
}
let ringMaxErr = 0;
if (rimGen.length === rimB.length)
  for (const g of rimGen) {
    let best = Infinity;
    for (const d of rimB) best = Math.min(best, Math.hypot(g.x - d.x, g.z - d.z));
    ringMaxErr = Math.max(ringMaxErr, best);       // nearest-dump-disc match, order-independent
  }

// ─── 2. band-coverage census at r = RIM.face ─────────────────────────────────────────────
// band centre = RIM.face (config.js:44) — the circle the discs stop the hull *skin* at, the circle
// rim_veil.js:90 draws on, and the circle the rescue refuses to park past (main.js:1743).
const BAND_R = RIM.face;
const NB = 3600, DTH = TAU / NB;               // 0.1 deg
const slackTo = (ds, x, z) => {
  let best = Infinity;
  for (const d of ds) {
    const q = Math.hypot(x - d.x, z - d.z) - d.r;  // metres past the disc edge
    if (q < best) best = q;
  }
  return best;
};
const rows = [];
for (let i = 0; i < NB; i++) {
  const th = i * DTH;
  const x = Math.cos(th) * BAND_R, z = Math.sin(th) * BAND_R;
  const sRim = slackTo(rimB, x, z), sScat = slackTo(scat, x, z);
  const sOther = slackTo(nonRim, x, z);
  const sAll = Math.min(sRim, sScat, sOther);
  const hit = s => +(s <= BODY_R).valueOf();
  rows.push({ th, x, z, sRim, sScat, sOther, sAll,
              hRim: hit(sRim), hScat: hit(sScat), hAll: hit(sAll) });
}
// terrain columns, same bearing grid (heightAt — height.js:633 -> rawHeight:347 -> rimWall:280)
const terrainCols = [];
for (let i = 0; i < NB; i += 10) {              // 0.5 deg is finer than the 1.364 m mesh at r>100
  const th = rows[i].th;
  let floorH = Infinity, crestH = -Infinity, crestR = 0;
  for (let r = 100; r <= 150.01; r += 0.25) {
    const h = heightAt(Math.cos(th) * r, Math.sin(th) * r);
    if (r <= 108.001) floorH = Math.min(floorH, h);
    if (h > crestH) { crestH = h; crestR = r; }
  }
  terrainCols.push([rows[i].th, crestR, crestH - floorH]);
}

// contiguous gap runs on a coverage array (true = covered), wrap-around aware: runs of *uncovered*
// entries as {s: start index, n: cells}. Nothing covered at all returns one run of all cells.
function runsOfArr(on) {
  const runs = [];
  let anchor = -1;
  for (let k = 0; k < on.length; k++) if (on[k]) { anchor = k; break; }
  if (anchor < 0) return [{ s: 0, n: on.length }];
  let start = -1, len = 0;
  for (let k = 1; k <= on.length; k++) {
    const idx = (anchor + k) % on.length;
    if (!on[idx]) { if (len === 0) start = idx; len++; }
    else if (len > 0) { runs.push({ s: start, n: len }); len = 0; }
  }
  if (len > 0) runs.push({ s: start, n: len });
  return runs;
}
function uncoveredRuns(flag) { return runsOfArr(rows.map(r => r[flag] === 1)); }
const runsToTable = runs => runs.map(c => ({
  startDeg: +(c.s * 360 / NB).toFixed(2),
  stopDeg: +(((c.s + c.n) % NB) * 360 / NB).toFixed(2),
  cells: c.n, arcM: +(c.n * DTH * BAND_R).toFixed(2),
}));
const gapsAll = runsToTable(uncoveredRuns('hAll'));
const gapsRimOnly = runsToTable(uncoveredRuns('hRim'));
const scatCoverPct = (100 * rows.filter(r => r.hScat).length / NB);
const rimCoverPct = (100 * rows.filter(r => r.hRim).length / NB);
const allCoverPct = (100 * rows.filter(r => r.hAll).length / NB);

// ─── 3. the shipped exit test on the full disc set (main.js pocket-census rule, EC=0.5) ──
function floodComponents(discs, extraSeeds) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const c of discs) {
    x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r);
    z0 = Math.min(z0, c.z - c.r); z1 = Math.max(z1, c.z + c.r);
  }
  const EC = 0.5;
  x0 -= PAD; x1 += PAD; z0 -= PAD; z1 += PAD;
  const NX = Math.ceil((x1 - x0) / EC) + 1, NZ = Math.ceil((z1 - z0) / EC) + 1;
  const B = 32, buckets = new Map(); const bkey = (a, b) => a * 4096 + b;
  let maxR = 0;
  for (const c of discs) {
    maxR = Math.max(maxR, c.r);
    const k = bkey(Math.floor(c.x / B), Math.floor(c.z / B));
    const a2 = buckets.get(k); if (a2) a2.push(c); else buckets.set(k, [c]);
  }
  const slack = new Float32Array(NX * NZ);
  for (let i = 0; i < NX; i++) {
    const x = x0 + i * EC;
    const bi = Math.floor(x / B), reach = Math.ceil((BODY_R + TURN + maxR) / B);
    for (let j = 0; j < NZ; j++) {
      const z = z0 + j * EC; const bj = Math.floor(z / B);
      let best = 99;
      for (let a2 = -reach; a2 <= reach; a2++) for (let b2 = -reach; b2 <= reach; b2++) {
        const list = buckets.get(bkey(bi + a2, bj + b2));
        if (list) for (const c of list) {
          const s = Math.hypot(x - c.x, z - c.z) - c.r - BODY_R;
          if (s < best) best = s;
        }
      }
      slack[i * NZ + j] = best;
    }
  }
  const cid = new Int32Array(NX * NZ).fill(-1);
  const comps = []; const q = new Int32Array(NX * NZ);
  for (let s0 = 0; s0 < slack.length; s0++) {
    if (slack[s0] < 0 || cid[s0] >= 0) continue;
    const id = comps.length; let qh = 0, qt = 0; q[qt++] = s0; cid[s0] = id;
    let pivot = 0, edge = false;
    while (qh < qt) {
      const c = q[qh++]; const i = (c / NZ) | 0, j = c % NZ;
      if (slack[c] >= TURN) pivot++;
      if (i === 0 || j === 0 || i === NX - 1 || j === NZ - 1) edge = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
        const n = ni * NZ + nj;
        if (slack[n] >= 0 && cid[n] < 0) { cid[n] = id; q[qt++] = n; }
      }
    }
    comps.push({ id, cells: qt, pivot, edge, exitable: pivot > 0 || !edge });
  }
  const at = (x, z) => {
    const i = Math.round((x - x0) / EC), j = Math.round((z - z0) / EC);
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return null;
    const c = i * NZ + j;
    if (slack[c] < 0) return 'buried';
    return comps[cid[c]];
  };
  return { comps, at, NX, NZ, EC };
}
const flood = floodComponents(solid);
const seedPoints = {
  spawn: [START.pos[0], START.pos[1]],              // main.js:3640: phys.x=pos[0], phys.z=pos[1]
  inside_at_rim: null,                              // filled below: deepest legal pre-rim stance
  outside_b0: [Math.cos(0) * 125, Math.sin(0) * 125],
  outside_b90: [Math.cos(Math.PI / 2) * 125, Math.sin(Math.PI / 2) * 125],
  outside_b180: [-125, 0],
  outside_b270: [0, -125],
};
{
  let bw = -Infinity, bi = 0;
  rows.forEach((r, i) => { const s = Math.min(r.sRim, r.sScat, r.sOther); if (s > bw) { bw = s; bi = i; } });
  seedPoints.inside_at_rim = [rows[bi].x * (110 / BAND_R), rows[bi].z * (110 / BAND_R)];
}
const seedComp = {};
for (const [k, [x, z]] of Object.entries(seedPoints)) {
  const c = flood.at(x, z);
  seedComp[k] = c === null ? 'outside-grid' : c === 'buried' ? 'buried'
    : { comp: c.id, cells: c.cells, pivot: c.pivot, edge: c.edge, exitable: c.exitable };
}
const trapped = flood.comps.filter(r => r.pivot === 0 && !r.edge && r.cells * 0.5 * 0.5 >= 10);
// ^ the shipped pocket filter, main.js:5120: no-pivot AND off-edge AND >= 10 m^2 of standing room
// (a POI in the pocket reports however small; the rim annulus holds no POI, verified below).

// sealCheck (plan.js:360) on the shipped ring, alone and with the scatter added
const sealBorder = sealCheck(rimB);
const sealBorderScat = sealCheck(rimB.concat(scat));

// ─── 4. replay of the REMOVED rock ring (props.js as of 30862f8^) → does a rock wall seal? ──
function oldRockRing() {
  const rnd = mulberry32(0x0a17);
  const SEQ = ['mega', 'block', 'mega', 'slab'];
  const RING_R = 117.0, BODY = BODY_R, SEAL = 1.5;
  const discs = []; let th = 0, rocks = 0;
  const m = new Matrix4(), v = new Vector3(), ONE = new Vector3(1, 1, 1);
  while (th < TAU - 1e-9 && rocks < 400) {
    const name = SEQ[rocks % SEQ.length], spec = RIM_ROCK[name];
    const ux = Math.cos(th), uz = Math.sin(th);
    const rr = RING_R + (rnd() - 0.5) * 0.6;
    const x = ux * rr, z = uz * rr, e = 2.6;
    const hi = heightAt(x - ux * e, z - uz * e), ho = heightAt(x + ux * e, z + uz * e);
    const ht = heightAt(x - uz * e, z + ux * e), hb = heightAt(x + uz * e, z - ux * e);
    const pitch = Math.atan2(ho - hi, 2 * e), roll = Math.atan2(hb - ht, 2 * e);
    const qy = new Quaternion().setFromEuler(new Euler(0, -th + (rnd() - 0.5) * 0.17, 0));
    const qz = new Quaternion().setFromEuler(new Euler(0, 0, pitch));
    const qx = new Quaternion().setFromEuler(new Euler(roll, 0, 0));
    // three's object.rotateOnAxis PRE-multiplies, so after `rotation.y =` -> rotateZ -> rotateX the
    // composed quaternion is qx * qz * qy. cloneModel is model.clone() (assets.js:239-241) and every
    // rim_rock.glb node is identity TRS, so scale is 1 and the object matrix is exactly (pos, rot).
    const rot = qx.multiply(qz).multiply(qy);
    m.compose(new Vector3(x, heightAt(x, z) - 0.10 - 2.2 * Math.hypot(pitch, roll), z), rot, ONE);
    for (const [dx, dz, r] of spec.discs) {
      v.set(dx, 0, dz).applyMatrix4(m);
      discs.push({ x: +v.x.toFixed(2), z: +v.z.toFixed(2), r, prop: `rim:rampart#${rocks}` });
    }
    // scree's only touch on THIS rng is its `ry` argument — the chips themselves draw from a
    // separate mulberry32(0x5eed) (props.js@30862f8^:396-411), so the ring sequence is untouched.
    rnd();
    th += (spec.reachT + RIM_ROCK[SEQ[(rocks + 1) % SEQ.length]].reachT + 2 * BODY - SEAL) / RING_R;
    rocks++;
  }
  return { discs, rocks };
}
const oldRing = oldRockRing();
const RING_R_REP = 117.0;                        // the replayed wall's own circle
const sealOld = sealCheck(oldRing.discs);
// old-ring hull-band coverage at its own face: same test, band = RING_R - discs... use r = 112 too
// The old wall sat on RING_R=117, i.e. its face is NOT the shipped 112 circle — measuring it at
// r=112 would be apples-to-oranges. Instead walk the exact hull-centre test the radial ray meets:
// centre stops where the ray first enters any disc padded by BODY_R (physics.js:251 `min = c.r + BODY_R`).
const oldStops = new Float64Array(NB).fill(Infinity);
for (let i = 0; i < NB; i++) {
  const th = i * DTH, ux = Math.cos(th), uz = Math.sin(th);
  let best = Infinity;
  for (const c of oldRing.discs) {
    const R = c.r + BODY_R;
    const b = c.x * ux + c.z * uz;
    const dq = b * b - (c.x * c.x + c.z * c.z - R * R);
    if (dq <= 0) continue;
    const t = b - Math.sqrt(dq);
    if (t > 100 && t < best) best = t;
  }
  oldStops[i] = best;
}
const oldBlocked = Array.from(oldStops, t => t <= 124.5);      // blocked somewhere on the ring band
const oldCoverPct = 100 * oldBlocked.filter(Boolean).length / NB;
const oldStopSorted = [...oldStops].sort((a, b) => a - b);
const oldRuns = runsOfArr(oldBlocked);                          // runs of *open* bearings = gaps
// shipped exit test on the replayed ring (+ every non-rim solid from the dump, which never moved):
const oldFlood = floodComponents(oldRing.discs.concat(nonRim));
const oldSpawnC = oldFlood.at(START.pos[0], START.pos[1]);
const oldTrap = oldRuns.map(r => {
  const mid = ((r.s + Math.floor(r.n / 2)) % NB) * DTH;
  const cx = Math.cos(mid), cz = Math.sin(mid);
  const inC = oldFlood.at(cx * 108, cz * 108);      // just inside the ring
  const outC = oldFlood.at(cx * 121.5, cz * 121.5); // just outside it (ring discs reach ~120.4)
  const outward = outC && typeof outC === 'object' ? outC : null;
  return {
    startDeg: +(r.s * 360 / NB).toFixed(2), stopDeg: +(((r.s + r.n) % NB) * 360 / NB).toFixed(2),
    cells: r.n, arcM: +(r.n * DTH * RING_R_REP).toFixed(2),
    comp: outward ? outward.id : String(outC),
    exitable: outward ? outward.exitable : null,
    passable: !!(inC && outward && typeof inC === 'object' && inC === outward),
    trapCapable: !!(outward && outward.pivot === 0 && !outward.edge && outward.cells * 0.25 >= 10),
  };
});
const oldTrappedComps = oldFlood.comps.filter(c => c.pivot === 0 && !c.edge && c.cells * 0.25 >= 10).length;

// ─── 5. GLB triangle counts (cc0-conform.mjs chunk walk, simplified to what #56 needs) ────
function glbTris(file) {
  const g = fs.readFileSync(file);
  if (g.length < 28 || g.readUInt32LE(0) !== 0x46546c67) throw new Error(file + ': not GLB v2');
  const jsonLen = g.readUInt32LE(12);
  const j = JSON.parse(g.subarray(20, 20 + jsonLen).toString('utf8'));
  const out = {}; const acc = {};
  const nodes = j.nodes || [];
  const roots = (j.scenes && j.scenes.length) ? j.scenes[0].nodes : nodes.map((_, i) => i);
  function primTris(p) {
    return p.mode === undefined || p.mode === 4
      ? Math.floor((p.indices !== undefined ? j.accessors[p.indices].count
        : j.accessors[p.attributes.POSITION].count) / 3) : 0;
  }
  function walk(n, prefix) {
    const nm = n.name || prefix;
    if (n.mesh !== undefined) {
      const t = j.meshes[n.mesh].primitives.reduce((s, p) => s + primTris(p), 0);
      out[nm] = (out[nm] || 0) + t;
    }
    for (const c of n.children || []) walk(nodes[c], nm);
  }
  for (const r of roots) walk(nodes[r], 'root');
  out.__total__ = Object.values(out).reduce((a, b) => a + b, 0);
  out.__bytes__ = g.length;
  return out;
}
const rimRockTris = glbTris(path.join(HERE, '..', 'public', 'assets', 'rim_rock.glb'));
const hazardTris = glbTris(path.join(HERE, '..', 'public', 'assets', 'hazard_sign.glb'));

// scatter instance census off the dump
const scatStones = new Set(scat.map(d => d.id));
const scatRad = scat.map(d => Math.hypot(d.x, d.z));
const scatOuter = scat.map(d => Math.hypot(d.x, d.z) + d.r);
const boardIds = new Set(solid.filter(d => d.id.startsWith('rim:rim-board')).map(d => d.id.replace(/#\d+$/, '')));

// replacement-budget arithmetic for option (a): N stones at pitch p over 2π·RIM.discR
const ringCirc = TAU * RIM.discR;
const bagAvg = ['cobble','cobble','cobble','cobble','slab','slab','ledge','block','block','block','shard','shard','shard','mega','mega'];
const avgBagTris = bagAvg.reduce((s, n) => s + (rimRockTris[n] || 0), 0) / bagAvg.length;

// ─── report ──────────────────────────────────────────────────────────────────────────────
const L = [];
const P = (...a) => L.push(a.join(' '));
P('#56 rim-wall census — generated by tools/rim-wall-census-probe.mjs on 2026-09-27');
P(`constants: BODY_R=${BODY_R} RIDE=${RIDE} ROOF=${ROOF} (physics.js:12-29), TURN=${TURN.toFixed(3)} (main.js:4747)`);
P(`census: ${CENSUS_FILE} (shipped-map disc dump, 2026-09-26) — ${solid.length} solid + ${floor.length} floor discs`);
P(`rim:border discs in dump: ${rimB.length}; analytic re-derivation (props.js:683-688, config.js:41-45): ${rimGen.length}, max centre disagreement ${ringMaxErr.toFixed(3)} m`);
P(`scatter:rock: ${scatStones.size} stones / ${scat.length} discs; centres r ${Math.min(...scatRad).toFixed(2)}..${Math.max(...scatRad).toFixed(2)} m;`);
P(`  drawn-body reach incl. disc radius: max ${Math.max(...scatOuter).toFixed(2)} m — band circle is r=${BAND_R} (config.js:44)`);
P('');
P('── 1. where the rim is (heightAt, i.e. rawHeight/rimWall: height.js:280-343,633) ──');
const cr = terrainCols.map(t => t[1]), ch = terrainCols.map(t => t[2]);
P(`crest radius over bearing: ${Math.min(...cr).toFixed(1)} .. ${Math.max(...cr).toFixed(1)} m (median ${cr.slice().sort((a,b)=>a-b)[cr.length>>1].toFixed(1)})`);
P(`wall height (crest above lowest ground r 100..108, the rimWall section definition height.js:260-264):`);
P(`  ${Math.min(...ch).toFixed(2)} .. ${Math.max(...ch).toFixed(2)} m, median ${ch.slice().sort((a,b)=>a-b)[ch.length>>1].toFixed(2)} m`);
P(`containment circle: hull SKIN stops at r=${BAND_R} on every bearing (disc ring is circular; the wall height is not)`);
P(`hull CENTRE stops at ${(BAND_R - BODY_R).toFixed(1)} m (physics.js:251 pads each disc by BODY_R; height.js:296 states 110.4)`);
P('');
P('── 2. band coverage (circle r=112.0 m, 0.1 deg = 3600 bearings; covered = disc within BODY_R) ──');
P(`rim:border covers ${rimCoverPct.toFixed(1)} % of bearings; scatter:rock covers ${scatCoverPct.toFixed(1)} %; all-discs ${allCoverPct.toFixed(1)} %`);
P(`contiguous gaps on the COMBINED ring (hull-enterable test > ${(2 * BODY_R).toFixed(1)} m arc): ${gapsAll.length}`);
for (const g of gapsAll) P(`  gap ${g.startDeg}..${g.stopDeg} deg, arc ${g.arcM} m, ${g.arcM > 2 * BODY_R ? 'WIDER' : 'narrower'} than 2*BODY_R`);
P(`rim-only gap runs: ${gapsRimOnly.length}`);
P('exit test (shipped pocket-census rule verbatim, EC=0.5, main.js:5071-5120 / scan-triples.mjs:26-46):');
P(`  components of free ground: ${flood.comps.length}; trapped (pivot==0 && !edge): ${trapped.length};`);
for (const [k, v2] of Object.entries(seedComp)) P(`  seed ${k} @(${seedPoints[k].map(n=>n.toFixed(1)).join(',')}) -> ${typeof v2 === 'string' ? v2 : `comp#${v2.comp} cells=${v2.cells} pivot=${v2.pivot} edge=${v2.edge} exitable=${v2.exitable}`}`);
P(`  inside_at_rim and every outside_* seed share NO component: ${(() => {
  const ids = Object.values(seedComp).filter(v3 => typeof v3 === 'object').map(v3 => v3.comp);
  const spawn = seedComp.spawn.comp, out = new Set(ids.filter(i => i !== spawn));
  return out.size === 0 ? 'n/a (no outside components found)' : `spawn comp ${spawn}; outside seeds land in ${[...out].join(',')}`;
})()}`);
P(`sealCheck (plan.js:360-403) rim:border alone: ${JSON.stringify(sealBorder)}; +scatter: ${JSON.stringify(sealBorderScat)}`);
P('');
P('── 2b. the premise rock wall, replayed from the removed emitter (props.js @ 30862f8^) ──');
P(`replay: ${oldRing.rocks} clasts SEQ[mega,block,mega,slab] on RING_R=117, ${oldRing.discs.length} discs carried through the clone matrix (pos+rot, kit nodes are identity TRS)`);
P(`sealCheck on the replayed rock ring: ${JSON.stringify(sealOld)}`);
P(`hull-centre radial stop over the wall: blocked on ${(oldCoverPct).toFixed(1)} % of 3600 bearings; stop radius ${oldStopSorted[0].toFixed(2)} .. ${oldStopSorted[NB - 1] === Infinity ? 'INF' : oldStopSorted.filter(t => t <= 124.5).pop().toFixed(2)} m (median ${oldStopSorted[NB >> 1].toFixed(2)}); open-bearing gap runs: ${oldTrap.length}; >=10 m^2 trapped comps in replay flood: ${oldTrappedComps}`);
for (const g of oldTrap.slice(0, 12)) P(`  gap ${g.startDeg}..${g.stopDeg} deg arc ${g.arcM} m: outward comp ${g.comp} exitable=${g.exitable} passable=${g.passable} trapCapable=${g.trapCapable}`);
P('');
P('── 3. the double cost ──');
P(`rim_rock.glb per-node triangles (${rimRockTris.__bytes__} bytes): ${Object.entries(rimRockTris).filter(([k])=>k!=='__total__'&&k!=='__bytes__').map(([k,v3])=>`${k}=${v3}`).join(', ')}; kit total=${rimRockTris.__total__}`);
P(`hazard_sign.glb triangles: ${hazardTris.__total__}`);
P(`currently drawn at the rim: ${rimB.length} invisible discs (props.js:684-688, 0 triangles) + ${boardIds.size} boards (props.js:3292-3305)`);
P(`scatter boulders: ${scatStones.size} instances; measured frame cost terrain.js:1171-1176: 46 980 tris drawn + 46 980 shadow = 93 960 of 2 055 529 (2.29 % drawn / 4.57 % of all triangles), 2 of 1 556 draw calls`);
P(`ring circumference at discR: ${ringCirc.toFixed(1)} m; every clast in rim_rock.glb is 1566 tris (measured above), so kit-average over terrain.js:1045 BAG = ${avgBagTris.toFixed(0)};`);
P(`  replayed wall pitch: 2π·117 / ${oldRing.rocks} clasts = ${(TAU * RING_R_REP / oldRing.rocks).toFixed(2)} m; same pitch on the 115.6 m circle = ${Math.floor(ringCirc / (TAU * RING_R_REP / oldRing.rocks))} stones;`);
P(`  budget check: ${oldRing.rocks} stones x ${avgBagTris.toFixed(0)} tris = ${(oldRing.rocks * avgBagTris / 1000).toFixed(1)}k tris drawn + same again in shadow (vs scatter's measured 47.0k/94.0k, terrain.js:1171-1176)`);
P('');
P('── 4. does terrain slope feed the collision? ──');
P('no. step() integrates x,z with velocity alone (physics.js:184-187); the ground is applied AFTER,');
P('as a height the hull is locked to (physics.js:190-206: groundY=platformAt, hard clamp y>=groundH),');
P('slope enters only as a gravity projection (physics.js:171-179) and a visual limb tilt clamped at');
P('0.40 rad (physics.js:228-232); the only positional blockers iterated are collider discs (physics.js:246-257)');
P('plus the r=1180 clamp (physics.js:273-274). Standing-start climb test: throttle 10.5 (physics.js:113),');
P(`gravity term max G*0.85 = ${(3.71 * 0.85).toFixed(3)} m/s^2 (physics.js:3,178) < 10.5 for ANY slope -> no slope stops the rover;`);
P('a slope-only rampart is therefore NOT a barrier. A slope can only make the far side unrecoverable,');
P('which is exactly A5 (git 67ec15a/30862f8 notes: 62-67 deg face, no driving out).');
P('');
P(`option (a) seal pitch: replay of old ring seals per sealCheck=${JSON.stringify(sealOld)} at ${oldRing.rocks} clasts (~pitch ${(ringCirc / oldRing.rocks).toFixed(2)} m).`);
fs.writeFileSync(path.join(HERE, 'logs', 'rim-wall-probe-report-2026-09-27.txt'), L.join('\n') + '\n');
process.stdout.write(L.join('\n') + '\n');

// per-bearing TSV
const tsv = ['bearing_deg\tx_m\tz_m\tslack_rim_border_m\thit_rim_border\tslack_scatter_rock_m\thit_scatter_rock\t'
  + 'slack_other_solids_m\thit_any_solid\tslack_all_discs_m\thit_band\tcrest_r_m\twall_h_m'];
for (let i = 0; i < NB; i++) {
  const r = rows[i];
  const tc = terrainCols[Math.floor(i / 10)] || terrainCols[terrainCols.length - 1];
  tsv.push([(i * 360 / NB).toFixed(1), r.x.toFixed(2), r.z.toFixed(2), r.sRim.toFixed(3), r.hRim,
    r.sScat.toFixed(3), r.hScat, r.sOther.toFixed(3), Math.min(r.sOther, r.sScat, r.sRim) <= BODY_R ? 1 : 0,
    r.sAll.toFixed(3), r.hAll, tc[1].toFixed(2), tc[2].toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(HERE, 'logs', 'rim-wall-census-2026-09-27.tsv'), tsv.join('\n') + '\n');
