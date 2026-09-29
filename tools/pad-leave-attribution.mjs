import fs from 'fs';

// usage: node tools/pad-leave-attribution.mjs <url> [port]
//
// 归因 `hud:pad-leave` 那一条红（tools/logs/click-walk-2026-09-29b.log：车动了 5 m、末速 0 m/s、
// 光台提示条"没退"）。红有两种成因，而存档的读数分不开它们：它只记了 `#tele-hint` 的 hidden 位，
// 而这个元素在产品里有两个主人 —— main.js:2380 的光台提示与 main.js:2388 的并网提示（后者要求
// 停着才出现）。所以这里把「文本」「最近光台距离」「按下期间的逐段速度」一起量出来。
//
// 只读数、不改产品、不改尺子：判据留给 cdp-type-click.mjs，这一跑只回答"该改谁"。
const [,, url, portStr] = process.argv;
const port = Number(portStr || 9333);
const VK = { w: 87, a: 65, s: 83, d: 68, g: 71, m: 77, r: 82, p: 80, Enter: 13, Shift: 16 };

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot|8080/.test(t.url)) || list.find(t => t.type === 'page');
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
const keyBase = (k, code) => ({ key: k, code, windowsVirtualKeyCode: VK[k], nativeVirtualKeyCode: VK[k] });
const keyDown = async (k, code) => {
  const b = keyBase(k, code);
  await send('Input.dispatchKeyEvent', { ...b, type: 'keyDown' });
  await send('Input.dispatchKeyEvent', { ...b, type: 'char', text: k.toUpperCase() });
};
const keyUp = (k, code) => send('Input.dispatchKeyEvent', { ...keyBase(k, code), type: 'keyUp' });
const mouse = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const clickSel = async sel => {
  for (;;) {
    const r = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null;
      const b=el.getBoundingClientRect(); return b.width>0&&b.height>0?{cx:b.x+b.width/2,cy:b.y+b.height/2}:null; })()`);
    if (r) { await mouse(r.cx, r.cy); return r; }
    await frames(15);
    if (++clickSel.guard > 40) return null;
  }
};
clickSel.guard = 0;

// 距离口径从产品自己嘴里取：__RSB.pois() 的 pad 条目带着 main.js:2846 那个 3.9 m 到达半径，
// 而不是这里手抄一个数——手抄的半径正是这类归因最容易说谎的地方。
const read = async tag => {
  const raw = await evaluate(`(() => {
    const R = window.__RSB, s = R.state;
    let best = null;
    for (const p of R.pois().filter(x => x.kind === 'pad')) {
      const d = Math.hypot(s.pos[0] - p.x, s.pos[2] - p.z);
      if (!best || d < best.d) best = { d: +d.toFixed(2), at: p.name, r: p.r };
    }
    const hint = document.getElementById('tele-hint'), fab = document.getElementById('tele-fab');
    return JSON.stringify({ pos: s.pos.map(v => +v.toFixed(1)), speed: +(s.speed || 0).toFixed(2),
      hidden: hint.classList.contains('hidden'), txt: (hint.textContent || '').trim().slice(0, 64),
      fabHidden: fab.classList.contains('hidden'), nearest: best, batt: +s.battery.toFixed(3),
      grounded: R.phys ? !!R.phys().grounded : null });
  })()`);
  const o = JSON.parse(raw);
  console.log(`READ ${tag} pos=${o.pos.join(',')} speed=${o.speed} grounded=${o.grounded} hidden=${o.hidden} ` +
    `fabHidden=${o.fabHidden} nearest=${o.nearest.at} d=${o.nearest.d}/r${o.nearest.r} txt="${o.txt}" batt=${o.batt}`);
  return o;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
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
console.log('BOOT ok');

await clickSel('#start-btn');
{
  const deadline = Date.now() + 120000;
  while (await evaluate(`window.__RSB.state.started === true`) !== true) {
    if (Date.now() > deadline) { console.log('START_TIMEOUT'); process.exit(1); }
    await frames(30);
  }
}
await frames(120);

// 走存档那一跑的同一条路：点亮传送胶囊 → 点第一个可用光台（这是把车停上台面的那一步）
const opened = await clickSel('#tele-fab');
console.log('TELE_FAB clicked=' + !!opened);
await frames(30);
const warped = await clickSel('.tp-item:not([disabled])');
console.log('TP_ITEM clicked=' + !!warped);
await frames(120);

const onPad = await read('on-pad');

// 逐段量：按下期间的速度、离最近光台的距离、提示条此刻是"哪一个主人"
await keyDown('w', 'KeyW');
const chunks = [];
for (let i = 1; i <= 12; i++) { await frames(10); chunks.push(await read(`hold-${i * 10}`)); }
await keyUp('w', 'KeyW');
await frames(45);
const after = await read('after-45');

const padWord = /光台|跃迁|无电/;
const gridWord = /并网|电量|反应桩/;
const sawRetire = chunks.some(c => c.hidden || !padWord.test(c.txt));
const maxSpeed = Math.max(onPad.speed, ...chunks.map(c => c.speed), after.speed);

console.log('MAX_SPEED ' + maxSpeed.toFixed(2) + ' m/s (阈值 2.5) · 末速 ' + after.speed +
  ' · 离最近光台 ' + after.nearest.d + ' m (r=' + after.nearest.r + ')');
if (!after.hidden && gridWord.test(after.txt)) {
  console.log('VERDICT GAUGE — 提示条换成了并网文案（main.js:2388），光台提示本身已经退场：' +
    `sawPadHintGoneDuringHold=${sawRetire}；判"hidden"的尺子读不到这件事，产品侧无需改动`);
} else if (!after.hidden && padWord.test(after.txt)) {
  console.log(after.nearest.d < after.nearest.r
    ? 'VERDICT STEP_PREMISE — 车仍在光台 3.9 m 半径内（d=' + after.nearest.d + '），这一步的 5 m 行程够不上判据'
    : 'VERDICT PRODUCT — 车已出半径且提示条仍是光台文案：main.js:2380 那一支没退场，这是真红');
} else if (after.hidden) {
  console.log('VERDICT GREEN_NOW — 同一手势这一跑提示条退场了（存档那一跑不可复现，需查随机项）');
} else {
  console.log('VERDICT OTHER — 文案既非光台也非并网：' + after.txt);
}
fs.writeFileSync('/tmp/pad-leave-attribution.json', JSON.stringify({ onPad, chunks, after, maxSpeed, sawRetire }, null, 1));
process.exit(0);
