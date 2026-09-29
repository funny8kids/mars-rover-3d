import { installDomStub, buildOfflineWorld } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';
installDomStub();
const w = await buildOfflineWorld({ sky: false });
const { THREE, scene, colliders } = w;
console.log(`TERRAIN_KEYS ${Object.keys(w.terrain || {}).join(',')}`);
console.log(`BASE_KEYS ${Object.keys(w.base || {}).join(',')}`);
const centre = new THREE.Vector3(62.00, 9.33, 76.00);
const seen = new Map();
scene.traverse(o => {
  if (!o.isMesh) return;
  const b = new THREE.Box3().setFromObject(o); const c = b.getCenter(new THREE.Vector3());
  if (Math.hypot(c.x - centre.x, c.z - centre.z) > 16) return;
  const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => m?.name || '?');
  for (const m of mats) {
    const k = `${m}|scope=${o.userData?.scope || o.parent?.name || '?'}|y=${b.min.y.toFixed(0)}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
});
[...seen.entries()].sort().forEach(([k, v]) => console.log(`NEAR ${k} x${v}`));
const feet = colliders.filter(c => (c.prop || '').includes('fab-substation'));
console.log(`HOST_DISCS ${feet.length} ${feet.map(f => `(${f.x.toFixed(1)},${f.z.toFixed(1)} r${f.r.toFixed(2)} floor=${f.floor ?? 'none'} top=${f.top ?? 'none'})`).join(' ')}`);
