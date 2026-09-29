// In-page probe for task #70: why is near-field gravel unreadable at driving height?
// Run through tools/cdp-run.mjs. Measures, at the REAL chase-camera pose:
//  (a) stone screen-space height in px and above-ground height in m, near field
//  (b) which LOD level each tile within 60 m currently renders at
//  (c) shadow flags on the stone meshes and the key light
//  (d) stone instance-colour luminance vs terrain vertex-tint luminance
//  (e) per-stone albedo/normal-contrast proxies (instance colour spread, geometry normals)
(async () => {
  const R = window.__RSB;
  const cam = R.camera(), scene = R.scene();
  let field = null;
  scene.traverse(o => { if (o.name === 'stone-field') field = o; });
  if (!field) return { err: 'no stone-field' };

  // --- pick a gravel tile away from the pads, place the rover 8 m radially out, facing it
  const V = cam.position.constructor;
  const cands = field.children.map(l => {
    const p = l.position; const r = Math.hypot(p.x, p.z);
    return { l, r, p };
  }).filter(c => c.r > 55 && c.r < 100);
  cands.sort((a, b) => b.l.children[0].count - a.l.children[0].count); // densest tile
  const t = cands[0];
  const dirx = t.p.x / t.r, dirz = t.p.z / t.r;
  const rx = t.p.x + dirx * 8, rz = t.p.z + dirz * 8;
  const yaw = Math.atan2(t.p.x - rx, t.p.z - rz);
  const placed = R.place(rx, rz, yaw);
  for (let i = 0; i < 240; i++) R.frame(1 / 60);   // let the chase rig settle and draw the field
  scene.updateMatrixWorld(true);
  cam.updateMatrixWorld(true);

  // --- ground truth height under each stone, from the drawn terrain mesh itself
  let terrain = null;
  scene.traverse(o => { if (!terrain && o.name === 'terrain') terrain = o; });
  function groundAt(x, z) {
    const g = terrain.geometry, pos = g.attributes.position, idx = g.index;
    let best = null, bd = 1e9;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - x, dz = pos.getZ(i) - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = pos.getY(i); }
    }
    return best;
  }

  // --- project a world point to device px
  const pr = new V();
  const devH = R.shot ? null : null;
  const cv = document.querySelector('canvas');
  const px = (wx, wy, wz) => {
    pr.set(wx, wy, wz).project(cam);
    return [ (pr.x * 0.5 + 0.5) * cv.width, (-pr.y * 0.5 + 0.5) * cv.height ];
  };

  const pitch = new V(0, 0, -1);
  const out = { camera: { pos: [cam.position.x, cam.position.y, cam.position.z].map(v => +v.toFixed(2)),
      pitchDeg: +(Math.asin(cam.getWorldDirection(pitch).y) * 57.3).toFixed(1) },
    canvas: [cv.width, cv.height], fov: cam.fov };

  const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(3); };

  // geometry identity: detail 1 has 80 tris, detail 0 has 20
  const triCount = m => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  const mI = field.children[0].children[0].matrixWorld.constructor; // a Matrix4 to reuse
  const mWorld = new mI(), mTmp = new mI();

  const lumsStone = [], lumsGround = [];
  const pxH = [], mH = [], width = [], buried = [];
  let nearStones = 0, nearMeasured = 0;
  const tiles = [];

  for (const lod of field.children) {
    const wp = new V(); lod.getWorldPosition(wp);
    const d = wp.distanceTo(cam.position);
    if (d > 60) continue;
    const lvl = lod.getCurrentLevel();
    const mesh = lod.levels[lvl].object;
    const tris = triCount(mesh);
    tiles.push({ d: +d.toFixed(1), level: lvl, tris, n: mesh.count });
    nearStones += mesh.count;
    // 上一版在这里写的是 `if (lvl !== 0) continue`，而 baseline 的自相矛盾就是它留下的：
    // `stonesNearDetail0 713` 与 `near25m.count 0` 同时成立，说明 713 个实例正好全被这一行跳过 ——
    // 也就是说近瓦片报的 `getCurrentLevel()` 并不是 0（这游戏的 LOD 不是裸 THREE.LOD 语义）。
    // 判据应该按距离收，而不是按一个没验证过的 level 编号收。
    if (d > 25) continue; // 近景这一档才是投诉对象：量 25 m 内的瓦片
    nearMeasured += mesh.count;
    mesh.computeBoundingSphere();
    lod.updateWorldMatrix(true, false);
    // geometry bbox once
    const bb = mesh.geometry.boundingBox || (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox);
    const corners = [];
    for (const sx of [bb.min.x, bb.max.x]) for (const sy of [bb.min.y, bb.max.y]) for (const sz of [bb.min.z, bb.max.z])
      corners.push([sx, sy, sz]);
    // This three.js build hangs `instanceColor` as the InstancedBufferAttribute itself, so the
    // earlier `instanceColor.attributes.instanceColor` read found nothing and `lumStone` printed
    // null for both baseline runs — the contrast half of the "near gravel is unreadable" complaint
    // had no number against it. Accept either shape.
    const ic = mesh.instanceColor;
    const cAttr = ic && (ic.attributes ? ic.attributes.instanceColor : ic);
    const r2 = (d0) => d0 * d0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, mTmp);
      mWorld.multiplyMatrices(lod.matrixWorld, mTmp);
      const e = mWorld.elements;
      let ymax = -1e9, ymin = 1e9, cxz = new V(), xzmax = 0;
      for (const c of corners) {
        const wx = e[0]*c[0] + e[4]*c[1] + e[8]*c[2] + e[12];
        const wy = e[1]*c[0] + e[5]*c[1] + e[9]*c[2] + e[13];
        const wz = e[2]*c[0] + e[6]*c[1] + e[10]*c[2] + e[14];
        ymax = Math.max(ymax, wy); ymin = Math.min(ymin, wy);
        cxz.x += wx / 8; cxz.z += wz / 8;
      }
      for (const c of corners) {
        const wx = e[0]*c[0] + e[4]*c[1] + e[8]*c[2] + e[12];
        const wz = e[2]*c[0] + e[6]*c[1] + e[10]*c[2] + e[14];
        xzmax = Math.max(xzmax, Math.hypot(wx - cxz.x, wz - cxz.z));
      }
      const dc = Math.hypot(cxz.x - cam.position.x, cxz.z - cam.position.z);
      if (dc > 25) continue;
      const g = groundAt(cxz.x, cxz.z);
      const above = ymax - g;
      const pTop = px(cxz.x, ymax, cxz.z), pBot = px(cxz.x, Math.min(g, ymax), cxz.z);
      pxH.push(Math.abs(pTop[1] - pBot[1]));
      mH.push(above); width.push(2 * xzmax);
      buried.push(+(ymin < g ? (g - ymin) / Math.max(1e-6, ymax - ymin) : 0).toFixed(2));
      if (cAttr) {
        const l = 0.2126 * cAttr.getX(i) + 0.7152 * cAttr.getY(i) + 0.0722 * cAttr.getZ(i);
        lumsStone.push(l);
      }
    }
  }

  // ground vertex tint near the rover (the terrain's own per-vertex color attr)
  {
    const ca = terrain.geometry.attributes.color;
    if (ca) for (let i = 0; i < ca.count; i++) {
      const x = terrain.geometry.attributes.position.getX(i), z = terrain.geometry.attributes.position.getZ(i);
      if (Math.hypot(x - cam.position.x, z - cam.position.z) < 25)
        lumsGround.push(0.2126 * ca.getX(i) + 0.7152 * ca.getY(i) + 0.0722 * ca.getZ(i));
    }
  }

  const sun = { };
  scene.traverse(o => { if (o.isDirectionalLight && !sun.name) {
    sun.name = o.name || 'key'; sun.castShadow = o.castShadow;
    sun.mapSize = [o.shadow.mapSize.x, o.shadow.mapSize.y];
    sun.cam = [o.shadow.camera.left, o.shadow.camera.right, o.shadow.camera.near, o.shadow.camera.far];
    sun.intensity = +o.intensity.toFixed(2);
  } });
  const anyMesh = field.children[0].children[0];

  out.result = {
    // The placement loop's own report card. `createStones` chases `count` stones under a rejection
    // budget, so a widened rejection (graded ground now turns away pad aprons and road batters too)
    // could quietly ship a thinner field; this is the reader that makes that visible.
    fieldPlaced: field.userData.placed ?? null, fieldTried: field.userData.tried ?? null,
    placedSum: field.children.reduce((a, lod) => a + (lod.children[0]?.count ?? 0), 0),
    placed, tileCountNear: tiles.length,
    tilesWithin25m: tiles.filter(t0 => t0.d <= 25).length,
    stonesNearMeasured: nearMeasured,
    lodDistanceToDetail0: +(field.children.length ? Math.min(...field.children.map(l => { const w = new V(); l.getWorldPosition(w); return w.distanceTo(cam.position); })) : 0).toFixed(1),
    detailTris: { level0: triCount(field.children[0].children[0]), level1: triCount(field.children[0].children[1]) },
    stoneLodThresholds: field.children[0].levels.map(l => l.distance),
    shadowFlags: { instancedMesh: { cast: anyMesh.castShadow, receive: anyMesh.receiveShadow },
      smoothNormals: !!field.children[0].children[0].geometry.attributes.normal, sun },
    near25m: { count: pxH.length,
      widthM: { p10: q(width, .1), p50: q(width, .5), p90: q(width, .9) },
      aboveGroundM: { p10: q(mH, .1), p50: q(mH, .5), p90: q(mH, .9) },
      screenPxHeight: { p10: q(pxH, .1), p50: q(pxH, .5), p90: q(pxH, .9) },
      buriedFrac: { p50: q(buried, .5), p90: q(buried, .9) },
      stonesUnder3px: pxH.filter(v => v < 3).length, stonesUnder6px: pxH.filter(v => v < 6).length },
    lumStone: { p10: q(lumsStone, .1), p50: q(lumsStone, .5), p90: q(lumsStone, .9) },
    lumGround: { p10: q(lumsGround, .1), p50: q(lumsGround, .5), p90: q(lumsGround, .9) },
  };
  return out;
})()
