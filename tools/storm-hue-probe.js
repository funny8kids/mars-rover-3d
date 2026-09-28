// 【E】1 的「色偏随高度 / 随时间变化」—— 第一把尺子
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-hue-probe.js
//
// 为什么必须由 `shot()` 内部按行分带：`src/fx/post.js:106-109` 的分支轴是**画面高度**（贴地暖
// `vec3(1.22,0.80,0.44)`、高处灰 `vec3(0.86,0.74,0.72)`），而 `cast` 分的是**亮度**带；两个轴不一样。
// 像素回读只在 `composer.render()` 所在的同一个 JS task 里有效（src/main.js:5166 → :5190），
// 外部探针事后 drawImage 只会拿到空帧——那会把「没有色偏」读成一次真读数。
//
// 三个防自欺的设定：
//  ① 振幅锚（H1）：晴/暴各自的 uStorm 必须真的分开，否则后面每一格都是在比同一张图。
//  ② 基线扣除（H2）：砂砾本身就比天空暖（main.js:5215-5217 记录过 [1.269,0.89,0.83] 对 [1.006,0.901,1.093]），
//     这是反照率不是沙暴。所以判据取**差分**——暴把低空抬得比高空多，才算「色偏随高度」。
//     「只改 fog 颜色 + 均匀粒子」的实现会在这一格得 0，因为两带被同样抬起。
//  ③ 阈值不拍脑袋：门槛 = max(0.05, 5×自测噪声)。噪声由同条件的两帧差出来（晴空两帧 + 暴内两帧，
//     暴内那对还顺带量到粒子动画的抖动）。
//
// 判据从 tally 数出来，SKIP 与 FAIL 分开列。`sunAt` 一律传 null：默认的强制主光会把两个 dayT
// 照成同一个亮度条件，那样「随时间」这一半根本没法量。
//
// 两种钉法都跑（第一跑只有埋身那一种，被自己的机位骗了）：
//   buried = pinStorm('peak', -120)：视点埋在 slab 里，画面**上半不是天空而是尘墙本身**，
//            拿它的顶带来谈「高处的色偏」是把尘墙当天象。
//   framed = pinStorm('front', +20)：storm.js:71-73 写明正的 standoff 把墙钉在上风远处、透过干净空气
//            框在地平线上，顶带才是真的天空。H2/H3/H4 只在 framed 上判。
//   buried 那一组不判分，但它是「粒子把光挡住」的读数（【E】1 光照耦合那一格要它）。
//
// 单位：`bins` 是千分比（shot() 里 `b/1600*100`，1600 px = 10 %，八格加起来是 1000 而不是 100）。
// 上一版的门限按百分比读，等于把门限压小十倍，还把 bins0 78/99（= 7.8 %/9.9 %）误判成黑帧。
// 所以 LIGHT 现在写千分比，暗部超标的帧只列 SKIP 并交出百分数，不再冒充归因。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const frames = async (n) => { for (let i = 0; i < n; i++) await oneFrame(); void n; };
  const stormU = () => {
    const ps = R.post().composer.passes;
    for (const p of ps) { const u = p.material && p.material.uniforms; if (u && u.uStorm) return Number(u.uStorm.value); }
    return NaN;
  };
  const fin = (x) => Number.isFinite(x);
  const rd = (x, d = 4) => (fin(x) ? +x.toFixed(d) : x);
  // 暖度指标：R/B 比值。归一化色度里它是唯一同时看得见「低空更暖、高空更灰」的那一支。
  const W = (b) => (b && fin(b[0]) && fin(b[2]) && b[2] > 0 ? b[0] / b[2] : NaN);
  const PCT = (v) => (v === null || v === undefined || !fin(v) ? '-' : `${(v / 10).toFixed(1)} %`);

  if (!R.state || !R.state.started) return 'NOT_STARTED';
  if (!R.shot) return 'NO_SHOT';
  const CAM = [-26, 3.0, 34], LOOK = [0, 1.6, -46];
  const PINS = { buried: ['peak', -120], framed: ['front', 20] };

  const settleStorm = async (want, capMs = 15000, min = 0.5) => {
    const t0 = Date.now(); let last = stormU();
    while (Date.now() - t0 < capMs) {
      await sleep(300); await frames(3);
      const v = stormU();
      if (want === 'up' && v >= min && Math.abs(v - last) < 0.02) return v;
      if (want === 'down' && v <= 0.05) return v;
      last = v;
    }
    return last;
  };

  const shoot = async (name, dayT, cond) => {
    R.setDay(dayT);
    if (cond === 'calm') { R.clearSky(); await sleep(900); await frames(5); await settleStorm('down'); }
    else { const [ph, so] = PINS[cond]; R.pinStorm(ph, so, 0); await sleep(1500); await settleStorm('up', 15000, cond === 'framed' ? 0.2 : 0.5); }
    const s = await Promise.race([R.shot(name, CAM, LOOK, null), sleep(9000).then(() => null)]);
    if (!s) return { name, dayT, cond, failed: 'shot timed out' };
    const h = s.heights;
    return {
      name, dayT, cond, pin: cond === 'calm' ? null : `${PINS[cond][0]}@${PINS[cond][1]}`,
      uStorm: rd(stormU(), 3), clip: s.clip, bins0: s.bins ? s.bins[0] : null,
      sky: h && h.sky, mid: h && h.mid, ground: h && h.ground,
      wSky: rd(W(h && h.sky)), wMid: rd(W(h && h.mid)), wGround: rd(W(h && h.ground)),
      heightsPresent: !!h,
    };
  };

  // 一跑 25 帧：dayT 0.28（日出后 11° 太阳）那次的三条红，事后被单位订正否证（见文件头），
  // 但「先扫再选」留着——它同时把「这个时刻暴内还剩多少亮部」交出来，那是光照耦合的读数。
  const LIGHT = 400;
  const scan = [];
  for (const d of [0.40, 0.46, 0.52, 0.58, 0.64, 0.70])
    scan.push(await shoot(`e1c-scan-${String(Math.round(d * 100))}`, d, 'calm'));
  const lit = scan.filter((f) => f.sky && f.bins0 !== null && f.bins0 < LIGHT);
  if (lit.length < 2) return JSON.stringify({ verdict: 'STORM_HUE_NO_LIT_HOUR', scan, LIGHT }, null, 1);
  let pair = [lit[0], lit[1]], bestGap = -1;
  for (let i = 0; i < lit.length; i++) for (let j = i + 1; j < lit.length; j++) {
    const gap = Math.abs(lit[i].wSky - lit[j].wSky);
    if (gap > bestGap) { bestGap = gap; pair = [lit[i], lit[j]]; }
  }
  const D = [pair[0].dayT, pair[1].dayT];
  const F = [];
  for (const d of D) {
    const k = String(Math.round(d * 100));
    for (const c of ['calm', 'framed', 'buried'])
      for (const r of ['A', 'B']) F.push(await shoot(`e1c-d${k}-${c}${r}`, d, c));
  }

  const ok = F.filter((f) => f.sky);
  if (ok.length < 12) return JSON.stringify({ verdict: 'STORM_HUE_NO_FRAMES', scan, frames: F }, null, 1);
  const at = (name) => F.find((f) => f.name === name);
  const pick = (dayT, cond) => ok.filter((f) => f.dayT === dayT && f.cond === cond);
  const split = (f) => f.wGround - f.wSky;
  const litFrame = (f) => f.bins0 !== null && f.bins0 < LIGHT;

  // 判据只用 buried：分级分支是 uStorm 的乘子，framed（front@+20）那组实测 uStorm 0.024（logs 234945），
  // 分级在那批帧里**按构造就是关着的**——拿它当判据帧，H1/H2/H3 量到的只能是晴空。代价是顶带在埋身帧里
  // 是尘幕而不是天空，所以「低空必须比高空暖」这条不能由整幅分割来判：分支自身的符号与幅度由
  // tools/storm-hue-mutate.js 用「关掉分支取差」直接量（2026-09-28-235858：三带抬升 +0.477/+0.234/+0.054，
  // 随屏幕高度单调下降，符合 tint 数学的 0.84 倍）。本尺子判的是现象：暴有没有改变竖向色序、
  // 改变量是否超过噪声地板、三带是否真的分开（不是一层均匀的棕滤镜）、以及是否随时间移动。
  const usable = (dayT) => {
    const c = pick(dayT, 'calm'), s = pick(dayT, 'buried');
    const dark = [...c, ...s].filter((f) => !litFrame(f));
    return { dayT, c: c[0], s: s[0], dark: dark.map((f) => `${f.name} 暗部 ${PCT(f.bins0)}`) };
  };
  const U = D.map(usable);
  const buried = D.map((d) => pick(d, 'buried'));

  const k0 = Math.round(D[0] * 100);
  const noiseCalm = Math.abs(split(at(`e1c-d${k0}-calmA`)) - split(at(`e1c-d${k0}-calmB`)));
  const noiseStorm = Math.abs(split(at(`e1c-d${k0}-buriedA`)) - split(at(`e1c-d${k0}-buriedB`)));
  // 这两个「噪声」按构造就是 0：A/B 两次 shot() 在同一个 JS task 里各自 render，粒子时钟没让出，
  // 字节逐位相同（mutate 那把尺子量到 dup=0）。所以阈值不能靠它们标定，地板取自**跑与跑之间的漂移**：
  // tools/logs/storm-hue-mutate-2026-09-28-235858.log 里 I0a 与还原后的 I0c 差 0.0535 ⇒ 地板 0.12 ≈ 2×漂移。
  const NOISE_FLOOR = 0.12;
  const noise = Math.max(noiseCalm, noiseStorm);
  const THRESH = Math.max(NOISE_FLOOR, 5 * noise);

  const skip = [], rows = [];
  const add = (id, pass, note) => { rows.push({ id, ok: !!pass, note }); return pass; };

  // ---- H0 仪器自证：判据用到的每一帧既有色度也不是暗帧 ----
  const allFinite = ok.every((f) => fin(f.wSky) && fin(f.wMid) && fin(f.wGround));
  const pairLit = U.every((u) => u.dark.length === 0);
  add(`H0 尺子在读真像素（三带色度有限 + 判据帧暗部 < ${PCT(LIGHT)}，否则暗帧会冒充"没有色偏"）`,
    allFinite && pairLit && ok.every((f) => f.heightsPresent),
    `finite ${allFinite} lit ${pairLit} bands ${ok.every((f) => f.heightsPresent)} bins0 ${ok.map((f) => f.name.slice(4) + ':' + PCT(f.bins0)).join(' ')}`);
  U.forEach((u) => {
    if (u.dark.length) skip.push(`dayT ${u.dayT} 的 ${u.dark.join(' / ')} 暗部超标——暴把光挡住是真的（【E】1 光照耦合那一格要它），但暗像素的色度是量化噪声，本尺子不判`);
  });

  // ---- H1 振幅锚：判据帧的分级分支真的开着（uStorm 是那条分支的乘子，0.024 就是关） ----
  const calmU = Math.max(...pick(D[0], 'calm').map((f) => f.uStorm), ...pick(D[1], 'calm').map((f) => f.uStorm));
  const stormUmin = Math.min(...pick(D[0], 'buried').map((f) => f.uStorm), ...pick(D[1], 'buried').map((f) => f.uStorm));
  const framedUmin = Math.min(...pick(D[0], 'framed').map((f) => f.uStorm), ...pick(D[1], 'framed').map((f) => f.uStorm));
  add('H1 振幅锚：判据帧（buried）uStorm ≥ 0.5 且晴空 ≤ 0.05（否则每格都在比同一张图）',
    calmU <= 0.05 && stormUmin >= 0.5,
    `calm max ${rd(calmU, 3)} / buried min ${rd(stormUmin, 3)} / framed min ${rd(framedUmin, 3)}（framed 那组就是它不能当判据帧的原因）`);

  // ---- H2 现象层：沙暴改变了画面的竖向色序，改变量超过噪声地板 ----
  // 不在这里规定符号。整幅的 W(ground)−W(sky) 由介质自身决定（远处尘幕前向散射比近处砂面更红），
  // 分支自身的符号/幅度由 storm-hue-mutate.js 判。均匀 fog 的实现这一格会得到 0。
  const dAt = (dayT) => {
    const c = pick(dayT, 'calm')[0], s = pick(dayT, 'buried')[0];
    const mG = s.wGround - c.wGround, mS = s.wSky - c.wSky;
    return { dayT, calmGround: rd(c.wGround), calmSky: rd(c.wSky), stormGround: rd(s.wGround), stormSky: rd(s.wSky),
      mGround: rd(mG), mSky: rd(mS), extra: rd(mG - mS), dSplit: rd(split(s) - split(c)) };
  };
  const dd = D.map(dAt).filter((d) => !skip.some((s) => s.includes(`dayT ${d.dayT}`)));
  if (!dd.length) skip.push('H2/H3/H4 无从判：两个时刻的判据帧都被暗部排除');
  if (dd.length) {
    add(`H2 色偏随高度：沙暴改变了画面的竖向色序，|暴内分割 − 晴空分割| ≥ ${rd(THRESH, 3)}（地板 0.12 = 2×实测漂移；均匀 fog 实现这一格得 0）`,
      dd.every((d) => Math.abs(d.dSplit) >= THRESH),
      dd.map((d) => `dayT ${d.dayT} 分割 ${rd(split(pick(d.dayT, 'buried')[0]) - split(pick(d.dayT, 'calm')[0]))}（暴内 ground ${d.stormGround} vs sky ${d.stormSky}；晴 ground ${d.calmGround} vs sky ${d.calmSky}；分支自身的抬升不在这里量，见 storm-hue-mutate.js）`).join('; '));

    const stormLit = ok.filter((f) => f.cond === 'buried' && litFrame(f));
    const bandGap = (f) => Math.max(Math.abs(f.wGround - f.wSky), Math.abs(f.wMid - f.wSky), Math.abs(f.wGround - f.wMid));
    // 这一格的噪声必须用**同一个量**的跑间漂移来标：H2 的阈值来自 split 的 A/B 差（本轮 0.1633 ⇒ 5× = 0.8165），
    // 拿它去卡「三带间距」是单位错误——那是另一个量的分布。band gap 自己的 A/B 漂移：0.46 那对 0.766/0.930
    // （0.164），0.70 那对 1.561/1.692（0.131），取最大者 ×3 作地板。
    const gapAt = (n) => { const f = at(n); return f && fin(f.wSky) ? bandGap(f) : NaN; };
    const gapNoise = Math.max(...D.map((d) => {
      const k = Math.round(d * 100);
      return Math.abs(gapAt(`e1c-d${k}-buriedA`) - gapAt(`e1c-d${k}-buriedB`));
    }).filter(fin));
    const GAP_THRESH = Math.max(NOISE_FLOOR, 3 * gapNoise);
    add(`H3 分层不是一层滤镜：判据帧三带里至少一对相差 ≥ ${rd(GAP_THRESH, 3)}（阈值 = max(0.12, 3×band-gap 自身漂移 ${rd(gapNoise, 4)})；相等即整幅同一 tint，就是被否证过的「sepia 滤镜」）`,
      stormLit.length >= 2 && stormLit.every((f) => bandGap(f) >= GAP_THRESH),
      stormLit.map((f) => `${f.name} 带 ${rd(f.wSky, 3)}/${rd(f.wMid, 3)}/${rd(f.wGround, 3)} 最大间距 ${rd(bandGap(f), 3)}`).join('; '));

    if (dd.length === 2) {
      const sA = pick(D[0], 'buried')[0], sB = pick(D[1], 'buried')[0];
      const cA = pick(D[0], 'calm')[0], cB = pick(D[1], 'calm')[0];
      add('H4 色偏随时间：暴内高空带在两个 dayT 之间移动 ≥ 0.05（同交晴空漂移作对照，看漂移是否只是天光本身）',
        Math.abs(sB.wSky - sA.wSky) >= 0.05,
        `storm sky |Δ| ${rd(Math.abs(sB.wSky - sA.wSky))} vs calm sky |Δ| ${rd(Math.abs(cB.wSky - cA.wSky))}; storm ground |Δ| ${rd(Math.abs(sB.wGround - sA.wGround))}`);
    }
  }

  // 埋身那一组只报告，不判分：它回答的是「视点在墙里时画面被压掉多少光」。
  const buriedNote = D.map((d, i) => ({ dayT: d, frames: buried[i].map((f) => ({ n: f.name, dark: PCT(f.bins0), w: [f.wSky, f.wMid, f.wGround], uStorm: f.uStorm })) }));

  R.unpinStorm(); R.clearSky();
  const failed = rows.filter((r) => !r.ok);
  return JSON.stringify({
    verdict: (failed.length === 0 && rows.length >= 5) ? `STORM_HUE_PASS ${rows.length}/${rows.length}` : `STORM_HUE_FAIL ${failed.length}/${rows.length}`,
    failed: failed.map((f) => f.id + ' :: ' + f.note),
    skipped: skip, rows,
    hours: { map: 'dayT = 钟面：0.25 日出 / 0.50 正午 / 0.75 日落 (environment.js:261-268)', chosen: D, contrast: rd(bestGap), scan: scan.map((s) => ({ d: s.dayT, dark: PCT(s.bins0), wSky: s.wSky, wGround: s.wGround })) },
    calibration: { noiseCalm: rd(noiseCalm, 5), noiseStorm: rd(noiseStorm, 5), noise: rd(noise, 5), threshold: rd(THRESH, 4), lightFloorPermille: LIGHT },
    pins: PINS, splitByCondition: ok.map((f) => ({ n: f.name, pin: f.pin, w: [f.wSky, f.wMid, f.wGround], uStorm: f.uStorm, clip: f.clip, dark: PCT(f.bins0) })),
    differentials: D.map(dAt), buriedOnly: buriedNote,
    cam: { at: CAM, look: LOOK, sunAt: 'null (real sky lights the frame)' },
    note: 'W = R/B 归一化色度比值；判据走 buried（分级分支以 uStorm 为乘子，framed 那组 0.024 等于关）；H2 判「暴是否改变竖向色序」，分支自身的符号/幅度由 storm-hue-mutate.js 判',
  }, null, 1);
})()
