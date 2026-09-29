import { installDomStub, ROOT } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';
installDomStub();
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const fs = await import('node:fs');
const loader = new GLTFLoader();
const buf = fs.readFileSync(`${ROOT}/public/assets/overhead_crane.glb`);
const g = await new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
g.scene.updateMatrixWorld(true);
const v = new THREE.Vector3();
function sliceMesh(o, step) {
  const pos = o.geometry.attributes.position, idx = o.geometry.index;
  const tri = idx ? idx.count : pos.count;
  const slices = new Map();
  for (let t = 0; t + 2 < tri; t += 3) {
    const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t+1) : t+1, i2 = idx ? idx.getX(t+2) : t+2;
    let c=[0,0,0];
    for (const [k,i] of [i0,i1,i2].entries()) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); c[k===0?0:k===1?1:2]=0; c[0]+=v.x/3; c[1]+=v.y/3; c[2]+=v.z/3; }
    const b = Math.floor(c[1]/step)*step;
    let s = slices.get(b); if (!s) slices.set(b, s={minX:1e9,maxX:-1e9,minZ:1e9,maxZ:-1e9,n:0});
    s.minX=Math.min(s.minX,c[0]); s.maxX=Math.max(s.maxX,c[0]); s.minZ=Math.min(s.minZ,c[2]); s.maxZ=Math.max(s.maxZ,c[2]); s.n++;
  }
  console.log(`--- ${o.name} (${tri/3} tris) ---`);
  for (const [b, s] of [...slices.entries()].sort((a,b)=>a[0]-b[0]))
    console.log(` y ${b.toFixed(2)} n=${String(s.n).padStart(6)} x[${s.minX.toFixed(2)},${s.maxX.toFixed(2)}] z[${s.minZ.toFixed(2)},${s.maxZ.toFixed(2)}]`);
}
for (const m of ['overhead_crane_rails','Cube014','Cube014_1','Cylinder009','Cylinder009_1']) {
  const o = g.scene.getObjectByName(m); sliceMesh(o, 0.5);
}
// rail z-histogram at low y: where are the two rails?
const rails = g.scene.getObjectByName('overhead_crane_rails');
{
  const pos = rails.geometry.attributes.position, idx = rails.geometry.index;
  const hist = new Map();
  const l = new THREE.Vector3();
  const cnt = idx ? idx.count : pos.count;
  for (let i=0;i<cnt;i++){ l.fromBufferAttribute(pos,i); const z=(l.z-0.955); const b=Math.floor(z/0.25)*0.25; hist.set(b,(hist.get(b)||0)+1); }
  console.log('rails local-z histogram (world z = local + (-0.955)?? mesh pos z=-0.955):');
  for (const [b,n] of [...hist.entries()].sort((a,b)=>a[0]-b[0])) console.log(` z ${b.toFixed(2)} ${'#'.repeat(Math.min(60,n/50|0))} ${n}`);
}
