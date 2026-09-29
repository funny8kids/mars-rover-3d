// Where can the rover drive UNDER the gantry crane? Boxes only tell the authored origin is mid-body
// (hook tip y=-3.91, top y=+1.22), so this walks triangle centroids and answers two things per column:
// the lowest face that ever stands over it (the thing the hull would hit) and the y-range of the
// vertical members (the feet). Grid is in the asset's own metres, XZ centred on the model.
import { installDomStub, ROOT } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';
installDomStub();
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const fs = await import('node:fs');

const buf = fs.readFileSync(`${ROOT}/public/assets/overhead_crane.glb`);
const g = await new Promise((res, rej) => new GLTFLoader().parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
g.scene.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(g.scene);
const CELL = 1.0;
const nx = Math.ceil((box.max.x - box.min.x) / CELL), nz = Math.ceil((box.max.z - box.min.z) / CELL);
const cols = new Map();   // `ix|iz` → { n, ylo, yhi, runs: [] }
const v = new THREE.Vector3();
const legRuns = [];        // per-column y buckets, later turned into an occupancy histogram
const bucket = 0.25;
g.scene.traverse(o => {
  if (!o.isMesh) return;
  const pos = o.geometry.attributes.position, idx = o.geometry.index;
  const tri = idx ? idx.count : pos.count;
  for (let t = 0; t + 2 < tri; t += 3) {
    for (const k of [0, 1, 2]) {
      const ii = idx ? idx.getX(t + k) : t + k;
      v.fromBufferAttribute(pos, ii).applyMatrix4(o.matrixWorld);
      const ix = Math.floor((v.x - box.min.x) / CELL), iz = Math.floor((v.z - box.min.z) / CELL);
      const key = `${ix}|${iz}`;
      let c = cols.get(key);
      if (!c) cols.set(key, c = { n: 0, ylo: v.y, yhi: v.y, hist: new Map(), mesh: new Set() });
      c.n++;
      if (v.y < c.ylo) c.ylo = v.y;
      if (v.y > c.yhi) c.yhi = v.y;
      const b = Math.floor(v.y / bucket);
      c.hist.set(b, (c.hist.get(b) || 0) + 1);
      c.mesh.add(o.name);
    }
  }
});

// A column is a FOOT if its vertical span is small (a flat thing lying on the ground) and it sits at
// the bottom of the model; it is a LEG if it holds vertices across most of the height with a thin XZ
// neighbourhood. Print the whole grid as a y-range string per cell so a human can read the shape.
const line = (c, maxSpan) => {
  if (!c) return '.'.padStart(9);
  const a = Math.round(c.ylo * 100) / 100, b = Math.round(c.yhi * 100) / 100;
  return `${a.toFixed(1)}..${b.toFixed(1)}`.padStart(12);
};
console.log(`footprint ${nz} rows (z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}) x ${nx} cols (x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}), cell ${CELL} m`);
for (let iz = nz - 1; iz >= 0; iz--) {
  const cells = [];
  for (let ix = 0; ix < nx; ix++) cells.push(line(cols.get(`${ix}|${iz}`)));
  console.log(`z ${(box.min.z + (iz + 0.5) * CELL).toFixed(1).padStart(6)} |` + cells.join('|'));
}

// The hull is 2.72 m tall (ROOF) and rides 0.46 m (RIDE). For each column, report the lowest vertex
// strictly ABOVE the column's own bottom surface: that is the first thing the roof would hit.
console.log('\nfirst geometry above y=0 per column (the model is not seated yet; this is the roof-hit line):');
for (let iz = nz - 1; iz >= 0; iz--) {
  const cells = [];
  for (let ix = 0; ix < nx; ix++) {
    const c = cols.get(`${ix}|${iz}`);
    if (!c) { cells.push('        .'); continue; }
    let lo = Infinity;
    for (const [b, n] of c.hist) if (b * bucket >= 0 && n > 0) lo = Math.min(lo, b * bucket);
    cells.push((Number.isFinite(lo) ? lo.toFixed(2) : 'none').padStart(9));
  }
  console.log(`z ${(box.min.z + (iz + 0.5) * CELL).toFixed(1).padStart(6)} |` + cells.join('|'));
}

// Vertical member census: columns whose span covers >60 % of the body height are legs/pylons.
const bodyLo = -2.25, bodyHi = 1.22, span = bodyHi - bodyLo;
const legs = [];
for (const [key, c] of cols) {
  if (c.yhi - c.ylo > 0.6 * span) {
    const [ix, iz] = key.split('|').map(Number);
    legs.push({ x: box.min.x + (ix + 0.5) * CELL, z: box.min.z + (iz + 0.5) * CELL,
      ylo: c.ylo, yhi: c.yhi, n: c.n, meshes: [...c.meshes].join(',') });
  }
}
legs.sort((a, b) => b.n - a.n);
console.log(`\ncolumns spanning >60 % of the body height (${legs.length}):`);
for (const l of legs.slice(0, 24)) console.log(`  x ${l.x.toFixed(2)} z ${l.z.toFixed(2)} y ${l.ylo.toFixed(2)}..${l.yhi.toFixed(2)} verts ${l.n} [${l.meshes}]`);
