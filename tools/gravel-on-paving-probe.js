// Second reading for task #70. Re-seating made near gravel visible, and the first visible frame
// showed a stone standing on SAWN PAVING next to the rover — the exact "litter on engineered ground"
// tell the placement loop claims to reject. This asks, per near stone, whether it is inside a graded
// footing at all, so the answer is a number rather than an impression.
//
// The placement test in terrain.js is `lotAt(x, z)` with `lot.sd < 0`; R.footings() lists the same
// lots as rectangles. If a stone is inside a rectangle the placement test let it through, the two
// descriptions of "engineered ground" disagree and the rejection test is narrower than the paving.
(async () => {
  const R = window.__RSB;
  const scene = R.scene(), cam = R.camera();
  let field = null; scene.traverse(o => { if (o.name === 'stone-field') field = o; });
  const lots = await R.footings();
  const V = cam.position.constructor;
  // Same vantage the legibility probe measures: the last shot left the camera 22 m back on a rod, and
  // a probe that reports "near" from whatever pose the previous script happened to leave is not
  // measuring the near field anyone complained about.
  R.place(51.79, 50.69, -2.345);
  for (let i = 0; i < 240; i++) R.frame(1 / 60);
  scene.updateMatrixWorld(true); cam.updateMatrixWorld(true);
  const wp = new V();
  const out = { lotCount: lots.length, inside: 0, outside: 0, offenders: [], lotShapes: {} };
  for (const l of lots) out.lotShapes[l.id.split(':')[0]] = (out.lotShapes[l.id.split(':')[0]] || 0) + 1;
  const mI = field.children[0].children[0].matrixWorld.constructor;
  const mA = new mI(), mB = new mI();
  // Whole field, not the near band: the question is whether the placement predicate lets ANY chip
  // onto engineered ground, and a distance filter would only answer it for the tiles someone happened
  // to be standing next to.
  for (const lod of field.children) {
    lod.updateWorldMatrix(true, false);
    const mesh = lod.children[0].isInstancedMesh ? lod.children[0] : lod.children[1];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, mB);
      mA.multiplyMatrices(lod.matrixWorld, mB);
      const x = mA.elements[12], z = mA.elements[14];
      let hit = null;
      for (const l of lots) {
        if (Math.abs(x - l.x) <= l.w / 2 && Math.abs(z - l.z) <= l.d / 2) { hit = l; break; }
      }
      if (!hit) { out.outside++; continue; }
      out.inside++;
      if (out.offenders.length < 8) out.offenders.push({ x: +x.toFixed(1), z: +z.toFixed(1), lot: hit.id,
        deck: hit.deck, drawn: hit.drawn, y: +mA.elements[13].toFixed(2) });
    }
  }
  return out;
})()
