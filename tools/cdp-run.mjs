import fs from 'fs';

// node tools/cdp-run.mjs <url|--> <expr-file|expr> [port=9333] [readyTimeout=60000] [evalTimeout=120000]
// Reuses one existing tab: Page.navigate, wait until window.__RSB is fully populated, then
// Runtime.evaluate the expression (which may be an async IIFE) with awaitPromise.
const [,, url, exprArg, portStr, readyStr, evalStr] = process.argv;
const port = Number(portStr || 9333);
const expr = fs.existsSync(exprArg) ? fs.readFileSync(exprArg, 'utf8') : exprArg;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url)) || list.find(t => t.type === 'page');
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
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
if (url !== '-') await send('Page.navigate', { url });

const readyDeadline = Date.now() + Number(readyStr || 60000);
for (;;) {
  const r = await send('Runtime.evaluate', {
    // the accessors exist long before the sim does — `phys` is still undefined until the loader,
    // the quality menu and the GLB bundles have all finished, so the readiness test has to be the
    // sim itself or the first scripted move throws on a half-booted world
    expression: `(function(){const R=window.__RSB;if(typeof R?.place!=='function')return '';
      const p=typeof R.phys==='function'?R.phys():R.phys;return p?location.href:''})()`,
    returnByValue: true,
  });
  if (r.result?.value) { console.log('READY ' + r.result.value); break; }
  if (Date.now() > readyDeadline) { console.log('NOT_READY'); process.exit(1); }
  await new Promise(r2 => setTimeout(r2, 1000));
}

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true,
  timeout: Number(evalStr || 120000) });
const exc = out.exceptionDetails;
console.log(exc ? 'EVAL_THREW ' + (exc.exception?.description || exc.text)
  : 'RESULT ' + JSON.stringify(out.result?.value ?? out.result));
process.exit(0);
