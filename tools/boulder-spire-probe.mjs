#!/usr/bin/env node
// Task #118: a chase-camera frame showed a near-black ~4 m column standing on a 0.6 m collision disc.
//
// Three dead ends, all of them enumeration, are why this reads build-time data instead of walking the
// scene: a live name regex `/rock|boulder|scatter/i` matches the starship's `Mesh_rocket_*`; the
// `rock-scatter` group holds ONE mesh because `createRocks` itself calls `mergeInto(group)`; and the
// offline build hits the same merge, since merging is the emitter's business, not the page's. So
// terrain.js now publishes, per accepted stone and off the transform that drew it, `heightM` (top over
// the sand) and `bandReachM` (how far the drawn silhouette reaches inside the rover's own collision
// band, via `stoneMeasurement`), and this file joins those to the discs that stone exported.
//
// The join is the whole question. A band that reaches past its discs is a rock the hull drives through
// (visible, stops nothing); a disc that reaches past the band is an invisible wall; and a stone that is
// tall *and* thin in band is the leaning-tower read — which is a shape problem, not a collider problem,
// because the rover's roof is below its top.
import { buildOfflineWorld } from './offline-world.mjs';

const w = await buildOfflineWorld({ sky: true });
// The shape law is read out of the emitter rather than restated here: a second host for the number
// would go green on the day somebody raises the limit. Imported after the build so the probe runs on
// the same instrumented module graph the world was built from.
const { BOULDER_MAX_SLENDER } = await import('../src/world/terrain.js');
if (!(Number.isFinite(BOULDER_MAX_SLENDER) && BOULDER_MAX_SLENDER > 0)) {
  console.log(`BOULDER_SPIRE_RC=3 BOULDER_MAX_SLENDER not a positive number (got ${BOULDER_MAX_SLENDER})`);
  process.exit(3);
}
const group = w.scene.getObjectByName('rock-scatter');
const stones = group?.userData?.stones;
if (!Array.isArray(stones)) {
  console.log('BOULDER_SPIRE_RC=3 rock-scatter group carries no userData.stones');
  process.exit(3);
}
// Cover-set self-proof: a green over an empty denominator is the failure this file exists to avoid.
const discsByProp = new Map();
for (const c of w.colliders) {
  if (typeof c.prop !== 'string' || !c.prop.startsWith('scatter:rock#')) continue;
  if (!discsByProp.has(c.prop)) discsByProp.set(c.prop, []);
  discsByProp.get(c.prop).push(c);
}
if (stones.length !== discsByProp.size) {
  console.log(`BOULDER_SPIRE_RC=3 records ${stones.length} != grouped discs ${discsByProp.size}`);
  process.exit(3);
}

const rows = stones.map(s => {
  const ds = discsByProp.get(s.prop) || [];
  // A disc protects the hull out to (its centre's distance from the stone's centre) + its own radius.
  let shield = 0;
  for (const d of ds) shield = Math.max(shield, Math.hypot(d.x - s.x, d.z - s.z) + d.r);
  return { ...s, n: ds.length, shield: +shield.toFixed(2),
    phantom: +(s.bandReachM - shield).toFixed(2),
    slenderness: s.bandReachM > 0.01 ? +(s.heightM / s.bandReachM).toFixed(2) : null };
});

console.log(`BOULDERS ${rows.length} · discs ${discsByProp.size ? rows.reduce((a, r) => a + r.n, 0) : 0} · anchor=rock-scatter userData.stones`);
for (const r of rows.slice().sort((a, b) => b.phantom - a.phantom)) console.log(
  `  ${r.prop.padEnd(18)} ${String(r.x).padStart(7)},${String(r.z).padStart(7)}  ${r.name.padEnd(7)}` +
  ` h ${String(r.heightM).padStart(5)}  band ${String(r.bandReachM).padStart(5)}  reach ${String(r.reachM).padStart(5)}` +
  `  discs ${String(r.n).padStart(2)} shield ${String(r.shield).padStart(5)}  phantom ${String(r.phantom).padStart(6)}` +
  `  slender ${String(r.slenderness).padStart(6)}`);
const phantom = rows.filter(r => r.phantom > 0.2);
const spires = rows.filter(r => r.slenderness !== null && r.slenderness > BOULDER_MAX_SLENDER);
const thin = rows.filter(r => r.slenderness === null && r.heightM > 1);
console.log(`PHANTOM_BAND ${phantom.length} · SPIRE_OVER_${BOULDER_MAX_SLENDER}x ${spires.length} · TALL_NO_BAND ${thin.length}`);
// Witness that the clamp branch is reached by real products, not only by an injected one: the emitter
// records every stone it had to slump. Zero here would mean the law above has no effect on the shipped
// scatter, and a green ruler over a branch nothing walks is decoration.
const slump = group.userData.slumped || [];
console.log(`SLUMPED ${slump.length}`);
for (const s of slump) console.log(`  ${String(s.x).padStart(7)},${String(s.z).padStart(7)} ${s.name.padEnd(7)} ${s.from} -> ${s.to}`);
console.log(`  tallest ${Math.max(...rows.map(r => r.heightM))} m · worst slenderness ${Math.max(...rows.map(r => r.slenderness ?? -9))}`);
const rc = phantom.length || spires.length || thin.length ? 1 : 0;
console.log(`BOULDER_SPIRE_RC=${rc}`);
process.exit(rc);
