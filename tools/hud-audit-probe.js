// J 「前端为什么没有 bruno-simon 的美感」 — 把"美感差距"变成一组可判负的读数
//
//   node tools/cdp-run.mjs "http://127.0.0.1:5173/qa_boot.html?auto=std&audstate=hud"   tools/hud-audit-probe.js 9333 90000 300000
//   node tools/cdp-run.mjs "http://127.0.0.1:5173/qa_boot.html?auto=std&audstate=drive" tools/hud-audit-probe.js 9333 90000 300000
//
//   (~60 s and ~150 s against the headless Chrome on :9333.) The DOM pass changes nothing. The drive
//   pass teleports and drives the rover inside one browser tab — no file, no setting, no save —
//   because the lens the player looks through is a moving one; see `lens` below for why a
//   parked-camera reading is not a reading of the game's cinematography.
//
// WHY TWO PHASES AND NOT ONE RUN: one `Runtime.evaluate` is one frame budget. Headless software GL
// costs ~0.47 s per stepped 60 Hz frame here, and a step loop past roughly 500 frames makes CDP
// answer `-32603 Internal error` and the run yields nothing at all (crashed twice that way). The DOM
// census needs the camera flown in (~120 frames); the speed ladder needs a full throttle run-up
// (~300). Together they do not fit, so `?audstate=` names which one a run answers instead of one run
// answering neither.
//
// WHY A PROBE AND NOT AN OPINION: "不够美"不可判负，所以每一项都必须落成一个数字 + 一条会被坏实现
// 推红的判据。这里量的全是**页面自己的计算样式与真实落位**，不是截图观感：
//
//   typography — 设计里写的字体族到底有没有出现。一个 CSS 字体栈在缺字体的机器上会静默降级；
//     `getComputedStyle().fontFamily` 仍回你写的那串名字，所以它证明不了任何东西。这里用 canvas
//     量同一串文本在「设计栈」与「若干本机候选字体」下的推进宽度：宽度相等的那个才是真正被渲染的
//     字体。同时读 `document.fonts`：一个 @font-face 都没有的页面，字体身份完全由操作系统决定。
//   ladder     — 字号阶梯。排版要有层级，就得有几个明确分离的字号，而且最大/最小要拉开。这里给出
//     每个可见文本元素的实际字号、以及"多少比例的文本小于 X px"。
//   tracking   — 字距。小字号 + 大字距是"游戏 HUD"最常见的签名；单独看无害，和 ladder 一起看才有意义。
//   coverage   — 文本与"面板盒子"各吃掉多少画面。用 getBoundingClientRect 面积和除以视口面积。
//     一个 HUD 越像仪表盘，这个数越大；而参考站的画面上几乎不留盒子。
//   contrast   — 每条文本的颜色对它**实际合成出来的背景**的 WCAG 对比度（沿祖先链把半透明底色
//     合成到 --panel/#05040a 上）。不是量"好不好看"，是量"读不读得清"，这条有客观定义。
//   lens       — 相机的构图读数：主体（漫游车）占画面高度比例、镜头到主体的距离、fov、地平线在第几行，
//     并且沿真实加速过程逐档采样。这三条决定了"这一帧是不是被安排过的"，而它们全是投影算术，不需要人眼。
//     `opticsCheck` 用两份独立算法（投影算术 vs 距离/fov 的几何比）互验同一个 share，尺子坏了会露。
//
// WHAT THIS CANNOT SETTLE: 它不判断"哪个字体好看"，也不看世界着色（那是另一条链：帧直方图 +
// tools/storm-*）。它只回答一件事——现在的界面是按什么规格被渲染出来的，以及那条规格和参考站之间
// 可核对的差在哪。
//
// THE RULERS HAVE TO BE ABLE TO SAY "THE GAME IS FINE" — three controls do that here, and the actual
// findings, thresholds and the mutation run that filed them red are in
// `docs/VERIFICATION.md`（「前端 bruno-simon 差距」那一行）:
//   selfCheck      — DOM：五个已知在屏、已知字号的元素必须出现在普查结果里。少了就是尺子坏了，
//                    不是 HUD 变稀了（run #1 就是这样把 52 px 的 `#speed-val` 量没了）。
//   rulerControl   — 镜头：同一个 1.6 m 线段的屏幕占比，用投影矩阵算一遍、用相机自己的正交基做
//                    点积再算一遍，两把尺子必须同意。
//   opticsCheck    — 镜头：加速前后占比之比，必须等于 (d₀/d₁)·(tan(fov₀/2)/tan(fov₁/2))；这条
//                    证明「主体变小」不是 sharePct 的定义造成，而是相机真的在后退。
// 极性闸门（M1，写在 docs 那一行）：把 `src/camera/chase.js` 的 `speed * 0.42` 改成 `0`，
// drive phase 的 fov 阶梯必须躺平在 60°；不躺平就说明这一档量的不是游戏相机。

(async () => {
  const R = window.__RSB;
  if (!R) return JSON.stringify({ fail: 'window.__RSB missing' });
  const Q = window.__QA;
  // WHICH screen is measured has to be waited for, not assumed. `R.post()` only proves the composer
  // exists — it is true while the loading screen is still up — so gating on it made the phase a race
  // against the ~80 MB of assets the runner re-downloads every navigation (cache is disabled). Two
  // runs of this probe then reported different pages while looking identical: one censused the
  // loading screen (5 nodes, ladder 11/12/60/64), the next the driving HUD (16 nodes, 10…52).
  // `?audstate=hud` (default) and `?audstate=loader` name the screen, and `phase.got` below reports
  // what was actually up, so a mismatch fails loudly instead of reading as a change in the design.
  const want = (location.search.match(/audstate=(\w+)/) || [, 'hud'])[1];
  const cls = id => document.getElementById(id)?.classList;
  const wantUp = () => want === 'loader' ? !cls('loader')?.contains('hidden') : !!R.state?.started;
  const waitedAt = Date.now();
  while (!wantUp() && Date.now() - waitedAt < 60000) await new Promise(r => setTimeout(r, 250));
  const phase = { want, waitedMs: Date.now() - waitedAt, up: wantUp(),
    started: !!R.state?.started, loaderHidden: !!cls('loader')?.contains('hidden'), hudHidden: !!cls('hud')?.contains('hidden'),
    missionItems: document.querySelectorAll('#mission-list li').length };
  if (!phase.up) return JSON.stringify({ fail: `phase "${want}" never arrived`, phase }, null, 1);
  // The chase camera flies in from the boot pose, so a lens reading taken on the first frame after
  // the HUD appears describes a camera no player ever drives with (run #1 reported `camY 0.0` with
  // the rover at y 1.01 — an eye at ground level and the "horizon" pinned dead centre). Step until
  // the eye stops moving rather than until an arbitrary frame count, and report how long that took.
  // The drive phase skips this: it re-seats the rover on a lane and steps the camera onto it, so
  // the fly-in is settled by that move instead of by 120 frames of waiting the budget has no room for.
  const lens0 = () => { const c = R.camera(); return [+c.position.y.toFixed(3), +c.position.distanceTo(new c.position.constructor(0, c.position.y, 0)).toFixed(3)]; };
  let settleFrames = 0, prev = null;
  const stepAt = Date.now();
  if (Q?.step && want !== 'drive') {
    // 20 at a time, not 30: the whole probe is ONE Runtime.evaluate, and headless software GL runs
    // ~10x slower than the 14.97 ms real frame, so a long enough step loop makes CDP answer
    // `-32603 Internal error` and the run yields nothing at all. Two such crashes, both from the
    // frame count, so the budget is stated here rather than rediscovered later.
    for (let round = 0; round < 6; round++) {
      Q.step(20, 1000 / 60); settleFrames += 20;
      const now = lens0();
      if (prev && Math.abs(now[0] - prev[0]) < 0.01 && Math.abs(now[1] - prev[1]) < 0.05) break;
      prev = now;
    }
  }
  phase.settle = { frames: settleFrames, ms: Date.now() - stepAt };

  // ---- 4. 镜头构图：主体占比与地平线位置 -------------------------------------------------
  // Defined before the phase branches because both readings use it, and a reading that was taken by
  // a different function than the one documented here would not be the same measurement twice.
  const readLens = () => {
    try {
      const cam = R.camera(), P = R.phys();
      const V = cam.position.constructor;
      const pv = k => (Number.isFinite(P[k]) ? P[k] : Number.isFinite(P.pos?.[k]) ? P.pos[k] : null);
      if (pv('x') === null || pv('y') === null || pv('z') === null) throw new Error('phys pose fields: ' + Object.keys(P).slice(0, 12));
      const fwd = new V(0, 0, -1).applyQuaternion(cam.quaternion);
      const rp = new V(pv('x'), pv('y'), pv('z'));
      const ndc = v => v.clone().project(cam);
      // 主体高度占比：车体几何中点在屏幕上的跨度，用车的实际包围高度 1.6 m 折算
      const a0 = ndc(rp.clone()), a1 = ndc(rp.clone().add(new V(0, 1.6, 0)));
      // 地平线：沿视线方向 3 km 处、地面高度的那一点落在第几行
      const far = cam.position.clone().add(fwd.multiply(new V(3000, 3000, 3000))); far.y = 0;
      const fh = ndc(far);
      return {
        v: +(Number.isFinite(P.speed) ? P.speed : 0).toFixed(1), kmh: Math.round((P.speed || 0) * 3.6),
        fov: +cam.fov.toFixed(1),
        dist: +cam.position.distanceTo(rp).toFixed(1),
        camY: +cam.position.y.toFixed(2), subjY: +P.y.toFixed(2),
        sharePct: +(Math.abs(a1.y - a0.y) * 50).toFixed(2),
        horizonPct: +((0.5 - fh.y * 0.5) * 100).toFixed(1),
        gas: +R.input().gas.toFixed(2), rescue: R.state.rescue, fps: +R.state.fps.toFixed(1),
      };
    } catch (e) { return { fail: String(e).slice(0, 160) }; }
  };

  // A positive control for the composition ruler, and the reason it is not just a number: `sharePct`
  // is `project()` arithmetic times 50, and a wrong convention there (ndc y over -1..1 vs 0..1, or
  // an aspect baked into y) would silently scale every composition reading. The same span is
  // therefore recomputed from dot products against the camera's own basis — no projection matrix, no
  // three.js. Two algorithms on the same pose, and they disagree loudly if the ruler is broken.
  const rulerControl = () => {
    try {
      const cam = R.camera(), P = R.phys(), V = cam.position.constructor;
      const C = cam.position, q = cam.quaternion;
      const ax = new V(0, 0, -1).applyQuaternion(q), up = new V(0, 1, 0).applyQuaternion(q);
      const tan = Math.tan(cam.fov * Math.PI / 360);
      const ndcY = Q => { const d = Q.clone().sub(C); return (d.dot(up) / d.dot(ax)) / tan; };
      const rp = new V(P.x, P.y, P.z);
      const analyticPct = +((Math.abs(ndcY(rp.clone().add(new V(0, 1.6, 0))) - ndcY(rp))) * 50).toFixed(2);
      const projectPct = readLens().sharePct;
      return { projectPct, analyticPct, agrees: analyticPct > 0 && projectPct > 0
        && Math.abs(projectPct - analyticPct) / analyticPct < 0.05 };
    } catch (e) { return { fail: String(e).slice(0, 120) }; }
  };

  if (want === 'drive') {
    // WHAT THE CAMERA DOES TO THE SUBJECT AS THE PLAYER ACCELERATES — the single most load-bearing
    // composition number in the game, because the player spends the ride moving. Attribution lives in
    // `src/camera/chase.js`: `back = 9.6 + speed*0.16` dollies the rig away with speed while
    // `targetFov = 60 + speed*0.42` only opens 0.42°/m·s⁻¹, so the widening is outrun by the
    // retreat and the subject shrinks on the way up to speed. Measuring that needs a run, and the
    // run needs road: holding W at spawn pins the hull at z -24.07 after 1.9 m with gas at 1.00 (see
    // `spawnBlocker`), which measures a collision, not a camera. So the rig finds its own ≥30 m
    // straight, re-seats the rover at its head, and reads the lens the whole way up.
    const P = R.phys(), cols = R.colliders();          // [x, z, r, floor] — `floor` is a deck, not a wall
    const HALF = 1.35;                                  // hull half-width: a lane has to be drivable, not merely empty
    const clearance = (x, z, yaw) => {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      let best = 60;
      for (const [cx, cz, cr, f] of cols) {
        if (f !== 0) continue;
        const dx = cx - x, dz = cz - z, along = dx * fx + dz * fz;
        if (along <= 0 || along > best) continue;
        const lat = Math.abs(dx * fz - dz * fx);
        if (lat < cr + HALF) best = Math.min(best, along - (cr + HALF - lat) * 0.4);
      }
      return +best.toFixed(1);
    };
    let lane = null;
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      for (let r = 8; r <= 60 && !lane; r += 4) {
        for (let a = 0; a < 360 && !lane; a += 15) {
          const x = Math.round(Math.cos(a * Math.PI / 180) * r), z = Math.round(Math.sin(a * Math.PI / 180) * r);
          const c = clearance(x, z, yaw);
          if (c >= 30) lane = { x, z, yaw: +yaw.toFixed(3), clearM: c };
        }
      }
      if (lane) break;
    }
    const spawnBlocker = cols.filter(c => c[3] === 0 && Math.hypot(c[0] - P.x, c[1] - P.z) < 9 && c[1] - P.z > -1)
      .map(c => ({ d: +Math.hypot(c[0] - P.x, c[1] - P.z).toFixed(2), x: c[0], z: c[1], r: c[2] }))
      .sort((a, b) => a.d - b.d).slice(0, 4);
    const drive = { spawn: [+P.x.toFixed(1), +P.z.toFixed(1)], spawnBlocker, lane, ladder: [] };
    if (lane) {
      R.place(lane.x, lane.z, lane.yaw);
      Q.step(40, 1000 / 60);                            // let the rig land on the new pose first
      drive.atRest = readLens();
      const keys = R.input().keys;                       // `input: () => input.inp` — the object, not a namespace
      keys.add('KeyW');
      for (let i = 0; i < 20; i++) {
        Q.step(15, 1000 / 60);
        drive.ladder.push(readLens());
        const v = P.speed;
        // Stop on the way DOWN, not only on the way up. The lane is 31 m of clear road, and the
        // rover reaches it in ~2 s: without this the run keeps stepping into the far collider and
        // `top` reports a decelerating hull (sub-3 m/s, subjY 0.74 — the rover pitched against a
        // wall), which is the very sample the composition finding must NOT be built from.
        if (v >= 20) break;                              // 20 m/s = 72 km/h; the ceiling is 32
        if (i > 1 && v < drive.ladder[i - 1].v - 0.5 && drive.ladder[i].gas > 0.9) { drive.stalledOn = cols
            .filter(c => c[3] === 0 && Math.hypot(c[0] - P.x, c[1] - P.z) < c[2] + 2.2)
            .map(c => ({ d: +Math.hypot(c[0] - P.x, c[1] - P.z).toFixed(2), x: c[0], z: c[1], r: c[2] })); break; }
      }
      // The headline read is the fastest frame seen, wherever it fell in the run-up.
      drive.top = drive.ladder.reduce((b, x) => (x.v > (b?.v ?? -1) ? x : b), null);
      keys.delete('KeyW');
      Q.step(10, 1000 / 60);
      drive.released = readLens();
      // Cross-check the ruler with a second, independent geometry: an object of fixed height subtends
      // ∝ 1/(dist·tan(fov/2)), so the share ratio between the first and last sample has to match the
      // distance/fov ratio. Two algorithms agreeing is what makes "the subject halved" a measurement
      // rather than an artefact of how `sharePct` projects a point.
      const a = drive.ladder[0], b = drive.top;
      if (!a?.fail && !b?.fail) {
        const D2R = Math.PI / 180;
        drive.opticsCheck = {
          measuredShareRatio: +(b.sharePct / a.sharePct).toFixed(3),
          geometricRatio: +((a.dist / b.dist) * (Math.tan(a.fov * D2R / 2) / Math.tan(b.fov * D2R / 2))).toFixed(3),
        };
        drive.opticsCheck.agrees = Math.abs(drive.opticsCheck.measuredShareRatio - drive.opticsCheck.geometricRatio) < 0.12;
        // Split the loss between its two causes instead of blaming "the camera". A fixed-height object
        // subtends ∝ 1/(dist·tan(fov/2)), so the ratio factors exactly — and `opticsCheck` above is what
        // licenses that factorisation. Both terms shrink the subject: `chase.js:30` retreats the rig at
        // +0.16 m per m/s and `:74` opens the lens at 0.42°/m·s⁻¹. Which one to fix is a different
        // decision for 80/20 than for 20/80, so the numbers, not the prose, carry it.
        const D2R0 = Math.PI / 180;
        const distPart = a.dist / b.dist;
        const fovPart = Math.tan(a.fov * D2R0 / 2) / Math.tan(b.fov * D2R0 / 2);
        drive.shareAttribution = {
          totalPctLost: +((1 - b.sharePct / a.sharePct) * 100).toFixed(1),
          byRetreatingRigPct: +((1 - distPart) * 100).toFixed(1),
          byOpeningLensPct: +((1 - fovPart) * 100).toFixed(1),
          factorsInto: +(distPart * fovPart).toFixed(3),
        };
      }
    }
    drive.rulerControl = rulerControl();
    return JSON.stringify({ phase, lens: drive }, null, 1);
  }

  // ---- 1. 字体身份：设计的字体到底有没有落地 -------------------------------------------
  const faces = [];
  document.fonts.forEach(f => faces.push(`${f.family} ${f.weight} ${f.style} ${f.status}`));
  const mc = document.createElement('canvas').getContext('2d');
  const SAMPLE = 'RED STARBASE 火星 0123 · — →';
  const widthOf = font => { mc.font = `40px ${font}`; return +mc.measureText(SAMPLE).width.toFixed(2); };
  // 逐个本机候选比推进宽度；相等即"这串文本实际由该字体绘制"。
  const LOCAL = ['"DejaVu Sans Mono"', '"Liberation Mono"', '"Noto Sans Mono"', '"Noto Sans CJK SC"',
    '"Liberation Sans"', '"DejaVu Sans"', '"Noto Sans"', '"Ubuntu"', 'serif', 'system-ui'];
  const resolves = stack => {
    const w = widthOf(stack);
    const hit = LOCAL.filter(f => widthOf(f) === w);
    return { w, hit: hit.length ? hit : ['<none of the candidate list — some other local face>'] };
  };
  const cs = s => getComputedStyle(document.documentElement).getPropertyValue(s).trim();
  const monoStack = cs('--mono'), sansStack = cs('--sans');

  // ---- 2. 可见文本普查 ---------------------------------------------------------------
  const effOpacity = el => { let o = 1, n = el; while (n && n !== document.body) { o *= +getComputedStyle(n).opacity; n = n.parentElement; } return o; };
  // The frame is the box the document actually lays out in, NOT `innerWidth`. qa_boot.html
  // redefines `innerWidth`/`clientWidth` to 889×967 so the renderer allocates a known buffer, but
  // that lie only reaches JS — the browser still lays the document out in its real window (here
  // 1000×923), and `getBoundingClientRect` is in that space. Comparing the two dropped the whole
  // speedometer (`#speed-val` at x 936) as "offscreen" and made the type ladder look like it
  // stopped at 14 px. A ruler whose frame is 111 px narrower than the page reads exactly like a HUD
  // with no hierarchy. `body` is `width/height:100%` of the initial containing block, so its own box
  // is the layout viewport; the canvas is excluded as an anchor because `setSize()` pins its inline
  // width to the faked number.
  const bodyRect = document.body.getBoundingClientRect();
  const FRAME = { w: Math.round(bodyRect.width) || innerWidth, h: Math.round(bodyRect.height) || innerHeight };
  const inView = r => r.right > 0 && r.bottom > 0 && r.left < FRAME.w && r.top < FRAME.h;
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  const rgba = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))).toFixed(2); };
  const PAGE_BG = { r: 5, g: 4, b: 10, a: 1 };
  const stackBg = el => { let bg = PAGE_BG, n = el; while (n && n !== document.body) { const c = rgba(getComputedStyle(n).backgroundColor); if (c && c.a > 0.02) bg = over(c, bg); n = n.parentElement; } return bg; };

  const rows = [];
  // Why an element was left out has to be as countable as what went in. A census that silently
  // under-counts reads exactly like a sparser HUD: run #1 reported a type ladder topping out at
  // 14 px, and the 52 px `#speed-val` was missing from it — not because it is hidden, but because
  // the ruler's frame was wrong (see FRAME). Without `skip{}` and `selfCheck` below, that reads as
  // a finding about the game.
  const skip = { noText: 0, notRendered: 0, faint: 0, tooSmall: 0, offscreen: 0 };
  for (const el of document.querySelectorAll('body *')) {
    const t = ownText(el); if (!t) { skip.noText++; continue; }
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.visibility === 'collapse') { skip.notRendered++; continue; }
    const op = effOpacity(el); if (op < 0.05) { skip.faint++; continue; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { skip.tooSmall++; continue; }
    if (!inView(r)) { skip.offscreen++; continue; }
    const fs2 = +parseFloat(st.fontSize).toFixed(1);
    const ls = st.letterSpacing === 'normal' ? 0 : +parseFloat(st.letterSpacing).toFixed(2);
    const box = { id: el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase()) };
    rows.push({
      el: box.id, txt: t.slice(0, 14), fs: fs2, lsPx: ls,
      lsEm: +(ls / fs2).toFixed(3), fam: st.fontFamily.split(',')[0].replace(/["']/g, ''),
      weight: st.fontWeight, col: st.color, op: +op.toFixed(2),
      // `background-clip:text` with `color:transparent` is the one case where the computed colour is
      // a lie: `.title` is painted from a #fff3e0→#ff9a3c gradient, but its `color` is rgba(0,0,0,0),
      // which WCAG-scores 1.03 against anything. That is a blind ruler, not a contrast failure, so it
      // gets labelled rather than reported as a number.
      cr: (rgba(st.color)?.a === 0 && /text/.test(st.webkitBackgroundClip || '')) ? 'n/a gradient text'
        : ratio(rgba(st.color) || { r: 255, g: 255, b: 255, a: 1 }, stackBg(el)),
      areaPct: +(r.width * r.height / (FRAME.w * FRAME.h) * 100).toFixed(3),
    });
  }
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null;
  const textArea = rows.reduce((s, x) => s + x.areaPct, 0);
  const ladder = {}; rows.forEach(x => ladder[x.fs] = (ladder[x.fs] || 0) + 1);
  const fsList = Object.keys(ladder).map(Number).sort((a, b) => a - b);
  const tiny = rows.filter(x => x.fs < 11);
  const wide = rows.filter(x => x.lsEm >= 0.15);
  const scored = rows.filter(x => typeof x.cr === 'number');
  const lowC = scored.filter(x => x.cr < 4.5);

  // ---- 3. 面板盒子：有多少画面被"容器"占住，而不是被世界占住 ------------------------------
  let boxes = [], boxArea = 0;
  for (const el of document.querySelectorAll('body *')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || effOpacity(el) < 0.05) continue;
    const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 14 || !inView(r)) continue;
    const bgc = rgba(st.backgroundColor);
    const hasBg = !!(bgc && bgc.a > 0.03);
    const hasBorder = ['top', 'right', 'bottom', 'left'].some(s => parseFloat(st['border' + s[0].toUpperCase() + s.slice(1) + 'Width']) > 0 && (rgba(st['border' + s[0].toUpperCase() + s.slice(1) + 'Color']) || { a: 0 }).a > 0.05);
    const blur = st.backdropFilter && st.backdropFilter !== 'none';
    if (!hasBg && !hasBorder && !blur) continue;
    const a = r.width * r.height / (FRAME.w * FRAME.h) * 100;
    if (a > 0.25) { boxArea += a; boxes.push({ el: el.id ? '#' + el.id : el.tagName.toLowerCase(), pct: +a.toFixed(2), bg: hasBg, border: hasBorder, blur, radius: st.borderRadius }); }
  }
  boxes.sort((a, b) => b.pct - a.pct);

  // ---- 4b. 静止构图（本 phase 的镜头读数；行驶档的完整加速阶梯在 `?audstate=drive`）------
  // An at-rest number taken where the game parks the player, which is the frame the boot screen
  // hands over. It is deliberately not called "the driving lens": the spawn is walled in 4.9 m
  // ahead, so a W-hold from here reads a collision. The driving ladder is a separate phase with its
  // own frame budget, and this phase spends its frames on the census instead.
  const lensAtRest = readLens();
  const lensControl = rulerControl();

  // ---- 2b. 设计阶梯 vs 可见阶梯 ---------------------------------------------------------
  // The census above only sees what is on screen right now, so it cannot tell "the HUD has no
  // hierarchy" apart from "the hierarchy exists but lives behind a screen the player passes once".
  // Reading the parsed stylesheet gives the *authored* scale, and the two ladders side by side are
  // the difference: a 150 px `#countdown` in the CSS is a font size, a 150 px `#countdown` in
  // `rows` is part of the game's typography.
  const authored = { fontSize: {}, letterSpacing: {} };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }  // cross-origin: not ours
    for (const r of rules) {
      if (!r.selectorText) continue;
      for (const prop of ['fontSize', 'letterSpacing']) {
        const v = r.style[prop];
        if (v) (authored[prop][v] ||= []).push(r.selectorText);
      }
    }
  }

  // A positive control for the census itself: these elements are known to be on screen with known
  // sizes, so if any of them is missing from `rows` the ruler is broken, not the HUD sparse.
  const selfCheck = {};
  for (const id of ['speed-val', 'speed-unit', 'mission-panel', 'tel-met', 'battery-pct']) {
    const el = document.getElementById(id);
    if (!el) { selfCheck[id] = 'absent from DOM'; continue; }
    const st = getComputedStyle(el), r = el.getBoundingClientRect();
    selfCheck[id] = {
      inRows: rows.some(x => x.el === '#' + id), fs: st.fontSize, op: +effOpacity(el).toFixed(2),
      rect: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)],
      ownText: ownText(el).slice(0, 8), parentDisplay: getComputedStyle(el.parentElement).display,
    };
  }

  return JSON.stringify({
    frame: { laid: [FRAME.w, FRAME.h], innerWidth: [innerWidth, innerHeight],
      canvas: (r => [Math.round(r.width), Math.round(r.height)])(document.getElementById('scene').getBoundingClientRect()),
      visualViewport: [Math.round(visualViewport.width), Math.round(visualViewport.height)], dpr: devicePixelRatio },
    phase,
    census: { scanned: skip.noText + skip.notRendered + skip.faint + skip.tooSmall + skip.offscreen + rows.length, skip },
    selfCheck,
    fonts: {
      loadedFaces: faces.length, faces: faces.slice(0, 8),
      monoStack, monoResolves: resolves(monoStack),
      sansStack, sansResolves: resolves(sansStack),
      titleResolves: resolves(getComputedStyle(document.querySelector('.title') || document.body).fontFamily),
    },
    type: {
      visibleTextNodes: rows.length,
      ladder, min: fsList[0], max: fsList[fsList.length - 1],
      ratioMaxMin: fsList.length ? +(fsList[fsList.length - 1] / fsList[0]).toFixed(1) : null,
      under11: { n: tiny.length, pct: +(tiny.length / Math.max(1, rows.length) * 100).toFixed(1) },
      tracked15: { n: wide.length, pct: +(wide.length / Math.max(1, rows.length) * 100).toFixed(1) },
      textCoveragePct: +textArea.toFixed(2),
      contrast: { below45: lowC.length, scored: scored.length, unscored: rows.length - scored.length,
        min: scored.length ? Math.min(...scored.map(x => x.cr)) : null,
        worst: scored.slice().sort((a, b) => a.cr - b.cr).slice(0, 5).map(x => `${x.el}:${x.txt}=${x.cr}`) },
    },
    panels: { count: boxes.length, coveragePct: +boxArea.toFixed(2), top: boxes.slice(0, 8) },
    authoredScale: {
      fontSize: Object.entries(authored.fontSize).map(([v, sel]) => ({ v, n: sel.length, e: sel.slice(0, 2) }))
        .sort((a, b) => parseFloat(b.v) - parseFloat(a.v)),
      letterSpacingCount: Object.keys(authored.letterSpacing).length,
    },
    lens: { atRest: lensAtRest, rulerControl: lensControl, drivePhase: 'run with ?audstate=drive — one evaluate cannot carry both frame budgets' },
    sample: rows.slice(0, 26),
  }, null, 1);
})();
