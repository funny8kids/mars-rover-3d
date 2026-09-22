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

export function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}
