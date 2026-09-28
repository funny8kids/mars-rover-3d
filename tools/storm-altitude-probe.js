// 【E】1c 的第二把尺子：色偏随**世界海拔**（不是画面竖向）—— 补 ledger 点名未测的那一档
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-altitude-probe.js
//
// 为什么要单独一把：已提交的 tools/storm-hue-probe.js 量的是画面顶/中/底三条带（storm-hue-mutate.js
// 证明了分级分支的 `low` 就是 uv.y）。那把尺子对「相机抬高」是盲的：把相机竖直抬 57 m，三条带在屏幕上
// 一动不动，分支的贡献一分不少——所以它读不出「空气本身在不同海拔是不是不同颜色」。
//
// 控制变量：CAM 与 LOOK 一起抬高同一个量 ⇒ 视线方向、俯仰、构图完全不变，唯一变的是这束射线穿过哪一层空气。
// 判据帧仍走 buried（peak/-120），storm 与 calm 同一海拔成对采，晴空那一支是「天光本身随海拔变」的对照。
//
// 锚：A=0 那一格必须复现已提交日志（storm-hue-2026-09-29-000453.log）的 storm split −0.7958
// ——新尺子在两把尺子共有的那一点上必须与旧尺子同值，否则「随海拔不变」可能只是新尺子坏了。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const fin = (x) => Number.isFinite(x);
  const rd = (x, d = 4) => (fin(x) ? +x.toFixed(d) : x);
  const W = (b) => (b && fin(b[0]) && fin(b[2]) && b[2] > 0 ? b[0] / b[2] : NaN);
  const LIGHT = 400;                       // bins 是千分比：400‰ = 40 % 暗部地板
  const PCT = (v) => (fin(v) ? (v / 10).toFixed(1) + ' %' : String(v));
  if (!R.state || !R.state.started) return 'NOT_STARTED';

  const ps = R.post().composer.passes;
  const gi = ps.findIndex((p) => p.material && p.material.uniforms && p.material.uniforms.uStorm);
  const uStorm = () => (gi < 0 ? NaN : Number(ps[gi].material.uniforms.uStorm.value));

  const X = [-26, 3.0, 34], LK = [0, 1.6, -46];   // 已提交那把尺子的机位（海拔 0 档）
  const ALT = [0, 15, 37, 57];                    // 相对抬高（m）：驾驶高度 → 塔顶 → 穿出 slab 之前
  const DAYT = 0.46;                              // 与锚日志同一时刻

  const setStorm = (on) => {
    if (!on) { R.clearSky(); return Promise.resolve(); }
    R.pinStorm('peak', -120, 0);
    return sleep(1800);
  };
  const waitStorm = async (min, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (uStorm() >= min) return true; await sleep(300); }
    return uStorm() >= min;
  };
  const cap = async (name, dz) => {
    await oneFrame();
    const s = await Promise.race([R.shot(name, [X[0], X[1] + dz, X[2]], [LK[0], LK[1] + dz, LK[2]], null),
      sleep(9000).then(() => null)]);
    if (!s || !s.heights) return { name, failed: 'no frame', dz };
    const wg = W(s.heights.ground), ws = W(s.heights.sky), wm = W(s.heights.mid);
    return { name, dz, dayT: R.state && R.state.dayT, uStorm: rd(uStorm(), 3),
      wSky: rd(ws), wMid: rd(wm), wGround: rd(wg), split: rd(wg - ws),
      bins0: s.bins ? s.bins[0] : null, heightsPresent: true };
  };

  const rows = [], skip = [];
  const add = (id, pass, note) => { rows.push({ id, ok: !!pass, note }); return pass; };
  const at = (n) => frames.filter((f) => f.name === n && !f.failed)[0];
  const frames = [];

  // ---- 采样：每个海拔先晴后暴；A=0 的暴与晴各采两帧量噪声 ----
  R.setDay(DAYT); await sleep(900);
  for (const dz of ALT) {
    R.unpinStorm(); await setStorm(false); await sleep(700);
    frames.push(await cap(`e1a-d${dz}-calmA`, dz));
    if (dz === 0) frames.push(await cap('e1a-d0-calmB', dz));
    await setStorm(true); await waitStorm(0.9, 22000); await sleep(1500);
    frames.push(await cap(`e1a-d${dz}-stormA`, dz));
    if (dz === 0) frames.push(await cap('e1a-d0-stormB', dz));
  }
  R.unpinStorm(); R.clearSky();

  const ok = frames.filter((f) => !f.failed);
  const pair = (dz) => ({ c: at(`e1a-d${dz}-calmA`), s: at(`e1a-d${dz}-stormA`) });
  const split = (f) => (f && fin(f.split) ? f.split : NaN);

  // 噪声：A=0 的重复帧（同机位同条件，只差一次渲染）
  const nS = Math.abs(split(at('e1a-d0-stormA')) - split(at('e1a-d0-stormB')));
  const nC = Math.abs(split(at('e1a-d0-calmA')) - split(at('e1a-d0-calmB')));
  const noise = Math.max(nS, nC);
  const THRESH = Math.max(0.12, 5 * noise);       // 0.12 = 已提交那把尺子标定过的跑间漂移地板（2×0.0535）

  // ---- G0 仪器自证：每一档既有色度、又不是暗帧、而且暴真的开着 ----
  add('G0 尺子在读真像素（各海拔三带色度有限、判据帧暗部 < 40 %、storm 帧 uStorm ≥ 0.5）',
    ok.length === ALT.length * 2 + 2 && ok.every((f) => fin(f.wSky) && fin(f.wGround) && f.heightsPresent)
      && ok.every((f) => f.bins0 < LIGHT) && ok.filter((f) => f.name.includes('storm')).every((f) => f.uStorm >= 0.5),
    `帧 ${ok.length}/${ALT.length * 2 + 2}；uStorm ${ok.filter((f) => f.name.includes('storm')).map((f) => `+${f.dz}m ${f.uStorm}`).join(' ')}；暗部 ${ok.map((f) => `${f.name.slice(4)}:${PCT(f.bins0)}`).join(' ')}`);
  ok.filter((f) => f.bins0 >= LIGHT).forEach((f) => skip.push(`${f.name} 暗部 ${PCT(f.bins0)} 超标——暗像素色度是量化噪声，不参与海拔判据`));

  // ---- G1 锚：A=0 必须复现已提交日志的 storm split −0.7958 ----
  const ANCHOR = -0.7958, ATOL = Math.max(0.2, 3 * noise);
  const s0 = split(at('e1a-d0-stormA'));
  add(`G1 新尺子在共有那一点上复现旧尺子：A=0 storm split 落在 ${ANCHOR} ± ${rd(ATOL, 3)}（锚 = storm-hue-2026-09-29-000453.log）`,
    fin(s0) && Math.abs(s0 - ANCHOR) <= ATOL,
    `A=0 实测 ${rd(s0)}（旧尺子 ${ANCHOR}），容差 ${rd(ATOL, 3)}，噪声 max(${rd(nS)},${rd(nC)})=${rd(noise)}`);

  // ---- G2 判据：沙暴造成的竖向色偏随世界海拔变化（差中差）----
  // 不能只看暴内 split 随海拔的跨度：把相机竖直抬高时，晴空那一支也在动（画面里的地面带换成了更远的
  // 地形、天空带换成了更高处的天光）。第一跑就是这么读错的——暴内跨度 0.9484，但同一批晴空对照跨度
  // 0.8267，两者几乎同量，说明那 0.95 里绝大部分只是"平移取景框"的几何效应。
  // 所以判据落在 d(alt) = split(storm) − split(calm) 的跨度上：同一海拔的晴暴相减把几何项扣掉。
  const usable = ALT.map(pair).filter((p) => p.c && p.s && !skip.some((s) => s.includes(p.s.name)));
  const prof = usable.map((p) => ({ dz: p.s.dz, storm: split(p.s), calm: split(p.c),
    d: rd(split(p.s) - split(p.c)), dStorm: rd(split(p.s) - s0), uStorm: p.s.uStorm }));
  const span = prof.length ? Math.max(...prof.map((p) => p.storm)) - Math.min(...prof.map((p) => p.storm)) : NaN;
  const calmSpan = prof.length ? Math.max(...prof.map((p) => p.calm)) - Math.min(...prof.map((p) => p.calm)) : NaN;
  const dSpan = prof.length ? Math.max(...prof.map((p) => p.d)) - Math.min(...prof.map((p) => p.d)) : NaN;
  add(`G2 色偏随世界海拔（差中差）：暴内减晴空的 d = split(storm) − split(calm) 在 ${ALT.join('/')} m 四档之间的跨度 ≥ ${rd(THRESH, 3)}（阈值 = max(0.12, 5×噪声 ${rd(noise, 4)})；同海拔相减扣掉"平移取景框"的几何项）`,
    prof.length >= 3 && fin(dSpan) && dSpan >= THRESH,
    prof.map((p) => `+${p.dz}m d ${p.d}（storm ${rd(p.storm)} calm ${rd(p.calm)} uStorm ${p.uStorm}）`).join('; ')
      + ` ⇒ d 跨度 ${rd(dSpan)}；未扣几何项的暴内跨度 ${rd(span)}、晴空跨度 ${rd(calmSpan)}（两者同量即说明那一半是取景框平移，不是沙暴）`);

  // ---- G3 归因：色偏的变化是不是只是「暴变弱了」——uStorm 随海拔的跨度 ----
  const uSpan = prof.length ? Math.max(...prof.map((p) => p.uStorm)) - Math.min(...prof.map((p) => p.uStorm)) : NaN;
  const uFlat = fin(uSpan) && uSpan <= 0.15;
  add('G3 归因：若 split 随海拔动，必须说清是空气分层还是相机逃出了尘幕 —— uStorm 跨度 ≤ 0.15 才算「暴没变」，否则 G2 只读到暴强随海拔衰减',
    fin(uSpan),
    `uStorm 跨度 ${rd(uSpan, 3)}（${uFlat ? '暴强近似恒定 ⇒ G2 读到的是空气本身的分层' : '暴强随海拔变化 ⇒ G2 的跨度里混了"逃出去"这一半，不能单独当作分层证据'}）`);

  const failed = rows.filter((r) => !r.ok);
  return JSON.stringify({
    verdict: failed.length ? `STORM_ALT_FAIL ${failed.length}/${rows.length}` : `STORM_ALT_PASS ${rows.length}/${rows.length}`,
    failed: failed.map((f) => f.id + ' :: ' + f.note),
    rows, skip, frames: ok,
    prof, noise: { nStorm: rd(nS), nCalm: rd(nC), used: rd(noise), threshold: rd(THRESH, 3) },
    setup: { dayT: DAYT, baseCam: X, look: LK, altitudes_m: ALT, pin: "peak/-120 (buried)",
      note: 'CAM 与 LOOK 同量竖直平移 ⇒ 视线方向与构图不变，唯一变量是射线穿过哪层空气' },
  }, null, 1);
})()
