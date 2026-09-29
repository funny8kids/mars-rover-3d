// 【E】1 远景那一格：沙暴在页面上到底"动了哪些东西"—— 用图自证，不靠正则猜名字
//
//   node tools/cdp-run.mjs http://127.0.0.1:8080/qa_boot.html?auto=std tools/storm-visual-apparatus.js
//
// 上一条消融（藏掉 18 件"看起来像沙尘"的东西）没打到尘墙：隐藏名单里只有 `Points` 与几件误伤的管子。
// 所以先把"晴 → 埋身暴"之间**真的变了的东西**枚举出来：对象自身的（visible / opacity / color / scale）
// 与着色器 uniform 里的（含 `storm`/`uStorm`/`density` 之类键）。两批快照一 diff，消融就有名字了。
(async () => {
  const R = window.__RSB;
  const scene = R.scene();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const st = () => (R.env().state || {});
  const pump = async (n, want) => { for (let i = 0; i < n; i++) { R.frame(0.05); if (want && want(st())) return i + 1; } return n; };
  const sig = () => {
    const objs = new Map(), uni = new Map();
    scene.traverse(o => {
      if (o === scene) return;
      const key = `${o.type}#${o.name || '(anon)'}#${o.id}`;
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      const m0 = mats[0];
      objs.set(key, { visible: !!o.visible, op: m0 ? +m0.opacity.toFixed(3) : null,
        transparent: m0 ? !!m0.transparent : null, col: m0 && m0.color ? m0.color.getHexString() : null,
        sy: +o.scale.y.toFixed(3), posy: +o.position.y.toFixed(2) });
      for (const m of mats) if (m && m.uniforms) for (const k of Object.keys(m.uniforms)) {
        const v = m.uniforms[k].value;
        if (typeof v === 'number' && /storm|haze|dust|fog|veil|opacity|amount/i.test(k)) {
          uni.set(`${(o.name || m0 && m0.name) || o.type}.${k}`, +v.toFixed(4));
        }
      }
    });
    return { objs, uni, fog: scene.fog ? { density: +scene.fog.density.toFixed(6), hex: scene.fog.color.getHexString() } : null };
  };
  const out = { cam: 'no frames taken — this probe names objects, the picture is the next step' };
  R.clearSky(); R.setDay(0.46);
  await pump(140, s => (s.stormF ?? 1) <= 0.02);
  const calm = sig();
  R.pinStorm('peak', -120, 0);
  await pump(320, s => (s.stormF ?? 0) >= 0.97);
  const busy = sig();
  out.stormF = { calm: +(st().stormF ?? -1).toFixed(3) };
  out.fog = { calm, busy };
  const changedObj = [], changedUni = [];
  for (const [k, v] of busy.objs) {
    const c = calm.objs.get(k);
    if (!c) { changedObj.push(`${k} NEW ${JSON.stringify(v)}`); continue; }
    const diff = Object.keys(v).filter(f => JSON.stringify(v[f]) !== JSON.stringify(c[f]));
    if (diff.length) changedObj.push(`${k} ${diff.map(f => `${f}:${c[f]}->${v[f]}`).join(' ')}`);
  }
  for (const [k, v] of busy.uni) { const c = calm.uni.get(k); if (c === undefined || Math.abs(v - c) > 1e-4) changedUni.push(`${k} ${c === undefined ? '(absent)' : c} -> ${v}`); }
  for (const [k, v] of calm.uni) if (!busy.uni.has(k)) changedUni.push(`${k} 消失（暴里没有这个键）`);
  out.changed_objects = changedObj.slice(0, 40);
  out.changed_object_count = changedObj.length;
  out.changed_uniforms = changedUni.slice(0, 40);
  out.changed_uniform_count = changedUni.length;
  out.objects_total = { calm: calm.objs.size, busy: busy.objs.size };
  R.clearSky();
  return out;
})()
