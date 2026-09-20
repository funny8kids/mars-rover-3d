// usage: node tools/cdp-phase-eval.mjs <url> <pollExpr> <evalExpr> <offsetsCsv> [port]
const [,, url, pollExpr, evalExpr, offsetsStr, portStr] = process.argv;
const offsets = (offsetsStr || '0').split(',').map(Number);
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
let hit = 0;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 500));
  try {
    if (await evaluate(`(function(){ try { return (${pollExpr}) ? 1 : 0; } catch (e) { return 0; } })()`) === 1) { hit = Date.now(); break; }
  } catch { /* page restarting */ }
}
if (!hit) { console.log('POLL_TIMEOUT'); process.exit(2); }
console.log('CONDITION_HIT');

for (const off of offsets) {
  const wait = hit + off * 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  console.log(`+${off}s ` + JSON.stringify(await evaluate(`(function(){ try { return (${evalExpr}); } catch (e) { return 'ERR ' + e.message; } })()`)));
}
process.exit(0);
