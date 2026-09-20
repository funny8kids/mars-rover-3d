import * as THREE from 'three';
import { heightAt, installSurfaceGrid, surfaceAt, pavedAt } from './height.js';
import { TERRAIN, ZONES, ISLAND } from '../config.js';
import { fbm, vnoise, mulberry32, smoothstep } from '../utils/noise.js';
import { loadModel, cloneModel } from './assets.js';

// Two-scale sand relief. The mesh is only ~1.4 m per vertex, so everything the player sees
// from a metre away has to come from the normal map: elongated wind ripples for the medium
// band and a grain field for the close band.
export function makeDetailNormal(size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const PX = 12;   // pixels per noise unit → ripple wavelength ≈ 2 m
  const ripple = (x, y) => {
    const drift = fbm(x / (size * 0.55), y / (size * 0.55), 2);
    const a = drift * 1.6;
    const along = x * Math.cos(a) + y * Math.sin(a);
    const bend = vnoise(x * 0.06, y * 0.06) * 5.5;
    const crest = Math.pow(0.5 + 0.5 * Math.sin((along / PX) * 6.28318 + bend), 2.4);
    return crest * (0.55 + 0.45 * fbm(x / (PX * 9), y / (PX * 9), 3));
  };
  const hs = (x, y) =>
    ripple(x, y) * 0.62
    + vnoise(x / (PX * 0.45), y / (PX * 0.45)) * 0.20
    + fbm(x / size * 8, y / size * 8, 4) * 0.18;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const l = hs(x - 1, y), r = hs(x + 1, y), d = hs(x, y - 1), u = hs(x, y + 1);
    let nx = (l - r) * 3.4, ny = (d - u) * 3.4, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const i = (y * size + x) * 4;
    img.data[i] = (nx / len * 0.5 + 0.5) * 255;
    img.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
    img.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(26, 26);
  return t;
}

const SAND_A = new THREE.Color(0.80, 0.44, 0.31);   // warm coral toy sand
const SAND_B = new THREE.Color(0.70, 0.35, 0.24);   // deeper terracotta in troughs
const SAND_C = new THREE.Color(0.88, 0.58, 0.40);   // sun-lit crest
const PAVE   = new THREE.Color(0.82, 0.76, 0.68);   // cream regolith pavement
const GRAVEL = new THREE.Color(0.46, 0.26, 0.19);   // dark scree drifts

export function createTerrain(scene) {
  const { size, seg } = TERRAIN;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const nodes = new Float32Array(pos.count);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = heightAt(x, z);
    nodes[i] = y;
    pos.setY(i, y);
    const r = Math.hypot(x, z);
    const tint = fbm(x * 0.02 + 11, z * 0.02 + 5, 3);
    col.copy(SAND_A).lerp(SAND_B, smoothstep(0.35, 0.95, tint));
    col.lerp(SAND_C, smoothstep(2.2, 7.5, y) * 0.7);            // bright rim crest
    col.lerp(SAND_B, smoothstep(-1, -4, y) * 0.6);              // darker beyond the cliff
    const pave = pavedAt(x, z);
    if (pave > 0) col.lerp(PAVE, pave * 0.85);                  // cream pads & roads
    // soft dune banding so large flats never read as a dead sheet
    col.multiplyScalar(0.94 + 0.12 * vnoise(x * 0.35, z * 0.35));
    // gravel drifts and wind-scoured lighter bands — the mid-scale reading that survives
    // the 1.4 m vertex spacing
    const gravel = smoothstep(0.58, 0.82, fbm(x * 0.055 + 31, z * 0.055 + 17, 3));
    col.lerp(GRAVEL, gravel * 0.42 * (1 - pave));
    col.lerp(SAND_C, Math.pow(smoothstep(0.55, 0.95, vnoise(x * 0.12, z * 0.12 + 40)), 2) * 0.20);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  installSurfaceGrid(nodes, seg, size);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0,
    normalMap: makeDetailNormal(),
  });
  mat.normalScale.set(0.85, 0.85);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  scene.add(mesh);
  return mesh;
}

// Kenney Nature Kit boulders — real modeled rocks instead of jagged icospheres.
export async function createRocks(scene) {
  const names = ['rock_largeA', 'rock_largeB', 'rock_largeC', 'rock_smallA', 'rock_smallB',
    'rock_smallC', 'rock_smallD', 'rock_smallFlatA', 'rock_smallFlatB', 'rock_smallG'];
  const models = await Promise.all(names.map(n => loadModel(`kenney/nature/${n}`)));
  const rand = mulberry32(777);
  const group = new THREE.Group();
  const placed = [];
  let guard = 0;
  while (placed.length < 64 && guard++ < 900) {
    const a = rand() * Math.PI * 2;
    const r = 40 + Math.pow(rand(), 0.7) * (ISLAND.rim + 40);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ok = true;
    for (const zn of Object.values(ZONES)) {
      if (Math.hypot(x - zn.pos[0], z - zn.pos[1]) < zn.radius + 12) ok = false;
    }
    for (const p of placed) if (Math.hypot(x - p[0], z - p[1]) < 9) ok = false;
    if (!ok) continue;
    placed.push([x, z]);
    const m = cloneModel(models[Math.floor(rand() * models.length)]);
    const s = 0.8 + rand() * 2.6;
    m.scale.setScalar(s);
    m.position.set(x, surfaceAt(x, z) - 0.25, z);
    m.rotation.y = rand() * Math.PI * 2;
    group.add(m);
  }
  scene.add(group);
  return group;
}
