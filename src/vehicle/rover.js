import * as THREE from 'three';
import { loadModel, cloneModel, cloneMaterials, findByName, findMeshByMaterial } from '../world/assets.js';

// Blender-modeled six-wheel rover (tools/blender/build_assets.py → rover.glb).
// Wheel pivots ship as empties named wheelpivot_N; the physics rig wants a steer pivot
// whose children live in a spin rotor, so re-home them at load time.
export async function createRover(scene) {
  const model = await loadModel('rover');
  const g = new THREE.Group();
  const inner = cloneModel(model);
  inner.scale.setScalar(0.85);
  cloneMaterials(inner, (o, mats) => mats.some((m) => m && m.name === 'light_amber'));
  g.add(inner);

  const wheels = [];
  for (let i = 0; i < 6; i++) {
    const pv = findByName(inner, `wheelpivot_${i}`);
    pv.rotation.order = 'YXZ';
    const rotor = new THREE.Group();
    pv.add(rotor);
    for (const kid of [...pv.children]) if (kid !== rotor) rotor.add(kid);
    pv.userData = { row: Math.floor(i / 2), side: i % 2 === 0 ? -1 : 1, spin: rotor };
    wheels.push(pv);
  }

  // headlights: warm throw downrange, emissive lens tied to the modeled lamp bar
  const beam = findMeshByMaterial(inner, 'light_amber');
  const lampMat = beam ? beam.material : new THREE.MeshStandardMaterial({ emissive: 0xffe0a0 });
  const spotL = new THREE.SpotLight(0xfff1e0, 0, 115, 0.33, 0.7, 1.05);
  spotL.position.set(-0.5, 1.2, 1.8); spotL.target.position.set(-0.5, -0.9, 34); g.add(spotL, spotL.target);
  const spotR = spotL.clone(); spotR.position.x = 0.5; spotR.target.position.x = 0.5; g.add(spotR, spotR.target);
  g.userData.spots = [spotL, spotR];

  g.position.set(0, 0, 0);
  scene.add(g);
  return { group: g, wheels, lampMat };
}
