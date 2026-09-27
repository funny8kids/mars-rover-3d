// node tools/cdp-page-errors.mjs <url> [port=9334] [collectMs=40000]
// Attach to the existing Chrome tab, arm the error channels, THEN navigate, and print everything the
// page reports while it boots.
//
// This exists because a probe harness can only say what it observed from the outside: `cdp-run.mjs`'s
// readiness gate now names the clause it stopped at (`stormRef() is null`), which says the page never
// finished booting but not *why*. The page knows — it either threw (Runtime.exceptionThrown /
// Log.entryAdded) or it is still awaiting something (no throw at all, which is its own answer).
// The handler has to be armed before the navigation: `Runtime.enable` and `Log.enable` are per-session,
// so events from the new document arrive without an `addEventListener('error')` racing the load.
import fs from 'fs';

const [,, url, portStr, collectStr] = process.argv;
const port = Number(portStr || 9334);
const collectMs = Number(collectStr || 40000);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
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
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    events.push('THROW ' + (d.exception?.description || d.text || JSON.stringify(d)).split('\n').slice(0, 6).join('\n      '));
  } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    events.push('CONSOLE ' + m.params.type + ' ' + (m.params.args || [])
      .map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (['error', 'warning'].includes(e.level)) {
      events.push(`LOG ${e.source} ${e.text?.slice(0, 300)} @${e.url || ''}:${e.lineNumber ?? ''}`);
    }
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, collectMs));

const state = await send('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  const R=window.__RSB, out={ href: location.href, hasRSB: !!R };
  out.place = typeof R?.place;
  try { out.phys = (typeof R?.phys === 'function' ? R.phys() : R.phys) ? 'set' : 'null'; } catch (e) { out.phys = 'THREW ' + e.message; }
  try { out.storm = R?.stormRef ? (R.stormRef() ? 'set' : 'null') : 'no accessor'; } catch (e) { out.storm = 'THREW ' + e.message; }
  const res = performance.getEntriesByType('resource');
  out.resources = res.length;
  // A resource entry with responseEnd still 0 is a request the page is sitting on — the shape a
  // hung fetch takes, and the difference between "boot threw" and "boot never gets its asset".
  out.pending = res.filter(r => r.responseEnd === 0).slice(0, 10).map(r => r.name.split('/').slice(-2).join('/'));
  out.failed = res.filter(r => r.transferSize === 0 && r.decodedBodySize === 0 && r.responseEnd > 0)
    .slice(0, 10).map(r => r.name.split('/').slice(-2).join('/'));
  const l = document.getElementById('loader');
  out.loader = l ? getComputedStyle(l).display + '/' + [...l.classList].join('.') : 'no #loader';
  out.missingAssets = [...(window.__rsbMissingAsset || [])].slice(0, 8);
  return JSON.stringify(out);
})()`});

console.log('PAGE ' + (state.result?.value || JSON.stringify(state)));
console.log('EVENTS ' + events.length);
for (const e of events) console.log('  ' + e);
process.exit(0);
