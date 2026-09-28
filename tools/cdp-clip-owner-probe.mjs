// Who owns the 139 blown pixels at the launch-pad day vantage (tools/logs/clip-sweep-2026-09-28.log
// row "day pad:launch clip=0.9")? cdp-clip-attribution already showed the post chain owns none of
// them (bloom off: 139 -> 138 px). Two hypotheses remain: a distant 3.2x1.55 PlaneGeometry sign that
// the sweep's in-frame census names, or the sun-side horizon (this is the only day vantage that
// looks nearly at the sun: sunDeg 21 while every clean row sits at 97-159 deg).
//
//   node tools/cdp-clip-owner-probe.mjs <url> <port> <at:[x,y,z]> <look:[x,y,z]>
//
// Rows: baseline, signs hidden (the named panels only, then restored), and the same pose with the
// view rotated 90 deg about the vertical. The last row keeps every object in the scene, so if it is
// the one that clears the frame, the owner is the direction, not a mesh.
import { spawn } from 'node:child_process';
const [,, url, portStr, atArg, lookArg] = process.argv;
const PORT = Number(portStr || 9333);
const AT = JSON.parse(atArg), LOOK = JSON.parse(lookArg);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('node', ['tools/shot-server.mjs', '/tmp/rsb-skyclip'], { stdio: 'ignore' });
for (let i = 0; i < 40; i++) { await sleep(100); try { await fetch('http://127.0.0.1:8123/ping'); break; } catch { } }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url === url) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET on :' + PORT); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } };
await new Promise(r => ws.onopen = r);
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'THREW'); return r.result.value; }
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url });
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  ready = await ev(`!!(window.__RSB && window.__RSB.shot && window.__RSB.state && window.__RSB.state.started)`).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { console.log('NEVER_READY'); process.exit(2); }
await ev(`(() => { const R = window.__RSB; R.clearSky(); R.setDay(0.30);
  for (let k = 0; k < 60; k++) R.frame(0.05); return 1; })()`);

// The 3.2 x 1.55 panel is the sweep's own handle on the object, so the hide stays keyed to it.
const IS_SIGN = `o.geometry?.type === 'PlaneGeometry' && o.geometry.parameters &&
  Math.abs(o.geometry.parameters.width - 3.2) < 0.01 && Math.abs(o.geometry.parameters.height - 1.55) < 0.01`;

const census = await ev(`(() => { const R = window.__RSB, cam = R.camera();
  cam.position.set(${AT.join(', ')}); cam.lookAt(${LOOK.join(', ')}); cam.updateMatrixWorld();
  const V = cam.position.constructor, hits = [];
  R.scene().traverse(o => { if (!(${IS_SIGN})) return;
    const w = new V().setFromMatrixPosition(o.matrixWorld);
    hits.push({ name: o.name || o.parent?.name || '(anon)', dist: +cam.position.distanceTo(w).toFixed(1) }); });
  return JSON.stringify({ matched: hits.length, inFrameDistanceBand: hits.filter(h => h.dist > 40 && h.dist < 90).length }); })()`);
console.log('SIGN_PANELS', census);

function measure(look, setup) {
  return `(() => {
  const R = window.__RSB, P = R.post();
  ${setup}
  const cam = R.camera();
  cam.position.set(${AT.join(', ')});
  cam.lookAt(${look.join(', ')});
  cam.updateMatrixWorld();
  P.composer.render();
  const src = P.composer.renderer.domElement, W = 160, H = 100;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g2 = c.getContext('2d', { willReadFrequently: true });
  g2.drawImage(src, 0, 0, W, H);
  const d = g2.getImageData(0, 0, W, H).data;
  let blown = 0; const cols = new Array(8).fill(0), rows = new Array(5).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] >= 224) {
      blown++; cols[Math.floor(x / (W / 8))]++; rows[Math.floor(y / (H / 5))]++;
    }
  }
  return JSON.stringify({ clip: +(blown / (W * H) * 100).toFixed(2), px: blown, cols, rows });
})()`;
}
const row = async (label, look, setup = '') => {
  console.log(label.padEnd(24), await ev(measure(look, setup)));
  await ev(`(() => { window.__RSB.frame(0.05); return 1; })()`);
};

const hide = `window.__RSB.scene().traverse(o => { if (${IS_SIGN}) o.visible = false; });`;
const show = `window.__RSB.scene().traverse(o => { if (${IS_SIGN}) o.visible = true; });`;
await row('baseline', LOOK);
await row('signs hidden', LOOK, hide);
await ev(show);
await row('after restore', LOOK);

// 90 deg about the vertical, around the camera: same body, same sky, sun moved out of frame.
const dx = LOOK[0] - AT[0], dz = LOOK[2] - AT[2];
const AWAY = [AT[0] + dz, LOOK[1], AT[2] - dx];
await row('view rotated 90deg', AWAY);
console.log('POSE at=' + JSON.stringify(AT) + ' look=' + JSON.stringify(LOOK) + ' rotated=' + JSON.stringify(AWAY.map(v => +v.toFixed(2))));
server.kill(); ws.close(); process.exit(0);
