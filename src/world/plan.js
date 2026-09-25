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
export function coverDiscs(w, d, maxR = 9) {
  const L = Math.max(w, d), S = Math.min(w, d);
  let n = Math.max(1, Math.ceil(L / Math.max(S, 3)));
  let r;
  do {
    r = Math.hypot(L / (2 * n), S / 2);
    if (r <= maxR || n > 12) break;
    n++;
  } while (true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : -L / 2 + (L / n) * (i + 0.5);
    out.push(w >= d ? { dx: t, dz: 0, r } : { dx: 0, dz: t, r });
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
  const base = s => (s || '').replace(/#\d+$/, '');
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
