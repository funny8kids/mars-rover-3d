// tools/cdp-flip-schedule-probe.mjs — the ruler for task #62 ③: how fast the separated booster turns
// itself over, how long that turn takes, and what a spectator on the watch deck is shown while it happens.
//
//   node tools/cdp-flip-schedule-probe.mjs <url> [label] [port] [headSha]
//
// Why this exists: the schedule derives the turn rate from the coast between two beats —
// `FLIP_RATE = pi / (RELIGHT_AT - STAGE_AT)` — so with a 3 s coast the vehicle is *required* to spend a
// half turn in three seconds, i.e. 60 deg/s. The complaint is that the closest camera moment after the
// separation then shows a disc rather than a rocket. That is a claim about seconds of MET and degrees per
// second, so it is measurable, and a fix has to move these numbers rather than the guidance.
//
// Every figure comes from `__RSB.flight()` — the object the scene graph was written from that same frame —
// after stepping the game with `__RSB.frame(1/60)` under `__QA`'s virtual clock. Four frames are captured
// on the way through, because a number nobody looked at is half a measurement.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [,, url, LABEL = 'before', portStr, HEAD = '?'] = process.argv;
const PORT = Number(portStr || 9333);
const DT = 1 / 60;
const STAGE = 22;                       // s, the separation beat as the schedule is written today
// Frames at a fixed offset from the separation beat, so the before/after pairs stay comparable even when
// the beats themselves move under a re-timed schedule.
const CAPTURES = [[0.6, 'a'], [2.5, 'b'], [5.0, 'c'], [8.0, 'd']];
// Bars. 36 deg/s is 0.6x what the pi/3 coast in the code demands; 6 s is the shortest turn that still
// reads as a vehicle changing its mind rather than flicking over.
const RATE_MAX = 36;
const FLIP_MIN_S = 6;
const END_HARD = 70;                    // s, launch.js `t >= SECO_AT + 24` closes the flight regardless

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot/.test(t.url))
  || list.find(t => t.type === 'page' && /^http/.test(t.url));
if (!page) { console.log('NO_PAGE_TARGET ' + JSON.stringify(list.map(t => t.url))); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
};
await new Promise(r => ws.onopen = r);
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'EVAL_ERROR');
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The page is served by a plain http.server with no cache headers, and this Chrome runs against a
// persistent profile, so a plain navigate reuses the module from last run: the first `green` run of
// this probe reported byte-identical rows for a schedule that had been edited, because the browser had
// never asked for the new bytes. Cache disabled makes every request go to disk.
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

// Name the bytes this run is about to measure, and check the sim ran them. The coast is what the
// schedule declares (`RELIGHT_AT = STAGE_AT + n`) and it is what the flight spends, so the two have to
// agree to the frame — a run against a stale module disagrees, and says so instead of reporting the
// previous numbers as if they were this build's. `src/main.js` is on the same list because the shot
// table lives there: the pictures below are read against it, so a run that photographed the old station
// list would otherwise be reported as a check of the new one.
const MODS = ['src/fx/launch.js', 'src/main.js'];
const origin = new URL(url).origin;
const src = await Promise.all(MODS.map(async m => {
  const served = await (await fetch(`${origin}/${m}`, { cache: 'no-store' })).text();
  return { m, local: fs.readFileSync(m, 'utf8'), served };
}));
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const declared = src[0].served.match(/^const RELIGHT_AT\s*=\s*STAGE_AT\s*\+\s*([0-9.]+)/m);

await send('Runtime.enable');
await send('Page.enable');
// `__RSB.shot()` POSTs the frame to the collector on :8123 and awaits the response, so without a
// listener every capture inside the flight throws `TypeError: Failed to fetch` mid-run, after the boot
// and the whole lead-in have been paid for. Name the missing dependency before navigating.
let collector = null;
try { collector = await (await fetch('http://127.0.0.1:8123/ping')).json(); } catch { }
if (!collector) { console.log('SHOT_SERVER_DOWN — start `node tools/shot-server.mjs` before this probe; the frames come off that collector'); process.exit(4); }
console.log('collector :8123 -> ' + collector.out);
await send('Page.navigate', { url });
const deadline = Date.now() + 420000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(1000);
  try { if (await evaluate(`!!(window.__RSB && window.__QA && __RSB.state && __RSB.state.started)`) === true) { ready = true; break; } } catch { }
}
if (!ready) { console.log('BOOT_TIMEOUT'); process.exit(2); }
if (await evaluate(`typeof __RSB.flight`) !== 'function') { console.log('NO_FLIGHT_API'); process.exit(3); }

// Arm the flight and hand the clock to the virtual pump. `fly(t)` pins MET while qaFly is set, so it is
// released straight away: a pinned flight would read as one that never separated.
await evaluate(`__QA.pause(); __RSB.skipMissions(); __RSB.fly(0); __RSB.fly(null);
window.__ROWS = [];
window.__F = 0;
window.__collect = (maxMet, maxFrames) => {
  const R = window.__RSB;
  for (let i = 0; i < maxFrames; i++) {
    R.frame(${DT});
    const f = R.flight();
    const met = ++window.__F * ${DT};
    window.__ROWS.push({
      // Probe-owned frame counter as the clock: flight().tel.met rounds to 0.1 s, a sixth of a frame,
      // so a rate taken across it is mostly quantisation. lean.booster is already degrees off vertical
      // (main.js:3043); treating it as radians is what made the first run report 3438 deg/s.
      met: +met.toFixed(3),
      lean: +f.lean.booster.toFixed(2),
      h: +f.bodies.booster[1].toFixed(1),
      vs: +f.tel.bVs.toFixed(1),
      sep: !!f.separated, burn: !!f.tel.bBurn, land: !!f.landed,
      thr: f.tel.thr.map(x => +x.toFixed(2)),
    });
    if (met >= maxMet || f.done) return { met: +met.toFixed(2), done: !!f.done, n: window.__ROWS.length };
  }
  return { met: null, done: false, n: window.__ROWS.length };
};`);

const lead = await evaluate(`__collect(${STAGE + 0.1}, 4000)`);
const shots = [];
const lens = [];
const lensRig = [];
const clips = [];
const casts = [];
for (const [off, tag] of CAPTURES) {
  const r = await evaluate(`__collect(${(STAGE + off).toFixed(2)}, 1400)`);
  if (r.met === null) { shots.push(`${tag}@sep+${off}:STEP_STUCK`); continue; }
  // Paint the live camera's own frame before the compositor is asked for it. Under `__QA.pause()` no
  // animation frame is running, so a bare `Page.captureScreenshot` returns whatever was last painted —
  // which is how the first run of this probe handed back pictures of a parked rover at an empty pad for
  // a flight that was already thirty seconds old. `shot()` with a null vantage and null look leaves the
  // camera to the game, renders it, and returns the luminance histogram with it, so the same call that
  // proves the framing is the one that carries the clip check.
  const painted = await evaluate(`__RSB.shot('flip-${LABEL}-${tag}', null, null, null)`);
  // `__RSB.camera` is a function, `__RSB.cam()` is the pose readout, and `__RSB.nearby(r)` answers the
  // one question a histogram cannot: what is actually inside the lens. A chase cam parked 7 m off the
  // rover's shoulder and a launch station 150 m off a vehicle 2 km up both photograph *something*.
  const rig = await evaluate(`(() => {
    const c = __RSB.camera(), k = __RSB.cam(), s = __RSB.state, f = __RSB.flight();
    let near = null;
    try { near = (__RSB.nearby(900) || []).map(o => o && (o.name || o.key || o.label || JSON.stringify(o).slice(0, 46))).slice(0, 8); }
    catch (e) { near = 'NEARBY_THREW: ' + e.message; }
    return { phase: s.launch, cam: k.pos, roverDist: k.dist, fov: +c.fov.toFixed(1),
      alt: f && f.tel ? f.tel.alt : null, near };
  })()`);
  await sleep(900);
  const png = await send('Page.captureScreenshot', { format: 'png' });
  const file = `tools/logs/flip-${LABEL}-${tag}-sep+${off}.png`;
  fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
  shots.push(`${tag}@sep+${off}->${file}`);
  if (typeof painted?.clip !== 'number') throw new Error(`shot() returned no clip for ${tag}: ${JSON.stringify(painted)}`);
  clips.push(painted.clip);
  // The other half of F1's picture bar is 「无纯色系偏色」, and `clip` says nothing about it: a
  // uniformly violet frame and a neutral one land in the same luminance bins. `shot()` already carries
  // the chroma ruler (`cast` = per-band mean channel / mean of the three, plus warm/cool shares), so
  // read it here instead of settling the hue by looking at a thumbnail. Printed, not gated: the >1.15
  // figure is the project's documented threshold for ground/sky bands, and these frames are ~85 % sky
  // at altitude, where no band has ever been calibrated. A gate on an unmeasured population is a ruler
  // that cannot read nonzero — the exact failure mode the `bins[8]/bins[9]` clip used to have.
  const bands = painted.cast || {};
  const named = Object.entries(bands).filter(([, v]) => Array.isArray(v));
  const chroma = named.map(([k, v]) => ({ k, dom: Math.max(v[0], v[1], v[2]), share: v[3], warm: v[4], cool: v[5] }));
  casts.push(`${tag}: ${chroma.length ? chroma.map(c => `${c.k} ${c.dom.toFixed(3)}@${(c.share * 100).toFixed(1)}% w${c.warm}/c${c.cool}`).join('  ')
    : `ALL_BANDS_NULL share<2% (bands present: ${Object.entries(bands).map(([k, v]) => k + '=' + (v === null ? 'null' : 'set')).join(',')})`}`);
  lensRig.push({ tag, off, ...rig });
  lens.push(`${tag}@sep+${off}: phase=${rig.phase} camY=${rig.cam[1]}m roverDist=${rig.roverDist}m fov=${rig.fov}deg alt=${rig.alt}m clip=${painted.clip} near=${JSON.stringify(rig.near)}`);
}
const tail = await evaluate(`__collect(200, 9000)`);
const rows = await evaluate(`window.__ROWS`);
// The sim's own touchdown note: off-pad distance and arrival rate. The schedule change moves the whole
// descent later and higher, so "the flip looks slower" is only worth buying if the boostback still
// arrives on the deck it aimed at, at a rate the field could brake.
const touch = await evaluate(`__RSB.flight().touch`);

const first = (pred) => { for (const r of rows) if (pred(r)) return r; return null; };
const sep = first(r => r.sep);
const burn = first(r => r.burn);
const land = first(r => r.land);

const rate = [];
for (let i = 1; i < rows.length; i++) {
  if (!rows[i].sep || rows[i].land) continue;
  const d = Math.abs(rows[i].lean - rows[i - 1].lean) / DT;
  if (d > 0.5) rate.push({ met: rows[i].met, v: d });
}
const rateMax = rate.length ? Math.max(...rate.map(r => r.v)) : 0;
const turnFirst = rate.length ? rate[0].met : null;
const turnLast = rate.length ? rate[rate.length - 1].met : null;
const turnSec = rate.length ? turnLast - turnFirst : 0;
const coast = sep && burn ? burn.met - sep.met : null;
const sepRows = rows.filter(r => r.sep);
const apex = sepRows.length ? Math.max(...sepRows.map(r => r.h)) : 0;
const sideOn = rows.filter(r => r.sep && !r.land && r.lean > 12 && r.lean < 168);
let run = 0, coldWorst = 0, coldAt = null;
for (const r of rows) {
  if (r.thr[0] <= 0.02 && r.thr[1] <= 0.02) { run += DT; if (run > coldWorst) { coldWorst = run; coldAt = r.met; } }
  else run = 0;
}

const L = [];
L.push(`PROBE flip-schedule [${LABEL}]  HEAD=${HEAD}`);
L.push(`  frames=${rows.length}  lastMET=${tail.met ?? '(frame budget spent)'}  lead=${JSON.stringify(lead)}`);
L.push(`  staging  MET=${sep ? sep.met : 'NEVER'}  lean=${sep ? sep.lean : '-'}deg  h=${sep ? sep.h : '-'}m`);
L.push(`  relight  MET=${burn ? burn.met : 'NEVER'}  lean=${burn ? burn.lean : '-'}deg  h=${burn ? burn.h : '-'}m  vs=${burn ? burn.vs : '-'}m/s`);
L.push(`  landing  MET=${land ? land.met : 'NEVER'}  margin to the ${END_HARD}s hard end: ${land ? (END_HARD - land.met).toFixed(1) + 's' : 'n/a'}`);
L.push(`  touch    ${touch ? `offPad=${touch.offPad}m  sink=${touch.sink}m/s  tGo=${touch.tGo}s` : 'NO TOUCHDOWN RECORD'}`);
L.push(`  coast    ${coast === null ? 'n/a' : coast.toFixed(2) + 's'}   apex h=${apex.toFixed(0)}m   side-on ${(sideOn.length * DT).toFixed(2)}s`);
L.push(`  RATE     peak ${rateMax.toFixed(1)}deg/s   turning window MET ${turnFirst} -> ${turnLast} = ${turnSec.toFixed(2)}s`);
const allFresh = src.every(s => s.local === s.served);
for (const s of src) {
  L.push(`  bytes    ${s.m} local=${sha(s.local)} served=${sha(s.served)} served_is_local=${s.local === s.served}`);
}
const implied = declared ? Number(declared[1]) : null;
const anchor = implied === null ? 'ANCHOR_ABSENT (no `const RELIGHT_AT = STAGE_AT + n` line in the served bytes)'
  : coast === null ? 'ANCHOR_UNCHECKED (never relit)'
  : Math.abs(coast - implied) <= 2 * DT ? `coast ${coast.toFixed(2)}s = declared +${implied}s, the sim ran these bytes`
  : `STALE_OR_NO_OP: schedule declares a ${implied}s coast but the flight spent ${coast.toFixed(2)}s`;
L.push(`  anchor   ${anchor}`);
L.push(`  cold     longest both-throttle gap ${coldWorst.toFixed(2)}s at MET ${coldAt}`);
L.push(`  shots    ${shots.join('  ')}`);
// What the lens was doing at each of those frames. `camY` is the discriminator: the rover's chase cam
// sits 4–8 m over the ground, while the launch rig's station for the flip is hundreds of metres up, so a
// `phase=flight camY=5` pair means the shot list never had the camera and the picture proves nothing.
for (const l of lens) L.push(`  lens     ${l}`);
const lensFlight = lens.length === CAPTURES.length && lens.every(l => /phase=flight/.test(l));
// Both halves of "the launch rig had the lens": the station is hundreds of metres of AGL up during the
// flip, and it is nowhere near the rover, which is where the chase cam sits 4–8 m over the ground.
const lensLifted = lensRig.length === CAPTURES.length
  && lensRig.every(r => r.cam[1] > 60 && r.roverDist > 150);
// F1's bar, stated for these frames rather than only for the parked-stack census: no captured frame may
// carry blown highlights. `clip` is the field `shot()` returns off its own luminance histogram.
const clipWorst = clips.length === CAPTURES.length ? Math.max(...clips) : null;
const pass = rateMax > 0 && rateMax <= RATE_MAX && turnSec >= FLIP_MIN_S
  && coast !== null && coast >= FLIP_MIN_S && land && (END_HARD - land.met) > 2
  && lensFlight && lensLifted && clipWorst === 0;
L.push(`  clip     worst of the ${clips.length} captures: ${clipWorst}   (F1 bar: 0)`);
L.push(`  cast     per-capture chroma readout, [R,G,B]/band as mean-channel over mean-of-three; n>1.15 = the documented cast figure`);
for (const c of casts) L.push(`           ${c}`);
L.push(`  VERDICT ${pass ? 'PASS' : 'FAIL'}  bars: peak<=${RATE_MAX}deg/s, turning>=${FLIP_MIN_S}s, coast>=${FLIP_MIN_S}s, landing>=2s before the hard end, every capture inside the launch rig (phase=flight, camY>60m), clip=0`);
const text = L.join('\n') + '\n';
fs.writeFileSync(`tools/logs/flip-schedule-${LABEL}.txt`, text);
process.stdout.write(text);
fs.writeFileSync(`tools/logs/flip-schedule-${LABEL}-rows.json`, JSON.stringify(rows));
ws.close();
// A reading taken off bytes the browser never asked for is not a reading, so the anchor has somewhere to
// refuse rather than printing into a passing report.
if (!allFresh) { console.log('STALE_MODULE: the served bytes differ from the working tree for at least one module above'); process.exit(6); }
if (anchor.startsWith('STALE_OR_NO_OP') || anchor.startsWith('ANCHOR_ABSENT')) process.exit(5);
