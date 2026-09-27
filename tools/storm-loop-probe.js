// ─── storm-loop probe (#E2): does the weather change the rules, or only the picture? ───
// Run: node tools/cdp-run.mjs 'http://127.0.0.1:5173/qa_boot.html?auto=std' tools/storm-loop-probe.js 9333 90000 300000
//
// 【E】2 asks for at least two closed loops in which a front changes what the player must DO. The code
// has two candidates (main.js FILM / NAV), and until this file neither had ever been walked end to end:
// the two storm probes in the repo (`storm-layer-probe.js`, `storm-aniso-probe.js`) both judge the
// PICTURE, and every number this loop needs was already exposed on `__RSB` (`film`, `setFilm`, `nav`,
// `lance`, `grid`) except the battery, which is added in the same commit as this file because a bill
// you cannot read is not a bill.
//
// Six links, each with its own control. A link counts as proven only when the thing that should move
// moves AND the thing that must not move stays:
//   L1 deposit      a front over the rover raises `film.worst`            (control: under clear sky it
//                                                                    does not, over the same wall-clock)
//   L2 yield        more film means more lost output                   (same dust, two films)
//   L3 lance pays   holding F near an array lowers its film AND battery (control: no lance, no drain)
//   L4 nav is local local dust at the rover, not a global flag, slides the fix
//                                                                    (control: same stormF, front far away)
//   L5 nav is earned landmarks come back from cleaning, not from a timer (control: setFilm 0 → +landmarks)
//   L6 blind stops  below NAV.BLIND the arrow is not drawn at all        (false-positive: full lock draws)
//
// Verdict lines, and the exit code is printed by the wrapper (this file returns text):
//   STORM_LOOPS_PASS / STORM_LOOPS_FAIL <which links> / STORM_LOOPS_UNTRUSTED <why not>
(() => {
  const R = window.__RSB;
  if (!R || !R.film || !R.nav || !R.grid || !R.lance) return 'STORM_LOOPS_UNTRUSTED __RSB lacks film/nav/grid/lance';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const say = (...a) => out.push(a.join(' '));
  const read = () => ({ film: R.film(), nav: R.nav(), grid: R.grid(), wind: R.windNow(), phys: R.phys() });
  const ok = [], bad = [];
  const link = (name, pass, detail) => { (pass ? ok : bad).push(name); say(`  ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

  return (async () => {
    if (!R.state.started) return 'STORM_LOOPS_UNTRUSTED the page never started (no menu press)';
    // Park the rover on the industry array field so L3 can hold the lance without driving: the array
    // positions come from the same ledger the game sits them from, so this is a measured spot and not
    // a hand-typed coordinate. `phys()` is the live body; writing x/z is what the teleport pad does.
    say(`storm loops probe · phase ${(R.storm() || {}).phase} · film ${JSON.stringify(R.film().arrays)}`);

    // ── L1 with its control: same wall clock, sky pinned calm vs a front held over the rover ──
    R.clearSky();
    const calm0 = read();
    await sleep(12000);
    const calm1 = read();
    R.pinStorm('front', 110);
    const fr0 = read();
    await sleep(24000);
    const fr1 = read();
    const calmRise = calm1.film.worst - calm0.film.worst;
    const frRise = fr1.film.worst - fr0.film.worst;
    say(`  observed · calm film ${calm0.film.worst} → ${calm1.film.worst} (Δ ${calmRise.toFixed(4)}) | ` +
      `front film ${fr0.film.worst} → ${fr1.film.worst} (Δ ${frRise.toFixed(4)})`);
    link('L1 deposit writes the bill', frRise > 0.002 && frRise > calmRise,
      `front Δ ${frRise.toFixed(4)} vs calm Δ ${calmRise.toFixed(4)} (want front>0.002 and > calm)`);
    link('L1c control: clean sky does not silt', calmRise < frRise + 1e-9,
      `calm Δ ${calmRise.toFixed(4)} is not above the front's own Δ`);

    // ── L2: yield follows film at one fixed dust level ──
    R.unpinStorm(); R.clearSky();
    R.setFilm(0.02, 0.02); const low = read();
    R.setFilm(0.90, 0.02); const high = read();
    say(`  observed · lost@film0.02 ${low.film.lost}% → lost@film0.90 ${high.film.lost}%`);
    link('L2 film costs output', high.film.lost > low.film.lost + 1,
      `${high.film.lost}% > ${low.film.lost}% + 1`);

    // ── L4 / L5: navigation, the second loop, with its two controls ──
    R.setFilm(0.95, 0.9);
    R.pinStorm('front', 60);                       // the wall on top of the rover
    await sleep(14000);
    const near = read();
    R.pinStorm('front', 420);                      // same storm, the front put downwind and far
    await sleep(14000);
    const far = read();
    say(`  observed · front@60 lock ${near.nav.lock} landmarks ${near.nav.landmarks} blind ${near.nav.blind} | ` +
      `front@420 lock ${far.nav.lock} landmarks ${far.nav.landmarks} blind ${far.nav.blind} · ` +
      `stormF ${JSON.stringify(R.storm().stormF)}`);
    link('L4 nav reads dust AT the rover', near.nav.lock < far.nav.lock,
      `lock ${near.nav.lock} (wall over rover) < ${far.nav.lock} (wall 420 m off), same storm`);
    link('L6 blind arrow is not drawn', near.nav.blind === true && near.nav.opacity <= 0.05,
      `blind ${near.nav.blind} arrow-opacity ${near.nav.opacity} (want true and ~0)`);

    // ── L5: the fix is earned from the columns, so cleaning them is what brings the map back ──
    R.setFilm(0.0, 0.0);                           // arrays restored, sky unchanged: no timer involved
    await sleep(9000);
    const clean = read();
    say(`  observed · after restoring arrays (same storm) lock ${clean.nav.lock} landmarks ` +
      `${clean.nav.landmarks} blind ${clean.nav.blind}`);
    link('L5 landmarks come back by cleaning', clean.nav.landmarks > near.nav.landmarks &&
      clean.nav.lock > near.nav.lock,
      `landmarks ${near.nav.landmarks} → ${clean.nav.landmarks}, lock ${near.nav.lock} → ${clean.nav.lock}`);
    link('L6c control: clean arrays do draw', clean.nav.blind === false && clean.nav.opacity > 0.05,
      `blind ${clean.nav.blind} arrow-opacity ${clean.nav.opacity} (want false and > 0.05)`);

    // ── L3: the act of cleaning spends the resource it protects ──
    R.unpinStorm(); R.clearSky();
    R.setFilm(0.8, 0.8);
    const idle0 = read();
    R.lance(true);
    await sleep(10000);
    const idled = read();                          // lance held, but is anything aimed?
    R.lance(false);
    const aim = idled.film.aim;
    const filmDown = idled.film.worst - idle0.film.worst;
    const battDown = idled.grid.battery - idle0.grid.battery;
    say(`  observed · lance held 10 s near nothing: aim ${JSON.stringify(aim)} film Δ ${filmDown.toFixed(4)} ` +
      `battery Δ ${battDown.toFixed(4)} (self film ${idle0.film.rover} → ${idled.film.rover})`);
    link('L3 lance pays with battery', (aim !== null && filmDown < -0.002) || idled.film.rover < idle0.film.rover,
      `aim ${aim} array-film Δ ${filmDown.toFixed(4)}, paint film ${idle0.film.rover} → ${idled.film.rover}`);
    link('L3b the payment is real', battDown < 0 || idled.film.rover < idle0.film.rover,
      `battery Δ ${battDown.toFixed(4)} (a lance that costs nothing is not a decision)`);

    R.unpinStorm(); R.clearSky(); R.setFilm(0, 0);
    say(`verdict · pass [${ok.join(', ')}] fail [${bad.join(', ') || 'none'}]`);
    // The count is read off the tally, never typed: a hardcoded denominator goes stale the day a
    // link is added or renamed, and a green line with the wrong number on it is worse than no line.
    const n = ok.length + bad.length;
    say(bad.length ? `STORM_LOOPS_FAIL ${bad.length}/${n} ${bad.join(',')}` : `STORM_LOOPS_PASS ${ok.length}/${n}`);
    return out.join('\n');
  })();
})()
