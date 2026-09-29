(async () => {
  const R = window.__RSB;
  const cam = R.camera();
  const scene = R.scene();
  // crane meshes, found by material exactly as the offline checker does it
  const parts = [];
  scene.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some(m => m && /overhead_crane/.test(m.name || ''))) parts.push(o);
  });
  // world-space AABB of the crane from its own vertices (no THREE in this page)
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const o of parts) {
    const p = o.geometry.attributes.position, e = o.matrixWorld.elements;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const w = [
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14]];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
  }
  const inv = cam.matrixWorldInverse.elements, pr = cam.projectionMatrix.elements;
  const mul = (m, v) => {
    const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
    return [(m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12]) / w,
            (m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13]) / w, w];
  };
  const frac = () => {
    // hFrac/wFrac over the crane's 8 box corners, the same口径 as tools/cdp-subject-fraction-probe.mjs
    let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, behind = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      const n = mul(inv, [a ? hi[0] : lo[0], b ? hi[1] : lo[1], c ? hi[2] : lo[2]]);
      if (n[2] > 0) { behind++; continue; }
      const q = mul(pr, [n[0], n[1], n[2]]);
      minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]);
      minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
    }
    return { hFrac: +((maxY - minY) / 2).toFixed(3), wFrac: +((maxX - minX) / 2).toFixed(3), behind };
  };
  const subject = [+((lo[0] + hi[0]) / 2).toFixed(1), +((lo[1] + hi[1]) / 2).toFixed(1), +((lo[2] + hi[2]) / 2).toFixed(2)];
  const out = [];
  const shots = [
    ['crane-1-avenue-day', 62, 104, 9.3, false],
    ['crane-2-close-day', 44, 96, 9.3, false],
    ['crane-3-under-hook', 62, 88, 10.5, false],
    ['crane-4-avenue-skyreal', 62, 104, 9.3, true],
  ];
  for (const [name, vx, vz, lookY, realSky] of shots) {
    const g = R.ground(vx, vz);
    const at = [vx, (g && g.stand != null ? g.stand : 2) + 1.6, vz];
    const look = [62, lookY, 76];
    const r = await R.shot(name, at, look, realSky ? null : [-150, 120, 95]);
    out.push({ name, vantage_ground: g, at: at.map(v => +v.toFixed(2)), look,
      clip: r.clip, burn: r.burn, bins: r.bins, key: r.key, status: r.status, subj: frac() });
  }
  return JSON.stringify({ crane_meshes: parts.length, crane_world_box: { lo: lo.map(v => +v.toFixed(2)), hi: hi.map(v => +v.toFixed(2)) }, subject_centre: subject, fov: +cam.fov.toFixed(2), aspect: +cam.aspect.toFixed(3), frames: out }, null, 1);
})()
