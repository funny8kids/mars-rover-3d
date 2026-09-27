#!/usr/bin/env node
// tools/beam-ladder-pool.mjs — pool the ladder and the cone probe into one reading per vantage.
//
// #104 moved five searchlights from an additive cone mesh to the `fx/beams.js` shaft shader, and the only
// thing carried across was the amplitude. It was matched by whole-frame lift (see the header of
// tools/beam-level-ladder.mjs), measured over several blocks in tools/logs/beam-level-ladder-2026-09-27.txt.
// A lift is not a stable number: the scene refreshes its environment about twice a second, so repeated
// blocks of the same layer at the same camera wander by a few hundredths of 255. That makes any single
// printed row a poor thing to quote in a comment, and a comment that quotes one will be wrong the next
// time someone re-runs the ladder.
//
//   node tools/beam-ladder-pool.mjs [log-path]
//
// So this reads every block in the log, pools the crest rows by vantage and layer, prints the ranges and
// their counts, and judges the claim that #104 actually rests on: that the two layers light the apron
// frame by the same amount, and that the swap moved the shape rather than the brightness.
//
// "The same amount" cannot be a band of absolute numbers. Pooled over the blocks in the log, the layer
// means sit close together and each layer's own block-to-block scatter is of the same order as the gap
// between them, so a band drawn around today's values is a band drawn on the ruler's jitter: it would go
// red on a build that looks identical, and the only fix available would be to widen the band, which is
// not a judgement at all. The gate prints both numbers every run, so the reader can see the gap and the
// scatter it has to clear.
//
// So the parity gate is a comparison, and it has two halves, both of which can actually fail:
//   1. a FLOOR — each layer must light the frame by at least FLOOR of 255 on average. This is what
//      rejects a swap that quietly did nothing; a no-op layer has lift ~0 and no comparison can see it.
//   2. an unresolved DIFFERENCE — |mean(shafts) - mean(cones)| must be smaller than the block-to-block
//      spread the layers show by themselves (the larger of the two, so neither layer's quietness gets to
//      vouch for the other). Reaching that difference requires >=2 blocks per layer; fewer, and there is
//      no spread to compare against, so the tool says so by name instead of passing.
// The shape claims (fewer pixels touched, more strength per touched pixel) are ratios of spans and stay.
import { readFileSync } from 'node:fs';

const LOG = process.argv[2] || 'tools/logs/beam-level-ladder-2026-09-27.txt';
const CREST = 0.28;
const FLOOR = 1.5;                  // of 255, mean whole-frame crest lift each layer must reach
const CEIL_TOL = 0.05;              // % of the sample a layer may add over its own frame's clip (12 px of 16 000)
// The pool's own output is appended to the log it reads, under this line, which the parser stops at. It
// has to be a constant declared before the loop and matched as a whole line, not a substring test.
const POOL_SENTINEL = '*** POOL OUTPUT — written by tools/beam-ladder-pool.mjs over the log above it; the parser stops here.';
const CEIL_RUNG = 0.45;
let raw;
try { raw = readFileSync(LOG, 'utf8'); } catch (e) {
  console.log(`CANNOT_READ ${LOG} — ${e.code || e.message}`); process.exit(2);
}

const blocks = [];
let cur = null;
// The `#n` suffix only counts within one RUN letter: `---- LADDER apron #1` appears in every block from D
// to M. Grouping by that suffix alone merges ~10 independent blocks into one mean, and a mean of 10
// blocks has an eighth of the scatter of a single one — the spread below is the ruler's own jitter, so
// folding blocks into fake super-blocks is exactly what would make a resolvable difference look like noise.
let runLetter = '';
for (const line of raw.split('\n')) {
  // The pool's own printed output gets appended to the log it read, under this sentinel. Stop there: a
  // row of pooled ranges is not a block, and if it were parsed the tool would be reading its own output
  // back as evidence. The second, byte-identical run recorded at the end of the log is the proof that it
  // is not.
  if (line === POOL_SENTINEL) break;
  const r = line.match(/^RUN ([A-Z]) — bust /);
  if (r) { runLetter = r[1]; continue; }
  const b = line.match(/^----\s+(LADDER|LEGACY)\s+(\S+)(\s+#\d+)?/);
  if (b) { cur = { layer: b[1], pose: b[2], run: `${runLetter}${b[3] || ''}`.trim(), rows: [], target: '', rc: null }; blocks.push(cur); continue; }
  if (!cur) continue;
  const t = line.match(/buffer (\d+x\d+)/);
  if (t && !cur.target) cur.target = t[1];
  if (cur.layer === 'LADDER') {
    const r = line.match(/^\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/);
    if (r) cur.rows.push({ rung: +r[1], clip: +r[2], selfClip: +r[3], blown: +r[4], touch: +r[7], mean: +r[8], lift: +r[10] });
    const c = line.match(/^LADDER_RC=(\d)/);
    if (c) cur.rc = +c[1];
  } else {
    const h = line.match(/^HEAD_OPACITY ([\d.]+) → (\{.*\})/);
    if (h) {
      const j = JSON.parse(h[2]);
      cur.rows.push({ rung: +h[1], clip: j.litClip, selfClip: j.darkClip, blown: j.litBlown,
        touch: j.touchPct, mean: j.mean, lift: +(j.litMean - j.darkMean).toFixed(2) });
    }
    const c = line.match(/^PROBE_RC=(\d)/);
    if (c) cur.rc = +c[1];
  }
}

const at = (layer, pose, rung) => blocks.filter(b => b.layer === layer && b.pose === pose)
  .flatMap(b => b.rows.filter(r => Math.abs(r.rung - rung) < 1e-6).map(r => ({ ...r, buf: b.target, run: b.run })));
const PINNED = '1303x532';
// One ladder run escaped the device-metrics override and drew at 1810x740 (RUN G apron #2, named in the
// appendix). A lift is a frame mean over a 160x100 downsample, so it is resolution-robust, but the pool
// is a set of readings taken at one size and it says which set it is: other buffers are dropped, and the
// drop is printed rather than folded into the range.
const keep = (xs) => {
  const on = xs.filter(x => !x.buf || x.buf === PINNED);
  const off = xs.filter(x => x.buf && x.buf !== PINNED);
  if (off.length) console.log(`  EXCLUDED ${off.length} row(s) drawn on ${[...new Set(off.map(x => x.buf))].join(', ')}`
    + ` (block${off.length > 1 ? 's' : ''} ${off.map(x => x.run || '?').join(', ')}) — only ${PINNED} is pooled`);
  return on;
};
const span = (xs, k) => xs.length ? `${Math.min(...xs.map(x => x[k]))}–${Math.max(...xs.map(x => x[k]))}` : '—';
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const blockMeans = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const k = (r.run || '(unlabelled)').trim();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r.lift);
  }
  return [...by.entries()].map(([block, xs]) => ({ block, n: xs.length, mean: +avg(xs).toFixed(3) }));
};
const spread = (means) => means.length < 2 ? 0 : +(Math.max(...means.map(x => x.mean)) - Math.min(...means.map(x => x.mean))).toFixed(3);

console.log(`POOL over ${LOG} · ${blocks.length} blocks · crest rung ${CREST}, ceiling rung ${CEIL_RUNG}`);
const fails = [];
for (const pose of ['apron', 'plaza', 'pad-centre']) {
  const s = keep(at('LADDER', pose, CREST)), c = keep(at('LEGACY', pose, 0.028));
  const hi = keep(at('LADDER', pose, CEIL_RUNG));
  console.log(`\n${pose} · ladder blocks ${blocks.filter(b => b.layer === 'LADDER' && b.pose === pose).length},`
    + ` probe blocks ${blocks.filter(b => b.layer === 'LEGACY' && b.pose === pose).length}`);
  if (!s.length || !c.length) {
    console.log(`  NO READINGS — shafts ${s.length} rows, cones ${c.length} rows: this vantage cannot be pooled`);
    fails.push(`${pose}: missing ${s.length ? 'cone' : 'shaft'} readings`);
    continue;
  }
  console.log(`  shafts @${CREST}  n=${s.length}  lift ${span(s, 'lift')}  touch% ${span(s, 'touch')}  mean+ ${span(s, 'mean')}  clip% ${span(s, 'clip')}  self% ${span(s, 'selfClip')}`);
  console.log(`  cones  @0.028   n=${c.length}  lift ${span(c, 'lift')}  touch% ${span(c, 'touch')}  mean+ ${span(c, 'mean')}  clip% ${span(c, 'clip')}  self% ${span(c, 'selfClip')}`);
  if (hi.length) console.log(`  shafts @${CEIL_RUNG}  n=${hi.length}  lift ${span(hi, 'lift')}  clip% ${span(hi, 'clip')}`);
  const bufs = new Set([...s, ...c].map(x => x.buf).filter(x => x));
  console.log(`  buffers seen: ${[...bufs].join(', ') || '(probe blocks print no TARGET)'}`);
  // The ceiling is not what stopped the crest here. That is a claim about clip% not rising above the same
  // frame's own self%, at every pose and at both the crest and the top rung — so the gate is "this layer
  // adds no blown pixels", not "the number looks small": a vantage whose scene blows 0.74 % on its own
  // (the plaza, on the mirror) passes while a layer that pushed it up would not.
  for (const [tag, rows] of [[`shafts @${CREST}`, s], [`shafts @${CEIL_RUNG}`, hi], ['cones @0.028', c]]) {
    if (!rows.length) continue;
    const worst = Math.max(...rows.map(x => x.clip - x.selfClip));
    console.log(`  ${tag} clip - self = at most ${worst.toFixed(2)} % of the sample`
      + ` (clip ${span(rows, 'clip')}, self ${span(rows, 'selfClip')})`);
    if (worst > CEIL_TOL) fails.push(`${pose}: ${tag} blow ${worst.toFixed(2)} % more pixels than the frame does without it — the ceiling is what stopped it, not the reach`);
  }
  if (pose === 'plaza') {
    // Reach, stated as an ordering rather than a ratio to copy: the shafts put more light in this frame
    // than the cones did, on every block, and the pool prints both spans so the reader can see the gap.
    const ls = s.map(x => x.lift), lc = c.map(x => x.lift);
    const ordered = Math.min(...ls) > Math.max(...lc);
    console.log(`  REACH ordering gate (shafts' lowest plaza lift > cones' highest): ${ordered ? 'PASS' : 'FAIL'}`
      + ` — shafts ${span(s, 'lift')} vs cones ${span(c, 'lift')} of 255`
      + ` (${(avg(ls) / avg(lc)).toFixed(2)}x on pooled means; touch is a wash at ${span(s, 'touch')} vs ${span(c, 'touch')} %`
      + ` because the shafts are thinner, so the ratio is read off lift, not coverage)`);
    if (!ordered) fails.push(`plaza: the shafts do not carry more light than the cones on every block — the reach claim would be unsupported`);
  }
  if (pose === 'pad-centre') {
    // "Exactly 0 in the frame at every rung, for both layers" — the staging finding #75 inherits, so it
    // gets a gate rather than a quoted row: any light reaching this sample at all contradicts it.
    const zero = [...s, ...c, ...hi].filter(x => x.lift !== 0);
    console.log(`  OCCLUSION gate (every ${pose} lift is exactly 0, both layers, up to ${CEIL_RUNG}): `
      + (zero.length ? `FAIL — ${zero.length} row(s) carry light (${zero.map(x => `${x.lift} in ${x.run}`).join(', ')})`
        : `PASS — ${s.length + c.length + hi.length} rows, all 0: neither layer reaches this frame`));
    if (zero.length) fails.push(`pad-centre: the layers are no longer invisible from the pad centre — the occlusion/staging finding needs re-reading`);
  }
  if (pose === 'apron') {
    // One number per block, so the spread below is block-to-block and not row-to-row inside one run.
    const ms = blockMeans(s), mc = blockMeans(c);
    for (const [layer, rows, m] of [['shafts', s, ms], ['cones', c, mc]]) {
      const mean = avg(m.map(x => x.mean));
      const shown = m.slice(0, 6).map(x => `${x.block}${x.n > 1 ? `(${x.n})` : ''}=${x.mean}`).join(' ');
      console.log(`  ${layer}: ${m.length} block(s), means ${spread(m) ? `${Math.min(...m.map(x => x.mean))}–${Math.max(...m.map(x => x.mean))}` : m[0].mean}`
        + ` · pooled ${mean.toFixed(3)} · first blocks: ${shown}${m.length > 6 ? ` +${m.length - 6} more` : ''}`);
      if (!(mean >= FLOOR)) fails.push(`apron: ${layer}'s mean crest lift ${mean.toFixed(3)} is under the ${FLOOR} floor — the layer may as well not be drawn`);
    }
    console.log(`  FLOOR each layer's mean crest lift >= ${FLOOR} of 255 (a no-op swap cannot clear it)`);
    const meanS = avg(ms.map(x => x.mean)), meanC = avg(mc.map(x => x.mean));
    const spreadS = spread(ms), spreadC = spread(mc);
    const noise = Math.max(spreadS, spreadC);
    const diff = Math.abs(meanS - meanC);
    if (ms.length < 2 || mc.length < 2) {
      console.log(`  PARITY cannot be judged: ${ms.length < 2 ? `shafts have ${ms.length} block` : ''}`
        + `${ms.length < 2 && mc.length < 2 ? ' and ' : ''}${mc.length < 2 ? `cones have ${mc.length} block` : ''}`
        + ` — with one block there is no block-to-block spread to compare the difference against`);
      fails.push(`apron: parity needs >=2 blocks per layer, got shafts ${ms.length} / cones ${mc.length}`);
    } else {
      console.log(`  PARITY |mean(shafts) - mean(cones)| = ${diff.toFixed(3)} vs block-to-block spread`
        + ` ${spreadS.toFixed(3)} (shafts, ${ms.length}) / ${spreadC.toFixed(3)} (cones, ${mc.length}) — noise ${noise.toFixed(3)}`);
      console.log(`    ${diff < noise ? 'PASS — the two layers are not separable on this ruler, which is the claim'
        : 'FAIL — the difference is resolvable, so "matched" is the wrong word here'}`);
      if (!(diff < noise)) fails.push(`apron: lift difference ${diff.toFixed(3)} >= the layers' own spread ${noise.toFixed(3)} — parity unsupported`);
    }
    const rel = 1 - (Math.min(...s.map(x => x.touch)) / Math.max(...c.map(x => x.touch)));
    console.log(`  shape moved: shafts touch ${span(s, 'touch')} % against the cones' ${span(c, 'touch')} % — ${(rel * 100).toFixed(0)} % fewer pixels,`
      + ` at mean+ ${span(s, 'mean')} against ${span(c, 'mean')}`);
    if (!(rel > 0.3)) fails.push(`apron: the shafts do not cover meaningfully fewer pixels (${(rel * 100).toFixed(0)} %) — the column/veil claim would be unsupported`);
    const ratio = Math.min(...s.map(x => x.mean)) / Math.max(...c.map(x => x.mean));
    console.log(`  strength per touched pixel: shafts/cones = ${ratio.toFixed(2)}×`);
    if (!(ratio > 1.5)) fails.push(`apron: per-pixel strength ratio ${ratio.toFixed(2)} is not "about twice" — the claim would be unsupported`);
  }
}
const seen = at('LADDER', 'apron', CREST).map(x => x.buf).filter(x => x);
const pinned = seen.filter(b => b === PINNED).length;
const others = [...new Set(seen.filter(b => b !== PINNED))];
console.log(`\nBUFFER ${pinned} of ${seen.length} pooled-candidate apron rows drawn at ${PINNED}`
  + `${others.length ? `; the rest at ${others.join(', ')} and excluded above` : ''}`);
if (!pinned) fails.push(`no apron row drawn at ${PINNED} — there is nothing to pool`);
console.log(fails.length ? `POOL_RC=1 — ${fails.length} judgement(s) refused:\n  ` + fails.join('\n  ') : 'POOL_RC=0');
process.exit(fails.length ? 1 : 0);
