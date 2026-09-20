import fs from 'fs';

// usage: node tools/cdp-touch-audit.mjs <url> <outDir> [port]
// Mobile path, end to end: CDP touch emulation is switched on before the page loads, so the
// game really boots into its touch build, and the leak repair is then driven by tapping the
// 交互 button with synthetic touch events — no keyboard involved.
const [,, url, outDir, portStr] = process.argv;
const port = Number(portStr || 9333);
fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /localhost/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(1); }

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
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ try { return eval(${JSON.stringify(expr)}); } catch (e) { return 'ERR ' + e.message; } })()`,
    returnByValue: true,
  });
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('SHOT ' + name);
};

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 4 });
await send('Emulation.setDeviceMetricsOverride', { width: 812, height: 375, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });

const deadline = Date.now() + 300000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(500);
  if (await evaluate('!!(window.__RSB && window.__RSB.state.started === true)') === true) { ready = true; break; }
}
if (!ready) { console.log('READY_TIMEOUT'); process.exit(2); }

const S = 'window.__RSB';
console.log('BOOT ' + JSON.stringify(await evaluate(`JSON.stringify({
  isTouchWindow: 'ontouchstart' in window,
  touchUiVisible: !document.getElementById('touch-ui').classList.contains('hidden'),
  interButton: !!document.getElementById('t-inter'),
  bootMs: __RSB.state.bootMs, quality: __RSB.state.quality})`)));

await shot('t0_touch_hud');

// pass 1: does the drive input respond to the stick + gas button?
const gasRect = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('t-gas').getBoundingClientRect())`));
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gasRect.x + gasRect.width / 2, y: gasRect.y + gasRect.height / 2 }] });
await sleep(4000);
const drive = await evaluate(`JSON.stringify({speed: +__RSB.phys().speed.toFixed(2), fps: __RSB.state.fps})`);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
console.log('TAP gas => ' + drive);

// pass 2: mission 0 by proximity, then hold the new interact button at the leak
await evaluate(`${S}.warp(-260, 30, true); 'patrol'`);
await sleep(1500);
await evaluate(`${S}.warp(215, -26, false, 0); 'at the leak'`);
const before = await evaluate(`JSON.stringify(${S}.state)`);
console.log('LEAK-before ' + before);

const interRect = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('t-inter').getBoundingClientRect())`));
const px = interRect.x + interRect.width / 2, py = interRect.y + interRect.height / 2;
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py }] });
const t0 = Date.now();
let fixed = false;
while (Date.now() - t0 < 60000) {
  // re-assert the position each iteration: this is a hold, and the rover must not drift away
  await evaluate(`${S}.warp(215, -26, false, 0); false`);
  fixed = await evaluate(`${S}.state.leak === true`);
  if (fixed) break;
  await sleep(500);
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
console.log(`TOUCH-hold-E => ${fixed ? 'OK' : 'FAIL'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('LEAK-after ' + JSON.stringify(await evaluate(`JSON.stringify(${S}.state)`)));
await shot('t1_leak_fixed_by_touch');

const toast = await evaluate(`document.getElementById('toast').textContent`);
console.log('TOAST ' + toast);
process.exit(fixed ? 0 : 1);
