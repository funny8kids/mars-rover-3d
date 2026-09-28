// ─── storm-loop probe (#E2): does the weather change the rules, or only the picture? ───
// Run: node tools/cdp-run.mjs 'http://127.0.0.1:8080/qa_boot.html?auto=std&v='$(date +%s)'' tools/storm-loop-probe.js 9333 120000 420000
//
// 【E】2 asks for at least two closed loops in which a front changes what the player must DO. The code
// has two candidates (main.js FILM / NAV), and until this file neither had ever been walked end to end:
// the two storm probes in the repo (`storm-layer-probe.js`, `storm-aniso-probe.js`) both judge the
// PICTURE, and every number this loop needs was already exposed on `__RSB` (`film`, `nav`, `grid`,
// `lance`, `windNow`) except the battery, which is added in the same commit as this file because a bill
// you cannot read is not a bill.
//
// Six links, each with its own control. A link counts as proven only when the thing that should move
// moves AND the thing that must not move stays:
//   L1 deposit      a front over the rover raises `film.worst`            (control: under clear sky it
//                                                                    does not, over the same wall-clock)
//   L2 yield        more film means more lost output                   (same dust, two films)
//   L3 lance pays   holding F near an array lowers its film AND the battery
//   L4 nav is local local dust at the rover, not a global flag, slides the fix
//                                                                    (control: same front, far standoff)
//   L5 nav is earned with the air breathable again, clean columns bring the fix back faster and add a
//                                                                    landmark          (control: same
//                                                                    front-then-clear, two films)
//   L6 blind stops  below NAV.BLIND the arrow is not drawn at all, and above it is        (both halves)
//
// Verdict lines, and the exit code is printed by the wrapper (this file returns text):
//   STORM_LOOPS_PASS / STORM_LOOPS_FAIL <which links> / STORM_LOOPS_UNTRUSTED <why not>
//
// ─── WHY THE SETUP BLOCK LOOKS LIKE IT DOES (calibrated 2026-09-28, three runs) ───
// Three runs of this file measured the mechanism and then contradicted their own setup, and each time
// the probe — not the game — was wrong. Recorded here so the next reader does not re-derive them:
//  1. `nav.landmarks` only counts rigs that are `online && power >= 0.2` (main.js:956). With the grid
//     dark the count is pinned no matter what the film does, so L5 would fail for a reason that has
//     nothing to do with dust. `skipMissions()` is the game's own "grid is up" rig; it also puts the
//     battery above `LANCE_MIN`. It is what lets this file ask the E2 question (does the front change
//     the plan) instead of the mission-0 question (can you start a run at all).
//  2. `nav.lock` is dead flat until dust crosses `NAV.LOSS` = 0.30 (main.js:962, `load` clamps to 0).
//     A run read local 0.143 at a typed-in standoff 30 and printed "lock 1 < 1" — a FAIL that was
//     really this file never putting the rover in dust thick enough for the mechanism to have an
//     opinion. So the standoff is swept per stance and the front is held at whatever distance actually
//     carries dust over the rover (measured: 0 m → 0.95, 10 m → 0.73, 20 m → 0.52, 35 m → 0.21, 60 m →
//     0.00, with the field's own amplitude 1.0).
//  3. A pinned front is not a constant: `pin()` freezes `t` (storm.js:231) while `local()` multiplies
//     in `fingers`, which runs on the free-running `tick` (storm.js:341). Hence `holdFront()`: it
//     re-aims the pin every 2 s and reports the samples the link actually stood in.
//  4. `film.worst` is the MAX over arrays (main.js:687) and `setFilm(a, s)` sets every array to the
//     same value (main.js:2895) — so with a lance running on one column, `worst` does not move, because
//     another column is the max. L3b reads the AIMED column's own film out of `film().arrays`. Rig
//     positions come from `__RSB.taps()` (main.js:3549), the same `base.gridRigs` the lance and the nav
//     loop over.
//  5. `stormPlay.aim` is null whenever no rig inside `LANCE_R` still has film above 0.001 (main.js:895)
//     — i.e. the lance stops pointing at a column it has finished. Sampling it only at the end of a
//     10 s hold therefore reads "aim null" on a lance that WORKED (that is exactly what run
//     tools/logs/storm-loop-2026-09-28-214316.log showed: aim null, aimed column film 0.8 → 0). So L3
//     samples the aim early in the hold and the film at the end.
//  6. Landmarks are a *band*, not a lever: reach = `LAND_R*(1 - min(.5, stormF*.45))` and a silted
//     column only reads inside `reach*(1 - film*0.45)` (main.js:951-957). Under the held front that is
//     ~33 m clear vs ~19 m silted, so a column decides anything only between those two radii — and a
//     stance 6 m from its neighbour (the lance's own requirement) is nowhere near that band. The nav
//     stance is therefore computed from the stormF measured under the held front, and the band is
//     printed whether or not a stance inside it exists.
//  7. `lock` cannot recover while the wall is still over the rover: `load > 0.02` takes the decay
//     branch, which never looks at landmarks. The landmark count only prices the RECOVERY, so L5 asks
//     that question — front to the floor, then the same far sky, two films.
(() => {
  const R = window.__RSB;
  if (!R || !R.film || !R.nav || !R.grid || !R.lance || !R.taps) {
    return 'STORM_LOOPS_UNTRUSTED __RSB lacks film/nav/grid/lance/taps';
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const say = (...a) => out.push(a.join(' '));
  const field = () => R.stormRef();
  // `state.pos` is [x, y, z] (main.js:2855), so a plan distance is pos[0] and pos[2]. The first draft
  // paired pos[1] — the rover's HEIGHT above datum — with a rig's z, and printed a nonsense "85.1 m
  // from industry" that then tripped this file's own lance-reach guard.
  const at = () => [R.state.pos[0], R.state.pos[2]];
  const dist = (x, z) => { const [px, pz] = at(); return Math.hypot(px - x, pz - z); };
  const here = () => { const [px, pz] = at(); return field().local(px, pz); };
  const read = () => ({ film: R.film(), nav: R.nav(), grid: R.grid(), wind: R.windNow(), phys: R.phys(),
    here: +here().toFixed(3), stormF: +(R.env().state.stormF || 0).toFixed(3) });
  const ok = [], bad = [];
  const link = (name, pass, detail) => { (pass ? ok : bad).push(name); say(`  ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };
  // Bail-out must carry the ledger with it. An UNTRUSTED line alone re-creates the failure this whole
  // file exists to escape: the setup readings are the evidence for *why* the stance is unusable, and
  // without them the next reader has to re-run the probe to find out.
  const untrusted = why => out.concat(['STORM_LOOPS_UNTRUSTED ' + why]).join('\n');
  const list = a => a.map(x => `${x.dust.toFixed(3)}@${x.s}`).join(' ');
  const num = v => (typeof v === 'number' ? +v.toFixed(3) : v);

  // Re-aims a held front at one standoff and returns what the rover's own air carried during it. A
  // link that wants "the wall over the rover" has to show the dust it stood in, because the standoff
  // alone does not say it (calibration note 3).
  async function holdFront(standoff, seconds) {
    const samples = [];
    const n = Math.max(1, Math.round(seconds / 2));
    for (let i = 0; i < n; i++) {
      R.pinStorm('front', standoff);
      await sleep(2000);
      samples.push({ s: standoff, dust: +here().toFixed(3) });
    }
    const dusts = samples.map(x => x.dust);
    return { samples, min: Math.min(...dusts), max: Math.max(...dusts),
      mean: +(dusts.reduce((a, b) => a + b, 0) / dusts.length).toFixed(3) };
  }

  return (async () => {
    if (!R.state.started) return untrusted('the page never started (no menu press)');

    // ── setup: grid up (calibration note 1), sky held, dust ledger at a known low ──
    const dark = { online: R.grid().online, of: R.grid().of, battery: R.grid().battery };
    R.skipMissions();
    R.clearSky();
    R.setFilm(0.04, 0.04);
    const lit = { online: R.grid().online, of: R.grid().of, battery: R.grid().battery };
    say(`setup · grid ${dark.online}/${dark.of} batt ${dark.battery} → ${lit.online}/${lit.of} batt ${lit.battery}` +
      ` · films reset to 0.04 (a dark grid makes every column invisible for reasons that are not weather)`);
    if (lit.online < lit.of || lit.battery < 0.1) {
      return untrusted(`skipMissions left the grid at ${lit.online}/${lit.of} and battery ${lit.battery}`);
    }

    const rigs = R.taps().map(t0 => ({ key: t0[0], x: t0[1], z: t0[2], power: t0[3], online: t0[4] }));
    say(`taps · ${rigs.map(r0 => `${r0.key}[${r0.x},${r0.z}] p${r0.power}${r0.online ? '' : ' offline'}`).join(' ')}`);
    const along = (a, b, from) => {
      const d = Math.hypot(a.x - b.x, a.z - b.z), ux = (b.x - a.x) / d, uz = (b.z - a.z) / d;
      return { x: a.x + ux * from, z: a.z + uz * from, d, from };
    };
    async function takeStance(a, b, from, why) {
      const p = along(a, b, from);
      const st = R.place(p.x, p.z);
      await sleep(1200);
      const dA = dist(a.x, a.z), dB = dist(b.x, b.z);
      if (dB > p.d) return untrusted(`${why}: placing between the columns is not geometry, the rover ended` +
        ` ${dB.toFixed(1)} m from ${b.key} on a ${p.d.toFixed(1)} m pair`);
      say(`${why} · ${a.key}→${b.key} pair ${p.d.toFixed(1)} m apart; rover [${at().map(v => v.toFixed(1)).join(',')}]` +
        ` = ${dA.toFixed(1)} m from ${a.key} (lance reach 9) and ${dB.toFixed(1)} m from ${b.key}` +
        ` · touching ${JSON.stringify(st.touching)}`);
      return { dA, dB, touching: st.touching, p };
    }

    // ── lance stance: 6 m from a column, for the film loop's own act of cleaning ──
    let lpair = null;
    for (const a of rigs) for (const b of rigs) {
      if (a === b) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > 24 && d < 70 && (!lpair || d < lpair.d)) lpair = { a, b, d };
    }
    if (!lpair) return untrusted(`no two tap columns are 24-70 m apart (columns:` +
      ` ${rigs.map(r0 => r0.key).join(',')}) — the map cannot host both stances at once`);
    const lance0 = await takeStance(lpair.a, lpair.b, 6, 'lance stance');
    if (typeof lance0 === 'string') return lance0;
    if (lance0.touching.length) return untrusted(`the lance stance is inside ${lance0.touching.join(', ')}`);
    if (lance0.dA > 9) return untrusted(`the rover ended ${lance0.dA.toFixed(1)} m from ${lpair.a.key}, outside lance reach`);

    // ── sweep the standoff: which wall distance puts dust over THIS stance (note 2) ──
    const sweep = [];
    for (const s of [0, 10, 20, 35, 60]) sweep.push({ s, ...(await holdFront(s, 6)) });
    const usable = sweep.filter(x => x.mean > 0.30);
    const near = usable.length ? usable[usable.length - 1].s : sweep.slice().sort((x, y) => y.mean - x.mean)[0].s;
    const far = 420;
    say(`standoff sweep · ${sweep.map(x => `${x.s}m mean ${x.mean} [${list(x.samples)}]`).join(' | ')}` +
      ` · NAV.LOSS 0.30 → usable ${usable.map(x => x.s + 'm').join(',') || 'NONE'} · holding the front at` +
      ` ${near} m for the tests below`);

    // ── L1 with its control: same wall clock, sky calm vs a front held over the rover ──
    R.unpinStorm(); R.clearSky();
    const calm0 = read();
    await sleep(12000);
    const calm1 = read();
    const fr0 = read();
    const held = await holdFront(near, 24);
    const fr1 = read();
    const calmRise = calm1.film.worst - calm0.film.worst;
    const frRise = fr1.film.worst - fr0.film.worst;
    const skyAt = read();
    R.unpinStorm(); R.clearSky();
    say(`  observed · calm local ${calm0.here}→${calm1.here} film ${calm0.film.worst} → ${calm1.film.worst} ` +
      `(Δ ${calmRise.toFixed(4)}) | front@${near} held ${held.samples.length}×2 s local ${list(held.samples)}` +
      `, film ${fr0.film.worst} → ${fr1.film.worst} (Δ ${frRise.toFixed(4)}) · arrays ${JSON.stringify(fr1.film.arrays)}`);
    link('L1 deposit writes the bill', frRise > 0.002 && frRise > calmRise,
      `front Δ ${frRise.toFixed(4)} vs calm Δ ${calmRise.toFixed(4)} (want front>0.002 and > calm)`);
    link('L1c control: clean sky does not silt', calmRise < frRise + 1e-9,
      `calm Δ ${calmRise.toFixed(4)} is not above the front's own Δ`);

    // ── L2: yield follows film at one fixed dust level ──
    R.setFilm(0.02, 0.02); const low = read();
    R.setFilm(0.90, 0.02); const high = read();
    say(`  observed · lost@film0.02 ${low.film.lost}% → lost@film0.90 ${high.film.lost}%`);
    link('L2 film costs output', high.film.lost > low.film.lost + 1,
      `${high.film.lost}% > ${low.film.lost}% + 1`);

    // ── the band: how far a column has to be before its own film decides if it counts (note 6) ──
    const front = await holdFront(near, 6);
    const sky = read();
    R.unpinStorm(); R.clearSky();
    const reach = 58 * (1 - Math.min(0.5, sky.stormF * 0.45));
    const silted = reach * (1 - 0.95 * 0.45);
    const dBwant = (reach + silted) / 2;
    say(`band · held front@${near} local ${list(front.samples)} · stormF ${sky.stormF} → landmark reach ` +
      `${reach.toFixed(1)} m clean, ${silted.toFixed(1)} m at 95 % film → a column decides between ` +
      `${silted.toFixed(1)} and ${reach.toFixed(1)} m; nav stance targets ${dBwant.toFixed(1)} m of a column`);
    // Which pair can host it? The rover needs to sit between the two columns, `dBwant` from one, and
    // not need to be inside the lance ring at all.
    let npair = null;
    for (const a of rigs) for (const b of rigs) {
      if (a === b) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const from = d - dBwant;
      if (from > 2 && from < d - 2 && (!npair || Math.abs(d - (dBwant + 12)) < Math.abs(npair.d - (dBwant + 12)))) {
        npair = { a, b, d, from };
      }
    }
    if (!npair) return untrusted(`no tap pair is ${dBwant.toFixed(0)} m-plus-a-bit apart, so no stance on this` +
      ` map puts a column in the deciding band (${reach.toFixed(0)} m clean vs ${silted.toFixed(0)} m silted)` +
      ` — columns: ${rigs.map(r0 => `${r0.key}@${r0.d || ''}`).join(',')}`);
    const nav0 = await takeStance(npair.a, npair.b, npair.from, 'nav stance');
    if (typeof nav0 === 'string') return nav0;
    if (nav0.touching.length) return untrusted(`the nav stance is inside ${nav0.touching.join(', ')}`);

    // ── L4 / L6a: the wall over the rover vs the same wall far away, at one fixed stance ──
    R.setFilm(0.95, 0.9);
    const nearHeld = await holdFront(near, 16);
    const nearRead = read();
    const farHeld = await holdFront(far, 16);
    const farRead = read();
    R.unpinStorm();
    say(`  observed · front@${near} local ${list(nearHeld.samples)} lock ${nearRead.nav.lock} lm ` +
      `${nearRead.nav.landmarks} blind ${nearRead.nav.blind} op ${nearRead.nav.opacity} stormF ${nearRead.stormF}` +
      ` | front@${far} local ${list(farHeld.samples)} lock ${farRead.nav.lock} lm ${farRead.nav.landmarks}` +
      ` blind ${farRead.nav.blind} op ${farRead.nav.opacity} stormF ${farRead.stormF}`);
    link('L4 nav reads dust AT the rover', nearHeld.mean > farHeld.mean + 0.05 && nearRead.nav.lock < farRead.nav.lock,
      `mean local dust ${nearHeld.mean} (wall over rover) > ${farHeld.mean} (wall ${far} m off) and lock ` +
      `${nearRead.nav.lock} < ${farRead.nav.lock}, one stance`);
    link('L6a blind arrow is not drawn', nearRead.nav.blind === true && nearRead.nav.opacity <= 0.05,
      `blind ${nearRead.nav.blind} arrow-opacity ${num(nearRead.nav.opacity)} (want true and ~0)`);

    // ── L5: with the air breathable again the columns price the recovery, so cleaning is the map ──
    // `load > 0.02` takes the decay branch, which never reads the landmark count (note 7), so this is
    // asked as two identical trials that differ only in the film: front to the floor, then 3 s of the
    // same far sky, and read how far the lock got back.
    async function recoverTrial(film, label) {
      R.setFilm(film, 0.9);
      const under = await holdFront(near, 12);          // drive the lock to the floor
      const at0 = read();
      const clear = await holdFront(far, 4);            // breathable air, same storm, far away
      const at1 = read();
      say(`  ${label} · film ${film} · under the front local ${list(under.samples)} lock ${at0.nav.lock} lm ` +
        `${at0.nav.landmarks} | after ${clear.samples.length}×2 s of far sky local ${list(clear.samples)} lock ` +
        `${at1.nav.lock} lm ${at1.nav.landmarks} homing ${num(at1.nav.homing)} blind ${at1.nav.blind}`);
      return { lock: at1.nav.lock, lm: at1.nav.landmarks, homing: at1.nav.homing, blind: at1.nav.blind,
        opacity: at1.nav.opacity, under: at0.nav.lock, at1 };
    }
    const dirty = await recoverTrial(0.95, 'silted columns');
    const earned = await recoverTrial(0.0, 'clean columns');
    link('L5 a cleaned column becomes a landmark', earned.lm > dirty.lm,
      `landmarks ${dirty.lm} → ${earned.lm} at one stance with ${npair.b.key} at ${nav0.dB.toFixed(1)} m of it ` +
      `(band ${silted.toFixed(0)}-${reach.toFixed(0)} m, film is the only thing that moved)`);
    link('L5b the fix comes back faster from clean columns', earned.lock > dirty.lock + 0.02,
      `lock after the same 8 s of clear air: silted ${dirty.lock} → clean ${earned.lock} (homing ` +
      `${num(dirty.homing)} s vs ${num(earned.homing)} s) · both driven to ${dirty.under}/${earned.under} under the front`);
    // The trials' negative control, and it reads the FLOOR rather than the recovery: a trial whose lock
    // never left 1 did not "win the fix back" when the clean columns appeared, it just never lost it, and
    // the L5 comparison above would be measuring nothing.
    link('L5c both trials started from a lost fix', dirty.under < 0.35 && earned.under < 0.35,
      `lock under the held front: silted ${dirty.under}, clean ${earned.under} (want both < 0.35 = NAV.BLIND)`);

    // ── L6b: and once it is earned, the arrow is drawn again ──
    R.unpinStorm(); R.clearSky();
    let waited = 0;
    while (waited < 20 && R.nav().blind) { await sleep(1000); waited++; }
    const drawn = read();
    say(`  observed · ${waited} s of calm sky after the clean trial: lock ${drawn.nav.lock} lm ` +
      `${drawn.nav.landmarks} blind ${drawn.nav.blind} op ${num(drawn.nav.opacity)}`);
    link('L6b control: a clean, breathable sky draws', drawn.nav.blind === false && drawn.nav.opacity > 0.05,
      `blind ${drawn.nav.blind} arrow-opacity ${num(drawn.nav.opacity)} after ${waited} s (want false and > 0.05)`);

    // ── L3: the act of cleaning spends the resource it protects (note 5: aim is sampled early) ──
    const lance1 = await takeStance(lpair.a, lpair.b, 6, 'lance stance again');
    if (typeof lance1 === 'string') return lance1;
    R.setFilm(0.8, 0.8);
    const idle0 = read();
    R.lance(true);
    await sleep(2500);
    const mid = read();                             // aimed while the column still has a coating
    const aimMid = mid.film.aim, aimMidFilm = (mid.film.arrays.find(a0 => a0[0] === lpair.a.key) || [])[1];
    await sleep(7500);
    const idled = read();
    R.lance(false);
    const aimEnd = idled.film.aim, battDown = idled.grid.battery - idle0.grid.battery;
    const target = (idled.film.arrays.find(a0 => a0[0] === lpair.a.key) || [null, null])[1];
    const dNow = dist(lpair.a.x, lpair.a.z);
    say(`  observed · lance held 10 s at ${dNow.toFixed(1)} m of ${lpair.a.key}: aim at 2.5 s ` +
      `${JSON.stringify(aimMid)} with that column at ${aimMidFilm}, aim at 10 s ${JSON.stringify(aimEnd)} ` +
      `(null = nothing left to blow off) · aimed column film 0.8 → ${target} · worst-array Δ ` +
      `${(idled.film.worst - idle0.film.worst).toFixed(4)} (a MAX, so equal columns hide a single clean one)` +
      ` · battery ${idle0.grid.battery} → ${idled.grid.battery} · paint film ${idle0.film.rover} → ${idled.film.rover}`);
    link('L3 lance aims the column it is parked at', aimMid === lpair.a.key,
      `aim ${aimMid} vs ${lpair.a.key} at ${dNow.toFixed(1)} m (reach 9), column film ${aimMidFilm} when aimed`);
    link('L3b the array under the lance clears', target !== null && target < 0.8,
      `${lpair.a.key} column film 0.8 → ${target} (read by key, not by the max)`);
    link('L3c the payment is real', battDown < 0,
      `battery Δ ${battDown.toFixed(4)} (a lance that costs nothing is not a decision)`);
    link('L3d it stops aiming at finished work', aimMid !== null && aimEnd === null,
      `aim ${aimMid} at 2.5 s → ${aimEnd} at 10 s with the column at ${target}: the ring is empty, which is` +
      ` why the end-of-hold sample alone read a false FAIL in an earlier run`);

    R.unpinStorm(); R.clearSky(); R.setFilm(0, 0);
    say(`verdict · pass [${ok.join(', ')}] fail [${bad.join(', ') || 'none'}]`);
    // The count is read off the tally, never typed: a hardcoded denominator goes stale the day a
    // link is added or renamed, and a green line with the wrong number on it is worse than no line.
    const n = ok.length + bad.length;
    say(bad.length ? `STORM_LOOPS_FAIL ${bad.length}/${n} ${bad.join(',')}` : `STORM_LOOPS_PASS ${ok.length}/${n}`);
    return out.join('\n');
  })();
})()
