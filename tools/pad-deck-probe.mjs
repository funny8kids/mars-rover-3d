#!/usr/bin/env node
// ─── pad-deck probe (#93): does the height a wheel is told to stand at equal the height of the
//     plate the player sees, at every teleport pad on the map?
//
// Why this file exists. The fix for #93 is in the shipped code (`PAD_DECK_Z` seats a pad into its own
// footing at `−0.30·s`, props.js:377-397, and `sealsPad` now knows which pad a wall belongs to,
// props.js:3407-3408), and the two numbers it was supposed to move have moved — the live audit of
// 2026-09-27 reads `driveThroughCells: 0` and `refused.pad: 0` (tools/logs/disc-audit-2026-09-27-live.txt).
// The third criterion in the task ("坪盘顶 stand == 盘顶") had been measured by a scratch script under
// /tmp that no longer exists, so the claim had no reproducible ruler behind it. This is that ruler,
// reading the shipped emitters.
//
// What it measures, per pad:
//   drawn   the top of the drivable plateau — the highest vertex of the pad's `deck` mesh strictly
//           inside the lathe's own edge ((DECK_R − 0.05)·s), because the 6 cm kerb ring lives in the
//           same mesh and is not what a wheel rests on
//   ground  surfaceAt(x,z) — the analytic surface the hull is locked to (height.js)
//   stand   platformAt(colliders,x,z) over the wheel-ring radii — what physics.js:190 puts the hull on
// and judges max |drawn − ground| and |drawn − stand| against TOL. Everything else the pad wears is
// printed rather than folded into the verdict: the kerb ring above the plateau, the emitter teeth and
// their glow ring, the marking decal's plane, the hardware beyond r 2.3.
//
// Run of 2026-09-27 (tools/logs/pad-deck-2026-09-27.txt), the verdict this file exists to keep:
//   7/7 pads |Δ plateau−surfaceAt| ≤ 0.000 m and |Δ plateau−stand| ≤ 0.000 m · PAD_DECK_AGREE · rc 0
//   kerb ring +0.060…0.075 m (= the authored 0.06 × s), teeth glow +0.130…0.143 m, marking +0.066…0.082 m,
//   all far under the 0.46 m ride height — which is why #90's exposure ruler reads EXPOSED 0 at every pad
//   control: lifting pad0 by 0.30 m moved both deltas by exactly 0.300 m → FIRED
//
// Two identifications the file has to get right, and how it proves them:
//   * a pad is named by `userData.rsbScope = padN` (putDeck, props.js:404-405), not by Object3D.name;
//   * every pad also wears one flat marking decal built from a geometry SHARED between the pads
//     (padMarkGeo, props.js:411-417). Counting geometry reuse across the whole scene separates the two
//     and prints the counts, so a reader can see what was dropped instead of trusting a filter.
//
// It carries its own positive control (#90's rule: a gate that cannot go red is decoration). One pad
// is lifted by 0.30 m — the order of magnitude the pre-fix defect measured (the plate read 0.28-0.37 m
// above the stand line, props.js:385-395) — and the ruler must call that pad out. Green with the pad in
// the air prints CONTROL_BLIND and exits 2. An empty pad set is a named failure too, never a pass.
//
// Exit codes: 0 every pad agrees within TOL · 1 at least one pad disagrees · 2 the control stayed
// green (the ruler is blind) · 3 the denominator is empty.
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { buildOfflineWorld } from './offline-world.mjs';
import { surfaceAt, heightAt } from '../src/world/height.js';
import { platformAt } from '../src/vehicle/physics.js';

const TOL = 0.02;          // metres; a wheel cannot see 2 cm
const DECK_R = 1.9;        // the asset lathes its drivable plateau out to r 0 → 1.90, then steps up
const RADII = [0, 1.2, 2.05, 2.6, 3.4];
const t0 = performance.now();
const say = (...a) => console.log(...a);

const { scene, base, colliders } = await buildOfflineWorld({ stones: false });
scene.updateMatrixWorld(true);

// A pad clone is the object putDeck stamps with `userData.rsbScope = padN` (props.js:404). Its marking
// decal is NOT under it — putDeck adds that to the island group directly (props.js:411-417) — so the
// deck band is read off the clone alone and the decal is looked for beside it by placement, printing
// how many were found rather than assuming.
const pads = [];
const _v = new THREE.Vector3();
scene.traverse(o => {
  const scope = o.userData?.rsbScope;
  if (typeof scope !== 'string' || !/^pad\d+$/.test(scope)) return;
  if (pads.find(p => p.scope === scope)) return;
  const mesh = [];
  o.traverse(c => { if (c.isMesh && c.geometry?.attributes?.position?.count) mesh.push(c); });
  pads.push({ scope, root: o, mesh, mark: null });
});
let marks = 0;
for (const p of pads) {
  const sibs = p.root.parent?.children || [];
  p.mark = sibs.find(c => c.isMesh && Math.abs((c.rotation?.x || 0) + Math.PI / 2) < 0.02 &&
    Math.hypot(c.position.x - p.root.position.x, c.position.z - p.root.position.z) < 0.05) || null;
  if (p.mark) marks++;
  p.lot = (base.lots || []).find(l => typeof l.id === 'string' && l.id.endsWith(`:${p.scope}`)) || null;
}
const byPos = (x, z) => pads.find(p => Math.hypot(p.root.position.x - x, p.root.position.z - z) < 1) || null;
say(`[${((performance.now() - t0) / 1000).toFixed(1)}s] pad roots ${pads.length} · teleports in the ledger ` +
  `${base.teleports.length} · marking decals found beside them ${marks} · meshes per pad ` +
  `${pads.map(p => p.mesh.length).join('/')} · colliders ${colliders.length}`);
if (!pads.length || !base.teleports.length) { say('PAD_DECK_NO_OBJECTS'); process.exit(3); }

function deckTop(x, z) {
  const p = byPos(x, z);
  if (!p) return null;
  // Per-mesh maxima, so the verdict can be taken from the surface a wheel actually touches (the lathed
  // `deck`) while the rim hardware — the step ring, the 16 emitter teeth, their glow — is reported next
  // to it instead of being silently folded in. The first version of this file judged "the tallest vertex
  // within r ≤ 1.90", which on six of the seven pads is a tooth, not the plate: those six disagreed by
  // +0.027 to +0.257 m for that reason alone, and the disagreement was the instrument's, not the map's.
  const per = [];
  for (const m of p.mesh) {
    m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position;
    const s = p.root.scale.x;
    let top = -1e9, topR = 0, plat = -1e9, ring = -1e9;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const r = Math.hypot(_v.x - x, _v.z - z);
      if (r > 4.2) continue;
      if (_v.y > top) { top = _v.y; topR = r; }
      // The asset lathes the drivable plateau out to r 1.90 and then steps UP to the 6 cm kerb ring,
      // all in one mesh. So the plateau has to be read strictly inside the lathe's own edge, scaled by
      // the pad's own s — a fixed metre band catches the ring on every pad but the largest, and the
      // ring is not what a wheel rests on.
      if (/^deck\b/i.test(m.name)) { if (r < (DECK_R - 0.05) * s) plat = Math.max(plat, _v.y); else ring = Math.max(ring, _v.y); }
    }
    if (top > -1e8) per.push({ name: m.name || 'mesh', top, topR, plat, ring });
  }
  const decks = per.filter(o => /^deck\b/i.test(o.name));
  if (!decks.length) return { missing: `no deck mesh among ${per.map(o => o.name).join('/')}` };
  const deck = Math.max(...decks.map(o => o.plat));
  const ring = Math.max(...decks.map(o => o.ring));
  if (deck < -1e8) return { missing: 'deck mesh has no vertex inside 1.85·s (the plateau is not drawn)' };
  const rim = per.filter(o => !/^deck\b/i.test(o.name) && o.topR <= 2.3)
    .sort((a, b) => b.top - a.top)[0] || null;
  let mark = -1e9;
  if (p.mark) {
    p.mark.updateWorldMatrix(true, false);
    const pos = p.mark.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(p.mark.matrixWorld);
      mark = Math.max(mark, _v.y);
    }
  }
  const kerb = Math.max(-1e9, ...per.filter(o => o.topR > 2.3).map(o => o.top));
  return { deck, ring, kerb, mark, rim, meshes: per.length, deckMesh: decks.map(o => o.name).join('+'),
    rootY: p.root.position.y, s: p.root.scale.x, scope: p.scope, lot: p.lot };
}
function probe(x, z) {
  const b = deckTop(x, z);
  if (!b || b.deck < -1e8) return null;
  const rows = RADII.map(r => ({ r, ground: surfaceAt(x, z - r), plat: platformAt(colliders, x, z - r) }));
  const stand = Math.max(...rows.map(o => o.plat));
  return { ...b, stand, dGround: b.deck - surfaceAt(x, z), dPlat: b.deck - stand,
    spread: rows.map(o => Math.abs(o.plat - o.ground)).reduce((a, v) => Math.max(a, v), 0) };
}

let worst = 0, bad = 0;
for (const tp of base.teleports) {
  const p = probe(tp.x, tp.z);
  if (!p) { bad++; say(`  pad ${tp.key.padEnd(9)} @${tp.x.toFixed(1)},${tp.z.toFixed(1)}  NO DRAWN GEOMETRY`); continue; }
  if (p.missing) { bad++; say(`  pad ${tp.key.padEnd(9)} @${tp.x.toFixed(1)},${tp.z.toFixed(1)}  ${p.missing}`); continue; }
  const delta = Math.max(Math.abs(p.dGround), Math.abs(p.dPlat));
  const ok = delta <= TOL;
  if (!ok) bad++;
  worst = Math.max(worst, delta);
  say(`  pad ${tp.key.padEnd(9)} @${tp.x.toFixed(1)},${tp.z.toFixed(1)} ${p.scope} ` +
    `drawn deck top ${p.deck.toFixed(3)} (${p.deckMesh}) · surfaceAt(centre) ${(p.deck - p.dGround).toFixed(3)} · ` +
    `stand(platform, r≤${Math.max(...RADII)}) ${p.stand.toFixed(3)} · ` +
    `Δ drawn−ground ${p.dGround >= 0 ? '+' : ''}${p.dGround.toFixed(3)} · ` +
    `Δ drawn−stand ${p.dPlat >= 0 ? '+' : ''}${p.dPlat.toFixed(3)} · kerb ring above plateau ` +
    `${(p.ring - p.deck).toFixed(3)}\n` +
    `      pose root.y ${p.rootY.toFixed(3)} ×s ${p.s.toFixed(2)} → deck should read ` +
    `${(p.rootY + 0.30 * p.s).toFixed(3)} · tallest rim inside r 2.3: ` +
    `${p.rim ? `${p.rim.name} +${(p.rim.top - p.deck).toFixed(3)} m at r ${p.rim.topR.toFixed(2)}` : 'none'} · ` +
    `marking ${(p.mark - p.deck).toFixed(3)} m · rim hardware beyond r 2.3 ` +
    `${p.kerb > -1e8 ? `+${(p.kerb - p.deck).toFixed(3)} m` : '—'} (${p.meshes} meshes, bar ${TOL}, ride height 0.46)`);
  if (!ok) say(`      → MISMATCH`);
}

// ─── the control: lift one pad out of its footing and demand the ruler notice ───
const victim = base.teleports[0];
const vp = byPos(victim.x, victim.z);
const before = probe(victim.x, victim.z);
vp.root.position.y += 0.30;
const after = probe(victim.x, victim.z);
vp.root.position.y -= 0.30;                 // undo, so the next reader sees the world this one measured
// The control asks whether the ruler MOVES when a pad is put in the air, not whether the baseline
// passes: a gate that requires `before` to be clean would report "blind" for a pad that is genuinely
// mismatched, which is the opposite of what a positive control is for.
const caught = Math.abs(after.dGround - before.dGround) > 0.25 && Math.abs(after.dPlat - before.dPlat) > 0.25;
say(`  control · ${victim.key} (${vp.scope}) lifted +0.30 m: Δ drawn−ground ${before.dGround.toFixed(3)} ` +
  `→ ${after.dGround.toFixed(3)} (response ${(after.dGround - before.dGround).toFixed(3)} m, want > 0.25)` +
  ` · Δ drawn−stand ${before.dPlat.toFixed(3)} → ${after.dPlat.toFixed(3)}  → ${caught ? 'FIRED' : 'DOES NOT RESPOND'}`);

say(`[${((performance.now() - t0) / 1000).toFixed(1)}s] pads ${base.teleports.length} · mismatch ${bad} · ` +
  `worst |Δ| ${worst.toFixed(3)} m · bar ${TOL} m`);
if (!caught) { say('PAD_DECK_CONTROL_BLIND'); process.exit(2); }
if (bad) { say('PAD_DECK_MISMATCH'); process.exit(1); }
say('PAD_DECK_AGREE'); process.exit(0);
