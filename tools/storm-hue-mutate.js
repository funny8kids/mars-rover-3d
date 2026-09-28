// 【E】1「色偏随高度」的变异对照 —— 分级分支本身到底可不可见
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-hue-mutate.js
//
// 背景（第一跑 tools/logs/storm-hue-2026-09-28-234945.log）：埋身沙暴下量到画面顶带 R/B 4.0、底带 3.2
// ——分割是有的、方向稳定，但**和 `src/fx/post.js:106-109` 那条分层分支预测的方向相反**：
// 该分支满强度时给底带的 R/B 乘子是 (0.66+0.34·1.22)/(0.66+0.34·0.44)=1.33，给顶带是
// (0.78+0.22·0.86)/(0.78+0.22·0.72)=1.033，即它要底带比顶带暖 1.28 倍；实测却是底带只有顶带的 0.80 倍。
// 所以「画面有竖向色偏」不等于「分层分级在做功」——尘幕自身的颜色（雾+粒子，R/B 4–5）把地形带冲淡了。
//
// 这一把尺子只回答一个问题：把那条分支改掉，读数会不会跟着动？
//   I0   原样（两帧）
//   M0   整条分层分支关掉 ⇒ 「介质自身竖向色偏」的基线，所有变异读数都相对它取差
//   M1   抹掉高度项（两支 mix 都用常数权重 0.28）⇒ 保持 tint 总量、只拆掉随高度的分配
//   M2   方向反转（低/高权重互换）⇒ 贡献必须反号
//   I0'  还原后再量一次 ⇒ 漂移必须远小于被量的贡献，否则是在比一个挂掉的 shader
// 第一跑（tools/logs/storm-hue-mutate-2026-09-28-235308.log）的 V1/V2 写错了期望：要求「总分割塌到 ~0」
// 和「翻符号」。塌到 0 只有在介质自身没有竖向色偏时才成立，而 M0 显示介质基线本身就是 −0.5 量级
// （顶带比底带暖）。没有 M0 这一支，分支在做功会被读成不在做功。判据因此改成差分＋算术预测。
// 变异在页面里做（改 fragmentShader + needsUpdate，three.js 的 needsProgramChange 会比对源串重编译），
// 不动仓库字节；每次替换先数锚点出现次数，!=1 就停下——打在重复锚上会把「分支在功」读成假红。
// 只用埋身钉法（peak/-120）：framed（front@+20）那组 uStorm 只有 0.024，等于没开 storm。
(async () => {
  const R = window.__RSB;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oneFrame = () => Promise.race([new Promise(requestAnimationFrame), sleep(1500)]);
  const frames = async (n) => { for (let i = 0; i < n; i++) await oneFrame(); void n; };
  const fin = (x) => Number.isFinite(x);
  const rd = (x, d = 4) => (fin(x) ? +x.toFixed(d) : x);
  const W = (b) => (b && fin(b[0]) && fin(b[2]) && b[2] > 0 ? b[0] / b[2] : NaN);
  if (!R.state || !R.state.started) return 'NOT_STARTED';

  const ps = R.post().composer.passes;
  const idx = ps.findIndex((p) => p.material && p.material.uniforms && p.material.uniforms.uStorm);
  if (idx < 0) return 'NO_GRADE_PASS';
  const mat = ps[idx].material;
  const SRC = mat.fragmentShader;
  const LOW = 'col = mix(col, col * vec3(1.22, 0.80, 0.44), uStorm * low * 0.34);';
  const ALOFT = 'col = mix(col, col * vec3(0.86, 0.74, 0.72), uStorm * (1.0 - low) * 0.22);';
  const count = (s, sub) => s.split(sub).length - 1;
  const anchors = { lowAt: count(SRC, LOW), aloftAt: count(SRC, ALOFT), lowVar: count(SRC, 'float low =') };
  if (anchors.lowAt !== 1 || anchors.aloftAt !== 1)
    return JSON.stringify({ verdict: 'STORM_HUE_MUTATE_ANCHOR', anchors, note: '锚点不唯一，拒绝变异（重复锚会把"分支在功"读成假红）' }, null, 1);

  const apply = (src) => { mat.fragmentShader = src; mat.needsUpdate = true; };
  // M0：整条分层分支关掉——这是「介质自身的竖向色偏」基线。没有它，「分割没塌到 0」会被读成
  // 「分支不在功」，而实际上分支只是在往一个更大的反向底色上做功（第一跑就是这么误判的）。
  const off = SRC.replace(LOW, '').replace(ALOFT, '');
  // M1：抹掉高度项——两支都用常数权重 0.28，保持 tint 强度总量不变，只拆掉随高度的分配
  const flat = SRC.replace(LOW, 'col = mix(col, col * vec3(1.22, 0.80, 0.44), uStorm * 0.28);')
                  .replace(ALOFT, 'col = mix(col, col * vec3(0.86, 0.74, 0.72), uStorm * 0.28);');
  // M2：方向反转——底带拿灰 tint 的权重、顶带拿暖 tint 的权重
  const flip = SRC.replace(LOW, 'col = mix(col, col * vec3(1.22, 0.80, 0.44), uStorm * (1.0 - low) * 0.34);')
                  .replace(ALOFT, 'col = mix(col, col * vec3(0.86, 0.74, 0.72), uStorm * low * 0.22);');

  const CAM = [-26, 3.0, 34], LOOK = [0, 1.6, -46];
  const cap = async (name) => {
    const s = await Promise.race([R.shot(name, CAM, LOOK, null), sleep(9000).then(() => null)]);
    if (!s || !s.heights) return { name, failed: 'no frame' };
    return { name, sky: rd(W(s.heights.sky)), mid: rd(W(s.heights.mid)), ground: rd(W(s.heights.ground)),
      split: rd(W(s.heights.ground) - W(s.heights.sky)), dark: s.bins && s.bins[0] };
  };

  // 埋身满强度沙暴，钉到 uStorm 平台
  R.pinStorm('peak', -120, 0);
  await sleep(1800);
  for (let i = 0; i < 40; i++) { await sleep(300); await frames(3); if (Number(ps[idx].material.uniforms.uStorm.value) >= 0.9) break; }

  const runs = {};
  runs.I0a = await cap('e1cm-I0a'); runs.I0b = await cap('e1cm-I0b');
  apply(SRC); apply(off); await sleep(700); await frames(6);
  runs.M0a = await cap('e1cm-M0a'); runs.M0b = await cap('e1cm-M0b');
  apply(SRC); apply(flat); await sleep(700); await frames(6);
  runs.M1a = await cap('e1cm-M1a'); runs.M1b = await cap('e1cm-M1b');
  apply(SRC); apply(flip); await sleep(700); await frames(6);
  runs.M2a = await cap('e1cm-M2a'); runs.M2b = await cap('e1cm-M2b');
  apply(SRC); await sleep(700); await frames(6);
  runs.I0c = await cap('e1cm-I0c');

  const mean = (a, b) => (a.split + b.split) / 2;
  // 噪声不能只取相邻两帧：I0a/I0b 逐位相同（shot() 自己 render 一帧，粒子时钟没让出 task），
  // 那量到的是「同一帧抄两遍」= 0，不是跑与跑之间的漂移。漂移取 I0a 与还原后的 I0c。
  const dup = Math.max(Math.abs(runs.I0a.split - runs.I0b.split), Math.abs(runs.M0a.split - runs.M0b.split), Math.abs(runs.M1a.split - runs.M1b.split), Math.abs(runs.M2a.split - runs.M2b.split));
  const drift = Math.abs(runs.I0c.split - runs.I0a.split);
  const base = mean(runs.I0a, runs.I0b), offM = mean(runs.M0a, runs.M0b), flatM = mean(runs.M1a, runs.M1b), flipM = mean(runs.M2a, runs.M2b);
  // 分支自己该贡献多少：底带拿暖 tint（R/B 乘子 1.22/0.44 按权重 0.34·low≈0.29 混）≈ ×1.27，
  // 顶带拿灰 tint（0.86/0.72 按 0.22 混）≈ ×1.033。用关掉分支那两带的实测 W 作底，
  // 预测贡献 = W_g·0.27 − W_s·0.033。这条把「方向对但幅度是 taste」变成算术。
  const pred = (runs.M0a.ground * 0.27) - (runs.M0a.sky * 0.033);
  const contrib = base - offM;

  const rows = [];
  const add = (id, ok, note) => rows.push({ id, ok: !!ok, note });
  add('V0 还原真实：改回原串之后读数回到变异前，漂移必须远小于被量的贡献（否则整场比较是在比一个挂掉的 shader）',
    drift <= Math.max(0.02, 0.5 * Math.abs(contrib)), `I0 ${rd(base)} → 变异三轮 → I0c ${rd(runs.I0c.split)}，漂移 ${rd(drift, 5)}，阈值 max(0.02, 0.5×|贡献|)=${rd(Math.max(0.02, 0.5 * Math.abs(contrib)), 5)}，同帧重复 ${rd(dup, 5)}`);
  add('V1 分支在功：关掉整条分层，split 必须移动 ≥ max(0.12, 3×漂移)',
    Math.abs(contrib) >= Math.max(0.12, 3 * drift), `开 ${rd(base)} 关 ${rd(offM)} ⇒ 贡献 ${rd(contrib)}（漂移 ${rd(drift, 5)}，阈值 ${rd(Math.max(0.12, 3 * drift), 5)}）`);
  add('V2 方向与幅度符合 tint 数学：贡献为正（底带被抬暖）且落在预测的 0.4–2.5 倍内',
    contrib > 0 && contrib / pred >= 0.4 && contrib / pred <= 2.5,
    `贡献 ${rd(contrib)} / 预测 ${rd(pred)} = ${rd(contrib / pred, 3)} 倍`);
  add('V3 极性：反转低/高权重必须把贡献打到反号，且幅度 ≥ 原贡献的 0.6 倍',
    flipM - offM < 0 && Math.abs(flipM - offM) >= 0.6 * Math.abs(contrib),
    `反转后贡献 ${rd(flipM - offM)}（原 ${rd(contrib)}）；抹平成常数权重那组贡献 ${rd(flatM - offM)}——它就是"一层棕滤镜"该有的样子`);

  const failed = rows.filter((r) => !r.ok);
  return JSON.stringify({
    verdict: failed.length ? `STORM_HUE_MUTATE_FAIL ${failed.length}/${rows.length}` : `STORM_HUE_MUTATE_PASS ${rows.length}/${rows.length}`,
    failed: failed.map((f) => f.id + ' :: ' + f.note),
    rows, runs,
    anchors, shaderSrcSha: SRC.length,
    means: { intact: rd(base), off: rd(offM), flat: rd(flatM), flipped: rd(flipM), dup: rd(dup, 5), drift: rd(drift, 5), pred: rd(pred), contrib: rd(contrib), ratio: rd(contrib / pred, 3) },
    note: 'split = W(ground) − W(sky)，W = R/B；埋身 peak/-120，uStorm ≈ 1，同一机位同一 dayT，只改 fragmentShader 的分支权重',
  }, null, 1);
})()
