// 【E】1 远景那一格：第二次消融，打在**有名字的地方**
//
// 上一条探针（tools/storm-visual-apparatus.js）给出关键事实：晴→暴在页面图里几乎不动物件，
// 动的是 uniform —— `Mesh.uStorm 0→0.9286`、`Mesh.uFogDen 0.0014→0.0068`、**`rim-veil.uFogDen 0.0014→0.0068`**。
// 也就是说那面"墙"是 `rim-veil`（src/world/rim_veil.js），而第一次消融用 visible=false 去藏"像沙尘的名字"，
// 根本没碰到它（名单里只有 5 个 Points 与几根被误伤的管子）。这次按名字来：
//   A) 藏掉整个 `rim-veil` 子树（自证：打印子树里 mesh/points 的件数，0 件即这条没打到东西）
//   B) 只把雾密度按回晴空的 0.0014（与第一次的"摘掉整条 fog"不同：fog 还在，只是不加厚）
// 机位与 fb1-calm / fb2-storm 完全一致，量具还是 tools/storm-ground-detail.py（砂纹带，三条对照全绿）。
(async () => {
  const R = window.__RSB;
  const CAM = [-26, 3, 34], LOOK = [0, 1.6, -46];
  const scene = R.scene();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const st = () => (R.env().state || {});
  const pump = async (n, want) => { for (let i = 0; i < n; i++) { R.frame(0.05); if (want && want(st())) return i + 1; } return n; };
  const out = { cam: CAM, look: LOOK, dayT: 0.46, shots: [] };
  const grab = async (name, note, extra) => {
    const s = await Promise.race([R.shot(name, CAM, LOOK, null), sleep(9000).then(() => null)]);
    out.shots.push(Object.assign({ name, note, stormF: +(st().stormF ?? -1).toFixed(3),
      fogDen: scene.fog ? +scene.fog.density.toFixed(5) : null, clip: s ? s.clip : null,
      bin0: s ? s.bins[0] : null, status: s ? s.status : 'TIMEOUT' }, extra || {}));
  };
  R.clearSky(); R.setDay(0.46);
  await pump(140, s => (s.stormF ?? 1) <= 0.02);
  R.pinStorm('peak', -120, 0);
  await pump(320, s => (s.stormF ?? 0) >= 0.97);
  const veil = scene.getObjectByName('rim-veil');
  out.rim_veil_found = !!veil;
  if (veil) {
    const kids = []; veil.traverse(o => kids.push(o));
    out.rim_veil_nodes = kids.length;
    out.rim_veil_hidden_nodes = kids.filter(o => o.visible).length;
    veil.visible = false;
    await pump(6);
    await grab('fc1-storm-no-veil', 'ablation: rim-veil subtree hidden', { veilNodes: kids.length });
    veil.visible = true;
  } else {
    out.rim_veil_err = 'no object named rim-veil in the live scene graph';
  }
  await pump(4);
  const calmDen = 0.0014, was = scene.fog ? scene.fog.density : null;
  if (scene.fog) scene.fog.density = calmDen;
  await pump(6);
  await grab('fc2-storm-fog-at-calm', 'ablation: fog kept, density pinned to calm 0.0014', { restored: was });
  if (scene.fog && was != null) scene.fog.density = was;
  R.clearSky();
  return out;
})()
