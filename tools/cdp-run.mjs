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
// `http.server` sends no `Cache-Control`, so Chrome keeps ES modules in its script cache across
// navigations: a probe run after editing `src/` can execute the *previous* build's bytes and print an
// identical report, which reads as "my change did nothing". A `fetch(u,{cache:'reload'})` preflight
// refreshes the HTTP cache but not the script cache, so it does not fix it either.
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
if (url !== '-') await send('Page.navigate', { url });

const readyDeadline = Date.now() + Number(readyStr || 60000);
let lastReason = 'no poll', clickedStart = false;
for (;;) {
  const r = await send('Runtime.evaluate', {
    // the accessors exist long before the sim does — `phys` is still undefined until the loader,
    // the quality menu and the GLB bundles have all finished, so the readiness test has to be the
    // sim itself or the first scripted move throws on a half-booted world.
    // `phys` alone is not far enough into boot: it is set at main.js:279 by `boot()`, but the render
    // pipeline — `applyQuality()` at main.js:339, which creates `stormField` at :349 — only runs from
    // the START button's handler (main.js:2793-2799). So a freshly navigated page has a complete world
    // model and NO weather: `__RSB.sites()` reaches `exposure()` (main.js:763) and throws on
    // `stormField.along`. Earlier runs did not hit that only because the reused tab had been left
    // started by whoever used it last, which is luck, not a harness.
    // So the gate presses the button itself and then waits for the consequence it cares about. The
    // press is checked against the menu actually going away, and a probe that wants to study the menu
    // should navigate with `-` and read the DOM before this gate runs.
    // A bare `NOT_READY` told the reader nothing about which clause failed, so the gate returns the
    // reason it stopped at and the timeout prints it: the difference between "the page is slow" and
    // "the gate is wrong" is only knowable from the page's own answer.
    // A probe whose first line is `if(!R.state.started)` used to get answered "READY" and then bail:
    // `applyQuality()` (which creates `stormField`, so this gate's own last ingredient) runs at the top
    // of the START handler, while `started = true` is set only after it — past a `raf()` and an audio
    // init that may wait out its 2 s race (main.js:2791-2802). Measured 2026-09-28: `storm-loop-probe.js`
    // filed `STORM_LOOPS_UNTRUSTED the page never started` on a page that read `started:true`, 62 FPS and
    // a live HUD 20 s later. So the gate waits for the consequence, not for one of its ingredients.
    expression: `(function(){const R=window.__RSB;
      if(!R)return 'no __RSB at '+location.href;
      if(typeof R.place!=='function')return 'no .place ('+typeof R.place+')';
      const p=typeof R.phys==='function'?R.phys():R.phys;
      if(!p)return 'phys still null';
      const btn=document.getElementById('start-btn'), menu=document.getElementById('menu');
      if(btn && menu && !menu.classList.contains('hidden')){ btn.click(); return 'CLICK'; }
      if(typeof R.stormRef!=='function')return 'no .stormRef ('+typeof R.stormRef+')';
      const s=R.stormRef();
      if(!s)return 'stormRef() is '+String(s);
      if(!R.state.started)return 'render pipeline up but sim not started';
      return location.href})()`,
    returnByValue: true,
  });
  const v = r.result?.value;
  if (typeof v === 'string' && /^https?:/.test(v)) {
    console.log('READY ' + v + (clickedStart ? ' (gate pressed #start-btn)' : ''));
    break;
  }
  if (v === 'CLICK') {
    if (clickedStart) { console.log('START_CLICK_DID_NOT_TAKE: #menu still visible after a second press'); process.exit(1); }
    clickedStart = true;
    console.log('GATE pressed #start-btn (page was sitting at the menu, so the render pipeline had not run)');
  }
  lastReason = String(v ?? r.exceptionDetails?.exception?.description ?? 'no value');
  if (Date.now() > readyDeadline) { console.log('NOT_READY after poll: ' + lastReason); process.exit(1); }
  await new Promise(r2 => setTimeout(r2, 1000));
}

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true,
  timeout: Number(evalStr || 120000) });
const exc = out.exceptionDetails;
console.log(exc ? 'EVAL_THREW ' + (exc.exception?.description || exc.text)
  : 'RESULT ' + JSON.stringify(out.result?.value ?? out.result));
process.exit(0);
