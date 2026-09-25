// 【C】dynamic-wall A/B — the mineral spire's collider against the spire the player can see.
//
// The static audit can only read one instant, and at that instant `wall` and the drawn geometry agree
// by construction (both were set by the same `dressSample` call). This probe moves the state on
// purpose and asks three questions that a snapshot cannot answer:
//   membership  `live === (wall ? discs : 0)` at every cover value. A disc left in the solver's list
//               under a drift is the invisible wall; one that fails to come back is the rock you
//               drive through. The splice has to be symmetric in both directions.
//   geometry    `wall === (crown > RIDE)`, where `crown` is measured off the drawn spire's own Box3
//               minus the ground it stands on — a second ruler that has never seen `siteWallUp`, so
//               a predicate that drifted away from the picture (a stale `rise`, a sink that moves
//               something other than the crystal) shows up here and not in the first question.
//   accounting  the length of the solver's own collider array must move by exactly the number of
//               discs the sites hold, and must return to the byte-identical figure once the cover is
//               restored. A "pass" that leaves two discs behind would otherwise be invisible here.
//   seat        the group's own Y against `heightAt` where it stands. This is the ruler that names
//               *why* a predicate and a picture can disagree: a site is seated mid-build, and every
//               footing claimed after it drags its regrade skirt across the sand underneath.
//
// Run against the loaded page (no reload needed; this only moves state, and restores it):
//   node tools/cdp-run.mjs '-' tools/site-wall-probe.js 9334 15000 90000
//
// First run (audit10 build) came back with the membership and accounting halves clean — 27 discs in
// and out together across 14 cover values, the collider array returning to its starting 719 — and two
// rows from one cause: `v=0.45 #8 crown=0.358 wall=true`, and a seat 0.395 m under the finished field.
// Site 8 stands inside `grid:tap:industry`'s 12 m skirt, which was claimed after the site was placed,
// so the stored `rise` was measured from ground that no longer existed there and the ring stayed up
// after the crown had gone under the hull floor at RIDE 0.46. props.js re-seats every site from the
// finished `heightAt` in front of `solidify()`; the seat ruler is what would catch it coming back.
(async () => {
  const R = window.__RSB;
  if (!R) return JSON.stringify({ fatal: 'no __RSB' });
  const THREE = await import('three');
  const { RIDE } = await import('/src/vehicle/physics.js');
  const { heightAt } = await import('/src/world/height.js');
  const scene = R.scene(), solids = R.solids();
  const spawn = [];
  const st0 = R.sites();
  const n0 = solids.length;
  const before = st0.map(s => ({ id: s.id, buried: s.buried, seen: s.seen, taken: s.taken,
    live: s.live, discs: s.discs, wall: s.wall }));

  // The groups are tagged `siteN` by props.js; the spire inside each is picked while the cover is
  // off, where it is unambiguously the tallest thing standing on the ground.
  const groups = new Map();
  const feet = [];
  scene.traverse(o => {
    if (o.userData.rsbNoSolid) feet.push(o);
    const sc = o.userData && o.userData.rsbScope;
    if (typeof sc === 'string' && /^site\d+$/.test(sc)) groups.set(sc, o);
  });
  // `dY` is the seat against the field as it finished. The spire's group and its gravel foot are two
  // objects, and props.js re-seats both — a foot left on the stale datum would be the same bug with
  // the collider half already fixed.
  const seatBad = [], seats = [];
  const seatOf = (tag, o) => {
    const dY = o.position.y - heightAt(o.position.x, o.position.z);
    seats.push(`${tag}:${dY >= 0 ? '+' : ''}${dY.toFixed(3)}`);
    if (Math.abs(dY) > 0.05) seatBad.push(`${tag} seat ${dY >= 0 ? '+' : ''}${dY.toFixed(3)} m off the finished field`);
  };
  R.bury(0);
  const spire = new Map();
  for (const s of R.sites()) {
    const g = groups.get('site' + s.id);
    if (!g) { spawn.push(`#${s.id} no group tagged site${s.id}`); continue; }
    seatOf(`#${s.id}`, g);
    let best = null, top = -1e9;
    for (const c of g.children) {
      const b = new THREE.Box3().setFromObject(c);
      if (b.max.y > top) { top = b.max.y; best = c; }
    }
    if (!best) { spawn.push(`#${s.id} group has no children`); continue; }
    let meshes = 0; best.traverse(o => { if (o.isMesh) meshes++; });
    spire.set(s.id, { g, c: best, top0: +top.toFixed(3), meshes });
    if (meshes < 2) spawn.push(`#${s.id} spire has ${meshes} meshes — identity pin is wrong`);
  }
  for (const f of feet) seatOf(`foot@${Math.round(f.position.x)},${Math.round(f.position.z)}`, f);
  // The crown as the player's eyes would measure it: the drawn box's top over the ground the hull
  // rides on. `ground().surface` is the same `surfaceAt` the physics loop stands the rover on.
  const crown = id => {
    const o = spire.get(id); if (!o) return null;
    const b = new THREE.Box3().setFromObject(o.c);
    const g = R.ground(o.g.position.x, o.g.position.z).surface;
    return { crown: +(b.max.y - g).toFixed(3), over: +(b.min.y - g).toFixed(3) };
  };
  const em = crown(0) && { ...crown(0), ...R.sites()[0] };

  const STEP = [0, 0.02, 0.03, 0.04, 0.15, 0.3, 0.45, 0.6, 0.75, 0.84, 0.85, 0.86, 0.95, 1];
  const memberBad = [], geomBad = [], sweep = [];
  for (const v of STEP) {
    R.bury(v);
    const list = R.sites();
    let up = 0, live = 0;
    for (const s of list) {
      if (s.taken) continue;
      live += s.live; up += s.wall ? 1 : 0;
      if (s.live !== (s.wall ? s.discs : 0))
        memberBad.push(`v=${v} #${s.id} live=${s.live}/${s.discs} wall=${s.wall}`);
      const c = crown(s.id);
      if (!c) { geomBad.push(`v=${v} #${s.id} no spire`); continue; }
      if (s.wall !== (c.crown > RIDE))
        geomBad.push(`v=${v} #${s.id} crown=${c.crown} wall=${s.wall} live=${s.live}/${s.discs}`);
    }
    sweep.push({ v, sitesWalled: up, discsLive: live, len: solids.length });
  }

  // Hard extremes, read off the solver's list rather than off the sites' own bookkeeping.
  R.bury(1); const allBuried = { len: solids.length, sites: R.sites().map(s => `${s.id}:${s.live}/${s.discs}`) };
  R.bury(0); const allUp = { len: solids.length, sites: R.sites().map(s => `${s.id}:${s.live}/${s.discs}`) };
  for (const b of before) if (!b.taken) R.bury(b.buried, b.id);
  const after = R.sites();
  const notRestored = after.map((s, i) => ({ s, b: before[i] }))
    .filter(({ s, b }) => s.live !== b.live || s.discs !== b.discs
      || Math.abs(s.buried - b.buried) > 1e-3 || s.wall !== b.wall)
    .map(({ s, b }) => `#${s.id} now ${s.live}/${s.discs} wall=${s.wall} b=${s.buried}`
      + ` was ${b.live}/${b.discs} wall=${b.wall} b=${b.buried}`);
  const sideEffect = after.filter((s, i) => s.seen !== before[i].seen)
    .map(s => `#${s.id} seen=${s.seen}`);

  // Only the sites still standing contribute: a collected one has its discs out of the list for good.
  const ownLive = before.reduce((a, b) => a + (b.taken ? 0 : b.live), 0);
  const owned = before.reduce((a, b) => a + (b.taken ? 0 : b.discs), 0);

  return JSON.stringify({
    RIDE, sites: st0.length, taken: before.filter(b => b.taken).length,
    discsOwned: before.reduce((a, b) => a + b.discs, 0),
    discsLiveAtStart: before.reduce((a, b) => a + b.live, 0),
    n0, allBuried, allUp,
    restoresExactly: n0 === solids.length && notRestored.length === 0,
    lenAfterRestore: solids.length, notRestored, sideEffect,
    // The 0-coverage reading of the tallest spire is also the stored `rise`'s cross-check.
    firstSite: em, spireTops: [...spire.entries()].map(([i, o]) => `${i}:${o.top0}`).join(' '),
    seatBad, seats, memberBad, geomBad, sweep,
    // The two extremes are arithmetic on one number: the array starts at `n0`, which already carries
    // `ownLive` of the sites' discs, so fully buried must read `n0 − ownLive` and fully clear `n0`
    // minus those same discs plus every disc the sites own. Written as `owned` rather than
    // `owned − live` because the live half is already out of the starting figure.
    pass: memberBad.length === 0 && geomBad.length === 0 && seatBad.length === 0
      && feet.length === st0.length && n0 === solids.length
      && notRestored.length === 0 && allBuried.len === n0 - ownLive
      && allUp.len === n0 - ownLive + owned,
  });
})();
