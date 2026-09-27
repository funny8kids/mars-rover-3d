#!/usr/bin/env node
// tools/legacy-beam-layer-probe.mjs — how much light did the pre-#104 searchlight cones put in a frame?
//
// #104 replaced five `CylinderGeometry(0.5, 2.6, 56, 12, 1, true)` additive cones with `UNIT_BEAM` on
// `shaftMaterial`, and `src/main.js`'s drive with `opacity`. That swap changes what a given number
// delivers, so the new amplitude cannot be carried across it by taste: it has to be chosen against the
// old layer's measured contribution. This probe is that measurement.
//
// It runs against a build that still has the cones — i.e. a checkout of a commit before #104 — because
// its job is to read a layer that no longer exists in the working tree. Serve an old worktree (the run
// recorded in tools/logs/beam-level-ladder-2026-09-27.txt used a `git archive` mirror of 79775a0 on
// :5174) and point the tab at it. The cone materials are found by their five shipped hues plus
// additive `MeshBasicMaterial`, and the geometry parameters are printed so a match cannot be mistaken
// for some other additive cone in the scene.
//
// The show timer that drives `opacity` in game (a 14-second window opened only by parking a rover at
// the pad) is unreachable from here, so the probe writes the shipped peak by hand: with the old
// envelope `(0.016 + 0.012·sin)·nightF` at nightF=1, the crest is 0.028.
//
// Ruler: identical to tools/beam-level-ladder.mjs — same pose handling, same settle, same 160x100
// sample, same luminance, same difference-against-level-0. So "12.7 % of the sample holding +20.9"
// from here and the same words from the ladder are directly comparable.
//
//   node tools/legacy-beam-layer-probe.mjs <url-regex> <port> <at-json> <look-json> <opacity>
//
// e.g.  node tools/legacy-beam-layer-probe.mjs 5174 9337 '[25,2.2,-58]' '[-60,18,-60]' 0.028
import { once } from 'node:events';

const [,, urlRe, portStr, atArg, lookArg, opArg] = process.argv;
const usage = 'usage: node tools/legacy-beam-layer-probe.mjs <url-regex> <port> <at-json> <look-json> <opacity>';
if (!urlRe || !portStr || !atArg || !lookArg || !opArg) { console.log('ARGV — ' + usage); process.exit(2); }
const PORT = Number(portStr);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) { console.log(`BAD_PORT ${portStr} — ${usage}`); process.exit(2); }
let AT, LOOK;
try { AT = JSON.parse(atArg); LOOK = JSON.parse(lookArg); } catch { console.log('BAD_JSON — ' + usage); process.exit(2); }
if (![...AT, ...LOOK].every(Number.isFinite) || AT.length !== 3 || LOOK.length !== 3) { console.log('BAD_VEC — at/look each [x,y,z]'); process.exit(2); }
const OP = Number(opArg);
if (!Number.isFinite(OP)) { console.log(`BAD_OPACITY ${opArg} — ${usage}`); process.exit(2); }
let RE;
try { RE = new RegExp(urlRe); } catch (e) { console.log(`BAD_REGEX ${e.message}`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && RE.test(t.url));
if (!page) {
  console.log(`NO_PAGE_TARGET — no open tab URL matches /${urlRe}/ at :${PORT}; pages here: ` +
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
  ready = await ev(`!!(window.__RSB && window.__RSB.state && window.__RSB.state.started)`).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { console.log('NEVER_READY — __RSB.state.started never became true on this tab'); ws.close(); process.exit(1); }

// The five hues the launch block ships, plus "additive MeshBasicMaterial", plus the exact cylinder
// parameters printed so a pass here can only mean these cones.
const found = JSON.parse(await ev(`(async () => {
  const T = await import('three'); const out = [];
  const H = [0x8fd4ff, 0xffb066, 0xc79cff, 0x8fffe0, 0xff9ab0];
  window.__RSB.scene().traverse(o => {
    if (!o.isMesh) return;
    const m = o.material;
    if (!(m && m.isMeshBasicMaterial && m.blending === T.AdditiveBlending && H.includes(m.color.getHex()))) return;
    const p = o.geometry?.parameters ?? {};
    out.push({ hue: m.color.getHex().toString(16), rTop: +p.radiusTop, rBot: +p.radiusBottom,
               h: p.height, seg: p.radialSegments, open: p.openEnded, opacity: +m.opacity.toFixed(4) });
  });
  return JSON.stringify({ n: out.length, rows: out });
})()`));
console.log(`MATCHED additive MeshBasicMaterial cones with a searchlight hue: ${found.n}`);
for (const r of found.rows) console.log(`  #${r.hue} CylinderGeometry(${r.rTop}, ${r.rBot}, ${r.h}, ${r.seg}, _, ${r.open}) @ opacity ${r.opacity}`);
if (!found.n) {
  console.log('NO_CONES — this build has no searchlight cones to probe; #104 already landed here, so the number this tool exists to give cannot be taken.');
  ws.close(); process.exit(1);
}
const shapeOK = found.rows.every(r => r.rTop === 0.5 && r.rBot === 2.6 && r.h === 56 && r.seg === 12);
if (!shapeOK) console.log('  ! a matched cone is not the documented (0.5, 2.6, 56, 12) shape — check the hues are not shared with another additive cone');

await ev(`(async () => {
  const R = window.__RSB; R.clearSky(); R.setDay(0.90);
  for (let k = 0; k < 400; k++) R.frame(0.05);
  R.setDay(0.90); R.frame(0.05); return 1;
})()`);
const settle = JSON.parse(await ev(`JSON.stringify((()=>{const s=(window.__RSB.env()||{}).state||{};return {nightF:+((s.nightF??0).toFixed(4)),clock:s.clock??null}})())`));

const run = JSON.parse(await ev(`(async () => {
  const R = window.__RSB, cam = R.camera(), P = R.post();
  const T = await import('three');
  const H = [0x8fd4ff, 0xffb066, 0xc79cff, 0x8fffe0, 0xff9ab0];
  const mats = [];
  R.scene().traverse(o => { const m = o.material;
    if (m && m.isMeshBasicMaterial && m.blending === T.AdditiveBlending && H.includes(m.color.getHex())) mats.push(m); });
  const W = 160, H2 = 100;
  const c = document.createElement('canvas'); c.width = W; c.height = H2;
  const g2 = c.getContext('2d', { willReadFrequently: true });
  const shoot = () => {
    cam.position.set(${AT.join(',')}); cam.lookAt(${LOOK.join(',')}); cam.updateMatrixWorld(true);
    P.composer.render();
    g2.drawImage(P.composer.renderer.domElement, 0, 0, W, H2);
    const q = g2.getImageData(0, 0, W, H2).data;
    const lum = new Float32Array(W * H2); const bins = new Array(8).fill(0);
    for (let i = 0; i < W * H2; i++) { const j = i * 4;
      const l = 0.2126 * q[j] + 0.7152 * q[j + 1] + 0.0722 * q[j + 2]; lum[i] = l; bins[l >> 5]++; }
    return { lum, bins };
  };
  for (const m of mats) m.opacity = 0;
  const A = shoot();
  for (const m of mats) m.opacity = ${OP};
  const B = shoot();
  let touch = 0, sum = 0, mx = 0;
  for (let i = 0; i < A.lum.length; i++) { const d = B.lum[i] - A.lum[i]; if (d > 3) { touch++; sum += d; if (d > mx) mx = d; } }
  return JSON.stringify({ mats: mats.length,
    darkClip: +(A.bins[7] / 160).toFixed(2), litClip: +(B.bins[7] / 160).toFixed(2),
    darkBlown: A.bins[7], litBlown: B.bins[7], bin0: B.bins[0], touchPx: touch,
    touchPct: +(touch / 160).toFixed(2),
    darkMean: +(A.lum.reduce((s, v) => s + v, 0) / 16000).toFixed(2),
    litMean: +(B.lum.reduce((s, v) => s + v, 0) / 16000).toFixed(2),
    mean: +(touch ? sum / touch : 0).toFixed(3), max: +mx.toFixed(3) });
})()`));

console.log('');
const buf = JSON.parse(await ev(`JSON.stringify((()=>{const r=window.__RSB.post().composer.renderer.domElement;return [r.width,r.height]})())`));
console.log(`POSE at=${JSON.stringify(AT)} look=${JSON.stringify(LOOK)} · sky=night nightF=${settle.nightF} clock=${settle.clock} · buffer ${buf[0]}x${buf[1]}`);
console.log('UNITS clip = % of the 16 000-px (160x100) sample · touch% = px with |Δlum| > 3, this layer alone');
console.log(`      (Δlum = this frame minus the same frame with the five cones at opacity 0) · lum = 0.2126r+0.7152g+0.0722b`);
console.log(`HEAD_OPACITY ${OP} → ${JSON.stringify(run)}`);
if (!run.touchPx) console.log('  THE LAYER PUT NO LIGHT IN THIS FRAME — the pose cannot see the cones, so parity against it is meaningless');
console.log('PROBE_RC=0');
ws.close();
