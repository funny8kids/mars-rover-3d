// 【E】1 远景那一格第一次上 ablation：地平线一带被谁吃掉？
// 同一个机位（抄 tools/storm-hue-probe.js 的 CAM/LOOK，与已归档的 e1c-* 帧同取景）、同一个 dayT，
// 四张帧一次跑完：晴空 / 埋身暴 / 埋身暴去掉 scene.fog / 埋身暴去掉沙尘物件。
// 每条消融都自证"真的动到了东西"：fog 移除前后打印 fog 对象，隐藏沙尘时打印被隐藏的物件数与名字，
// 数为 0 就是这条消融没打到任何东西 —— 那它的读数不能当归因用。
(async () => {
  const R = window.__RSB;
  const CAM = [-26, 3, 34], LOOK = [0, 1.6, -46];
  const scene = R.scene();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const st = () => (R.env().state || {});
  const pump = async (n, want) => {
    for (let i = 0; i < n; i++) { R.frame(0.05); if (want && want(st())) return i + 1; }
    return n;
  };
  const out = { cam: CAM, look: LOOK, dayT: 0.46, shots: [] };
  const grab = async (name, note) => {
    const s = await Promise.race([R.shot(name, CAM, LOOK, null), sleep(9000).then(() => null)]);
    out.shots.push({ name, note, stormF: +(st().stormF ?? -1).toFixed(3),
      fog: scene.fog ? `${scene.fog.type}:${(+scene.fog.density).toFixed(5)}` : null,
      clip: s ? s.clip : null, bin0: s ? s.bins[0] : null, status: s ? s.status : 'TIMEOUT' });
    return s;
  };
  R.clearSky(); R.setDay(0.46);
  await pump(120, s => (s.stormF ?? 1) <= 0.02);
  await grab('fb1-calm', 'reference');
  R.pinStorm('peak', -120, 0);
  const waited = await pump(320, s => (s.stormF ?? 0) >= 0.97);
  out.storm_wait_frames = waited;
  await grab('fb2-storm', 'buried, as shipped');
  // ① 摘掉 scene.fog
  const fog = scene.fog;
  scene.fog = null;
  await pump(6);
  await grab('fb3-storm-nofog', 'ablation: scene.fog = null');
  scene.fog = fog;
  // ② 藏掉沙尘/雾墙类物件（名字要打印出来，0 个就是没打到）
  const hidden = [];
  scene.traverse(o => {
    if (o === scene) return;
    const n = (o.name || '') + ' ' + (o.type || '');
    if (/storm|dust|sand|sheet|wall|slab|particle|Points|Sprite/i.test(n) && o.visible) { o.visible = false; hidden.push(o.name || o.type); }
  });
  out.hidden_objects = hidden.length;
  out.hidden_names = hidden.slice(0, 12);
  await pump(6);
  await grab('fb4-storm-nodust', `ablation: ${hidden.length} dust/wall objects hidden`);
  for (const o of scene.children) void o;
  scene.traverse(o => { if (hidden.includes(o.name) || hidden.includes(o.type)) o.visible = true; });
  return out;
})()
