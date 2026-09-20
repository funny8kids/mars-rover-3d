import * as THREE from 'three';
import { heightAt, installSurfaceGrid, surfaceAt } from './height.js';
import { TERRAIN, ZONES } from '../config.js';
import { fbm, vnoise, mulberry32, smoothstep } from '../utils/noise.js';

export function makeDetailNormal(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const hs = (x, y) => fbm(x / size * 8, y / size * 8, 4) * 0.7 + vnoise(x / size * 40, y / size * 40) * 0.3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const l = hs(x - 1, y), r = hs(x + 1, y), d = hs(x, y - 1), u = hs(x, y + 1);
    let nx = (l - r) * 3, ny = (d - u) * 3, nz = 1;
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
  t.repeat.set(90, 90);
  return t;
}

const padList = Object.values(ZONES).filter(z => z.padHeight !== undefined);
function nearPad(x, z, extra = 0) {
  for (const p of padList) if (Math.hypot(x - p.pos[0], z - p.pos[1]) < p.radius + extra) return true;
  return false;
}

export function createTerrain(scene) {
  const { size, seg } = TERRAIN;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const nodes = new Float32Array(pos.count);
  const col = new THREE.Color();
  const n = { x: 0, y: 1, z: 0 };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = heightAt(x, z);
    nodes[i] = y;
    pos.setY(i, y);
    normalAtSlope(x, z, n);
    const slope = 1 - n.y;
    const tint = fbm(x * 0.004 + 11, z * 0.004 + 5, 3);
    // rust base → darker dust in flats → pale rock on slopes → blue-ish basalt near craters
    col.setRGB(0.285 + tint * 0.10, 0.125 + tint * 0.045, 0.068 + tint * 0.03);
    const rock = smoothstep(0.12, 0.42, slope);
    col.lerp(new THREE.Color(0.24, 0.155, 0.105), rock * 0.8);
    const dust = smoothstep(0.02, -0.05, y - 1.5) * smoothstep(6, 0, slope * 100);
    col.lerp(new THREE.Color(0.165, 0.075, 0.045), dust * 0.35);
    if (nearPad(x, z, -8)) col.lerp(new THREE.Color(0.17, 0.14, 0.125), 0.4); // graded regolith near pads
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  installSurfaceGrid(nodes, seg, size);
  function normalAtSlope(x, z, out) {
    const e = size / seg * 1.2;
    const hL = heightAt(x - e, z), hR = heightAt(x + e, z), hD = heightAt(x, z - e), hU = heightAt(x, z + e);
    const nx = hL - hR, nz = hD - hU, ny = 2 * e, l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0.02,
    normalMap: makeDetailNormal(),
  });
  mat.normalScale.set(0.85, 0.85);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  scene.add(mesh);
  return mesh;
}

export function createRocks(scene) {
  const rand = mulberry32(777);
  const groups = [];
  for (const [geoFn, count, smin, smax] of [
    [() => new THREE.IcosahedronGeometry(1, 1), 340, 0.7, 3.2],
    [() => new THREE.DodecahedronGeometry(1, 0), 260, 0.4, 1.6],
  ]) {
    const geo = geoFn();
    // random jaggedness
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.75 + rand() * 0.5), p.getY(i) * (0.6 + rand() * 0.6), p.getZ(i) * (0.75 + rand() * 0.5));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x3d281e, roughness: 0.95, metalness: 0.05 });
    const im = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
    let idx = 0, guard = 0;
    while (idx < count && guard++ < count * 30) {
      const a = rand() * Math.PI * 2;
      const r = 120 + Math.pow(rand(), 0.6) * 950;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (nearPad(x, z, 18)) continue;
      const sc = smin + rand() * (smax - smin);
      const y = surfaceAt(x, z) - sc * 0.28;
      e.set(rand() * 3, rand() * 6.28, rand() * 3);
      q.setFromEuler(e); s.set(sc * (0.8 + rand() * 0.6), sc * (0.55 + rand() * 0.7), sc * (0.8 + rand() * 0.6));
      v.set(x, y, z);
      m.compose(v, q, s);
      im.setMatrixAt(idx++, m);
    }
    im.count = idx;
    im.castShadow = true; im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    groups.push(im);
  }
  return groups;
}
