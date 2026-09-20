import fs from 'fs';

const [,, url, outPng, marksStr, portStr] = process.argv;
const marks = (marksStr || '30').split(',').map(Number);
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
  if (msg.method === 'Runtime.consoleAPICalled') {
    const txt = (msg.params.args || []).map(a => a.value ?? a.description ?? `[${a.type}]`).join(' ');
    console.log(`[console.${msg.params.type}] ${txt}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' || e.source === 'rendering') console.log(`[log.${e.level}] ${e.text}`);
  }
};

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
if (url) { await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2000)); }

const t0 = Date.now();
for (const mark of marks) {
  const target = t0 + mark * 1000;
  const now = Date.now();
  if (now < target) await new Promise(r => setTimeout(r, target - now));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const name = `${outPng}_${mark}s.png`;
  fs.writeFileSync(name, Buffer.from(shot.data, 'base64'));
  console.log('SAVED ' + name);
}
process.exit(0);
