// ─── storm-beat probe (#E3): is a front a step of the mission chain, or weather that happens to it? ───
// Run: node tools/cdp-run.mjs 'http://127.0.0.1:8080/qa_boot.html?auto=std&v='$(date +%s)'' tools/storm-beat-probe.js 9333 120000 420000
//
// 【E】3 says the storm must be *a variable of the chain* and the UI must warn in a way a player can
// act on. The code has that wiring (`STORM_BEAT` + `fireStormBeat()` + `launchWindowHold()` in
// src/main.js, `arm()/holdSky()/timeToClear()` in src/world/storm.js), and until this file the ledger
// row said "✅ Implemented" on the strength of reading it. `tools/storm-loop-probe.js` measures what a
// front does to the *rules* (film, yield, nav); this one measures the other half — that a mission
// schedules the front, that the warning reaches the screen as a countdown rather than as a caption, and
// that the launch gate is actually held by that schedule and released by clear sky.
//
// Five links, each with its own control. A link counts only when the thing that should move moves AND
// the thing that must not move stays:
//   B1 fire       reaching the chain's last step fires the beat           (control: at boot nothing has
//                                                                   fired and nothing is armed)
//   B2 warning    the forecast is readable on screen with a clock in it   (control: the toast before
//                                                                   the beat does not mention a storm)
//   B3 clock      the armed countdown ticks down at one second per second (control: it is bounded by the
//                                                                   beat's own lead, not by a random roll)
//   B4 gate       the launch window is held, and the hold NAMES the storm (control: after the sky is
//                                                                   taken off the schedule the storm
//                                                                   clause is gone — the line is
//                                                                   conditioned, not hardwired)
//   B5 arrives    an armed short lead really puts a wall in the sky over the pad (this is the link that
//                                                                   separates "scheduled" from "described")
//
// Verdict lines, printed by this file; the wrapper reports the exit code:
//   STORM_BEAT_PASS / STORM_BEAT_FAIL <which links> / STORM_BEAT_UNTRUSTED <why not>
//
// ─── WHY THE SETUP BLOCK LOOKS LIKE IT DOES (calibrated 2026-09-28) ───
//  1. `arm()` queues behind a slab that is still crossing (`pendingLead`), so a beat fired onto a live
//     storm would start its countdown *after* that slab's own legs — the reading would then be about
//     the dice, not the schedule. `clearSky()` is the page's own "take the sky off the dice" rig
//     (main.js:2888 → `holdSky()`: phase calm, hold Infinity) and it makes the beat's arithmetic
//     single-valued. It also has to come AFTER the boot snapshot, or the negative control is a control
//     on my own setup instead of on the game's starting state.
//  2. The beat is reached by `skipMissions()` (main.js:2856), which marks every step but `watch` done
//     and calls `advanceMission()` — the same function a player arriving at the deck arrives through.
//     That is the cheapest way to stand at the chain's last step without driving it; it does not skip
//     the beat itself, which is the thing under test.
//  3. `timeToClear()` in the calm branch returns the wait PLUS `_eventLegs()` (≈124 s: watch 42 + the
//     480 m approach at 21 m/s + peak 26 + the 900 m tail at 27 m/s), so the countdown the gate prints
//     is bigger than the beat's `lead` by that many seconds. B3 therefore judges the SLOPE and the
//     ceiling (`lead + 130`), never "countdown == 120".
//  4. `launchWindowHold()` checks the dust clause BEFORE the sunset clause, so an armed sky shows
//     `等待沙暴过境` whatever the clock says — no need to force night to read this gate.
//  5. B5 uses `armStorm(6)`: `arm()` clamps the calm hold to 4 s, the watch creep runs 42 s, so a wall
//     is over the island in well under the 170 s this link is allowed to watch. The test is that the
//     pad's own dust crosses `LAUNCH_DUST_LIMIT` (0.12) — a schedule that never becomes air is a caption.
(() => {
  const R = window.__RSB;
  if (!R || !R.stormBeats || !R.storm || !R.armStorm || !R.launchRig || !R.stormRef) {
    return 'STORM_BEAT_UNTRUSTED __RSB lacks stormBeats/storm/armStorm/launchRig/stormRef';
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const say = (...a) => out.push(a.join(' '));
  const ok = [], bad = [];
  const link = (name, pass, detail) => { (pass ? ok : bad).push(name); say(`  ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };
  const beat = () => R.stormBeats();
  const st = () => { const s = R.storm(); return { phase: s.phase, scheduled: s.scheduled, pendingLead: s.pendingLead,
    clearIn: Number.isFinite(s.clearIn) ? +s.clearIn.toFixed(1) : s.clearIn, edge: +s.edge.toFixed(1) }; };
  const field = () => R.stormRef();
  const toast = () => { const el = document.getElementById('toast');
    return el ? { text: el.textContent, shown: el.classList.contains('show') } : { text: null, shown: false }; };
  const mmss = /m?\d?\d:\d\d/;
  // How long the beat's forecast line is actually on screen, in seconds — a single sample cannot tell
  // "never shown" from "shown and already gone", and that distinction is the whole link.
  const watchToast = async (ms) => {
    let shownFor = 0, text = null;
    const t0 = performance.now();
    let last = t0;
    while (performance.now() - t0 < ms) {
      await sleep(200);
      const now = performance.now(), t = toast();
      if (t.shown && /沙暴/.test(t.text || '')) { shownFor += (now - last) / 1000; text = t.text; }
      last = now;
    }
    return { shownFor, text: text || toast().text };
  };
  // The top bar is where the game keeps its weather PROMISE between toasts, so it is read twice: one
  // frozen word would look identical to a live countdown in a single snapshot.
  const weatherTwice = async (gap) => {
    const el = document.getElementById('tb-weather');
    if (!el) return { t0: null, t1: null };
    const a = el.textContent; await sleep(gap); return { t0: a, t1: el.textContent };
  };

  return (async () => {
    if (!R.state.started) return 'STORM_BEAT_UNTRUSTED the page never started (no menu press)';
    const rig = R.launchRig();
    if (!rig || !rig.pad) return 'STORM_BEAT_UNTRUSTED launchRig() gave no pad to sample the gate against';
    const [padX, , padZ] = rig.pad;
    const padDust = () => +field().local(padX, padZ).toFixed(3);

    // ── B1/B2 negative control FIRST, on the game's own starting state, before I touch anything ──
    const boot = { beat: beat(), st: st(), toast: toast().text };
    say(`boot · fired ${JSON.stringify(boot.beat.fired)} · storm ${JSON.stringify(boot.st)} · toast ${JSON.stringify(boot.toast)}`);

    R.clearSky();
    await sleep(1500);
    const held = st();
    if (held.phase !== 'calm' || !Number.isFinite(held.clearIn) || held.clearIn > 1) {
      return 'STORM_BEAT_UNTRUSTED clearSky() left the sky at ' + JSON.stringify(held) +
        ' — the beat would queue behind a slab instead of starting its own countdown';
    }
    const calmDust = padDust();
    if (calmDust >= 0.12) return `STORM_BEAT_UNTRUSTED the pad already reads ${calmDust} dust under a held sky`;

    // ── B1: standing on the chain's last step is what fires the beat ──
    R.skipMissions();
    const t0 = performance.now();
    const b0 = beat();
    const s0 = st();
    say(`beat · fired ${JSON.stringify(b0.fired)} at sim ${b0.at}s · armed ${JSON.stringify(s0)} · pad dust ${calmDust} ` +
      `· mission ${R.state.mission} · launchArmed ${b0.armed}`);
    link('B1 the chain fires the front', b0.fired.includes('launch') && s0.scheduled === true &&
      Number.isFinite(s0.clearIn) && s0.clearIn > 0,
      `fired ${JSON.stringify(b0.fired)}, scheduled ${s0.scheduled}, sky clears in ${s0.clearIn}s`);
    link('B1c control: nothing was armed before the beat', boot.beat.fired.length === 0 &&
      !(boot.beat.hold && /沙暴|过境/.test(boot.beat.hold)),
      `boot fired ${JSON.stringify(boot.beat.fired)}, boot gate hold ${JSON.stringify(boot.beat.hold)}`);

    // ── B2: the warning has to reach the screen twice over — once as the beat's own line, once as the
    // top bar's standing state. The toast lives 3.6 s -> 8.8 s (main.js:459), so it is polled, never
    // sampled once: the first version of this file slept 9 s and read an empty slot, which is the
    // probe's clock, not the game's.
    const warn = await watchToast(10000);
    const bar = await weatherTwice(3000);
    say(`toast · shown ${warn.shownFor.toFixed(1)}s of 10s · text ${JSON.stringify(warn.text)}`);
    say(`topbar · ${JSON.stringify(bar.t0)} → ${JSON.stringify(bar.t1)}`);
    link('B2a the forecast is on screen with a clock', warn.shownFor >= 2 && /沙暴/.test(warn.text) &&
      mmss.test(warn.text), `shown for ${warn.shownFor.toFixed(1)}s, text ${JSON.stringify(warn.text)}`);
    link('B2b the top bar carries the standing countdown', /沙暴/.test(bar.t0) && /沙暴/.test(bar.t1) &&
      mmss.test(bar.t0) && bar.t0 !== bar.t1, `${JSON.stringify(bar.t0)} → ${JSON.stringify(bar.t1)} (must name ` +
      `a storm and be a LIVE clock, not a frozen word)`);
    link('B2c control: the pre-beat toast never mentioned it', !/沙暴/.test(boot.toast || ''),
      `boot toast ${JSON.stringify(boot.toast)}`);

    // ── B3: the countdown is a clock, not a caption ──
    const c0 = st().clearIn;
    await sleep(8000);
    const c1 = st().clearIn;
    const slope = (c0 - c1) / 8;
    say(`clock · clearIn ${c0} → ${c1} over 8 s (slope ${slope.toFixed(2)} s/s) · phase ${st().phase}`);
    link('B3 the armed wait counts down', c1 < c0 && slope > 0.7 && slope < 1.3,
      `${c0} → ${c1}, ${slope.toFixed(2)} s per second`);
    link('B3c bounded by the beat, not by a roll', c0 <= 120 + 130 && c0 > 120,
      `clearIn ${c0} (want just above the beat's own 120 s lead, and no more than lead + the 124 s of legs)`);

    // ── B4: the launch gate is held BY the schedule, and names it out loud ──
    const gate = beat().hold;
    say(`gate · hold ${JSON.stringify(gate)} · armed ${beat().armed}`);
    link('B4 the window is held for the storm, in words', typeof gate === 'string' &&
      /沙暴|过境/.test(gate) && mmss.test(gate), `hold ${JSON.stringify(gate)}`);
    R.clearSky();
    await sleep(1200);
    const rel = beat().hold;
    say(`gate · after taking the sky off the schedule: hold ${JSON.stringify(rel)} · storm ${JSON.stringify(st())}`);
    link('B4c control: clear sky releases the storm clause', !(typeof rel === 'string' && /沙暴|过境/.test(rel)),
      `hold ${JSON.stringify(rel)} (the wait line must disappear when nothing is armed — a hold that says ` +
      `storm forever is decoration, not a gate)`);

    // ── B5: the schedule becomes air — an armed short lead puts a wall over the pad ──
    R.armStorm(6);
    let seen = null;
    const samples = [];
    const deadline = performance.now() + 170000;
    while (performance.now() < deadline && !seen) {
      await sleep(4000);
      const d = padDust(), s = st();
      if (d >= 0.12) seen = { dust: d, phase: s.phase, edge: s.edge };
      else samples.push(`pad ${d} phase ${s.phase} edge ${s.edge}`);
    }
    say(`arrive · ${seen ? `pad dust ${seen.dust} under phase ${seen.phase} (edge ${seen.edge})`
      : `no wall reached the pad within 170 s of a 6 s lead`}`);
    link('B5 an armed lead actually arrives at the pad', !!seen,
      seen ? `pad local dust ${seen.dust} ≥ LAUNCH_DUST_LIMIT 0.12 while phase ${seen.phase}`
        : 'the countdown never became a front over the launch pad');
    if (samples.length) say(`  samples before arrival · ${samples.join(' | ')}`);

    R.clearSky();
    say(`verdict · pass [${ok.join(', ')}] fail [${bad.join(', ') || 'none'}]`);
    const n = ok.length + bad.length;
    say(bad.length ? `STORM_BEAT_FAIL ${bad.length}/${n} ${bad.join(',')}` : `STORM_BEAT_PASS ${ok.length}/${n}`);
    return out.join('\n');
  })();
})()
