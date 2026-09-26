// tools/cdp-clip-sweep.mjs — the 【F】1 half of the acceptance that no tool used to run: shoot every
// interactive point of the map under each sky and read the frame's luminance histogram, so "clip=0"
// is a census instead of a taste call.
//
//   node tools/cdp-clip-sweep.mjs <url> <port> [skies=day,dusk,night] [poi=<regex>]
//
// Why this exists as its own ruler: `__RSB.shot()` already returns the histogram (main.js:5029), but
// every use of it so far was a *named* frame somebody chose — the gate close-up, the dune, the plaza.
// A blown fitting on a street nobody photographed stays unmeasured, and the goal clause says the whole
// map. So the vantage set is derived from the game's own waypoint list (`__RSB.pois()`), never typed
// here, and a missing row is a loud failure rather than an empty list read as clean.
//
// Two rulers on the histogram, not one. `clip` (percent of pixels at luminance >= 224) catches the
// over-bright frame; `burn`/`burnPct` catches the specific defect the night rework is about — a lamp
// whose core is bleached to hueless white stops being the thing you navigate by, and a frame can score
// a low `clip` while every one of those pixels is white. Both come from `shot()`, which counts the
// >= 224 band and the chroma-free subset inside it.
import { spawn } from 'node:child_process';

const [,, url, portStr, skiesArg, poiArg] = process.argv;
const PORT = Number(portStr || 9333);
const SKIES = (skiesArg && !skiesArg.startsWith('poi=') ? skiesArg : 'day,dusk,night').split(',');
const poiFlag = process.argv.find(a => a.startsWith('poi='));
const POI_RE = poiFlag ? new RegExp(poiFlag.slice(4)) : null;
const DAY_T = { day: 0.30, dusk: 0.76, night: 0.90 };
// Bars. The 0.5 % ceiling on `clip` is not arbitrary: the accepted wide frames of this build read
// 0.0-0.1 %, and the one frame that was ever *defended* at 3.4 % (main.js:5073) was a gate close-up,
// i.e. a fitting blown to a disc. 0.5 % is the gap between "a filament" and "a hole in the picture".
const CLIP_MAX = 0.5;
// A lamp band whose blown pixels are mostly hue-free is a bleached fitting — but only if there is a
// band to speak of. `clip` is quantised to 0.1 % = 16 px, so `burnPct` on a smaller population is the
// share of one or two pixels: the first sweep printed `bleached 100 %` for rows whose `clip` was 0.0,
// i.e. up to 15 blown pixels, all of them a single specular speck. The floor is `shot()`'s own rule
// for averaging a chroma band — 160 px of the 16 000-px sample (main.js:5115) — and below it the
// share is reported as null rather than as a verdict.
const BURN_MIN_BLOWN_PX = 160;
// With a population to average, most-hueless-blown is a bleached fitting whatever the share is.
const BURN_SHARE_MAX = 60;
// Dead black: the night grade is allowed to be dark, not to be void. `bins` from `shot()` is in
// PER-MILLE, not percent (main.js:5150 rounds `count / 1600 * 100` over a 16 000-px sample), so 30 on
// that scale is 3 % of the frame — the same unit the plaza night readings were filed in (1 ‰, and the
// 24 ‰ regression of #84). Sand at luminance 28-31 is dark and warm, not void (main.js:5046); a frame
// with 3 % of its pixels under luminance 32 has holes in it.
const NIGHT_BIN0_MAX = 30;
// The shadow band's dominant channel, per main.js:5081: neutral is 1.000 and a cast pushes past 1.15.
const CAST_MAX = 1.15;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = '/tmp/rsb-clip-' + new Date().toISOString().slice(0, 10);
// `shot()` POSTs its PNG to the collector on :8123 and awaits the response — without a listener the
// fetch rejects and every frame "fails" as an exception, which would be a ruler reading its own plumbing.
const server = spawn('node', ['tools/shot-server.mjs', OUT], { stdio: 'ignore' });
let serverUp = false;
for (let i = 0; i < 40 && !serverUp; i++) {
  await sleep(100);
  // A `catch` that also sets the flag would make this check unkillable, and the first thing it has to
  // be able to say is "the collector is not there".
  try { await fetch('http://127.0.0.1:8123/ping'); serverUp = true; } catch { }
}
if (!serverUp) { console.log('SHOT_SERVER_DOWN — :8123 never answered'); server.kill(); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); server.kill(); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return;
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'EVAL_THREW');
  return r.result.value;
};
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  ready = await ev(`!!(window.__RSB && window.__RSB.shot && window.__RSB.state && window.__RSB.state.started)`).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { console.log('NEVER_READY'); ws.close(); server.kill(); process.exit(1); }
// The vantage set comes from the game. An empty list here would make the whole sweep a vacuous pass.
const pois = JSON.parse(await ev('JSON.stringify(window.__RSB.pois().map(p => [p.name, +p.x.toFixed(1), +p.z.toFixed(1), p.r]))'));
const picked = POI_RE ? pois.filter(p => POI_RE.test(p[0])) : pois;
if (!picked.length) {
  console.log(`POI_FILTER_EMPTY — poi=${poiFlag} matched none of ${pois.length} interactive points`);
  ws.close(); server.kill(); process.exit(1);
}
const buf = JSON.parse(await ev(`JSON.stringify((()=>{const r=window.__RSB.post().composer.renderer.domElement;return [r.width,r.height]})())`));
console.log(`TARGET ${url} · buffer ${buf[0]}x${buf[1]} · ${picked.length}/${pois.length} interactive points × ${SKIES.length} skies = ${picked.length * SKIES.length} frames`);
// Units on one line, because the two come off the same ruler in different ones: `clip`/`burn` are
// percent with a decimal, `bins` are per-mille.
console.log(`UNITS clip,burn = % of the 16 000-px histogram sample · bins = ‰ each · shadow= chroma:warm/cool shares`);
// The game's own wall discs, so the vantage can be proven clear of geometry instead of guessed.
// Discs carrying a `floor` are excluded on purpose: physics.js:249 skips exactly those when it pushes
// the hull out, so a stand the rover drives over is not a wall the lens may not enter either.
const walls = JSON.parse(await ev(`JSON.stringify(window.__RSB.solids().filter(c => c.r && c.floor === undefined).map(c => [+c.x.toFixed(2), +c.z.toFixed(2), c.r, c.prop || '']))`));
if (!walls.length) {
  console.log('NO_WALL_DISCS — __RSB.solids() returned nothing, so no vantage can be proven clear of geometry');
  ws.close(); server.kill(); process.exit(1);
}
console.log(`WALLS ${walls.length} collider discs used for vantage clearance`);
const norm3 = v => { const l = Math.hypot(...v) || 1; return v.map(n => n / l); };
const dot3 = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);

const rows = [];
// One function decides what a bad frame is, because the per-row print and the end-of-run verdict have
// to be the same ruler — two copies of the threshold arithmetic is how a flagged row ends up in a
// "PASS" summary.
const defects = r => {
  const f = [];
  // A lens inside a wall disc describes a frame no player ever sees, and its `clip` indicts the wrong
  // thing — this is an instrument fault, and it is named as one rather than filed under lighting.
  if (r.inN) f.push(`vantage(${r.inN} discs${r.inProp ? ': ' + r.inProp : ''})`);
  if (r.clip > CLIP_MAX) f.push(`clip ${r.clip}`);
  if (r.burnPct !== null && r.burnPct > BURN_SHARE_MAX) f.push(`bleached ${r.burnPct}%`);
  if (r.sky !== 'day' && r.bins[0] > NIGHT_BIN0_MAX) f.push(`bin0 ${r.bins[0]}‰`);
  // A buried camera and a black picture score the same way, and both would "pass" a clip bar. No frame
  // of this map is 95 % of its pixels in the bottom two buckets, so that shape is an instrument fault.
  if (r.bins[0] + r.bins[1] > 950) f.push(`blank ${r.bins[0] + r.bins[1]}‰`);
  // Shadow-band chroma is reported, never scored, and that is a decision with evidence behind it:
  // main.js:5097-5103 adjudicated a warm shadow band on regolith as the picture's *second hue* (the
  // dune's rows read 1.269-1.323 warm while the whole-frame mean said 1.169, belonging to nothing).
  // A bar on that mean therefore indicts correct frames; the night-fill cast this was meant to catch
  // shows up as dead black (`bin0`) or as bleached lamps (`burnPct`) instead.
  return f;
};
for (const sky of SKIES) {
  const dayT = DAY_T[sky];
  if (dayT === undefined) { console.log(`BAD_SKY ${sky} — known: ${Object.keys(DAY_T).join(',')}`); continue; }
  // `nightF` is a smoothed follower, not a setpoint: setting the day and shooting the next frame reads
  // the *previous* sky. So pump until the reading stops moving, and carry how many frames it took —
  // a row that settled in 0 frames is a row that never changed at all.
  const settle = JSON.parse(await ev(`(async () => {
    const R = window.__RSB;
    R.clearSky();
    R.setDay(${dayT});
    let prev = -1, pumped = 0, nf = 0, sun = -1;
    for (let k = 0; k < 400; k++) {
      R.frame(0.05); pumped++;
      const e = R.env();
      nf = +((e.state || {}).nightF ?? -1).toFixed(4);
      const s = e.sun ? +e.sun.intensity.toFixed(3) : -1;
      if (prev === nf && s === sun) break;
      prev = nf; sun = s;
    }
    R.setDay(${dayT}); R.frame(0.05);
    const e = R.env(), st = e.state || {};
    return JSON.stringify({ pumped, nightF: st.nightF ?? null, dayF: st.dayF ?? null,
      duskF: st.duskF ?? null, clock: st.clock ?? null, sun: e.sun ? +e.sun.intensity.toFixed(2) : null });
  })()`));
  console.log(`SKY ${sky} dayT=${dayT} settled in ${settle.pumped} frames · nightF=${settle.nightF} dayF=${settle.dayF} duskF=${settle.duskF} sun=${settle.sun} clock=${settle.clock}`);
  if (settle.nightF === null) console.log(`  ! env().state.nightF is not readable — the follower cannot be proven settled, every ${sky} row may be the previous sky`);
  if (settle.pumped === 0) console.log(`  ! ${sky} settled without advancing — the follower never moved, these rows read the previous sky`);
  for (const [name, x, z, r] of picked) {
    const g = JSON.parse(await ev(`JSON.stringify(window.__RSB.ground(${x}, ${z}))`));
    const eye = Math.max(g.surface ?? 0, g.stand ?? 0, g.drawn ?? 0) + 1.62;
    // Stand off along the bearing from the base centre, so the lens looks back at the settlement —
    // the direction a player arrives from and the one that puts the most emitters in one frame.
    const b = Math.atan2(z, x);
    // Back off until the lens is outside every wall disc it can be. The first sweep's four worst rows
    // (day/pad:motor 9.9 %, day/tap:motor 9.8 %) were not a lighting defect at all: the fixed 9 m
    // stand-off put the eye *inside* a gantry's truss, so the frame was a sunlit beam 1 m from the
    // lens filling the picture. A histogram cannot tell "this surface is over-exposed" from "the
    // camera is inside a surface", and an instrument that cannot tell them apart sends the wrong crew
    // to the wrong file. `walls` is the game's own collider list minus the discs that carry a `floor`
    // — physics.js:249 skips exactly those, so a stand is not a wall here either.
    let off = Math.max(9, r + 4), inN = 0, inProp = null;
    for (; off <= Math.max(9, r + 4) + 27; off += 3) {
      const ax = x + Math.cos(b) * off, az = z + Math.sin(b) * off;
      const hit = walls.filter(w => Math.hypot(ax - w[0], az - w[1]) < w[2]);
      if (!hit.length) { inN = 0; inProp = null; break; }
      inN = hit.length; inProp = hit.map(w => w[3]).filter(Boolean).join(',');
    }
    const at = [+(x + Math.cos(b) * off).toFixed(1), +eye.toFixed(2), +(z + Math.sin(b) * off).toFixed(1)];
    const look = [x, +(eye - 0.4).toFixed(2), z];
    const tag = `${sky}--${name}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const s = await ev(`(async () => {
      const R = window.__RSB;
      R.setDay(${dayT});
      const shot = await R.shot(${JSON.stringify(tag)}, ${JSON.stringify(at)}, ${JSON.stringify(look)}, null);
      // shot() awaits the collector POST, and during that await the game's own rAF tick runs and
      // parks the chase camera back on the rover. A census taken after it therefore describes the
      // rover's frame, not the one whose histogram was just read — the first sweep proved it: all 66
      // rows named the same two emitters at the same 10.4 m and 29.8 m, distances that cannot be
      // constant across 22 vantages. Re-aim at the pose that was shot before asking what is in frame,
      // and carry the camera position out so the reader can check which frame was described.
      const cam = R.camera();
      cam.position.set(${at.join(', ')});
      cam.lookAt(${look.join(', ')});
      const nb = R.nearby(70).filter(o => o.inFrame).slice(0, 2);
      return JSON.stringify({ shot, nb, camPos: cam.position.toArray().map(n => +n.toFixed(2)) });
    })()`);
    const { shot, nb, camPos } = JSON.parse(s);
    // The anchor is not "I set the camera" — that is unfalsifiable. It is that the distances `nearby()`
    // reports for its own objects agree with the pose the histogram was taken at, to within the 1 m
    // rounding of `wp`. On the chase camera they disagree by tens of metres, which is exactly how the
    // first sweep's census was found to be describing the wrong frame.
    const camCheck = nb.length ? +Math.abs(nb[0].dist - Math.hypot(...nb[0].wp.map((n, i) => n - at[i]))).toFixed(1) : null;
    const lamp = shot.cast && shot.cast.lamp;
    // How far off the sun the lens is pointing, read off the key light that actually lit the frame
    // (`shot.key` is the light, not the argument list). A frame aimed into the sun holds a blown disc
    // by physics; a ruler that cannot tell that from a blown *surface* indicts both.
    const view = norm3([look[0] - at[0], look[1] - at[1], look[2] - at[2]]);
    const toSun = shot.key ? norm3(shot.key.pos.map((p, i) => p - shot.key.tgt[i])) : null;
    const sunDeg = toSun ? Math.round(Math.acos(Math.max(-1, Math.min(1, dot3(view, toSun)))) * 57.2958) : null;
    const row = {
      sky, name, at, look, clip: shot.clip, burn: shot.burn,
      blownPx: Math.round(shot.clip * 160),
      burnPct: shot.clip * 160 >= BURN_MIN_BLOWN_PX ? shot.burnPct : null,
      bins: shot.bins, lampShare: lamp ? lamp[3] : null,
      lampChroma: lamp ? +Math.max(lamp[0], lamp[1], lamp[2]).toFixed(3) : null,
      shadowChroma: shot.cast && shot.cast.shadow ? +Math.max(...shot.cast.shadow.slice(0, 3)).toFixed(3) : null,
      shadowSplit: shot.cast && shot.cast.shadow ? `${shot.cast.shadow[4]}/${shot.cast.shadow[5]}` : null,
      key: shot.key && shot.key.i, sunDeg, inN, inProp, off, camPos, camCheck,
      brightest: nb.map(o => `${o.n}@${o.dist}m lum${o.lum}`).slice(0, 2),
    };
    rows.push(row);
    const flags = defects(row);
    console.log(`${flags.length ? '✗' : '·'} ${sky.padEnd(5)} ${name.padEnd(22)} at=${JSON.stringify(row.at)} clip=${String(row.clip).padStart(4)} burn=${String(row.burn).padStart(4)}(${String(row.burnPct).padStart(4)}%) bins=${row.bins.join('/')} lamp=${row.lampChroma}@${row.lampShare} sun=${row.key} sunDeg=${row.sunDeg} off=${row.off}m camCheck=${row.camCheck}` +
      ` shadow=${row.shadowChroma}${row.shadowChroma !== null && row.shadowChroma > CAST_MAX ? '*' : ''}:${row.shadowSplit}${flags.length ? ' ' + flags.join(' ') : ''}` +
      // The pose on the flagged row, so the frame can be re-shot by hand without recomputing it.
      (flags.length ? `\n    look=${JSON.stringify(row.look)} in frame: ${row.brightest.join(' | ')}` : ''));
  }
}
const bad = rows.filter(r => defects(r).length);
// `bins` is an array, so the bar's field is its bottom bucket — sorting on the array itself would
// compare NaN and the "worst" column would quietly name whoever happened to be first.
const worst = f => rows.slice().sort((a, b) => (f === 'bins' ? b.bins[0] - a.bins[0] : (b[f] ?? -1) - (a[f] ?? -1)))
  .slice(0, 5).map(r => `${r.sky}/${r.name}=${f === 'bins' ? r.bins[0] : r[f]}`).join(' ');
console.log(`SUMMARY frames=${rows.length} flagged=${bad.length} · worst clip: ${worst('clip')} · worst bin0: ${worst('bins')} ` +
  `· worst burn share: ${worst('burnPct')}`);
// The three ways this ruler can be quietly reading the wrong thing, counted on their own line so a
// "PASS" cannot be the product of an exclusion nobody had to look at.
const camBad = rows.filter(r => r.camCheck !== null && r.camCheck > 2);
console.log(`COVERAGE vantage-in-geometry=${rows.filter(r => r.inN).length}/${rows.length} · ` +
  `sun-in-frame(<20 deg)=${rows.filter(r => r.sunDeg !== null && r.sunDeg < 20).length}/${rows.length} · ` +
  `census-anchor-fail=${camBad.length}/${rows.length} (nearby() disagrees with the shot pose by > 2 m) · ` +
  `census-empty=${rows.filter(r => r.camCheck === null).length}/${rows.length} (no emitter within 70 m of the pose, so nothing to cross-check) · ` +
  `burn-share-measured=${rows.filter(r => r.burnPct !== null).length}/${rows.length} (>= ${BURN_MIN_BLOWN_PX} blown px)`);
if (camBad.length) console.log(`CENSUS_ANCHOR_FAIL — ${camBad.length} row(s): ${camBad.map(r => `${r.sky}/${r.name}=${r.camCheck}m`).join(' ')} — the "in frame" column there describes a frame other than the one measured, so the sweep cannot be trusted either`);
console.log(`FRAMES ${OUT}/ (PNG, lossless — shot() stopped encoding JPEG, main.js:5141)`);
console.log(bad.length || camBad.length ? `CLIP SWEEP FAIL` : `CLIP SWEEP PASS`);
ws.close(); server.kill();
process.exit(bad.length || camBad.length ? 1 : 0);
