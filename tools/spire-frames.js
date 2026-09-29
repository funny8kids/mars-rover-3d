// Frame capture for task #118: after the slender-boulder law slumped three shards, does the chase
// rig still read "a black tower with nothing to stand on"?
// Run through tools/cdp-run.mjs, which has its own ready gate — the previous attempt at this cell
// used tools/cdp-probe-shot.mjs with `window.__RSB.ready`, a field that does not exist, and timed out
// with zero frames.
//
// The vantage is not remembered either: it is taken from the emitter's own published witness. The
// live page's `rock-scatter` group carries `userData.slumped`, so the stones framed here are exactly
// the stones the shape law touched, and each frame is printed next to the record the eye is being
// asked to check it against.
//
// Sky pinned before the FIRST drawn frame, settle loop copied from tools/gravel-frames.js: shot()
// parks the key light at its own default unless handed null, and leaves intensity to the game clock.
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
  const sky = { pumped, nightF: st.nightF ?? null, dayF: st.dayF ?? null, duskF: st.duskF ?? null,
    stormF: st.stormF ?? null, clock: st.clock ?? null, sun: e.sun ? +e.sun.intensity.toFixed(2) : null };

  const g = R.scene().getObjectByName('rock-scatter');
  const slumped = g?.userData?.slumped, records = g?.userData?.stones;
  if (!Array.isArray(slumped) || !Array.isArray(records)) {
    return { sky, err: 'rock-scatter carries no userData.slumped/stones on the live page' };
  }
  const byXY = new Map(records.map(r => [`${r.x},${r.z}`, r]));
  const c = R.camera();
  const frames = [];
  // 4 frames for 3 stones (the batch cap): the complaint stone gets the game's own chase rig plus a
  // low eye; the other two get the low eye, which is the framing that filed the complaint.
  for (const s of slumped) {
    const rec = byXY.get(`${s.x},${s.z}`);
    const tr = Math.hypot(s.x, s.z) || 1;
    const rx = s.x - (s.x / tr) * 9, rz = s.z - (s.z / tr) * 9;  // stand off toward the hub, look back out
    const placed = R.place(+rx.toFixed(2), +rz.toFixed(2), Math.atan2(s.x - rx, s.z - rz));
    for (let i = 0; i < 180; i++) R.frame(1 / 60);
    const chaseOrLow = [];
    if (rec?.prop === 'scatter:rock#27') chaseOrLow.push(await R.shot(`spire-27-chase`, null, null, null));
    const eye = [c.position.x, c.position.y, c.position.z];
    chaseOrLow.push(await R.shot(`spire-${s.x}-${s.z}-low`, eye,
      [s.x, eye[1] + (rec ? rec.heightM : 2) * 0.45, s.z], null));
    for (const f of chaseOrLow) frames.push({ prop: rec?.prop ?? '?', stone: `${s.name}@${s.x},${s.z}`,
      from: s.from, to: s.to, record: rec ? { h: rec.heightM, band: rec.bandReachM,
        discs: rec.discRs.length, slender: rec.bandReachM > 0.01
          ? +(rec.heightM / rec.bandReachM).toFixed(2) : null } : null,
      placed: placed?.contacts ?? placed, frame: f });
  }
  return { sky, anchor: { stones: records.length, slumped: slumped.length }, frames };
})()
