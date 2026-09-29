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
// TAPER LAW. The anchor is a right cone, not an adjective: r(y) = R (1 - y/H) is 1 R wide at 0.5 H and
// 0.3 R at 0.85 H, so any stone that keeps at least 30 % of its waist by its shoulder is no thinner
// there than a cone. Real boulders are blunter than cones, which makes the constant a floor with room
// under it rather than a line the shipped scatter sits on. This one stays on the ruler's side of the
// fence, unlike BOULDER_MAX_SLENDER: the emitter clamps that (squashes the stone before tiling discs),
// while this judges the authored archetype, so a refusal here means someone thinned `shard` in the kit
// and the fix is in the model, not in a runtime squash. `TAPER_MIN_HEIGHT` bounds the covered set from
// below because a 0.78 m slab has no shoulder in the picture to taper -- its top width is a 0.00
// measurement artifact, and a law that rejected it would be a law about vertex counts.
const TAPER_MIN = 0.3;
const TAPER_MIN_HEIGHT = 1;
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
    slenderness: s.bandReachM > 0.01 ? +(s.heightM / s.bandReachM).toFixed(2) : null,
    midEye: s.midWidthM > 0.01 ? +(s.heightM / s.midWidthM).toFixed(2) : null,
    topEye: s.topWidthM > 0.01 ? +(s.heightM / s.topWidthM).toFixed(2) : null };
});
// The eye columns have their own denominator check: a missing width field would make every ratio null
// and the distribution below would print an honest-looking empty set over a record the emitter stopped
// publishing.
for (const k of ['midWidthM', 'topWidthM', 'midChords', 'topChords', 'eyeHiM', 'eyeLoM']) {
  if (rows.some(r => r[k] === undefined)) {
    console.log(`BOULDER_SPIRE_RC=3 records carry no ${k} (emitter stopped publishing the eye width)`);
    process.exit(3);
  }
}

console.log(`BOULDERS ${rows.length} · discs ${discsByProp.size ? rows.reduce((a, r) => a + r.n, 0) : 0} · anchor=rock-scatter userData.stones`);
for (const r of rows.slice().sort((a, b) => b.phantom - a.phantom)) console.log(
  `  ${r.prop.padEnd(18)} ${String(r.x).padStart(7)},${String(r.z).padStart(7)}  ${r.name.padEnd(7)}` +
  ` h ${String(r.heightM).padStart(5)}  band ${String(r.bandReachM).padStart(5)}  reach ${String(r.reachM).padStart(5)}` +
  `  discs ${String(r.n).padStart(2)} shield ${String(r.shield).padStart(5)}  phantom ${String(r.phantom).padStart(6)}` +
  `  slender ${String(r.slenderness).padStart(6)}` +
  `  midW ${String(r.midWidthM).padStart(5)}  topW ${String(r.topWidthM).padStart(5)}` +
  `  midEye ${String(r.midEye).padStart(6)}  topEye ${String(r.topEye).padStart(6)}`);
const phantom = rows.filter(r => r.phantom > 0.2);
const spires = rows.filter(r => r.slenderness !== null && r.slenderness > BOULDER_MAX_SLENDER);
const thin = rows.filter(r => r.slenderness === null && r.heightM > 1);
console.log(`PHANTOM_BAND ${phantom.length} · SPIRE_OVER_${BOULDER_MAX_SLENDER}x ${spires.length} · TALL_NO_BAND ${thin.length}`);
// Two objects, not comparable to each other: `slender` divides height by the *radius* of the hull's
// band, `midEye`/`topEye` divide it by the *diameter* of the silhouette at half height and at 85 %
// height. #118's residual claimed the eye was stricter than the law; measured on the shipped scatter
// that is false at mid height (worst 2.41, none over 3), so the column that still carries the word
// "尖" is the one near the top — taper, not overall slenderness. Gated below.
const byName = {};
for (const r of rows) (byName[r.name] ||= []).push(r);
console.log(`EYE_WIDTHS height/silhouette-diameter · mid distribution only, top gated as TAPER`);
const med = a => a.length ? a[Math.floor((a.length - 1) / 2)] : null;
for (const [name, rs] of Object.entries(byName)) {
  const m = rs.map(r => r.midEye).filter(v => v !== null).sort((a, b) => a - b);
  const t = rs.map(r => r.topEye).filter(v => v !== null).sort((a, b) => a - b);
  console.log(`  ${name.padEnd(7)} n ${String(rs.length).padStart(2)}` +
    `  mid ${String(m[0] ?? '-').padStart(5)}/${String(med(m) ?? '-').padStart(5)}/${String(m[m.length - 1] ?? '-').padStart(5)}` +
    `  top ${String(t[0] ?? '-').padStart(5)}/${String(med(t) ?? '-').padStart(5)}/${String(t[t.length - 1] ?? '-').padStart(5)}` +
    `  (min/med/max)  tallest h ${Math.max(...rs.map(r => r.heightM))} m`);
}
const mid = rows.map(r => r.midEye).filter(v => v !== null);
const top = rows.map(r => r.topEye).filter(v => v !== null);
console.log(`  worst mid ${Math.max(...mid)} · worst top ${Math.max(...top)}` +
  ` · cone reference at worst-mid: a stone as wide at 0.85 h as a cone is top ${TAPER_MIN} x mid`);

// TAPER: `topWidthM / midWidthM` against the cone floor. See the law's own comment above the rows.
const taperOf = r => r.midWidthM > 0.01 ? +(r.topWidthM / r.midWidthM).toFixed(3) : null;
// The gate is one function, and the controls below call *it* rather than a restatement: a second copy
// of the comparison would keep passing after somebody edited the one the shipped scatter runs through.
const taperViolations = list => list.filter(r => r.heightM >= TAPER_MIN_HEIGHT &&
  taperOf(r) !== null && taperOf(r) < TAPER_MIN);
// The covered set is bounded on `eyeHiM`, the height the mesh's own vertices reach, not on `heightM`:
// the law judges the picture, so the picture's height is the one that decides whether there is a
// shoulder in it at all. The two differ (see BOX_VS_MESH below).
const covered = rows.filter(r => r.eyeHiM >= TAPER_MIN_HEIGHT);
// Denominator proof for the covered set: a green `TAPER_OVER_CONE 0` over an empty or unmeasurable
// sample is exactly the reading this file was written to refuse.
if (!covered.length) {
  console.log(`BOULDER_SPIRE_RC=3 TAPER covered set empty (no stone at or above ${TAPER_MIN_HEIGHT} m)`);
  process.exit(3);
}
if (covered.some(r => taperOf(r) === null)) {
  console.log('BOULDER_SPIRE_RC=3 a covered stone has no measurable waist (midWidthM <= 0.01)');
  process.exit(3);
}
// A section plane that hit no triangle at all also reads 0.00 m wide, and that is the emitter's problem
// to report, not a judgement about the stone: refuse before the gate can call a missed plane a needle.
const missed = covered.filter(r => r.midChords < 2 || r.topChords < 2);
if (missed.length) {
  console.log(`BOULDER_SPIRE_RC=3 ${missed.length} covered stone(s) whose section plane found no chord:`);
  for (const r of missed) console.log(`  ${r.prop} ${r.name} h ${r.heightM} shoulder plane ${+(0.85 * r.heightM).toFixed(2)}` +
    ` over sand · mesh vertex span ${r.eyeLoM}..${r.eyeHiM} · mid chords ${r.midChords} · top chords ${r.topChords}`);
  process.exit(3);
}
const taperViol = taperViolations(rows);
// The shipped scatter can only ever supply the pass side, and a gate that has never refused anything is
// indistinguishable from a gate that cannot refuse. So each synthetic record is run through the real
// gate as an addition to the real rows, and the reading is the delta: a needle must add one refusal, a
// cone-at-the-reference and a blunter-than-cone stone must add none, and the short needle must add none
// because the height floor excludes it -- that last one is the witness that the floor branch is walked,
// which is also the branch that keeps a 0.78 m slab from being rejected for vertex counts.
const probe = (label, rec, want) => {
  const got = taperViolations([...rows, rec]).length - taperViol.length;
  return `${label} ${got === want ? `ok(+${got})` : `BROKEN expected +${want} got +${got}`}`;
};
const controls = [
  probe('needle h4 waist1 top0.05', { heightM: 4, midWidthM: 1, topWidthM: 0.05 }, 1),
  probe('at-reference h2 waist1 top0.3', { heightM: 2, midWidthM: 1, topWidthM: TAPER_MIN }, 0),
  probe('under-reference h2 top0.29', { heightM: 2, midWidthM: 1, topWidthM: TAPER_MIN - 0.01 }, 1),
  probe('blunt h2 waist1 top0.9', { heightM: 2, midWidthM: 1, topWidthM: 0.9 }, 0),
  probe('short needle h0.5 top0.01', { heightM: 0.5, midWidthM: 1, topWidthM: 0.01 }, 0)
];
const ctrlDead = controls.some(c => c.includes('BROKEN'));
const tvals = covered.map(taperOf).sort((a, b) => a - b);
console.log(`TAPER top/mid · cone floor ${TAPER_MIN} · covered ${covered.length} of ${rows.length} rows (h >= ${TAPER_MIN_HEIGHT} m)` +
  ` · min ${tvals[0]} med ${med(tvals)} max ${tvals[tvals.length - 1]}`);
// `heightM` is a Box3 measurement, so on a tilted stone the corner box stands proud of the highest vertex
// it encloses -- measured on this scatter 2026-09-29 as the `BOX_VS_MESH` line below. The clamp that
// consumes that number therefore slumps a tilted stone *more* than the drawn shape requires, which is the
// safe direction for a law whose whole job is to stop needles -- reported so nobody reads the published
// heights as the heights a camera sees, and so nobody "fixes" the gap by loosening the clamp.
const gaps = rows.map(r => +(r.heightM - r.eyeHiM).toFixed(2)).sort((a, b) => b - a);
console.log(`BOX_VS_MESH heightM - eyeHiM · max ${gaps[0]} · med ${gaps[Math.floor((gaps.length - 1) / 2)]} · min ${gaps[gaps.length - 1]} m`);
for (const r of taperViol) {
  console.log(`  ${r.prop} ${r.name} h ${r.heightM} midW ${r.midWidthM} (${r.midChords} chords) topW ${r.topWidthM} (${r.topChords}) -> taper ${taperOf(r)}`);
}
const thinnest = covered.slice().sort((a, b) => taperOf(a) - taperOf(b))[0];
console.log(`  thinnest covered ${thinnest.prop} ${thinnest.name} h ${thinnest.heightM}` +
  ` midW ${thinnest.midWidthM} (${thinnest.midChords} chords) topW ${thinnest.topWidthM} (${thinnest.topChords}) -> taper ${taperOf(thinnest)}`);
console.log(`  uncovered ${rows.length - covered.length} rows are below the ${TAPER_MIN_HEIGHT} m floor by design` +
  ` · their topW/chords ${rows.filter(r => r.eyeHiM < TAPER_MIN_HEIGHT).map(r => `${r.topWidthM}/${r.topChords}`).join(' ')}`);
console.log(`TAPER_OVER_CONE ${taperViol.length} · CONTROL ${controls.join(' · ')}`);
if (ctrlDead) console.log('BOULDER_SPIRE_RC=3 the taper gate did not answer the controls (ruler broken, not the rocks)');

// Witness that the clamp branch is reached by real products, not only by an injected one: the emitter
// records every stone it had to slump. Zero here would mean the law above has no effect on the shipped
// scatter, and a green ruler over a branch nothing walks is decoration.
const slump = group.userData.slumped || [];
console.log(`SLUMPED ${slump.length}`);
for (const s of slump) console.log(`  ${String(s.x).padStart(7)},${String(s.z).padStart(7)} ${s.name.padEnd(7)} ${s.from} -> ${s.to}`);
console.log(`  tallest ${Math.max(...rows.map(r => r.heightM))} m · worst slenderness ${Math.max(...rows.map(r => r.slenderness ?? -9))}`);
// rc 1 = the scatter has a bad shape, rc 3 = this ruler cannot be trusted. Distinct on purpose: the
// first is a modelling to-do, the second means a green rc 1 would be read as a judgement about rocks.
const rc = ctrlDead ? 3 : (phantom.length || spires.length || thin.length || taperViol.length ? 1 : 0);
console.log(`BOULDER_SPIRE_RC=${rc} · refusals phantom ${phantom.length} spire ${spires.length} no-band ${thin.length} taper ${taperViol.length}`);
process.exit(rc);
