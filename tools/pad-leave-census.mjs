import fs from 'fs';

// usage: node tools/pad-leave-census.mjs <url> [port]
//
// #116 的第二格：走查里 `hud:pad-leave` 只钉了第一台盘（`pois().filter(kind==='pad')[0]`＝hub），
// 判据「按住 W 能开走」因此只在 hub 上量过。这台盘在 `pad-exit` 归因里是 3/16 净空，所以过了；
// 但 comms 静态扫是 0/16「free to 9 m」——那把尺把「净空」定成 9 m 直道，而产品自己的
// `outwardBearing` 只要「净空最长那条」，comms 最长是 68° 的 7.5 m，远超 3.9 m 盘半径。
// 二者是否等价，不能靠读代码推断——要**逐台真按 W 开车**才知道。
//
// 这一跑把走查里那条判据一字不动地搬到每一台盘上（位置仍钉 search=0 盘心、朝向问产品 'out'）：
// 判据 = moved ≥ 3 m 且 离盘半径 d > r 且 末速 ≥ 2.5。全过＝#116 第二格用实测关掉；
// 任一失败＝那台盘给出 RED 复现，才轮到产品侧 MOUTH_GAP 的决策。
// 不改产品、不改走查（改走查会作废已入库的 `-i` 绿跑）。
const [,, url, portStr] = process.argv;
const port = Number(portStr || 9333);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot|8080/.test(t.url));
if (!page) { console.log('NO_PAGE_TARGET ' + list.filter(t => t.type === 'page').map(t => t.url).join(' | ')); process.exit(2); }
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
await send('Input.enable').catch(() => {});

const ready = await evaluate(`!!(window.__RSB && window.__RSB.warp && window.__RSB.pois && window.__QA)`);
if (!ready) { console.log('NOT_READY — 需要已启动的 qa_boot 页（__RSB.warp / __RSB.pois / __QA）'); process.exit(2); }

// 走查的 padState 读数口径，逐字搬过来：nearest pad 的 d/r 从 pois() 现取，不手抄。
const read = `(() => {
  const R = window.__RSB, s = R.state;
  let best = null;
  for (const p of R.pois().filter(x => x.kind === 'pad')) {
    const d = Math.hypot(s.pos[0] - p.x, s.pos[2] - p.z);
    if (!best || d < best.d) best = { d: +d.toFixed(2), at: p.name, r: p.r };
  }
  return JSON.stringify({ speed: +(s.speed || 0).toFixed(2), pos: s.pos.map(v => +v.toFixed(2)), pad: best });
})()`;

const keyBase = k => ({ key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: undefined, nativeVirtualKeyCode: undefined });
const frames = n => evaluate(`__QA.step(${n}); 1`);
// 极性对照开关：置 1 时不按任何键，只让车在 warp 后坐到 150 帧。若这一趟仍报全绿，就说明
// `moved ≥ 3 / 越过盘半径` 判的是落位噪声而不是真驾驶——那时这把尺是装饰，不能拿绿跑放行。
const NOKEY = process.env.PAD_CENSUS_NOKEY === '1';
// 直线可跑 ~12 m 的帧预算（见下）——从 0 加速到 ~5.5 m/s 约需 45 帧，给到 150 帧足够越过 3.9 m 盘半径。
const DRIVE_FRAMES = 150;

const pads = JSON.parse(await evaluate(`JSON.stringify(window.__RSB.pois().filter(x => x.kind === 'pad')
  .map(p => ({ name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), r: p.r })))`));
console.log('PADS ' + pads.length + '  ' + pads.map(p => p.name).join(','));

const results = [];
for (const p of pads) {
  // 前提自造：位置钉盘心（search=0），朝向交产品 'out' —— 与走查 hud:pad-leave 同一支路。
  // 前提与走查 hud:pad-leave 逐字对齐：warp 之后先跑 120 帧让姿态坐定，再读起点。
  await evaluate(`(() => { const R = window.__RSB;
    R.warp(${p.x}, ${p.z}, 'out', 0); return 1; })()`);
  await frames(120);
  const start = JSON.parse(await evaluate(read));
  const yaw = +(await evaluate(`+((window.__RSB.state.yaw ?? 0)).toFixed(3)`));
  if (!NOKEY) await send('Input.dispatchKeyEvent', { ...keyBase('w'), type: 'keyDown' });
  if (!NOKEY) await send('Input.dispatchKeyEvent', { ...keyBase('w'), type: 'char', text: 'W' });
  // 只按 W 不转舵 ⇒ 沿 outwardBearing 那条净空航向走直线。DRIVE_FRAMES 帧（~2.5 s、直线可跑 ~12 m）
  // 让判据量的是"能不能越过 3.9 m 盘半径"，而不是"我给几帧"。
  await frames(DRIVE_FRAMES);
  await send('Input.dispatchKeyEvent', { ...keyBase('w'), type: 'keyUp' });
  const end = JSON.parse(await evaluate(read));
  // pos 是 [x, y, z]——地面行程只取 x/z，不能把 y（落位高度）混进 hypot。
  const moved = Math.hypot(end.pos[0] - start.pos[0], end.pos[2] - start.pos[2]);
  const onPad = start.pad && start.pad.at === p.name && start.pad.d <= p.r;
  // 判据与走查 hud:pad-leave 逐条对齐，任何一条不满足就是这台盘的 RED 复现。
  let fail = null;
  if (!onPad) fail = `precondition: after warp the nearest pad is ${start.pad && start.pad.at} d=${start.pad && start.pad.d} — never stood on ${p.name} (r=${p.r})`;
  else if (!(moved >= 3)) fail = `${NOKEY ? 'no key pressed (polarity control)' : 'held W'} for ${DRIVE_FRAMES} frames, travelled only ${moved.toFixed(2)} m (${start.pos}→${end.pos}), speed@read=${end.speed}`;
  else if (!(end.pad && end.pad.d > end.pad.r)) fail = `not off the pad at read: d=${end.pad && end.pad.d} of r=${end.pad && end.pad.r} at ${end.pos}`;
  else if (!(end.speed >= 2.5)) fail = `speed ${end.speed} m/s under the 2.5 parked bar`;
  results.push({ pad: p.name, r: p.r, yaw, start, end, moved: +moved.toFixed(2), fail });
  console.log(`${fail ? '!!' : '##'} PAD ${p.name} r=${p.r} yaw=${yaw} moved ${moved.toFixed(2)} m  ` +
    `d ${start.pad && start.pad.d}→${end.pad && end.pad.d} speed ${start.speed}→${end.speed}` + (fail ? `  FAIL ${fail}` : ''));
}

const failed = results.filter(r => r.fail);
console.log('SUMMARY ' + JSON.stringify(results.map(r => ({ pad: r.pad, moved: r.moved, fail: r.fail || undefined }))));
console.log(`PADS ${results.length} FAILED ${failed.length}`);
const rc = failed.length === 0 ? 0 : 1;
console.log(`VERDICT ${failed.length === 0 ? 'ALL_PADS_DRIVABLE' : 'PAD_EXIT_RED'} — ` +
  (failed.length === 0 ? '每台盘按 W 都能开走并越过自身半径' : `开不走的台：${failed.map(r => r.pad).join(',')}`));
fs.writeSync(1, 'PAD_CENSUS_RC=' + rc + '\n');
try { ws.close(); } catch { /* already closed */ }
process.exit(rc);
