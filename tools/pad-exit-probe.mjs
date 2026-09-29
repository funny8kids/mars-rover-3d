import fs from 'fs';

// usage: node tools/pad-exit-probe.mjs <url> [port]
//
// 【F】1 走查里唯一剩下的红（`hud:pad-leave`）在具名视口与无名视口下同处复现：把车落到光台盘心、
// 按住 W 120 帧，末读 `d=1.34 of r=3.9`。这一跑只回答一个问题：**盘心周围 120° 的扇区里，车身环
// 在多远处第一次碰到实体，碰到的是哪一件**。
//
// 口径全部从产品自己嘴里取：`__RSB.place(x, z, yaw)` 逐字写位姿（无搜索、无顶出），并且它就是
// 用 `c.r + 1.6` 这条车身环近似来报 `touching` 的；半径与朝向都从 `__RSB.pois()` 的 pad 条目取。
// 这里不改判据、不改产品 —— 只把"挡住的是哪一件"打印出来。
const [,, url, portStr] = process.argv;
const port = Number(portStr || 9333);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot|8080/.test(t.url));
if (!page) { console.log('NO_PAGE_TARGET ' + list.filter(t => t.type === 'page').map(t => t.url).join(' | ')); process.exit(1); }
console.log('TARGET ' + page.url);

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
await send('Runtime.enable');

const ready = await evaluate(`!!(window.__RSB && window.__RSB.place && window.__QA)`);
if (!ready) { console.log('NOT_READY — 需要已启动的 qa_boot 页（__RSB.place / __QA）'); process.exit(1); }

// STEP 每帧推进固定 dt，所以几何扫完之后不需要它；但 place 会改写实时位姿 ⇒ 跑完把原位姿还回去。
const sweep = await evaluate(`(() => {
  const R = window.__RSB;
  const before = { pos: R.state.pos.map(v => +v.toFixed(2)), yaw: +((R.state.yaw ?? 0).toFixed(3)) };
  const STEP = 0.5, FAR = 9.0;
  const out = [];
  for (const p of R.pois().filter(x => x.kind === 'pad')) {
    const centre = R.place(p.x, p.z, 0);
    const rows = [];
    for (let h = 0; h < 16; h++) {
      const a = h * Math.PI / 8;
      const dx = Math.sin(a), dz = Math.cos(a);
      let blockedAt = null, by = null, freeBeyond = null;
      for (let t = STEP; t <= FAR + 1e-9; t += STEP) {
        const q = R.place(+(p.x + dx * t).toFixed(3), +(p.z + dz * t).toFixed(3), a);
        if (q.touching.length) { blockedAt = +t.toFixed(2); by = q.touching; break; }
        freeBeyond = +t.toFixed(2);
      }
      rows.push({ head: +(a * 180 / Math.PI).toFixed(0), blockedAt, freeBeyond,
        firstBlock: by ? by[0] : null, at: by ? null : null });
    }
    const clear = rows.filter(r => r.blockedAt === null).length;
    const crossR = rows.filter(r => r.blockedAt !== null && r.blockedAt > p.r).length;
    out.push({ pad: p.name, at: [+p.x.toFixed(2), +p.z.toFixed(2)], r: p.r,
      centreTouching: centre.touching, clearLanes: clear, blockedPastRadius: crossR,
      lanes: rows });
  }
  R.place(before.pos[0], before.pos[2], before.yaw);
  return JSON.stringify({ before, pads: out });
})()`);

const data = JSON.parse(sweep);
console.log('BEFORE ' + JSON.stringify(data.before));
for (const pad of data.pads) {
  console.log(`PAD ${pad.pad} at ${pad.at.join(',')} r=${pad.r} centreTouching=${JSON.stringify(pad.centreTouching)}`);
  console.log(`  LANES clear ${pad.clearLanes}/16 · blocked beyond r ${pad.blockedPastRadius}/16`);
  for (const l of pad.lanes) {
    console.log(`  ${String(l.head).padStart(3)}° ` + (l.blockedAt === null
      ? `free to ${l.freeBeyond} m`
      : `first contact ${l.blockedAt} m · ${l.firstBlock}`));
  }
}
// 判据留给读的人：这一跑不设闸，只把"哪个朝向在多远碰到哪一件"摊开。
const hub = data.pads.find(p => p.pad === 'pad:hub');
if (hub) {
  console.log(`HUB_SUMMARY centreTouching ${hub.centreTouching.length} · clearLanes ${hub.clearLanes}/16 · ` +
    `最短受阻距离 ${Math.min(...hub.lanes.filter(l => l.blockedAt !== null).map(l => l.blockedAt))}`);
}
console.log('VERDICT READ_ONLY — 这一跑不判红也不放行，只回答"挡住的是哪一件、在多远的朝向"');
ws.close();
process.exit(0);
