// 【E】1 的四格从未入册的判据 —— 分级器读的是同一条链：stormF → post uniforms / audio gains
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-grade-probe.js
//
// 目标条目（objective 【E】1 里点名、但 EVIDENCE_LEDGER 过去根本没有行）：
//   ① 粒子与光照/体积光耦合  ② 暴后沉积 dust 覆盖层（镜头砂粒 = stormF 与残膜之和）
//   ③ 随高度/时间的色偏中「随时间」那一半  ④ 音效与风压联动
//
// 为什么量 uniform 而不是量截图：写这些标量的是 src/main.js:2624-2642 的纯 JS（每个渲染帧重算一遍），
// `__RSB.post()` 直接把那张 ShaderPass 的 uniforms 交出来。截图会把着色器分支、bloom、JPEG 编码混进
// 同一个数里；这里要判的是「沙暴强度到达成像/音频参数的耦合到底存不存在」，标量级读数就够，且可复核。
//
// 三个防自欺的设定：
//  - 结构零对照（A1）：晴空 + 膜 0 时 uDirt 必须是 0；若它是个下限常数，「沉积层」这条就是假的。
//  - 极性对照（C0）：体积光这一族闸门（sunOnFrame/dayF）能被满足吗？先在晴空扫一天，找到
//    uGodRay 真的 > 0 的那个 dayT，才在同一个 dayT 上比暴内暴外。找不到就 SKIP，不算通过。
//  - 音频面（D）：headless 里 AudioContext 多半是 suspended，setTargetAtTime 的 .value 就不动。
//    所以 D 先报 ctx.state；只有 running 才判，否则记 SKIP 并给原因——SKIP 不进分子。
//
// 判据全部从 tally 数出来（不在文件里手写条数），SKIP 与 FAIL 分开列。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 上一跑死在无界 await 上（300 s 被 timeout 掐掉，rc=124，日志里只有 READY）。
  // 每一帧等待都封顶 1.5 s：宁可读到"没跟上"的值让判据自己红，也绝不永远不返回。
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const frames = async (n) => { for (let i = 0; i < n; i++) await oneFrame(); void n; };
  const U = () => {
    const ps = R.post().composer.passes;
    for (const p of ps) { const u = p.material && p.material.uniforms; if (u && u.uStorm) return u; }
    return null;
  };
  const g = (k) => { const u = U(); return u ? Number(u[k].value) : NaN; };
  const rd = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
  // roverFilm 有主人：__RSB.film() 直接交出 .rover（main.js:2891）。A3 的算式里有它，就必须把它一起读，
  // 不能拿一条只含 stormF 的公式去判一个两项之和——那是上一跑 A3 红的真实原因。
  const filmNow = () => { const f = R.film && R.film(); return f ? Number(f.rover) : NaN; };
  // 定长 sleep 是错的量法：stormF / roverFilm 都是 follower，2 s 快照量到的是"追到哪了"而不是"停在哪"。
  // 改成按条件收汗：每 300 ms 采一次，连续三次变化 < 0.004 才算平台；封顶 15 s 一定返回。
  const plateau = async (k, capMs = 15000) => {
    let last = g(k), same = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < capMs) {
      await sleep(300); await frames(3);
      const v = g(k);
      if (Math.abs(v - last) < 0.004) { if (++same >= 3) return { v, waited: Date.now() - t0 }; }
      else same = 0;
      last = v;
    }
    return { v: last, waited: Date.now() - t0, timedOut: true };
  };
  const settleBelow = async (k, eps, capMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < capMs) {
      await sleep(250); await frames(2);
      if (g(k) <= eps) return { v: g(k), waited: Date.now() - t0 };
    }
    return { v: g(k), waited: Date.now() - t0, timedOut: true };
  };
  const u = U();
  if (!R.state || !R.state.started) return 'NOT_STARTED';
  if (!u) return 'NO_GRADE_UNIFORMS';

  // 上一跑 5 条红全在 uDirt=NaN，而同页逐 pass 倾倒显示第 3 个 pass 同时持有 uStorm 与 uDirt（值 number:0）。
  // 两边不可能都对，所以把"我这跑到底选中了哪个对象"随读数一起交回来，而不是再去另一页猜一次。
  const diag = (() => {
    const ps = R.post().composer.passes;
    const i = ps.findIndex((p) => p.material && p.material.uniforms && p.material.uniforms.uStorm);
    const p = ps[i]; const uu = p && p.material.uniforms;
    return {
      picked: i,
      ctor: p && p.constructor && p.constructor.name,
      hasDirt: !!(uu && uu.uDirt),
      dirtType: uu && uu.uDirt ? typeof uu.uDirt.value : 'absent',
      dirtRaw: uu && uu.uDirt ? String(uu.uDirt.value).slice(0, 20) : '-',
      passUniformsSameObj: !!(p && p.uniforms === uu),
      keys: uu ? Object.keys(uu) : [],
      postKeys: Object.keys(R.post()),
    };
  })();

  const skip = [];
  const rows = [];
  const add = (id, ok, note) => { rows.push({ id, ok: !!ok, note }); return ok; };

  // ---- 归零：晴空 + 无残膜（按条件等到读数落定，不是固定 sleep）----
  R.clearSky(); R.setFilm(0, 0);
  const toZero = await settleBelow('uStorm', 0.02);
  await frames(3);
  const calm = { storm: g('uStorm'), dirt: g('uDirt'), vig: g('uVignette'), grain: g('uGrain'), ca: g('uCA'), film: filmNow() };

  // ---- ① 结构零：晴空无膜时镜头必须是干净的 ----
  add('A1 晴空无膜 ⇒ uDirt=0（否则"沉积层"是下限常数）', calm.dirt <= 0.001 && calm.storm <= 0.02 && calm.film <= 0.001,
    `uDirt ${rd(calm.dirt, 5)} uStorm ${rd(calm.storm, 3)} film ${rd(calm.film, 5)} settle ${JSON.stringify(toZero)} diag ${JSON.stringify(diag)}`);

  // ---- 钉一场峰值沙暴 ----
  // A2/A4 在 peak@40 下红得可疑：stormF 只到 0.023，而 E2 用 front@20 m 量到 local dust 0.563。
  // 与其再猜一个 standoff，先交一条 (phase, standoff) 梯子，逐格把 stormF 带回来，取最高那格当峰值。
  // storm.js:71-73 写明了 standoff 的方向语义：正的把墙钉在上风远处（视点在干净空气里），
  // 负的把视点埋进 slab 里。上一版梯子只扫了正半边，所以量到的是"衰减曲线"而不是"振幅上限"。
  const ladder = [];
  for (const [ph, so] of [['peak', -40], ['peak', -120], ['front', -40], ['front', 20], ['peak', 20], ['peak', 80]]) {
    R.pinStorm(ph, so, 0); await sleep(1500); await frames(12);
    ladder.push({ ph, so, storm: rd(g('uStorm'), 4), dirt: rd(g('uDirt'), 4) });
  }
  const best = ladder.reduce((a, b) => (Number(b.storm) > Number(a.storm) ? b : a), ladder[0]);
  const pinPeak = async () => { R.pinStorm(best.ph, best.so, 0); return plateau('uStorm'); };
  const peakHold = await pinPeak();
  const peak = { storm: g('uStorm'), dirt: g('uDirt'), vig: g('uVignette'), grain: g('uGrain'), ca: g('uCA'), god: g('uGodRay'), film: filmNow() };
  R.unpinStorm(); R.clearSky();
  const afterUnpin = await settleBelow('uStorm', 0.05);
  await frames(4);
  const back = { storm: g('uStorm'), dirt: g('uDirt'), vig: g('uVignette'), film: filmNow() };

  // ---- ② 沙暴驱动成像：uStorm 要跟到 uDirt/暗角/颗粒 ----
  add('A2 峰值把 uStorm 抬起来（stormF 真的进了分级器）', peak.storm >= 0.5,
    `uStorm calm ${rd(calm.storm, 3)} → plateau ${rd(peak.storm, 3)}（best rung ${best.ph}@${best.so} m，等待 ${peakHold.waited} ms${peakHold.timedOut ? ' 封顶' : ''}）`);
  add('A3 镜头脏度跟 stormF 与残膜两项：uDirt ≈ 0.62·uStorm + 0.55·film（±0.02）',
    Math.abs(peak.dirt - (0.62 * peak.storm + 0.55 * peak.film)) <= 0.02,
    `uDirt ${rd(peak.dirt)} vs 0.62·${rd(peak.storm)} + 0.55·film ${rd(peak.film, 3)} = ${rd(0.62 * peak.storm + 0.55 * peak.film)}`);
  add('A4 暗角与颗粒随风压上：Δvig ≥ 0.15、Δgrain ≥ 0.02',
    peak.vig - calm.vig >= 0.15 && peak.grain - calm.grain >= 0.02,
    `vig ${rd(calm.vig)}→${rd(peak.vig)} grain ${rd(calm.grain)}→${rd(peak.grain)} @ uStorm ${rd(peak.storm, 3)}`);
  add('A5 撤暴后成像回到基线（不是单向开关）', back.storm <= 0.05 && Math.abs(back.vig - calm.vig) <= 0.03,
    `uStorm ${rd(back.storm, 3)} vig ${rd(back.vig)} settle ${JSON.stringify(afterUnpin)} film ${rd(back.film, 4)}`);

  // ---- ③ 暴后沉积：晴空下残膜单独撑住 uDirt ----
  R.setFilm(0.8, 0.8); await sleep(600); await frames(6);
  const filmOnly = { storm: g('uStorm'), dirt: g('uDirt'), film: filmNow() };
  R.setFilm(0, 0); await sleep(600); await frames(6);
  const cleared = { storm: g('uStorm'), dirt: g('uDirt'), film: filmNow() };
  add('B1 晴空＋残膜单独撑住覆盖层：uDirt ≈ 0.62·storm + 0.55·film 且 storm≈0',
    filmOnly.storm <= 0.05 && Math.abs(filmOnly.dirt - (0.55 * filmOnly.film + 0.62 * filmOnly.storm)) <= 0.02 && filmOnly.dirt >= 0.4,
    `uDirt ${rd(filmOnly.dirt)} vs 0.55·film ${rd(filmOnly.film, 3)} + 0.62·storm ${rd(filmOnly.storm, 3)} = ${rd(0.55 * filmOnly.film + 0.62 * filmOnly.storm)}`);
  add('B2 擦干净后回零（沉积是有主人的量，不是贴图）', cleared.dirt - 0.62 * cleared.storm <= 0.001,
    `setFilm(0) → uDirt ${rd(cleared.dirt, 5)}，同期 storm 项 0.62·uStorm ${rd(0.62 * cleared.storm, 5)}，film ${rd(cleared.film, 5)}`);

  // ---- ④ 体积光耦合：先证明闸门可满足，再在同一 dayT 比 ----
  const sweep = [];
  for (let d = 0.06; d <= 0.94; d += 0.08) {
    R.setDay(d); await sleep(260); await frames(4);
    const clear = g('uGodRay');
    if (clear > 0.001) {
      await pinPeak();
      const inStorm = { god: g('uGodRay'), storm: g('uStorm') };
      R.unpinStorm(); R.clearSky(); await sleep(300); await frames(4);
      sweep.push({ dayT: +d.toFixed(2), clear: rd(clear), inStorm: rd(inStorm.god), uStorm: rd(inStorm.storm, 3) });
    } else sweep.push({ dayT: +d.toFixed(2), clear: rd(clear), inStorm: null });
  }
  const lit = sweep.filter((s) => s.inStorm !== null && s.clear > 0.001);
  if (!lit.length) skip.push('C 体积光耦合：扫遍 dayT 0.06–0.94，晴空的 uGodRay 始终为 0 ⇒ 太阳从未进框，闸门未被满足（不算通过也不算失败）');
  if (lit.length) {
    const best = lit.reduce((a, b) => (b.clear > a.clear ? b : a));
    const ratio = best.inStorm / best.clear;
    add('C0 极性对照：晴空存在让体积光真的亮起来的机位', best.clear > 0.001, JSON.stringify(best));
    add('C1 沙尘是介质不是开关：暴内 uGodRay 衰到晴空的 0.2–0.6 而不是 0', ratio > 0.2 && ratio < 0.6,
      `dayT ${best.dayT} clear ${best.clear} → storm ${best.inStorm}（×${rd(ratio, 3)}，公式预测 ×${rd(1 - 0.66 * best.uStorm, 3)}）`);
  }

  // ---- ⑤ 音效与风压 ----
  // __RSB 上这两个既可能是 getter 也可能是值，两种都要吃得下（第一版按函数调用，页面里直接抛了）
  const unwrap = (x) => (typeof x === 'function' ? x() : x);
  const A = unwrap(R.audio), ctx = unwrap(R.audioCtx);
  let ctxState = ctx && ctx.state ? ctx.state : 'no ctx';
  if (ctx && ctx.state !== 'running') { try { await Promise.race([ctx.resume(), sleep(2000)]); } catch (e) { ctxState += ' (resume threw)'; } ctxState = ctx && ctx.state ? ctx.state : ctxState; }
  if (!A || !A.windG || ctxState.indexOf('running') < 0) {
    skip.push(`D 音效-风压联动：AudioContext ${ctxState}，setTargetAtTime 的 .value 不推进 ⇒ 不判（headless 无手势）`);
  } else {
    const hear = () => ({ gain: A.windG.gain.value, freq: A.windF.frequency.value, q: A.windF.Q.value });
    R.clearSky(); R.setFilm(0, 0); await sleep(900); await frames(8);
    const q0 = hear();
    R.pinStorm('peak', 40, 0); await sleep(1200); await frames(10);
    const q1 = hear();
    R.unpinStorm(); R.clearSky(); await sleep(900); await frames(8);
    const q2 = hear();
    add('D1 风压起来时音量抬升', q1.gain > q0.gain * 1.5, `gain ${rd(q0.gain, 5)}→${rd(q1.gain, 5)}`);
    add('D2 音色随风压变亮：bandpass 中心频率与 Q 同时上移', q1.freq > q0.freq && q1.q > q0.q,
      `freq ${rd(q0.freq, 1)}→${rd(q1.freq, 1)} Hz, Q ${rd(q0.q, 3)}→${rd(q1.q, 3)}`);
    add('D3 风停了会退回去（不是单向 ramp）', q2.gain < q1.gain, `gain 撤暴后 ${rd(q2.gain, 5)}`);
  }

  const passed = rows.filter((r) => r.ok).length, total = rows.length;
  const failed = rows.filter((r) => !r.ok);
  R.setFilm(0, 0); R.clearSky();
  return JSON.stringify({
    verdict: (failed.length === 0 && total >= 7) ? `STORM_GRADE_PASS ${passed}/${total}` : `STORM_GRADE_FAIL ${failed.length}/${total}`,
    failed: failed.map((f) => f.id + ' :: ' + f.note),
    skipped: skip, rows, sweep,
    ladder, peakHold,
    note: 'A*=stormF→成像耦合 B=暴后沉积 C=体积光耦合 D=音效-风压；SKIP 不计入分子；ladder 是 (phase, standoff) 逐格 stormF 读数',
  }, null, 1);
})()
