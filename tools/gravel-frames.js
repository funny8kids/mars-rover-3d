// Frame capture for task #70: does the re-seated gravel actually read as rocks at driving height?
// Run through tools/cdp-run.mjs. Nothing here judges the picture — it only produces the frames and
// reports the lighting that produced them, which the clip sweep then reads.
//
// The sky has to be pinned before the FIRST frame is drawn: shot() parks the key light at its own
// default and leaves intensity to the game clock, so an unpinned shot is a sunlit frame wearing the
// clock's number. `nightF` is a smoothed follower, not a setpoint, so the settle loop and its
// `pumped > 0` check are copied from the shipping ruler (cdp-clip-sweep.mjs:149-166) rather than
// reinvented here — and the readouts come from `R.env()`, not `R.state`, which is the sim's own
// state object and has no `nightF` on it.
(async () => {
  const R = window.__RSB;
  R.clearSky(); R.setDay(0.30);
  let prev = -1, pumped = 0, nf = 0, sun = -1;
  for (let k = 0; k < 400; k++) {
    R.frame(0.05); pumped++;
    const e = R.env();
    nf = +((e.state || {}).nightF ?? -1).toFixed(4);
    const s = e.sun ? +e.sun.intensity.toFixed(3) : -1;
    if (prev === nf && s === sun) break;
    prev = nf; sun = s;
  }
  R.setDay(0.30); R.frame(0.05);
  const e = R.env(), st = e.state || {};
  const key = (() => { let k = null; R.scene().traverse(o => { if (!k && o.isDirectionalLight) k = o; }); return k; })();
  const sky = { pumped, nightF: st.nightF ?? null, dayF: st.dayF ?? null, duskF: st.duskF ?? null,
    stormF: st.stormF ?? null, clock: st.clock ?? null, sun: e.sun ? +e.sun.intensity.toFixed(2) : null,
    keyPos: key ? [+key.position.x.toFixed(0), +key.position.y.toFixed(0), +key.position.z.toFixed(0)] : null };

  // The vantage has to be found from the field, not remembered. The pose the legibility probe uses
  // (51.79, 50.69) predates the `gradedAt` rejection and lands the rover on an industrial apron: the
  // chips that used to fill its near field were exactly the ones that change removes, so a frame from
  // there proves nothing about readability. So: the densest tile whose centre is clear of every graded
  // rectangle, with the rover set back from it on the same open ground and looking into it.
  let field = null; R.scene().traverse(o => { if (o.name === 'stone-field') field = o; });
  const lots = await R.footings();
  const V = R.camera().position.constructor;
  const wp = new V();
  const clear = (x, z, m) => !lots.some(l => Math.abs(x - l.x) <= l.w / 2 + m && Math.abs(z - l.z) <= l.d / 2 + m);
  const cands = [];
  for (const lod of field.children) {
    lod.getWorldPosition(wp);
    const r = Math.hypot(wp.x, wp.z);
    const mesh = lod.children[0].isInstancedMesh ? lod.children[0] : lod.children[1];
    if (r > 40 && r < 105 && mesh.count > 0 && clear(wp.x, wp.z, 14))
      cands.push({ x: wp.x, z: wp.z, n: mesh.count });
  }
  cands.sort((a, b) => b.n - a.n);
  const t = cands[0];
  if (!t) return { sky, err: 'no gravel tile clear of footings', cands: cands.length };
  const tr = Math.hypot(t.x, t.z);
  const rx = t.x + (t.x / tr) * 10, rz = t.z + (t.z / tr) * 10;  // back off away from the tile, radially
  const yaw = Math.atan2(t.x - rx, t.z - rz);
  const placed = R.place(+rx.toFixed(2), +rz.toFixed(2), yaw);
  for (let i2 = 0; i2 < 240; i2++) R.frame(1 / 60);
  const names = [];
  const shoot = async (n, at, look) => { const r = await R.shot(n, at, look, null); names.push({ n, r }); };

  // (1) exactly what the player's chase rig shows at the moment the complaint was filed
  await shoot('gravel-seat-chase', null, null);

  // (2) the complaint itself: eye at rover height, aimed 4 m ahead at the sand so gravel fills the frame
  const c = R.camera();
  const fwd = new c.position.constructor(0, 0, -1).applyQuaternion(c.quaternion);
  const eye = [c.position.x, c.position.y, c.position.z];
  await shoot('gravel-seat-low', eye, [eye[0] + fwd.x * 4, eye[1] + fwd.y * 4 - 0.55, eye[2] + fwd.z * 4]);

  // (3) 30 m out along the same line, where the far LOD band takes over
  await shoot('gravel-seat-mid', [eye[0] - fwd.x * 22, eye[1] + 2.4, eye[2] - fwd.z * 22], eye);
  return { sky, placed, vantage: { tile: [+t.x.toFixed(1), +t.z.toFixed(1)], stones: t.n, clearTiles: cands.length }, names };
})()
