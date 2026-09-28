// 【E】1e 音效↔风压联动：让 AudioContext 真的跑起来，然后按 src/audio/audio.js:137-149 那五条
// 承诺的算式判「风压变了，听到的东西也变了」。
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-audio-probe.js 9333 300000 600000
//
// 为什么上一版只能记 SKIP：headless Chrome 默认 `--autoplay-policy=user-gesture-required`，
// `new AudioContext()` 落地就是 `suspended`，而 suspended 的 ctx **时钟不动**，
// `setTargetAtTime` 的 `.value` 于是永远停在初值——读到的 0.012 是「没开始」而不是「没联动」。
// 这一版把浏览器换成带 `--autoplay-policy=no-user-gesture-required` 的启动参数，
// 并且探针自己**从不派发任何手势**，所以 `state === 'running'` 只可能来自那个 flag；
// A10 再把这条因果钉住：挂起 ctx ⇒ 时钟冻结，恢复 ⇒ 时钟继续。
//
// 判据落在代码承诺的算式上（src/audio/audio.js:144/147/148/137/149）：
//   windG.gain = 0.012 + windLoad·(0.055 + 0.105·windGust)·breathe(t) + nightF·0.012 + speed01·0.012
//   windF.freq = 200 + windLoad·190 + windGust·sin(0.83t)·150
//   windF.Q    = 0.4 + windLoad·0.5
//   padG.gain  = 0.04 + nightF·0.035 − stormF·0.02
//   lowpass    = 20000 − stormF·9000
//   breathe(t) = 0.72 + 0.28·sin(1.31t) + 0.16·sin(0.53t + 1.7)
//
// 为什么判「窗口均值」而不是判单帧：`setTargetAtTime` 是一阶滤波（τ = 0.25/0.4/0.5/0.35 s），
// 而 `breathe` 与 gust 的正弦项均值恰为常数（0.72）与 0。线性滤波的直流增益是 1，所以
// **同一段窗口里 live 的均值 = target 的均值**（预热 ≥ 3 s ⇒ 暂态衰减到 0.1 ‰ 以下），
// 这比拿某一颗帧的瞬时值当契约干净得多。上一跑（tools/logs/storm-audio-2026-09-29-005321.raw）
// 四条红里有三条就是这个：只等 63 ms 的假平台、拿瞬时值比带相位的 target。
//
// 第二跑（tools/logs/storm-audio-2026-09-29-005906.raw，STORM_AUDIO_FAIL 4/11）四条红的归因：
// A6/A8 仍是尺子——4 s 窗口把 7.57 s 的 gust 正弦拦腰截断（wf 残 21.8 Hz 落在相位上），而 A8 拿窗口
// **跨度**当均值的不确定度，等于把同一场波动计了两次；A9 是探针按错按钮——按 onclick 源码文本搜
// `setMuted` 会先命中 `#start-btn`（开局那次 setMuted(false) 也在它身上），于是「静音了而 lvl 不塌」；
// A5 是**产品**：windLoad 当时是 min(1,v/26)·stormF，尘一到 0 它必然 0，所以 23 m/s 的晴空大风与静风
// 读同一个 wg=0.012（那一跑的 wind01 列：watch 0.346、front@150 0.885，wg 全等于底噪）。
// 那一跑因此保留作 RED 证据；本文件现在的判据要在「尺子已修 + main.js 的 windLoad 改成
// (v/26)²·(0.75+0.25·dust)」的字节上重新取，旧读数不复用。
//
// 输入侧读 `__RSB.audioIn()`（src/main.js:2594 那一帧的实参快照，含 wind01/dustHere 两个拆开的量），
// 输出侧读 `__RSB.audio()` 的节点当前值与 master 上 AnalyserNode 的均值——
// 「参数抬起来了」与「声音抬起来了」是两格，不是一格。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const fin = (x) => Number.isFinite(x);
  const rd = (x, d = 4) => (fin(x) ? +x.toFixed(d) : String(x));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const span = (a) => Math.max(...a) - Math.min(...a);
  const se = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2)) / a.length); };

  if (!R.state || !R.state.started) return 'NOT_STARTED';

  const phys = R.phys();
  const env = R.env();
  const ctx = R.audioCtx();
  const A = () => R.audio();
  const IN = () => R.audioIn();
  const rows = [];
  const add = (id, ok, note) => rows.push({ id, ok: !!ok, note });
  const skip = [];

  const still = () => { phys.vx = 0; phys.vz = 0; phys.speed = 0; };
  const breatheAt = (t) => 0.72 + 0.28 * Math.sin(t * 1.31) + 0.16 * Math.sin(t * 0.53 + 1.7);
  const wTgt = (i, t) => 0.012 + (i.windLoad || 0) * (0.055 + 0.105 * (i.windGust || 0)) * breatheAt(t)
    + (i.nightF || 0) * 0.012 + (i.speed01 || 0) * 0.012;
  const fTgt = (i, t) => 200 + (i.windLoad || 0) * 190 + (i.windGust || 0) * Math.sin(t * 0.83) * 150;

  const warm = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { still(); await oneFrame(); } };

  // 一段窗口：每 ~50 ms 同帧取「节点当前值 + 那一帧的输入」，返回均值、极值与均值的标准误。
  // 默认窗口取 gust 扫描 `sin(0.83t)` 的**一个整周期**（2π/0.83 = 7.57 s）：wf 的 target 里那支正弦在
  // 整周期上的均值恰为 0，而一阶滤波线性、直流增益 1，于是 live 与 target 的均值都只剩直流项。
  // 上一跑（-005906）A6 的 wf Δ21.8 Hz 就是拿 4 s 窗口去截 7.57 s 的正弦——残差落在采样相位上，不在产品上。
  const sampleWindow = async (ms = 7600, stepMs = 50) => {
    const wg = [], wf = [], wq = [], lp = [], pad = [], lvl = [], tw = [], tf = [], tq = [], tl = [], tp = [], storm = [], load = [], w01 = [], gust = [], night = [], spd = [], eng = [];
    const t0 = performance.now();
    let stateSeen = new Set(), clock0 = ctx.currentTime, clock1 = ctx.currentTime, n = 0;
    while (performance.now() - t0 < ms) {
      still();
      const a = A(), i = IN(), t = ctx.currentTime;
      if (a && i && fin(t)) {
        n++;
        wg.push(a.wg); wf.push(a.wf); wq.push(a.wq); lp.push(a.lp); pad.push(a.pad); lvl.push(a.lvl); eng.push(a.eng);
        tw.push(wTgt(i, t)); tf.push(fTgt(i, t)); tq.push(0.4 + i.windLoad * 0.5);
        tl.push(20000 - i.stormF * 9000); tp.push(0.04 + i.nightF * 0.035 - i.stormF * 0.02);
        storm.push(i.stormF); load.push(i.windLoad); w01.push(i.wind01 === undefined ? NaN : i.wind01);
        gust.push(i.windGust); night.push(i.nightF); spd.push(i.speed01);
        stateSeen.add(a.state);
        clock1 = t;
      }
      await sleep(stepMs);
    }
    return { n, ok: n >= 20, state: [...stateSeen].join('|'), clockAdvance: clock1 - clock0,
      m: { wg: mean(wg), wf: mean(wf), wq: mean(wq), lp: mean(lp), pad: mean(pad), lvl: mean(lvl), eng: mean(eng),
        tw: mean(tw), tf: mean(tf), tq: mean(tq), tl: mean(tl), tp: mean(tp),
        storm: mean(storm), load: mean(load), w01: mean(w01), gust: mean(gust), night: mean(night), spd: mean(spd) },
      x: { wg: span(wg), wf: span(wf), lvl: span(lvl), storm: span(storm), load: span(load), w01: span(w01) },
      // 均值的标准误。跨度是波动的幅度，不是均值的不确定度：上一跑 A8 拿 4 s 窗口的跨度当噪声地板，
      // 于是「Δ0.0445 对 2× 跨度 0.124」永远过不去——那是把同一场波动重复计了一次。
      se: { lvl: se(lvl), wg: se(wg), wf: se(wf), lp: se(lp), pad: se(pad), wq: se(wq), load: se(load), storm: se(storm) } };
  };

  // ── 0. 出场设置：把昼夜钉住（nightF 进 pad 公式）、车停住、可选的静音先解掉 ──
  let unmutedBy = null;
  // 锚在出货控件的 id 上，而不是锚在「onclick 源码里有 setMuted」这句话：整页里带 setMuted 的按钮有 2 个
  // （`#start-btn` 开局那次 setMuted(false) 也在它身上），按文档顺序 find 会点到 #start-btn，
  // 于是 -005906 那一跑的 A9「静音了而 lvl 没塌」——那是探针没按对按钮，不是分析器不听混音。
  const muteBtn = document.getElementById('mute-fab');
  if (A().muted && muteBtn) { muteBtn.click(); unmutedBy = 'clicked ' + (muteBtn.id || muteBtn.className || 'anon'); await sleep(600); }
  const dayPick = 0.35;
  env.dayT = dayPick; env.dayHold = true;
  if (R.unpinStorm) R.unpinStorm();
  R.clearSky();
  still();
  await sleep(1200);

  // ── A0 闸门可满足：ctx 在跑、时钟在走，且探针没派发过手势 ──
  const s0 = A();
  const tb = ctx.currentTime;
  await sleep(700);
  const dClock = ctx.currentTime - tb;
  add('A0 running-context gate — no gesture was dispatched by this probe, yet state is ' + s0.state
    + ' and ctx.currentTime advanced ' + rd(dClock, 3) + ' s over a 0.7 s wall window',
    s0.state === 'running' && s0.ready === true && fin(dClock) && dClock > 0.35,
    `state=${s0.state} ready=${s0.ready} Δclock=${rd(dClock, 3)}s muted=${s0.muted} (${unmutedBy || 'never muted'}) `
    + `⇒ 旧 SKIP 的成因是 suspended 的 ctx 时钟不动、setTargetAtTime 的 .value 停在初值，不是机制缺失`);

  // ── A1 晴基线必须先真的晴下来（stormF 与 wind01 双闸，否则「calm」只是上一次峰值的缓降中途） ──
  const calmWait = async (cap = 40000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < cap) {
      still(); await oneFrame();
      const i = IN();
      if (i && i.stormF <= 0.02 && (i.wind01 === undefined || i.wind01 <= 0.15)) {
        const a = A();
        if (a.state === 'running') return { ok: true, ms: performance.now() - t0 | 0 };
      }
    }
    return { ok: false, ms: performance.now() - t0 | 0 };
  };
  const cw = await calmWait();
  if (cw.ok) await warm(3000);
  const C = await sampleWindow();
  const cWg = C.m.wg;
  add('A1 calm baseline is really calm (condition-wait, not a fixed sleep)',
    cw.ok && C.ok && C.m.storm <= 0.02 && cWg <= 0.0135,
    `waited ${cw.ms} ms → stormF=${rd(C.m.storm)} wind01=${rd(C.m.w01)} wg=${rd(cWg, 5)} wf=${rd(C.m.wf, 1)} wq=${rd(C.m.wq, 3)} `
    + `lp=${rd(C.m.lp, 0)} pad=${rd(C.m.pad, 5)} lvl=${rd(C.m.lvl, 3)} (window n=${C.n})`);

  // ── 梯子：(phase, standoff)，负的 standoff 才会把视点埋进墙里 ──
  const LAD = [['watch', 300], ['watch', 120], ['front', 150], ['front', 40], ['front', -40], ['peak', -120], ['peak', -30]];
  const ladder = [];
  for (const [ph, so] of LAD) {
    try { R.pinStorm(ph, so, null); } catch (e) { skip.push(`${ph}@${so}: pinStorm threw ${e}`); continue; }
    still();
    await warm(3000);
    const s = await sampleWindow();
    ladder.push({ ph, so, ...s });
  }
  const usable = ladder.filter((r) => r.ok && r.state === 'running');
  add('A2 coverage set: rungs sampled while the context kept running',
    usable.length >= 5, `${usable.length}/${ladder.length} usable (states seen: ${[...new Set(ladder.map((r) => r.state))].join(', ')})`);

  // ── A3 windG 的窗口均值必须与同窗 target 的窗口均值相等（一阶滤波直流增益＝1） ──
  const agree = usable.map((r) => {
    const tol = Math.max(0.0012, 0.06 * Math.max(r.m.tw - 0.012, 0));
    return { rung: `${r.ph}@${r.so}`, live: rd(r.m.wg, 5), tgt: rd(r.m.tw, 5), d: rd(r.m.wg - r.m.tw, 5), tol: rd(tol, 5), ok: Math.abs(r.m.wg - r.m.tw) <= tol };
  });
  add('A3 windG.gain window-mean equals its own formula window-mean (DC gain of the ramp is 1)',
    agree.length > 0 && agree.every((a) => a.ok),
    `worst |Δ| = ${rd(Math.max(...agree.map((a) => Math.abs(a.d))), 5)} over ${agree.length} rungs; offenders: `
    + `${agree.filter((a) => !a.ok).map((a) => `${a.rung}(${a.live} vs ${a.tgt}, tol ${a.tol})`).join(' ') || 'none'}`);

  // ── A4 单调 + 值得听见的跨度 ──
  const byLoad = [...usable].sort((a, b) => a.m.load - b.m.load);
  const monoBad = [];
  for (let k = 1; k < byLoad.length; k++) {
    if (byLoad[k].m.wg < byLoad[k - 1].m.wg - 0.0015 && (byLoad[k].m.load - byLoad[k - 1].m.load) > 0.05) {
      monoBad.push(`${byLoad[k - 1].ph}@${byLoad[k - 1].so}(load ${rd(byLoad[k - 1].m.load)}→wg ${rd(byLoad[k - 1].m.wg, 5)}) before `
        + `${byLoad[k].ph}@${byLoad[k].so}(load ${rd(byLoad[k].m.load)}→wg ${rd(byLoad[k].m.wg, 5)})`);
    }
  }
  const wgSpan = Math.max(...usable.map((r) => r.m.wg)) - Math.min(...usable.map((r) => r.m.wg));
  const loadSpan = Math.max(...usable.map((r) => r.m.load)) - Math.min(...usable.map((r) => r.m.load));
  add('A4 roar is monotone in standing pressure, and the span is worth hearing',
    monoBad.length === 0 && wgSpan >= 0.02 && loadSpan >= 0.3,
    `windLoad ${rd(Math.min(...usable.map((r) => r.m.load)))}→${rd(Math.max(...usable.map((r) => r.m.load)))} `
    + `⇒ windG ${rd(Math.min(...usable.map((r) => r.m.wg)), 5)}→${rd(Math.max(...usable.map((r) => r.m.wg)), 5)} (span ${rd(wgSpan, 5)})`);

  // ── A5「先听见，后看见」：尘还没到（stormF ≤ 0.12）而空气自己已经抬起来（wind01 ≥ 0.3，即 ≥7.8 m/s）
  // 的格里，吼声必须已经离开平静底噪。判「风贡献」而不是总增益：0.012 是 audio.js:144 写死的无声底噪，
  // 拿含底噪的总数比倍率会把真实抬升说成「没抬」。──
  const early = usable.filter((r) => r.m.storm <= 0.12 && r.m.w01 >= 0.3);
  const windPart = (v) => Math.max(v - 0.012, 1e-6);
  const earlyBest = early.length ? early.reduce((a, b) => (b.m.wg > a.m.wg ? b : a)) : null;
  const early01 = early.length ? Math.max(...early.map((r) => r.m.w01)) : NaN;
  const calmPart = windPart(cWg);
  add('A5 the shipped promise "wind pressure, not weather mood" — clean-sky air already roars above verified calm',
    !!earlyBest && earlyBest.m.wg >= cWg + 0.003 && windPart(earlyBest.m.wg) >= 8 * calmPart,
    earlyBest ? `${earlyBest.ph}@${earlyBest.so}: wind01=${rd(earlyBest.m.w01)}（${rd(earlyBest.m.w01 * 26, 1)} m/s 的空气）`
      + ` stormF=${rd(earlyBest.m.storm)}（尘还没到）windLoad=${rd(earlyBest.m.load)} wg=${rd(earlyBest.m.wg, 5)} `
      + `vs calm ${rd(cWg, 5)} ⇒ 风贡献 ×${rd(windPart(earlyBest.m.wg) / calmPart, 1)}、绝对抬升 ${rd(earlyBest.m.wg - cWg, 5)}`
      + `；这类格里最大 wind01=${rd(early01)}。若风自己抬了而吼声没抬，红在产品（windLoad 被尘乘掉了）不在尺`
      : `no usable rung with stormF ≤ 0.12 and wind01 ≥ 0.3`);

  // ── A6 音区/闷度/房间声：四条通道的窗口均值既要对得上公式，方向也要对 ──
  const deep = usable.filter((r) => r.m.storm >= 0.7);
  const D = deep.length ? deep.reduce((a, b) => (b.m.storm > a.m.storm ? b : a)) : null;
  if (D) {
    const fAg = Math.abs(D.m.wf - D.m.tf), qAg = Math.abs(D.m.wq - D.m.tq), lAg = Math.abs(D.m.lp - D.m.tl), pAg = Math.abs(D.m.pad - D.m.tp);
    add('A6 register, band focus, muffling and room tone agree with their formulae and all move with the dust',
      fAg <= 12 && qAg <= 0.03 && lAg <= 250 && pAg <= 0.004
      && D.m.wf >= C.m.wf + 90 && D.m.wq >= C.m.wq + 0.3 && D.m.lp <= 20000 - 0.7 * 9000 && D.m.pad <= C.m.pad - 0.006,
      `buried(${D.ph}@${D.so}, stormF ${rd(D.m.storm)}): wf ${rd(C.m.wf, 1)}→${rd(D.m.wf, 1)} Hz (tgt ${rd(D.m.tf, 1)}, Δ ${rd(fAg, 1)}) | `
      + `wQ ${rd(C.m.wq, 3)}→${rd(D.m.wq, 3)} (tgt ${rd(D.m.tq, 3)}, Δ ${rd(qAg, 3)}) | lowpass ${rd(C.m.lp, 0)}→${rd(D.m.lp, 0)} `
      + `(tgt ${rd(D.m.tl, 0)}, Δ ${rd(lAg, 0)}) | pad ${rd(C.m.pad, 5)}→${rd(D.m.pad, 5)} (tgt ${rd(D.m.tp, 5)}, Δ ${rd(pAg, 5)}, `
      + `nightF locked ${rd(D.m.night)})`);
  } else add('A6 register, band focus, muffling and room tone agree with their formulae and all move with the dust', false, 'no rung reached stormF ≥ 0.7');

  // ── A7 归因隔离：nightF / speed01 / 引擎 voices 全程锁死，动的才只有尘 ──
  const nightSpan = Math.max(...usable.map((r) => r.m.night)) - Math.min(...usable.map((r) => r.m.night));
  const spdMax = Math.max(...usable.map((r) => r.m.spd));
  const engSpan = Math.max(...usable.map((r) => r.m.eng)) - Math.min(...usable.map((r) => r.m.eng));
  add('A7 attribution is clean: nightF, speed01 and the engine voice were held still across the whole ladder',
    nightSpan <= 0.02 && spdMax <= 0.03 && engSpan <= 0.01 && usable.every((r) => r.m.eng >= 0),
    `nightF ${rd(Math.min(...usable.map((r) => r.m.night)))}→${rd(Math.max(...usable.map((r) => r.m.night)))} (span ${rd(nightSpan)}) | `
    + `speed01 max ${rd(spdMax)} | engineG span ${rd(engSpan, 5)} across ${usable.length} rungs`);

  // ── A8 声音本身：master 上的 AnalyserNode。基线必须重新过一遍晴纯度闸，再各取窗口均值 ──
  if (R.unpinStorm) R.unpinStorm();
  R.clearSky();
  const cw2 = await calmWait();
  if (cw2.ok) await warm(3000);
  const L0 = await sampleWindow();
  R.pinStorm('peak', -120, null);
  still();
  await warm(3000);
  const L1 = await sampleWindow();
  const delta = L1.m.lvl - L0.m.lvl, gate = 6 * (L0.se.lvl + L1.se.lvl);
  add('A8 the analyser on master hears it: buried storm raises measured level above a *verified* calm by more than the uncertainty of either mean',
    cw2.ok && delta >= 0.01 && delta > Math.max(gate, 0.005),
    `calm lvl=${rd(L0.m.lvl, 4)} (±SE ${rd(L0.se.lvl, 4)}, n=${L0.n}, in-window span ${rd(L0.x.lvl, 4)}, stormF ${rd(L0.m.storm)}, wg ${rd(L0.m.wg, 5)}) → `
    + `buried lvl=${rd(L1.m.lvl, 4)} (±SE ${rd(L1.se.lvl, 4)}, n=${L1.n}, span ${rd(L1.x.lvl, 4)}, stormF ${rd(L1.m.storm)}, wg ${rd(L1.m.wg, 5)}) `
    + `⇒ Δ ${rd(delta, 4)} vs 6·(SE₀+SE₁)=${rd(gate, 4)}。跨度只当形状报，不再当噪声地板（-005906 的 A8 就是把波动计了两次）`);

  // ── A9 变异对照（出货的那个控件）：点静音 ⇒ 分析器塌下去而时钟继续走；再点回来 ⇒ 恢复 ──
  const preLvl = A().lvl, preT = ctx.currentTime;
  let mut = null;
  if (!muteBtn) {
    add('A9 polarity mutation via the shipping mute control', false, 'no element with a setMuted onclick was found — the row cannot run, so it is not silently dropped');
  } else {
    muteBtn.click();
    await sleep(900);
    still();
    const flagDuring = A().muted;
    const during = await sampleWindow(2400, 60);
    const midT = ctx.currentTime;
    muteBtn.click();
    await warm(3000);
    const back = await sampleWindow(2400, 60);
    mut = { id: muteBtn.id, flagDuring, flagAfterRestore: A().muted };
    add('A9 polarity mutation via the shipping mute control: level collapses while the clock keeps running, and comes back',
      flagDuring === true && A().muted === false && during.m.storm >= 0.5 && during.m.lvl <= 0.25 * preLvl
      && during.state.includes('running') && (midT - preT) > 0.5 && back.m.lvl >= 0.6 * preLvl,
      `clicked #${muteBtn.id} ⇒ muted flag ${flagDuring}：lvl ${preLvl}→${rd(during.m.lvl, 4)} (±SE ${rd(during.se.lvl, 4)})，`
      + `同一窗口里 ctx.currentTime 走了 ${rd(midT - preT, 3)}s；再点一次 ⇒ flag ${A().muted}、lvl ${rd(back.m.lvl, 4)}（点击前 ${preLvl}）`
      + `⇒ 分析器读的是混音本身而不是某个参数代理：静音把 master 增益打到 0（audio.js:305，τ=0.05）而时钟没停（对比 A10 把时钟冻住）`);
  }

  // ── A10 消费者侧对照：挂起 ⇒ 时钟冻结（这就是旧 SKIP 的成因），恢复 ⇒ 继续 ──
  const bT = ctx.currentTime;
  try {
    await Promise.race([ctx.suspend(), sleep(4000)]);
    await sleep(700);
    const fT = ctx.currentTime;
    await Promise.race([ctx.resume(), sleep(4000)]);
    await sleep(900);
    const rT = ctx.currentTime;
    add('A10 the mechanism behind the old SKIP: suspending the context freezes its clock, resuming restarts it',
      (fT - bT) <= 0.02 && (rT - fT) > 0.3,
      `running Δ=${rd(fT - bT, 3)}s while suspended (expected ~0) → Δ=${rd(rT - fT, 3)}s after resume | state now ${ctx.state} `
      + `⇒ .value 只在时钟走的 ctx 里推进；这就是上一版 12 格读 0 的唯一原因`);
  } catch (e) {
    add('A10 the mechanism behind the old SKIP: suspending the context freezes its clock, resuming restarts it', false, `threw ${e}`);
  }

  if (R.unpinStorm) R.unpinStorm();
  R.clearSky();
  still();

  const failed = rows.filter((r) => !r.ok);
  return JSON.stringify({
    verdict: failed.length ? `STORM_AUDIO_FAIL ${failed.length}/${rows.length}`
      : `STORM_AUDIO_PASS ${rows.length}/${rows.length}`,
    failed: failed.map((f) => f.id + ' :: ' + f.note),
    skip, rows, dayPick, unmutedBy, muteBtnFound: !!muteBtn,
    calm: C.m, calmWaitMs: cw.ms,
    ladder: ladder.map((r) => ({ rung: `${r.ph}@${r.so}`, n: r.n, state: r.state, ok: r.ok,
      m: { stormF: rd(r.m.storm, 3), wind01: rd(r.m.w01, 3), windLoad: rd(r.m.load, 3), gust: rd(r.m.gust, 3), nightF: rd(r.m.night, 3), speed01: rd(r.m.spd, 3),
        wg: rd(r.m.wg, 5), wf: rd(r.m.wf, 1), wq: rd(r.m.wq, 3), lp: rd(r.m.lp, 0), pad: rd(r.m.pad, 5), lvl: rd(r.m.lvl, 4), eng: rd(r.m.eng, 3) },
      tgt: { wg: rd(r.m.tw, 5), wf: rd(r.m.tf, 1), wq: rd(r.m.tq, 3), lp: rd(r.m.tl, 0), pad: rd(r.m.tp, 5) },
      inWindowSpan: { storm: rd(r.x.storm, 3), load: rd(r.x.load, 3), wg: rd(r.x.wg, 5), lvl: rd(r.x.lvl, 4), w01: rd(r.x.w01, 3) } })),
    agree,
    levels: { calm: { lvl: rd(L0.m.lvl, 4), wg: rd(L0.m.wg, 5), stormF: rd(L0.m.storm, 3), SE: rd(L0.se.lvl, 4), span: rd(L0.x.lvl, 4), calmWaitMs: cw2.ms },
      buried: { lvl: rd(L1.m.lvl, 4), wg: rd(L1.m.wg, 5), stormF: rd(L1.m.storm, 3), SE: rd(L1.se.lvl, 4), span: rd(L1.x.lvl, 4) } },
    setup: { autoplayFlag: '--autoplay-policy=no-user-gesture-required', gestureDispatchedByProbe: false,
      warmMs: 3000, windowMs: 7600, windowRationale: 'one full period of the gust sweep sin(0.83t) ⇒ 2π/0.83 = 7.57 s', stepMs: 50,
      formulae: 'audio.js:144 windG | :147 windF.freq | :148 windF.Q | :137 padG | :149 lowpass',
      inputsFrom: '__RSB.audioIn() (src/main.js:2594 frame snapshot, incl. wind01/dustHere)',
      nodeReadout: '__RSB.audio() .wg/.wf/.wq/.pad/.lp/.lvl/.eng/.muted' },
  }, null, 1);
})()
