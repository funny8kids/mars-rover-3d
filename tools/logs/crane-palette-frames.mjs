// 吊车配色的眼睛那一格：把机位各渲染一次，判「吊车与它骑的门架梁还读不读成一根梁」。
//
// 两件事是上一版脚本自己踩出来的坑，都写在这里而不是注释掉：
//  1. PNG 由 :8123 收集器落盘（`R.shot` 按 name POST data URL），本脚本再把那份拷进 outDir。
//     自己用 CDP `Page.captureScreenshot` 拍的是整页 1920x1080，画布只占左边 45 % —— 那不是
//     出货抓帧的口径，已入库的 crane-*.png 全是收集器写的 640x696 画布裁切。
//  2. 天空要自己钉。`shot()` 只挪方向光的位置，不动强度：这一页跑完 300 s 巡航后时钟已到
//     LMT 21:20，方向光是月光强度，于是「avenue-day」拍出来是夜景。所以每条链先 clearSky +
//     setDay(0.30)（`tools/cdp-clip-sweep.mjs` 的 DAY_T.day）再把帧抽稳，并把 shot() 自己报的
//     key 抄进读数 —— 一把读不出「是哪盏灯打的」的尺不配判观感。
//  3. 每帧带主体占比（hFrac/wFrac，吊车 8 角点，口径同 tools/cdp-subject-fraction-probe.mjs）：
//     上一版我打开图看不出吊车在哪，就是因为没有任何一格读数说「吊车在不在画面里」。
import fs from 'fs';

const PORT = 9333, OUT = process.argv[2] || 'tools/logs/shots-crane-palette-2026-09-29';
const DAY_T = 0.30;
fs.mkdirSync(OUT, { recursive: true });
const startedAt = Date.now();

const ping = await (await fetch('http://127.0.0.1:8123/ping')).json().catch(() => null);
if (!ping?.out || !fs.existsSync(ping.out)) {
  console.log('FRAMES_FAIL COLLECTOR_UNREACHABLE ' + JSON.stringify(ping));
  process.exit(1);
}
console.log('COLLECTOR_OUT ' + ping.out);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('FRAMES_FAIL NO_PAGE_TARGET'); process.exit(1); }
console.log('TARGET ' + page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const o = JSON.parse(e.data); if (o.id && pend.has(o.id)) {
  const { res, rej } = pend.get(o.id); pend.delete(o.id);
  o.error ? rej(new Error(o.error.message)) : res(o.result); } };
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
const ev = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('PAGE_EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const ready = async () => { for (let i = 0; i < 60; i++) {
  if (await ev('!!(window.__RSB && window.__RSB.ground)')) return true;
  await new Promise(s => setTimeout(s, 2000)); } return false; };
if (!await ready()) { console.log('FRAMES_FAIL NOT_READY'); process.exit(1); }

// 天空抽稳：nightF 是平滑跟随量，设完时钟立刻拍读到的是上一片天（表达式抄 clip-sweep:149）。
const settle = JSON.parse(await ev(`(async () => {
  const R = window.__RSB;
  R.clearSky();
  R.setDay(${DAY_T});
  let prev = -1, pumped = 0, nf = 0, sun = -1;
  for (let k = 0; k < 400; k++) {
    R.frame(0.05); pumped++;
    const e = R.env();
    nf = +((e.state || {}).nightF ?? -1).toFixed(4);
    const s = e.sun ? +e.sun.intensity.toFixed(3) : -1;
    if (prev === nf && s === sun) break;
    prev = nf; sun = s;
  }
  R.setDay(${DAY_T}); R.frame(0.05);
  const e = R.env(), st = e.state || {};
  return JSON.stringify({ pumped, nightF: st.nightF ?? null, dayF: st.dayF ?? null,
    duskF: st.duskF ?? null, clock: st.clock ?? null, sun: e.sun ? +e.sun.intensity.toFixed(2) : null });
})()`));
console.log('SKY day dayT=' + DAY_T + ' settled in ' + settle.pumped + ' frames · ' + JSON.stringify(settle));
if (settle.nightF === null) console.log('  ! env().state.nightF is not readable — the follower cannot be proven settled');
if (settle.pumped === 0) console.log('  ! day settled without advancing — these frames read the previous sky');

// 主体占比。上一轮入库的 crane-frames-2026-09-29.json 里 subj 四行全是
// {hFrac:-1e9,wFrac:-1e9,behind:8} —— 那是「8 角点全被判在相机背后」时没人动过的哨兵值，
// 也就是说那一列从头到尾是装饰。根因是 `cam.matrixWorldInverse` 在这页上取不到有效视图矩阵，
// 所以这里不引它：只用相机自己的 matrixWorld 取 right/up/forward 三条基向量，加 fov/aspect
// 手算 NDC。并且自带控制组：把相机正前方 5 m 那个点投一遍，它必须落在画面中心附近，
// 否则整列读数作废（SUBJ_UNVERIFIED）而不是交一个哨兵出去。
const frac = async (at, look) => await ev(`(() => {
  const R = window.__RSB, cam = R.camera();
  const box = ${CRANE_BOX};
  // 矩阵要自己刷新：shot() 之后没有东西再渲染，而相机不是 scene 的子节点，
  // 不 updateMatrixWorld 读到的就是恒等矩阵 —— 这正是 tools/cdp-subject-fraction-probe.mjs:116
  // 显式刷新的原因，也是上一轮 subj 四行全是哨兵（behind=8）的根因。
  // 注意：这段注释在一个模板字符串里，出现反引号会把字符串截断。
  R.scene().updateMatrixWorld(true);
  cam.updateMatrixWorld(true);
  const e = cam.matrixWorld.elements, cp = cam.position;
  const right = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]], fwd = [-e[8], -e[9], -e[10]];
  const tan = Math.tan(cam.fov * Math.PI / 360);
  const ndc = p => {
    const d = [p[0] - cp.x, p[1] - cp.y, p[2] - cp.z];
    const depth = d[0]*fwd[0] + d[1]*fwd[1] + d[2]*fwd[2];
    if (depth <= 0.1) return null;
    const dx = d[0]*right[0] + d[1]*right[1] + d[2]*right[2];
    const dy = d[0]*up[0] + d[1]*up[1] + d[2]*up[2];
    return [dx / (depth * tan * cam.aspect), dy / (depth * tan)];
  };
  const centre = [(box.lo[0]+box.hi[0])/2, (box.lo[1]+box.hi[1])/2, (box.lo[2]+box.hi[2])/2];
  const ctrl = ndc([cp.x + fwd[0]*5, cp.y + fwd[1]*5, cp.z + fwd[2]*5]);
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,misses=0;
  for (let a=0;a<2;a++) for (let b=0;b<2;b++) for (let c=0;c<2;c++) {
    const q = ndc([a?box.hi[0]:box.lo[0], b?box.hi[1]:box.lo[1], c?box.hi[2]:box.lo[2]]);
    if (!q) { misses++; continue; }
    minX=Math.min(minX,q[0]); maxX=Math.max(maxX,q[0]);
    minY=Math.min(minY,q[1]); maxY=Math.max(maxY,q[1]);
  }
  const ok = !!ctrl && Math.abs(ctrl[0]) < 0.05 && Math.abs(ctrl[1]) < 0.05 && misses < 8;
  return JSON.stringify({ ok, ctrl: ctrl && ctrl.map(v => +v.toFixed(3)), misses,
    centreNdc: (n => n && n.map(v => +v.toFixed(3)))(ndc(centre)),
    hFrac: ok ? +((maxY-minY)/2).toFixed(3) : null, wFrac: ok ? +((maxX-minX)/2).toFixed(3) : null });
})()`);
const CRANE_BOX = await ev(`(() => {
  const scene = window.__RSB.scene();
  const parts = [];
  scene.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some(m => m && /overhead_crane/.test(m.name || ''))) parts.push(o);
  });
  let lo = [1e9,1e9,1e9], hi = [-1e9,-1e9,-1e9];
  for (const o of parts) {
    const p = o.geometry.attributes.position, e = o.matrixWorld.elements;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const w = [e[0]*x + e[4]*y + e[8]*z + e[12], e[1]*x + e[5]*y + e[9]*z + e[13], e[2]*x + e[6]*y + e[10]*z + e[14]];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
  }
  return JSON.stringify({ meshes: parts.length, lo: lo.map(v => +v.toFixed(2)), hi: hi.map(v => +v.toFixed(2)) });
})()`);
console.log('CRANE_BOX ' + CRANE_BOX);


// 机位名一律换新前缀：`R.shot(name, …)` 会按 name 往收集器落盘，沿用上一轮的 crane-1-avenue-day
// 会把已入库的那批证据吃掉。
const VANTAGES = [
  ['crane-pal-1-avenue-day', 62, 104, 9.3],
  ['crane-pal-2-under-hook', 62, 88, 10.5],
];
let failed = 0;
for (const [name, vx, vz, lookY] of VANTAGES) {
  const dst = `${OUT}/${name}.png`;
  if (fs.existsSync(dst)) fs.rmSync(dst);
  const read = JSON.parse(await ev(`(async () => {
    const R = window.__RSB;
    R.setDay(${DAY_T});
    const g = R.ground(${vx}, ${vz});
    const at = [${vx}, (g && g.stand != null ? g.stand : 2) + 1.6, ${vz}];
    const look = [62, ${lookY}, 76];
    const r = await R.shot(${JSON.stringify(name)}, at, look, [-150, 120, 95]);
    return JSON.stringify({ at: at.map(v => +v.toFixed(2)), look, clip: r.clip, burn: r.burn,
      bins: r.bins, key: r.key, status: r.status });
  })()`));
  const subj = JSON.parse(await frac(read.at, read.look));
  // 收集器是异步落盘的：等到文件出现且比本脚本起跑更新，才敢拷。
  const srcFile = `${ping.out}/${name}.png`;
  let ok = false;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(srcFile) && fs.statSync(srcFile).mtimeMs >= startedAt) { ok = true; break; }
    await new Promise(s => setTimeout(s, 500));
  }
  if (!ok) { console.log('FRAME_FAIL ' + name + ' NO_COLLECTOR_PNG ' + srcFile); failed++; continue; }
  fs.copyFileSync(srcFile, dst);
  if (!subj.ok) console.log('SUBJ_UNVERIFIED ' + name + ' ' + JSON.stringify(subj) + ' — the hFrac/wFrac column is not usable for this frame');
  console.log(`SHOT ${name} ${JSON.stringify(read)} subj=${JSON.stringify(subj)} -> ${dst}`);
}
console.log('FRAMES_' + (failed ? 'FAIL ' : 'DONE ') + VANTAGES.length + ' failed=' + failed + ' -> ' + OUT);
ws.close();
process.exit(failed ? 1 : 0);
