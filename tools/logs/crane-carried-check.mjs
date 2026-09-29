// Carried-crane check: measure what props.js actually built, not what its derivation says it built.
// The crane is found by material (it survives the merge pass); the host portal is found by prop
// scope (`gantry_service` materials were retinted to the base palette, so a material regex there
// silently matches nothing — that is how the first run of this file reported NO_HOST).
// Exit 0 only when every clause below holds.
import { installDomStub, buildOfflineWorld } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';
installDomStub();
const w = await buildOfflineWorld({ sky: false });
const { THREE, scene, colliders } = w;

const matNames = (o) => (Array.isArray(o.material) ? o.material : [o.material]).map(m => m?.name || '');
const scopeOf = (o) => String(o.userData?.scope || o.parent?.name || '');
const centreOf = (o) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
const pick = (test, near = null, radius = Infinity) => {
  const b = new THREE.Box3(); const s = new THREE.Vector3();
  let n = 0, tris = 0;
  scene.traverse(o => {
    if (!o.isMesh || !test(o)) return;
    if (near) { const c = centreOf(o); if (Math.hypot(c.x - near.x, c.z - near.z) > radius) return; }
    b.expandByObject(o); n++;
    const idx = o.geometry?.index, p = o.geometry?.attributes?.position;
    tris += (idx ? idx.count : p ? p.count : 0) / 3;
  });
  if (!n) return null;
  b.getSize(s);
  return { n, tris, b, s, centre: b.getCenter(new THREE.Vector3()) };
};

const crane = pick(o => /overhead_crane/.test(matNames(o).join(',')));
const discs = colliders.filter(c => c.floor === undefined);
const roofRef = 3.15;      // the rover's own roof, Box3 — src/world/props.js:1903
const headroom = 1.05;     // the bar this site is asked to clear, not the asset's
const fails = [];

if (!crane) {
  fails.push('NO_CRANE_GEOMETRY_IN_SCENE');
  console.log('CRANE not found in the built scene');
} else {
  const { b, s, n, tris, centre } = crane;
  const host = pick(o => /gantry/.test(scopeOf(o)), centre, 16);
  const ground = host ? host.b.min.y : NaN;
  const clearance = b.min.y - ground;
  console.log(`CRANE_MESHES ${n}`);
  console.log(`CRANE_TRIS ${Math.round(tris)}`);
  console.log(`CRANE_BOX [${b.min.x.toFixed(2)},${b.min.y.toFixed(2)},${b.min.z.toFixed(2)}..${b.max.x.toFixed(2)},${b.max.y.toFixed(2)},${b.max.z.toFixed(2)}]`);
  console.log(`CRANE_SPAN_WORLD_AABB (${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
  console.log(`CRANE_CENTRE (${centre.x.toFixed(2)},${centre.y.toFixed(2)},${centre.z.toFixed(2)})`);
  console.log(`CLEARANCE_UNDER_HOOK ${clearance.toFixed(2)} m over the host plate (bar: roof ${roofRef} + headroom ${headroom} = ${(roofRef + headroom).toFixed(2)})`);
  if (!host) fails.push('NO_HOST_TO_MEASURE_AGAINST');
  else {
    console.log(`HOST_MESHES ${host.n} HOST_BOX_Y [${host.b.min.y.toFixed(2)}..${host.b.max.y.toFixed(2)}] HOST_SPAN_WORLD_AABB (${host.s.x.toFixed(2)},${host.s.y.toFixed(2)},${host.s.z.toFixed(2)})`);
    console.log(`CRANE_TOP_MINUS_HOST_TOP ${(b.max.y - host.b.max.y).toFixed(2)} m  (0.00 = bridge crown flush with the portal crown)`);
    if (Math.abs(b.max.y - host.b.max.y) > 0.15) fails.push(`CROWN_NOT_FLUSH ${(b.max.y - host.b.max.y).toFixed(2)}`);
  }
  if (Number.isNaN(clearance) || clearance < roofRef + headroom) fails.push(`HOOK_TOO_LOW ${clearance.toFixed(2)}`);
  const mine = discs.filter(c => (c.prop || '').includes('fab-crane'));
  console.log(`NEW_DISCS_FROM_CRANE ${mine.length}`);
  if (mine.length) fails.push(`CRANE_EMITTED_GROUND_DISCS ${mine.length}`);
}
console.log(`SOLID_DISCS_TOTAL ${discs.length}`);
if (discs.length !== 694) fails.push(`DISC_COUNT_MOVED ${discs.length} (expected 694 — a carried bridge may add no ground collider)`);
let meshes = 0;
scene.traverse(o => { if (o.isMesh && o.visible) meshes++; });
console.log(`VISIBLE_MESHES ${meshes}`);
console.log(`CRANE_CHECK_${fails.length ? 'FAIL ' + fails.join(' ') : 'PASS'}`);
process.exit(fails.length ? 1 : 0);
