import { fbm, vnoise, ridge, mulberry32, smoothstep, lerp, clamp } from '../utils/noise.js';
import { TERRAIN, ZONES, ISLAND } from '../config.js';
import { STREETS, STREET_HW } from './plan.js';

// ─── the ground's frame of reference ───
// A dune field answers the *seasonal resultant* of the wind, not the storm you happen to be
// standing in. So the ridge train is laid square to one fixed bearing here, while the dust veil at
// the boundary leans with whatever the weather is doing that minute. Both are correct, and the gap
// between them is what makes the sand look like it has been here longer than the base has.
const WIND_A = 0.42;                                            // radians, +X toward +Z
const WIND = { x: Math.cos(WIND_A), z: Math.sin(WIND_A) };
const alongW = (x, z) => x * WIND.x + z * WIND.z;               // metres downwind
const crossW = (x, z) => x * WIND.z - z * WIND.x;               // metres across it

// fbm's output band is 0..(1 - 2^-octaves), so comparing it against a fixed threshold meant
// re-deriving that band at every call site. `nz` puts it back in 0..1.
const nz = (x, y, oct) => clamp(fbm(x, y, oct) / (1 - Math.pow(0.5, oct)), 0, 1);

// ...and `nz` is only *arithmetically* normalised. fbm's theoretical ceiling needs the lattice to be
// walked to a high cell, and every field below is sampled across a handful of cells, so the values
// actually land in roughly 0.07..0.34 however `nz` scales them. A threshold written against the
// middle of 0..1 therefore reads "off" nearly everywhere: measured over the whole island the
// dominant dune family ran at 2.5% of its own amplitude on 76% of the map, and the yardang spacing
// resolved to 16-18 m while being written as 26. `sand` re-scales one field onto its real span, so
// a threshold can be read as the fraction of the island it lets through.
//
// The band is a measurement, not a derivation — see /tmp/probe_gates.mjs. Re-measure it if the
// frequencies below ever move by an order of magnitude.
const SAND_SPAN = 0.34 - 0.07;
const sand = (x, y, oct) => clamp((nz(x, y, oct) - 0.07) / SAND_SPAN, 0, 1);

// Value noise sampled *on a circle* is periodic in the angle — the only way to give a ring-shaped
// feature an azimuth that does not snap back where it started. `ref` is the circle's ground radius
// and `arc` the wavelength in metres along it, so the result is a function of bearing alone. That
// matters: what varies along a rim is its elevation, not its cross-section, and feeding the *live*
// radius in here made the wall vary radially instead and cancel itself out.
function bearingNoise(th, ref, arc, seed) {
  const k = ref / arc;
  return vnoise(Math.cos(th) * k + seed, Math.sin(th) * k - seed * 0.7);
}
// ...centred and scaled to -1..1, mean 0, so a term written as `base + amp * bn(...)` keeps the
// base where the old flat version had it and only wanders around that.
const bn = (th, ref, arc, seed) => (bearingNoise(th, ref, arc, seed) - 0.5) * 2;

// ─── sand: a transverse dune ridge train ───
// Three families rather than one because one sine is a corrugation, and real crest lines fork,
// bow, pinch out and start again downwind. That needs at least a second wavelength to interfere
// with, and a third long low wave for the ridges to sit on.
//
// The wavelengths are floored by the mesh, not chosen by taste: terrain.js builds its grid at
// TERRAIN.seg over 300 m, i.e. one vertex every 1.36 m, so anything under ~15 m per wavelength
// arrives as a blur with a hard edge on the wrong side of each vertex.
const DUNES = [
  { lam: 34, amp: 1.60, ws: 0.0085, as: 0.0104, seed: 41.3 },   // the dominant ridge
  { lam: 21, amp: 0.75, ws: 0.0125, as: 0.0155, seed: 12.8 },   // short, forks between them
  { lam: 60, amp: 0.90, ws: 0.0052, as: 0.0071, seed: 63.5 },   // the sand wave under them
];
// Fraction of the wavelength owned by the stoss slope; the lee side gets what is left. Calibrated
// against the mesh: at 0.72 the dominant ridge avalanched over 9.5 m for 1.35 m of drop, i.e. a
// 8°lee slope, which is a bump with a direction rather than a dune. 0.80 puts the slip faces at
// 12-15° at full swell — still gentler than the 32° of angle of repose, but a 1.4 m vertex lattice
// cannot hold a steeper facet than this without rounding it back into the bump it was meant to be.
const TC = 0.80;
// Integral of the profile below over one wavelength: stoss ∫(t/TC)^0.8 = TC/1.8, lee = (1−TC)/2.
// The train is subtracted back to zero mean with it, so a dune field mounds the ground where it is
// thick and does not lift the whole island a metre on the strength of a shape function.
const DUNE_MEAN = (TC / 1.8 + (1 - TC) / 2) * DUNES.reduce((s, F) => s + F.amp, 0);
function duneTrain(u, v, F) {
  // Crest lines bow by up to half a wavelength along strike. Written against `nz` this was a
  // constant phase shift instead of a wander, which is half of why the train looked machine-laid.
  const wander = (sand(v * F.ws + F.seed, 3.1, 2) - 0.5) * F.lam;
  const lam = F.lam * (1.02 + 0.22 * (sand(v * 0.0092 + F.seed * 1.7, 8.9, 2) - 0.5) * 2);
  const p = (u + wander) / lam;
  const t = p - Math.floor(p);
  // Sand creeps up a long, gently convex stoss slope, piles to a crest it can no longer hold, then
  // avalanches down a *planar* slip face. The straight facet is the whole read: it is the difference
  // between a dune and a bump, and the mesh's own vertex normals are what shade it.
  const shape = t < TC ? Math.pow(t / TC, 0.8) : 1 - (t - TC) / (1 - TC);
  // ...and the ridge is only there where sand was fed: open over the middle six-tenths of the
  // field, pinching out along strike where the supply runs short.
  return shape * smoothstep(0.08, 0.60, sand(v * F.as + F.seed * 2.3, 9.1, 2));
}

// ─── bedrock the sand has been blown off of ───
// Yardangs are ridges scoured *along* the wind, which is the one thing a dune field and a yardang
// field never agree on: the same air builds cross-wind crests where there is sand to build with and
// carves down-wind grooves where there is not. So both read off one cover survey and trade off.
//
// 26 m spacing, not the 13.5 m this started at: the tighter grooves were the steepest thing on the
// whole island inside the drive band — they stacked onto the rim of the (24,-106) crater and put one
// cell over the 0.70 slope gate, and their narrowest modulation sat under the mesh floor above. The
// measured open-desert relief is unchanged by the widening (1.04 m vs 1.09 m), so the cost was only
// ever the hazard, and real yardangs are tens of metres apart anyway.
//
// That widening did not take effect until `sand` existed: `nz` there resolved to 0.62..0.70 of the
// nominal spacing, so the grooves were actually 16-18 m apart and read as corduroy across the whole
// deflation plain. Two more things it needs, both of the same kind — the spacing must vary along
// strike or the pattern is a comb, and the ridges must snake, because a scour line that is straight
// for 200 m is drawn, not eroded.
function yardangs(u, v) {
  const lam = 26 * (0.86 + 0.28 * (sand(u * 0.0061 + 7.7, 2.2, 2) - 0.5) * 2);
  const p = (v + (sand(u * 0.0105 + 2.6, 5.3, 2) - 0.5) * lam * 1.7) / lam;
  const t = p - Math.floor(p);
  const ridgeShape = 1 - Math.pow(Math.abs(2 * t - 1), 1.7);    // flat crowns, scoured floors
  // Bedrock is exposed only where the winnowing found a weak seam; elsewhere the plain is buried
  // and the ridges die out. Mean of ridgeShape over a period is 1 - 1/2.7 = 0.63, so 0.63 times the
  // mean amplitude is subtracted to keep the field from lowering the whole plain by a third of a
  // metre on the strength of its own shape function.
  const amp = 0.12 + 0.88 * sand(u * 0.0108 + 4.4, 6.1, 2);
  return ridgeShape * amp - 0.63 * (0.12 + 0.44);
}

// How much of a point the drift cover still owns: 1 is sand to the horizon, 0 is deflation plain
// scoured down to bedrock. Slow, tens-of-metres fields — sand sheets do not change their mind.
// 0.57..0.80 of the measured span gives ~58% sand, ~31% pinch-out. Those bounds are the old
// 0.224..0.285 of `nz` restated in `sand` units, so the balance is unchanged; only the fields that
// were still reading against the theoretical middle have moved.
const sandCover = (x, z) => smoothstep(0.57, 0.80, sand(x * 0.013 + 13.7, z * 0.013 + 29.4, 3));

// ─── shallow craters, outside the playfield, for the silhouette ───
const crater = (x, z, r, depth, seed = 1) => ({ x, z, r, depth: Math.min(depth, r * 0.12), seed });
export const craters = [
  crater(96, 74, 26, 3.2, 2.7),
  crater(-102, -86, 30, 3.6, 8.1),
  crater(24, -106, 22, 2.6, 13.4),
  crater(-72, 98, 24, 3.0, 5.9),
  crater(-18, 128, 17, 2.0, 17.2),
  crater(126, 22, 20, 2.4, 21.8),
];
function craterProfile(dx, dz, c) {
  const th = Math.atan2(dz, dx);
  // No impact bowl is round at this scale, and a perfect circle is the read that gives away a
  // lathe. The rim wanders ±13%, and where the shock loosed a slump block the crest drops out.
  const r = c.r * (1 + 0.13 * bn(th, c.r, 22, c.seed));
  const q = Math.hypot(dx, dz) / r;
  if (q > 2.0) return 0;
  const crest = 1.0 + 0.45 * bn(th, c.r, 15, c.seed + 1.3);
  if (q > 1) {
    const t = (q - 1) / 1.0;
    // ejecta blanket: the rim crest, then a lobe of thrown-out material thinning away downwind
    return c.depth * crest * Math.sin(Math.PI * Math.min(t / 0.9, 1)) * (1 - t * 0.35)
      + c.depth * 0.22 * Math.exp(-(q - 1) * 2.4) * (0.5 + 0.5 * bn(th, c.r, 26, c.seed + 4.1));
  }
  return -c.depth * (1 - q * q) * (1 - q * 0.15);
}

// ─── the crater rim that encloses the island ───
// This used to be `smoothstep(radius, rim, r) * 8.5`: one number, a function of radius alone. Both
// of those are why the horizon read as a drum — a wall of constant height on a constant radius has
// a perfectly straight top edge, and a straight horizontal line at the end of a natural landscape
// is level design, not a planet. Real impact ramps are variable in elevation, breached where wash
// cut through them, and scarred on the inside by slump blocks. All four are azimuthal, so all four
// live here, and none of them cost a vertex.
function rimWall(th, r) {
  const tall = 9.4 + 3.2 * bn(th, 130, 300, 3.1) + 1.5 * bn(th, 130, 95, 8.4) + 0.8 * bn(th, 130, 34, 5.7);
  // Gaps where the sand has cut clean through the rampart. Without them the wall is unbroken
  // whatever else it does, and an unbroken wall is the thing being fixed.
  const breach = smoothstep(0.30, 0.58, bearingNoise(th, 130, 420, 11.9));
  // Where the wall starts and where its crest line runs — also by bearing, so the top edge is a
  // ridge meandering in plan rather than one compass-drawn circle.
  const foot = ISLAND.radius - 5 + 6 * bn(th, 130, 240, 2.2);
  const crestR = foot + 13 + 8 * bn(th, 130, 160, 6.6);
  let s = smoothstep(foot, crestR, r);
  // Slump scars on the inner flank: five shallow terraces between the desert floor and the crest,
  // which is where a wall this tall has actually failed. Only mid-climb — a smooth foot and a sharp
  // crest are both things real rims keep.
  s += s * 0.075 * Math.sin(s * Math.PI * 5.0) * smoothstep(0.04, 0.30, s) * (1 - smoothstep(0.62, 0.98, s));
  const rise = Math.max(1.5, tall) * (0.18 + 0.82 * breach) * s;
  // ...and the far side is not a floor, it is the next formation down.
  const voidR = crestR + 7 + 6 * bn(th, 130, 150, 7.1);
  const drop = smoothstep(voidR, voidR + 14, r) * (29 + 8 * bn(th, 130, 210, 1.4));
  return rise - drop;
}

// Stylised island: a toy-plateau of dunes ringed by a raised crater rim that drops into the haze —
// the whole world reads as one hand-placed diorama.
function rawHeight(x, z) {
  const r = Math.hypot(x, z);
  const calm = 1 - smoothstep(ISLAND.radius * 0.70, ISLAND.radius, r);   // flatten toward the middle
  // The basement swell under everything: not a dune, the weathered highland the sand sheet rests
  // on and the rampart is cut from. It stays at 1.0 m of amplitude across the playfield and only
  // grows outside it, because measured against the wheel it is the worst relief in the world here —
  // pinning the dune train to zero and sweeping the bands still gave 34° slopes at r≈103 from this
  // term alone, and 3.4 m of extra amplitude at the boundary is free: that ground is behind the
  // veil. Landform the player can drive on is shaped by the dunes; the rim is shaped by this.
  let h = (fbm(x * 0.014 + 3, z * 0.014 + 9, 3) - 0.5) * (1.0 + 2.6 * (1 - calm));
  h += (vnoise(x * 0.07, z * 0.07) - 0.5) * 0.35;

  // Drift thickens toward the sand source, which is the boundary: the ridges the rover can put
  // itself between inside the playfield become the ones it cannot climb at the edge of the map.
  // It also puts the relief where the eye actually looks — a ridge line crossing 40 m of desert
  // at the horizon carries the silhouette, the same ridge 12 m in front of the camera is a bump
  // the wheel drives over without comment.
  const u = alongW(x, z), v = crossW(x, z);
  const swell = 0.55 + 0.45 * smoothstep(40, 96, r) + 1.15 * smoothstep(99, 124, r);
  const cover = sandCover(x, z);
  let dunes = 0;
  for (const F of DUNES) dunes += duneTrain(u, v, F) * F.amp;
  h += (dunes - DUNE_MEAN) * cover * swell;
  h += yardangs(u, v) * (1 - cover) * swell * 1.15;

  for (const c of craters) h += craterProfile(x - c.x, z - c.z, c);
  h += rimWall(Math.atan2(z, x), r);
  return h;
}

// ---- flattened pads & roads ----
// `BATTER` is the one cut-and-fill rule the whole island shares: a change of level has to be
// spread over three times its height, which is the slope a rover climbs without unlocking a wheel.
// It is declared here rather than down with the footings because the district pads need it too.
const LOT_PAD = 1.2;         // metres of deck beyond the wall line
const BATTER = 3;            // 1 vertical : 3 horizontal — the angle a rover climbs without shifting
const pads = [];
for (const zn of Object.values(ZONES)) {
  if (zn.padHeight !== undefined) pads.push({ x: zn.pos[0], z: zn.pos[1], r: zn.radius, h: zn.padHeight });
}
// How far each district's cut actually has to be batted back into the desert, measured against the
// ground line just outside its own rim.
//
// This used to be a literal: `gradePad` ran to `r + 20` for every pad on the island. Nine pads of
// padHeight 0.4..0.6 m therefore each wore a collar two to three times longer than their own fill
// requires — a 0.6 m drop is 1.8 m of batter at 1:3, not 20 — and because those collars overlap,
// *every* point inside r<40 sat at a grade weight above 0.5. The blend is a lerp onto the pad level,
// so flattening the whole drive band that way is what put the dunes under the rover's wheels, not
// the dune field failing to generate. Measured through the live `heightAt` on one seeded 6 000-point
// set, with all 22 lots claimed: pad-top relief inside r<40 went 0.76 -> 0.90 m and the outer band
// r40-90 went 2.58 -> 2.97 m, and peak slope stayed under the 30 degree gate (28.8 deg at (9,-91),
// which is crater flank, not earthworks).
//
// The width is the *worst* bearing, not the average, because gradePad is radial and one pad cannot
// have nine different edges without becoming the per-bearing rim code. Samples start at the rim and
// are clipped to r < 0.82 * ISLAND.radius: the launch pad sits 85 m out, so an unfiltered ring walks
// off the edge of the world and reads the rim wall's 29 m drop into the void as a neighbour to blend
// with — that is how this measurement first came back asking for 89 m of batter on a 0.6 m pad.
//
// Narrowing the collar is what exposed a second, worse bug, and `gradePad`'s inner stop is the fix,
// so the two have to be reasoned about together. `grade()` cuts a building footing to the highest
// *natural* ground under its own deck, sampled through `baseHeightAt`. While the pad ramp started at
// 0.62r, a district's outer annulus was only ~0.69 level, so 31 % of a dune crest still came through
// underfoot at the plaza edge; a footing out there inherited that crest as its slab level. Measured:
// a habitat-district rim lot came in at 1.53 m on a plaza whose datum is 0.5, i.e. a 1.03 m plinth
// stacked on top of a paved square, and because `baseHeightAt` picks its target level by argmax over
// the fields, the crossover with the neighbouring pad turned that into a 41 deg face at (-42,67)
// where the old fat collar had kept it to 18 deg. Holding the pad dead level to its own rim makes
// every footing read the datum it actually sits in — lot levels came back to 0.4..0.8, all inside
// the padHeight range — and the same point is now 14 deg. It also puts the painted plate and the
// cut ground in the same place: `deckPad` lays plate from 0.78r, and plate over uncut sand was the
// whole complaint in the first place.
const PAD_RING = 30;                       // metres beyond the rim to look for the ground line
for (const p of pads) {
  let mx = -Infinity, mn = Infinity;
  for (let th = 0; th < Math.PI * 2; th += 0.05) {
    const ct = Math.cos(th), st = Math.sin(th);
    for (let d = p.r; d <= p.r + PAD_RING; d += 3) {
      const x = p.x + ct * d, z = p.z + st * d;
      if (Math.hypot(x, z) > ISLAND.radius * 0.82) continue;
      const n = rawHeight(x, z);
      if (n > mx) mx = n;
      if (n < mn) mn = n;
    }
  }
  p.batter = clamp(Math.max(mx - p.h, p.h - mn) * BATTER + LOT_PAD, 5, 16);
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
    const k = deckLot(l, sdLot(l, x, z));
    if (k > w) w = k;
  }
  return w;
}

// ─── deck vs grade: two different questions about the same site plan ───
// *Deck* is "is there sintered plate underfoot" — a plaza paved to its rim, a carriageway to its
// shoulder, a footing to its slab line. *Grade* is "has the earth been cut or filled to an engineered
// level", which has to run further out because the cut has to be batted back to the desert at a slope
// a wheel can climb. They are not the same extent, and the terrain shader used to read the grade
// falloff for both — so every district wore a collar of concrete plate as wide as its earthworks and
// every street a paved band 2.6× its carriageway width. Measured against the live fields: 100% of the
// island inside r<40 and 92% inside r<75 carried a deck weight above 0.5, and the "Martian desert"
// the rover drives across was a flat jointed slab with dunes in the remaining 5%.
//
// `terrain.js` rsbDeckPad/rsbDeckRoad are the same two bands written in GLSL; change one, change the
// other, or the vertex tint and the painted plate separate at the deck edge.
const deckPad = (p, d) => 1 - smoothstep(p.r * 0.78, p.r * 1.06, d);
const deckRoad = (hw, d) => 1 - smoothstep(hw * 0.90, hw * 1.14, d);
const deckLot = (l, s) => 1 - smoothstep(0, l.skirt * 0.72, s);
// Level to the rim, then batted back: a district plaza that is only ~0.69 level inside its own edge
// leaks dune crest into `grade()`'s footing cut. See the PAD_RING block above.
const gradePad = (p, d) => 1 - smoothstep(p.r, p.r + p.batter, d);
const gradeRoad = (hw, d) => 1 - smoothstep(hw * 0.8, hw * 2.6, d);
const gradeLot = (l, s) => 1 - smoothstep(0, l.skirt, s);

// Natural ground as the site plan intends it: dunes, district pads, carriageways — and deliberately
// *not* the graded lots, so a footing's cut level is independent of every other footing.
function baseHeightAt(x, z) {
  let h = rawHeight(x, z);
  let w = 0, th = 0;
  for (const p of pads) {
    const k = gradePad(p, Math.hypot(x - p.x, z - p.z));
    if (k > w) { w = k; th = p.h; }
  }
  for (const [a, b, hw] of roads) {
    const k = gradeRoad(hw, distToSeg(x, z, a, b));
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
    const k = gradeLot(l, sdLot(l, x, z));
    if (k > w) { w = k; th = l.h; }
  }
  return w > 0 ? lerp(h, th, w) : h;
}

// 0..1 — how much sintered plate is under a point. Used for the ground tint, and mirrored in the
// shader for the painted joints, centreline and hazard chevrons.
export function pavedAt(x, z) {
  let w = 0;
  for (const p of pads) {
    const k = deckPad(p, Math.hypot(x - p.x, z - p.z));
    if (k > w) w = k;
  }
  for (const [a, b, hw] of roads) {
    const k = deckRoad(hw, distToSeg(x, z, a, b));
    if (k > w) w = k;
  }
  for (const l of lots) {
    const k = deckLot(l, sdLot(l, x, z));
    if (k > w) w = k;
  }
  return w;
}

// 0..1 — how much of the point has been cut or filled to an engineered level, which reaches further
// out than the deck because of the batter. Scattering must answer *this* one: a loose boulder is
// fine on open sand and absurd halfway down a compacted shoulder, and the two extents are different.
export function gradedAt(x, z) {
  let w = 0;
  for (const p of pads) {
    const k = gradePad(p, Math.hypot(x - p.x, z - p.z));
    if (k > w) w = k;
  }
  for (const [a, b, hw] of roads) {
    const k = gradeRoad(hw, distToSeg(x, z, a, b));
    if (k > w) w = k;
  }
  for (const l of lots) {
    const k = gradeLot(l, sdLot(l, x, z));
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
