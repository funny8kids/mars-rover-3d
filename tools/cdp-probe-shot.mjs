import fs from 'fs';

// usage: node tools/cdp-probe-shot.mjs <url> <readyExpr> <actionExpr> <delaySecs> <outPng> [port]
const [,, url, readyExpr, actionExpr, delayStr, outPng, portStr] = process.argv;
const delay = Number(delayStr || 3);
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
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result?.value;
};

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });

const deadline = Date.now() + 240000;
let ready = false;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 500));
  try {
    if (await evaluate(`(function(){ try { return (${readyExpr}) ? 1 : 0; } catch (e) { return 0; } })()`) === 1) { ready = true; break; }
  } catch { /* page restarting */ }
}
if (!ready) { console.log('READY_TIMEOUT'); process.exit(2); }
console.log('READY');

let last = 0;
for (const off of [3, delay]) {
  await new Promise(r => setTimeout(r, Math.max(0, off - last) * 1000));
  last = off;
  console.log(`ACTION@${off}s ` + JSON.stringify(await evaluate(`(function(){ try { return (${actionExpr}); } catch (e) { return 'ERR ' + e.message; } })()`)));
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outPng}_${off}s.png`, Buffer.from(s.data, 'base64'));
  console.log('SAVED ' + `${outPng}_${off}s.png`);
}
process.exit(0);
