import fs from 'fs';

// usage: node tools/frame-attribution.mjs <url> [port]
//
// 归因 §7 HUD 密度在两跑之间的数倍差（tools/logs/click-walk-2026-09-29b.log 同一步 textPct 2.14 %，
// 而 click-walk-2026-09-29d.log 的同类步读到 17.02 %，两跑之间 src/ 零改动）。
//
// 判据的分母是 `document.body` 的矩形（hud-audit-probe.js:459-469 明确写了：不能用 innerWidth，
// 因为 qa_boot.html 把 innerWidth/clientWidth 重定义成 889×967 让渲染器拿到已知缓冲）。
// 走查 harness 摘要里没有这一格，两跑都没留底 ⇒ 只能重量。
//
// 一跑只动一个变量：视口。A=当前窗口，B=CDP 覆盖成 1920×1080，C=清掉覆盖回到当前窗口。
// A 与 C 必须一致，否则密度不是由视口决定的，这条归因就该喊"没归成"。
// 只读数、不改产品、不改尺子。
const [,, url, portStr] = process.argv;
const port = Number(portStr || 9333);
const probe = fs.readFileSync(new URL('./hud-audit-probe.js', import.meta.url), 'utf8');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot|8080/.test(t.url)) || null;
if (!page) { console.log('NO_QA_PAGE_TARGET — 列表里没有 qa_boot/8080，不 fallback 到"第一个 page"'); process.exit(1); }
console.log('TARGET ' + page.url + ' [' + page.title + ']');

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
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
await new Promise(r => ws.onopen = r);
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frames = n => evaluate(`__QA.step(${n}); 1`);
const mouse = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const clickSel = async sel => {
  for (let g = 0; g < 40; g++) {
    const r = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null;
      const b=el.getBoundingClientRect(); if(!(b.width>0&&b.height>0)) return null;
      const top=document.elementFromPoint(b.x+b.width/2, b.y+b.height/2);
      return { cx:b.x+b.width/2, cy:b.y+b.height/2, covered: !(el===top||el.contains(top)||top.contains(el)),
               top: top ? (top.id || String(top.className) || top.tagName).slice(0,40) : 'nothing' }; })()`);
    if (r) {
      if (!r.covered) { await mouse(r.cx, r.cy); return r; }
      console.log(`HITTEST_BLOCKED ${sel} top=${r.top}`);
    }
    await frames(15);
  }
  return null;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
{
  const deadline = Date.now() + 240000;
  for (;;) {
    const ok = await evaluate(`!!(window.__RSB && window.__QA)
      && document.getElementById('loader').classList.contains('hidden')
      && !document.getElementById('menu').classList.contains('hidden')`).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) { console.log('BOOT_TIMEOUT'); process.exit(1); }
    await sleep(2000);
  }
}
// `started` is a follower of the click, not of the frame pump: poll it and re-click rather than
// assuming one dispatch landed. A silent false here would make every later HUD number meaningless.
for (let g = 0; g < 6; g++) {
  const r = await clickSel('#start-btn');
  console.log(`CLICK_START attempt=${g} got=${JSON.stringify(r)}`);
  await frames(120);
  if (await evaluate(`!!window.__RSB.state.started`)) { console.log(`STARTED true after ${g + 1} click(s)`); break; }
  if (g === 5) { console.log('STARTED false — HUD never came up, nothing to attribute'); process.exit(1); }
}

const { windowId } = await send('Browser.getWindowForTarget');
const win = await send('Browser.getWindowBounds', { windowId });
console.log('WINDOW_BOUNDS ' + JSON.stringify(win));

const readOnce = async tag => {
  await evaluate(`window.__AUDSTATE='hud';window.__AUDHOLD=[];1`);
  const p = JSON.parse(await evaluate(probe));
  await evaluate(`delete window.__AUDSTATE;delete window.__AUDHOLD;1`);
  const d = p.density || {};
  console.log(`READ ${tag} laid=${p.frame.laid.join('x')} inner=${p.frame.innerWidth.join('x')}`
    + ` vv=${p.frame.visualViewport.join('x')} dpr=${p.frame.dpr} canvas=${p.frame.canvas.join('x')}`
    + ` | textPct=${d.textPct} panelPct=${d.panelPct} cardedBox=${d.cardedBox}`
    + ` judged=${d.judged} control=${d.control && d.control.tripped}/3@${d.control && d.control.bar}% fail=${JSON.stringify(d.fail)}`);
  console.log(`  OWNERS ${tag} ` + JSON.stringify(d.ownerSplit));
  return { d, laid: p.frame.laid.join('x') };
};

const a = await readOnce('A-as-is');
// One variable: the window. `Browser.setWindowBounds` is the lever the sibling mobile harness uses
// (cdp-interaction-audit.mjs:69 shrinks to 520×560), and it moves the *layout* — which is the probe's
// denominator. Emulation.setDeviceMetricsOverride is left alone: cdp-tour-audit.mjs:116-119 measured
// that it moves visualViewport but not the buffer on this headless build, so mixing the two levers
// would put two variables in one run.
const b0 = win.bounds;
try {
  await send('Browser.setWindowBounds', { windowId, bounds: { state: 'normal', left: b0.left, top: b0.top, width: 1920, height: 1080 } });
  await frames(90);
  const w2 = await send('Browser.getWindowBounds', { windowId });
  console.log('WINDOW_BOUNDS_AFTER ' + JSON.stringify(w2.bounds));
} catch (e) { console.log('SET_BOUNDS_FAILED ' + e.message); }
const b = await readOnce('B-bounds-1920x1080');
try {
  await send('Browser.setWindowBounds', { windowId, bounds: b0 });
  await frames(90);
} catch (e) { console.log('RESTORE_BOUNDS_FAILED ' + e.message); }
const c = await readOnce('C-as-is-repeat');

// The window-bounds lever moved nothing (A=B=C at laid 390x844 while Browser.getWindowBounds reports
// 1920x1080). So the layout frame is held by something other than the window. Ask the emulator:
// clear, look at the raw geometry, then pin a desktop frame explicitly.
const geomExpr = `(() => {
  const de = document.documentElement, b = document.body.getBoundingClientRect();
  return JSON.stringify({ body: [Math.round(b.width), Math.round(b.height)],
    client: [de.clientWidth, de.clientHeight],
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
    vvScale: visualViewport.scale,
    vv: [Math.round(visualViewport.width), Math.round(visualViewport.height)],
    dpr: devicePixelRatio, mqMobile: matchMedia('(max-width: 500px)').matches,
    metaViewport: (document.querySelector('meta[name=viewport]') || {}).content || 'none' });
})()`;
const geom = async tag => { const g = await evaluate(geomExpr); console.log(`GEOM ${tag} ${g}`); };
await geom('before-clear');
try { console.log('canEmulate ' + JSON.stringify(await send('Emulation.canEmulate'))); } catch (e) { console.log('CAN_EMULATE_FAILED ' + e.message); }
try { await send('Emulation.clearDeviceMetricsOverride'); console.log('CLEAR_OK'); } catch (e) { console.log('CLEAR_FAILED ' + e.message); }
await frames(90);
await geom('after-clear');
const d = await readOnce('D-after-clear');
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  console.log('SET_DESKTOP_OVERRIDE_OK');
} catch (e) { console.log('SET_DESKTOP_OVERRIDE_FAILED ' + e.message); }
await frames(90);
await geom('after-desktop-override');
const e = await readOnce('E-override-1920x1080');
try { await send('Emulation.clearDeviceMetricsOverride'); } catch (_) {}
await frames(60);
await geom('final');

const same = (x, y) => x.d && y.d && x.d.textPct === y.d.textPct && x.d.panelPct === y.d.panelPct;
console.log(`REPEAT_CONTROL A==C text ${a.d.textPct}/${c.d.textPct} panel ${a.d.panelPct}/${c.d.panelPct} => ${same(a, c) ? 'STABLE' : 'UNSTABLE'}`);
console.log(`FRAME_LADDER A=${a.laid} B=${b.laid} C=${c.laid} D=${d.laid} E=${e.laid}`);
console.log(`TEXT_LADDER A=${a.d.textPct} D=${d.d.textPct} E=${e.d.textPct}`);
console.log(`VERDICT ${same(a, c) && e.d.textPct < a.d.textPct && e.laid !== a.laid
  ? 'FRAME_DEPENDENT — 密度随布局视口变；换到具名桌面视口后读数不同，两跑之差可由视口解释'
  : 'NOT_ATTRIBUTED — 视口换了而密度没跟着换，或同视口重复不稳；两跑之差不能只归给视口'}`);
process.exit(0);
