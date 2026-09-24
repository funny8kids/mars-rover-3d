// E1 「随风的能见度各向异性」 — the probe that decides whether the clause exists.
//
//   node tools/cdp-run.mjs http://127.0.0.1:5173/qa_boot.html?auto=std tools/storm-aniso-probe.js
//
//   (against the headless Chrome on :9333; ~3 s once the page is booted — the whole reading needs
//   no rendered frame, because fog.density is written by Environment.update(), which is plain JS.
//   The first version of this test drove __QA.step() between bearings and cost 116 s for the same
//   numbers.)
//
// WHAT THE CODE DOES: src/world/environment.js has one `FogExp2` density, which is by definition
// isotropic, so a direction-dependent visibility cannot come from the fog model. It comes from
// sampling the dust field along the sightline (near 40 m / mid 110 m / far 220 m) instead of only
// beside the camera. Whether that sampling earns its frame time is a separate question from
// whether it exists, and this answers the existence one.
//
// WHY A SWING ALONE PROVES NOTHING: field.local() multiplies slab coverage by an fbm "fingers"
// term, so *turning the head* re-samples different dust and moves the number even in a uniform sky.
// A bearing swing is therefore not evidence. This rotates the WIND, not the camera.
//
// THE CONTROL THAT MAKES IT DECIDE: `pin(phase, focus, standoff, heading)` places the slab so that
// `edge - along(focus) == -standoff` for every heading — proven from src/world/storm.js:86. So at a
// fixed viewpoint the slab's distance and depth are invariant under rotation and the *only* thing
// that changes is which world direction the slab axis points along. Two consequences, both measured
// below:
//   - `corrVsWind0` — the 8-row deviation vector of heading h correlated with the h=0 vector rotated
//     by h. Weather-locked: ~1. Texture-pinned: collapses toward 0, because a finger field does not
//     organise itself around the wind bearing.
//   - `floor` — the rows exactly crosswind to the wind. Ahead of the front these cannot touch the
//     slab within 220 m, `coverage` is 0 there and `local()` returns 0 exactly, so they are a
//     *structural* zero and any nonzero row is entirely the sightline term. Inside a slab the same
//     rows read the finger gradient between the viewpoint and the sample points, which is real but
//     phase-dependent — hence the two configurations below are judged differently.
//
// MEASURED 2026-09-24 @ 3e014a9 — verdict PASS (8/8 rows), deviations from the viewDir=null
// baseline ×1e-4, one row-set per commanded wind bearing, sun at dayT 0.5 and finger phase at
// tick 0, amplitude 1.000 in every row-set (pin() sets it exactly):
//   buried      w0   0:-20.2 45:-16.3 90:1.7 135:1.4 180:-4.7 225:3.0 270:3.5 315:-15.1 sig 20.2 fl 3.5 r 1.000  120/182 m
//   buried      w45  0:-18.7 45:-22.1 90:-19.3 135:0.3 180:0.3 225:-3.4 270:2.0 315:1.6  sig 22.1 fl 1.6 r 0.992  120/183 m
//   buried      w90  0:1.4 45:-17.8 90:-22.0 135:-18.4 180:0.9 225:2.0 270:-1.2 315:2.0  sig 22.0 fl 1.4 r 0.984  124/192 m
//   buried      w135 0:-1.0 45:0.4 90:-19.9 135:-22.8 180:-19.3 225:0.7 270:1.2 315:-4.4 sig 22.8 fl 0.7 r 0.986  120/182 m
//   approaching w0   0:0.0 45:0.0 90:0.0 135:9.1 180:9.7 225:9.4 270:0.0 315:0.0        sig 9.7  fl 0   r 1.000  351/595 m
//   approaching w45  0:0.0 45:0.0 90:0.0 135:0.0 180:8.4 225:9.8 270:8.3 315:0.0        sig 9.8  fl 0   r 0.997  350/595 m
//   approaching w90  0:0.0 45:0.0 90:0.0 135:0.0 180:0.0 225:7.1 270:9.3 315:7.1         sig 9.3  fl 0   r 0.991  357/595 m
//   approaching w135 0:8.2 45:0.0 90:0.0 135:0.0 180:0.0 225:0.0 270:7.6 315:9.8         sig 9.8  fl 0   r 0.995  350/595 m
// Three runs of the finished file came back identical to the printed digit except for one row that
// straddles the rounding boundary (-15.1 twice, -15.0 once) and a 1 m shift in `edge`/`trail` from
// the rover's contact settling a hair differently under Q.step — no signal, floor, proj, correlation
// or D50 figure moved. So the reading is reproducible at the level the claims are made of. The metre
// column is D50 (half-visible range) worst/best.
// THE VERDICT: inside a slab the along-wind cone is clear air and crosswind is not — the most
// negative rows sit at the wind bearing and its ±45° mirrors in all four buried runs (w0: 0/-20.2,
// 45/-16.3, 315/-15.1) while the perpendicular rows read small and positive (+1.7/+3.5), and that
// whole shape walks around the dial with the wind at r 0.984..0.992. Looking straight downwind
// escapes past the leading edge, straight upwind only partly (the tail is 200 m off and just inside
// the 220 m far sample, so 180° reads -4.7 not -20), crosswind never escapes at all. Ahead of an
// approaching front five or six rows read *exactly* 0.0 — coverage there is structurally zero, so
// those rows are not noisy, they are empty — and the +7..+10 set is only the rows that face the slab.
// WHAT A PLAYER CONSUMES: 120 m of reach across the wind against 182 m along it while buried (1.5×),
// and 350 m at the wall against 595 m in any direction that misses it while approaching (1.7×). That
// ratio is what the HUD's "the front is coming from this quarter" claim is made of: the retreating
// front is a direction you can drive *toward*, and the arriving one is a direction you can see.
// THE GATE HAS BEEN SEEN RED. Deleting the clause is a one-line mutation of this file, and it fails
// 8/8 with every row at 0.0 (the first run-set prints as `-0.0` — negative zero, not a small number).
// Re-checkable right here, against the file's own bytes, so re-run it whenever this file changes:
//   sed 's|^    const sample = dir =>.*$|    const sample = () => { F.tick = 0; E.update(1 / 60, focus, 100, renderer, null); }; /*RED*/|' \
//     tools/storm-aniso-probe.js > /tmp/aniso-mutant.js
//   diff tools/storm-aniso-probe.js /tmp/aniso-mutant.js | grep -c '^<'      # must print 1
//   node tools/cdp-run.mjs - /tmp/aniso-mutant.js
// Two traps this command has already fallen into once each, so they are part of the recipe:
//   - The anchor is the sample line's four-space indent. Unanchored, it also hits the quoting line
//     above, and a reproduction command that rewrites its own documentation is not reproducible.
//     Anchored to `^    const` no comment line can match it.
//   - `diff` exits 1 when the files differ, so `diff ... && node ...` skips the mutant run and the
//     next reader sees the previous run's output still on disk. Check the 1, then run separately.
// The mutant's rows are not merely small, they are 0.0 to the last printed digit: with the finger
// phase pinned per call the instrument has no drift left of its own (before the pin it drifted by
// ±0.1 ×1e-4 between bearings, because update() advanced the scroll under the sweep). Its `r` column
// is worth reading too — 1.000 for w0 (a zero vector correlating with itself) and ±0.4 for the
// rotated runs, pure float dust. Correlation alone is therefore not the guard; proj and rangeRatio
// are what fail on those rows.
(async () => {
  const R = window.__RSB, Q = window.__QA;
  if (!R || !Q) return 'NOT_BOOTED';
  Q.pause();
  R.place(0, -100, 0);
  // Freeze the sun. The base fog density is `lerp(0.0026, 0.0014, dayF)`, so without this the
  // absolute metre readings drift with whatever time of day the rig happens to be at — two runs of
  // this file measured the same storm at 335 m and 248 m of reach before `setDay` was added. The
  // deviations (`rows`, `signal`, `floor`, `proj`) are day-invariant because they are taken against
  // `iso`; the metre figures are only reproducible with the clock held.
  R.setDay(0.5);
  Q.step(30, 1000 / 60);
  const E = R.env(), scene = R.scene(), F = R.stormRef(), renderer = R.post().composer.renderer;
  const focus = R.phys();
  const D50 = d => Math.sqrt(Math.LN2) / d;
  const rad = x => x * Math.PI / 180;

  const run = (tag, phase, standoff, heading) => {
    R.pinStorm(phase, standoff, heading);
    Q.step(4, 1000 / 60);
    // Push the PMREM gate past the sweep and then assert it never jumped back up: a run that quietly
    // ran a reflection bake is not the run being claimed. The anchor has to be the value that was
    // set — the first version asserted `> 59` after setting 60 and so fired on a clean sweep.
    E.envTimer = 600;
    // Freeze the scroll phase of the dust fingers, once per sampled bearing. `field.local()` advects
    // its fbm by `this.tick` (src/world/storm.js:341), and `tick` is advanced by update() itself — so
    // without this each of the nine calls below sampled a slightly different finger field, and the
    // page's uptime decided where the field started. Measured 2026-09-24 before the pin: three runs of
    // this same configuration reported the buried w0 `signal` as 21.0, 21.1 and 21.7 (×1e-4) and the
    // wall's reach as 335, 248 and 340 m. The directional claims survive that wobble — a finger field
    // does not organise itself around the wind bearing — but the metre figures do not.
    const sample = dir => { F.tick = 0; E.update(1 / 60, focus, 100, renderer, dir); };
    // `iso` is the build without this clause: update() with viewDir=null charges the dust only at
    // the viewpoint, one density for all bearings. Every row is reported as its deviation from that.
    sample(null);
    const iso = scene.fog.density;
    const rows = [];
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      sample({ x: Math.cos(a), y: -0.06, z: Math.sin(a) });
      rows.push([k * 45, scene.fog.density - iso]);
    }
    if (E.envTimer > 600) throw new Error('PMREM branch fired mid-sweep');
    // tick is reset before each call and advanced by exactly one dt inside it, so this proves the
    // sweep ran nine update() calls and nothing stepped a real frame between them.
    if (Math.abs(F.tick - 1 / 60) > 1e-12) throw new Error(`frame stepped mid-sweep (tick=${F.tick})`);
    // the axis the field actually holds, not the one commanded — a pinned storm is allowed to wobble
    const wb = (Math.atan2(F.wz, F.wx) * 180 / Math.PI + 360) % 360;
    const axis = b => Math.abs(Math.cos(rad(b - wb)));
    const along = rows.filter(r => axis(r[0]) > 0.6).map(r => r[1]);
    const cross = rows.filter(r => axis(r[0]) < 0.1).map(r => r[1]);
    const a1 = rows.reduce((m, [b, dv]) => m + dv * Math.cos(rad(b - wb)), 0) / 8;
    const dev = rows.map(r => r[1]);
    return {
      tag, headCmd: Math.round(heading * 180 / Math.PI), windBearing: Math.round(wb),
      iso: +iso.toFixed(5), edge: Math.round(F.edge), trail: Math.round(F.trail),
      // the two scalars the whole reading is taken at: pin() sets amplitude exactly, and tick is
      // forced to 0 above, so any run that reports something else here is not this instrument.
      amp: +F.amplitude.toFixed(3),
      // Named by what the two rows actually are, not by intuition: inside a slab the worst bearing
      // is CROSSWIND (the sightline never leaves the slab), the best is DOWNWIND (it walks out
      // through the leading edge), and looking upwind sits between them because the tail is 200 m
      // away — just inside the 220 m reach of the far sample.
      D50worst: Math.round(D50(iso + Math.max(...dev))), D50best: Math.round(D50(iso + Math.min(...dev))),
      // what a player consumes: the ratio of the two half-visible ranges in one number
      rangeRatio: +(D50(iso + Math.max(...dev)) / D50(iso + Math.min(...dev))).toFixed(2),
      // downwind-clearer is the physical claim; a1 < 0 says the dust column lies upwind
      proj: +(a1 * 1e4).toFixed(2),
      signal: +(Math.max(...along.map(Math.abs)) * 1e4).toFixed(1),
      floor: +(Math.max(...cross.map(Math.abs)) * 1e4).toFixed(1),
      rows: rows.map(([b, dv]) => `${b}:${(dv * 1e4).toFixed(1)}`).join(' '),
      _rows: rows,
    };
  };

  // Pearson r between two 8-row vectors, rows ordered by ascending bearing from 0.
  const pearson = (x, y) => {
    const mx = x.reduce((s, v) => s + v, 0) / x.length;
    const my = y.reduce((s, v) => s + v, 0) / y.length;
    const num = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
    const den = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
    return den === 0 ? 0 : +(num / den).toFixed(3);
  };
  // A feature sitting at bearing f when the wind blows at 0° must sit at f+shift when the wind
  // blows at `shift`, so the wind-locked prediction for the rotated run is base[b - shift]. (Getting
  // this the other way round correlates a chiral pattern against its own mirror and reports noise.)
  const rotBy = (v, shift) => v.map((_, i) => v[((i - shift / 45) % 8 + 8) % 8]);

  const H = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];
  const sets = {};
  for (const [tag, phase, standoff] of [['buried', 'peak', -60], ['approaching', 'front', 150]]) {
    const rs = H.map(h => run(tag, phase, standoff, h));
    const base = rs[0]._rows.map(r => r[1]);
    for (const r of rs) {
      // rotate by the axis the field actually held, snapped to the 8-row grid. The 0° run is the
      // anchor, so its correlation with itself is 1.000 by construction and must not count as a
      // pass — the criterion only has teeth on the three rotated runs.
      const shifted = r.windBearing !== 0;
      r.corrVsWind0 = pearson(r._rows.map(x => x[1]), rotBy(base, Math.round(r.windBearing / 45) * 45));
      // Four requirements, and only the first two carry the clause:
      //   proj < 0          — the dust column sits upwind, which is the physical direction of the claim
      //   rangeRatio < 0.8  — the two bearings differ by > 20 % of visible range, i.e. a player can act on it
      //   corr > 0.7 (rotated runs) — the pattern turns with the wind, which a finger field cannot do
      //   floor === 0 (approaching runs) — where geometry gives a structural zero, it must read one
      // The first version of this gate used `signal > 6 * floor` for *every* run instead. That was a
      // mis-specified criterion, not a weak result: inside a slab no sightline misses the dust, so the
      // crosswind rows legitimately read the finger gradient between the viewpoint and the sample
      // points, and the ratio measured the phase of the scroll rather than the clause. It went red on
      // buried/w0 at 5.8x with the phase pinned (20.2 signal vs 3.5 floor) while the wind-lock
      // correlation on the same run was 0.992. Ahead of the front, coverage really is 0 for a sightline
      // that misses the slab and `local()` returns exactly 0, so there the floor is structural — and it
      // is measured, not assumed: rows 0/45/90/270/315 read 0.0 while the three slab-facing rows read
      // +8.2..+9.8.
      r.pass = r.proj < 0 && r.rangeRatio < 0.8 && (!shifted || r.corrVsWind0 > 0.7) &&
        (r.tag !== 'approaching' || r.floor === 0);
      delete r._rows;
    }
    sets[tag] = rs;
  }
  R.unpinStorm(); Q.resume();
  const all = [...sets.buried, ...sets.approaching];
  return JSON.stringify({
    verdict: all.every(r => r.pass) ? 'PASS — 能见度各向异性随风锁相' : 'FAIL',
    failed: all.filter(r => !r.pass).map(r => `${r.tag}/${r.headCmd}`),
    ...sets,
  }, null, 1);
})()
