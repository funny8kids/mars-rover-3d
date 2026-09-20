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
  // Raycast forensics on a noon hub frame: the antenna dish drew as a bloom star because its
  // material was a second, props-pass-missed instance of `rover_alu` still at the exported
  // metalness 1.0 — a bare mirror facing the sun. Re-apply the authored rover shell values to this
  // clone (idempotent where the props pass already landed) and take the dish's mirror away for
  // good: a high-gain antenna is painted substrate over a dielectric reflector, not chrome.
  // `rover_hub` joins the table from the close-up wheel frame: the exported rim caps are a
  // 0.8-albedo gloss that renders as polished white five-spoke toy wheels. Anodised structure
  // under a season of dust film sits a full stop below the deck, not above it.
  const SHELL = {
    metalRed:   [[0.52, 0.135, 0.055], 0.52, 0.1],
    metal:      [[0.44, 0.435, 0.43], 0.44, 0.72],
    metalDark:  [[0.135, 0.13, 0.135], 0.62, 0.6],
    rover_white:[[0.40, 0.385, 0.355], 0.56, 0.08],
    rover_alu:  [[0.395, 0.4, 0.415], 0.42, 0.85],
    rover_hub:  [[0.27, 0.255, 0.24], 0.58, 0.55],
    solar_cell: [[0.019, 0.031, 0.072], 0.34, 0.3],
  };
  inner.traverse(o => {
    for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      const v = SHELL[mt.name];
      if (v) { mt.color.setRGB(v[0][0], v[0][1], v[0][2]); mt.roughness = v[1]; mt.metalness = v[2]; }
      if (o.name === 'dish' || o.name === 'dishfeed') {
        mt.color.setRGB(0.40, 0.40, 0.42); mt.roughness = 0.55; mt.metalness = 0.12;
      }
    }
  });
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
