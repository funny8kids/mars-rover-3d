// 【C】3 collider-vs-appearance audit — the second instrument, rebuilt as a measuring stick.
//
// Two defects, one ruler each:
//   exposure  a wall-ish face inside the rover's band that no collider disc stops. The player drives
//             through geometry they can see. Split by reachability: `re` faces sit on a legal drive
//             path from the spawn, `sealed` faces are walled off by the collider set itself and are
//             counted, not fixed — a desk behind a ring of module walls is not something you drove
//             through.
//   phantom   a collider disc with no drawn geometry where it stands. An invisible wall.
//   over-wide a disc that does stand on geometry, but reaches metres past it — the rim stops the
//             rover before anything they can see does. This is the "invisible rubber wall" complaint.
//   blanket   an *emitted* disc whose own rim is mostly standing on nothing. The tiler's rectangle is
//             not accepted as a licence here (it is derived from the same midpoints, so it would be
//             the ruler reading its own output), which is what catches two 0.35 m lamp posts merged
//             into one 1.21 m disc across the empty middle of a teleport deck.
//   merged    an emitted disc whose CENTRE has no drawn face near it — the same defect read from the
//             inside, and the reading `blanket` cannot make: a thin wall bulges a disc sideways
//             whatever its count, so rim-bare fires on legitimate walls too.
//   hollow    an emitted disc that hides a spot BODY_R away from every drawn face — a room its rim
//             seals with nothing built there. One disc strung across a ring of posts touches every
//             post (`blanket` reads 0.00 bare) and still locks the middle of the deck.
//
// Every threshold is a number the physics loop itself uses, not one picked to make the report
// pretty, and this file no longer keeps its own copies of them: RIDE, BODY_R and ROOF are imported
// from src/vehicle/physics.js, the module that enforces the first two. A hand-copied 0.46 here would
// have kept measuring the old hull on the day the solver's hull changed.
//   BODY_R 1.6   physics.js — the body ring pads every disc by this; the ring's skin can reach the
//                disc rim and no further, so "protected" means the face is inside the raw disc
//                radius r.
//   RIDE   0.46  physics.js — hull floor above the ground; a face whose whole band is below it
//                passes under the rover and is not a wall.
//   ROOF   2.72×scale  physics.js × the player's live group scale — measured hull top.
//
// The bulge allowance is the reason this file exists: `coverDiscs` (src/world/plan.js:47) tiles a
// rectangle with discs of radius hypot(half-length-per-disc, half-width), so a disc's rim *must*
// stand outside the drawn wall — by exactly r − min(hw, hd), where (hw, hd) is the disc's own share
// of the lot. Sampling the rim for geometry without that allowance calls every wide building a
// phantom. Each disc now carries the lot it was generated from and its own share (`lot`/`share`,
// src/world/props.js:544), so a disc is licensed up to the maths and not one metre further.
//
// Two more allowances the first working version got wrong:
//   the island rim: `rim-veil` is a travelling-dust shader, invisible to a mesh sweep, and the
//     collider ring sits on its face radius. Without the allowance all 135 rim discs read phantom.
//   the player's own vehicle: ~12 k triangles of hull that no collider is supposed to cover. It is
//     excluded by object identity through `__RSB.roverRoot()`, never by a radius around the parked
//     position — a radius silently exempts every prop standing near wherever the rover happened
//     to stop, which is 42 % of the band faces in the first run.
//
// Run it against the live page (dev server + the GPU Chrome on :9334):
//   node tools/cdp-eval.mjs "$(cat tools/disc-audit-probe.js)" 9334 280000 5173
(async () => {
  const R = window.__RSB;
  let waited = 0;
  while (!R.env && waited < 120_000) { await new Promise(r => setTimeout(r, 250)); waited += 250; }
  if (!R.env) return JSON.stringify({ fatal: 'env absent' });
  const THREE = await import('three');
  const scene = R.scene();
  scene.updateMatrixWorld(true);
  const scale = R.cam().scale || 1;
  const PHY = await import('/src/vehicle/physics.js');
  const RIDE = PHY.RIDE, BODY_R = PHY.BODY_R, ROOF = PHY.ROOF * scale;
  // …and the copy that was just imported is checked against the vehicle standing in the page, so a
  // ROOF retuned without re-measuring the hull shows up as a non-zero `roofCheck` rather than as a
  // ruler that quietly moved its band. The raw triple travels with the ratio: the hull's top over the
  // sand is a pose-dependent number (suspension pitch, and which deck the rover happens to be parked
  // on), and the first run of this check printed −0.353 while the same build measured −0.118 at the
  // spawn. A bare ratio invites reading a parked-vehicle difference as a stale constant.
  let roofCheck = null;
  {
    const rr = R.roverRoot?.();
    if (rr) {
      const bb = new THREE.Box3().setFromObject(rr);
      const surf = R.ground(rr.position.x, rr.position.z).surface;
      const over = +(bb.max.y - surf).toFixed(3);
      roofCheck = { rel: +Math.round((over / ROOF - 1) * 1e3) / 1e3,
        hullTop: +bb.max.y.toFixed(3), surface: +surf.toFixed(3), groupY: +rr.position.y.toFixed(3),
        scale };
    }
  }
  const ISLAND = 112;                    // rim_veil's own face radius: the ring the discs share
  const TOL = 0.6;                       // one and a half grid cells — the ruler's own resolution

  // Roots that are not walls, keyed by the name the module gives its group. An unknown root is
  // SWEPT, never skipped: a new prop group showing up as exposure is the outcome we want.
  //
  // `stone-field` used to sit here with the reason "gravel under the ride height". That is a
  // claim about a height, and the sweep is the thing that measures heights, so it is swept now:
  // the reading either shows nothing in the band (the claim was true) or shows chips the hull
  // clips (the claim was a comment). Nothing name-based gets to exempt geometry from a ruler
  // whose whole job is measuring geometry.
  const EXCLUDE = {
    terrain: 'the surface being driven on; a slope is not a wall',
    'rim-veil': 'the island edge itself, drawn as travelling dust at the collider ring radius',
  };

  // Per-root coverage, so the denominator is in the report and not in a comment. The root is the
  // scene's own child — walking the parent chain to its end lands on the scene itself, which puts
  // every prop in the base under one meaningless bucket.
  const rootOf = o => { let p = o; while (p.parent && p.parent !== scene) p = p.parent; return p; };
  const rootKey = new Map();
  { let i = 0; for (const child of scene.children) rootKey.set(child, `${child.name || child.type}#${i++}`); }

  const G = 0.25, X0 = -135, N = Math.ceil(270 / G);
  const gi = x => Math.floor((x - X0) / G);
  const covered = new Uint8Array(N * N), solid = new Uint8Array(N * N);
  const discs = (R.solids() || []).filter(c => c.floor === undefined);
  // The exposure arithmetic, in one place and injectable. The sweep below judges every band face by
  // it, and so do the polarity controls — a gate that only ever sees the live disc set cannot be
  // shown to work, because "0 exposed faces" and "the gate is broken" are the same reading. `ds`
  // defaults to the island; a control passes its own one-disc world.
  const reachAt = (x, z, ds = discs) => {
    let reach = Infinity, near = null;
    for (const d of ds) {
      const dd = Math.hypot(x - d.x, z - d.z) - d.r;
      if (dd < reach) { reach = dd; near = d; }
    }
    return { reach, near };
  };
  // metres past the hull skin: > 0 means the ring's outer surface stands outside every disc, so the
  // player drives through the face that is standing there.
  const pastAt = (x, z, ds) => reachAt(x, z, ds).reach - BODY_R;
  // Lots are only used to NAME a stray face, never to judge it, so an empty seam must show up as a
  // reading instead of quietly turning every face into "open sand".
  const lots = R.lots?.() || [];
  for (const c of discs) {
    const i0 = Math.max(0, gi(c.x - c.r)), i1 = Math.min(N - 1, gi(c.x + c.r));
    const j0 = Math.max(0, gi(c.z - c.r)), j1 = Math.min(N - 1, gi(c.z + c.r));
    for (let i = i0; i <= i1; i++) {
      const x = X0 + (i + 0.5) * G;
      for (let j = j0; j <= j1; j++) {
        const z = X0 + (j + 0.5) * G;
        if ((x - c.x) ** 2 + (z - c.z) ** 2 <= c.r * c.r) covered[i * N + j] = 1;
      }
    }
  }
  // Reachability. `past > 0` on its own conflates two different complaints: a face the player can
  // drive their hull into, and a face sealed behind a wall of colliders that no drive path reaches —
  // the desks inside a closed module read the same 5 m as a scaffold leg in open sand, and only the
  // first one is something to fix. The physics constrains only the rover's CENTRE (it must stand
  // BODY_R outside every disc), so the drivable space is exactly
  //   { p : min over discs (|p − c| − r) ≥ BODY_R }
  // and the honest question is whether a face lies in the connected component of that space the
  // spawn belongs to. Flood-filled over the collider set itself, 4-connectivity so a one-cell
  // diagonal cannot leak through a wall, seeded from `config.js START` — not from wherever the rover
  // happens to be parked, which would make the answer depend on the last thing the last probe did.
  const { START } = await import('/src/config.js');
  const RB = 0.5, FX0 = -135, FN = Math.ceil(270 / RB);
  const fgi = x => Math.floor((x - FX0) / RB);
  const fBlocked = new Uint8Array(FN * FN), reached = new Uint8Array(FN * FN);
  for (const c of discs) {
    const rr = c.r + BODY_R;                       // the swept body, not the disc
    const i0 = Math.max(0, fgi(c.x - rr)), i1 = Math.min(FN - 1, fgi(c.x + rr));
    const j0 = Math.max(0, fgi(c.z - rr)), j1 = Math.min(FN - 1, fgi(c.z + rr));
    for (let i = i0; i <= i1; i++) {
      const x = FX0 + (i + 0.5) * RB;
      for (let j = j0; j <= j1; j++) {
        const z = FX0 + (j + 0.5) * RB;
        if ((x - c.x) ** 2 + (z - c.z) ** 2 <= rr * rr) fBlocked[i * FN + j] = 1;
      }
    }
  }
  const cellIdx = (x, z) => { const i = fgi(x), j = fgi(z);
    return i >= 0 && j >= 0 && i < FN && j < FN ? i * FN + j : -1; };
  const startIdx = (() => { const k = cellIdx(START.pos[0], START.pos[1]);
    return k >= 0 && !fBlocked[k] ? k : -1; })();
  let freeCells = 0, reachedCells = 0;
  for (let k = 0; k < fBlocked.length; k++) if (!fBlocked[k]) freeCells++;
  {
    const stack = startIdx >= 0 ? [startIdx] : [];
    while (stack.length) {
      const k = stack.pop();
      if (reached[k]) continue;
      reached[k] = 1; reachedCells++;
      const i = (k / FN) | 0, j = k % FN;
      if (i > 0 && !fBlocked[k - FN] && !reached[k - FN]) stack.push(k - FN);
      if (i < FN - 1 && !fBlocked[k + FN] && !reached[k + FN]) stack.push(k + FN);
      if (j > 0 && !fBlocked[k - 1] && !reached[k - 1]) stack.push(k - 1);
      if (j < FN - 1 && !fBlocked[k + 1] && !reached[k + 1]) stack.push(k + 1);
    }
  }
  // Does a legal, flood-reached centre stand within `rad` of a point? The `+ RB` is the grid's own
  // quantisation, not slack. Asked with BODY_R it means "the hull skin can be on that spot"; asked
  // with a POI's own radius it means "the player can stand there and use it" — the two are not
  // interchangeable, because the grid tap you link to has a collider disc under its own feet, so
  // testing it at BODY_R reports every one of them sealed and reads as a broken flood.
  const reachedWithin = (x, z, rad) => {
    const q = rad + RB, RING = Math.ceil(q / RB), R2 = q * q;
    const i0 = fgi(x), j0 = fgi(z);
    for (let di = -RING; di <= RING; di++) {
      const i = i0 + di; if (i < 0 || i >= FN) continue;
      const dx = FX0 + (i + 0.5) * RB - x;
      for (let dj = -RING; dj <= RING; dj++) {
        const j = j0 + dj; if (j < 0 || j >= FN || !reached[i * FN + j]) continue;
        const dz = FX0 + (j + 0.5) * RB - z;
        if (dx * dx + dz * dz <= R2) return true;
      }
    }
    return false;
  };
  const hullReached = (x, z) => reachedWithin(x, z, BODY_R);

  const gcache = new Map();
  const groundAt = (x, z) => {
    const k = `${Math.round(x)},${Math.round(z)}`;
    let g = gcache.get(k);
    if (g === undefined) { g = R.ground(x, z).surface; gcache.set(k, g); }
    return g;
  };

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  // Face sampling density for the judge's own raster. It used to decimate every mesh to ~200 triangles
  // while the emitters (`solidify`, `stoneMeasurement`) walk every face — 80 053 band faces on the
  // island against this ruler's 15 186. A thin high-poly prop can then lose in the sample the very
  // face its disc was derived from, and read `phantom` for a wall that is drawn. Default is exact;
  // `?fb=200` restores the old density so a count can be pinned to one side of that line or the other.
  const FB = +(new URLSearchParams(location.search).get('fb') || 0) || Infinity;
  const cells = new Map();            // 10 m cell → the worst unprotected face in it
  const swept = new Map();            // root key → faces counted
  const seenNames = new Set();
  let meshes = 0, bandFaces = 0, offIsland = 0, domes = 0, roverMeshes = 0, roverTris = 0;
  let sealedFaces = 0;                // past > 0 but no drive path reaches it — a count, not a delete
  // Instancing, counted twice: once the moment the traverse touches the object, once where the
  // sampler actually consumed it. The first working version reported `instances: 0` while the
  // gravel field was standing right there with 3 600 of them, because the counter lived past the
  // per-root exclusion — a 0 that meant "the counter never looked" and read as "nothing truncated".
  const inst = { seenMeshes: 0, seenInstances: 0, sweptMeshes: 0, sweptInstances: 0, truncated: 0 };
  // The player's own vehicle, exempted by identity: its hull triangles are in the scene and no
  // collider is meant to cover them. Skipping the whole subtree means nothing else loses its
  // exemption because of where the rover happens to be parked — a 5 m radius around the parked
  // position swallowed 42 % of the band faces in the first run.
  const self = new Set();
  { const rr = R.roverRoot?.(); if (rr) rr.traverse(o => self.add(o)); }
  scene.traverse(o => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const g = o.geometry, pos = g.attributes?.position;
    if (!pos) return;
    if (o.isInstancedMesh) { inst.seenMeshes++; inst.seenInstances += o.count; }
    if (self.has(o)) { roverMeshes++; roverTris += (g.index ? g.index.count : pos.count) / 3; return; }
    const root = rootOf(o), key = rootKey.get(root);
    seenNames.add(root.name);
    const ex = EXCLUDE[root.name];
    swept.set(key, swept.get(key) || { skipped: !!ex, why: ex || null, tris: 0, faces: 0, strays: 0, maxAbove: 0 });
    if (ex) return;
    const m = o.material;
    if (m && (Array.isArray(m) ? m.some(x => x?.transparent) : m.transparent)) return;
    const w = new THREE.Box3().setFromObject(o);
    // A mesh bigger than the island cannot be a prop: it is a sky dome, a star shell or an
    // orbit-fx shell, and its faces land kilometres off the grid.
    if (w.max.x - w.min.x > 2 * ISLAND || w.max.z - w.min.z > 2 * ISLAND) { domes++; return; }
    const idx = g.index;
    const tri = idx ? idx.count : pos.count;
    if (tri < 3) return;
    meshes++;
    const mats = [];
    if (o.isInstancedMesh) {
      inst.sweptMeshes++; inst.sweptInstances += o.count;
      const mm = new THREE.Matrix4();
      const want = Math.min(o.count, 240), st = Math.max(1, Math.floor(o.count / want));
      for (let q = 0; q < o.count; q += st) { o.getMatrixAt(q, mm); mats.push(mm.clone()); }
      // An instanced mesh sampled below its count could turn a real rock into a phantom, so the
      // truncation itself is a reading: `truncated: 0` is what lets the phantom count mean
      // anything at all.
      if (mats.length < o.count) inst.truncated++;
    } else mats.push(new THREE.Matrix4());
    const stride = Math.max(3, Math.floor(tri / FB / 3) * 3);
    for (const im of mats) {
      const wm = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, im);
      for (let t = 0; t + 2 < tri; t += stride) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(wm);
        b.fromBufferAttribute(pos, i1).applyMatrix4(wm);
        c.fromBufferAttribute(pos, i2).applyMatrix4(wm);
        const mx = (a.x + b.x + c.x) / 3, mz = (a.z + b.z + c.z) / 3;
        if (Math.hypot(mx, mz) > ISLAND + 4) { offIsland++; continue; }
        ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac).normalize();
        if (Math.abs(n.y) > 0.7) continue;                    // floor/ceiling facing: driven over
        const lo = Math.min(a.y, b.y, c.y), hi = Math.max(a.y, b.y, c.y);
        if (hi - lo < 0.12) continue;                         // a plate's own rim: a step, not a wall
        const gy = groundAt(mx, mz);
        const rec = swept.get(key);
        if (hi - gy > rec.maxAbove) rec.maxAbove = hi - gy;
        if (lo > gy + ROOF || hi < gy + RIDE) continue;       // outside the rover's band
        bandFaces++;
        rec.faces++;
        const ai = gi(mx), bi = gi(mz);
        if (ai >= 0 && bi >= 0 && ai < N && bi < N) solid[ai * N + bi] = 1;
        if (ai < 0 || bi < 0 || ai >= N || bi >= N || !covered[ai * N + bi]) {
          // Severity in metres, from `reachAt` — the same function the controls under the report run
          // through, so a `driveThroughCells: 0` can only mean the island has no exposed face, never
          // that the gate was wired wrong.
          const { reach, near } = reachAt(mx, mz);
          // Attribution. `mergeInto` (src/world/merge.js:14) fuses the whole static base into a
          // handful of meshes that inherit no prop name, so a report grouped by mesh name says
          // `Mesh` for 1 210 faces and names nothing. What identifies the thing the player drove
          // through is where it is: a 10 m cell, the lot that owns it, and the mesh that drew the
          // worst face in it.
          let lot = null;
          for (const l of lots) {
            // Rotate the point into the lot's own basis: an axis-aligned test against a rotated lot
            // measures its bounding box, which is a different piece of ground.
            const dx = mx - l.x, dz = mz - l.z;
            const c = Math.cos(l.ry || 0), s = Math.sin(l.ry || 0);
            const u = dx * c + dz * s, v = -dx * s + dz * c;
            if (Math.abs(u) > l.w / 2 || Math.abs(v) > l.d / 2) continue;
            if (!lot || l.w * l.d < lot.w * lot.d) lot = l;
          }
          const h = +(hi - lo).toFixed(2), past = +(reach - BODY_R).toFixed(2);
          const at = [+mx.toFixed(1), +((lo + hi) / 2).toFixed(2), +mz.toFixed(1)];
          rec.strays++;
          // Two separate questions, in this order: is the face outside the body ring's reach at all
          // (`exposed`), and can a legal drive path bring the hull there (`hit`). `exposed && !hit`
          // is geometry sealed behind its own collider wall — reported as a count, never deleted.
          const exposed = past > 0;
          const hit = exposed && hullReached(mx, mz);
          if (exposed && !hit) sealedFaces++;
          const ck = `${Math.floor(mx / 10) * 10},${Math.floor(mz / 10) * 10}`;
          const nm = o.name || o.type;
          let cur = cells.get(ck);
          if (!cur) cells.set(ck, cur = { cell: ck, n: 0, exposed: 0, sealed: 0, re: 0,
            through: 0, reThrough: 0, past: -Infinity, rePast: -Infinity, at, mesh: nm,
            meshCount: 1, lot: null, near: '', root: '', above: 0 });
          cur.n++;
          if (!cur.seen) cur.seen = new Set([nm]); else cur.seen.add(nm);
          if (exposed) {
            cur.exposed++;
            const whole = reach > 2 * BODY_R;          // the entire vehicle can stand on the face
            cur.through += whole ? 1 : 0;
            if (past > cur.past) cur.past = past;
            if (!hit) cur.sealed++;
            else {
              cur.re++; cur.reThrough += whole ? 1 : 0;
              if (past > cur.rePast) {
                // The headline row has to point at a face the player can actually hit: a cell can
                // hold one sealed face at 9 m and one open one at 2 m, and only the second is a bug.
                // `root` and `above` are the two fields that turn a residual into an action. `root`
                // says which scene root drew the face, so a cell whose root is not the merged prop
                // group is geometry the collider emitter never walked — a scope gap, not a bad wall.
                // `above` is that face's own top over the ground under it: 0.13 m is a kerb the band
                // test happens to accept, 2 m is a wall the player drives through.
                cur.rePast = past; cur.h = h; cur.meshCount = cur.seen.size;
                cur.at = at; cur.mesh = nm; cur.lot = lot ? lot.id : null;
                cur.root = key; cur.above = +(hi - gy).toFixed(2);
                cur.near = `${near ? near.prop : 'no disc anywhere'}@${reach.toFixed(1)}`;
              }
            }
          }
        }
      }
    }
  });

  // Disc side. Two allowances are built into the sampling, and both come from geometry maths rather
  // than from taste:
  //   the island rim — `rim-veil` draws the playfield edge as travelling dust a mesh sweep cannot
  //     see, and the collider ring shares its face radius, so a rim point out there IS drawn.
  //   the tiling bulge — a disc may stand outside its lot's outline by exactly
  //     r − min(share.hw, share.hd), which is what `coverDiscs` is obliged to do. Anything past
  //     that is an invisible wall, and the excess is reported in metres.
  const outlineOf = d => {
    if (!d.lot || !d.share) return null;
    return { cx: d.lot.cx, cz: d.lot.cz, hw: d.lot.hw, hd: d.lot.hd,
             cos: Math.cos(d.lot.ry), sin: Math.sin(d.lot.ry),
             entitled: d.r - Math.min(d.share.hw, d.share.hd) };
  };
  // signed distance from a point to a rotated rectangle, negative inside. The world→lot basis is the
  // inverse of the placement maths in props.js `lot()`: u = x·cos − z·sin, v = x·sin + z·cos.
  const outsideRect = (o, x, z) => {
    const dx = x - o.cx, dz = z - o.cz;
    const ox = Math.abs(dx * o.cos - dz * o.sin) - o.hw;
    const oz = Math.abs(dx * o.sin + dz * o.cos) - o.hd;
    return Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0);
  };
  const onVeil = (x, z) => Math.hypot(x, z) > ISLAND - 2.5;
  const nearSolid = (x, z, tol = TOL) => {
    const i = gi(x), j = gi(z);
    const k = Math.ceil(tol / G);
    for (let di = -k; di <= k; di++) for (let dj = -k; dj <= k; dj++) {
      const p = i + di, q = j + dj;
      if (p >= 0 && q >= 0 && p < N && q < N && solid[p * N + q]) return true;
    }
    return false;
  };
  const phantom = [], overWide = [], blanket = [], mergedAway = [], hollow = [];
  let licensedBulge = 0, rimSamples = 0, rectlessDiscs = 0;
  const S = 48;
  // One disc's verdict as a callable, so the polarity controls underneath run through the very same
  // code path the island is judged by. A gate nobody can make red is not a gate.
  const judge = d0 => {
    const out = outlineOf(d0);
    let bare = 0, unlicensed = 0, maxPast = 0, licensed = 0, rim = 0;
    for (let i = 0; i < S; i++) {
      const th = i / S * Math.PI * 2;
      const px = d0.x + Math.cos(th) * d0.r, pz = d0.z + Math.sin(th) * d0.r;
      if (onVeil(px, pz)) { rim++; continue; }
      if (nearSolid(px, pz)) continue;
      bare++;
      if (!out) continue;                          // no outline: not classifiable, phantom-checked only
      const past = outsideRect(out, px, pz) - out.entitled;
      if (past > maxPast) maxPast = past;
      if (past > TOL) unlicensed++; else licensed++;
    }
    // Nothing drawn anywhere near the disc at all → an invisible wall.
    let anyNear = onVeil(d0.x, d0.z);
    for (let i = 0; i < 16 && !anyNear; i++) {
      const th = i / 16 * Math.PI * 2;
      for (const rr of [0, d0.r * 0.5, d0.r]) {
        const px = d0.x + Math.cos(th) * rr, pz = d0.z + Math.sin(th) * rr;
        if (onVeil(px, pz) || nearSolid(px, pz)) { anyNear = true; break; }
      }
    }
    const frac = bare / S;
    // Two more readings, taken on *emitted* discs only. An authored lot disc is allowed to fail both:
    // one disc over a footprint may legitimately stand between two walls and cover a floor the player
    // cannot enter. A disc the tiler derived from face midpoints has no such excuse — every metre of
    // it is supposed to be where the drawing is.
    //   `centreBare` the disc's own centre stands on nothing. This is the exact shape of the pad
    //               defect, and the rim ruler cannot see it: a thin wall makes any disc bulge sideways
    //               (the hull is a disc too), so `bare` fires on legitimate walls as well.
    //   `pocket`     samples inside the disc that are ≥ BODY_R from every drawn face, i.e. a place the
    //               hull could stand that the collider declares solid. One disc strung across a ring of
    //               posts touches every post — `bare` reads 0.00 — and still seals a room.
    let centreBare = false, pocketN = 0, pocketAt = null;
    if (d0.emitted) {
      centreBare = !(onVeil(d0.x, d0.z) || nearSolid(d0.x, d0.z));
      if (d0.r > BODY_R) {
        for (let a = -d0.r; a <= d0.r; a += 0.4) {
          for (let b = -d0.r; b <= d0.r; b += 0.4) {
            if (a * a + b * b > d0.r * d0.r) continue;
            const x = d0.x + a, z = d0.z + b;
            if (onVeil(x, z) || nearSolid(x, z, BODY_R)) continue;
            pocketN++; if (!pocketAt) pocketAt = [+x.toFixed(1), +z.toFixed(1)];
          }
          if (pocketN > 40) break;                 // a 0.4 m grid: 40 samples ≈ 6.4 m² — enough to file
        }
      }
    }
    // An *emitted* disc cannot be licensed by its own tiling rectangle: `solidify` derived that rect
    // from the same face midpoints the disc is supposed to trace, so "inside my rect" is the ruler
    // reading its own output — which is how a 1.21 m disc merged out of two 0.35 m lamp posts on a
    // teleport deck passed for clean. For these discs the rim is judged on what is drawn there.
    // Authored lot discs keep the bulge allowance: they are tiled from a footprint, and a disc whose
    // rim runs along a wall is entitled to cover the room behind it.
    return { out, bare: frac, unlicensed: unlicensed / S, maxPast, licensed, rim,
      centreBare, pocket: pocketN, pocketAt,
      kind: !frac ? 'ok' : !anyNear ? 'phantom'
           : d0.emitted && frac > 0.25 ? 'blanket'
           : out && unlicensed / S > 0.25 ? 'overWide' : 'ok' };
  };
  for (const d0 of discs) {
    if (Math.hypot(d0.x, d0.z) > ISLAND + 4) continue;
    const j = judge(d0);
    if (!j.out) rectlessDiscs++;
    licensedBulge += j.licensed; rimSamples += j.rim;
    const row = { prop: d0.prop, at: [+d0.x.toFixed(1), +d0.z.toFixed(1)], r: +d0.r.toFixed(2),
      bare: +j.bare.toFixed(2), boxed: !!j.out, mesh: d0.mesh || null };
    // Taken whatever `kind` says: these two are the ruler for a different defect than the rim is. A
    // disc strung across a ring of posts has every rim sample on a post (`bare` 0.00, kind 'ok') and is
    // still parked in mid-air over ground the drawing never covered.
    if (j.centreBare) mergedAway.push(row);
    if (j.pocket) hollow.push({ ...row, pocketAt: j.pocketAt,
      pocketArea: +(j.pocket * 0.4 * 0.4).toFixed(1) });
    if (j.kind === 'ok') continue;
    if (j.kind === 'phantom') phantom.push(row);
    else if (j.kind === 'blanket') blanket.push({ ...row, area: +(Math.PI * d0.r * d0.r * j.bare).toFixed(1) });
    else overWide.push({ ...row, past: +j.maxPast.toFixed(2) });
  }
  // A control for the licensing arithmetic itself, independent of what happens to be drawn: the
  // middle disc `coverDiscs` produces for a known rectangle must register no unlicensed bulge at
  // all, and the same disc slid 3 m along its lot's own length must register the whole 3 m. Without
  // this pair an `overWideCount: 0` could just mean the allowance maths never fires.
  const { coverDiscs } = await import('/src/world/plan.js');
  const bulgeOf = shift => {
    const L = 12, W = 4, ry = 0.4;
    const s = coverDiscs(L, W)[1];
    const d0 = { x: s.dx * Math.cos(ry) + shift, z: -s.dx * Math.sin(ry), r: s.r,
                 lot: { cx: 0, cz: 0, hw: L / 2, hd: W / 2, ry }, share: { hw: s.hw, hd: s.hd } };
    const out = outlineOf(d0);
    let past = -Infinity;
    for (let i = 0; i < 96; i++) {
      const th = i / 96 * Math.PI * 2;
      past = Math.max(past, outsideRect(out, d0.x + Math.cos(th) * d0.r,
                                        d0.z + Math.sin(th) * d0.r) - out.entitled);
    }
    return +past.toFixed(2);
  };
  const cleanPast = bulgeOf(0), brokenPast = bulgeOf(3);
  // A control for the exposure gate, and the only honest kind: a one-disc world whose answer is
  // known without looking at the island. `past > 0` is the whole of `driveThroughCells`, so a run
  // that reports 0 exposed faces is worth nothing unless the same `pastAt` reports a positive
  // number when a face is provably outside the hull ring, a negative one when it is provably
  // inside, and `> 0` — not `>= 0` — is what splits them at the exact touch.
  const one = x => [{ x, z: 0, r: 1 }];
  const gate = {
    outside: +pastAt(0, 0, one(3.2)).toFixed(2),        // want +0.6: 1.6 m of hull reaches past 1 m disc
    inside: +pastAt(0, 0, one(2.4)).toFixed(2),         // want −0.2: the disc stops the skin
    touch: +pastAt(0, 0, one(2.6)).toFixed(2),          // want 0.00: skin exactly on the rim
  };
  gate.pass = gate.outside > 0 && gate.inside < 0 && gate.touch === 0;
  const controls = { cleanPast, brokenPast, slid: 3, tol: TOL, gate,
    pass: cleanPast <= TOL && brokenPast > TOL };
  const fam = p => (p || '').replace(/#\d+$/, '');
  const tally = list => { const o = {}; for (const x of list) o[fam(x.prop)] = (o[fam(x.prop)] || 0) + 1; return o; };
  const byFamP = tally(phantom), byFamO = tally(overWide), byFamB = tally(blanket);
  overWide.sort((x, y) => y.past - x.past);
  phantom.sort((x, y) => y.bare - x.bare);
  blanket.sort((x, y) => y.area - x.area);
  const unseen = Object.keys(EXCLUDE).filter(k => !seenNames.has(k));
  // Exposure, aggregated per 10 m cell. `past ≤ 0` is not a finding: the face sits inside the body
  // ring's own reach, so the collider stops the hull before it gets there. `past > 0` splits in two:
  // `re` faces the hull can be driven onto, `sealed` faces walled off by the collider set itself.
  const exp = [...cells.values()].map(({ seen, ...o }) => ({ ...o, past: +o.past.toFixed(2),
    rePast: +(Number.isFinite(o.rePast) ? o.rePast : 0).toFixed(2),
    meshes: [...(seen || [])].slice(0, 4) }));
  const drive = exp.filter(e => e.re > 0).sort((x, y) => y.re - x.re || y.rePast - x.rePast);
  const sealedOnly = exp.filter(e => e.sealed > 0 && e.re === 0).sort((x, y) => y.sealed - x.sealed);
  const byLot = {};
  for (const e of drive) { const r = e.lot || 'outside every lot';
    const b = byLot[r] || (byLot[r] = { faces: 0, cells: 0, worst: 0 });
    b.faces += e.re; b.cells++; if (e.rePast > b.worst) b.worst = +e.rePast.toFixed(1); }
  // Cross-match with the emitter's own refusals — the only place the two records meet. A residual
  // cell here and a refusal there are two notes about the same 10 m of ground, written by different
  // modules in the same cell units: a cell with a refusal in it is a licence decision (two props
  // inside each other, a prop out in the lane, a prop on a pad) to undo at the placement site, while
  // a cell without one is a face the covering pass never turned into a candidate disc at all —
  // geometry outside its scope, or a unit its band gate waved through. Same headline number,
  // opposite fixes, so the split is printed rather than inferred by hand.
  const SR = R.solid ? R.solid() : null;
  const rfOf = new Map();
  for (const r of SR?.refusedAt || []) {
    if (!rfOf.has(r.cell)) rfOf.set(r.cell, []);
    rfOf.get(r.cell).push(`${r.k} n${r.n} r${r.r} @${r.x},${r.z} mesh=${r.mesh} vs ${r.against}`);
  }
  for (const e of drive) e.rf = rfOf.get(e.cell) || [];
  const driveLicensed = drive.filter(e => e.rf.length).length;
  // Flood controls. The reachability filter is only allowed to dismiss a face if it can also keep
  // one, so it is pinned at three places before any `sealed` number is believed: the spawn must be
  // inside the reached set, the centre of the widest collider must not be, and open sand beyond the
  // rim ring must not be either. `sealedPois` is a reading in its own right, not a flood failure —
  // an interactive point the hull cannot reach is a D3-class bug.
  const widest = discs.reduce((m, d) => (m === null || d.r > m.r ? d : m), null);
  const poiList = R.pois?.() || [];
  const sealedPois = [];
  for (const p of poiList) {
    if (reachedWithin(p.x, p.z, p.r || 0)) continue;
    // Named with the number that explains it: `reach` is how far the point stands outside the
    // nearest collider disc, so a point swallowed by its own rig's disc reads as a reach past its
    // use radius — a different fact from "the flood never got here".
    let reach = Infinity, near = null;
    for (const d of discs) {
      const dd = Math.hypot(p.x - d.x, p.z - d.z) - d.r;
      if (dd < reach) { reach = dd; near = d; }
    }
    sealedPois.push({ poi: p.name, at: [+p.x.toFixed(1), +p.z.toFixed(1)], useR: p.r,
      reach: +reach.toFixed(1), needs: +((p.r || 0) + BODY_R).toFixed(1),
      near: near ? near.prop : 'no disc' });
  }
  const flood = {
    seed: `START@${START.pos[0]},${START.pos[1]}`, seeded: startIdx >= 0,
    freeCells, reachedCells, reachFrac: +(reachedCells / Math.max(1, freeCells)).toFixed(3),
    atSpawn: hullReached(START.pos[0], START.pos[1]),
    atWidestDiscCentre: widest ? hullReached(widest.x, widest.z) : null,
    widestDiscR: widest ? +widest.r.toFixed(2) : null,
    atSandBeyondRim: hullReached(ISLAND + 12, 0),
    pois: poiList.length, poisSealed: sealedPois.length, sealedPois: sealedPois.slice(0, 12),
  };
  flood.pass = flood.seeded && flood.atSpawn && flood.atWidestDiscCentre === false &&
    flood.atSandBeyondRim === false && flood.reachFrac > 0.05 && flood.poisSealed === 0;
  // ─── controls for the centre/pocket ruler ───
  // Both halves are built from measurements this scan takes here, not from ground remembered out of
  // an earlier run: the island is swept on a 4 m lattice for the point with the largest clear radius
  // and for the point whose BODY_R window carries the most drawn faces. A fat synthetic disc parked on
  // the first MUST read `merged` and MUST hide a pocket; the same disc laid across the second MUST NOT
  // read merged. Without that second half a `mergedCount: 0` is equally consistent with a ruler that
  // fires on everything and a filter that hides it.
  const distToSolid = (x, z, cap = 6) => {
    for (let r = G * 0.5; r <= cap; r += G) if (nearSolid(x, z, r)) return +r.toFixed(2);
    return cap;
  };
  let openest = null, fullest = null;
  const kw = Math.ceil(BODY_R / G);
  for (let x = -ISLAND + 6; x <= ISLAND - 6; x += 4) {
    for (let z = -ISLAND + 6; z <= ISLAND - 6; z += 4) {
      if (onVeil(x, z)) continue;
      const i = gi(x), j = gi(z);
      let c = 0;
      for (let di = -kw; di <= kw; di++) for (let dj = -kw; dj <= kw; dj++) {
        const p = i + di, q = j + dj;
        if (p >= 0 && q >= 0 && p < N && q < N && solid[p * N + q]) c++;
      }
      if (!fullest || c > fullest.c) fullest = { x, z, c };
      const d = distToSolid(x, z);
      if (!openest || d > openest.d) openest = { x, z, d };
    }
  }
  const ctlR = 2.6;
  const ctlParked = openest ? judge({ x: openest.x, z: openest.z, r: ctlR, emitted: true,
    prop: 'CONTROL:parked-on-open-sand' }) : null;
  const ctlDrawn = fullest ? judge({ x: fullest.x, z: fullest.z, r: ctlR, emitted: true,
    prop: 'CONTROL:laid-on-drawn-faces' }) : null;
  const emittedDiscs = discs.filter(d => d.emitted).length;
  controls.coverRuler = {
    r: ctlR, latticeStep: 4,
    openest: openest && { at: [openest.x, openest.z], clearToFace: openest.d },
    fullest: fullest && { at: [fullest.x, fullest.z], faceCellsInBodyWindow: fullest.c },
    parked: ctlParked && { merged: ctlParked.centreBare, pocketSamples: ctlParked.pocket },
    drawn: ctlDrawn && { merged: ctlDrawn.centreBare, pocketSamples: ctlDrawn.pocket },
    emittedDiscs,
    pass: !!(ctlParked && ctlDrawn) && ctlParked.centreBare && ctlParked.pocket > 0 &&
      !ctlDrawn.centreBare,
  };
  return JSON.stringify({
    anchors: { BODY_R, RIDE, ROOF: +ROOF.toFixed(3), TOL, ISLAND,
      // the imported ROOF against the vehicle actually in the page: relative error, 0 = agreement.
      roofCheck },
    discs: discs.length, meshes, bandFaces, faceBudget: FB === Infinity ? 'exact' : FB,
    offIslandFaces: offIsland, domeMeshes: domes,
    // what the sweep deliberately cannot see: the player's own vehicle, and the instance bookkeeping
    // — `seen` is what the traverse touched, `swept` is what the sampler consumed. Equal numbers mean
    // the instanced geometry was measured; a gap means part of the island was skipped.
    exemptRover: { meshes: roverMeshes, tris: Math.round(roverTris) },
    instancing: { seenMeshes: inst.seenMeshes, seenInstances: inst.seenInstances,
      sweptMeshes: inst.sweptMeshes, sweptInstances: inst.sweptInstances,
      truncatedMeshes: inst.truncated, covered: inst.seenInstances === inst.sweptInstances },
    // The coverage set, printed with the reading: which roots were swept, which were skipped and
    // why, how high their geometry stands over the sand (`maxAbove`, against RIDE 0.46 / ROOF),
    // and how many of its faces no disc stops. A root here with strays>0 is the ruler telling you
    // something new was added to the island.
    coverage: [...swept.entries()].map(([k, v]) => ({ root: k, faces: v.faces, strays: v.strays,
      maxAbove: +v.maxAbove.toFixed(2), skipped: v.skipped, why: v.why }))
      .sort((x, y) => y.strays - x.strays).slice(0, 24),
    staleExclusions: unseen,
    discSide: { rectless: rectlessDiscs, licensedBulgeSamples: licensedBulge, rimSamples },
    controls,
    reachability: flood,
    // Attribution self-check: lots only NAME a face, they never judge it, so `lots: 0` would turn
    // every stray into "outside every lot" and still print a plausible table.
    attribution: { lots: lots.length, cells: exp.length },
    exposedFaces: exp.reduce((s, e) => s + e.exposed, 0),
    sealedFaces, driveThroughCells: drive.length,
    driveThroughFaces: drive.reduce((s, e) => s + e.re, 0),
    wholeBodyFaces: drive.reduce((s, e) => s + e.reThrough, 0),
    sealedCells: sealedOnly.length,
    driveLicensed, driveUnlicensed: drive.length - driveLicensed,
    exposureByLot: byLot,
    exposure: drive.slice(0, 30),
    phantomCount: phantom.length, phantomFamilies: byFamP, phantom: phantom.slice(0, 20),
    overWideCount: overWide.length, overWideFamilies: byFamO, overWide: overWide.slice(0, 20),
    // An emitted disc whose rim mostly stands on nothing — the merged-post shape the tiler produces
    // when two thin parts land in one cell. `blanketArea` is the m² of collider floor with no drawn
    // wall under it, which is the number the "invisible rubber wall" complaint is about.
    blanketCount: blanket.length, blanketFamilies: byFamB, blanket: blanket.slice(0, 40),
    blanketArea: +blanket.reduce((s, x) => s + x.area, 0).toFixed(1),
    // The two centre/pocket readings, in m² of collider floor and with the rate the ruler fires at:
    // `merged` is a disc whose own centre has no drawn face within TOL (a wall the drawing does not
    // have), `hollow` is a disc that hides a spot BODY_R away from any face (a room it seals). Both
    // only ever fire on emitted discs, so `emittedDiscs` is their denominator.
    mergedCount: mergedAway.length, mergedFamilies: tally(mergedAway),
    merged: mergedAway.slice(0, 40),
    hollowCount: hollow.length, hollowFamilies: tally(hollow),
    hollowArea: +hollow.reduce((s, x) => s + x.pocketArea, 0).toFixed(1),
    hollow: hollow.sort((x, y) => y.pocketArea - x.pocketArea).slice(0, 40),
    // The emitter's own books, read beside the verdict. `driveThroughCells: 0` with `exposed: 0` in
    // the census is a genuinely sealed island; the same 0 with a large `exposed` means the pass saw
    // the faces and the covering maths still left them standing, which is a different defect.
    solidifier: SR,
    // Everything above measures one instant. A mineral spire is sunk into and scoured out of its own
    // drift after the build, so the discs its geometry drew have to enter and leave the collider list
    // with it — which means `discs` above is a snapshot of a moving set, and `solidifier.discs` is the
    // count the pass emitted. This is the ledger of the mover's own bookkeeping: `ghost` is a site
    // whose discs sit in the solver's list while no drawn part of it stands in the rover's band (the
    // invisible wall you circle without touching), `missing` is the mirror (a rock you drive
    // through), and `unwalled` is a site that was never given discs — the residue of a wall the
    // road licence refused. `rulerArmed` keeps the whole section honest: without the three fields it
    // would filter nothing and print `pass: true`.
    dynamic: (() => {
      const st = R.sites ? R.sites() : [];
      const armed = st.length > 0 && st.every(s => typeof s.wall === 'boolean'
        && typeof s.live === 'number' && typeof s.discs === 'number');
      const row = s => `#${s.id} ${s.site} buried=${s.buried} wall=${s.wall} ` +
        `live=${s.live}/${s.discs} taken=${s.taken}`;
      const ghost = st.filter(s => !s.wall && s.live > 0).map(row);
      const missing = st.filter(s => s.wall && s.live !== s.discs).map(row);
      const unwalled = st.filter(s => s.wall && s.discs === 0).map(row);
      return { sites: st.length, rulerArmed: armed, ghost, missing, unwalled,
      // The site discs the solver currently counts, against the same figure from the build pass.
        liveOfSites: st.reduce((a, s) => a + s.live, 0),
        ownedBySites: st.reduce((a, s) => a + s.discs, 0),
        pass: armed && !ghost.length && !missing.length && !unwalled.length };
    })(),
    // plan() is the layout's own audit — the pairs the discs form with each other and with the
    // streets. The emitter adds discs, so these counts move with it, and 【C】3 is phrased in them.
    site: (() => {
      const p = R.plan ? R.plan() : null;
      if (!p) return null;
      const n = k => (Array.isArray(p[k]) ? p[k].length : p[k]);
      return { blocks: n('blocks'), tight: n('tight'), intrusions: n('intrusions'),
        discs: n('discs'), abutments: n('abutments'),
        tightSample: (p.tight || []).slice(0, 8).map(t => `${t.a?.prop || t.a}@${t.b?.prop || t.b}`),
        blockSample: (p.blocks || []).slice(0, 8).map(t => `${t.a?.prop || t.a}@${t.b?.prop || t.b}`) };
    })(),
  }, null, 1);
})()
