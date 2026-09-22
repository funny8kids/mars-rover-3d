import { fbm, vnoise, ridge, mulberry32, smoothstep, lerp, clamp } from '../utils/noise.js';
import { TERRAIN, ZONES, ISLAND } from '../config.js';
import { STREETS, STREET_HW } from './plan.js';

// ---- shallow decorative craters (outside the playfield, for silhouette) ----
const crater = (x, z, r, depth) => ({ x, z, r, depth: Math.min(depth, r * 0.12) });
export const craters = [
  crater(96, 74, 26, 3.2),
  crater(-102, -86, 30, 3.6),
  crater(24, -106, 22, 2.6),
  crater(-72, 98, 24, 3.0),
];
function craterProfile(d, r, depth) {
  const q = d / r;
  if (q > 1.9) return 0;
  if (q > 1) { const t = (q - 1) / 0.9; return depth * 0.7 * Math.sin(Math.PI * t) * (1 - t * 0.3); }
  return -depth * (1 - q * q) * (1 - q * 0.15);
}

// ---- flattened pads & roads ----
const pads = [];
for (const zn of Object.values(ZONES)) {
  if (zn.padHeight !== undefined) pads.push({ x: zn.pos[0], z: zn.pos[1], r: zn.radius, h: zn.padHeight });
}
// The carriageway the rover actually rolls on: the street grid from the site plan, flattened to the
// same engineered level as the pads. It used to be five spokes from the hub to each district, which
// is why every district ended up with its buildings arranged radially around a centre they shared
// with the plaza — a spoke layout gives you no intersections, no frontage and no block to sit a
// building on.
const roads = STREETS.map(s => [s.a, s.b, STREET_HW]);
function distToSeg(px, pz, a, b) {
  const ax = a[0], az = a[1], bx = b[0], bz = b[1];
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// ---- per-building cut & fill: the graded footings ----
// A pad circle flattens the ground around a district's centre; it has no idea where the buildings
// are. `heightAt` only guarantees flat ground inside r*0.62 of the zone centre, so a hull placed
// outside that core — the habitat's second dome sits 19.4 m out on a 22 m pad — stands on the dune
// blend, and seating its *centre* on that sample leaves the upslope rim in the air. props.js used
// to paper over it two ways: `rimY()` lifted a wide deck to the highest ground under its own
// footprint (which makes the whole thing float), or a hand-tuned `dy` pushed it back into the sand.
// Neither is ground engineering, and both are why the user saw 一个椭圆的房子浮空.
//
// A real site is graded lot by lot: the earthworks for one building are a rectangle around its own
// footprint, cut to the highest natural ground inside it so nothing pokes through the deck, and
// battered back to the surface at 1:3 so there is no step for a wheel to climb. `LOT_PAD` oversails
// the slab past the wall line, because a footing is always larger than what stands on it.
//
// The level is sampled from `baseHeightAt` — dunes, district pads and carriageways, but never other
// footings — so a lot's grade cannot depend on which lot was claimed first. Each claim is then a
// pure function of the site plan, and no convergence pass is needed.
//
// Lots are claimed while props are placed, i.e. after the terrain mesh exists, so `heightAt` is the
// analytic truth and the mesh is rebuilt from it once the plan is complete (terrain `regrade()`).
const lots = [];
const LOT_PAD = 1.2;         // metres of deck beyond the wall line
const BATTER = 3;            // 1 vertical : 3 horizontal — the angle a rover climbs without shifting
const SKIRT_MIN = 5, SKIRT_MAX = 16, SAMPLE = 2, SAMPLE_MAX = 22;

// signed distance to the lot's rectangle, in metres, negative inside the deck
function sdLot(l, x, z) {
  const dx = x - l.x, dz = z - l.z;
  const u = Math.abs(dx * l.cos - dz * l.sin) - l.hw;
  const v = Math.abs(dx * l.sin + dz * l.cos) - l.hd;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0);
}

export function lotAt(x, z) {
  let best = null, sd = Infinity;
  for (const l of lots) {
    const d = sdLot(l, x, z);
    if (d < sd) { sd = d; best = l; }
  }
  return best ? { id: best.id, h: +best.h.toFixed(2), sd: +sd.toFixed(2), skirt: +best.skirt.toFixed(1),
    w: +(best.hw * 2).toFixed(1), d: +(best.hd * 2).toFixed(1), rot: best.ry } : null;
}

// Cut to the highest natural ground *under the deck*, so nothing pokes through the slab, and read
// how far the surrounding surface falls away to size the batter. Sampled on a 2 m lattice over the
// deck plus its longest possible skirt — finer than the terrain mesh's 1.36 m vertices, far coarser
// than the noise that shapes the dunes.
function grade(l) {
  const r = Math.hypot(l.hw, l.hd) + SKIRT_MAX;
  const n = Math.min(SAMPLE_MAX, Math.max(2, Math.ceil((2 * r) / SAMPLE)));
  let top = -Infinity, low = Infinity;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const u = -r + (2 * r * i) / n, v = -r + (2 * r * j) / n;
      const h = baseHeightAt(l.x + u * l.cos + v * l.sin, l.z - u * l.sin + v * l.cos);
      // Only the ground the deck actually covers has to be beaten by the cut: raising the platform
      // to a crest 16 m outside its own edge would stack fill where there is nothing to support.
      if (Math.abs(u) <= l.hw && Math.abs(v) <= l.hd && h > top) top = h;
      if (h < low) low = h;
    }
  }
  l.h = top;
  const drop = top - low;
  // A 1.2 m shave on a flat lot stays a tidy shoulder; a 4 m cut into a dune flank gets a long
  // slope instead of a cliff.
  l.skirt = clamp(drop * BATTER + LOT_PAD, SKIRT_MIN, SKIRT_MAX);
}

// Four corners of a footprint in world space. The rotation props.js applies is `ry` about +Y,
// which sends a model's local (u,v) to world (u·cos + v·sin, −u·sin + v·cos) — the same algebra
// plan.js `discLayout` uses for its collision discs, so a lot and the collider that guards it
// always turn together.
const corners = (x, z, w, d, ry) => {
  const c = Math.cos(ry), s = Math.sin(ry), hw = w / 2, hd = d / 2;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [
    x + a * hw * c + b * hd * s, z - a * hw * s + b * hd * c]);
};

// `id` is the collision group: modules bolted into one pressure vessel are one structure, so they
// get one footing. Two hulls on two footings would leave a fold in the ground exactly where their
// shared corridor meets a wall. The merged rect is the AABB of every member's corners, taken in the
// frame of the first member — which is the frame the cluster was laid out in anyway.
export function claimLot({ id, x, z, w, d, ry = 0, move = false }) {
  const member = corners(x, z, w, d, ry);
  let l = lots.find(o => o.id === id);
  if (l) {
    if (move) {
      // An asset re-sited after its footing was cut: the slab follows it, so the rect it used to
      // occupy is let go rather than unioned in — otherwise a moved pad drags a phantom deck.
      l.parts = [member]; l.cos = Math.cos(ry); l.sin = Math.sin(ry); l.ry = ry; l.x = x; l.z = z;
    } else {
      l.parts.push(member);
    }
  } else {
    l = { id, x, z, cos: Math.cos(ry), sin: Math.sin(ry), ry, hw: 0, hd: 0, h: 0, skirt: SKIRT_MIN, parts: [member] };
    lots.push(l);
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const quad of l.parts) {
    for (const [px, pz] of quad) {
      const dx = px - l.x, dz = pz - l.z;
      const u = dx * l.cos - dz * l.sin, v = dx * l.sin + dz * l.cos;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;      // the deck's centre, in the cluster's own frame
  l.x += cu * l.cos + cv * l.sin;
  l.z += -cu * l.sin + cv * l.cos;
  l.hw = (u1 - u0) / 2 + LOT_PAD;
  l.hd = (v1 - v0) / 2 + LOT_PAD;
  grade(l);
  return l.h;
}

export const listLots = () => lots;

// The registry is the site plan, not a history: props.js rebuilds the whole base when the quality
// tier changes, and a footing left over from the previous pass would keep its cut in the ground.
export function resetLots() { lots.length = 0; }

// The terrain shader has to know exactly where the ground stops being sand and becomes a
// compacted deck — the dune ripples must not run across a landing pad. Mirror of the flattening
// above, deduplicated because several ZONES entries alias the same site.
export function paveGeometry() {
  const seen = new Set(), out = [];
  for (const p of pads) {
    const key = `${Math.round(p.x)},${Math.round(p.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([p.x, p.z, p.r]);
  }
  return {
    pads: out,
    roads: roads.map(([a, b, hw]) => [a[0], a[1], b[0], b[1], hw]),
  };
}

// How much of a graded building deck is under a point, 0..1. Mirrors the lot term of `pavedAt`, and
// sampled per terrain *vertex* rather than in the shader: with dozens of lots a rect-SDF loop would
// run 48 000 times a frame on an iGPU, while the mesh's own 1.36 m lattice is already far finer
// than any batter. It also makes the paving edge land exactly where the ground stops being flat.
export function deckAt(x, z) {
  let w = 0;
  for (const l of lots) {
    const k = 1 - smoothstep(0, l.skirt * 0.72, sdLot(l, x, z));
    if (k > w) w = k;
  }
  return w;
}

// Stylised island: a toy-plateau of gentle dunes ringed by a raised crater rim that
// drops into the haze — the whole world reads as one hand-placed diorama.
function rawHeight(x, z) {
  const r = Math.hypot(x, z);
  let h = 0;
  const calm = 1 - smoothstep(ISLAND.radius * 0.55, ISLAND.radius, r);   // flatten toward the middle
  h += (fbm(x * 0.014 + 3, z * 0.014 + 9, 3) - 0.5) * (1.1 + 3.4 * (1 - calm));
  h += (vnoise(x * 0.07, z * 0.07) - 0.5) * 0.35;
  h += smoothstep(ISLAND.radius, ISLAND.rim, r) * 8.5;                   // crater rim wall
  h -= smoothstep(ISLAND.rim, ISLAND.rim + 16, r) * 30;                  // cliff into the void
  for (const c of craters) h += craterProfile(Math.hypot(x - c.x, z - c.z), c.r, c.depth);
  return h;
}

// Natural ground as the site plan intends it: dunes, district pads, carriageways — and deliberately
// *not* the graded lots, so a footing's cut level is independent of every other footing.
function baseHeightAt(x, z) {
  let h = rawHeight(x, z);
  let w = 0, th = 0;
  for (const p of pads) {
    const d = Math.hypot(x - p.x, z - p.z);
    const k = 1 - smoothstep(p.r * 0.62, p.r + 20, d);
    if (k > w) { w = k; th = p.h; }
  }
  for (const [a, b, hw] of roads) {
    const d = distToSeg(x, z, a, b);
    const k = 1 - smoothstep(hw * 0.8, hw * 2.6, d);
    if (k > w) { w = k; th = 0.55; }
  }
  return lerp(h, th, w);
}

export function heightAt(x, z) {
  let h = baseHeightAt(x, z);
  let w = 0, th = h;
  for (const l of lots) {
    // Inside the deck the weight is exactly 1, so the platform is level to the millimetre — which
    // is what lets a hull be seated on `claimLot`'s return value and touch the ground on every rim.
    const k = 1 - smoothstep(0, l.skirt, sdLot(l, x, z));
    if (k > w) { w = k; th = l.h; }
  }
  return w > 0 ? lerp(h, th, w) : h;
}

// 0..1 — how paved (pad/road/deck) a point is, used for ground tinting
export function pavedAt(x, z) {
  let w = 0;
  for (const p of pads) {
    const k = 1 - smoothstep(p.r * 0.78, p.r * 1.06, Math.hypot(x - p.x, z - p.z));
    if (k > w) w = k;
  }
  for (const [a, b, hw] of roads) {
    const k = 1 - smoothstep(hw * 0.9, hw * 1.9, distToSeg(x, z, a, b));
    if (k > w) w = k;
  }
  for (const l of lots) {
    // The batter is compacted fill, so the deck covering runs most of the way down it; the last
    // sliver is left as loose sand, which is how a real pad edge blows out after a season.
    const k = 1 - smoothstep(0, l.skirt * 0.72, sdLot(l, x, z));
    if (k > w) w = k;
  }
  return w;
}

// ─── the surface the player actually sees ───
let grid = null, gSeg = 0, gSize = 0;
export function installSurfaceGrid(nodes, seg, size) {
  grid = nodes; gSeg = seg; gSize = size;
}
export function surfaceAt(x, z) {
  if (!grid) return heightAt(x, z);
  const cell = gSize / gSeg;
  const fx = (x + gSize / 2) / cell, fz = (z + gSize / 2) / cell;
  const i = clamp(Math.floor(fx), 0, gSeg - 1), j = clamp(Math.floor(fz), 0, gSeg - 1);
  const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
  const w = gSeg + 1;
  const a = grid[j * w + i], d = grid[j * w + i + 1];
  const b = grid[(j + 1) * w + i], c = grid[(j + 1) * w + i + 1];
  return tx + tz <= 1
    ? a + (d - a) * tx + (b - a) * tz
    : c + (b - c) * (1 - tx) + (d - c) * (1 - tz);
}
export function surfaceSlope(x, z) {
  const e = 0.8;
  const gx = (surfaceAt(x + e, z) - surfaceAt(x - e, z)) / (2 * e);
  const gz = (surfaceAt(x, z + e) - surfaceAt(x, z - e)) / (2 * e);
  return Math.hypot(gx, gz);
}
export function normalAt(x, z, out) {
  const e = 0.6;
  const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
  const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
  const nx = hL - hR, nz = hD - hU, ny = 2 * e;
  const l = Math.hypot(nx, ny, nz);
  out = out || { x: 0, y: 1, z: 0 };
  out.x = nx / l; out.y = ny / l; out.z = nz / l;
  return out;
}
export function slopeAt(x, z) {
  const n = normalAt(x, z);
  return Math.acos(clamp(n.y, -1, 1));
}
export { smoothstep };
