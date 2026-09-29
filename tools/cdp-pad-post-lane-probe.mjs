// usage: node tools/cdp-pad-post-lane-probe.mjs <url> [port]
//
// A13 的取证尺。`tools/logs/tour-a4-2026-09-29-genset*.log` 与 `tools/logs/tour-leg-comms-pad4-2026-09-29.log`
// 都 filed 同一次 `no-net-progress`：车身停在 (48.2,-70.8) 附近、油门 0.41 一直踩着、`range=0`，
// `pocket` 只有 `comms:pad4#2` 一件。同一行的 `lane` 列却读 9 —— 而 `main.js:4351` 是
// `lane > 9 ? 9 : +lane.toFixed(2)`，9 是 `laneMargin` 空列表时的哨兵 99 被夹出来的样子。
// 这一跑只回答一个问题：**停车控制器逐帧用的那把线段尺，看不见光台自己的哪一副盘。**
//
// 口径全部从产品自己嘴里取：盘表来自 `__RSB.solids()`（就是 `base.colliders`），车身环 1.6 m 与
// 20 m 过滤半径逐字抄 `main.js` 的 `laneMargin`/`parkSpot`（这里不复制常量到判据里，只做算式）。
// 这里不改判据、不改产品 —— 只把"谁在列表里、谁不在"打印出来。
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
  return r.result.value;
};
await send('Runtime.enable');

// The pose the two FAIL runs and the leg repro all agree on: the wedge stance and the park point the
// controller aimed at, both read off `tour-leg-comms-pad4-2026-09-29.log` rows 63.5 → 65.3.
const expr = `(() => {
  const R = window.__RSB;
  if (!R || !R.solids) return 'NO_RSB';
  const all = R.solids();
  const idOf = c => String(c.prop ?? c.name ?? c.id ?? '(unnamed)');
  const fields = Object.keys(all[0]);
  const pad4 = all.filter(c => idOf(c).includes('pad4'));
  const S = [48.1, -70.7], P = [53.6, -66.5], C = [51, -68];
  const lane = (a, b, discs) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz || 1;
    let m = 99, by = null;
    for (const c of discs) {
      let t = ((c.x - a[0]) * dx + (c.z - a[1]) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const v = Math.hypot(a[0] + dx * t - c.x, a[1] + dz * t - c.z) - c.r - 1.6;
      if (v < m) { m = v; by = idOf(c); }
    }
    return { m: +m.toFixed(2), by };
  };
  const inList = all.filter(c => c.floor === undefined);
  const near = discs => discs.filter(c => Math.hypot(c.x - S[0], c.z - S[1]) < 20 + c.r);
  // marginAt-shaped reading at the park point and at the wedge stance: max penetration of the hull ring
  const pen = (p, discs) => {
    let q = 0, who = null;
    for (const c of discs) {
      const v = c.r + 1.6 - Math.hypot(p[0] - c.x, p[1] - c.z);
      if (v > q) { q = v; who = idOf(c); }
    }
    return { p: +q.toFixed(2), who };
  };
  return {
    totalDiscs: all.length,
    fields,
    pad4Count: pad4.length,
    pad4: pad4.map(c => ({ id: idOf(c), x: +c.x.toFixed(2), z: +c.z.toFixed(2), r: +c.r.toFixed(3),
      floorRaw: JSON.stringify(c.floor), top: c.top === undefined ? null : +c.top.toFixed(2) })),
    inListCount: inList.length,
    laneAll: lane(S, P, all),
    laneFloorUndefined: lane(S, P, inList),
    laneParkSpotFilter: lane(S, P, near(inList)),
    penAtParkAll: pen(P, inList),
    penAtWedgeAll: pen(S, inList),
    // the two lines the search actually spans, per main.js:4076 — rover→stance and stance→pad
    laneStanceToPad: lane(S, C, inList),
    postIdsReachable: inList.some(c => idOf(c).includes('pad4')),
  };
})()`;

const out = await evaluate(expr);
if (out === 'NO_RSB') { console.log('NO_RSB'); process.exit(1); }
console.log('TOTAL_DISCS ' + out.totalDiscs);
console.log('FIELDS ' + out.fields.join(','));
console.log('PAD4_DISCS ' + out.pad4Count + ' IN_FLOOR_UNDEFINED_LIST ' + out.postIdsReachable);
for (const d of out.pad4) console.log(`DISC ${d.id} x=${d.x} z=${d.z} r=${d.r} floor=${d.floorRaw} top=${d.top}`);
console.log(`LANE_ALL ${out.laneAll.m} by=${out.laneAll.by}`);
console.log(`LANE_FLOOR_UNDEFINED ${out.laneFloorUndefined.m} by=${out.laneFloorUndefined.by}`);
console.log(`LANE_PARKSPOT_FILTER_20M ${out.laneParkSpotFilter.m} by=${out.laneParkSpotFilter.by}`);
console.log(`LANE_STANCE_TO_CENTRE ${out.laneStanceToPad.m} by=${out.laneStanceToPad.by}`);
console.log(`PEN_AT_PARK p=${out.penAtParkAll.p} who=${out.penAtParkAll.who}`);
console.log(`PEN_AT_WEDGE p=${out.penAtWedgeAll.p} who=${out.penAtWedgeAll.who}`);
ws.close();
process.exit(0);
