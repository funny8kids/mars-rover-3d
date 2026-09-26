// Which term owns the daylight wash? The clip sweep says a frame is 1.5 % blown; this says *whose*
// pixels those are, so a fix can be aimed at a material instead of at another global knob.
//
//   node tools/cdp-clip-attribution.mjs <url> <port> <at:[x,y,z]> <look:[x,y,z]>
//
// Rows, in order: the shipped frame, the same frame with the bloom pass off, then each of the three
// day gates put back where it was found, and finally the same frame again with nothing touched. The
// last row is the noise floor — a "restored" row that does not return to the baseline number means the
// pose or the sky moved between rows, not that the gate did nothing.
//
// Measured 2026-09-27 at the motor pad (day 0.30), tools/logs/clip-attribution-2026-09-27.log:
// baseline 1.54 % · bloom off 1.53 % · threshold back to 2.9 → 3.38 % · radius back to 0.62 → 1.54 %
// · exposure day cut off → 1.94 % · restored 1.54 %. Read together those say the wide radius is now a
// no-op (with the gate at 6.0 there is nothing left for it to smear), the threshold owns 1.84 points
// of the old wash and the exposure cut 0.40 — and what survives all of it, 1.54 %, is not post at all:
// 157 of the 247 blown pixels sit in the rightmost eighth of the frame, where aiming the camera there
// shows sunlit white paint, and 43 more on the left edge, where the sun itself is 6° outside the frame.
//
// One trap this tool already fell into: hiding the sky dome is NOT a sky measurement. The renderer
// clears to the fog colour (environment.js:226), and by day that colour is a light salmon
// (0.46,0.33,0.27 → 0.74,0.57,0.46 by dayF), so "sky hidden" still reads 1.31 % blown. Attribute with
// the post chain's own knobs, or by aiming the camera at the suspect pixels.
import { spawn } from 'node:child_process';
const [,, url, portStr, atArg, lookArg] = process.argv;
const PORT = Number(portStr || 9335);
const AT = JSON.parse(atArg), LOOK = JSON.parse(lookArg);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('node', ['tools/shot-server.mjs', '/tmp/rsb-skyclip'], { stdio: 'ignore' });
for (let i = 0; i < 40; i++) { await sleep(100); try { await fetch('http://127.0.0.1:8123/ping'); break; } catch { } }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url));
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
await ev(`(() => { const R = window.__RSB; R.clearSky(); R.setDay(0.30);
  for (let k = 0; k < 60; k++) R.frame(0.05); return 1; })()`);
const run = async (label, setup, restore = '') => {
  const o = JSON.parse(await ev(`(() => {
    const R = window.__RSB, P = R.post();
    ${setup}
    const cam = R.camera();
    cam.position.set(${AT.join(', ')});
    cam.lookAt(${LOOK.join(', ')});
    cam.updateMatrixWorld();
    P.composer.render();
    const src = P.composer.renderer.domElement;
    const W = 160, H = 100;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    g2.drawImage(src, 0, 0, W, H);
    const d = g2.getImageData(0, 0, W, H).data;
    let blown = 0, sr = 0, sg = 0, sb = 0;
    const cols = new Array(8).fill(0), rows = new Array(5).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (l >= 224) { blown++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
        cols[Math.floor(x / (W / 8))]++; rows[Math.floor(y / (H / 5))]++; }
    }
    const out = { clip: +(blown / (W * H) * 100).toFixed(2), px: blown,
      mean: blown ? [sr, sg, sb].map(s => Math.round(s / blown)) : null,
      cols, rows, exp: +P.composer.renderer.toneMappingExposure.toFixed(3) };
    ${restore}
    return JSON.stringify(out);
  })()`));
  console.log(label.padEnd(22), JSON.stringify(o));
  await ev(`(() => { window.__RSB.frame(0.05); return 1; })()`);
};
await run('baseline', '');
await run('bloom off', 'P.bloom.enabled = false;', 'P.bloom.enabled = true;');
await run('day gate back to 2.9', 'P.bloom.threshold = 2.9;', 'P.bloom.threshold = 6.0;');
await run('day radius back to 0.62', 'P.bloom.radius = 0.62;', 'P.bloom.radius = 0.28;');
await run('exposure day cut off', 'P.composer.renderer.toneMappingExposure = 1.02;', '');
await run('after restore', '');
ws.close(); process.exit(0);
