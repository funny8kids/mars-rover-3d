const [,, expr, portStr, timeoutStr, urlFilter] = process.argv;
const port = Number(portStr || 9333);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// several tabs can share a debug port; without a filter the first localhost page wins, which
// silently targets a stale or error page
const match = t => t.type === 'page' && (urlFilter ? t.url.includes(urlFilter) : /localhost/.test(t.url));
const page = list.find(match);
if (!page) { console.log('NO_PAGE ' + JSON.stringify(list.filter(t => t.type === 'page').map(t => t.url))); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) {
    const exc = m.result?.exceptionDetails;
    console.log(exc ? 'EVAL_THREW ' + JSON.stringify(exc.exception?.description || exc.text) : (m.result?.result?.value ?? JSON.stringify(m)));
    process.exit(0);
  }
};
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, Number(timeoutStr || 15000));
