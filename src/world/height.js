import { fbm, vnoise, ridge, mulberry32, smoothstep, lerp, clamp } from '../utils/noise.js';
import { TERRAIN, ZONES } from '../config.js';

// ---- deterministic crater field ----
const rand = mulberry32(20260919);
export const craters = [];
// Depth is capped against radius: the bowl's steepest point is at its rim, and a deep narrow
// crater there is a 35°+ wall — the rover slides down it airborne, leans onto the 23° body
// clamp and cannot climb back out. 0.13·r keeps the walls near 15°, so craters are traps you
// can drive out of rather than into.
const crater = (x, z, r, depth) => ({ x, z, r, depth: Math.min(depth, r * 0.13) });
for (let i = 0; i < 16; i++) {
  const a = rand() * Math.PI * 2;
  const r = 260 + rand() * 820;
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  let ok = true;
  for (const k of ['launch', 'production', 'tanks', 'habitat', 'watch']) {
    const p = ZONES[k].pos;
    if (Math.hypot(x - p[0], z - p[1]) < ZONES[k].radius + 130) ok = false;
  }
  if (!ok) continue;
  craters.push(crater(x, z, 40 + rand() * 95, 6 + rand() * 16));
}
craters.push(crater(480, 430, 85, 14));    // Roadster's crater
craters.push(crater(560, 120, 70, 12));
craters.push(crater(-500, -380, 100, 16));
craters.push(crater(-420, 330, 60, 8));    // night overlook ring

// ---- flattened pads & roads ----
const pads = [];
for (const k of ['launch', 'production', 'tanks', 'habitat', 'watch', 'night']) {
  const zn = ZONES[k];
  if (zn.padHeight !== undefined) pads.push({ x: zn.pos[0], z: zn.pos[1], r: zn.radius, h: zn.padHeight });
}
const roads = [
  [ZONES.launch.pos, ZONES.watch.pos, 10], [ZONES.watch.pos, ZONES.habitat.pos, 9],
  [ZONES.watch.pos, ZONES.tanks.pos, 9], [ZONES.tanks.pos, ZONES.production.pos, 9],
  [ZONES.production.pos, ZONES.launch.pos, 9],
];
function distToSeg(px, pz, a, b) {
  const ax = a[0], az = a[1], bx = b[0], bz = b[1];
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
function craterProfile(d, r, depth) {
  const q = d / r;
  if (q > 1.9) return 0;
  // raised rim ring outside the rim — spread over 0.9·r so its flank stays walkable
  if (q > 1) { const t = (q - 1) / 0.9; return depth * 0.7 * Math.sin(Math.PI * t) * (1 - t * 0.3); }
  return -depth * (1 - q * q) * (1 - q * 0.15);
}
function rawHeight(x, z) {
  let h = 0;
  h += (fbm(x * 0.0016, z * 0.0016, 4) - 0.5) * 84;          // mega dunes
  h += (fbm(x * 0.0062, z * 0.0062, 4) - 0.5) * 14;          // medium dunes
  h += ridge(x * 0.0028 + 7.3, z * 0.0028 + 2.1, 3) * 10;    // ridges
  h += (vnoise(x * 0.045, z * 0.045) - 0.5) * 1.6;           // ripples
  h += (vnoise(x * 0.13 + 31, z * 0.13 + 17) - 0.5) * 0.45;  // gravel bump
  for (const c of craters) h += craterProfile(Math.hypot(x - c.x, z - c.z), c.r, c.depth);
  const r = Math.hypot(x, z);
  h += smoothstep(1050, 1500, r) * (150 + (fbm(x * 0.002, z * 0.002, 3) - 0.5) * 160); // rim mountains
  return h;
}
// ---- campus relief grading ----
// The pads and roads are graded to a common ~+1 m datum, but the raw field puts that spot
// 40 m down in a mega-dune trough: blending straight to the datum over a 10 m shoulder left
// 75° cliffs across every mission route, and 5.7% of the campus surface was steeper than the
// rover's 23° body-pitch limit (it slid down them airborne, hull under the visible ground).
// So inside the compound the relief is squashed toward the datum first, then eased back to raw
// dunes over a wide shoulder — a graded site in rising dunes instead of a plateau with sheer edges.
const CAMPUS_KEEP = 0.18;
const campus = ['launch', 'production', 'tanks', 'habitat', 'watch']
  .map(k => ({ x: ZONES[k].pos[0], z: ZONES[k].pos[1], r: ZONES[k].radius + 150 }));
function campusWeight(x, z) {
  let w = 0;
  for (const c of campus) {
    const k = 1 - smoothstep(c.r, c.r + 190, Math.hypot(x - c.x, z - c.z));
    if (k > w) w = k;
  }
  return w;
}
export function heightAt(x, z) {
  const cw = campusWeight(x, z);
  let raw = rawHeight(x, z);
  if (cw > 0) raw = lerp(raw, 1.05 + (raw - 1.05) * (1 - cw * (1 - CAMPUS_KEEP)), cw);
  let w = 0, th = 0;
  for (const p of pads) {
    const d = Math.hypot(x - p.x, z - p.z);
    const k = 1 - smoothstep(p.r * 0.62, p.r + 58, d);
    if (k > w) { w = k; th = p.h; }
  }
  for (const [a, b, hw] of roads) {
    const d = distToSeg(x, z, a, b);
    const k = 1 - smoothstep(hw * 0.8, hw * 5.0, d);
    if (k > w) { w = k; th = 1.05; }
  }
  // the overlook mound must not out-vote the graded campus: it did, and dropped an 8 m
  // 75° step into the launch pad's outer ring
  const nd = Math.hypot(x - ZONES.night.pos[0], z - ZONES.night.pos[1]);
  const wz = (1 - smoothstep(80, 250, nd)) * (1 - w);
  if (wz > 0) { th = (th * w + 8 * wz) / (w + wz); w += wz; }
  return lerp(raw, th, w);
}

// ─── the surface the player actually sees ───
// The terrain mesh draws heightAt sampled on a TERRAIN.size/TERRAIN.seg (~10 m) grid, so
// wherever the analytic field steps faster than one cell — road shoulders, pad rims, crater
// walls — the drawn ground sits metres above it. Measured at the spawn point the visible
// floor was 10.3 m over the rover: it started the run buried under the dune. Anything that
// must touch the ground samples this grid instead of heightAt.
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
  // PlaneGeometry splits each quad on the a→c diagonal, so interpolate the same two triangles
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
