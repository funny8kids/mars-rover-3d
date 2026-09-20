import fs from 'fs';

// usage: node tools/cdp-launch-frames.mjs <url> <outPrefix> [altitudesCsv] [settleSecs] [port]
// Headless Edge renders at a few fps, so wall-clock offsets never reach the high part of the
// ascent. This drives launch.y one fixed step per RENDERED frame and shoots at altitudes.
// It must stay per-frame: a setInterval teleport outruns the plume emitter, which only seeds the
// swept path of the game's own dt, so the exhaust breaks into a dotted chain and the shot lies.
const [,, url, outPng, ysStr, settleStr, portStr] = process.argv;
const targets = (ysStr || '200').split(',').map(Number);
const settle = Number(settleStr || 2);
const port = Number(portStr || 9333);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /localhost/.test(t.url)) || list.find(t => t.type === 'page' && t.url.startsWith('http'));
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
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });

const deadline = Date.now() + 560000;
let hit = false;
while (Date.now() < deadline) {
  await sleep(500);
  try { if (await evaluate(`(function(){try{return __RSB.state.launch==='ascent'?1:0}catch(e){return 0}})()`) === 1) { hit = true; break; } } catch { }
}
if (!hit) { console.log('POLL_TIMEOUT'); process.exit(2); }
console.log('ASCENT_HIT');
await evaluate(`(()=>{const L=__RSB.launchRef;cancelAnimationFrame(window.__FF);const step=()=>{L.vy=Math.min(160,L.vy+7.2/60);L.y+=L.vy/60;window.__FF=requestAnimationFrame(step);};window.__FF=requestAnimationFrame(step);return 1})()`);

for (const ty of targets) {
  while (Date.now() < deadline) {
    const y = await evaluate(`__RSB.launchRef.y`);
    if (y >= ty) break;
    await sleep(400);
  }
  await sleep(settle * 1000);
  const name = `${outPng}_y${ty}.png`;
  fs.writeFileSync(name, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const probe = await evaluate(`(()=>{const l=__RSB.los(),g=h=>l.find(x=>x.h===h),a=g(3),b=g(120),c=__RSB.cam();
    return JSON.stringify({y:Math.round(__RSB.launchRef.y),phase:__RSB.state.launch,span:a&&b?Math.abs(b.px[1]-a.px[1]):0,
      on:l.filter(x=>x.onScreen).map(x=>x.h),cam:c.pos,tail:b?b.px:null})})()`);
  console.log('SAVED ' + name + ' ' + probe);
}
await evaluate('cancelAnimationFrame(window.__FF)');
process.exit(0);
