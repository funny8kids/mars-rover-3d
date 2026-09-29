// 【E】1 远景那一格的第三刀：把 `uStorm` 这条分级**中和写手**，而不是改它的输出值。
//
// 前两刀的教训：① `scene.fog.density = 0.0014` 会被每帧重写（den_at_shot 0.00701）——只有让写手看不见
// 目标（`scene.fog = null`）才算真消融；② 拿正则藏"像沙尘的名字"打不到东西，因为沙暴动的是 uniform。
// 所以这一刀用 `Object.defineProperty` 把 uniform 对象的 `value` 换成一个**吞写入的 getter(=0)**：
// 写手照样跑，但它写不进去了。打到了什么，全部打印出来（对象名 + 件数），0 件就是这条没打到东西。
(async () => {
  const R = window.__RSB, scene = R.scene(), CAM = [-26, 3, 34], LOOK = [0, 1.6, -46];
  const st = () => (R.env().state || {});
  const pump = async (n, want) => { for (let i = 0; i < n; i++) { R.frame(0.05); if (want && want(st())) return i + 1; } return n; };
  R.clearSky(); R.setDay(0.46);
  await pump(140, s => (s.stormF ?? 1) <= 0.02);
  R.pinStorm('peak', -120, 0);
  await pump(320, s => (s.stormF ?? 0) >= 0.97);
  const hits = [], undo = [];
  scene.traverse(o => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      const u = m && m.uniforms && m.uniforms.uStorm;
      if (!u) continue;
      hits.push(`${o.type}#${o.name || '(anon)'}.${m.name || '(mat)'}`);
      undo.push([u, Object.getOwnPropertyDescriptor(u, 'value')]);
      Object.defineProperty(u, 'value', { configurable: true, get: () => 0, set: () => {} });
    }
  });
  // 自证：中和之后写手再跑一帧，读回来必须是 0（否则这条消融没生效）
  await pump(3);
  const still = hits.length ? (() => { const probe = []; scene.traverse(o => { const m = o.material && !Array.isArray(o.material) ? o.material : null; if (m && m.uniforms && m.uniforms.uStorm) probe.push(+m.uniforms.uStorm.value.toFixed(3)); }); return probe.slice(0, 6); })() : [];
  const s = await Promise.race([R.shot('fd1-storm-uStorm-zeroed', CAM, LOOK, null), new Promise(r => setTimeout(() => r(null), 9000))]);
  for (let i = undo.length - 1; i >= 0; i--) { const [u, d] = undo[i]; if (d) Object.defineProperty(u, 'value', d); }
  R.clearSky();
  return { stormF: +(st().stormF ?? -1).toFixed(3), zeroed_materials: hits.length, names: hits.slice(0, 8),
    readback_after_writer: still, clip: s ? s.clip : null, bin0: s ? s.bins[0] : null, status: s ? s.status : 'TIMEOUT' };
})()
