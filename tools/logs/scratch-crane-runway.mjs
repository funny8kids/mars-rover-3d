// Runway survey for the legless crane bridge: measure the gantry portal's own box so the
// crane's datum can be derived from the rail top instead of a typed dy.
import { installDomStub, ROOT } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';
installDomStub();
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const fs = await import('node:fs');
const loader = new GLTFLoader();
const parse = (buf) => new Promise((res, rej) => loader.parse(buf, '', g => res(g), rej));
const fmt = (b) => `[${b.min.x.toFixed(3)},${b.min.y.toFixed(3)},${b.min.z.toFixed(3)}..${b.max.x.toFixed(3)},${b.max.y.toFixed(3)},${b.max.z.toFixed(3)}]`;

const buf = fs.readFileSync(`${ROOT}/public/assets/gantry_service.glb`);
const g = await parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const full = new THREE.Box3().setFromObject(g.scene);
const sz = new THREE.Vector3(); full.getSize(sz);
console.log(`gantry_service FULL ${fmt(full)} size=(${sz.x.toFixed(2)},${sz.y.toFixed(2)},${sz.z.toFixed(2)})`);
const rows = [];
g.scene.traverse(o => {
  if (!o.isMesh) return;
  const b = new THREE.Box3().setFromObject(o);
  const s = new THREE.Vector3(); b.getSize(s);
  rows.push({ n: o.name, y: `${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}`, x: `${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)}`, z: `${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}`, s: `(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})` });
});
rows.sort((a, b) => parseFloat(b.y.split('..')[1]) - parseFloat(a.y.split('..')[1]));
for (const r of rows.slice(0, 14)) console.log(`  "${r.n}" y=${r.y} x=${r.x} z=${r.z} size=${r.s}`);
console.log(`MESH_COUNT=${rows.length}`);

// y-histogram of the whole gantry: which bands are structure and where the rail top really is
const pos = [];
g.scene.traverse(o => {
  if (!o.isMesh) return;
  const p = o.geometry.attributes.position;
  const m = new THREE.Matrix4(); o.updateMatrixWorld(true); m.copy(o.matrixWorld);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push([v.x, v.y, v.z]); }
});
const top = full.max.y;
for (let k = 0; k < 8; k++) {
  const lo = top - (k + 1) * 0.5, hi = top - k * 0.5;
  const band = pos.filter(([, y]) => y > lo && y <= hi);
  if (!band.length) { console.log(`band ${lo.toFixed(2)}..${hi.toFixed(2)} n=0`); continue; }
  const xs = band.map(([x]) => x), zs = band.map(([, , z]) => z);
  console.log(`band ${lo.toFixed(2)}..${hi.toFixed(2)} n=${band.length} x[${Math.min(...xs).toFixed(2)},${Math.max(...xs).toFixed(2)}] z[${Math.min(...zs).toFixed(2)},${Math.max(...zs).toFixed(2)}]`);
}
