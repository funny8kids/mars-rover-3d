// E1 「分层密度与视差」 — does the frame hold three strata, or one sheet of static?
//
//   node tools/cdp-run.mjs http://127.0.0.1:5173/qa_boot.html?auto=std tools/storm-layer-probe.js
//
//   (against the headless Chrome on :9333; ~10-14 s wall end to end, of which the page-side work is
//   ~0.19 s of storm plus ~0.27 s of statistics — the rest is boot and CDP round trips. No frame is
//   ever rendered: `stormStep` runs the same `updateStorm` line main.js runs, on the CPU.)
//
// WHAT THE CODE CLAIMS: src/fx/particles.js builds the storm as three pools (salt / susp / haze)
// with different seed bands, sizes, opacities, gravity, drag and advection rates, and the comment
// above `STORM_LAYERS` promises they "separate in the frame instead of averaging into one flat
// orange wash". A table of constants cannot keep that promise: between birth and the photographed
// frame the sprites advect, fall, bounce on the deck and die, so what a layer *is* is the
// distribution of its live sprites. `__RSB.stormLayers()` walks those buffers and reports each live
// sprite through the vertex/fragment shader's own arithmetic (view-axis depth, the uMaxSize clamp,
// the uNearFade and uFadeIn alpha ramps).
//
// WHY A LOOK AT THE CONSTANTS IS NOT A TEST: the pools differ by construction, so "they differ"
// proves nothing. The hypothesis the clause must refute is a *uniform sheet* — that the label on a
// pool carries no information about where in the air its sprites are, how fast they go with the
// wind, or how fast they sweep the lens. That hypothesis is exactly what a permutation null
// measures: re-deal the same samples into three groups of the same sizes at random, many times, and
// see whether the real groups separate more than any re-deal does. No taste constant is needed for
// the threshold, and the null is computed from the frame being judged, so the gate is
// self-normalising against run-to-run noise in the storm.
//   statistic: S = (spread of the three group medians) / (mean within-group IQR)
//   verdict:   beats = how many of REPS re-deals reach S — 0 means p < 1/REPS.
//
// WHY `beats === 0` IS NOT ENOUGH ON ITS OWN: the first run of the band-collapse mutant (M2 below)
// passed the whole gate set — its observed S was 0.37 against a best re-deal of 0.295, so no shuffle
// ever matched the real grouping, yet the frame had visibly lost its layers. "No random re-deal does
// this well" is a statement about sample size, not about how much separation there is, and 200-ish
// sprites per pool is enough to make a faint real difference unfalsifiable. The gate therefore also
// requires obs >= MARGIN * worst, i.e. the layers must separate several times better than chance
// rather than merely better than chance.
//
// WHAT THIS CANNOT SETTLE, STATED UP FRONT: `dps` (screen sweep, device px/s) is partly implied by
// the pools' different seed radii (34/54/96 m), since anything nearer to the lens drifts faster in
// pixels at the same m/s. It is therefore reported as the parallax *reading* — how much apparent
// motion separation the frame actually has — and judged by the ordering test (near layer sweeps
// faster) rather than being the sole evidence for layering. Sprites inside 5 m of the view plane are
// dropped from it: the perspective divide sends their px/s to 10^5, which is a property of the lens,
// not of the storm.
//
// MEASURED (pinned peak storm, wind 26 m/s, effWind 26, authored lens at [0, 4.2, -109.6],
// framebuffer 640×696, 800 CPU steps = 13.33 s of dust, seed 20260924; two fresh pages agree to the
// digit — only msSim/msStats differ. Quantile rows are [min,p5,p25,p50,p75,p95,max].)
//
//                          salt        susp        haze
//   alive / cap            1065/1200   727/816     346/384
//   cover of the frame     1.963 %     2.195 %     7.787 %
//   height median          0.276 m     3.537 m     23.45 m
//   along-wind median      17.65       23.54       25.03       m/s
//   as a share of the wind 0.679       0.905       0.963
//   screen sweep median    672         513.6       357.8       device px/s
//   airborne / on-deck     59.6/35.2   85.2/13.7   99.4/0.6    %
//
//   Sep. medians [0.276, 3.537, 23.45] m  -> S(h) 2.380   vs worst re-deal 0.420   (5.7×, beats 0/400)
//   Sep. medians [17.65, 23.54, 25.03] m/s -> S(va) 3.075  vs worst re-deal 0.357   (8.6×, beats 0/400)
//   S(d) 1.363/0.423 and S(dps) 0.643/0.456 are reported, not gated (see "WHAT THIS CANNOT SETTLE").
//   Where the dust sits, in frame-cover % per height band: 0–5 cm 1.267 (salt 0.900), 5–50 cm 0.248,
//   0.5–2 m 0.980, 2–8 m 1.381 (susp 0.913), 8–30 m 5.309 (haze 4.930), 30 m+ 2.629.
//
// WHAT IT FOUND, BEFORE THE FIX: the deck was not a boundary layer, it was a wall. `skid` was a bare
// per-frame constant (0.72), so a sprite touching the sand lost 0.72^60 ≈ 3e-16 of its horizontal
// speed per second and any grain that settled simply stopped — 74.6 % of salt within 1.5 mm of the
// ground at a median 1.05 m/s (4 % of the storm), 36.9 % of the *suspension* layer frozen at 1.31 m/s
// while its other two thirds moved at 22.6, and screen sweep rising with height (23.2 / 90 / 154.4
// px/s) — an inverted parallax, far layers smearing faster than near ones. `skid` is now retention
// per 1/60 s like `drag`, and both numbers above are the post-fix frame.
//
// THE GATE AND ITS MUTATION. Two one-line mutants, each run on its own fresh page (the source is
// restored from a /tmp backup afterwards, and only a run whose printed `physics` shows the mutant's
// constant counts as having tested anything):
//   M1  `sed -i 's/bounce: 0.72, skid: 0.98/bounce: 0.72, skid: 0.72/' src/fx/particles.js`
//       -> FAIL {nearLeads:false, hops:false, salt:false}: salt back on the deck (floor 72.3 %,
//          h median 0 m, va median 1.05 m/s = 0.04 W), sweep median 67.9 px/s against susp's 513.6.
//          Note what the null did here: S(h) 2.542 and S(va) 5.349, both *larger* than the healthy
//          frame's, because gluing one group to zero makes the medians fly apart. A permutation null
//          rewards the worst defect this probe exists to catch, so it cannot be the only gate —
//          ordering and drift are what fail M1, and `beats === 0` alone would have passed it.
//   M2  `sed -i 's|const h = L.y\[0\] + Math.random() \*\* L.y\[2\] \* (L.y\[1\] - L.y\[0\]);|const h = 2.5 + Math.random() * 3; /*RED*/|' src/fx/particles.js`
//       (all three pools seeded into one narrow band — the "flat orange wash" the clause denies)
//       -> the first gate set PASSED it (S(h) 0.370 vs best re-deal 0.295, beats 0/400), which is how
//          MARGIN got added. With obs >= 3 × worst: FAIL {strongH:false}, salt h median 2.449 m
//          against haze's 6.091 — the healthy frame's 85× spread between those two medians collapsed
//          to 2.5× — and the 0–5 cm band's cover drops from 1.267 % to 0.902 %.
// Both mutants were reproduced on a page whose `physics` line printed the changed constant, so the
// failures are the storm's and not a stale module's: see the note in tools/cdp-run.mjs on Chrome's
// script cache, without which six consecutive runs of this probe printed identical digits and looked
// like a fix that did nothing.

(async () => {
  const R = window.__RSB, Q = window.__QA;
  if (!R || !Q || !R.stormLayers) return JSON.stringify({ fail: 'rig or stormLayers() missing' });

  const mulberry32 = s => () => {
    s = (s + 0x6D2B79F5) | 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // The storm's emitter is Math.random(), so the sim is re-seeded as well as the null: two runs of
  // the same bytes must print the same digits, or a regression in the probe hides in the noise.
  const SEED_SIM = 20260924, SEED_NULL = 51241, REPS = 400;
  const realRandom = Math.random;

  // The runner's readiness poll only proves the world exists. The post-processing chain and the storm
  // field are both built inside the START handler, and the render loop is registered with them — so a
  // probe that starts stepping frames before that is stepping nothing: one such run reported "the
  // chase camera never flew in, 100.0 m after 600 frames", and those 600 frames cost 0.2 s because no
  // callback was there to receive them. Wait on the wall clock for the app to be started, and say so
  // out loud if it never is.
  const bootedAt = Date.now();
  while (!(R.post() && R.storm()) && Date.now() - bootedAt < 30000) await new Promise(r => setTimeout(r, 250));
  if (!(R.post() && R.storm())) return JSON.stringify({ fail: `app never started (no composer/stormField after ${((Date.now() - bootedAt) / 1000).toFixed(1)} s)` });

  Q.pause();
  R.place(0, -100, 0);
  R.setDay(0.5);
  // The lens is authored here rather than inherited from the chase camera, for two reasons. It races
  // the app's own boot: a run that stepped 600 frames before the render loop was registered moved the
  // lens 0 m in 0.2 s and took the whole census from [0,0,0], 100 m upwind of the rover. And nothing
  // below needs a drawn frame — `__RSB.stormLayers()` walks the buffers through the shader's own
  // arithmetic — so pausing the pump and writing the pose fixes the framing to the digit. The pose is
  // the one the chase camera settles at behind a rover parked at (0, -100): 9.6 m back, 4.2 m up,
  // aimed a metre above the deck at the vehicle.
  const eye = R.camera();
  eye.position.set(0, 4.2, -109.6);
  eye.lookAt(0, 1.2, -100);
  eye.updateMatrixWorld();
  R.pinStorm('peak', -60, 0);
  Math.random = mulberry32(SEED_SIM);
  const wall0 = Date.now();
  // 800 steps = 13.3 s of dust, longer than the longest sprite life (haze ttl 8 s × the 0.6..1.3
  // seed scatter), so by the census every live sprite was born inside the pinned, frozen field.
  const warm = R.stormStep(800, 1 / 60);
  const C = R.stormLayers(220);
  const msSim = Date.now() - wall0;
  Math.random = realRandom;
  R.unpinStorm();
  Q.resume();
  if (!C) return JSON.stringify({ fail: 'stormLayers() returned null' });

  const KEYS = ['salt', 'susp', 'haze'];
  const G = {}, drop = {};
  for (const k of KEYS) {
    const m = C.rows[k].m;
    G[k] = m;
    drop[k] = m.filter(s => s.dps === null || s.zc < 5).length;
  }
  const num = (a, b) => a - b;
  const quant = (sorted, f) => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.round(f * (sorted.length - 1)))] : NaN;
  const profile = v => {
    const s = v.slice().sort(num);
    return [0, .05, .25, .5, .75, .95, 1].map(f => +quant(s, f).toFixed(3));
  };
  const S = (groups, get) => {
    const meds = groups.map(g => quant(g.map(get).sort(num), 0.5));
    const spread = Math.max(...meds) - Math.min(...meds);
    const within = groups.reduce((a, g) => {
      const s = g.map(get).sort(num);
      return a + (quant(s, .75) - quant(s, .25));
    }, 0) / groups.length;
    return { s: spread / (within || 1e-9), meds };
  };
  const perm = (groups, get, reps, seed) => {
    const all = []; for (const g of groups) for (const x of g) all.push(get(x));
    const sizes = groups.map(g => g.length);
    const obs = S(groups, get);
    const rng = mulberry32(seed);
    const idx = all.map((_, i) => i);
    const dealt = sizes.map(() => []);
    let beats = 0, worst = -Infinity;
    for (let r = 0; r < reps; r++) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1)), t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      let c = 0;
      for (let k = 0; k < dealt.length; k++) {
        dealt[k].length = 0;
        for (let n = 0; n < sizes[k]; n++) dealt[k].push(all[idx[c++]]);
      }
      const s = S(dealt, x => x).s;
      if (s >= obs.s - 1e-12) beats++;
      if (s > worst) worst = s;
    }
    return {
      n: sizes, obs: +obs.s.toFixed(3), reps, beats, worst: +worst.toFixed(3),
      meds: obs.meds.map(x => +x.toFixed(3)),
    };
  };

  const sepH = perm(KEYS.map(k => G[k]), s => s.h, REPS, SEED_NULL);
  const sepVa = perm(KEYS.map(k => G[k]), s => s.va, REPS, SEED_NULL + 7);
  // Range is the third axis a uniform sheet cannot fake: the pools are seeded in boxes of 34/54/96 m
  // half-extent around the lens, so if the labels do not predict distance either, the "strata" are one
  // cloud with three names.
  const sepD = perm(KEYS.map(k => G[k]), s => s.d, REPS, SEED_NULL + 23);
  const near = {};
  for (const k of KEYS) near[k] = G[k].filter(s => s.dps !== null && s.zc >= 5);
  const sepDps = perm(KEYS.map(k => near[k]), s => s.dps, REPS, SEED_NULL + 13);

  // Optical cover as the frame receives it: drawn area x peak alpha, in device px. Summed over a
  // pool and divided by the framebuffer, it answers "how much of this frame is this layer worth".
  const [FW, FH] = C.frame;
  const cover = k => G[k].reduce((a, s) => a + s.cw, 0) / (FW * FH) * 100;
  const BANDS = [[0, .05], [.05, .5], [.5, 2], [2, 8], [8, 30], [30, Infinity]];
  const bands = BANDS.map(([lo, hi]) => {
    const inb = {};
    let tot = 0;
    for (const k of KEYS) {
      const c = G[k].filter(s => s.h >= lo && s.h < hi).reduce((a, s) => a + s.cw, 0) / (FW * FH) * 100;
      inb[k] = +c.toFixed(3); tot += c;
    }
    return { band: `${lo}–${hi === Infinity ? '∞' : hi} m`, tot: +tot.toFixed(3), ...inb };
  });

  const med = (k, f) => +quant(G[k].map(f).sort(num), 0.5).toFixed(3);
  const wind = C.speed * (1 + C.gust * 0.55);
  const layer = k => ({
    alive: C.rows[k].alive, cap: C.rows[k].cap, drawn: G[k].length, stride: C.rows[k].stride,
    op: C.rows[k].op, focal: C.rows[k].focal, capPx: C.rows[k].capPx, nearFade: C.rows[k].nearFade,
    // Forwarded verbatim so a distribution of speeds is never quoted without the constants that made
    // it — and so a reading that survives an edit to `src/fx/particles.js` is caught as a stale module
    // rather than as a physics result.
    physics: C.rows[k].physics,
    h: profile(G[k].map(s => s.h)),
    va: profile(G[k].map(s => s.va)),
    vRatio: +(med(k, s => s.va) / wind).toFixed(3),
    dps: profile(near[k].map(s => s.dps)),
    px: profile(G[k].map(s => s.px)),
    d: profile(G[k].map(s => s.d)),
    coverPct: +cover(k).toFixed(3),
    // Optical cover contributed by sprites drifting below a quarter of the storm speed. The median
    // alone cannot see a bimodal layer: the run this instrument was written for had 37 % of the
    // suspension layer welded to the deck at 5 % of the wind while its median still read 23 m/s.
    deadPct: +((G[k].reduce((a, s) => a + (s.va < 0.25 * wind ? s.cw : 0), 0) /
      (G[k].reduce((a, s) => a + s.cw, 0) || 1e-9)) * 100).toFixed(1),
    airbornePct: +(G[k].filter(s => s.h > 0.05).length / G[k].length * 100).toFixed(1),
    floorPct: +(G[k].filter(s => s.h <= 0.0015).length / G[k].length * 100).toFixed(1),
  });

  const L = {}; for (const k of KEYS) L[k] = layer(k);
  const asc = f => KEYS.every((k, i) => i === 0 || f(KEYS[i - 1]) < f(KEYS[i]));
  // Height and sprite size have to *rise* through the layers (a boundary layer), and so has the
  // along-wind drift — the shear profile is the physical claim the three pools exist to make.
  const order = { h: asc(k => L[k].h[3]), px: asc(k => L[k].px[3]), va: asc(k => L[k].va[3]) };
  // The parallax clause, stated as what the eye reads: the layer nearest the deck must sweep the lens
  // faster than either layer above it. A strict salt > susp > haze chain is *not* the claim — screen
  // sweep is also set by the pools' seed radii (34/54/96 m), so ordering suspension against the
  // high, far, 151 px motes measures the emitter, not the storm.
  const nearLeads = L.salt.dps[3] > L.susp.dps[3] && L.salt.dps[3] > L.haze.dps[3];
  // A ground layer may not be paint: at least half the storm speed in the median, and no more than
  // half its own optical cover sitting still. `0.5` is not a taste constant — it is the boundary the
  // previous reading failed by an order of magnitude (salt held 0.04 W with 74.6 % of its sprites on
  // the deck), and a layer drifting at half the wind still lags the air above it visibly.
  const drift = {}; for (const k of KEYS) drift[k] = L[k].vRatio >= 0.5 && L[k].deadPct <= 50;
  // Saltation is a hop: the layer that is supposed to roll along the sand must spend most of a
  // sprite's life in the air, or it is a carpet and the clause it illustrates is a lie.
  const hops = L.salt.airbornePct >= 50;
  const populated = KEYS.every(k => L[k].drawn >= 100);
  const sep = { h: sepH, va: sepVa, d: sepD, dps: sepDps };
  // `beats === 0` alone is not the clause. The first mutation that erased the three seed bands (every
  // layer drawing the same 2.5-5.5 m box) still beat all 400 re-deals on height: S fell from 2.38 to
  // 0.37 but 0.37 > 0.295, so a gate that only asks "better than chance?" passes a storm whose strata
  // have been flattened to one cloud. The claim is not that the label carries *some* information about
  // height, it is that the layers sit at different heights, so the reading must clear the best chance
  // re-deal by a stated factor. The constant is in units of the null, not of the storm: the build that
  // passes does so at 5.7x on height and 8.6x on drift, the mutation that erases the bands sits at
  // 1.25x, and nothing between those two is being judged.
  const MARGIN = 3;
  const sig = k => sep[k].beats === 0 && sep[k].obs >= MARGIN * sep[k].worst;
  // Range is reported, not gated: the pools are seeded in boxes of 34/54/96 m half-extent, so the
  // label predicts distance partly by construction, and a gate that can only fail when the emitter is
  // deleted measures the emitter, not the storm.
  const pass = populated && order.h && order.px && order.va && nearLeads && hops &&
    KEYS.every(k => drift[k]) && sig('h') && sig('va');

  return JSON.stringify({
    verdict: pass ? 'PASS' : 'FAIL',
    msSim: +msSim, msStats: Date.now() - wall0 - msSim, warm,
    frame: C.frame, cam: C.cam, wind: C.wind, stormSpeed: C.speed,
    gust: C.gust, effWind: +wind.toFixed(2), amp: C.amp,
    pass: { populated, ...order, nearLeads, hops, strongH: sig('h'), strongVa: sig('va'),
      ...Object.fromEntries(KEYS.map(k => [k, drift[k]])) },
    sep, dropDps: drop, bands, layers: L,
  }, null, 1);
})()
