// 【E】1 的第一条：贴地滚动的沙浪前缘 —— 第一把尺子
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-front-probe.js
//
// 七件事里只有这一格到 2026-09-28 还没有自动读数：其余六格的证据都在 tools/logs/，而前缘只有一份
// 2026-09-22 的人工量测（写在 src/world/storm.js:365-372 的注释里：WALL_SPAN 760 / WALL_TALL 88 /
// WALL_DECK 0.30，机位眼高 4.7 m、60° 竖向 fov、standoff 150 m 时墙脚 −2.2°、墙顶 +28.7°→ 改成 +15°）。
// 注释能说明"当初为什么这么定"，不能说明"今天还在这么画"。这一把把它换成判据。
//
// 「贴地滚动的沙浪前缘」这句话拆成四件事，每一件都必须能被否证：
//   前缘在推进    → 场自己的 edge 按 LEAD_SPEED 走，而且画出来的那片布确实站在 edge 上（F1）
//   是楔不是阶跃  → 沿风向 local() 有几十米的 10→90 % 过渡带（F2）；「只改 fog 颜色」的实现这里
//                  给的是全岛同一个数，宽度量不出来
//   贴在地上      → 布按 deck 线吊着（不是居中）⇒ 墙脚落在地平线/terrain 上、裙摆埋进沙里、
//                  墙顶之上还剩真的天空（F3）；且墙自己的贡献锁在一段连续的行里，行带之外逐行不变
//                  （F5）——「只改 fog」的实现在这里每一行都动，会红
//   在滚          → 同一帧只改 `uTime`，墙的像素必须跟着变（F4）；把 uTime 冻住就是极性变异
//
// 两个防自欺的设定：
//  ① 一切像素判据走 `__RSB.wallFrame({uTime, hide})`（src/main.js 的 __RSB 块）。它**同步**渲染并
//     回读，所以两次调用之间不会让出 JS task —— 让出去一次，游戏的循环就把 uTime += dt 推前一格，
//     那一对比就成了「时间不同」而不是「uTime 不同」。回读也必须在同一个 task 里：composer.render()
//     之后 task 一空，drawing buffer 就是空的，drawImage 只能拿到黑帧，那会把「没有滚动」读成一次真读数。
//  ② 每条判据的地板由**同条件的重复帧**量出来（repeat baseline），不是拍出来的常数；F4 还配一条
//     极性变异（冻 uTime），F6 配一条假阳对照（钉住晴空：墙不可见 ⇒ 推 uTime 也不该有差）。
//
// 披露（不是缺陷，但必须写在读数旁边）：
//  · `local()` 与海拔无关（`src/world/storm.js:337`，它只吃 x,z），所以「贴地」这一半**不来自雾**，
//    来自那片布的几何与可见性：吊在 deck 线上、裙摆 26 m 埋进沙、贡献锁在低空一行带里，且只有 deck
//    以上的部分在顶点着色器里翻滚（`up = smoothstep(uDeck, 1.0, uv.y)`，「Nothing below the deck line
//    moves」）。F3/F5 量的就是这个；雾与粒子那半边的高空分层另有 E1a。
//  · 片元里那条「deck 之上 14 % 处更密」的肩（`prof *= 1.0 + 0.30*exp(-pow((hy-0.14)*2.2, 2.0))`）
//    **不在判据里**，只报数。原因写在 F5 里：画面上一行只能观测到 α·(墙色 − 背景)，α 与背景不可分
//    （一次 render 一个方程），所以"低处更密"不能从带背景的帧差里干净地归因出来；那一格交给眼睛
//    （F7 的三帧）与着色器算术本身。
//  · `uAmt` 在墙被关掉之后是**陈旧值**：`placeStormWall` 第一行 `const amt = field.amplitude;`
//    然后 `mesh.visible = amt > 0.02; if (!mesh.visible) return 0;` —— 提前返回，uniform 不再被写。
//    第一跑我就是照 `uAmt ≤ 0.05` 判 F6，于是"墙已经不可见"的假阳对照读到一个 1.0 的 uAmt 而判红。
//    生死要看 `mesh.visible`／`field.amplitude`，不是那个 uniform（本尺已改，见 F6 的 uniform_is_stale）。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const frames = async (n) => { for (let i = 0; i < n; i++) await oneFrame(); void n; };
  const fin = Number.isFinite;
  const rd = (x, d = 3) => (fin(x) ? +x.toFixed(d) : String(x));
  const LEAD = 21, BAND = 46, SLAB_TAIL = 260, FACE = 150;

  if (!R || !R.state || !R.state.started) return 'NOT_STARTED';
  if (!R.stormWallRef || !R.wallFrame) return 'NO_INSTRUMENT';

  const out = { rows: {}, notes: [] };
  const ok = (k, v, d) => { out.rows[k] = { pass: !!v, ...d }; };
  const wall = R.stormWallRef();
  const U = wall && wall.material && wall.material.uniforms;

  // ── F0 闸：尺子自己先证明自己读得到东西 ────────────────────────────────
  R.pinStorm('front', 150, null);
  await frames(30);
  const g1 = R.wallFrame();
  await frames(30);
  const g2 = R.wallFrame();
  const hasU = !!(U && U.uTime && U.uAmt && U.uDeck);
  ok('F0', hasU && g1 && g2 && g2.amt > 0.3 && g2.time > g1.time, {
    uniforms: Object.keys(U || {}), amt: rd(g2 && g2.amt),
    timeAdvanced: rd(g2 && g2.time - g1.time, 4),
    why: 'uTime 必须自己往前走（placeStormWall 里 uTime += dt），uAmt 必须非零 —— 否则后面每一条像素判据比的都是两张空帧',
  });
  if (!out.rows.F0.pass) return { ...out, verdict: 'STORM_FRONT_ABORT F0', tally: '0/8' };

  // ── F1 前缘在推进：把场解钉，让 edge 自己走 ────────────────────────────
  const f = R.stormRef();
  f.enabled = true; f.pinned = false; f.scheduled = false;
  f.phase = 'front'; f.t = 0; f.hold = 60;
  f.amplitude = 1; f.speed = 23;
  f.edge = -FACE - BAND; f.trail = f.edge - SLAB_TAIL;
  const march = [];
  for (let i = 0; i < 9; i++) {
    await frames(15);
    const p = R.phys();
    const a = f.along(wall.position.x, wall.position.z);
    march.push({ t: +(performance.now() / 1000).toFixed(3), edge: +f.edge.toFixed(2),
      meshAlong: +a.toFixed(2), follow: +(a - f.edge).toFixed(2),
      standoff_to_rover_m: +(f.along(p.x, p.z) - f.edge).toFixed(1), phase: f.phase,
      amp: +f.amplitude.toFixed(2) });
  }
  const n = march.length;
  const xs = march.map(m => m.t), ys = march.map(m => m.edge);
  const mt = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mt) * (ys[i] - my); den += (xs[i] - mt) ** 2; }
  const slope = num / den;
  const trackErr = Math.max(...march.map(m => Math.abs(m.follow)));
  ok('F1', fin(slope) && Math.abs(slope - LEAD) <= LEAD * 0.3 && trackErr <= 1.5, {
    slope_mps: rd(slope, 2), expect: LEAD, tol_pct: 30,
    edge_first: rd(ys[0], 1), edge_last: rd(ys[n - 1], 1),
    elapsed_s: rd(xs[n - 1] - xs[0], 2), mesh_tracks_edge_maxerr_m: rd(trackErr, 2),
    why: `storm.js:24 写「LEAD_SPEED = 21 m/s — the wall crosses the 300 m island in ~14 s」；这句话此前从没被当判据跑过。mesh 的 along 坐标跟 edge 的差是「那片布确实站在前缘上」的那一半`,
  });
  out.notes.push({ march_first: march[0], march_last: march[n - 1] });

  // ── F2 是楔不是阶跃：钉住前缘，沿风向扫 local() ────────────────────────
  R.pinStorm('front', 150, null);
  await frames(30);
  const F = R.stormRef(), wx = F.wx, wz = F.wz, edge = F.edge;
  const camCross = F.cross(wall.position.x, wall.position.z);
  const at = (s, c) => F.local(s * wx + c * wz, s * wz - c * wx);
  const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
  const LANES = [-40, -20, 0, 20, 40].map(c => c + camCross);
  const prof = [];
  for (let s = edge + 150; s >= edge - 150; s -= 3) prof.push({ s: +(s - edge).toFixed(1), v: med(LANES.map(c => at(s, c))) });
  const ahead = med(LANES.map(c => at(edge + 120, c)));
  const behind = med(LANES.map(c => at(edge - 60, c)));
  // 单调交叉（prof 按 s 从大到小排）：从下风的干净空气往上风走，v 由 0 升上来。
  // s10 = 第一个把 v 抬到 0.1 的采样点（也就是最靠干净空气那一侧的 10 % 交点），
  // s90 = 第一个到 0.9 的点。宽度 = s10 − s90。
  // 第一跑不是这么写的（它取了整段扫描的两端），于是量到的是"我扫了 300 m"而不是"过渡带 45 m"——
  // 那条红是尺子的，读数本身（profile 那一列）当时就已经把楔形画出来了。
  let s10 = null, s90 = null;
  for (const p of prof) {
    if (s10 === null && p.v >= 0.1) s10 = p.s;
    if (s90 === null && p.v >= 0.9) s90 = p.s;
  }
  const width = (s10 !== null && s90 !== null) ? s10 - s90 : NaN;
  const pv = prof.map(p => p.s), qv = prof.map(p => p.v);
  const mp = pv.reduce((a, b) => a + b, 0) / pv.length, mq = qv.reduce((a, b) => a + b, 0) / qv.length;
  let pn = 0, pd1 = 0, pd2 = 0;
  for (let i = 0; i < pv.length; i++) { pn += (pv[i] - mp) * (qv[i] - mq); pd1 += (pv[i] - mp) ** 2; pd2 += (qv[i] - mq) ** 2; }
  const r_ = pn / Math.sqrt(pd1 * pd2);
  ok('F2', fin(width) && width >= 15 && width <= 140 && ahead <= 0.08 && behind >= 0.7 && r_ <= -0.8, {
    width_10_90_m: rd(width, 1), s10_m: s10, s90_m: s90, band_theory_m: rd(BAND * 1.4, 1),
    ahead_at_edge_plus_120: rd(ahead), behind_at_edge_minus_60: rd(behind),
    corr_s_vs_local: rd(r_), samples: prof.length,
    why: '阶跃（coverage 直接 0/1）在这里宽度≈0；全岛同一个数（只改 fog）在这里相关系数≈0。楔形的宽度由 BAND=46 m 的前缘斜坡给出（local 还乘了 1.5 的指状 fbm，所以量到的会比纯 smoothstep 略窄，两半都报）',
  });
  out.notes.push({ profile: prof.filter((_, i) => i % 5 === 0).map(p => [p.s, rd(p.v)]) });

  // ── F3 墙脚落在地上：deck 线 = 地形/地平线夹住的值，裙摆埋进沙，墙顶在画面里但顶不穿 ──
  R.pinStorm('front', 150, null);
  await frames(20);
  const W = wall, tall = W.geometry.parameters.height, deckFrac = U.uDeck.value;
  const surfaceAt = R.stormRef().surfaceAt;
  const deckObs = W.position.y + tall * (deckFrac - 0.5);            // storm.js: WALL_SINK = tall*(deck-0.5)
  const gWall = surfaceAt(W.position.x, W.position.z);
  const rover = R.phys();
  const expect = Math.max(gWall, surfaceAt(rover.x, rover.z) - 1.5);
  const bottom = deckObs - deckFrac * tall, crest = deckObs + (1 - deckFrac) * tall;
  const horizDist = Math.hypot(W.position.x - rover.x, W.position.z - rover.z);
  // 眼高取 3.0 m（车体上方相机那一档）。这个假设对判据不敏感：standoff 140 m 处 ±1.7 m 的眼高
  // 只把墙顶仰角移动 0.6°，而 09-22 那次人工量测用的 4.7 m 也在同一条 +5°~+28° 带里。
  const eye = 3.0;
  const deg = (y) => Math.atan2(y - eye, horizDist) * 180 / Math.PI;
  const crestDeg = deg(crest), deckDeg = deg(deckObs);
  ok('F3', Math.abs(deckObs - expect) <= 0.5 && bottom < gWall - 5 && crestDeg >= 5 && crestDeg <= 28 && deckDeg < 0.8, {
    deck_world_y: rd(deckObs, 2), expected_from_clamp: rd(expect, 2), err_m: rd(deckObs - expect, 2),
    skirt_bottom_m: rd(bottom, 1), terrain_at_wall_m: rd(gWall, 1), buried_by_m: rd(gWall - bottom, 1),
    crest_elevation_deg: rd(crestDeg, 2), deck_elevation_deg: rd(deckDeg, 2), eye_m_assumed: eye,
    standoff_m: rd(horizDist, 1), tall_m: rd(tall, 1), deck_frac: rd(deckFrac, 2),
    why: '把 09-22 那次人工量测自动化：墙必须"站在"deck 夹值上（不是浮着也不是插进沙），裙摆必须被沙埋住（否则前缘和地面之间露出一道缝），而墙顶必须在 +5°~+28° 之间——高了就顶穿画面变成"天气开关"，低了就退回那面被龙门架挡住的板',
  });

  // ── F4/F5/F6 像素：同一帧只动 uTime，以及把墙藏起来看它是谁 ──────────────
  R.pinStorm('front', 150, null);
  await frames(40);
  const live = R.wallFrame();
  const t0 = live.time;
  const A = R.wallFrame({ uTime: t0 });
  const B = R.wallFrame({ uTime: t0 });
  const C = R.wallFrame({ uTime: t0 + 2.4 });
  const D = R.wallFrame({ uTime: t0, hide: true });
  const dAB = A.rows.map((v, i) => Math.abs(v - B.rows[i]));
  const dAC = A.rows.map((v, i) => Math.abs(v - C.rows[i]));
  const dAD = A.rows.map((v, i) => Math.abs(v - D.rows[i]));
  const noiseMax = Math.max(...dAB);
  // 墙自己占的行：把它自己的贡献（现帧 − 藏帧）按行量出来，取连续的一段
  const rowsOwn = dAD.map((v) => v > Math.max(0.25, 6 * noiseMax));
  let best = { len: 0, a: 0, b: 0 }, cur = null;
  for (let i = 0; i < 100; i++) {
    if (rowsOwn[i]) { if (!cur) cur = { a: i, b: i }; else cur.b = i; if (cur.b - cur.a + 1 > best.len) best = { ...cur, len: cur.b - cur.a + 1 }; }
    else cur = null;
  }
  const band = [];
  for (let i = best.a; i <= best.b; i++) band.push(i);
  const mean = (arr, rows) => rows.reduce((s, i) => s + arr[i], 0) / (rows.length || 1);
  const third = Math.max(1, Math.floor(band.length / 3));
  const stepBand = mean(dAC, band), noiseBand = mean(dAB, band);
  ok('F4', band.length >= 8 && stepBand >= 8 * Math.max(noiseBand, 0.002) && stepBand >= 0.4, {
    wall_band_rows: [best.a, best.b], band_len_rows: band.length,
    step_uTime: 2.4, advect_cells_per_unit: 0.42,
    band_mean_abs_diff_after_step: rd(stepBand, 3),
    band_mean_abs_diff_repeat: rd(noiseBand, 4), ratio: rd(stepBand / Math.max(noiseBand, 0.002), 1),
    rowwise_noise_max: rd(noiseMax, 4),
    why: '极性变异就在这一格：把 uTime 冻住（这里用同一个 t0 重复一次）差值必须回到噪声；一张不消费 uTime 的静态贴图在这格给 0',
  });
  // 「贴地」的画面那一半：墙的贡献必须锁在一段连续的行里，带外逐行不动。
  // 「只改 fog 颜色」的实现让 100 行全动 ⇒ 带外最大差会远超噪声 ⇒ 这一格红。
  const outside = dAD.filter((_, i) => i < best.a || i > best.b);
  const outsideMax = outside.length ? Math.max(...outside) : NaN;
  const lowDense = mean(dAD, band.slice(-third)), highDense = mean(dAD, band.slice(0, third));
  ok('F5', band.length >= 8 && band[band.length - 1] >= 6 && fin(outsideMax) && outsideMax <= Math.max(0.5, 6 * noiseMax), {
    own_wall_rows: [best.a, best.b], band_len_rows: band.length, rows_above_band: band[0],
    band_is_below_frame_top: band[band.length - 1] >= 6,
    outside_band_max_abs_diff_levels: rd(outsideMax, 3), floor: rd(Math.max(0.5, 6 * noiseMax), 3),
    not_gated: { near_deck_over_near_crest: rd(lowDense / (highDense || 1e-6), 3),
      deck_side_mean: rd(lowDense, 3), crest_side_mean: rd(highDense, 3),
      reason: '画面上一行只观测到 α·(墙色 − 背景)：一次 render 一个方程，α 与背景不可分，所以片元那条 low-shoulder（prof *= 1.0+0.30*exp(-pow((hy-0.14)*2.2,2.0))）不能从带背景的帧差里干净归因；这一格只报数，判据交给 F7 的帧与着色器算术本身' },
    why: '「贴地」在画面里的可归因那一半：前缘是一片站在地上、被地平线收住的行带（带外一行的亮度都不动），不是铺满全屏的洗色（那是雾）',
  });

  // 假阳对照：钉住晴空 —— 此时 placeStormWall 让 mesh.visible=false 并提前返回，
  // 推 uTime 也不该有任何像素变化。生死看 visible/amplitude，不看那个陈旧的 uAmt uniform。
  R.pinStorm('calm', 150, null);
  await frames(60);
  const c0 = R.wallFrame();
  const calmVisible = wall.visible, calmAmp = +R.stormRef().amplitude.toFixed(3);
  const E = R.wallFrame({ uTime: c0.time });
  const Ff = R.wallFrame({ uTime: c0.time + 2.4 });
  const calmDiff = E.rows.map((v, i) => Math.abs(v - Ff.rows[i]));
  ok('F6', calmVisible === false && calmAmp <= 0.02 && mean(calmDiff, band) === 0, {
    mesh_visible: calmVisible, field_amplitude: calmAmp,
    uniform_is_stale: { uAmt_read: rd(c0.amt), note: 'placeStormWall 提前 return，uniform 不再被写 ⇒ 单看 uAmt 会把"墙不可见"读成"墙全开"' },
    band_mean_diff_when_invisible: rd(mean(calmDiff, band), 4),
    why: '这条是尺子的假阳对照：墙不可见时推 uTime 仍能差出东西，那 F4 量的就不是墙',
  });

  // ── F7 眼睛：三帧，且把「藏掉墙」那一帧一起拍，让它自己说话 ────────────
  R.pinStorm('front', 150, null);
  await frames(40);
  const s1 = await Promise.race([R.shot('e1f-front-framed', null, null, null), sleep(12000).then(() => null)]);
  W.visible = false;
  const s2 = await Promise.race([R.shot('e1f-front-wallhidden', null, null, null), sleep(12000).then(() => null)]);
  W.visible = true;
  R.pinStorm('calm', 150, null);
  await frames(60);
  const s3 = await Promise.race([R.shot('e1f-front-calm', null, null, null), sleep(12000).then(() => null)]);
  const cl = [s1, s2, s3].map(s => (s ? s.clip : null));
  ok('F7', cl.every(c => fin(c) && c <= 1.0) && !!s1 && !!s2 && !!s3, {
    frames: ['e1f-front-framed', 'e1f-front-wallhidden', 'e1f-front-calm'],
    clip_pct: cl, clip_bar: 1.0,
    why: 'F1 的眼睛那一格：三帧要在图上分得开（有墙/没墙/晴空），且不过曝；判据帧必须归档，不能只活在收集器的临时目录里',
  });

  const keys = Object.keys(out.rows);
  const pass = keys.filter(k => out.rows[k].pass);
  out.rows.F7.frames_read = 'NOT_OPENED_BY_PROBE —— 由人打开 tools/logs/ 里那三张 png 之后再签这一格';
  return { ...out, tally: `${pass.length}/${keys.length}`,
    verdict: `${pass.length === keys.length ? 'STORM_FRONT_PASS' : 'STORM_FRONT_FAIL'} ${pass.length}/${keys.length}`,
    failed: keys.filter(k => !out.rows[k].pass) };
})();
