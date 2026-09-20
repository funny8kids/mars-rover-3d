import { fbm, vnoise, ridge, mulberry32, smoothstep, lerp, clamp } from '../utils/noise.js';
import { TERRAIN, ZONES, ISLAND } from '../config.js';

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
const H = ZONES.hub.pos;
const roads = [
  [H, ZONES.habitat.pos, 7], [H, ZONES.industry.pos, 7], [H, ZONES.comms.pos, 7],
  [H, ZONES.launch.pos, 7], [H, ZONES.science.pos, 7],
];
function distToSeg(px, pz, a, b) {
  const ax = a[0], az = a[1], bx = b[0], bz = b[1];
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
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

export function heightAt(x, z) {
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

// 0..1 — how paved (pad/road) a point is, used for ground tinting
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
