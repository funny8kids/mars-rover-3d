// tools/clip-attribution-probe.mjs — real attribution for ONE failing clip frame: instead of naming
// the scene's brightest candidates by inference (the sweep's `in frame:` column), raycast every blown
// histogram cell through the live camera and report which object actually owns that pixel, at what
// depth, with what material/emissive read at that exact moment.
//
//   node tools/clip-attribution-probe.mjs <url-match-regex> <port> <at-json> <look-json> <sky>
//
// e.g.  node tools/clip-attribution-probe.mjs 5173 9333 '[-13.5,2.22,19.9]' '[39.5,1.96,-85.2]' night
//
// Conventions are copied from tools/cdp-clip-sweep.mjs, with the page-side API each one uses cited
// below. The tab must already be open — this probe never navigates, spawns a server, or touches git;
// it only attaches to the CDP endpoint and evaluates into the live page.
//
// Page-side API evidence (all file:line verified by grep in this repo):
//   window.__RSB test hook ................. src/main.js:2770
//   __RSB.clearSky ............................. src/main.js:2816
//   __RSB.setDay ............................... src/main.js:2873
//   __RSB.env (state.nightF / sun follower) .. src/main.js:2877  (read by the sweep's settle loop,
//       cdp-clip-sweep.mjs:145-162, pumped with __RSB.frame below until nightF+sun stop moving)
//   __RSB.pois (interactive points, used here only to LABEL the vantage, e.g. "sample:4")
//       ....................................... src/main.js:3445
//   __RSB.solids (collider discs) ............ src/main.js:3450   — NOT used: the vantage is handed
//       in on argv rather than derived, so no wall-clearance walk is needed.
//   __RSB.post (composer + bloom) ............ src/main.js:3485 (object built src/main.js:359;
//       .composer.render() as used by shot() at src/main.js:5064)
//   __RSB.camera ............................. src/main.js:3486
//   __RSB.scene .............................. src/main.js:3487
//   __RSB.frame (one manual game tick) ....... src/main.js:3496
//   __RSB.shot (the ruler being reproduced) .. src/main.js:5055 — posed via
//       R.shot(tag, at, look, null) in the sweep (cdp-clip-sweep.mjs:192); the null key light means
//       "keep the sky's own sun" (src/main.js:5059-5061), so calling shot() itself would only add a
//       PNG POST to the :8123 collector (src/main.js:5175) and a camera re-aim the rAF tick undoes
//       (cdp-clip-sweep.mjs:196-201). This probe therefore does, synchronously in ONE evaluate,
//       exactly what shot() would have done with sunAt=null: cam.position.set + cam.lookAt
//       (src/main.js:5062-5063) + post.composer.render() (src/main.js:5064).
//   framebuffer read: 160x100 drawImage of renderer.domElement, 16 000 px, luminance
//       0.2126r+0.7152g+0.0722b binned `>> 5` into 8 bins ..... src/main.js:5084-5095, per-mille
//       bins print at src/main.js:5176; blown band = lum >= 224 and clip = blown/16000*100 (one
//       decimal) .................. src/main.js:5158-5165 — identical population to bins[7].
//   object naming for unnamed merged meshes (`geometry.type:{params}`) ... src/main.js:5195 (nearby)
//   raycast idiom (Raycaster.setFromCamera(Vector2 NDC, camera) against scene.children, filtered by
//       h.object.visible) .................................. src/main.js:5243-5246 (__RSB.pick)
//   in-page THREE via `await import('three')` — the app's vendored module, resolved by the import
//       map "three": "./vendor/three/build/three.module.js" (REVISION 169) at index.html:107-111;
//       same route as cdp-live-cadence.mjs:100 / cdp-tour-audit.mjs:187 / cdp-frame-cost.mjs:110.
//   CDP attach (fetch http://127.0.0.1:<port>/json/list, pick type==='page' matching the URL regex,
//       WebSocket to webSocketDebuggerUrl, Runtime.evaluate returnByValue+awaitPromise) .......
//       cdp-clip-sweep.mjs:62-86. Readiness gate (state.started): cdp-clip-sweep.mjs:88-92.
//   sky setpoints day/dusk/night = 0.30/0.76/0.90 ........... cdp-clip-sweep.mjs:25.
import { once } from 'node:events';

const [,, urlRe, portStr, atArg, lookArg, skyArg] = process.argv;
const usage = 'usage: node tools/clip-attribution-probe.mjs <url-match-regex> <port> <at-json> <look-json> <day|dusk|night>';
if (!urlRe || !portStr || !atArg || !lookArg || !skyArg) { console.log('ARGV — ' + usage); process.exit(2); }
const PORT = Number(portStr);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) { console.log(`BAD_PORT ${portStr} — ${usage}`); process.exit(2); }
// same DAY_T table the sweep settles with (cdp-clip-sweep.mjs:25)
const DAY_T = { day: 0.30, dusk: 0.76, night: 0.90 };
const SKY = (skyArg || '').toLowerCase();
const dayT = DAY_T[SKY];
if (dayT === undefined) { console.log(`BAD_SKY ${skyArg} — known: ${Object.keys(DAY_T).join(',')}`); process.exit(2); }
let AT, LOOK;
try { AT = JSON.parse(atArg); LOOK = JSON.parse(lookArg); } catch { console.log('BAD_JSON — at/look must be JSON arrays: ' + usage); process.exit(2); }
if (![...AT, ...LOOK].every(Number.isFinite) || AT.length !== 3 || LOOK.length !== 3) {
  console.log('BAD_VEC — at/look each must be [x,y,z] of finite numbers'); process.exit(2);
}
let RE;
try { RE = new RegExp(urlRe); } catch { console.log(`BAD_REGEX ${urlRe}`); process.exit(2); }

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
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'EVAL_THREW');
  return r.result.value;
};
// No Page.navigate, no Network, no shot-server: the tab is already where the sweep left it.
await send('Runtime.enable');
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  ready = await ev(`!!(window.__RSB && window.__RSB.shot && window.__RSB.state && window.__RSB.state.started)`).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { console.log('NEVER_READY — __RSB.state.started never became true on this tab'); ws.close(); process.exit(1); }

const buf = JSON.parse(await ev(`JSON.stringify((()=>{const r=window.__RSB.post().composer.renderer.domElement;return [r.width,r.height]})())`));
console.log(`TARGET ${page.url} · sky=${SKY} dayT=${dayT} · pose at=${JSON.stringify(AT)} look=${JSON.stringify(LOOK)} · buffer ${buf[0]}x${buf[1]}`);
console.log(`UNITS clip = % of the 16 000-px (160x100) sample, same ruler as the sweep · bins = ‰ each · cells = 1 histogram px each`);

// Which interactive point does this vantage stand at? Read off the game's own list so the row can be
// matched to the sweep's `night sample:4` label without trusting the typed pose.
const pois = JSON.parse(await ev('JSON.stringify(window.__RSB.pois().map(p => [p.name, p.x, p.z]))'));
// horizontal distance only — pois are standing points on the map, the eye height is not part of "which
// interactive point is this vantage for".
let nearest = null;
for (const [n, x, z] of pois) {
  const d = +Math.hypot(AT[0] - x, AT[2] - z).toFixed(1);
  if (!nearest || d < nearest[1]) nearest = [n, d];
}
console.log(`POI nearest interactive point: ${nearest ? `${nearest[0]} at ${nearest[1]} m` : 'none listed'}`);

// Settle the sky exactly like the sweep does (cdp-clip-sweep.mjs:145-162): nightF is a smoothed
// follower, so pump R.frame(0.05) until the reading stops moving, then re-hold the setpoint.
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
console.log(`SKY ${SKY} dayT=${dayT} settled in ${settle.pumped} frames · nightF=${settle.nightF} dayF=${settle.dayF} duskF=${settle.duskF} sun=${settle.sun} clock=${settle.clock}`);
if (settle.nightF === null) console.log(`  ! env().state.nightF is not readable — the follower cannot be proven settled`);
if (settle.pumped === 0) console.log(`  ! ${SKY} settled without advancing — this may read the previous sky`);

// One evaluate: pose (as shot() with sunAt=null would), render, histogram, and raycast every blown
// cell — all synchronously, because the page's own rAF tick parks the chase camera back on the rover
// between calls (the trap documented at cdp-clip-sweep.mjs:194-201).
const M = JSON.parse(await ev(`(async () => {
  const T = await import('three');
  const R = window.__RSB;
  const cam = R.camera(), sc = R.scene(), P = R.post();
  R.setDay(${dayT});                       // same re-hold shot() does before rendering
  cam.position.set(${AT.join(', ')});      // src/main.js:5062
  cam.lookAt(${LOOK.join(', ')});          // src/main.js:5063
  cam.updateMatrixWorld(true);
  P.composer.render();                     // src/main.js:5064 — no forced sun, the sky's own key lights
  const src = P.composer.renderer.domElement;
  const W = 160, H = 100;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g2 = c.getContext('2d', { willReadFrequently: true });
  g2.drawImage(src, 0, 0, W, H);
  const q = g2.getImageData(0, 0, W, H).data;
  const bins = new Array(8).fill(0);       // same >> 5 ruler as shot(), src/main.js:5093-5095
  const blown = [];                        // [x,y,r,g,b] per cell in the top bin (lum >= 224)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const lum = 0.2126 * q[i] + 0.7152 * q[i + 1] + 0.0722 * q[i + 2];
    bins[lum >> 5]++;
    if (lum >= 224) blown.push([x, y, q[i], q[i + 1], q[i + 2]]);
  }
  // Per-cell attribution through the LIVE camera — the __RSB.pick idiom (src/main.js:5243-5246),
  // but on the exact cell centres of the histogram, not a typed 1280x720 pixel.
  const rc = new T.Raycaster(), ndc = new T.Vector2();
  const objs = new Map(), objList = [];
  const rgb = v => v ? [+v.r.toFixed(3), +v.g.toFixed(3), +v.b.toFixed(3)] : null;
  const describe = o => {
    const m0 = Array.isArray(o.material) ? o.material[0] : o.material;   // nearby() takes [0] too, src/main.js:5187
    return {
      name: o.name || '',
      label: o.name || (o.geometry ? o.geometry.type + ':' + JSON.stringify(o.geometry.parameters || {}).slice(0, 46) : o.type),
      type: o.type, parent: o.parent ? (o.parent.name || o.parent.type) : null,
      mat: m0 ? (m0.name || m0.type) : null,
      multiMat: Array.isArray(o.material),
      color: rgb(m0 && m0.color), emissive: rgb(m0 && m0.emissive), emissiveHex: m0 && m0.emissive ? m0.emissive.getHexString() : null,
      ei: m0 && m0.emissive ? (m0.emissiveIntensity ?? null) : null,
      toneMapped: m0 ? m0.toneMapped : null,
      blending: m0 ? m0.blending : null,
      additive: !!(m0 && m0.blending === T.AdditiveBlending),
      transparent: m0 ? m0.transparent : null, opacity: m0 ? +m0.opacity.toFixed(3) : null,
      depthWrite: m0 ? m0.depthWrite : null, depthTest: m0 ? m0.depthTest : null,
      overlay: !!(m0 && (m0.blending === T.AdditiveBlending || m0.depthWrite === false)),
      n: 0, i: 0, dmin: 1e9, dmax: -1,
    };
  };
  const cells = [];
  for (const [x, y, r, g, b] of blown) {
    ndc.set((x + 0.5) / W * 2 - 1, -((y + 0.5) / H * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObjects(sc.children, true).filter(h => h.object.visible);
    const h0 = hits[0];
    let idx = -1, d = null, pt = null;
    if (h0) {
      const o = h0.object;
      let e = objs.get(o.uuid);
      if (!e) { e = describe(o); e._o = o; e.i = objList.length; objs.set(o.uuid, e); objList.push(e); }
      e.n++; e.dmin = Math.min(e.dmin, h0.distance); e.dmax = Math.max(e.dmax, h0.distance);
      idx = e.i;                          // stable id: objList is sorted only AFTER the cells are built
      d = +h0.distance.toFixed(2);
      pt = h0.point.toArray().map(v => +v.toFixed(2));
    }
    cells.push({ x, y, px: [r, g, b], ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3)], idx, d, pt });
  }
  // Frustum answer for the aggregation (requirement 5): is the object's OWN geometry inside the
  // frustum, and/or is it an additive/depthWrite:false overlay that paints pixels without owning
  // them by depth?
  const fr = new T.Frustum(), m4 = new T.Matrix4();
  m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  fr.setFromProjectionMatrix(m4);
  for (const e of objList) {
    try { e.inFrustum = e._o.geometry ? fr.intersectsObject(e._o) : null; } catch { e.inFrustum = null; }
    delete e._o;
    e.dmin = +e.dmin.toFixed(2); e.dmax = +e.dmax.toFixed(2);
  }
  const clip = +(blown.length / (W * H) * 100).toFixed(1);   // same arithmetic as src/main.js:5165
  return JSON.stringify({
    clip, blown: blown.length, bins: bins.map(b => Math.round(b / 1600 * 100)),  // ‰, as shot() prints (src/main.js:5176)
    cells, objs: objList.sort((a, b) => b.n - a.n),
    camPos: cam.position.toArray().map(v => +v.toFixed(2)),
    bloom: P.bloom ? { enabled: P.bloom.enabled, threshold: +P.bloom.threshold.toFixed(3), radius: +P.bloom.radius.toFixed(2), strength: +P.bloom.strength.toFixed(3) } : null,
    exposure: +P.composer.renderer.toneMappingExposure.toFixed(3),
  });
})()`));

const blendName = b => ({ 0: 'NoBlending', 1: 'NormalBlending', 2: 'AdditiveBlending', 3: 'MultiplyBlending', 4: 'CustomBlending' }[b] ?? b);
if (!M.cells.length) {
  console.log(`CLEAN — 0 blown cells at this pose/sky (clip=${M.clip} %, bins=${M.bins.join('/')} ‰). ` +
    `The sweep's ${M.clip} % row did not reproduce: re-check the pose, the settle, and the buffer.`);
  ws.close(); process.exit(0);
}
console.log(`FRAME clip=${M.clip} % · blown=${M.blown} cells of 16 000 · bins(‰)=${M.bins.join('/')} · cam=${JSON.stringify(M.camPos)} · exposure=${M.exposure}` +
  (M.bloom ? ` · bloom=${M.bloom.enabled ? 'on' : 'off'} thr=${M.bloom.threshold} rad=${M.bloom.radius} str=${M.bloom.strength}` : ''));
console.log(`CELLS (raster order; lum from the same >>5 ruler as the sweep):`);
for (const k of M.cells) {
  const o = k.idx >= 0 ? M.objs.find(e => e.i === k.idx) : null;
  console.log(`  ${String(k.x).padStart(3)},${String(k.y).padStart(3)} ndc=(${k.ndc.join(',')}) rgb=[${k.px}] -> ` +
    (o ? `${o.label} | mat=${o.mat} | emissive=${o.emissiveHex}${o.ei !== null ? '@e' + o.ei : ''} | d=${k.d}m | pt=[${k.pt}]`
       : 'NO GEOMETRY HIT (ray left the scene — sky/stars own this pixel)'));
}
// Missed cells are attribution too: they say the blowout is the sky itself, not any prop.
const missed = M.cells.filter(k => k.idx < 0).length;
console.log(`AGGREGATE (sorted by cell count; total=${M.blown} · ray-missed=${missed})`);
console.log(`  ${'cells'.padStart(5)}  ${'%ofblown'.padStart(8)}  object | material | emissive | dist range`);
for (const o of M.objs) {
  console.log(`  ${String(o.n).padStart(5)}  ${String((o.n / M.blown * 100).toFixed(1)).padStart(8)}  ` +
    `${o.label} | mat=${o.mat}${o.multiMat ? ' (multi, [0])' : ''} | ${o.emissiveHex ? `emissive ${o.emissiveHex}@${o.ei}` : 'not emissive'} | ${o.dmin}–${o.dmax} m`);
}
console.log(`TOP OBJECTS — material state at render time, and how it is in frame:`);
for (const o of M.objs.slice(0, 5)) {
  console.log(`  ${o.label} (${o.n} cells) type=${o.type} parent=${o.parent}`);
  console.log(`    color=${JSON.stringify(o.color)} emissive=${JSON.stringify(o.emissive)}@${o.ei} toneMapped=${o.toneMapped} blending=${blendName(o.blending)} transparent=${o.transparent}@${o.opacity} depthWrite=${o.depthWrite} depthTest=${o.depthTest}`);
  console.log(`    inFrustumByGeometry=${o.inFrustum} additiveOrNoDepthWrite=${o.overlay}` +
    (o.overlay ? ' — this is an overlay: it paints pixels additively / without depth, so the nearest-hit cell count under-states what it contributes' : ''));
}
console.log(`COMPARE clip=${M.clip} % vs the sweep row (0.8 % gate-fail on night sample:4); blown=${M.blown} cells = ${M.clip}% of the 16 000-px sample.`);
ws.close();
process.exit(0);
