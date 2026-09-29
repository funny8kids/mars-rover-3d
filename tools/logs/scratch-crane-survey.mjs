// crane/gen geometry survey — offline, plain node
import { installDomStub, ROOT } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';
installDomStub();
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const fs = await import('node:fs');
const loader = new GLTFLoader();

function parse(buf) {
  return new Promise((res, rej) => loader.parse(buf, '', g => res(g), rej));
}

function boxOf(o) { const b = new THREE.Box3().setFromObject(o); return b; }
const fmt = b => b && !b.isEmpty() ? `[${b.min.x.toFixed(2)},${b.min.y.toFixed(2)},${b.min.z.toFixed(2)} .. ${b.max.x.toFixed(2)},${b.max.y.toFixed(2)},${b.max.z.toFixed(2)}]` : 'empty';

for (const name of ['overhead_crane', 'portable_generator']) {
  const buf = fs.readFileSync(`${ROOT}/public/assets/${name}.glb`);
  const g = await parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log(`\n=== ${name} ===`);
  g.scene.traverse(o => {
    const s = o.name ? ` "${o.name}"` : '';
    if (o.isMesh) {
      const idx = o.geometry.index, pos = o.geometry.attributes.position;
      const tris = (idx ? idx.count : pos.count) / 3;
      console.log(`MESH${s} parent="${o.parent?.name}" pos=(${o.position.x.toFixed(3)},${o.position.y.toFixed(3)},${o.position.z.toFixed(3)}) rot=(${o.rotation.x.toFixed(2)},${o.rotation.y.toFixed(2)},${o.rotation.z.toFixed(2)}) scale=(${o.scale.x.toFixed(3)},${o.scale.y.toFixed(3)},${o.scale.z.toFixed(3)}) tris=${tris} mats=${(Array.isArray(o.material)?o.material:[o.material]).map(m=>m.name).join('/')} worldbox=${fmt(boxOf(o))}`);
    } else if (o.isGroup || o.isObject3D) {
      console.log(`NODE${s} type=${o.type} pos=(${o.position.x.toFixed(3)},${o.position.y.toFixed(3)},${o.position.z.toFixed(3)})`);
    }
  });
  const full = boxOf(g.scene);
  console.log(`FULL ${fmt(full)} size=(${(full.max.x-full.min.x).toFixed(2)},${(full.max.y-full.min.y).toFixed(2)},${(full.max.z-full.min.z).toFixed(2)})`);
  console.log('materials:', [...new Set((() => { const s = []; g.scene.traverse(o => { if (o.isMesh) (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>s.push(m.name)); }); return s; })())]);

  if (name === 'overhead_crane') {
    // horizontal-slab analysis: for every world-y slice, what is the XZ extent and how many triangles' centroids fall there
    g.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const slices = new Map(); // 0.25 m bucket -> {minX,maxX,minZ,maxZ,n}
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const tri = idx ? idx.count : pos.count;
      for (let t = 0; t + 2 < tri; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t+1) : t+1, i2 = idx ? idx.getX(t+2) : t+2;
        let cx=0, cy=0, cz=0;
        for (const i of [i0,i1,i2]) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); cx+=v.x; cy+=v.y; cz+=v.z; }
        cx/=3; cy/=3; cz/=3;
        const b = Math.floor(cy/0.25)*0.25;
        let s = slices.get(b); if (!s) slices.set(b, s={minX:1e9,maxX:-1e9,minZ:1e9,maxZ:-1e9,n:0});
        s.minX=Math.min(s.minX,cx); s.maxX=Math.max(s.maxX,cx); s.minZ=Math.min(s.minZ,cz); s.maxZ=Math.max(s.maxZ,cz); s.n++;
      }
    });
    console.log('y-slice (centroid buckets of 0.25 m):');
    for (const [b, s] of [...slices.entries()].sort((a,b)=>a[0]-b[0]))
      console.log(` y ${b.toFixed(2)}..${(b+0.25).toFixed(2)} n=${String(s.n).padStart(6)} x[${s.minX.toFixed(2)},${s.maxX.toFixed(2)}] z[${s.minZ.toFixed(2)},${s.maxZ.toFixed(2)}]`);
  }
}
