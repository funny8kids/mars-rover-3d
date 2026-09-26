// The live frame cadence while the rover actually drives, at the size each quality tier ships.
//
// Why this exists next to tools/cdp-tour-audit.mjs rather than inside it: the acceptance ruler
// advances the sim inside one synchronous task (`__RSB.drive()`, src/main.js:3972, bailed out at
// main.js:4471 when a chunk would outlive 9 s), so the page serves no rAF frame while a chunk runs
// and the fps it prints comes from the frames *between* chunks. That is fine for a floor, but it is
// not the thing the bar names, and it cannot see what driving adds: tyre dust and exhaust plumes
// (Points, never meshes, so no static census counts them), the camera follower with its speed and
// trauma terms, and the HUD write-back. This probe therefore runs the game's own rAF loop and drives
// with real key events through CDP — `Input.dispatchKeyEvent` into the page's own listeners, not
// `__RSB.input` — and reads the distribution of the gaps between frames.
//
// Two sizes are swept, because the difference between them is the whole finding
// (tools/logs/live-cadence-2026-09-27.log, 2 rounds, worst-pose controls):
//   tier buffer 1811×884 = 1.60 Mpx  driving med 17 ms -> 58.8 fps   (4/4 driving rows)
//   1920×1080           = 2.07 Mpx  driving med 19 ms -> 52.6 fps   (straight, both rounds)
// i.e. a five-minute cruise that fails at 52 fps and passes at 58.8 can be the ruler's surplus
// pixels and not the scene's. Each size also runs a parked control at one fixed pose (the tour's own
// worst, -77,59), because a cheaper driving row can just mean the rover drove somewhere emptier —
// `draws` travels along with every row for exactly that reading, and it did move: turning at the
// 2.07 Mpx pin read med 17 ms at 576 draws where straight read 19 ms at 1 221.
//
// Six points of the frame are read back per row (luma + raw RGB) so a fast row that draws nothing
// cannot be mistaken for a win. The cache-disable is not optional: :5173 here is
// `python3 -m http.server`, which sends no cache headers, so Chrome replays its disk copy of
// src/*.js across a navigate and the probe would measure whatever page was cached last.
//
// Usage: node tools/cdp-live-cadence.mjs <port> <url> [seconds-per-row] [tier|pin]
//   e.g. node tools/cdp-live-cadence.mjs 9335 'http://127.0.0.1:5173/?auto=std' 6 both
import { QUALITIES } from '../src/config.js';

const [port, url, secsStr, which] = process.argv.slice(2);
const SAMPLE_MS = Math.round((Number(secsStr) || 6) * 1000);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const host = new URL(url).host;
const page = list.find(t => t.type === 'page' && t.url.includes(host));
if (!page) { console.log('ABORT: no page on', host, 'at port', port); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const d = JSON.parse(e.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const ex = r.result?.exceptionDetails || r.exceptionDetails;
  if (ex) { console.log('EXC:', JSON.stringify(ex.exception?.description || ex.text).slice(0, 260)); process.exit(1); }
  return (r.result?.result?.value) ?? null;
};
const key = (type, code) => send('Input.dispatchKeyEvent', {
  type, code, key: code.slice(3).toLowerCase(), windowsVirtualKeyCode: code.charCodeAt(3),
  nativeVirtualKeyCode: code.charCodeAt(3) });

await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev('!!(window.__RSB && window.__RSB.state.started)')) break; }
if (!await ev('!!(window.__RSB && window.__RSB.state.started)')) { console.log('ABORT: page never booted'); process.exit(1); }

const boot = JSON.parse(await ev(`(()=>{const r=window.__RSB.post().composer.renderer,cv=r.domElement;
  return JSON.stringify({tier:window.__RSB.state.quality,pr:+r.getPixelRatio().toFixed(4),
    w:cv.width,h:cv.height,css:cv.clientWidth+'x'+cv.clientHeight})})()`));
// The tier's own budget fitted to this window's aspect — the same arithmetic solvePixelRatio() uses,
// so the row named 'tier' is the size the game would have chosen for itself (it booted at
// `${boot.w}x${boot.h}` on ratio ${boot.pr}) and not a size this file picked.
const aspect = boot.css.split('x').map(Number);
const a = aspect[0] / aspect[1];
const tierH = Math.round(Math.sqrt((QUALITIES[boot.tier]?.maxPixels ?? 1.6e6) / a));
const SIZES = {
  tier: { w: Math.round(tierH * a), h: tierH, why: `${boot.tier} maxPixels ${(QUALITIES[boot.tier]?.maxPixels / 1e6).toFixed(2)} Mpx at aspect ${a.toFixed(3)}` },
  pin: { w: 1920, h: 1080, why: 'the buffer tools/cdp-tour-audit.mjs pinned before 2026-09-27' },
};
const rows = which === 'tier' ? ['tier'] : which === 'pin' ? ['pin'] : ['tier', 'pin'];
console.log('BOOT', JSON.stringify(boot), '· rows:', rows.map(k => `${k}=${SIZES[k].w}x${SIZES[k].h}`).join(' '));

const SIZE = (w, h) => `(()=>{const R=window.__RSB,r=R.post().composer.renderer;
  r.setPixelRatio(1);r.setSize(${w},${h},false);R.post().setSize(${w},${h});return r.domElement.width+'x'+r.domElement.height})()`;
const ARM = `(()=>{window.__sg={a:[],prev:0,stop:false};
  const t=()=>{const n=Date.now();if(window.__sg.prev)window.__sg.a.push(n-window.__sg.prev);window.__sg.prev=n;
    if(!window.__sg.stop)requestAnimationFrame(t)};requestAnimationFrame(t);return 1})()`;
// Date.now() and not the rAF timestamp: this build's high-resolution clock does not advance inside a
// task (see tools/cdp-frame-cost.mjs), so mixing the two bases would put a start-up offset into the
// distribution. `comp.render()` before readPixels because the canvas holds the previous frame until
// the next one is composited.
const READ = `(()=>{window.__sg.stop=true;const a=window.__sg.a.sort((p,q)=>p-q);
  const R=window.__RSB,comp=R.post().composer,r=comp.renderer,cv=r.domElement;comp.render();
  const gl=r.getContext(),W=cv.width,H=cv.height;
  const pts=[[0.5,0.18],[0.28,0.3],[0.72,0.3],[0.5,0.42],[0.15,0.5],[0.85,0.5]];
  let luma=0;const px=[];
  for(const [u,v] of pts){const o=new Uint8Array(4);
    gl.readPixels(Math.round(u*W),Math.round((1-v)*H),1,1,gl.RGBA,gl.UNSIGNED_BYTE,o);
    px.push(o[0]+','+o[1]+','+o[2]);luma+=0.2126*o[0]+0.7152*o[1]+0.0722*o[2]}
  return JSON.stringify({med:a[a.length>>1],p90:a[Math.floor(a.length*.9)],max:a[a.length-1],n:a.length,
    over25:a.filter(v=>v>25).length,fps:+(1000/(a[a.length>>1]||16.7)).toFixed(1),buf:W+'x'+H,
    luma:Math.round(luma/pts.length),px:px.slice(0,2).join(' '),statefps:+R.state.fps.toFixed(1),
    speed:+R.phys().speed.toFixed(1),pos:[Math.round(R.phys().x),Math.round(R.phys().z)].join(',')})})()`;
// What the frame carries, taken after the sample window so the frustum comes off the live camera the
// chase rig actually settled on — the same reasoning as the tour's census, kept out of READ because
// the census walks 1 500 spheres and must not land inside the measured stretch.
const CENS = `(async()=>{const T=await import('three'),R=window.__RSB,sc=R.scene(),cam=R.camera();
  sc.updateMatrixWorld(true);
  const fr=new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse));
  const on=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true};
  let draws=0,tris=0,parts=0,partN=0,meshes=0,cast=0;
  sc.traverse(o=>{if(!on(o))return;
    if(o.isMesh){meshes++;if(o.castShadow)cast++}
    if((o.isPoints||o.isSprite)&&o.geometry){parts+=(o.geometry.attributes.position?o.geometry.attributes.position.count:0);partN++;return}
    if(!o.isMesh||!o.geometry)return;
    if(!o.geometry.boundingSphere)o.geometry.computeBoundingSphere();
    if(!fr.intersectsSphere(o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld)))return;
    const g=o.geometry;draws++;tris+=(g.index?g.index.count:g.attributes.position.count)/3*(o.isInstancedMesh?o.count:1)});
  return JSON.stringify({draws,tris:Math.round(tris),meshes,cast,parts,partN})})()`;

const POSE = [-77, 59, -242];
const sample = async (label) => {
  await ev(ARM);
  await sleep(SAMPLE_MS);
  const g = JSON.parse(await ev(READ));
  const c = JSON.parse(await ev(CENS));
  console.log(`${label.padEnd(22)} buf=${g.buf} med=${g.med} p90=${g.p90} max=${g.max} live=${g.fps} ` +
    `statefps=${g.statefps} >25:${g.over25}/${g.n} draws=${c.draws} tris=${c.tris} parts=${c.parts}(${c.partN}) ` +
    `cast=${c.cast} spd=${g.speed} pos=${g.pos} luma=${g.luma} px=${g.px}`);
  return { label, ...g, ...c };
};

const out = [];
for (let round = 1; round <= 2; round++) {
  const order = round % 2 ? rows : rows.slice().reverse();
  for (const k of order) {
    const s = SIZES[k];
    console.log(`--- r${round} ${k} ${s.w}x${s.h} = ${(s.w * s.h / 1e6).toFixed(2)} Mpx by ${s.why} ---`);
    await ev(SIZE(s.w, s.h));
    await ev(`window.__RSB.place(${POSE[0]}, ${POSE[1]}, ${POSE[2]} * Math.PI / 180)`);
    await sleep(2200);
    out.push(await sample(`r${round} ${k} parked`));
    await key('keyDown', 'KeyW');
    await sleep(2500);
    out.push(await sample(`r${round} ${k} straight`));
    // Steering, because the dust plume and the camera sweep only exist while the hull is yawing, and
    // the chase rig's collider keep-out engages on the turn rather than on the straight.
    for (let i = 0; i < 5; i++) {
      await key('keyDown', i % 2 ? 'KeyA' : 'KeyD'); await sleep(700);
      await key('keyUp', i % 2 ? 'KeyA' : 'KeyD'); await sleep(500);
    }
    out.push(await sample(`r${round} ${k} turning`));
    await key('keyUp', 'KeyW');
    await sleep(800);
  }
}

// Reduced by (buffer, condition) and never across them: the two sizes differ by 29 % of their
// pixels, and averaging a 17 ms row with a 19 ms row would print a number no page ever ran.
for (const k of rows) {
  const buf = `${SIZES[k].w}x${SIZES[k].h}`;
  for (const cond of ['parked', 'straight', 'turning']) {
    const sel = out.filter(r => r.buf === buf && r.label.endsWith(cond));
    const m = sel.map(r => r.med).sort((x, y) => x - y);
    const med = m[m.length >> 1];
    console.log(`LIVE ${k.padEnd(5)} ${cond.padEnd(8)} med ${m.join('/')} ms -> ${(1000 / med).toFixed(1)} fps · ` +
      `p90≤${Math.max(...sel.map(r => r.p90))} max ${Math.max(...sel.map(r => r.max))} · draws ${sel.map(r => r.draws).join('/')}`);
  }
  const bad = out.filter(r => r.buf === buf && !r.label.endsWith('parked') && r.med > 18);
  if (bad.length) console.log(`  ✗ ${bad.length} driving row(s) at ${k} slower than 18 ms med: ` +
    bad.map(r => `${r.label} ${r.med}ms @${r.pos} ${r.draws} draws`).join(' | '));
}
ws.close();
