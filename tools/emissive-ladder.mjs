#!/usr/bin/env node
// tools/emissive-ladder.mjs — how bright can this material get before the frame's own ruler says no?
//
// The clip gate (tools/cdp-clip-sweep.mjs, CLIP_MAX = 0.5 %) is judged on the shipped, animating
// emissive, which means a pulsing material is measured at whatever phase the render happened to
// land on. This scan removes the phase: it pins one material's emissiveIntensity to each rung of a
// ladder, renders, and reads the sweep's own histogram back off that frame. The top rung whose
// clip is 0 is the ceiling the shipped formula's PEAK has to stay under — not its mean, not the
// frame it was sampled in.
//
//   node tools/emissive-ladder.mjs <url-regex> <port> <at-json> <look-json> <sky> <mesh-name-regex> <ladder>
//
// e.g.  node tools/emissive-ladder.mjs 5173 9336 '[43.3,2.36,-93.4]' '[39.5,1.96,-85.2]' night \
//         '^crystal' '1.19,1.0,0.85,0.7,0.55,0.4,0.3,0.2'
//
// Conventions (settle loop, 160x100 sample, >>5 bins, lum >= 224 blown band, per-cell raycast) are
// the same as tools/clip-attribution-probe.mjs, whose header cites every page-side API used here.
import { once } from 'node:events';

const [,, urlRe, portStr, atArg, lookArg, skyArg, nameArg, ladderArg] = process.argv;
const usage = 'usage: node tools/emissive-ladder.mjs <url-regex> <port> <at-json> <look-json> <day|dusk|night> <mesh-name-regex> <e1,e2,...>';
if (!urlRe || !portStr || !atArg || !lookArg || !skyArg || !nameArg || !ladderArg) { console.log('ARGV — ' + usage); process.exit(2); }
const PORT = Number(portStr);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) { console.log(`BAD_PORT ${portStr} — ${usage}`); process.exit(2); }
const DAY_T = { day: 0.30, dusk: 0.76, night: 0.90 };
const SKY = skyArg.toLowerCase();
const dayT = DAY_T[SKY];
if (dayT === undefined) { console.log(`BAD_SKY ${skyArg} — known: ${Object.keys(DAY_T).join(',')}`); process.exit(2); }
let AT, LOOK;
try { AT = JSON.parse(atArg); LOOK = JSON.parse(lookArg); } catch { console.log('BAD_JSON — ' + usage); process.exit(2); }
if (![...AT, ...LOOK].every(Number.isFinite) || AT.length !== 3 || LOOK.length !== 3) { console.log('BAD_VEC — at/look each [x,y,z]'); process.exit(2); }
let RE, NRE;
try { RE = new RegExp(urlRe); NRE = new RegExp(nameArg); } catch (e) { console.log(`BAD_REGEX ${e.message}`); process.exit(2); }
const LADDER = ladderArg.split(',').map(Number);
if (!LADDER.length || !LADDER.every(Number.isFinite)) { console.log(`BAD_LADDER ${ladderArg}`); process.exit(2); }

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
  ready = await ev(`!!(window.__RSB && window.__RSB.shot && window.__RSB.state && window.__RSB.state.started)`).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { console.log('NEVER_READY — __RSB.state.started never became true on this tab'); ws.close(); process.exit(1); }

const buf = JSON.parse(await ev(`JSON.stringify((()=>{const r=window.__RSB.post().composer.renderer.domElement;return [r.width,r.height]})())`));
console.log(`TARGET ${page.url} · sky=${SKY} dayT=${dayT} · pose at=${JSON.stringify(AT)} look=${JSON.stringify(LOOK)} · buffer ${buf[0]}x${buf[1]}`);
console.log('UNITS clip = % of the 16 000-px (160x100) sample (sweep gate: ≤ 0.5 %) · bins = ‰ · lum = the same 0.2126r+0.7152g+0.0722b ruler');

// How many meshes carry the name, and which material(s)? Read it before pinning so a ladder that
// silently finds zero targets cannot report "clean".
const found = JSON.parse(await ev(`(()=>{const R=window.__RSB,N=${JSON.stringify(nameArg)};const re=new RegExp(N);const out=[];
  R.scene().traverse(o=>{if(!o.isMesh||!re.test(o.name||''))return;const ms=Array.isArray(o.material)?o.material:[o.material];
    ms.forEach(m=>{if(m&&m.emissive)out.push([o.name,m.uuid,+m.emissiveIntensity.toFixed(4),m.emissive.getHexString()]);});});
  return JSON.stringify({n:out.length,mats:[...new Set(out.map(r=>r[1]))].length,ei:[...new Set(out.map(r=>r[2]))],hex:[...new Set(out.map(r=>r[3]))]})})()`));
console.log(`MATCH /${nameArg}/ on ${found.n} mesh-material pairs across ${found.mats} materials · emissive ${found.hex.join(',')} @ live intensity ${found.ei.join(', ')}`);
if (!found.n) { console.log('NO_MATCH — the ladder would scan nothing and report a clean frame for free'); ws.close(); process.exit(1); }

const settle = JSON.parse(await ev(`(async () => {
  const R = window.__RSB; R.clearSky(); R.setDay(${dayT});
  let prev = -1, pumped = 0, nf = 0, sun = -1;
  for (let k = 0; k < 400; k++) {
    R.frame(0.05); pumped++;
    const e = R.env(); nf = +((e.state || {}).nightF ?? -1).toFixed(4);
    const s = e.sun ? +e.sun.intensity.toFixed(3) : -1;
    if (prev === nf && s === sun) break;
    prev = nf; sun = s;
  }
  R.setDay(${dayT}); R.frame(0.05);
  const st = (R.env() || {}).state || {};
  return JSON.stringify({ pumped, nightF: st.nightF ?? null, dayF: st.dayF ?? null, clock: st.clock ?? null });
})()`));
console.log(`SKY ${SKY} settled in ${settle.pumped} frames · nightF=${settle.nightF} dayF=${settle.dayF} clock=${settle.clock}`);
if (settle.pumped === 0) console.log('  ! settled without advancing — the ladder may be reading the previous sky');

console.log('');
console.log(`  ${'e'.padStart(6)}  ${'clip%'.padStart(6)}  ${'blown'.padStart(6)}  ${'bin7‰'.padStart(6)}  ${'bin6‰'.padStart(6)}  ${'bin0‰'.padStart(6)}  ${'peakLum'.padStart(8)}  peak cell owner @ its lum`);
for (const e of LADDER) {
  const r = JSON.parse(await ev(`(async () => {
    const T = await import('three');
    const R = window.__RSB, cam = R.camera(), sc = R.scene(), P = R.post();
    const re = new RegExp(${JSON.stringify(nameArg)});
    let pinned = 0;
    sc.traverse(o => { if (!o.isMesh || !re.test(o.name || '')) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(m => { if (m && m.emissive) { m.emissiveIntensity = ${e}; pinned++; } }); });
    R.setDay(${dayT});
    cam.position.set(${AT.join(', ')}); cam.lookAt(${LOOK.join(', ')}); cam.updateMatrixWorld(true);
    P.composer.render();
    const W = 160, H = 100;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    g2.drawImage(P.composer.renderer.domElement, 0, 0, W, H);
    const q = g2.getImageData(0, 0, W, H).data;
    const bins = new Array(8).fill(0); const px = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = 0.2126 * q[i] + 0.7152 * q[i + 1] + 0.0722 * q[i + 2];
      bins[lum >> 5]++;
      px.push({ x, y, lum, rgb: [q[i], q[i + 1], q[i + 2]] });
    }
    px.sort((a, b) => b.lum - a.lum);
    const top = px.slice(0, 12);
    const rc = new T.Raycaster(), ndc = new T.Vector2(), out = [];
    for (const k of top) {
      ndc.set((k.x + 0.5) / W * 2 - 1, -((k.y + 0.5) / H * 2 - 1));
      rc.setFromCamera(ndc, cam);
      const h = rc.intersectObjects(sc.children, true).filter(z => z.object.visible)[0];
      const m = h ? (Array.isArray(h.object.material) ? h.object.material[0] : h.object.material) : null;
      out.push({ name: h ? (h.object.name || 'unnamed') : 'SKY/NO-HIT', ei: m && m.emissive ? +m.emissiveIntensity.toFixed(3) : null,
                 hex: m && m.emissive ? m.emissive.getHexString() : null, d: h ? +h.distance.toFixed(2) : null,
                 lum: +k.lum.toFixed(1), rgb: k.rgb });
    }
    // No restore: every rung re-pins the intensity before it renders, and the game's own update()
    // overwrites the live pulse on the next frame anyway (src/main.js:2238).
    return JSON.stringify({ pinned, blown: bins[7], clip: +(bins[7] / (W * H) * 100).toFixed(1),
      bins: bins.map(b => Math.round(b / 16)), top: out });
  })()`));
  const t = r.top[0];
  console.log(`  ${String(e).padStart(6)}  ${String(r.clip).padStart(6)}  ${String(r.blown).padStart(6)}  ${String(r.bins[7]).padStart(6)}  ${String(r.bins[6]).padStart(6)}  ${String(r.bins[0]).padStart(6)}  ${String(t.lum).padStart(8)}  ${t.name}${t.hex ? ` ${t.hex}@${t.ei}` : ''} d=${t.d} rgb=[${t.rgb}]`);
  if (r.pinned !== found.n) console.log(`    ! pinned ${r.pinned} of ${found.n} material slots — the ladder is not moving everything it matched`);
}
console.log('');
console.log(`bin6‰ is where the crystal has to live to stay a lit stone rather than a white disc; bin0‰ is the sweep's dead-black gate (≤ 30 ‰).`);
console.log('LADDER_RC=0');
ws.close();
