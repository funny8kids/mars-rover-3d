#!/usr/bin/env node
// tools/beam-level-ladder.mjs — how bright can a shaft of light get, and what does it cost the frame?
//
// The same shape as tools/emissive-ladder.mjs, for the half of the base whose brightness is not an
// `emissiveIntensity`: the `fx/beams.js` shafts are ShaderMaterials and their drive is `uLevel`. #104
// moved the launch pad's five light-show searchlights onto that shader, and the drive they arrived with
// was `opacity: 0.016 + 0.012·sin` — a peak of 0.028 that a ShaderMaterial has no use for. The number
// cannot be carried over, because `uLevel` is multiplied by the grazing falloff, by exp(-s·1.15) and by
// the run-out before it reaches a pixel: the same value on the new material is a different brightness.
//
//   node tools/beam-level-ladder.mjs <url-regex> <port> <at-json> <look-json> <day|dusk|night> <ladder> [shot-tag]
//
// Each rung is printed twice over: the frame with this layer at 0 and the frame at the rung, rendered
// back to back inside one eval and differenced against each other. That makes the two halves of the
// judgement readable at once: `clip` is the ceiling (the sweep's gate is 0.5 % of the sample blown), and
// `touch`/`mean+` are how much of the frame the layer is actually carrying. A shaft layer can fail in
// either direction — too hot it eats the vehicle it is supposed to be shining on, too cold it is a
// decoration nobody sees — and a rung table that only prints `clip` reports "clean" for the second one.
//
// The dark frame is taken per rung rather than once for the run because the scene is not still between
// two renders: `envUpdateHz` refreshes the environment about twice a second, so a rung-0 base captured
// at the start of the ladder has drifted by the time the last rung reads it, and the drift lands in
// `touch` as if it were light. Run C of tools/logs/beam-level-ladder-2026-09-27.txt is that flaw: an
// apron row reporting 30 % touched with mean +11.6 for a layer whose true reading is 14 % at +18.
//
// Rung 0 is the control and is printed. It is `shoot(0)` twice, so its `touch` is the noise floor of
// this pairing — the frame's own drift over the two renders, with no light in either. If no brighter
// rung moves `touch` or `mean+` past that floor, the tool says so: that is the ladder failing to reach
// the frame, not a ceiling.
import { once } from 'node:events';

const [,, urlRe, portStr, atArg, lookArg, skyArg, ladderArg, shotTag] = process.argv;
const usage = 'usage: node tools/beam-level-ladder.mjs <url-regex> <port> <at-json> <look-json> <day|dusk|night> <l0,l1,...> [shot-tag]';
if (!urlRe || !portStr || !atArg || !lookArg || !skyArg || !ladderArg) { console.log('ARGV — ' + usage); process.exit(2); }
const PORT = Number(portStr);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) { console.log(`BAD_PORT ${portStr} — ${usage}`); process.exit(2); }
const DAY_T = { day: 0.30, dusk: 0.76, night: 0.90 };
const SKY = skyArg.toLowerCase();
const dayT = DAY_T[SKY];
if (dayT === undefined) { console.log(`BAD_SKY ${skyArg} — known: ${Object.keys(DAY_T).join(',')}`); process.exit(2); }
let AT, LOOK;
try { AT = JSON.parse(atArg); LOOK = JSON.parse(lookArg); } catch { console.log('BAD_JSON — ' + usage); process.exit(2); }
if (![...AT, ...LOOK].every(Number.isFinite) || AT.length !== 3 || LOOK.length !== 3) { console.log('BAD_VEC — at/look each [x,y,z]'); process.exit(2); }
const LADDER = ladderArg.split(',').map(Number);
if (!LADDER.length || !LADDER.every(Number.isFinite)) { console.log(`BAD_LADDER ${ladderArg}`); process.exit(2); }
if (LADDER[0] !== 0) console.log(`  ! the first rung is ${LADDER[0]}, not 0 — no row here is the dark-vs-dark control, so nothing prints the noise floor the touch column sits on`);
let RE; try { RE = new RegExp(urlRe); } catch (e) { console.log(`BAD_REGEX ${e.message}`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && RE.test(t.url));
if (!page) {
  console.log(`NO_PAGE_TARGET — no tab URL matches /${urlRe}/ at :${PORT}; pages: ` +
    list.filter(t => t.type === 'page').map(t => t.url).join(' | '));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await once(ws, 'open').catch(() => { console.log('WS_OPEN_FAIL'); process.exit(1); });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return;
  }
};
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'EVAL_THREW');
  return r.result.value;
};
await send('Runtime.enable');
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  ready = await ev(`!!(window.__RSB && window.__RSB.show && window.__RSB.shot && window.__RSB.state && window.__RSB.state.started)`).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { console.log('NEVER_READY — __RSB.state.started never became true on this tab'); ws.close(); process.exit(1); }

// Close the show first: while it runs the frame loop rewrites `uLevel` every tick, so a pinned rung
// would be overwritten between the write and the render.
const closed = JSON.parse(await ev(`JSON.stringify(window.__RSB.show(0))`));
console.log(`SHAFTS ${closed.shafts.length} · hues ${closed.shafts.map(s => s.hue).join(' ')} · feet axisR ${[...new Set(closed.shafts.map(s => s.axisR))].join(',')} m · levels ${closed.shafts.map(s => s.level).join(',')}`);
if (!closed.shafts.length) { console.log('NO_SHAFTS — the ladder would scan nothing and report a clean frame for free'); ws.close(); process.exit(1); }

const settle = JSON.parse(await ev(`(async () => {
  const R = window.__RSB; R.clearSky(); R.setDay(${dayT});
  let prev = -1, pumped = 0, nf = 0, sun = -1;
  for (let k = 0; k < 400; k++) {
    R.show(0); R.frame(0.05); pumped++;
    const e = R.env(); nf = +((e.state || {}).nightF ?? -1).toFixed(4);
    const s = e.sun ? +e.sun.intensity.toFixed(3) : -1;
    if (prev === nf && s === sun) break;
    prev = nf; sun = s;
  }
  R.setDay(${dayT}); R.show(0); R.frame(0.05);
  const st = (R.env() || {}).state || {};
  return JSON.stringify({ pumped, nightF: st.nightF ?? null, dayF: st.dayF ?? null, fog: R.scene().fog ? +R.scene().fog.density.toFixed(5) : null, clock: st.clock ?? null });
})()`));
const buf = JSON.parse(await ev(`JSON.stringify((()=>{const r=window.__RSB.post().composer.renderer.domElement;return [r.width,r.height]})())`));
console.log(`TARGET ${page.url} · buffer ${buf[0]}x${buf[1]} · pose at=${JSON.stringify(AT)} look=${JSON.stringify(LOOK)}`);
console.log(`SKY ${SKY} settled in ${settle.pumped} frames · nightF=${settle.nightF} dayF=${settle.dayF} fog=${settle.fog} clock=${settle.clock}`);
if (settle.pumped === 0) console.log('  ! settled without advancing — the ladder may be reading the previous sky');
console.log('UNITS clip = % of the 16 000-px (160x100) sample (sweep gate: ≤ 0.5 %) · bins = ‰ ·');
console.log('      self% = the same clip with this layer at 0 — the frame blows that many on its own, so a');
console.log('      clip equal to self% is the scene, not this layer ·');
console.log('      touch/mean+/max+ are this layer alone: the rung frame minus the dark frame, px with Δlum > 3;');
console.log('      lift = the whole 16 000-px frame mean, lit minus dark — the number a vantage is judged by');
console.log('');
console.log(`  ${'uLevel'.padStart(7)}  ${'clip%'.padStart(6)}  ${'self%'.padStart(6)}  ${'blown'.padStart(6)}  ${'bin7‰'.padStart(6)}  ${'bin0‰'.padStart(6)}  ${'touch%'.padStart(7)}  ${'mean+'.padStart(6)}  ${'max+'.padStart(5)}  ${'lift'.padStart(5)}  ${'peakLum'.padStart(8)}  peak cell owner @ rgb`);
const rows = [];
for (const e of LADDER) {
  const r = JSON.parse(await ev(`(async () => {
    const T = await import('three');
    const R = window.__RSB, cam = R.camera(), sc = R.scene(), P = R.post();
    cam.position.set(${AT.join(', ')}); cam.lookAt(${LOOK.join(', ')}); cam.updateMatrixWorld(true);
    const W = 160, H = 100;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    // Addressed by uuid, not by "has a uLevel uniform": thirteen other shafts in this scene answer to
    // the same name (the pad's six flood shafts, the grid rigs' seven), and pinning those would have
    // this table report a ceiling for the whole night's lighting instead of for these five.
    let ids = null, mats = null;
    // One shot: pin the rung on these five shafts and only these, hold the shimmer fixed so the two
    // frames can differ in brightness and in nothing else, render, and return the sample.
    // show(0, rung) closes the show first — while it runs the frame loop rewrites uLevel every tick,
    // so a pinned rung would be overwritten between the write and the render.
    const shoot = (lv) => {
      const back = R.show(0, lv);
      if (!mats) {
        ids = new Set(back.shafts.map((s) => s.id));
        mats = [];
        sc.traverse((o) => { if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uLevel && ids.has(o.material.uuid)) mats.push(o.material); });
      }
      const fogD = sc.fog ? sc.fog.density : 0;
      for (const m of mats) {
        m.uniforms.uTime.value = 4.0; m.uniforms.uWander.value = 0;
        m.uniforms.uCam.value.copy(cam.position); m.uniforms.uFogDen.value = fogD;
      }
      R.setDay(${dayT});
      P.composer.render();
      g2.drawImage(P.composer.renderer.domElement, 0, 0, W, H);
      const q = g2.getImageData(0, 0, W, H).data;
      const lum = new Float32Array(W * H);
      const bins = new Array(8).fill(0); const px = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const l = 0.2126 * q[i] + 0.7152 * q[i + 1] + 0.0722 * q[i + 2];
        lum[y * W + x] = l; bins[l >> 5]++;
        px.push({ x, y, lum: l, rgb: [q[i], q[i + 1], q[i + 2]] });
      }
      const meanLum = lum.reduce((a, b) => a + b, 0) / lum.length;
      return { bins, lum, meanLum, px, read: back.shafts.map((s) => s.level), pinned: mats.length };
    };
    // Dark and lit, adjacent: the scene's own ~2 Hz environment refresh moves the frame between two
    // renders, and a base held across the whole ladder would hand that drift to the touch column as light.
    const dark = shoot(0);
    const shot = shoot(${e});
    let touch = 0, sum = 0, mx = 0;
    for (let k = 0; k < shot.lum.length; k++) { const d = shot.lum[k] - dark.lum[k]; if (d > 3) { touch++; sum += d; if (d > mx) mx = d; } }
    const px = shot.px; px.sort((a, b) => b.lum - a.lum);
    const rc = new T.Raycaster(), ndc = new T.Vector2(), out = [];
    for (const k of px.slice(0, 12)) {
      ndc.set((k.x + 0.5) / W * 2 - 1, -((k.y + 0.5) / H * 2 - 1));
      rc.setFromCamera(ndc, cam);
      const h = rc.intersectObjects(sc.children, true).filter(z => z.object.visible)[0];
      out.push({ name: h ? (h.object.name || (ids.has((h.object.material || {}).uuid) ? 'SEARCHLIGHT' : 'unnamed')) : 'SKY/NO-HIT',
        d: h ? +h.distance.toFixed(2) : null, lum: +k.lum.toFixed(1), rgb: k.rgb });
    }
    return JSON.stringify({ read: shot.read, pinned: shot.pinned, touch, mean: touch ? +(sum / touch).toFixed(1) : 0,
      max: +mx.toFixed(1), blown: shot.bins[7], clip: +(shot.bins[7] / (W * H) * 100).toFixed(1),
      darkBlown: dark.bins[7], darkClip: +(dark.bins[7] / (W * H) * 100).toFixed(1),
      darkMean: +dark.meanLum.toFixed(2), litMean: +shot.meanLum.toFixed(2),
      lift: +(shot.meanLum - dark.meanLum).toFixed(2),
      bins: shot.bins.map(b => Math.round(b / 16)), top: out });
  })()`));
  if (r.pinned !== closed.shafts.length) console.log(`    ! pinned ${r.pinned} of ${closed.shafts.length} shafts — the ladder is not moving everything it matched`);
  if (r.read.some(v => Math.abs(v - e) > 0.0002)) console.log(`    ! the API read back ${r.read.join(',')} for the requested rung ${e}`);
  const t = r.top[0];
  rows.push({ e, ...r });
  console.log(`  ${String(e).padStart(7)}  ${String(r.clip).padStart(6)}  ${String(r.darkClip).padStart(6)}  ${String(r.blown).padStart(6)}  ${String(r.bins[7]).padStart(6)}  ${String(r.bins[0]).padStart(6)}  ${(r.touch / 160).toFixed(2).padStart(7)}  ${String(r.mean).padStart(6)}  ${String(r.max).padStart(5)}  ${String(r.lift).padStart(5)}  ${String(t.lum).padStart(8)}  ${t.name} d=${t.d} rgb=[${t.rgb}]`);
  // The two frames that settle the judgement: the rung the layer is absent from, and the rung it ships
  // at. Everything else in the table is a number, and a number cannot say whether five columns of light
  // ringing a pad read as a show or as a smudge over the ship.
  if (shotTag !== undefined && (e === 0 || e === Number(shotTag))) {
    const tag = `${shotTag}-rung${e}`;
    const s = JSON.parse(await ev(`(async () => { const R = window.__RSB; R.setDay(${dayT}); return JSON.stringify(await R.shot(${JSON.stringify(tag)}, ${JSON.stringify(AT)}, ${JSON.stringify(LOOK)}, null)); })()`));
    console.log(`    shot ${tag}.png → clip=${s.clip} burn=${s.burn} bins=${s.bins.join('/')}`);
  }
}
const control = rows[0];
const floor = control.e === 0 ? control.touch : 0;
const lit = rows.slice(1).filter(r => r.touch > floor);
console.log('');
if (control.e === 0) {
  console.log(`NOISE FLOOR rung 0 is dark vs dark: ${control.touch} px touched (${(control.touch / 160).toFixed(2)} %) at mean +${control.mean}, max +${control.max}` +
    ` — that is the frame's own drift between the paired renders, with no light in either of them`);
} else {
  console.log(`NOISE FLOOR not measured — the first rung is ${control.e}, so nothing sits under the touch column`);
}
console.log(`CONTROL rung ${control.e} vs the ${rows.length - 1} brighter rungs: ${lit.length} put more light in the frame than that floor` +
  (lit.length ? '' : ' — THE LAYER NEVER REACHED THIS FRAME, every "clip 0" above is meaningless'));
const clean = rows.filter(r => r.clip === 0);
console.log(`ceiling: highest rung measured with clip 0 = ${clean.length ? clean[clean.length - 1].e : 'none — every rung blows'}`);
console.log(`LADDER_RC=${lit.length ? 0 : 1}`);
ws.close();
process.exit(lit.length ? 0 : 1);
