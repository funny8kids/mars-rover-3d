// 【E】1d 粒子↔体积光耦合：把太阳真正框进画面，然后按公式判 uGodRay
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-godray-probe.js 9333 240000 540000
//
// 为什么上一版只能记 SKIP：`tools/storm-grade-probe.js` 的 ④ 段扫了 12 个 dayT，晴空 `uGodRay`
// 全是 0，然后把它归因成「闸门未被满足」。那个 0 其实有两解——闸门没满足，或者耦合根本没接上——
// 而尺子读不出是哪一种。这一版的差别是：机位由**太阳方向**反解出来（车首对着太阳 ⇒ 追车相机对着
// 太阳），所以每一格都同时打印 dot / 投影 p / dayF，0 从此只可能有一个意思。
//
// 判据落在代码承诺的那条算式上（src/main.js:2628）：
//   uGodRay = quality.godrays && sunOnFrame ? (1 − stormF·0.66) · dayF · clamp(camDir·sunDir·2.2, 0, 1) : 0
// 所以「同帧读到 uStorm、dayF、dot，再算出预测值」本身就是锚——不需要复现某一张历史帧的字面值，
// 那正是 storm-altitude 前三跑红掉的原因（拿 follower 的单帧值当跨尺子锚）。
//
// 变异对照：把车首转 180°，太阳出框，uGodRay 必须**恰好** 0。亮着的那一格与灭掉的那一格成对，
// 才排除「常量」与「读错 pass」这两种假绿。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const frames = async (n) => { for (let i = 0; i < n; i++) await oneFrame(); };
  const fin = (x) => Number.isFinite(x);
  const rd = (x, d = 4) => (fin(x) ? +x.toFixed(d) : String(x));

  if (!R.state || !R.state.started) return 'NOT_STARTED';

  const cam = R.camera();
  const phys = R.phys();
  const env = R.env();
  // 页面里没有 window.THREE（各模块走 ES import），所以取现成对象的构造函数，不引第三个源
  const V3 = env.state.sunDir.constructor;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ps = R.post().composer.passes;
  const gi = ps.findIndex((p) => p.material && p.material.uniforms && p.material.uniforms.uGodRay);
  if (gi < 0) return 'NO_GODRAY_UNIFORM';
  const U = ps[gi].material.uniforms;
  const g = (k) => Number(U[k].value);
  const uGod = () => g('uGodRay');
  const uStorm = () => g('uStorm');
  const dotSun = () => new V3().copy(cam.getWorldDirection(new V3())).dot(env.state.sunDir);
  // 页面里重算闸门的那次投影，逐字照抄 src/main.js:2620-2623 —— 读不出 p 就读不出「0 是哪一种 0」
  const sunProj = () => {
    const sw = new V3().copy(env.state.sunDir).multiplyScalar(2000).add(cam.position);
    const p = sw.project(cam);
    return { x: +p.x.toFixed(3), y: +p.y.toFixed(3) };
  };
  // 同帧四元组：被测量与它的预测必须来自**同一帧**的同一个 uniform 对象
  const read = () => {
    const s = uStorm(), d = dotSun(), df = env.state.dayF, p = sunProj();
    const pred = (1 - s * 0.66) * df * clamp01(d * 2.2);
    return { god: rd(uGod()), storm: rd(s, 3), dayF: rd(df, 3), dot: rd(d, 3), p,
      sunUV: U.uSunUV ? U.uSunUV.value.toArray().map((n) => +n.toFixed(3)) : null,
      pred: rd(pred), dayT: +env.dayT.toFixed(3), dayHeld: !!env.dayHold };
  };
  // 车首朝向：physics 的 forward 是 (sin yaw, cos yaw)（src/vehicle/physics.js:105），
  // 所以要对着水平方位 (dx,dz) 走，yaw = atan2(dx, dz)。相机方位由追车 rig 跟着车，不改 rig 本身。
  const faceSun = (flip = false) => {
    const sd = env.state.sunDir;
    let yaw = Math.atan2(sd.x, sd.z);
    if (flip) yaw += Math.PI;
    phys.yaw = yaw;
    phys.vx = 0; phys.vz = 0; phys.speed = 0;
    return rd(yaw, 3);
  };
  // follower ⇒ 条件等平台，不定长 sleep（storm-grade 学到的第 2 条）
  const plateau = async (ms = 20000) => {
    const t0 = Date.now();
    let a = uGod(), b, stable = 0;
    while (Date.now() - t0 < ms) {
      await sleep(220); await oneFrame();
      b = uGod();
      stable = Math.abs(b - a) < 0.002 ? stable + 1 : 0;
      a = b;
      if (stable >= 3) return { waited: Date.now() - t0, timedOut: false, god: rd(b) };
    }
    return { waited: Date.now() - t0, timedOut: true, god: rd(a) };
  };

  const rows = [], skip = [];
  const add = (id, pass, note) => { rows.push({ id, ok: !!pass, note }); return pass; };

  // ---- ① 找机位：扫一天，取「太阳框内且 uGodRay 最大」的那个 dayT ----
  R.setFilm(0, 0);
  const aim = [];
  for (let d = 0.10; d <= 0.90; d += 0.1) {
    R.setDay(d); faceSun(false);
    await sleep(400); await frames(8); await plateau(9000);
    const r = read();
    aim.push({ ...r, dayT: +d.toFixed(2) });
    if (r.god > 0.001) break;                 // 一亮就收：后面每格都要在同一 dayT 上比
  }
  const lit = aim.filter((a) => a.god > 0.001);
  add('G0 闸门可满足：有一个 dayT 让太阳进框、体积光真的亮（uGodRay > 0.02）',
    lit.length > 0 && lit[lit.length - 1].god > 0.02,
    aim.map((a) => `dayT ${a.dayT} god ${a.god} dot ${a.dot} p ${JSON.stringify(a.p)} dayF ${a.dayF}`).join('; '));
  if (!lit.length) {
    skip.push('C 体积光耦合：扫过 dayT 0.10–0.90 且车首已按太阳方位反解，uGodRay 仍处处为 0（逐格 dot/p 见 G0 note）');
    return JSON.stringify({ verdict: 'STORM_GODRAY_SKIP', rows, skip, aim }, null, 1);
  }
  const dayPick = lit[lit.length - 1].dayT;
  R.setDay(dayPick); faceSun(false); await sleep(400); await frames(8); await plateau();
  const calm = read();

  // ---- ② 变异对照：太阳出框 ⇒ 恰好 0 ----
  faceSun(true); await sleep(500); await frames(10); await plateau(12000);
  const away = read();
  faceSun(false); await sleep(500); await frames(10); const backOn = await plateau();
  const calmAgain = read();
  add('G1 极性变异：车首转 180° 把太阳逐出框（dot ≤ 0.08 或 |p| ≥ 1.25）⇒ uGodRay 必须恰好 0，转回来必须复亮',
    away.god === 0 && away.dot <= 0.08 && Math.abs(calmAgain.god - calm.god) <= 0.02,
    `晴 ${calm.god}（dot ${calm.dot} p ${JSON.stringify(calm.p)}）→ 转开 ${away.god}（dot ${away.dot}）→ 转回 ${calmAgain.god}（settle ${JSON.stringify(backOn)}）`);
  const noise = Math.abs(calmAgain.god - calm.god);
  const TOL = Math.max(0.02, 5 * noise);

  // ---- ③ 耦合标尺：stormF 梯子，每格同帧比公式 ----
  // 梯子必须往负 standoff 走，正的把墙钉在上风远处（src/world/storm.js:71-73）——
  // storm-grade 第一版只扫正的，把衰减曲线当成了振幅上限。
  const ladder = [];
  for (const [ph, so] of [['peak', -120], ['peak', -40], ['front', -40], ['front', 20], ['peak', 20], ['peak', 80]]) {
    R.pinStorm(ph, so, Math.atan2(env.state.sunDir.x, env.state.sunDir.z));
    await sleep(900); await frames(8);
    const set = await plateau(22000);
    const r = read();
    // 相机必须在整格判据里都锁着太阳，否则这一格读的是「逃出了尘幕」而不是「暴变强」
    ladder.push({ ph, so, ...r, settle: set });
    R.unpinStorm(); R.clearSky(); await sleep(500); await frames(6); await plateau(12000);
  }
  const usable = ladder.filter((l) => l.dot > 0.08 && Math.abs(l.p.x) < 1.25 && Math.abs(l.p.y) < 1.25);
  add('G2 覆盖集：每一格判据都要在太阳仍框内时取（dot > 0.08 且 |p| < 1.25），否则那格不参与耦合判据',
    usable.length >= 3, `${usable.length}/${ladder.length} 格可用：` +
      ladder.map((l) => `${l.ph}@${l.so} god ${l.god} storm ${l.storm} dot ${l.dot} p ${JSON.stringify(l.p)}`).join('; '));
  add(`G3 公式跟到第四位：每格 |uGodRay − (1−0.66·stormF)·dayF·clamp(2.2·dot)| ≤ ${rd(TOL)}（容差 = max(0.02, 5×同机位重复噪声 ${rd(noise)}），锚取自同帧读数而非历史字面值）`,
    usable.length >= 3 && usable.every((l) => Math.abs(l.god - l.pred) <= TOL),
    usable.map((l) => `${l.ph}@${l.so}: god ${l.god} vs pred ${l.pred}（storm ${l.storm} dayF ${l.dayF} dot ${l.dot}）Δ ${rd(Math.abs(l.god - l.pred))}`).join('; '));

  // ---- ④ 沙尘是介质不是开关：暴内衰到晴空的 (1−0.66·stormF) 而不是 0 ----
  const deep = usable.reduce((a, b) => (b.storm > a.storm ? b : a), usable[0]);
  const ratio = fin(deep.god / calm.god) ? deep.god / calm.god : NaN;
  add('G4 深暴不关灯：最深一格 uGodRay 仍是晴空的 0.2–0.6 倍且严格大于 0（旧实现乘 (1−stormF) 会把它整条抹掉）',
    deep.storm >= 0.8 && ratio > 0.2 && ratio < 0.6,
    `dayT ${dayPick}：晴 ${calm.god} → ${deep.ph}@${deep.so} 暴内 ${deep.god}（×${rd(ratio, 3)}，公式预测 ×${rd(1 - 0.66 * deep.storm, 3)}，stormF ${deep.storm}）`);
  const byStorm = usable.slice().sort((a, b) => a.storm - b.storm);
  add('G5 单调：按 stormF 升序，uGodRay 必须逐级不升且首末差 ≥ 0.15（耦合方向反了或压根没接都会红）',
    byStorm.length >= 3 && byStorm.every((l, i) => i === 0 || l.god <= byStorm[i - 1].god + 0.002)
      && byStorm[byStorm.length - 1].storm - byStorm[0].storm >= 0.4
      && byStorm[0].god - byStorm[byStorm.length - 1].god >= 0.15,
    byStorm.map((l) => `storm ${l.storm} → god ${l.god}`).join(' ≥ '));
  add('G6 归因隔离：整场 dayF 与 dot 保持锁定（否则读到的可能是太阳升高而不是沙尘变浓）',
    usable.every((l) => Math.abs(l.dayF - calm.dayF) <= 0.02) && usable.every((l) => Math.abs(l.dot - calm.dot) <= 0.05),
    `dayF ${[...new Set(usable.map((l) => l.dayF))].join('/')}（晴 ${calm.dayF}）；dot ${usable.map((l) => l.dot).join('/')}（晴 ${calm.dot}）`);

  // ---- ⑤ 眼睛那一格：暴内暴外同一机位各拍一张，进 tools/logs 才可核对 ----
  const shots = [];
  R.unpinStorm(); R.clearSky(); faceSun(false); R.setDay(dayPick);
  await sleep(700); await frames(8);
  for (const [tag, ph, so] of [['godray-calm', null, null], ['godray-storm', 'peak', -120]]) {
    if (ph) { R.pinStorm(ph, so, Math.atan2(env.state.sunDir.x, env.state.sunDir.z)); await sleep(900); await plateau(22000); }
    const s = await Promise.race([R.shot('e1d-' + tag, null, null, null).catch(() => null), sleep(12000)]);
    shots.push({ tag, storm: rd(uStorm(), 3), god: rd(uGod()), clip: s && fin(s.clip) ? s.clip : null,
      bin0: s && s.bins ? s.bins[0] : null, got: !!s });
    if (ph) { R.unpinStorm(); R.clearSky(); await sleep(600); await frames(6); }
  }
  add('G7 两帧抓得到且能对眼（判据帧 clip < 0.5，暴内帧 stormF ≥ 0.8）',
    shots.every((s) => s.got && s.bin0 < 400) && shots[1].storm >= 0.8,
    shots.map((s) => `${s.tag} god ${s.god} storm ${s.storm} clip ${s.clip} bin0 ${s.bin0}`).join('; '));

  // ---- ⑧ 变异对照（读图面而不是读仪表）：把 uGodRay 手动写 0 再渲染一次，亮度必须掉 ----
  // G3 那格只证明「写字段的人按公式写」——同帧重算公式与字段当然相等，系数改了才会红，仅此而已。
  // 「体积光有没有进到画面」是另一件事，得在像素上判。shot() 的直方图是 8 档整数百分比，
  // 分辨率不够（1 % 才动一格），所以这里直接从 composer 的画布取一帧自己算亮度。
  // 与 shot() 同一条约束：渲染与取像素必须在同一个 JS task 里，否则 drawingBuffer 已被清空。
  const comp = R.post().composer;
  const cvs = comp && comp.renderer && comp.renderer.domElement;
  if (!cvs) {
    skip.push('C 变异对照：拿不到 composer.renderer 的画布，图面消费方未被判据覆盖（数值判据仍在）');
  } else {
    // 第一版只比整幅均值，读出来是「Δ 0.09 灰阶」——但体积光是**围着太阳**的一圈（shader 从
    // uSunUV 反向 march，`col += rays * 0.045 * uGodRay * (1,0.62,0.32)`，post.js:72）。整幅均值把
    // 那一圈摊到 64000 个像素上，量的是稀释后的余量而不是效应本身。所以这里同时给三个窗口：
    // 整幅、顶部 20 % 行、以及以 uSunUV 为圆心半径 40 px（在 320×200 的采样面上）的日轮邻域。
    // 判据落在**日轮邻域**那一格上，整幅那一格只报数不判——把「不可见」写成判据等于用尺子预设结论。
    const lumOf = () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 200;
      const x = c.getContext('2d'); x.drawImage(cvs, 0, 0, 320, 200);
      const d = x.getImageData(0, 0, 320, 200).data;
      const sx = (U.uSunUV ? U.uSunUV.value.x : 0.5) * 320, sy = (1 - (U.uSunUV ? U.uSunUV.value.y : 0.5)) * 200;
      let s = 0, st = 0, n = 0, hot = 0, ds = 0, dn = 0, dmax = 0;
      for (let i = 0; i < d.length; i += 4) {
        const px = (i / 4) % 320, py = Math.floor(i / 4 / 320);
        const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        s += L; n++;
        if (py < 40) st += L;
        if (L > 150) hot++;
        if (Math.hypot(px - sx, py - sy) <= 40) { ds += L; dn++; if (L > dmax) dmax = L; }
      }
      return { mean: +(s / n).toFixed(3), skyMean: +(st / (n * 0.2)).toFixed(3),
        sunMean: +(ds / Math.max(1, dn)).toFixed(3), sunMax: +dmax.toFixed(1),
        sunPx: dn, hotPct: +(hot / n * 100).toFixed(3) };
    };
    // 对照纯度：AB 的两半必须在同一个 stormF 上——G7 刚撤暴，stormF 是往回落的 follower，
    // 不等平台就会在 0.59/0.60/0.62 这种半暴的值上做变异（第一跑正是这样，三条 live 递增）。
    const waitCalm = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (uStorm() <= 0.05) return true; await sleep(250); }
      return uStorm() <= 0.05;
    };
    R.unpinStorm(); R.clearSky(); faceSun(false); R.setDay(dayPick);
    const pure = await waitCalm(24000);
    await frames(4);
    const AB = [];
    for (let k = 0; k < 3; k++) {
      await frames(4);
      const live = uGod();
      comp.render(); const on = lumOf();
      U.uGodRay.value = 0; comp.render(); const off = lumOf();
      U.uGodRay.value = live; comp.render(); const on2 = lumOf();
      AB.push({ k, live: rd(live), storm: rd(uStorm(), 3), on, off, on2,
        dMean: rd(on.mean - off.mean, 3), dSky: rd(on.skyMean - off.skyMean, 3),
        dSun: rd(on.sunMean - off.sunMean, 3), dSunMax: rd(on.sunMax - off.sunMax, 2),
        repeat: rd(Math.abs(on2.sunMean - on.sunMean), 3) });
    }
    const dSun = AB.map((a) => a.dSun), rep = Math.max(...AB.map((a) => a.repeat));
    add(`G8 图面消费方：同一帧把 uGodRay 手动写 0 再渲染，日轮邻域（半径 40 px）的平均亮度必须下降（>0.5 灰阶，且 >10× 同帧重复噪声 ${rd(rep, 3)}）；只看仪表不看像素，等于没判过`,
      pure && AB.every((a) => a.live > 0.5) && Math.min(...dSun) > Math.max(0.5, 10 * rep),
      `晴空纯度 ${pure ? 'ok（stormF ≤ 0.05）' : '未达（stormF 仍在回落中，AB 不可比）'}；`
        + AB.map((a) => `#${a.k} live ${a.live} storm ${a.storm}：ON 日轮 ${a.on.sunMean}/max ${a.on.sunMax}/整幅 ${a.on.mean}/顶部 ${a.on.skyMean} vs OFF ${a.off.sunMean}/${a.off.sunMax}/${a.off.mean}/${a.off.skyMean} ⇒ Δ日轮 ${a.dSun} Δmax ${a.dSunMax} Δ整幅 ${a.dMean} Δ顶部 ${a.dSky}；ON-ON 重复 ${a.repeat}`).join('; ')
        + ` ⇒ Δ日轮取最小 ${rd(Math.min(...dSun))}，整幅均值只有 ${rd(Math.min(...AB.map((a) => a.dMean)))}（体积光围着太阳，摊到整幅必然稀释，所以判据不放在整幅那一格）`);
    add('G8b 幅度披露：整幅均值随 uGodRay 归零而下降的量（不判，只写进台账供 F1 的眼睛复核）',
      true, `Δ整幅均值 ${dSun.length ? rd(Math.min(...AB.map((a) => a.dMean))) : 'n/a'} 灰阶／Δ顶部 20 % ${rd(Math.min(...AB.map((a) => a.dSky)))} 灰阶／Δ过曝占比 ${rd(Math.min(...AB.map((a) => a.on.hotPct - a.off.hotPct)), 3)} % ⇒ 若这两项都 < 0.2，则「写了但整幅看不出」是这一版出货的真实水位`);
  }

  const failed = rows.filter((r) => !r.ok);
  return JSON.stringify({
    verdict: failed.length ? `STORM_GODRAY_FAIL ${failed.length}/${rows.length}`
      : `STORM_GODRAY_PASS ${rows.length}/${rows.length}`,
    failed: failed.map((f) => f.id + ' :: ' + f.note),
    rows, skip, dayPick, qualityGodrays: R.state.quality, calm, away, calmAgain, ladder, shots,
    setup: { uniform: `pass #${gi}`, formula: '(1 - stormF*0.66) * dayF * clamp(camDir.sunDir*2.2,0,1)',
      aimedBy: 'phys.yaw = atan2(sunDir.x, sunDir.z) — chase rig follows the hull, rig itself untouched',
      tolerance: rd(TOL), noiseSamePose: rd(noise) },
  }, null, 1);
})()
