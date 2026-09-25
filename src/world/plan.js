// ─── the site plan ───
// The base used to be authored the easy way round: each district was a pile of props at
// hand-typed offsets from a zone centre, and every prop's collision disc was a second hand-typed
// guess at what that pile occupied. Two independent guesses per prop, no rule linking them, and the
// result was 43 pairs of overlapping discs — pockets where the rover could enter but no legal
// position existed, which is what reads to a player as "WASD stopped working".
//
// This module is the single source of truth for the plan: the street grid, the one rule that keeps
// buildings off the roads, and the geometry that turns a building footprint into collision discs.
// Props are now placed on lots, and their colliders are derived from the lot they occupy rather
// than typed by hand a second time.

export const STREET_HW = 6;      // trafficable width, half of it either side of the centreline
export const PAVEMENT = 1.5;     // graded shoulder beyond the trafficable width
export const SETBACK = 4;        // first wall sits this far past the shoulder
export const CORRIDOR = 3.2;     // the rover needs this much daylight between two footprints

// CORRIDOR is 2 × BODY_R, which is the same number the hull's own keep-out is made of — so a pair of
// footprints that "just passes" CORRIDOR leaves 0.00 m of daylight, and physics (which pads every
// disc by BODY_R) reads a wall. MOUTH is what a *drivable* gap really needs, measured in daylight
// rather than in raw gap: 1.2 m is one hand-width of margin on each side of the hull, enough that a
// driver lined up with the mouth gets through and a driver who is not can still walk out along it.
// The number is not a taste call: it is the bar the driven census settled (a stance at 1.17 m of
// daylight pinned the rover, one at 4.0 m released it), and it lives here because two consumers have
// to agree on it — `scan()` in main.js, which reports seams, and the placement rules in props.js,
// which must not build a run of posts the scan will then call a fence.
export const MOUTH = 1.2;

// A 3x3 lattice of 60 m blocks with two avenues and two streets crossing between them. Every
// district owns one cell, so districts cannot overlap each other no matter how their interiors are
// composed, and the street grid is legible from orbit — which is the whole point of a base plan.
export const STREETS = [
  { id: 'west-avenue', a: [-30, -90], b: [-30, 90] },
  { id: 'east-avenue', a: [30, -90], b: [30, 90] },
  { id: 'south-street', a: [-90, -30], b: [90, -30] },
  { id: 'north-street', a: [-90, 30], b: [90, 30] },
];

export const CELL_EDGE = 30;     // centreline of the streets that bound a block

// How far a lot may sit from its cell centre: the street half-width, its shoulder and the setback,
// measured to the far corner of the footprint.
export const frontageLimit = (w, d) =>
  CELL_EDGE - (STREET_HW + PAVEMENT + SETBACK) + Math.hypot(w, d) / 2 - Math.min(w, d) / 2;

// The nearest street direction a building should present its front to.
export function faceOf(x, z) {
  const dx = CELL_EDGE - Math.abs(Math.abs(x) - CELL_EDGE) * (Math.abs(x) > CELL_EDGE ? 0 : 1);
  const ax = Math.abs(x), az = Math.abs(z);
  if (Math.max(ax, az) < CELL_EDGE) return 0;                 // inside the core: face south
  return ax > az ? (x < 0 ? Math.PI / 2 : -Math.PI / 2)       // west/east of the grid
                 : (z < 0 ? Math.PI : 0);                     // north/south of the grid
}

// A rectangle is not a circle, and forcing it to be one is what made props feel like they were
// surrounded by invisible rubber walls. Cover it with the fewest discs that still hold the outline:
// n discs strung along the long axis, each just big enough to pass through the corners it owns.
//
// The share each disc owns used to be floored at 3 m, and that floor is what turned a thin object
// into a fat wall: a 0.4 × 8.7 m gate panel tiled at one disc per 3 m is three discs of r 1.46,
// which is 1.26 m of keep-out in front of and behind a panel you can see through, and the driven
// seam census found a rover pinned against exactly that. The floor now follows the object's own
// short side down to 1.2 m, because a share that thin stops being a share of the outline and starts
// being a disc around empty ground. Coverage is not given up to get there: with share width `s` the
// radius is hypot(s/2, S/2) ≤ 0.71·s, so every disc still passes through the corners of the strip it
// owns, and a fat footprint (S ≥ 1.2) tiles exactly as it did — measured over the 136 lots of the
// built map (2026-09-25): 29 lots change, all of them thin, discs 184 → 228, worst bulge past a
// drawn outline 1.26 m → 0.38 m, and `starship`/`listening-post`/`hab-drum` untouched.
export const SHARE_MIN = 1.2;
export function coverDiscs(w, d, maxR = 9) {
  const L = Math.max(w, d), S = Math.min(w, d);
  let n = Math.max(1, Math.min(12, Math.ceil(L / Math.max(S, SHARE_MIN))));
  let r;
  do {
    r = Math.hypot(L / (2 * n), S / 2);
    if (r <= maxR || n >= 12) break;
    n++;
  } while (true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : -L / 2 + (L / n) * (i + 0.5);
    // `hw`/`hd` are the disc's own share of the rectangle, as half-extents along the rectangle's
    // axes. A reader that only has `r` cannot tell "a disc around a wide wall" from "an invisible
    // wall", because the bulge past the drawn outline is r minus the *short* half-side — and that
    // number is lost the moment the disc is emitted. Carrying it costs nothing and makes each disc
    // self-auditing (tools/disc-audit-probe.js is what reads it back).
    const wide = w >= d;
    out.push({ dx: wide ? t : 0, dz: wide ? 0 : t, r,
               hw: wide ? L / (2 * n) : S / 2, hd: wide ? S / 2 : L / (2 * n) });
  }
  return out;
}

// The same discs in world space, so a placement can be tested for clearance *before* it is
// committed rather than audited after the fact.
export function discLayout(w, d, cx, cz, ry = 0) {
  const cos = Math.cos(ry), sin = Math.sin(ry);
  return coverDiscs(w, d).map(p => ({
    x: cx + p.dx * cos + p.dz * sin, z: cz - p.dx * sin + p.dz * cos, r: p.r,
  }));
}

// The same rule for a point cloud nobody drew a rectangle for: the wall faces a boulder actually
// presents, or the risers of a stair, or a pipe run that was drawn in `put()` and therefore never
// went through `lot()`. `coverDiscs` cannot be used because its input is a width and a depth, and
// inventing those for an irregular silhouette is the hand-typed guess this module exists to end.
//
// The long axis comes from two farthest-point sweeps (the 2-approximation of the cloud's diameter)
// and sets the frame `hw`/`hd`/`ry` are reported in — the same convention `lot()` uses, and required
// by any consumer that tests containment, since an axis-aligned test against a rotated cloud
// measures a different piece of ground. The axis is *not* used to place the discs, and that is the
// whole content of this function. It used to: a chain of `k` seeds strung along the chord, each disc
// then stretched until it reached the points nearest its seed. For a cloud that is straight that is
// exact. For a cloud that curves or hollows, the chord is a lie — the four lamp posts of a teleport
// deck sit 3.9 m apart on a 2.75 m circle, so the farthest pair is a diameter, the perpendicular
// spread `W` is the other diameter, and the old budget asked for exactly one disc, which came out at
// r 2.76 parked on the deck's centre: a collider wall through the middle of the pad the drawing does
// not have (the audit calls the class `blanket`, and measured 31 of them across 11 families,
// 89.5 m²). So the cloud is now cut the way it is actually built:
//
//   1. into connected components, joined face-to-face at one `minShare` — past that distance one
//      disc would have to stand in the gap to speak for both, which is the defect, not the coverage;
//   2. then within a component by a nearest-neighbour walk, budgeted by the *length of that walk*
//      rather than by the chord's span, so a ring earns a disc per share of ring and a straight wall
//      keeps the same count it always had (its walk is its chord);
//   3. and each share's disc is measured, not derived — its centre is the midpoint of the share's own
//      farthest pair and `r` reaches the share's furthest point, so a disc is only as fat as the
//      geometry it was given. `hw`/`hd` are that point set's half-extents in the axis frame, so the
//      bulge the disc is entitled to (`r − min(hw, hd)`) stays the tiling maths rather than a wish.
//
// Deterministic by construction (buffer order, strict `>`/`<` ties to the lowest index, components
// visited in first-index order, `minShare` a constant rather than a data-derived threshold — the one
// value the audit and this file disagree about nothing else), so it adds no draw to the placement rng
// and cannot reshuffle a world that was already measured. Cost is O(n²) per component per bucket for
// the walk; buckets are `CELL`-sized and the exposed cloud averaged 73 points across 148 buckets.
export function coverPointDiscs(pts, minShare = 3) {
  const n = pts.length / 2;
  if (!n) return [];
  const px = i => pts[2 * i], pz = i => pts[2 * i + 1];
  let mx = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += px(i); mz += pz(i); }
  mx /= n; mz /= n;
  let ia = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const q = (px(i) - mx) ** 2 + (pz(i) - mz) ** 2;
    if (q > best) { best = q; ia = i; }
  }
  const ax = px(ia), az = pz(ia);
  let ib = ia; best = -1;
  for (let i = 0; i < n; i++) {
    const q = (px(i) - ax) ** 2 + (pz(i) - az) ** 2;
    if (q > best) { best = q; ib = i; }
  }
  const L = Math.sqrt(best);
  if (L < 1e-9) return [{ x: ax, z: az, r: 0, hw: 0, hd: 0, ry: 0 }];
  const bx = px(ib), bz = pz(ib);
  const ux = (bx - ax) / L, uz = (bz - az) / L;                 // unit vector along the long axis
  const cx = (ax + bx) / 2, cz = (az + bz) / 2;                 // the cloud's midspan on that axis
  // world → cloud basis, matching tools/disc-audit-probe.js `outsideRect`: u = x·cos ry − z·sin ry,
  // v = x·sin ry + z·cos ry. The u axis is (ux, uz), so cos ry = ux and sin ry = −uz.
  const ry = Math.atan2(-uz, ux);
  const uAt = (x, z) => (x - cx) * ux + (z - cz) * uz;
  const vAt = (x, z) => (x - cx) * uz - (z - cz) * ux;

  // ─── 1. components, joined at one share ───
  const root = Int32Array.from({ length: n }, (_, i) => i);
  const find = i => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
  const cellOf = new Map();
  const gi = v => Math.floor(v / minShare);
  for (let i = 0; i < n; i++) {
    const key = gi(px(i)) + ':' + gi(pz(i));
    let list = cellOf.get(key);
    if (!list) cellOf.set(key, list = []);
    list.push(i);
  }
  const reach = minShare * minShare;
  for (let i = 0; i < n; i++) {
    const gx = gi(px(i)), gz = gi(pz(i));
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = cellOf.get((gx + dx) + ':' + (gz + dz));
      if (!list) continue;
      for (const j of list) {
        if (j === i) continue;
        const ddx = px(j) - px(i), ddz = pz(j) - pz(i);
        if (ddx * ddx + ddz * ddz < reach) {
          const ra = find(i), rb = find(j);
          if (ra !== rb) root[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
    }
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let c = comps.get(r);
    if (!c) comps.set(r, c = []);
    c.push(i);
  }

  // ─── 2. and 3. one disc per share of walk, measured off its own points ───
  let budget = 12;                       // the same ceiling `coverDiscs` holds a footprint to
  const discs = [];
  for (const g of comps.values()) {
    const m = g.length;
    // Greedy nearest-neighbour walk from the component's lowest-index point. `arc[s]` is how far
    // along the drawn geometry the s-th walked point is, so a curve costs its true length.
    const used = new Uint8Array(m), walk = new Int32Array(m), arc = new Float64Array(m);
    walk[0] = 0; used[0] = 1;
    for (let s = 1; s < m; s++) {
      const ci = walk[s - 1];
      let q = Infinity, h = -1;
      for (let t = 0; t < m; t++) {
        if (used[t]) continue;
        const dx = px(g[t]) - px(g[ci]), dz = pz(g[t]) - pz(g[ci]);
        const d = dx * dx + dz * dz;
        if (d < q) { q = d; h = t; }
      }
      used[h] = 1; walk[s] = h; arc[s] = arc[s - 1] + Math.sqrt(q);
    }
    const P = arc[m - 1];
    // Every component must produce at least one disc: a bucket whose wall faces went unmeasured would
    // hand the audit an exposed, unlicensed face, which is a worse defect than overshooting the
    // ceiling by the number of components. A bucket is `CELL`-sized, so clouds here are one or two.
    const want = Math.ceil(P / minShare) || 1;
    const k = Math.max(1, Math.min(budget, want));
    budget -= k;
    for (let s = 0; s < k; s++) {
      // This share's points are the walk positions whose arc length falls in [s·P/k, (s+1)·P/k]. The
      // walk is monotone in arc, so every point lands in exactly one share: no face is measured twice
      // and none is dropped, which the chord lattice could not promise.
      const lo = P * s / k, hi = P * (s + 1) / k;
      const sh = [];
      for (let t = 0; t < m; t++) if (arc[t] >= lo && arc[t] <= hi) sh.push(g[walk[t]]);
      if (!sh.length) continue;
      // The share's own diameter, by the same two-sweep approximation the cloud's frame used: from the
      // first member to its farthest point, then from that point to *its* farthest point. Each sweep
      // has a fixed anchor — a sweep that moves its anchor as it goes converges on whichever point it
      // happened to reach last, not on the share's extent.
      let a = 0, best = -1;
      for (let i = 0; i < sh.length; i++) {
        const q = (px(sh[i]) - px(sh[0])) ** 2 + (pz(sh[i]) - pz(sh[0])) ** 2;
        if (q > best) { best = q; a = i; }
      }
      let b = a; best = -1;
      for (let i = 0; i < sh.length; i++) {
        const q = (px(sh[i]) - px(sh[a])) ** 2 + (pz(sh[i]) - pz(sh[a])) ** 2;
        if (q > best) { best = q; b = i; }
      }
      // centre = midpoint of the share's farthest pair; `r` = furthest member from it. For a share
      // along one line that is the share's own midpoint and half-length, which is what the old chain
      // produced for a straight wall; for a share that curves, the midpoint sits on the chord and `r`
      // is the chord's half-length plus its sagitta — measured, not a wish across it.
      const x = (px(sh[a]) + px(sh[b])) / 2, z = (pz(sh[a]) + pz(sh[b])) / 2;
      let r = 0, hw = 0, hd = 0;
      const cu = uAt(x, z), cv = vAt(x, z);
      for (const i of sh) {
        const d = Math.hypot(px(i) - x, pz(i) - z);
        if (d > r) r = d;
        const au = Math.abs(uAt(px(i), pz(i)) - cu), av = Math.abs(vAt(px(i), pz(i)) - cv);
        if (au > hw) hw = au;
        if (av > hd) hd = av;
      }
      discs.push({ x, z, r, hw, hd, ry });
    }
  }
  return discs;
}


// ─── what counts as a wall ───
// `coverPointDiscs` above has no opinion about *which* triangles to feed it, and both emitters
// (terrain.js `stoneMeasurement` for the scatter, props.js `solidify` for everything drawn without a
// footing) ask the same question. Two gates say "a wheel hits this" rather than "a wheel rolls over
// it": a face flatter than 45.6° from horizontal is a floor, tread or plate, and anything with less
// than 12 cm of vertical run is a kerb lip, which the rover climbs. The band these are read against —
// [ground + RIDE, ground + ROOF] — is the hull's own envelope and comes from physics.js.
// tools/disc-audit-probe.js is the judge of the result and restates both numbers on purpose: an
// emitter that handed the ruler its predicate could never be told it was wrong.
export const BAND_NY = 0.7;       // |normal·up| above this is a surface you drive over, not into
export const BAND_STEP = 0.12;    // vertical run below this is a step, not an obstacle

// Which authored object a disc belongs to. A prop built from legs is named `${id}#${i}`: a sign's
// three feet, a portal's four stanchions. They are one rigid object, so the crease between two of
// them is not a gap the rover can be trapped in any more than the lens between two discs of one
// building is. `audit` exempts same-family pairs; the measurement pass that emits discs has to agree
// with it, or the two would disagree about what "the same prop" is — so the rule is written once,
// here, and both consumers import it.
export const discFamily = s => (s || '').replace(/#\d+$/, '');

// How far one disc reaches past the kerb and its shoulder. Positive means it is standing in the road.
export const streetEncroach = (x, z, r) => {
  let worst = -Infinity;
  for (const s of STREETS) worst = Math.max(worst, STREET_HW + PAVEMENT - (distToSeg(x, z, s.a, s.b) - r));
  return worst;
};

// The audit the old layout could not pass. Two rules, both measured against the discs the physics
// loop actually reads:
//   * no district may stand in a carriageway — the shoulder is paved precisely so the rover never
//     has to steer around a building while it is in the lane;
//   * two different props must not have raw discs that *overlap*. Where they do, the crease between
//     them has no legal position in it at all, and a rover driven in gets two push-outs that fight —
//     the "WASD stopped working" bug. Any pair closer than CORRIDOR is reported too, because a
//     pinch of two discs plus a third behind them is a pocket with no escape direction in it, and
//     the only way to know the hub is clear is to measure every gap rather than assume a district
//     will not trap the player inside itself.
// Discs covering one and the same prop are exempt: they are strung along one axis, so their lens
// always has an escape perpendicular to it.
//
// The census of that last class, 2026-09-25, and what it took to empty it. The world then reported
// 45 `tight` pairs, which `scan()` groups into 33 seams standing next to drive-reached ground, and
// every one of those 33 was then *driven* rather than argued (tools/cdp-seam-drive.mjs parks the
// rover on the pair's cusp and holds full throttle on six headings; 4 m of travel without the
// unstick firing is what counts as out). Eight held the rover. Moving the corridor check out of the
// audit and into the placement site — `siteClear`/`kClear` for satellites in props.js, `putLamp`
// sliding along its own run instead of being skipped where it no longer fits, and the crew rover
// parked off its bay's leg line, which no garage this narrow can hold — emptied all eight.
//
// What survives is 7 pairs / 4 seams, each one measured to release: the spaceport gate's own leg and
// a plaza machine 1 cm off the bar (3.20), the starship against the LOX terminal that feeds it (2.38)
// and against the strongback that holds it (0.89), and the habitat's drum standing on the crater
// rampart it is sheltered by (1.60 to 3.10). That is the bar for this class, not "the counter reads
// zero": no stance the audit can name may hold a rover under the shipped physics, and a residual with
// no measurement next to its name is not an argument, it is the old default pass in better prose.
export function audit(items) {
  const blocks = [], tight = [], intrusions = [];
  const clearOf = STREET_HW + PAVEMENT;
  // A prop built from legs is named `${id}#${i}`: a sign's three feet, a portal's four
  // stanchions. They are one rigid object, so the crease between two of them is not a gap the
  // rover can be trapped in any more than the lens between two discs of one building is.
  const base = discFamily;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (const s of STREETS) {
      const d = distToSeg(a.x, a.z, s.a, s.b) - a.r;
      if (d < clearOf) intrusions.push({ id: a.id, street: s.id, encroach: +(clearOf - d).toFixed(1) });
    }
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.prop && base(a.prop) === base(b.prop)) continue;
      const gap = Math.hypot(a.x - b.x, a.z - b.z) - a.r - b.r;
      const at = [a.x, a.z, a.r, b.x, b.z, b.r];
      if (gap < 0) blocks.push({ a: a.id, b: b.id, gap: +gap.toFixed(1), at });
      // A wedge the rover cannot fit through is only a problem between *districts*: within one
      // district a corridor meeting its own module is supposed to be airtight.
      else if (gap < CORRIDOR) tight.push({ a: a.id, b: b.id, gap: +gap.toFixed(1), at });
    }
  }
  return { blocks, tight, intrusions };
}

// Does a ring of discs actually close? `audit` cannot answer this for the crater rampart: its discs
// are deliberately one object and deliberately interpenetrate, so every pair is exempt by the rule
// above. The question that matters is the one the exemption throws away — is there any path a rover
// centre can take from inside the ring to outside it. Flood the annulus over the cells no padded
// disc covers, starting from the inner edge; anything that reaches the outer edge is a hole.
// Cell size is the test's resolution (≈1.4 m of arc at the inner edge), so this is a cross-check on
// the placement arithmetic rather than a replacement for it — it catches a mis-sequenced ring, not
// a 40 cm slot.
export function sealCheck(discs, { r0 = 104, r1 = 130, body = 1.6, na = 480, nr = 28 } = {}) {
  const TAU = Math.PI * 2;
  const open = new Uint8Array(na * nr);
  const dr = (r1 - r0) / nr;
  for (let j = 0; j < nr; j++) {
    const r = r0 + (j + 0.5) * dr;
    for (let i = 0; i < na; i++) {
      const th = (i / na) * TAU;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      let blocked = false;
      for (const d of discs) {
        const dx = x - d.x, dz = z - d.z;
        if (dx * dx + dz * dz < (d.r + body) * (d.r + body)) { blocked = true; break; }
      }
      open[j * na + i] = blocked ? 0 : 1;
    }
  }
  // BFS from the inner edge outwards; `i` wraps, `j` does not.
  const seen = new Uint8Array(na * nr);
  const queue = [];
  for (let i = 0; i < na; i++) if (open[i]) { seen[i] = 1; queue.push(i); }
  let outer = 0;
  const reachOuter = new Uint8Array(na);
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], i = c % na, j = (c - i) / na;
    if (j === nr - 1) { outer++; reachOuter[i] = 1; }
    const nb = [((i + 1) % na) + j * na, ((i - 1 + na) % na) + j * na];
    if (j + 1 < nr) nb.push(i + (j + 1) * na);
    if (j > 0) nb.push(i + (j - 1) * na);
    for (const n of nb) if (open[n] && !seen[n]) { seen[n] = 1; queue.push(n); }
  }
  // Widest contiguous run of leaked angles, in metres of arc at the outer edge.
  let run = 0, widest = 0;
  for (let k = 0; k < na * 2 && run <= na; k++) {
    if (!reachOuter[k % na]) { run = 0; continue; }
    run++; widest = Math.max(widest, Math.min(run, na));
  }
  const holes = (() => {
    let n = 0;
    for (let i = 0; i < na; i++) if (reachOuter[i] && !reachOuter[(i - 1 + na) % na]) n++;
    return n;
  })();
  return { closed: outer === 0, holes, widest_m: +(widest / na * TAU * r1).toFixed(1) };
}

export function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}
