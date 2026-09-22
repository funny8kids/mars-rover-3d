// ───────────────────────── the site chart ─────────────────────────
// The map used to be a dark disc with six dots and six straight lines run from the centre out to
// each dot. That was not a map of this base, it was a map of the *old* base: the carriageways have
// been a 3x3 block lattice with two avenues and two streets since plan.js landed, every district
// sits on a graded footing behind a setback, and the ground in between is dunes inside a crater
// rim. None of that was legible on the panel.
//
// So this module draws an actual chart of the world as it is:
//   * hillshade and contours sampled from heightAt — the same analytic ground the physics reads;
//   * shoulder, kerb, carriageway and centreline from STREETS, round-capped so the intersections
//     fuse the way the asphalt does;
//   * the setback line no wall may cross, one outline per graded footing plus its batter skirt;
//   * district plates, block numbers, landmarks, crater rim, compass, scale bar, legend, grain;
//   * and a live layer: pads, objective with a bearing line, samples, the rover's heading.
//
// Everything expensive is baked once into an offscreen plate, so the per-frame cost is one
// drawImage plus a dozen primitives.

import { ZONES, ISLAND, RIM, SHIP_POS } from '../config.js';
import { STREETS, STREET_HW, PAVEMENT, SETBACK, CELL_EDGE } from '../world/plan.js';
import { heightAt, listLots, craters } from '../world/height.js';
import { mulberry32 } from '../utils/noise.js';
import { t } from '../i18n.js';

const EXTENT = ISLAND.rim + 4;          // centre to neat edge, in metres, both ways
const GS = 240;                         // height grid side — ~1.17 m per cell
const CELL = (EXTENT * 2) / (GS - 1);
const CONTOUR = 1.2;                    // metres between contours, index contour every 5th
const SUN = [-0.71, 0.55];              // relief light from the north-west
const RELIEF = 2.1;                     // how hard the wash exaggerates the dune slopes

const INK = '#ddd2c0', INK_DIM = '#9a8f7f', AMBER = '#ffbe5c', CYAN = '#5fd4e8',
      DEAD = '#7a6a58', RED = '#ff7a62', GREEN = '#8ee06a', SANS = '"Helvetica Neue","PingFang SC","Noto Sans SC",sans-serif',
      MONO = '"JetBrains Mono",ui-monospace,monospace';

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// ─── ground ───
function sampleGround() {
  const h = new Float32Array(GS * GS);
  for (let j = 0; j < GS; j++) {
    const z = -EXTENT + j * CELL;
    for (let i = 0; i < GS; i++) h[j * GS + i] = heightAt(-EXTENT + i * CELL, z);
  }
  const gx = new Float32Array(GS * GS), gz = new Float32Array(GS * GS);
  const at = (i, j) => h[Math.max(0, Math.min(GS - 1, j)) * GS + Math.max(0, Math.min(GS - 1, i))];
  for (let j = 0; j < GS; j++) {
    for (let i = 0; i < GS; i++) {
      gx[j * GS + i] = (at(i + 1, j) - at(i - 1, j)) / (CELL * (i > 0 && i < GS - 1 ? 2 : 1));
      gz[j * GS + i] = (at(i, j + 1) - at(i, j - 1)) / (CELL * (j > 0 && j < GS - 1 ? 2 : 1));
    }
  }
  return { h, gx, gz };
}

// Sand is dark, and a map of a desert that is only dark is unreadable, so the ramp carries
// elevation as value and the lambert term carries relief on top of it.
const RAMP = [
  [0.00, 21, 16, 15], [0.30, 45, 34, 29], [0.55, 76, 57, 43],
  [0.78, 113, 83, 58], [0.92, 147, 111, 76], [1.00, 176, 137, 95],
];
function rampAt(v) {
  v = clamp01(v);
  let i = 1;
  while (i < RAMP.length - 1 && RAMP[i][0] < v) i++;
  const [t0, r0, g0, b0] = RAMP[i - 1], [t1, r1, g1, b1] = RAMP[i];
  const k = t1 === t0 ? 0 : (v - t0) / (t1 - t0);
  return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
}
// Piecewise, so the ~8 m of dune relief gets most of the ramp and the 8.5 m rim wall sits above it.
const elevT = h => (h < 4.6 ? ((h + 4.2) / 8.8) * 0.74 : 0.74 + ((h - 4.6) / 5.4) * 0.26);

function reliefWash(gd) {
  const c = document.createElement('canvas');
  c.width = c.height = GS;
  const g = c.getContext('2d');
  const img = g.createImageData(GS, GS), d = img.data;
  const len = Math.hypot(SUN[0], SUN[1]);
  for (let k = 0, n = GS * GS; k < n; k++) {
    const nx = -gd.gx[k] * RELIEF, nz = -gd.gz[k] * RELIEF;
    const lambert = (nx * SUN[0] + nz * SUN[1]) / (Math.hypot(nx, 1, nz) * len);
    const [r, gg, b] = rampAt(clamp01(elevT(gd.h[k]) * 0.60 + 0.20 + lambert * 0.34));
    d[k * 4] = r; d[k * 4 + 1] = gg; d[k * 4 + 2] = b; d[k * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Marching squares over the height grid, in world metres. Four crossings is a saddle and gets an
// arbitrary pairing — a sub-pixel lie at 1.17 m cells on a chart this size.
function contourAt(gd, level) {
  const { h } = gd, out = [];
  const wx = i => -EXTENT + i * CELL;
  for (let j = 0; j < GS - 1; j++) {
    for (let i = 0; i < GS - 1; i++) {
      const a = h[j * GS + i], b = h[j * GS + i + 1],
            c = h[(j + 1) * GS + i + 1], d = h[(j + 1) * GS + i];
      const x = [];
      if ((a > level) !== (b > level)) x.push([wx(i + (level - a) / (b - a)), wx(j)]);
      if ((b > level) !== (c > level)) x.push([wx(i + 1), wx(j + (level - b) / (c - b))]);
      if ((d > level) !== (c > level)) x.push([wx(i + (level - d) / (c - d)), wx(j + 1)]);
      if ((a > level) !== (d > level)) x.push([wx(i), wx(j + (level - a) / (d - a))]);
      if (x.length === 2) out.push(x[0][0], x[0][1], x[1][0], x[1][1]);
      else if (x.length === 4) out.push(x[0][0], x[0][1], x[2][0], x[2][1], x[1][0], x[1][1], x[3][0], x[3][1]);
    }
  }
  return out;
}

function label(g, str, x, y, o = {}) {
  const { size = 11, weight = '400', color = INK, halo = 3, track = 0, align = 'center',
          baseline = 'middle', italic = false, mono = false, alpha = 1 } = o;
  g.save();
  g.globalAlpha = alpha;
  g.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${mono ? MONO : SANS}`;
  if (track && 'letterSpacing' in g) g.letterSpacing = `${(track * size).toFixed(2)}px`;
  g.textAlign = align; g.textBaseline = baseline;
  if (halo) {
    g.lineJoin = 'round'; g.lineWidth = halo; g.strokeStyle = 'rgba(8,6,10,.88)';
    g.strokeText(str, x, y);
  }
  g.fillStyle = color; g.fillText(str, x, y);
  g.restore();
}

// Live lettering is drawn over baked lettering it cannot see, so it carries its own plate.
// `parts` is [[text, {mono?, color?, size?}], …] laid out left to right; `anchor` pins the plate.
function chip(g, parts, x, y, o = {}) {
  const { size = 9, pad = 6, gap = 9, anchor = 'left' } = o;
  let w = 0;
  const run = parts.map(([str, s = {}], i) => {
    const sz = s.size || size;
    g.font = `${sz}px ${s.mono === false ? SANS : MONO}`;
    const pw = g.measureText(str).width;
    w += pw + (i ? gap : 0);
    return { str, s, sz, pw };
  });
  const bw = w + pad * 2, bh = size + pad * 2;
  const x0 = anchor === 'center' ? x - bw / 2 : anchor === 'right' ? x - bw : x;
  g.save();
  g.fillStyle = 'rgba(9,7,6,.88)';
  g.strokeStyle = 'rgba(236,214,180,.22)'; g.lineWidth = 1;
  g.beginPath();
  if (g.roundRect) g.roundRect(x0 + .5, y - bh / 2, bw - 1, bh - 1, 3.5);
  else g.rect(x0 + .5, y - bh / 2, bw - 1, bh - 1);
  g.fill(); g.stroke();
  let cx = x0 + pad;
  for (const { str, s, sz, pw } of run) {
    label(g, str, cx, y, { size: sz, mono: s.mono !== false, color: s.color || AMBER, halo: 0, align: 'left' });
    cx += pw + gap;
  }
  g.restore();
  return bw;
}

export function createMapChart({ side = 400, scale = 2 } = {}) {
  const RES = Math.round(side * Math.min(scale, 2));
  const S = RES / 2 / EXTENT;                 // device px per metre
  const MID = RES / 2;
  const P = (x, z) => [MID + x * S, MID + z * S];

  const canvas = document.createElement('canvas');
  canvas.className = 'tp-map';
  canvas.width = canvas.height = RES;
  canvas.style.width = `${side}px`;   // CSS keeps it square when the panel is squeezed
  const g = canvas.getContext('2d');
  let plate = null;

  function bake() {
    const gd = sampleGround();
    plate = document.createElement('canvas');
    plate.width = plate.height = RES;
    const b = plate.getContext('2d');
    b.imageSmoothingQuality = 'high';

    b.fillStyle = '#0a0807'; b.fillRect(0, 0, RES, RES);
    b.drawImage(reliefWash(gd), 0, 0, RES, RES);

    // contours, clipped to the plateau so the cliff outside is left to the hatching
    b.save();
    b.beginPath(); b.arc(MID, MID, ISLAND.rim * S, 0, 7); b.clip();
    b.lineCap = 'round';
    for (let n = Math.ceil(-14 / CONTOUR); n * CONTOUR <= 12; n++) {
      const pts = contourAt(gd, n * CONTOUR);
      if (!pts.length) continue;
      const index = n % 5 === 0;
      b.strokeStyle = index ? 'rgba(255,214,164,.30)' : 'rgba(255,204,164,.125)';
      b.lineWidth = index ? 1.7 : 1;
      b.beginPath();
      for (let i = 0; i < pts.length; i += 4) {
        // position-locked wobble: identical at both ends of a shared vertex, so lines stay joined
        const w1x = Math.sin(pts[i] * 5.13 + pts[i + 1] * 2.71) * 0.34;
        const w1y = Math.sin(pts[i + 1] * 3.77 - pts[i] * 1.31) * 0.34;
        const w2x = Math.sin(pts[i + 2] * 5.13 + pts[i + 3] * 2.71) * 0.34;
        const w2y = Math.sin(pts[i + 3] * 3.77 - pts[i + 2] * 1.31) * 0.34;
        b.moveTo(...P(pts[i] + w1x, pts[i + 1] + w1y));
        b.lineTo(...P(pts[i + 2] + w2x, pts[i + 3] + w2y));
      }
      b.stroke();
    }
    b.restore();

    // the void beyond the wall, hatched so nobody reads it as ground you can drive on
    b.save();
    b.beginPath();
    b.arc(MID, MID, EXTENT * S, 0, 7);
    b.arc(MID, MID, ISLAND.rim * S, 0, 7, true);
    b.clip('evenodd');
    b.fillStyle = 'rgba(4,3,5,.88)'; b.fillRect(0, 0, RES, RES);
    b.strokeStyle = 'rgba(255,190,140,.075)'; b.lineWidth = 1;
    b.beginPath();
    for (let o = -RES; o < RES * 2; o += 7) { b.moveTo(o, 0); b.lineTo(o - RES, RES); }
    b.stroke();
    b.restore();

    // Two circles, and the map has to tell them apart: the crater rim is geology, the dashed one is
    // where the barrier's discs stop a rover's *skin*, which is also where the dust veil stands. Draw
    // the island's own radius here instead and the chart promises six metres of road that does not exist.
    for (const [r, a, w, dash] of [[ISLAND.rim, 0.34, 2, []], [RIM.face, 0.16, 1.2, [5, 4]]]) {
      b.strokeStyle = `rgba(255,196,140,${a})`; b.lineWidth = w; b.setLineDash(dash);
      b.beginPath(); b.arc(MID, MID, r * S, 0, 7); b.stroke();
    }
    b.setLineDash([]);
    label(b, t('陨石坑边缘'), MID, MID - ISLAND.rim * S + 13, { size: 8.5, color: 'rgba(255,196,140,.5)', mono: true, track: .3 });
    label(b, t('沙垣禁行线'), MID, MID - RIM.face * S + 12, { size: 8.5, color: 'rgba(255,196,140,.34)', mono: true, track: .3 });

    // survey graticule on the block lattice
    b.strokeStyle = 'rgba(255,255,255,.042)'; b.lineWidth = 1;
    b.beginPath();
    for (let m = -120; m <= 120; m += 30) {
      b.moveTo(...P(m, -EXTENT)); b.lineTo(...P(m, EXTENT));
      b.moveTo(...P(-EXTENT, m)); b.lineTo(...P(EXTENT, m));
    }
    b.stroke();

    // district plates: engineered ground reads warmer and flatter than the dunes
    for (const zn of Object.values(ZONES)) {
      if (zn.padHeight === undefined) continue;
      const [x, y] = P(zn.pos[0], zn.pos[1]);
      const grd = b.createRadialGradient(x, y, 0, x, y, zn.radius * S);
      grd.addColorStop(0, 'rgba(200,170,132,.17)');
      grd.addColorStop(0.72, 'rgba(150,124,96,.09)');
      grd.addColorStop(1, 'rgba(120,96,72,0)');
      b.fillStyle = grd;
      b.beginPath(); b.arc(x, y, zn.radius * S, 0, 7); b.fill();
    }

    // carriageway: shoulder, casing, asphalt, centreline
    const lane = (halfW, color, dash) => {
      b.strokeStyle = color; b.lineWidth = halfW * 2 * S; b.lineCap = 'round';
      b.setLineDash(dash || []);
      b.beginPath();
      for (const s of STREETS) { b.moveTo(...P(s.a[0], s.a[1])); b.lineTo(...P(s.b[0], s.b[1])); }
      b.stroke(); b.setLineDash([]);
    };
    lane(STREET_HW + PAVEMENT, 'rgba(178,154,122,.16)');
    lane(STREET_HW + 0.5, 'rgba(10,8,8,.72)');
    lane(STREET_HW, 'rgba(98,86,72,.55)');
    lane(0.35, 'rgba(255,226,180,.30)', [10, 12]);

    // the setback: no first wall may sit closer than this to a centreline
    const set = STREET_HW + PAVEMENT + SETBACK;
    b.strokeStyle = 'rgba(255,190,120,.16)'; b.lineWidth = 1; b.setLineDash([2, 6]);
    b.beginPath();
    for (const s of STREETS) {
      const vert = s.a[0] === s.b[0];
      for (const k of [-1, 1]) {
        if (vert) { b.moveTo(...P(s.a[0] + set * k, s.a[1])); b.lineTo(...P(s.a[0] + set * k, s.b[1])); }
        else { b.moveTo(...P(s.a[0], s.a[1] + set * k)); b.lineTo(...P(s.b[0], s.b[1] + set * k)); }
      }
    }
    b.stroke(); b.setLineDash([]);

    // the works: one graded footing per structure cluster, and the batter that lets a wheel up it
    for (const l of listLots()) {
      b.save();
      b.translate(...P(l.x, l.z)); b.rotate(-l.ry);
      const w = l.hw * 2 * S, d = l.hd * 2 * S, sk = l.skirt * S;
      b.fillStyle = 'rgba(216,192,158,.10)'; b.fillRect(-w / 2, -d / 2, w, d);
      b.strokeStyle = 'rgba(240,218,184,.45)'; b.lineWidth = 1.3;
      b.strokeRect(-w / 2, -d / 2, w, d);
      b.strokeStyle = 'rgba(255,190,120,.12)'; b.lineWidth = 1; b.setLineDash([3, 4]);
      b.strokeRect(-w / 2 - sk, -d / 2 - sk, w + sk * 2, d + sk * 2);
      b.restore();
    }

    // landmarks that are not districts
    b.strokeStyle = 'rgba(120,220,240,.45)'; b.lineWidth = 1.2;
    b.beginPath(); b.arc(...P(SHIP_POS[0], SHIP_POS[1]), 5 * S, 0, 7);
    b.moveTo(...P(SHIP_POS[0] - 8, SHIP_POS[1])); b.lineTo(...P(SHIP_POS[0] + 8, SHIP_POS[1]));
    b.moveTo(...P(SHIP_POS[0], SHIP_POS[1] - 8)); b.lineTo(...P(SHIP_POS[0], SHIP_POS[1] + 8));
    b.stroke();
    b.strokeStyle = 'rgba(255,206,164,.14)'; b.lineWidth = 1; b.setLineDash([4, 6]);
    for (const c of craters) {
      b.beginPath(); b.arc(...P(c.x, c.z), c.r * S, 0, 7); b.stroke();
    }
    b.setLineDash([]);

    // lettering: districts get plates and codes, single-purpose sites get italics
    for (const [key, zn] of Object.entries(ZONES)) {
      if (key === 'wild') continue;
      const [x, y] = P(zn.pos[0], zn.pos[1]);
      const big = !!zn.teleport;
      label(b, t(zn.name), x, y, {
        size: big ? 13 : 10.5, weight: big ? '600' : '400', italic: !big,
        color: big ? INK : 'rgba(212,196,172,.62)', track: big ? 0.14 : 0.1,
      });
      if (big) label(b, key.toUpperCase(), x, y + 14, { size: 8.5, color: 'rgba(178,164,144,.6)', mono: true, track: 0.3 });
    }
    const cols = 'ABC';
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const [x, y] = P(-CELL_EDGE + i * CELL_EDGE * 2 - 20, -CELL_EDGE + j * CELL_EDGE * 2 - 18);
        label(b, `LOT ${cols[j]}${i + 1}`, x, y, { size: 8, color: 'rgba(190,174,152,.34)', mono: true, track: .18 });
      }
    }

    // one dimension annotation, because this is an engineering drawing as much as a map
    {
      const z = -78, x0 = -STREET_HW - 30, x1 = STREET_HW - 30;
      const [A, B] = [P(x0, z), P(x1, z)];
      b.strokeStyle = 'rgba(255,190,120,.4)'; b.lineWidth = 1;
      b.beginPath();
      b.moveTo(...A); b.lineTo(...B);
      b.moveTo(A[0], A[1] - 4); b.lineTo(A[0], A[1] + 4);
      b.moveTo(B[0], B[1] - 4); b.lineTo(B[0], B[1] + 4);
      b.stroke();
      label(b, `${STREET_HW * 2} m`, (A[0] + B[0]) / 2, A[1] - 8, { size: 8, color: 'rgba(255,190,120,.62)', mono: true, halo: 2 });
    }

    furniture(b);
    grain(b);
    return plate;
  }

  // neat line, ticks, compass, scale, title block, legend
  function furniture(b) {
    const m = 7, w = RES - m * 2;
    b.strokeStyle = 'rgba(236,214,180,.34)'; b.lineWidth = 1.6; b.strokeRect(m, m, w, w);
    b.strokeStyle = 'rgba(236,214,180,.15)'; b.lineWidth = 1; b.strokeRect(m + 4, m + 4, w - 8, w - 8);
    b.strokeStyle = 'rgba(236,214,180,.3)'; b.lineWidth = 1;
    b.beginPath();
    for (let i = 0; i <= 8; i++) {
      const p = m + (w * i) / 8, l = i % 2 ? 5 : 9;
      b.moveTo(p, m); b.lineTo(p, m + l); b.moveTo(p, m + w - l); b.lineTo(p, m + w);
      b.moveTo(m, p); b.lineTo(m + l, p); b.moveTo(m + w - l, p); b.lineTo(m + w, p);
    }
    b.stroke();

    const nx = RES - 38, ny = 44, r = 16;
    b.strokeStyle = 'rgba(236,214,180,.45)'; b.lineWidth = 1.1;
    b.beginPath(); b.arc(nx, ny, r, 0, 7); b.stroke();
    b.fillStyle = 'rgba(255,190,120,.9)';
    b.beginPath(); b.moveTo(nx, ny - r + 2); b.lineTo(nx + 4.5, ny + 1); b.lineTo(nx - 4.5, ny + 1); b.closePath(); b.fill();
    b.fillStyle = 'rgba(236,214,180,.28)';
    b.beginPath(); b.moveTo(nx, ny + r - 2); b.lineTo(nx + 4.5, ny - 1); b.lineTo(nx - 4.5, ny - 1); b.closePath(); b.fill();
    label(b, 'N', nx, ny - r - 6, { size: 9.5, weight: '600', color: AMBER, halo: 0 });

    const bx = 22, by = RES - 74, seg = 25 * S;
    for (let i = 0; i < 4; i++) {
      b.fillStyle = i % 2 ? 'rgba(236,214,180,.8)' : 'rgba(18,14,12,.85)';
      b.fillRect(bx + i * seg, by, seg, 4.5);
      b.strokeStyle = 'rgba(236,214,180,.5)'; b.lineWidth = 1;
      b.strokeRect(bx + i * seg, by, seg, 4.5);
    }
    label(b, '0', bx, by - 7, { size: 8, mono: true, color: INK_DIM, halo: 0 });
    label(b, '100 m', bx + seg * 4, by - 7, { size: 8, mono: true, color: INK_DIM, halo: 0 });

    label(b, 'RED STARBASE', 22, RES - 48, { size: 12, weight: '600', color: INK, align: 'left', track: .18, halo: 0 });
    label(b, t('基地总图 · 等高距 1.2 m'), 22, RES - 35, { size: 8.5, color: INK_DIM, align: 'left', mono: true, halo: 0 });

    const legend = [[CYAN, '●', t('光台就绪')], [DEAD, '◎', t('光台无电')],
                    [AMBER, '◎', t('当前目标')], [GREEN, '◇', t('样本点')], [RED, '▨', t('危险区')],
                    ['#ffd27a', '▲', t('漫游车')]];
    // A legend has to sit on something, or it reads as noise laid over the dunes it explains.
    const lx = RES - 132, ly = RES - 224, lw = 118, lh = 13 * legend.length + 12;
    b.fillStyle = 'rgba(8,6,9,.62)'; b.fillRect(lx, ly, lw, lh);
    b.strokeStyle = 'rgba(236,214,180,.2)'; b.lineWidth = 1; b.strokeRect(lx, ly, lw, lh);
    label(b, t('图例'), lx + lw / 2, ly + 9, { size: 8, color: INK_DIM, mono: true, track: .3, halo: 0 });
    legend.forEach(([col, glyph, txt], i) => {
      const y = ly + 22 + i * 13;
      label(b, glyph, lx + 13, y, { size: 9, color: col, halo: 0 });
      label(b, txt, lx + 26, y, { size: 8.5, color: INK_DIM, align: 'left', halo: 0 });
    });
  }

  function grain(b) {
    const rnd = mulberry32(20260922);
    for (let i = 0; i < 5200; i++) {
      const v = rnd();
      b.fillStyle = v > 0.5 ? `rgba(255,232,200,${(0.016 + v * 0.022).toFixed(3)})` : `rgba(0,0,0,${(0.05 * v).toFixed(3)})`;
      b.fillRect(rnd() * RES, rnd() * RES, 1.25, 1.25);
    }
    const vg = b.createRadialGradient(MID, MID, RES * 0.30, MID, MID, RES * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.40)');
    b.fillStyle = vg; b.fillRect(0, 0, RES, RES);
  }

  // ─── live layer ───
  function draw(st) {
    if (!plate) bake();
    g.clearRect(0, 0, RES, RES);
    g.drawImage(plate, 0, 0);
    const time = st.time || 0;

    // an uncontrolled leak is an area, not a dot
    if (st.danger) {
      const [X, Y] = P(st.danger.x, st.danger.z), r = st.danger.r * S;
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.6);
      g.save();
      g.beginPath(); g.arc(X, Y, r, 0, 7); g.clip();
      g.fillStyle = `rgba(255,90,60,${(0.06 + 0.05 * pulse).toFixed(3)})`;
      g.fillRect(X - r, Y - r, r * 2, r * 2);
      g.strokeStyle = 'rgba(255,120,90,.4)'; g.lineWidth = 1.1;
      g.beginPath();
      for (let o = -r * 2; o < r * 2; o += 7) { g.moveTo(X + o, Y - r); g.lineTo(X + o + r * 2, Y + r); }
      g.stroke();
      g.restore();
      g.strokeStyle = `rgba(255,120,90,${(0.45 + 0.4 * pulse).toFixed(3)})`; g.lineWidth = 1.6;
      g.beginPath(); g.arc(X, Y, r, 0, 7); g.stroke();
      label(g, t('危险区'), X, Y - r - 8, { size: 9, color: RED, track: .18 });
    }

    // A site lying under the sand the last front dropped is not "somewhere you have not been yet" —
    // it is right there and unreachable until you scour it. The pin carries that: the crystal green
    // drains toward the lens's own ochre as the cover rises, and past the work line the diamond goes
    // hollow and dashed, which is the same sentence the sand dome on the ground is saying.
    const mix = (a, b, k) => Math.round(a + (b - a) * k);
    for (const sm of st.samples || []) {
      const [X, Y] = P(sm.x, sm.z);
      const k = Math.max(0, Math.min(1, (sm.buried || 0) / 0.5));
      g.save(); g.translate(X, Y); g.rotate(Math.PI / 4);
      if (sm.taken) {
        g.strokeStyle = 'rgba(160,150,132,.45)'; g.fillStyle = 'rgba(0,0,0,0)';
      } else if (k >= 1) {
        g.strokeStyle = 'rgba(213,164,105,.95)'; g.fillStyle = 'rgba(185,138,92,.20)';
        g.setLineDash([2.6, 2.2]);
      } else {
        g.strokeStyle = `rgba(${mix(142, 213, k)},${mix(224, 164, k)},${mix(106, 105, k)},.95)`;
        g.fillStyle = `rgba(${mix(142, 205, k)},${mix(224, 158, k)},${mix(106, 101, k)},${(0.32 - 0.11 * k).toFixed(3)})`;
      }
      g.lineWidth = 1.4; g.beginPath(); g.rect(-3.6, -3.6, 7.2, 7.2); g.fill(); g.stroke();
      g.restore();
    }

    const [PX2, PY2] = P(st.x, st.z);
    // The rover spends its life at a pad, and every pad was baked with its district's name under it.
    // An opaque wedge dropped on that lettering reads as a typo, so it gets a cast shadow to sit in.
    const cast = g.createRadialGradient(PX2, PY2, 3, PX2, PY2, 26);
    cast.addColorStop(0, 'rgba(6,5,4,.82)'); cast.addColorStop(.55, 'rgba(6,5,4,.5)');
    cast.addColorStop(1, 'rgba(6,5,4,0)');
    g.fillStyle = cast;
    g.beginPath(); g.arc(PX2, PY2, 26, 0, 7); g.fill();

    if (st.objective) {
      const [X, Y] = P(st.objective.x, st.objective.z);
      const pulse = 0.5 + 0.5 * Math.sin(time * 3.4);
      g.strokeStyle = `rgba(255,190,92,${(0.26 + 0.26 * pulse).toFixed(3)})`; g.lineWidth = 1.1;
      g.setLineDash([7, 6]); g.lineDashOffset = -time * 22;
      g.beginPath(); g.moveTo(PX2, PY2); g.lineTo(X, Y); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
      g.strokeStyle = AMBER; g.lineWidth = 1.7;
      g.beginPath(); g.arc(X, Y, 8 + 3.5 * pulse, 0, 7); g.stroke();
      g.beginPath();
      g.moveTo(X - 13, Y); g.lineTo(X - 6, Y); g.moveTo(X + 6, Y); g.lineTo(X + 13, Y);
      g.moveTo(X, Y - 13); g.lineTo(X, Y - 6); g.moveTo(X, Y + 6); g.lineTo(X, Y + 13);
      g.stroke();
    }

    // the fast-travel skeleton
    for (const tp of st.teleports || []) {
      const [X, Y] = P(tp.x, tp.z);
      const live = tp.online !== false, here = st.padHere === tp;
      g.strokeStyle = here ? '#8ff4ff' : live ? CYAN : DEAD;
      g.lineWidth = here ? 2.2 : 1.5;
      g.beginPath(); g.arc(X, Y, here ? 9 : 7, 0, 7); g.stroke();
      g.fillStyle = here ? '#8ff4ff' : live ? 'rgba(95,212,232,.55)' : 'rgba(122,106,88,.35)';
      g.beginPath(); g.arc(X, Y, 3, 0, 7); g.fill();
      if (!live) {
        g.strokeStyle = DEAD; g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(X - 4, Y - 4); g.lineTo(X + 4, Y + 4);
        g.moveTo(X + 4, Y - 4); g.lineTo(X - 4, Y + 4); g.stroke();
      }
    }

    // the rover: a heading wedge, because a dot does not tell you which way to drive
    const dir = Math.atan2(Math.cos(st.yaw || 0), Math.sin(st.yaw || 0));
    const cone = g.createRadialGradient(PX2, PY2, 2, PX2, PY2, 30);
    cone.addColorStop(0, 'rgba(255,190,92,.22)'); cone.addColorStop(1, 'rgba(255,190,92,0)');
    g.fillStyle = cone;
    g.beginPath(); g.moveTo(PX2, PY2);
    g.arc(PX2, PY2, 30, dir - 0.55, dir + 0.55);
    g.closePath(); g.fill();
    g.save();
    g.translate(PX2, PY2); g.rotate(dir + Math.PI / 2);
    g.fillStyle = '#ffd27a'; g.strokeStyle = 'rgba(22,15,8,.92)'; g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(0, -11); g.lineTo(6.5, 7); g.lineTo(0, 3.2); g.lineTo(-6.5, 7);
    g.closePath(); g.fill(); g.stroke();
    g.restore();

    // The readout is a marginal note, not a callout. Hanging it off the marker put it on top of the
    // district lettering baked under every pad — and the rover spends its life at those pads.
    const note = [['▲', { mono: false, color: '#ffd27a', size: 10 }],
                  [st.padHere ? t('你在这里') : t('漫游车'), { mono: false, color: st.padHere ? '#8ff4ff' : INK }],
                  [`E ${Math.round(st.x)}  S ${Math.round(st.z)}`, { color: AMBER }]];
    if (st.padHere) note.push([st.padHere.online === false ? t('光台无电') : t(st.padHere.name),
                              { mono: false, color: st.padHere.online === false ? DEAD : CYAN }]);
    chip(g, note, 18, 26, { size: 9.5 });
  }

  function toWorld(clientX, clientY, rect) {
    const r = rect || canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * 2 * EXTENT - EXTENT,
      z: ((clientY - r.top) / r.height) * 2 * EXTENT - EXTENT,
    };
  }

  return {
    canvas, draw, toWorld, EXTENT,
    // The plate carries lettering, so a language flip invalidates it. Re-baking is deferred to the
    // next open rather than paid for on the frame the toggle is clicked.
    invalidate() { plate = null; },
    get baked() { return !!plate; },
  };
}
